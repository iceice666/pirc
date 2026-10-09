import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeSandbox } from '../src/node/sandbox.js';
import { SandboxedEnvironmentExecutor } from '../src/node/environment-executor.js';
import { createBackgroundRuntime } from '../src/agent/features/background/index.js';
import { createBrowserTools } from '../src/agent/features/browser.js';
import { createSandboxTools } from '../src/agent/features/sandbox.js';
import { builtinTools } from '../src/agent/tools/index.js';
import { generateDescriptor } from '../src/environment/descriptor.js';
import { intentDigest, type ExecutionIntent } from '../src/environment/protocol.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import type { Json } from '../src/environment/json.js';
import { testConfig, waitFor } from './helpers.js';
import type { Tool } from '../src/agent/tools/types.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const real = process.env.PIRC_TEST_SRT;
async function fixture(
  realSandbox = false,
  panelReturn = false,
  delegatedCgroup?: string,
  hooks?: Record<string, unknown>,
  central?: {
    tool: Tool;
    execute(args: Record<string, unknown>, intent: ExecutionIntent): Promise<unknown>;
  },
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-env-process-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace'),
    configDir = path.join(root, 'config'),
    sessionDir = path.join(root, 'session');
  for (const dir of [cwd, configDir, sessionDir]) mkdirSync(dir);
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ features: { autoMode: { enabled: false } }, ...(hooks ? { hooks } : {}) }),
  );
  const previous = process.env.PIRC_CONFIG_DIR;
  process.env.PIRC_CONFIG_DIR = configDir;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.PIRC_CONFIG_DIR;
    else process.env.PIRC_CONFIG_DIR = previous;
  });
  const config = testConfig({
    sandbox: realSandbox
      ? real === 'embedded'
        ? {}
        : { srt: real! }
      : { srt: path.resolve('test/fixtures/fake-srt.sh') },
  });
  const prepared = await new NodeSandbox(config).prepare({
    sessionId: randomUUID(),
    workspaceRoot: cwd,
    sessionDir,
    environmentExecutor: true,
  });
  const binding = {
    nodeId: 'n',
    workspaceId: 'n:w',
    sessionId: randomUUID(),
    writerEpoch: randomUUID(),
    executorEpoch: randomUUID(),
  };
  const background = createBackgroundRuntime();
  cleanups.push(() => background.shutdown());
  const tools = [
    ...builtinTools(),
    background.tool,
    ...createBrowserTools(() => ({ request: async () => ({}) }), new AbortController().signal),
    ...createSandboxTools(() => undefined),
    ...(central ? [central.tool] : []),
  ];
  const descriptor = generateDescriptor({
    binding,
    cwd,
    tools,
    sandboxStatus: { active: true },
    env: {
      PIRC_CONFIG_DIR: configDir,
      PIRC_SANDBOX: 'srt',
      PIRC_SANDBOX_POLICY: JSON.stringify(prepared.policy.paths),
    },
  });
  const journal = new ExecutionJournal(path.join(root, 'ptc.sqlite'));
  cleanups.push(() => journal.close());
  const jobs: Array<{ id: string; pid?: number | undefined; status: string }> = [];
  const executor = new SandboxedEnvironmentExecutor({
    sandbox: prepared,
    cwd,
    descriptor,
    inner: journal.inner,
    ptcSnapshot: () => ({ store: '{}', untrusted: [] }),
    ...(delegatedCgroup ? { delegatedCgroup } : {}),
    background: (tasks) => {
      jobs.splice(0, jobs.length, ...tasks);
    },
    request: async (kind, payload, intent) => {
      if (kind === 'ptc_central' && central)
        return central.execute(
          (payload as { arguments: Record<string, unknown> }).arguments,
          intent,
        );
      if (kind === 'lease') return null;
      if (kind === 'browser')
        return payload && { url: 'https://example.com', title: 'Fixture', snapshot: 'page' };
      if (kind === 'ui' && panelReturn)
        return new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100));
      if (kind === 'approval' || kind === 'ui') return false;
      throw new Error('unexpected broker');
    },
  });
  cleanups.push(async () => {
    try {
      await executor.closeAndWait();
    } catch (error) {
      if (!String(error).includes('quarantined')) throw error;
    }
  });
  await executor.started;
  const make = (capability: string, args: Record<string, Json>): ExecutionIntent => {
    const value = {
      binding,
      executionId: randomUUID(),
      runId: randomUUID(),
      turnId: randomUUID(),
      toolCallId: randomUUID(),
      capability,
      arguments: args,
      descriptorRevision: descriptor.revision,
      policyRevision: descriptor.policyRevision,
      budgetMs: 10000,
    };
    return { ...value, argumentDigest: intentDigest(value) };
  };
  const run = (
    capability: string,
    args: Record<string, Json>,
    signal = new AbortController().signal,
  ) => executor.execute(make(capability, args), signal, () => {});
  return { root, cwd, config, binding, descriptor, executor, make, run, jobs, journal };
}

