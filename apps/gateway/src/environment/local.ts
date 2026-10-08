import type { HookRunner } from '../agent/hooks.js';
import { validateSchema } from '../agent/ptc/schema.js';
import type { Tool, ToolContext, ToolResult } from '../agent/tools/types.js';

/** Policy-chain progress, NOT durable evidence that an external effect did not occur. */
export type OperationStage =
  | 'unavailable'
  | 'invalid'
  | 'denied'
  | 'withheld'
  | 'refused'
  | 'cancelled'
  | 'threw'
  | 'executed';

export interface OperationOptions {
  /** Claim a PTC slot using final arguments; throwing cancels the call. */
  beforeExecute?: (name: string, args: Record<string, unknown>) => Promise<void>;
  /** Refusal latch, checked before approval and immediately before execution. */
  withheld?: (name: string, args: Record<string, unknown>) => string | undefined;
}

export interface OperationOutcome {
  stage: OperationStage;
  result: ToolResult;
  /** Also appended to the result, even when the script drops its text. */
  hookOutput?: string;
}

/**
 * Local-only dependencies. Never serialize this host or ToolContext: they contain
 * environment/configuration and authority. The Agent-backed gate retains its
 * model classifier, approvals and write leases until a separate broker exists.
 */
export interface LocalOperationHost {
  hooks: Pick<HookRunner, 'beforeTool' | 'run'>;
  hasAfterHooks(): boolean;
  gate(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  context(id: string, signal: AbortSignal, update?: (result: ToolResult) => void): ToolContext;
  log(message: string): void;
}

/**
 * Shared direct/PTC operation entry point, executed inside the existing agent
 * sandbox. This extraction does not create an unsandboxed daemon tool runner.
 * Transcript projection and durable RPC admission remain separate concerns.
 */
export async function executeLocalOperation(
  host: LocalOperationHost,
  tool: Tool,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
  toolCallId: string,
  onUpdate?: (result: ToolResult) => void,
  options: OperationOptions = {},
): Promise<OperationOutcome> {
  const name = tool.name;
  const cancelled = () => fail('cancelled', 'Cancelled before it started');
  const fail = (stage: OperationStage, text: string): OperationOutcome => ({
    stage,
    result: { content: [{ type: 'text', text }], isError: true },
  });
  if ('__invalid_json' in rawArgs)
    return fail(
      'invalid',
      `Invalid JSON arguments for ${name}: ${String(rawArgs.__invalid_json).slice(0, 500)}`,
    );
  const invalid = (args: Record<string, unknown>, what: string) => {
    const errors = validateSchema(args, tool.parameters);
    return errors.length ? `Invalid ${what} for ${name}: ${errors.join('; ')}` : undefined;
  };
  const before = invalid(rawArgs, 'arguments');
  if (before) return fail('invalid', before);
  if (signal.aborted) return cancelled();
  const gate = await host.hooks.beforeTool(name, rawArgs, signal);
  if (signal.aborted) return cancelled();
  if (gate.blocked) return fail('denied', `Blocked by hook: ${gate.blocked}`);
  if (gate.args !== rawArgs) {
    const after = invalid(gate.args, 'hook-rewritten arguments');
    if (after) return fail('invalid', after);
  }
  const held = () => options.withheld?.(name, gate.args);
  const early = held();
  if (early) return fail('withheld', early);
  let refusal: string | undefined;
  try {
    refusal = await host.gate(name, gate.args, signal);
  } catch (error) {
    if (signal.aborted) return cancelled();
    return fail('refused', (error as Error).message);
  }
  if (signal.aborted) return cancelled();
  if (refusal) return fail('denied', `Blocked by auto mode: ${refusal}`);
  if (options.beforeExecute)
    try {
      await options.beforeExecute(name, gate.args);
    } catch {
      return cancelled();
    }
  if (signal.aborted) return cancelled();
  const late = held();
  if (late) return fail('withheld', late);
  let result: ToolResult;
  let stage: OperationStage = 'executed';
  try {
    result = await tool.execute(gate.args, host.context(toolCallId, signal, onUpdate));
  } catch (error) {
    host.log(`tool ${name} threw: ${(error as Error).stack ?? String(error)}\n`.slice(0, 8192));
    stage = 'threw';
    result = { content: [{ type: 'text', text: (error as Error).message }], isError: true };
  }
  if (host.hasAfterHooks()) {
    const hookOutput = (
      await host.hooks.run(
        'afterTool',
        {
          tool: name,
          args: gate.args,
          isError: !!result.isError,
          output: result.content
            .filter((part) => part.type === 'text')
            .map((part) => (part as { text: string }).text)
            .join('')
            .slice(0, 65_536),
        },
        name,
        signal,
      )
    )
      .filter((item) => item.exitCode === 0 && item.stdout.trim())
      .map((item) => item.stdout.trim())
      .join('\n');
    if (hookOutput) {
      result = {
        ...result,
        content: [...result.content, { type: 'text', text: `\n[hook]\n${hookOutput}` }],
      };
      return { stage, result, hookOutput };
    }
  }
  return { stage, result };
}
