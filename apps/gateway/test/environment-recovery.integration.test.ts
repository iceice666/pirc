import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDaemonApp } from '../src/daemon/app.js';
import { startNode } from '../src/node/runtime.js';
import { NodeSandbox } from '../src/node/sandbox.js';
import { SandboxedEnvironmentExecutor } from '../src/node/environment-executor.js';
import { EnvironmentAuthority } from '../src/node/environment-authority.js';
import {
  fenceEnvironment,
  restoreEnvironmentQuarantines,
} from '../src/node/environment-supervisor.js';
import { WriteBroker } from '../src/node/write-broker.js';
import { ApprovalAuthority, type EnvironmentApproval } from '../src/environment/approvals.js';
import { ChunkStore } from '../src/environment/chunks.js';
import { generateDescriptor } from '../src/environment/descriptor.js';
import { EnvironmentFlow } from '../src/environment/flow.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import { RemoteEnvironment } from '../src/environment/remote.js';
import { LocalEnvironment, dispatchEnvironment } from '../src/environment/service.js';
import {
  intentDigest,
  type Binding,
  type ExecutionIntent,
  type ExecutionRecord,
} from '../src/environment/protocol.js';
import type { Json } from '../src/environment/json.js';
import { builtinTools } from '../src/agent/tools/index.js';
import { createSandboxTools } from '../src/agent/features/sandbox.js';
import { loadAgentConfig } from '../src/agent/config.js';
import { daemonConfig, testConfig, waitFor } from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const generation = (): Binding => ({
  nodeId: 'test',
  workspaceId: 'test:test',
  sessionId: SESSION,
  writerEpoch: WRITER,
  executorEpoch: randomUUID(),
});
const SESSION = randomUUID();
const WRITER = randomUUID();

/** One sandboxed executor generation with node-owned approvals, as the supervisor provisions it. */
async function provisionGeneration(
  root: string,
  binding: Binding,
  approvals: ApprovalAuthority,
  writes: WriteBroker,
) {
  const cwd = path.join(root, 'workspace');
  const sessionDir = path.join(root, `session-${binding.executorEpoch}`);
  mkdirSync(sessionDir);
  const prepared = await new NodeSandbox(
    testConfig({ sandbox: { srt: path.resolve('test/fixtures/fake-srt.sh') } }),
  ).prepare({ sessionId: randomUUID(), workspaceRoot: cwd, sessionDir, environmentExecutor: true });
  const env = {
    PIRC_CONFIG_DIR: path.join(root, 'config'),
    PIRC_SANDBOX: 'srt',
    PIRC_SANDBOX_POLICY: JSON.stringify(prepared.policy.paths),
  };
  const descriptor = generateDescriptor({
    binding,
    cwd,
    env,
    tools: [...builtinTools(), ...createSandboxTools(() => undefined)],
    sandboxStatus: { active: true },
  });
  let executor!: SandboxedEnvironmentExecutor;
  const authority = new EnvironmentAuthority({
    config: loadAgentConfig(cwd, { providers: {} }, env),
    descriptor,
    sandbox: prepared,
    approvals,
    writes,
    executor: () => executor,
  });
  executor = new SandboxedEnvironmentExecutor({
    sandbox: prepared,
    cwd,
    descriptor,
    request: (kind, payload, intent, signal) =>
      authority.request(kind, payload as Record<string, any>, intent, signal),
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
      budgetMs: 20_000,
    };
    return { ...value, argumentDigest: intentDigest(value) };
  };
  return { descriptor, executor, make };
}