test('node-local PTC executes ten dependent environment calls and journals each without node-link RPC', async () => {
  const f = await fixture(!!real);
  writeFileSync(path.join(f.cwd, 'value.txt'), 'hello');
  const intent = f.make('ptc', {
    code: 'let value="";for(let i=0;i<10;i++)value=(await tools.read({path:"value.txt"})).text;store("last",value);return value;',
  });
  const result = await f.executor.execute(intent, new AbortController().signal, () => {});
  expect(result.state).toBe('completed');
  expect(JSON.stringify(result.output)).toContain('hello');
  const inner = f.journal.inner.list(f.binding, intent.executionId);
  expect(inner).toHaveLength(10);
  expect(inner.every((operation) => operation.state === 'terminal')).toBe(true);
  expect(inner.every((operation) => operation.delivered)).toBe(true);
}, 15000);

test('mixed PTC applies node hooks to central final arguments and preserves refusal latch', async () => {
  const calls: unknown[] = [];
  const f = await fixture(
    false,
    false,
    undefined,
    {
      beforeTool: [{ matcher: 'schedule', command: `echo '{"args":{"action":"create"}}'` }],
      afterTool: [{ matcher: 'schedule', command: 'echo central-hook-output' }],
    },
    {
      tool: {
        name: 'schedule',
        description: 'fixture',
        parameters: {
          type: 'object',
          properties: { action: { type: 'string' } },
          required: ['action'],
        },
        resultSchema: { type: 'object' },
        execute: async () => {
          throw new Error('Must execute on gateway');
        },
      },
      execute: async (args, intent) => {
        calls.push(args);
        return {
          ok: false,
          contractVersion: 1,
          operationId: intent.innerOperationId,
          error: { code: 'ApprovalDenied', message: 'human denied', outcome: 'not_started' },
        };
      },
    },
  );
  writeFileSync(path.join(f.cwd, 'input.txt'), 'input');
  const result = await f.run('ptc', {
    code: 'await tools.read({path:"input.txt"});try{await tools.schedule({action:"list"});}catch{}try{await tools.write({path:"should-not-exist",content:"bad"});}catch{}return "finished";',
  });
  expect(result.state).toBe('completed');
  expect(calls).toEqual([{ action: 'create' }]);
  expect(existsSync(path.join(f.cwd, 'should-not-exist'))).toBe(false);
  expect(JSON.stringify(result.output)).toContain('[declined]');
  expect(JSON.stringify(result.output)).toContain('central-hook-output');
}, 15000);

