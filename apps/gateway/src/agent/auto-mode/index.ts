/**
 * Auto mode: a pre-execution filter for shell actions (`bash`,
 * `background_task` start/write, including calls made from PTC code).
 *
 * 1. Static rules ({@link classifyShell}) sort the action into read / write /
 *    danger, or `unknown` when it cannot be judged without understanding it.
 * 2. `unknown` actions go to a model classifier (models from
 *    `features.autoMode`, else observational memory's, then the session model).
 *    It sees the human's recent requests and critical observational-memory
 *    notes, never tool output. If no model answers, the action is treated as a write.
 * 3. `danger` needs a human: with a UI the user confirms; headless agents
 *    (team workers, subagents) are refused.
 * 4. Anything that may write takes the node's write lease first, so a
 *    competing session writing an overlapping workspace fails the call with
 *    `workspace_busy` instead of racing it.
 *
 * Not a sandbox: an approved or misclassified command still runs with the
 * agent account's permissions.
 */
import path from 'node:path';
import { z } from 'zod';
import type { Agent } from '../agent.js';
import { thinkingLevels } from '../config.js';
import { classifyWithModel, type ModelChoice, type ShellAction } from './classifier.js';
import { classifyShell, type Classification } from './rules.js';

const modelChoice = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  thinking: z.enum(thinkingLevels).optional(),
});

const settingsSchema = z
  .object({
    /** false: no danger checks or model calls; shell actions only decide the write lease (unclear ⇒ write). */
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

export class AutoMode {
  /** Model verdicts that need no human (read/write), by cwd + action. */
  private readonly cache = new Map<string, AutoModeDecision>();
  private warnedFailure = false;
  private warnedRulesFailure = false;

  constructor(private readonly agent: Agent) {}

  /**
   * Static verdict for an action. A bug in the rules must not surface as a
   * failed tool call: an unjudgeable action becomes `unknown`, so the model
   * classifier (or the write fallback) decides instead.
   */
  private rulesVerdict(action: ShellAction): Classification {
    try {
      return classifyShell(action.text, {
        cwd: action.cwd,
        roots: this.agent.guard.allowedRoots,
        protectedPaths: this.agent.config.protectedPaths,
      });
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

  /** The shell action a tool call would perform, or undefined when auto mode does not gate it. */
  actionFor(tool: string, args: Record<string, unknown>): ShellAction | undefined {
    const cwd = this.agent.config.workspace;
    if (tool === 'bash' && typeof args.command === 'string')
      return { tool, kind: 'command', text: args.command, cwd };
    if (tool === 'background_task') {
      if (args.action === 'start' && typeof args.command === 'string')
        return {
          tool,
          kind: 'command',
          text: args.command,
          cwd: path.resolve(cwd, String(args.cwd ?? '.').replace(/^@/, '')),
        };
      if (args.action === 'write' && typeof args.input === 'string')
        return { tool, kind: 'input', text: args.input, cwd };
    }
    return undefined;
  }

  async classify(action: ShellAction, signal: AbortSignal): Promise<AutoModeDecision> {
    const settings = autoModeSettings(this.agent.config.features);
    const rules = this.rulesVerdict(action);
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
    const answer = await this.agent.ui.confirm(
      'Auto mode: allow a potentially dangerous action?',
      `${action.kind === 'input' ? 'Input' : 'Command'} (${action.tool}, in ${action.cwd}):\n\n${action.text.slice(0, 4_000)}\n\nReason: ${reason}`,
      { signal },
    );
    if (answer === true) return undefined;
    return `${reason}. The user ${answer === false ? 'declined' : 'did not approve'} it. ${advice}`;
  }
}
