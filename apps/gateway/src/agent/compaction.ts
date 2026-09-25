import type { Agent } from './agent.js';
import type { CompactionPlan } from './feature.js';
import { estimateTokens, type AssistantMessage, type Message } from './messages.js';

export interface CompactionSettings {
  enabled: boolean;
  /** Compact when context exceeds `contextWindow - reserveTokens`. */
  reserveTokens: number;
  /** Recent context kept verbatim after the summary. */
  keepRecentTokens: number;
  /** Warm the provider prompt cache after compaction (OpenAI-compatible with long retention). */
  warmCache: boolean;
}

export const defaultCompaction: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  warmCache: true,
};

export const SUMMARY_PROMPT = `Stop working and write a handoff summary of this conversation so far. It will replace the earlier history, so the next assistant must be able to continue seamlessly from it alone.

Use this structure:
## Goal
## Constraints and preferences
## Progress
### Done
### In progress
### Blocked
## Key decisions
## Important context (files, commands, errors, identifiers — exact values)
## Next steps

Be concrete and complete; omit pleasantries. Do not call tools.`;

const overflowPattern =
  /context.?length|context.?window|maximum context|too many tokens|prompt is too long|input is too long|exceeds? the (?:model'?s? )?(?:maximum|context)|max_tokens.*exceed|request too large|HTTP 413/i;

export function isContextOverflow(message: AssistantMessage): boolean {
  return message.stopReason === 'error' && overflowPattern.test(message.errorMessage ?? '');
}

/**
 * Current context size: provider-reported usage of the latest assistant
 * message plus an estimate for anything appended after it.
 */
export function contextTokens(entries: Array<{ message: Message }>): number {
  let tokens = 0;
  let index = entries.length - 1;
  for (; index >= 0; index--) {
    const message = entries[index]!.message;
    if (
      message.role === 'assistant' &&
      message.usage.totalTokens > 0 &&
      message.stopReason !== 'error'
    ) {
      const usage = message.usage;
      tokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
      break;
    }
  }
  const start = index + 1;
  if (index < 0) tokens = 0;
  for (const entry of entries.slice(start)) tokens += estimateTokens(entry.message);
  return tokens;
}

/**
 * Pick the first entry kept verbatim: walk back from the end until
 * `keepRecentTokens` is covered, then back to the start of that user turn so
 * a tool call is never separated from its result. The latest user turn is
 * always kept (an overflow retry must still answer it).
 */
export function findCutPoint(
  entries: Array<{ entryId: string; message: Message }>,
  keepRecentTokens: number,
): string | undefined {
  const isTurnStart = (message: Message) => message.role === 'user' || message.role === 'custom';
  let kept = 0;
  let cut = entries.length;
  for (let index = entries.length - 1; index >= 0; index--) {
    kept += estimateTokens(entries[index]!.message);
    cut = index;
    if (kept >= keepRecentTokens && isTurnStart(entries[index]!.message)) break;
  }
  while (cut > 0 && !isTurnStart(entries[cut]!.message)) cut--;
  if (cut === 0) {
    // Whole context is smaller than the keep budget: keep only the last turn.
    cut = entries.length - 1;
    while (cut > 0 && !isTurnStart(entries[cut]!.message)) cut--;
  }
  const summarizable = entries
    .slice(0, cut)
    .some((entry) => entry.message.role !== 'compactionSummary');
  if (!summarizable || cut >= entries.length) return undefined;
  return entries[cut]!.entryId;
}

export async function runCompaction(
  agent: Agent,
  options: {
    reason: 'threshold' | 'overflow' | 'manual';
    signal: AbortSignal;
    instructions?: string;
    settings: CompactionSettings;
  },
): Promise<{ ok: boolean; error?: string; tokensBefore?: number; summary?: string }> {
  const entries = agent.store.contextEntries();
  const tokensBefore = contextTokens(entries);
  const cut = findCutPoint(
    entries,
    options.reason === 'overflow' ? 0 : options.settings.keepRecentTokens,
  );
  if (!cut) return { ok: false, error: 'Nothing to compact' };
  // 'end' = everything is summarized; the kept range starts after the compaction entry.
  const firstKeptEntryId = cut;
  agent.emit({ type: 'compaction_start', reason: options.reason });
  let plan: CompactionPlan | undefined;
  try {
    for (const feature of agent.features) {
      const result = await feature.beforeCompact?.(agent, {
        firstKeptEntryId,
        tokensBefore,
        signal: options.signal,
      });
      if (!result) continue;
      if ('cancel' in result) {
        agent.emit({ type: 'compaction_end', reason: options.reason, aborted: true });
        return { ok: false, error: 'Compaction cancelled by extension' };
      }
      plan = result;
      break;
    }
    if (!plan) {
      const instructions = options.instructions
        ? `${SUMMARY_PROMPT}\n\nAdditional focus from the user: ${options.instructions}`
        : SUMMARY_PROMPT;
      // Same system prompt + tools + history prefix as normal turns, so the
      // provider prompt cache is reused; only the instruction is new.
      const response = await agent.stream(agent.systemPrompt(), options.signal, {
        emit: false,
        toolChoice: 'none',
        extraMessages: [{ role: 'user', content: instructions, timestamp: Date.now() }],
        upTo: firstKeptEntryId,
      });
      const summary = response.content
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text: string }).text)
        .join('')
        .trim();
      if (response.stopReason === 'error' || response.stopReason === 'aborted' || !summary)
        throw new Error(response.errorMessage ?? `Summarizer stopped: ${response.stopReason}`);
      plan = { summary, firstKeptEntryId, tokensBefore };
    }
  } catch (error) {
    agent.emit({
      type: 'compaction_end',
      reason: options.reason,
      aborted: options.signal.aborted,
      errorMessage: (error as Error).message,
    });
    return { ok: false, error: (error as Error).message };
  }
  const entry = agent.store.append({
    type: 'compaction',
    summary: plan.summary,
    firstKeptEntryId: plan.firstKeptEntryId,
    tokensBefore: plan.tokensBefore,
    ...(plan.details === undefined ? {} : { details: plan.details }),
  });
  agent.emit({
    type: 'compaction_end',
    reason: options.reason,
    result: { summary: plan.summary, tokensBefore: plan.tokensBefore, entryId: entry.id },
  });
  for (const feature of agent.features) {
    try {
      await feature.afterCompact?.(agent);
    } catch (error) {
      agent.ui.notify(`${feature.name}: ${(error as Error).message}`, 'warning');
    }
  }
  if (options.settings.warmCache && options.reason !== 'overflow') void warmCache(agent);
  return { ok: true, tokensBefore: plan.tokensBefore, summary: plan.summary };
}

/**
 * Prime the provider cache with the compacted prefix (cache-safe-compaction):
 * only for OpenAI-compatible models that opted into long cache retention.
 */
export async function warmCache(agent: Agent): Promise<void> {
  let resolved;
  try {
    resolved = agent.resolveModel();
  } catch {
    return;
  }
  const compat = { ...resolved.provider.compat, ...resolved.model.compat } as Record<
    string,
    unknown
  >;
  if (resolved.provider.api !== 'openai-chat' || compat.supportsLongCacheRetention !== true) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  agent.ui.setStatus('cache-safe-compaction', 'warming compacted cache…');
  try {
    const response = await agent.stream(agent.systemPrompt(), controller.signal, {
      emit: false,
      toolChoice: 'none',
      maxTokens: 16,
      thinking: 'minimal',
      retries: false,
    });
    if (response.stopReason !== 'stop' && response.stopReason !== 'length')
      throw new Error('incomplete');
  } catch {
    if (!controller.signal.aborted)
      agent.ui.notify(
        'Compaction succeeded, but cache warm-up failed; the next turn will continue normally.',
        'warning',
      );
  } finally {
    clearTimeout(timer);
    agent.ui.setStatus('cache-safe-compaction', undefined);
  }
}