test('cancelled mixed central work fences executor before caught script continues writing', async () => {
  let finish!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => (finish = resolve)),
    entered = new Promise<void>((resolve) => (started = resolve));
  const f = await fixture(false, false, undefined, undefined, {
    tool: {
      name: 'schedule',
      description: 'held central',
      parameters: { type: 'object' },
      resultSchema: { type: 'object' },
      execute: async () => {
        throw new Error('central only');
      },
    },
    execute: async (_args, intent) => {
      started();
      await held;
      return {
        ok: true,
        contractVersion: 1,
        operationId: intent.innerOperationId,
        data: { text: 'done' },
        attachments: [],
        truncated: false,
      };
    },
  });
  writeFileSync(path.join(f.cwd, 'input.txt'), 'input');
  const controller = new AbortController();
  const running = f
    .run(
      'ptc',
      {
        code: 'await tools.read({path:"input.txt"});try{await tools.schedule({});}catch{}await tools.write({path:"after-cancel",content:"bad"});',
      },
      controller.signal,
    )
    .catch((error) => error);
  await entered;
  controller.abort();
  await f.executor.stopped;
  expect(f.executor.healthy).toBe(false);
  expect(existsSync(path.join(f.cwd, 'after-cancel'))).toBe(false);
  finish();
  await running;
}, 15000);

test('lifecycle hooks run on the node executor and return bounded prompt context', async () => {
  const f = await fixture(false, false, undefined, {
    sessionStart: [{ command: 'echo session-context' }],
    beforePrompt: [{ command: 'echo prompt-context' }],
    agentSettled: [{ command: 'echo settled' }],
  });
  expect(f.descriptor.lifecycleHooks).toEqual(['sessionStart', 'beforePrompt', 'agentSettled']);
  expect((await f.run('lifecycle.sessionStart', {})).output).toEqual({ text: 'session-context' });
  expect((await f.run('lifecycle.beforePrompt', { prompt: 'hello' })).output).toEqual({
    text: 'prompt-context',
  });
  expect((await f.run('lifecycle.agentSettled', {})).state).toBe('completed');
}, 15000);

test('outer PTC before hook can deny the entire script before any inner operation', async () => {
  const f = await fixture(false, false, undefined, {
    beforeTool: [{ command: 'echo outer-denied >&2; exit 2', matcher: 'ptc' }],
  });
  const intent = f.make('ptc', { code: 'await tools.write({path:"denied.txt",content:"bad"});' });
  const result = await f.executor.execute(intent, new AbortController().signal, () => {});
  expect(result.state).toBe('failed');
  expect(existsSync(path.join(f.cwd, 'denied.txt'))).toBe(false);
  expect(f.journal.inner.list(f.binding, intent.executionId)).toHaveLength(0);
}, 15000);

test('node PTC preserves browser provenance even when script drops tool warning text', async () => {
  const f = await fixture();
  const result = await f.run('ptc', {
    code: 'const page=await tools.browser_snapshot({});store("page",page);return "derived page text";',
  });
  expect(result.state).toBe('completed');
  expect(JSON.stringify(result.output)).toContain('untrusted web content');
  expect((result.output as any).ptcUntrusted).toContain('browser_snapshot');
}, 15000);