/** The gateway end: daemon app, its own durable journal and the authenticated environment link. */
async function startGateway(root: string, port: number, bindings: Binding[]) {
  const config = { ...daemonConfig(), stateDir: path.join(root, 'daemon'), port };
  const { app, services } = await buildDaemonApp(config);
  const journal = new ExecutionJournal(path.join(root, 'gateway-journal.sqlite'));
  const incoming = new ChunkStore(path.join(root, `gateway-chunks-${randomUUID()}`));
  let flow!: EnvironmentFlow;
  const remote = new RemoteEnvironment({
    nodeId: 'test',
    journal,
    authorize: authorizeFrom(bindings),
    send: (message) => flow.send(message),
    timeoutMs: 5000,
  });
  flow = new EnvironmentFlow({
    send: (raw) => services.nodes.sendEnvironmentFrame('test', raw),
    append: (...args) => incoming.append(...args),
    take: (id) => incoming.take(id),
    discard: (id) => incoming.discard(id),
    receive: (message) => remote.receive(message),
    failed: () => remote.disconnect(),
  });
  services.nodes.onEnvironmentFrame = async (_nodeId, raw) => {
    await flow.receive(raw);
  };
  await app.listen({ host: '127.0.0.1', port });
  const close = async () => {
    remote.disconnect();
    flow.close();
    await app.close();
    journal.close();
  };
  return {
    port: (app.server.address() as { port: number }).port,
    services,
    journal,
    remote,
    close,
  };
}

/** The node end: node runtime whose environment harness serves `local` and owns `approvals`. */
async function startNodeLink(
  root: string,
  port: number,
  local: LocalEnvironment,
  approvals: ApprovalAuthority,
) {
  const outgoing = new ChunkStore(path.join(root, `node-chunks-${randomUUID()}`));
  let flow: EnvironmentFlow | undefined;
  const node = await startNode(
    testConfig({ nodeId: 'test', nodeToken: 't'.repeat(32), daemonUrl: `ws://127.0.0.1:${port}` }),
    {
      connect: (send) => {
        local.reconnect();
        approvals.reconnect();
        flow = new EnvironmentFlow({
          send,
          append: (...args) => outgoing.append(...args),
          take: (id) => outgoing.take(id),
          discard: (id) => outgoing.discard(id),
          receive: async (message) => {
            await flow!.send(await dispatchEnvironment(local, message));
          },
          failed: () => local.disconnect(),
        });
      },
      receive: (raw) => flow!.receive(raw),
      disconnect: () => {
        // A lost link withdraws every pending human approval (§5 rule 5).
        approvals.disconnect();
        local.disconnect();
        flow?.close();
      },
    },
  );
  return node;
}

const authorizeFrom = (bindings: Binding[]) => (actual: Binding) => {
  const same = (expected: Binding) =>
    (Object.keys(expected) as Array<keyof Binding>).every((key) => actual[key] === expected[key]);
  if (!bindings.some(same)) throw new Error('unprovisioned fixture binding');
};

const lines = (file: string) =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;

async function terminal(
  remote: RemoteEnvironment,
  binding: Binding,
  id: string,
): Promise<ExecutionRecord> {
  let record!: ExecutionRecord;
  await waitFor(
    async () => {
      try {
        record = await remote.status(binding, id);
        return Boolean(record.terminal);
      } catch {
        return false;
      }
    },
    true,
    10_000,
  );
  return record;
}

