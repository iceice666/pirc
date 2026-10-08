import { randomUUID } from 'node:crypto';
import { createBackgroundRuntime } from '../agent/features/background/index.js';
import { createBrowserTools } from '../agent/features/browser.js';
import { createSandboxTools } from '../agent/features/sandbox.js';
import { finalArgumentsDigest } from './broker.js';
import { loadAgentConfig } from '../agent/config.js';
import { AutoMode } from '../agent/auto-mode/index.js';
import { HookRunner } from '../agent/hooks.js';
import { PathGuard } from '../agent/sandbox.js';
import { builtinTools } from '../agent/tools/index.js';
import type { ToolContext, UiApi } from '../agent/tools/types.js';
import { stdinLines } from '../agent/rpc.js';
import { executeLocalOperation } from './local.js';
import { parseJson, canonicalJson } from './json.js';
import { validateSchema } from '../agent/ptc/schema.js';
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
  const cancelling = new Map<string, { complete(): void; promise: Promise<void> }>();
  let active: { id: string; controller: AbortController } | undefined;
  const lifetime = new AbortController();
  let finalArguments: Record<string, unknown> | undefined;
  const ask = (kind: string, payload: unknown, signal: AbortSignal): Promise<any> => {
    signal.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        pending.delete(id);
        let complete!: () => void;
        const promise = new Promise<void>((resolve) => {
          complete = resolve;
        });
        cancelling.set(id, { complete, promise });
        write({ type: 'executor.cancel_request', id, executionId: active?.id });
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
    confirm: (title, message, options) =>
      ask('ui', { title, message }, options?.signal ?? active!.controller.signal),
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
        const finalArgumentDigest = finalArgumentsDigest(
          { executionId: active!.id },
          finalArguments,
          action,
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
  const finalPayload = () => {
    if (!active || !finalArguments) throw new Error('Missing final arguments');
    return {
      arguments: finalArguments,
      finalArgumentDigest: finalArgumentsDigest({ executionId: active.id }, finalArguments),
    };
  };
  const background = createBackgroundRuntime({
    watchdog: true,
    env: () => ({ ...process.env, ...config.env }),
    changed: (tasks) =>
      write({
        type: 'executor.background',
        tasks: tasks.map(({ id, pid, status, startedAt }) => ({
          id,
          ...(pid ? { pid } : {}),
          status,
          startedAt,
        })),
      }),
  });
  const browser = createBrowserTools(
    () => ({
      request: (op, args, signal) =>
        ask('browser', { op, args, ...finalPayload() }, signal ?? active!.controller.signal),
    }),
    lifetime.signal,
  );
  const exceptions = createSandboxTools(() => ({
    request: (op, args, signal) =>
      ask('sandbox', { op, args, ...finalPayload() }, signal ?? active!.controller.signal),
  }));
  const enabled = (name: string) =>
    (config.features[name] as { enabled?: boolean } | undefined)?.enabled !== false;
  const backgroundEnabled =
    enabled('background') &&
    (config.workspaceKind !== 'chat' ||
      (config.features.background as { enabled?: boolean } | undefined)?.enabled === true);
  const tools = new Map(
    [
      ...builtinTools(),
      ...(backgroundEnabled ? [background.tool] : []),
      ...(enabled('browser') ? browser : []),
      ...exceptions,
    ].map((tool) => [tool.name, tool]),
  );
  const lines = stdinLines();
  write({ type: 'executor.ready' });
  for await (const line of lines) {
    const message = parseJson(line, REQUEST_BYTES) as Record<string, any>;
    if (message.type === 'executor.cancelled_request') {
      cancelling.get(message.id)?.complete();
      cancelling.delete(message.id);
      continue;
    }
    if (message.type === 'executor.response') {
      cancelling.get(message.id)?.complete();
      cancelling.delete(message.id);
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
    if (message.type === 'executor.shutdown') break;
    if (message.type !== 'executor.start' || active) throw new Error('Invalid executor command');
    const intent = validateIntent(message.intent);
    const hook = message.hook as
      | {
          phase: 'preflight' | 'post';
          schema: Record<string, unknown>;
          result?: { output?: unknown; state?: string };
        }
      | undefined;
    const tool = hook
      ? {
          name: intent.capability,
          description: '',
          parameters: hook.schema,
          execute: async () => {
            throw new Error('Gateway effect cannot run on node');
          },
        }
      : tools.get(intent.capability);
    if (!tool) throw new Error('Unsupported executor capability');
    const controller = new AbortController();
    active = { id: intent.executionId, controller };
    void (async () => {
      try {
        if (hook) {
          const args = intent.arguments as Record<string, unknown>;
          if (validateSchema(args, hook.schema).length)
            throw new Error('Invalid gateway hook arguments');
          let output: unknown;
          if (hook.phase === 'preflight') {
            const gate = await hooks.beforeTool(intent.capability, args, controller.signal);
            if (gate.blocked || validateSchema(gate.args, hook.schema).length)
              throw new Error(gate.blocked ?? 'Invalid rewritten arguments');
            output = { arguments: gate.args };
          } else if (hook.phase === 'post') {
            const results = await hooks.run(
              'afterTool',
              {
                tool: intent.capability,
                args,
                isError: hook.result?.state !== 'completed',
                output: canonicalJson(hook.result?.output ?? null, RESULT_BYTES).slice(0, 65536),
              },
              intent.capability,
              controller.signal,
            );
            if (results.some((result) => result.exitCode !== 0 || result.timedOut))
              throw new Error('Post hook failed');
            output = {
              text: results
                .map((result) => result.stdout)
                .join('\n')
                .slice(0, 65536),
            };
          } else throw new Error('Invalid hook phase');
          controller.signal.throwIfAborted();
          write({
            type: 'executor.result',
            executionId: intent.executionId,
            terminal: {
              state: 'completed',
              effect: 'completed',
              output,
              truncated: false,
              artifacts: [],
            },
          });
          return;
        }
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
              humanWait: async (work) => {
                write({ type: 'executor.wait', executionId: intent.executionId, waiting: true });
                try {
                  return await work;
                } finally {
                  write({ type: 'executor.wait', executionId: intent.executionId, waiting: false });
                }
              },
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
        await Promise.all([...cancelling.values()].map((entry) => entry.promise));
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
        await Promise.all([...cancelling.values()].map((entry) => entry.promise));
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
  lifetime.abort();
  active?.controller.abort();
  for (const request of pending.values()) request.reject(new Error('Executor channel closed'));
  await background.shutdown();
  write({ type: 'executor.shutdown_complete' });
}