test('subprocess background jobs survive foreground completion and cancelled waits, then shutdown', async () => {
  const f = await fixture();
  const started = await f.run('background_task', { action: 'start', command: 'sleep 60' });
  expect(started.state).toBe('completed');
  const id = (started.output as any).data.task.id;
  const controller = new AbortController();
  const waiting = f.run('background_task', { action: 'wait', id, timeout: 30 }, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await waiting;
  const listed = await f.run('background_task', { action: 'list' });
  expect((listed.output as any).data.tasks[0].status).toBe('running');
  expect((await f.run('browser_snapshot', {})).state).toBe('completed');
  await expect(f.executor.closeAndWait()).rejects.toThrow('quarantined');
}, 10000);

test('watchdog background tty retains interactive input and output', async () => {
  const f = await fixture();
  const result = await f.run('background_task', {
    action: 'start',
    command: 'read line; echo received:$line',
    tty: true,
  });
  const id = (result.output as any).data.task.id;
  const written = await f.run('background_task', { action: 'write', id, input: 'hello\n' });
  expect(JSON.stringify(written.output)).toContain('received:hello');
}, 10000);

test('browser panel handoff cancels the losing confirmation without killing executor', async () => {
  const f = await fixture(false, true);
  expect((await f.run('browser_handoff', { reason: 'human login' })).state).toBe('completed');
  expect(f.executor.healthy).toBe(true);
  expect((await f.run('browser_snapshot', {})).state).toBe('completed');
}, 10000);

test('background watchdog fences detached jobs on abrupt executor death', async () => {
  const f = await fixture();
  const started = await f.run('background_task', { action: 'start', command: 'sleep 60' });
  const pid = (started.output as any).data.task.pid as number;
  f.executor.close();
  await f.executor.stopped;
  await expect(f.executor.closeAndWait()).rejects.toThrow('quarantined');
  await waitFor(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    true,
    3000,
  );
}, 10000);

test.skipIf(!process.env.PIRC_TEST_ENV_CGROUP)(
  'delegated Linux cgroup fences detached jobs before regrant after executor crash',
  async () => {
    const f = await fixture(Boolean(real), false, process.env.PIRC_TEST_ENV_CGROUP);
    const started = await f.run('background_task', {
      action: 'start',
      command: 'setsid sleep 60 & wait',
    });
    const pid = (started.output as any).data.task.pid as number;
    f.executor.close();
    await f.executor.closeAndWait();
    let exists = true;
    try {
      process.kill(pid, 0);
    } catch {
      exists = false;
    }
    if (exists) {
      const stat = await Bun.file(`/proc/${pid}/stat`)
        .text()
        .catch(() => '');
      exists = !stat.includes(') Z');
    }
    expect(exists).toBe(false);
  },
  10000,
);

test('real child crash after a side effect remains unknown across journal restart and duplicate start', async () => {
  const f = await fixture();
  const file = path.join(f.root, 'journal.sqlite');
  let journal = new ExecutionJournal(file);
  cleanups.push(() => journal.close());
  journal.provision(f.binding, f.descriptor.revision, f.descriptor.policyRevision);
  const intent = f.make('bash', { command: 'echo effect >> effect.txt; sleep 60' });
  journal.accept(intent);
  journal.claim(f.binding, intent.executionId);
  const pending = f.executor.execute(intent, new AbortController().signal, () => {});
  void pending.catch(() => {});
  await waitFor(() => existsSync(path.join(f.cwd, 'effect.txt')), true);
  f.executor.close();
  await f.executor.stopped;
  await expect(pending).rejects.toThrow();
  journal.close();
  journal = new ExecutionJournal(file);
  expect(journal.recover(f.binding)[0]!.state).toBe('unknown');
  expect(journal.accept(intent).fresh).toBe(false);
  expect(await Bun.file(path.join(f.cwd, 'effect.txt')).text()).toBe('effect\n');
}, 10000);

test.skipIf(!real)(
  'real OS sandbox executor protects private files, writes, network and environment',
  async () => {
    const f = await fixture(true);
    const secret = path.join(f.config.stateDir, 'secret.txt');
    writeFileSync(secret, 'node-private-secret');
    const read = await f.run('bash', { command: `cat '${secret}'` });
    expect(JSON.stringify(read.output)).not.toContain('node-private-secret');
    expect((read.output as any).isError).toBe(true);
    expect((await f.run('bash', { command: 'echo inside > ok.txt && cat ok.txt' })).state).toBe(
      'completed',
    );
    const probe = path.join(os.homedir(), `.pirc-env-probe-${randomUUID()}`);
    cleanups.push(() => {
      if (existsSync(probe)) rmSync(probe);
    });
    expect((await f.run('bash', { command: `touch '${probe}'` })).state).toBe('failed');
    expect(existsSync(probe)).toBe(false);
    const network = await f.run('bash', {
      command: 'curl -sS -m 5 -o /dev/null https://example.com/ 2>&1; echo "curl=$?"',
    });
    expect(JSON.stringify(network.output)).toMatch(/403|curl=[1-9]/);
    const env = await f.run('bash', { command: 'env' });
    expect(JSON.stringify(env.output)).not.toContain('PIRC_NODE_TOKEN=');
  },
  30000,
);
