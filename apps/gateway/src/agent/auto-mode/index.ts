/**
 * Auto mode: a pre-execution filter for shell actions (`bash`,
 * `background_task` start/write, including calls made from PTC code) and for
 * `code` (PTC) scripts themselves.
 *
 * 1. Static rules ({@link classifyShell}, {@link classifyScript}) sort the
 *    action into read / write / danger, or `unknown` when it cannot be judged
 *    without understanding it. The user's deny-list (`features.autoMode.deny`)
 *    is matched first and always means danger.
 * 2. `unknown` actions go to a model classifier (models from
 *    `features.autoMode`, else observational memory's, then the session model).
 *    It sees the human's recent requests and critical observational-memory
 *    notes the human is the source of, never tool output. If no model answers,
 *    the action is treated as a write.
 * 3. `danger` needs a human: with a UI the user confirms; headless agents
 *    (team workers, subagents) are refused.
 * 4. Anything that may write takes the node's write lease first, so a
 *    competing session writing an overlapping workspace fails the call with
 *    `workspace_busy` instead of racing it.
 *
 * Keystrokes for a tty task are judged together with the rest of the line
 * they belong to (everything typed since the last Enter), so a command cannot
 * be smuggled in one harmless-looking fragment at a time.
 *
 * Not a sandbox: an approved or misclassified command still runs with the
 * agent account's permissions; the OS sandbox is the boundary.
 */
import path from 'node:path';
import { z } from 'zod';
import type { Agent } from '../agent.js';
import { thinkingLevels } from '../config.js';
import { classifyWithModel, type ModelChoice, type ShellAction } from './classifier.js';
import { classifyShell, compileDeny, type Classification } from './rules.js';
import { classifyScript } from './script.js';

const modelChoice = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  thinking: z.enum(thinkingLevels).optional(),
});

const settingsSchema = z
  .object({
    /** false: no danger checks or model calls; shell actions only decide the write lease (unclear ⇒ write). The deny-list still applies. */
    enabled: z.boolean().default(true),
    /** Send statically unclear actions to a model; false treats them as writes. */
    useModel: z.boolean().default(true),
    /** Show the classifier critical observational-memory notes (the human's earlier constraints and decisions). */
    useMemory: z.boolean().default(true),
    /** Classifier model; defaults to observational memory's model, then the session model. */
    model: modelChoice.optional(),
    fallbackModels: z.array(modelChoice).default([]),
    timeoutMs: z.number().int().positive().max(120_000).default(30_000),
  })
  .default({});

const memoryModels = z
  .object({
    model: modelChoice.optional(),
    fallbackModels: z.array(modelChoice).default([]),
  })
  .passthrough();

export type AutoModeSettings = z.infer<typeof settingsSchema>;

