import { randomUUID } from 'node:crypto';
import { loadAgentConfig } from '../agent/config.js';
import { AutoMode } from '../agent/auto-mode/index.js';
import { HookRunner } from '../agent/hooks.js';
import { PathGuard } from '../agent/sandbox.js';
import { builtinTools } from '../agent/tools/index.js';
import type { ToolContext, UiApi } from '../agent/tools/types.js';
import { stdinLines } from '../agent/rpc.js';
import { executeLocalOperation } from './local.js';
import { parseJson, canonicalJson, digest } from './json.js';
import { REQUEST_BYTES, RESULT_BYTES, validateIntent } from './protocol.js';

/** Shipped sandbox child, deliberately no Agent, SessionStore, model loop or provider socket. */
export async function runEnvironmentExecutor(): Promise<void> {
  if (process.env.PIRC_SANDBOX !== 'srt') throw new Error('Environment executor requires sandbox');
  const config = loadAgentConfig(process.cwd(), { providers: {} });
  const guard = new PathGuard(config.workspace, config.pathPolicy, config.protectedPaths);
  const write = (message: unknown) => {
    process.stdout.write(`${canonicalJson(message, RESULT_BYTES)}\n`);
  };
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  let active: { id: string; controller: AbortController } | undefined;
  let finalArguments: Record<string, unknown> | undefined;
  const ask = (kind: string, payload: unknown, signal: AbortSignal): Promise<any> => {
    signal.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        pending.delete(id);
        reject(new Error('Executor request cancelled'));
      };
      signal.addEventListener('abort', abort, { once: true });
      pending.set(id, {
        resolve: (value) => {
          signal.removeEventListener('abort', abort);
          resolve(value);
        },
        reject: (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      });
      write({ type: 'executor.request', id, executionId: active?.id, kind, payload });
    });
  };
  const unavailable = async () => {
    throw new Error('Unsupported executor interaction');
  };
  const ui: UiApi = {
    select: unavailable,
    choose: unavailable,
    input: unavailable,
    editor: unavailable,
    confirm: unavailable,
    notify: () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const acquireWrite = async (file: string, signal: AbortSignal) => {
    const absolute = guard.resolve(file, 'write');
    const root = guard.leaseRoot(absolute);
    if (root) await ask('lease', { root }, signal);
  };
  const mode = new AutoMode(
    {
      config,
      guard,
      hasUI: true,
      ui,
      acquireWrite,
      approveAction: async (action, reason, signal) => {
        if (!finalArguments) throw new Error('Missing final operation arguments');
        const finalArgumentDigest = digest(
          { executionId: active!.id, arguments: finalArguments, action },
          REQUEST_BYTES,
        );
        return (
          (await ask(
            'approval',
            { action, reason, arguments: finalArguments, finalArgumentDigest },
            signal,
          )) === true
        );
      },
    },
    (action, hint, choices, signal, timeoutMs, useMemory) =>
      ask('classify', { action, hint, choices, timeoutMs, useMemory }, signal),
  );
  const hooks = new HookRunner(config.hooks, config.workspace, config.env, {}, () => undefined);
  const tools = new Map(builtinTools().map((tool) => [tool.name, tool]));
  const lines = stdinLines();
  write({ type: 'executor.ready' });
  for await (const line of lines) {
    const message = parseJson(line, REQUEST_BYTES) as Record<string, any>;
    if (message.type === 'executor.response') {
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (typeof message.error === 'string') request.reject(new Error(message.error));
      else request.resolve(message.value);
      continue;
    }
    if (message.type === 'executor.cancel') {
      if (active && active.id === message.executionId) active.controller.abort();
      continue;
    }
    if (message.type !== 'executor.start' || active) throw new Error('Invalid executor command');
    const intent = validateIntent(message.intent);
    const tool = tools.get(intent.capability);
    if (!tool) throw new Error('Unsupported executor capability');
    const controller = new AbortController();
    active = { id: intent.executionId, controller };
    void (async () => {
      try {
        const outcome = await executeLocalOperation(
          {
            hooks,
            hasAfterHooks: () => hooks.has('afterTool'),
            gate: (name, args, signal) => {
              finalArguments = structuredClone(args);
              return mode.gate(name, args, signal);
            },
            context: (id, signal, update): ToolContext => ({
              cwd: config.workspace,
              config,
              guard,
              signal,
              toolCallId: id,
              ui,
              hasUI: true,
              env: config.env,
              acquireWrite: (file) => acquireWrite(file, signal),
              update: update ?? (() => undefined),
              humanWait: (work) => work,
            }),
            log: () => undefined,
          },
          tool,
          intent.arguments as Record<string, unknown>,
          controller.signal,
          intent.toolCallId,
          (output) => {
            // Progress is a bounded projection; the terminal result retains tool data.
            const text = output.content
              .filter((part) => part.type === 'text')
              .map((part) => (part as { text: string }).text)
              .join('');
            write({
              type: 'executor.progress',
              executionId: intent.executionId,
              output: { text: text.slice(-4096), truncated: text.length > 4096 },
            });
          },
        );
        write({
          type: 'executor.result',
          executionId: intent.executionId,
          terminal: {
            state: controller.signal.aborted
              ? 'cancelled'
              : outcome.result.isError
                ? 'failed'
                : 'completed',
            // Tool-level errors or cancellation never prove absence of prior effects.
            effect: controller.signal.aborted || outcome.result.isError ? 'unknown' : 'completed',
            output: outcome.result,
            truncated:
              outcome.result.data?.truncated === true ||
              (outcome.result.details as { truncated?: unknown } | undefined)?.truncated === true,
            artifacts: [],
          },
        });
      } catch (error) {
        write({
          type: 'executor.result',
          executionId: intent.executionId,
          terminal: {
            state: controller.signal.aborted ? 'cancelled' : 'failed',
            effect: 'unknown',
            error: { code: 'failed', message: String(error).slice(0, 8192) },
            truncated: false,
            artifacts: [],
          },
        });
      } finally {
        finalArguments = undefined;
        active = undefined;
      }
    })();
  }
  active?.controller.abort();
  for (const request of pending.values()) request.reject(new Error('Executor channel closed'));
}
