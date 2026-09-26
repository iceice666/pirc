import type { ThinkingLevel } from '../../config.js';
import type { Agent, ResolvedModel } from '../../agent.js';
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '../../messages.js';

export interface ModelChoice {
  provider: string;
  id: string;
  thinking?: ThinkingLevel | undefined;
}

const RATE_LIMIT =
  /(?:^|[^\d])429(?:[^\d]|$)|rate[\s_-]?limit|too[\s_-]?many[\s_-]?requests|quota|resource[\s_-]?exhausted|overloaded/i;

/** Per-process cooldowns for rate-limited memory models. */
export class RateLimitTracker {
  private readonly until = new Map<string, number>();
  constructor(private readonly cooldownMs: () => number) {}
  cooling(key: string): boolean {
    const until = this.until.get(key);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.until.delete(key);
    return false;
  }
  noteError(key: string, message: string | undefined): boolean {
    if (!message || !RATE_LIMIT.test(message)) return false;
    this.until.set(key, Date.now() + this.cooldownMs());
    return true;
  }
  entries(): Array<[string, number]> {
    return [...this.until].filter(([, until]) => until > Date.now());
  }
}

export interface WorkerModel {
  key: string;
  resolved: ResolvedModel;
  thinking: ThinkingLevel;
}

/** Preferred model, then fallbacks; skip cooling ones (unless all are). */
export function pickModel(
  agent: Agent,
  preferred: ModelChoice | undefined,
  fallbacks: ModelChoice[],
  tracker: RateLimitTracker,
): WorkerModel {
  const candidates: WorkerModel[] = [];
  const seen = new Set<string>();
  const add = (choice: ModelChoice | undefined, thinking: ThinkingLevel) => {
    let resolved: ResolvedModel;
    try {
      resolved = agent.resolveModel(choice);
    } catch {
      return;
    }
    const key = `${resolved.providerName}/${resolved.model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ key, resolved, thinking });
  };
  if (preferred) {
    add(preferred, preferred.thinking ?? 'low');
    if (!candidates.length) {
      agent.ui.notify(
        `Observational memory: model ${preferred.provider}/${preferred.id} not found; using the session model`,
        'warning',
      );
      add(undefined, 'low');
    }
  } else add(undefined, 'low');
  for (const fallback of fallbacks)
    add(fallback, fallback.thinking ?? preferred?.thinking ?? 'low');
  if (!candidates.length) throw new Error('no model available');
  const ready = candidates.filter((candidate) => !tracker.cooling(candidate.key));
  // Keys were resolved by the gateway; a provider without one is still tried (keyless endpoints).
  return ready[0] ?? candidates[0]!;
}

export interface WorkerTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: any): string;
}

/**
 * Minimal tool loop for memory sub-agents: sequential tool execution, stops
 * when the model replies without tool calls or after `maxTurns`.
 */
export async function runWorker(
  agent: Agent,
  options: {
    model: WorkerModel;
    tracker: RateLimitTracker;
    systemPrompt: string;
    prompt: string;
    tool: WorkerTool;
    maxTurns: number;
    maxTokens: number;
    signal: AbortSignal;
  },
): Promise<{ error?: string }> {
  const { resolved, thinking } = options.model;
  const stream = agent.streamFunction(resolved.provider);
  const messages: Message[] = [{ role: 'user', content: options.prompt, timestamp: Date.now() }];
  for (let turn = 0; turn < options.maxTurns; turn++) {
    if (options.signal.aborted) return { error: 'aborted' };
    const reply: AssistantMessage = await stream(
      {
        providerName: resolved.providerName,
        provider: resolved.provider,
        model: resolved.model,
        apiKey: resolved.provider.apiKey,
        systemPrompt: options.systemPrompt,
        messages,
        tools: [
          {
            name: options.tool.name,
            description: options.tool.description,
            parameters: options.tool.parameters,
          },
        ],
        thinking: resolved.model.reasoning ? thinking : 'off',
        sessionId: `${agent.store.sessionId}-memory`,
        signal: options.signal,
        maxTokens: Math.min(resolved.model.maxTokens, options.maxTokens),
      },
      () => {},
    );
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
      options.tracker.noteError(options.model.key, reply.errorMessage);
      return { error: reply.errorMessage ?? reply.stopReason };
    }
    messages.push(reply);
    const calls = reply.content.filter((part): part is ToolCall => part.type === 'toolCall');
    if (!calls.length) return {};
    for (const call of calls) {
      let text: string;
      let isError = false;
      try {
        if (call.name !== options.tool.name) throw new Error(`Unknown tool ${call.name}`);
        text = options.tool.execute(call.arguments ?? {});
      } catch (error) {
        text = (error as Error).message;
        isError = true;
      }
      const result: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text }],
        isError,
        timestamp: Date.now(),
      };
      messages.push(result);
    }
  }
  return {};
}