export function autoModeSettings(features: Record<string, unknown>): AutoModeSettings {
  const parsed = settingsSchema.safeParse(features.autoMode ?? {});
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

/**
 * The user's deny-list, `features.autoMode.deny`: regular expressions (or
 * `/source/flags`) searched in every shell command, tty input line and `code`
 * script, and in the package scripts, make/just recipes and shell scripts a
 * command runs. A match is always `danger`. Read on its own so a mistake
 * elsewhere in the auto-mode settings cannot drop it; a bare string counts as
 * one pattern.
 */
export function autoModeDeny(features: Record<string, unknown>): string[] {
  const deny = (features.autoMode as { deny?: unknown } | undefined)?.deny;
  if (typeof deny === 'string') return [deny];
  return Array.isArray(deny) ? deny.filter((item): item is string => typeof item === 'string') : [];
}

/** Classifier models: auto mode's own, else observational memory's (session model is appended later). */
export function classifierChoices(features: Record<string, unknown>): ModelChoice[] {
  const settings = autoModeSettings(features);
  if (settings.model || settings.fallbackModels.length)
    return [...(settings.model ? [settings.model] : []), ...settings.fallbackModels];
  const memory = memoryModels.safeParse(features.observationalMemory ?? {});
  if (!memory.success) return [];
  return [...(memory.data.model ? [memory.data.model] : []), ...memory.data.fallbackModels];
}

export interface AutoModeDecision extends Classification {
  source: 'rules' | 'model' | 'fallback';
}

const CACHE_LIMIT = 256;
/** Unsubmitted tty input kept per task (the current line). */
const INPUT_LINE_LIMIT = 4_096;
const INPUT_TASK_LIMIT = 64;

const CONTROL_NAMES: Record<string, string> = {
  '\x1b': 'Esc',
  '\x7f': 'Backspace',
  '\b': 'Backspace',
  '\t': 'Tab',
};

/**
 * Keystrokes made readable: control keys become `⟨Ctrl-X⟩` (`⟨Esc⟩`,
 * `⟨Tab⟩` …) so neither the rules nor the model mistake them for text. Tab
 * completion, history recall and line editing change what a line runs.
 */
export function visibleKeys(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(
      /[\x00-\x08\x0b-\x1f\x7f\t]/g,
      (c) => `⟨${CONTROL_NAMES[c] ?? `Ctrl-${String.fromCharCode(c.charCodeAt(0) + 64)}`}⟩`,
    );
}

const TRUNCATED = '⟨earlier keystrokes truncated⟩';
const CTRL_C = '⟨Ctrl-C⟩';

interface PendingLine {
  text: string;
  truncated: boolean;
}

export class AutoMode {
  /** Model verdicts that need no human (read/write), by kind + cwd + action. */
  private readonly cache = new Map<string, AutoModeDecision>();
  /** Per tty task: what was typed since the last Enter (or Ctrl-C). */
  private readonly lines = new Map<string, PendingLine>();
  private warnedFailure = false;
  private warnedRulesFailure = false;
  private warnedDeny = '';

  constructor(private readonly agent: Agent) {}

  private deny(): RegExp[] {
    const { deny, invalid } = compileDeny(autoModeDeny(this.agent.config.features));
    const key = invalid.join('\n');
    if (key && key !== this.warnedDeny) {
      this.warnedDeny = key;
      this.agent.ui.notify(
        `Auto mode: deny-list pattern(s) are not valid regular expressions and are matched as plain text: ${invalid.join(', ')}`,
        'warning',
      );
    }
    return deny;
  }

  /**
   * Static verdict for an action. A bug in the rules must not surface as a
   * failed tool call: an unjudgeable action becomes `unknown`, so the model
   * classifier (or the write fallback) decides instead.
   */
  private rulesVerdict(action: ShellAction): Classification {
    try {
      const deny = this.deny();
      if (action.kind === 'script') return classifyScript(action.text, deny);
      const rules = classifyShell(action.text, {
        cwd: action.cwd,
        roots: this.agent.guard.allowedRoots,
        protectedPaths: this.agent.config.protectedPaths,
        deny,
      });
      if (
        action.kind === 'input' &&
        action.text.includes('⟨') &&
        (rules.verdict === 'read' || rules.verdict === 'write')
      )
        return {
          verdict: 'unknown',
          reason:
            'the keystrokes include terminal control keys (editing, completion or history) or are partly shown',
        };
      return rules;
    } catch (error) {
      process.stderr.write(
        `auto mode: shell rules failed: ${(error as Error).stack ?? String(error)}\n`.slice(
          0,
          8192,
        ),
      );
      if (!this.warnedRulesFailure) {
        this.warnedRulesFailure = true;
        this.agent.ui.notify(
          `Auto mode: shell rules failed (${(error as Error).message}); judging this action without them`,
          'warning',
        );
      }
      return { verdict: 'unknown', reason: 'the static shell rules failed on this command' };
    }
  }

  /** The action a tool call would perform, or undefined when auto mode does not gate it. */
  actionFor(tool: string, args: Record<string, unknown>): ShellAction | undefined {
    const cwd = this.agent.config.workspace;
    if (tool === 'bash' && typeof args.command === 'string')
      return { tool, kind: 'command', text: args.command, cwd };
    // Code mode: the script itself can do anything the agent account can.
    if (tool === 'code' && typeof args.code === 'string')
      return { tool, kind: 'script', text: args.code, cwd };
    if (tool === 'background_task') {
      if (args.action === 'start' && typeof args.command === 'string')
        return {
          tool,
          kind: 'command',
          text: args.command,
          cwd: path.resolve(cwd, String(args.cwd ?? '.').replace(/^@/, '')),
        };
      if (args.action === 'write' && typeof args.input === 'string') {
        const line = this.lines.get(String(args.id ?? ''));
        const text = (line?.text ?? '') + visibleKeys(args.input);
        return { tool, kind: 'input', text: line?.truncated ? TRUNCATED + text : text, cwd };
      }
    }
    return undefined;
  }

  /** Remember the unsubmitted part of a tty task's input after it was let through. */
  private typed(args: Record<string, unknown>, action: ShellAction): void {
    const id = String(args.id ?? '');
    let truncated = action.text.startsWith(TRUNCATED);
    let text = truncated ? action.text.slice(TRUNCATED.length) : action.text;
    // Enter submits the line; Ctrl-C discards it (and readline does not keep it for yanking).
    const submitted = Math.max(
      text.lastIndexOf('\n') + 1,
      text.lastIndexOf(CTRL_C) < 0 ? 0 : text.lastIndexOf(CTRL_C) + CTRL_C.length,
    );
    if (submitted > 0) {
      text = text.slice(submitted);
      truncated = false;
    }
    this.lines.delete(id);
    if (!text) return;
    if (text.length > INPUT_LINE_LIMIT) {
      text = text.slice(-INPUT_LINE_LIMIT);
      truncated = true;
    }
    if (this.lines.size >= INPUT_TASK_LIMIT) this.lines.delete(this.lines.keys().next().value!);
    this.lines.set(id, { text, truncated });
  }

  async classify(action: ShellAction, signal: AbortSignal): Promise<AutoModeDecision> {
    const settings = autoModeSettings(this.agent.config.features);
    const rules = this.rulesVerdict(action);
    // The deny-list is the user's own rule: it holds even with auto mode off.
    if (rules.denied) return { ...rules, source: 'rules' };
    if (!settings.enabled) {
      // Lease decision only: anything that is not clearly read-only writes.
      return rules.verdict === 'read'
        ? { ...rules, source: 'rules' }
        : { verdict: 'write', reason: rules.reason, source: 'rules' };
    }
    if (rules.verdict !== 'unknown') return { ...rules, source: 'rules' };
    if (!settings.useModel)
      return {
        verdict: 'write',
        reason: `${rules.reason} (model check disabled)`,
        source: 'fallback',
      };

    // Rules (and the deny-list) run before the cache, so a cached model
    // verdict never outlives a newly added deny pattern.
    const key = `${action.kind}\0${action.cwd}\0${action.text}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const result = await classifyWithModel(
      this.agent,
      action,
      rules.reason,
      classifierChoices(this.agent.config.features),
      signal,
      settings.timeoutMs,
      settings.useMemory,
    );
    if (!result.ok) {
      if (!this.warnedFailure) {
        this.warnedFailure = true;
        this.agent.ui.notify(
          `Auto mode: classifier unavailable (${result.error}); treating unclear shell actions as writes`,
          'warning',
        );
      }
      return {
        verdict: 'write',
        reason: `${rules.reason}; classifier unavailable`,
        source: 'fallback',
      };
    }
    this.warnedFailure = false;
    const decision: AutoModeDecision = {
      verdict: result.verdict,
      reason: result.reason,
      source: 'model',
    };
    if (decision.verdict !== 'danger') {
      if (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, decision);
    }
    return decision;
  }

  /**
   * Gate one tool call. Returns a refusal message for the model, or undefined
   * when the call may run (after taking the write lease when needed). Throws
   * when the lease is refused.
   */
  async gate(
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const action = this.actionFor(tool, args);
    if (!action) return undefined;
    const decision = await this.classify(action, signal);
    if (decision.verdict === 'danger') {
      const refusal = await this.approve(action, decision.reason, signal);
      if (refusal) return refusal;
    }
    if (decision.verdict !== 'read') await this.agent.acquireWrite(action.cwd, signal);
    if (action.kind === 'input') this.typed(args, action);
    return undefined;
  }

  private async approve(
    action: ShellAction,
    reason: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const advice =
      'Do not try to reach the same effect another way; explain what you intended and ask the user to run or approve it.';
    if (!this.agent.hasUI)
      return `${reason}. Dangerous actions need a human and this agent has no UI. ${advice}`;
    const label =
      action.kind === 'input' ? 'Input' : action.kind === 'script' ? 'Script' : 'Command';
    const answer = await this.agent.ui.confirm(
      'Auto mode: allow a potentially dangerous action?',
      `${label} (${action.tool}, in ${action.cwd}):\n\n${action.text.slice(0, 4_000)}\n\nReason: ${reason}`,
      { signal },
    );
    if (answer === true) return undefined;
    return `${reason}. The user ${answer === false ? 'declined' : 'did not approve'} it. ${advice}`;
  }
}
