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

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const real = process.env.PIRC_TEST_SRT;
async function fixture(realSandbox = false, panelReturn = false, delegatedCgroup?: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-env-process-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace'),
    configDir = path.join(root, 'config'),
    sessionDir = path.join(root, 'session');
  for (const dir of [cwd, configDir, sessionDir]) mkdirSync(dir);
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ features: { autoMode: { enabled: false } } }),
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
  const jobs: Array<{ id: string; pid?: number | undefined; status: string }> = [];
  const executor = new SandboxedEnvironmentExecutor({
    sandbox: prepared,
    cwd,
    descriptor,
    ...(delegatedCgroup ? { delegatedCgroup } : {}),
    background: (tasks) => {
      jobs.splice(0, jobs.length, ...tasks);
    },
    request: async (kind, payload) => {
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
  return { root, cwd, config, binding, descriptor, executor, make, run, jobs };
}

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