test('fake-srt subprocess recovery across both-end restart: effects never replay and lost approvals stay denied', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-env-recovery-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  for (const dir of [cwd, path.join(root, 'config'), path.join(root, 'daemon')]) mkdirSync(dir);
  writeFileSync(
    path.join(root, 'config', 'config.json'),
    JSON.stringify({ features: { autoMode: { enabled: false } } }),
  );
  const previous = process.env.PIRC_CONFIG_DIR;
  process.env.PIRC_CONFIG_DIR = path.join(root, 'config');
  cleanups.push(() => {
    if (previous === undefined) delete process.env.PIRC_CONFIG_DIR;
    else process.env.PIRC_CONFIG_DIR = previous;
  });

  const gen1 = generation();
  // An unrelated workspace may continue; the quarantined workspace cannot get
  // a replacement generation, even under a new session/writer identity.
  const gen2 = { ...generation(), workspaceId: 'test:other', sessionId: randomUUID() };
  const bindings = [gen1, gen2];
  const nodeJournalFile = path.join(root, 'node-journal.sqlite');
  const approvalsFile = path.join(root, 'approvals.sqlite');
  let writes = new WriteBroker();

  // --- First lifetime of both ends.
  let gateway = await startGateway(root, 0, bindings);
  const port = gateway.port;
  cleanups.push(() => gateway.close());
  let nodeJournal = new ExecutionJournal(nodeJournalFile);
  cleanups.push(() => nodeJournal.close());
  const notices: EnvironmentApproval[] = [];
  let approvals = new ApprovalAuthority(approvalsFile, (record) => notices.push(record));
  cleanups.push(() => approvals.close());
  let local = new LocalEnvironment({
    nodeId: 'test',
    journal: nodeJournal,
    authorize: authorizeFrom(bindings),
    unfencedHarness: true,
  });
  const first = await provisionGeneration(root, gen1, approvals, writes);
  cleanups.push(async () => {
    try {
      await first.executor.closeAndWait();
    } catch (error) {
      if (!String(error).includes('quarantined')) throw error;
    }
  });
  local.provision(first.descriptor, first.executor);
  gateway.journal.provision(gen1, first.descriptor.revision, first.descriptor.policyRevision);
  let node = await startNodeLink(root, port, local, approvals);
  cleanups.push(() => node.close());
  await waitFor(() => gateway.services.nodes.list().length, 1);

  // A: an ordinary effect, received and acknowledged.
  const a = first.make('bash', { command: 'echo a >> a.txt' });
  await gateway.remote.start(a);
  const aDone = await terminal(gateway.remote, gen1, a.executionId);
  expect(aDone.state).toBe('completed');
  expect(gateway.journal.receipt(gen1, a.executionId)?.resultDigest).toBe(aDone.resultDigest);
  await gateway.remote.ack(gen1, a.executionId, aDone.resultDigest!);

  // B: a host execution waiting for a human when the link drops. The approval
  // is withdrawn, the operation is refused without running, and the old
  // interaction cannot be answered after the link returns.
  const b = first.make('unsandboxed_bash', { command: 'echo b >> b.txt', reason: 'fixture' });
  await gateway.remote.start(b);
  await waitFor(() => notices.length, 1);
  gateway.services.nodes.disconnect('test');
  await waitFor(() => gateway.services.nodes.list().length, 0);
  await waitFor(() => gateway.services.nodes.list().length, 1, 7000);
  gateway.remote.reconnect();
  const bDone = await terminal(gateway.remote, gen1, b.executionId);
  // A tool-level refusal is not proof of absence, so the record stays
  // conservative (`unknown`); the file below is the evidence it never ran.
  expect(bDone.state).toBe('failed');
  expect(bDone.effect).not.toBe('completed');
  const lost = notices[0]!;
  expect(
    approvals.humanAnswer(lost.binding, lost.interactionId, lost.finalArgumentDigest, true),
  ).toBe(false);
  expect(existsSync(path.join(cwd, 'b.txt'))).toBe(false);

  // C: an effect lands, then the executor dies before reporting a result.
  const c = first.make('bash', { command: 'echo c >> c.txt; sleep 60' });
  await gateway.remote.start(c);
  await waitFor(() => existsSync(path.join(cwd, 'c.txt')), true);
  first.executor.close();
  await first.executor.stopped;

  // --- Both ends go down: the gateway and the node daemon stop, the node
  // supervisor fences generation 1 before its journal closes.
  await gateway.close();
  const fenced = await fenceEnvironment({
    binding: gen1,
    environment: local,
    executor: first.executor,
    journal: nodeJournal,
    approvals,
    writes,
  });
  expect(fenced.recovered.every((record) => record.state !== 'running')).toBe(true);
  if (!fenced.quarantined) throw new Error('expected quarantine without aggregate fencing');
  // Without aggregate proof (no delegated cgroup here) the session keeps its
  // write lease: another session cannot take the workspace.
  expect(writes.acquire(randomUUID(), realpathSync(cwd)).granted).toBe(false);
  await local.close();
  await node.close();
  approvals.close();
  nodeJournal.close();

  // --- Second lifetime of both ends, from the same durable files.
  nodeJournal = new ExecutionJournal(nodeJournalFile);
  writes = new WriteBroker();
  restoreEnvironmentQuarantines(nodeJournal, writes);
  expect(writes.acquire(randomUUID(), realpathSync(cwd)).granted).toBe(false);
  expect(writes.acquire(gen1.sessionId, realpathSync(cwd)).granted).toBe(false);
  writes.release(gen1.sessionId);
  expect(writes.acquire(randomUUID(), realpathSync(cwd)).granted).toBe(false);
  for (const replacement of [
    { ...gen1, executorEpoch: randomUUID() },
    { ...gen1, sessionId: randomUUID(), writerEpoch: randomUUID(), executorEpoch: randomUUID() },
  ])
    expect(() =>
      nodeJournal.provision(
        replacement,
        first.descriptor.revision,
        first.descriptor.policyRevision,
      ),
    ).toThrow('quarantined');
  approvals = new ApprovalAuthority(approvalsFile, (record) => notices.push(record));
  // A restarted authority starts with every earlier approval expired.
  expect(
    approvals.humanAnswer(lost.binding, lost.interactionId, lost.finalArgumentDigest, true),
  ).toBe(false);
  local = new LocalEnvironment({
    nodeId: 'test',
    journal: nodeJournal,
    authorize: authorizeFrom(bindings),
    unfencedHarness: true,
  });
  local.adoptRetired(gen1);
  const otherRoot = path.join(root, 'other');
  for (const directory of ['workspace', 'config'])
    mkdirSync(path.join(otherRoot, directory), { recursive: true });
  writeFileSync(
    path.join(otherRoot, 'config', 'config.json'),
    JSON.stringify({ features: { autoMode: { enabled: false } } }),
  );
  const second = await provisionGeneration(otherRoot, gen2, approvals, writes);
  cleanups.push(async () => {
    try {
      await second.executor.closeAndWait();
    } catch (error) {
      if (!String(error).includes('quarantined')) throw error;
    }
  });
  local.provision(second.descriptor, second.executor);
  gateway = await startGateway(root, port, bindings);
  gateway.journal.provision(gen2, second.descriptor.revision, second.descriptor.policyRevision);
  node = await startNodeLink(root, port, local, approvals);
  await waitFor(() => gateway.services.nodes.list().length, 1, 7000);

  // The gateway reconciles generation 1 by status only. C's effect is
  // reported unknown, never rerun; the earlier ACK of A survived both restarts.
  const cDone = await terminal(gateway.remote, gen1, c.executionId);
  expect(cDone.state).toBe('unknown');
  expect(cDone.effect).toBe('unknown');
  expect(gateway.journal.receipt(gen1, c.executionId)?.state).toBe('unknown');
  expect((await gateway.remote.status(gen1, a.executionId)).acknowledged).toBe(true);
  expect((await gateway.remote.status(gen1, b.executionId)).state).toBe('failed');
  // A retried start of any generation-1 ID cannot run again.
  for (const intent of [a, b, c]) await expect(gateway.remote.start(intent)).rejects.toThrow();
  await expect(
    gateway.remote.start(first.make('bash', { command: 'echo late >> late.txt' })),
  ).rejects.toThrow();
  expect(lines(path.join(cwd, 'a.txt'))).toBe(1);
  expect(lines(path.join(cwd, 'c.txt'))).toBe(1);
  expect(existsSync(path.join(cwd, 'b.txt'))).toBe(false);
  expect(existsSync(path.join(cwd, 'late.txt'))).toBe(false);
  await gateway.remote.ack(gen1, c.executionId, cDone.resultDigest!);

  // An unrelated workspace works after both restarts, without regranting the quarantined one.
  const d = second.make('bash', { command: 'echo d >> d.txt' });
  await gateway.remote.start(d);
  expect((await terminal(gateway.remote, gen2, d.executionId)).state).toBe('completed');
  expect(lines(path.join(otherRoot, 'workspace', 'd.txt'))).toBe(1);
  expect(existsSync(path.join(cwd, 'd.txt'))).toBe(false);
  await local.close();
}, 60_000);
