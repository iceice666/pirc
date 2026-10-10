import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LocalEnvironment,
  dispatchEnvironment,
  unsolicitedResult,
} from '../src/environment/service.js';
import { RemoteEnvironment } from '../src/environment/remote.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import { ApprovalAuthority } from '../src/environment/approvals.js';
import { EnvironmentArtifacts } from '../src/environment/artifacts.js';
import { HookReceipts } from '../src/environment/hook-receipts.js';
import {
  descriptorDigest,
  intentDigest,
  type Descriptor,
  type Binding,
  type ExecutionIntent,
} from '../src/environment/protocol.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const binding = (): Binding => ({
  nodeId: 'n',
  workspaceId: 'n:w',
  sessionId: randomUUID(),
  writerEpoch: randomUUID(),
  executorEpoch: randomUUID(),
});
function fixture() {
  const bound = binding();
  const journal = new ExecutionJournal(':memory:');
  cleanups.push(() => journal.close());
  const gateway = new ExecutionJournal(':memory:');
  cleanups.push(() => gateway.close());
  const content: Omit<Descriptor, 'revision'> = {
    binding: bound,
    version: 1,
    policyRevision: 'a'.repeat(64),
    capabilityCatalog: [
      {
        name: 'read',
        argumentSchema: {},
        resultSchema: {},
        placement: 'node',
        effects: 'read',
        concurrency: 'read',
        approval: 'policy',
        hookRevision: 'b'.repeat(64),
      },
    ],
    instructions: '',
    skills: [],
    role: 'coding',
    platform: 'linux',
    cwdDisplay: '/fixture',
    sandboxStatus: { active: true },
    limits: { maxActive: 1, maxBudgetMs: 1000 },
  };
  const descriptor = { ...content, revision: descriptorDigest(content) };
  const value = {
    binding: bound,
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    capability: 'read',
    arguments: {},
    descriptorRevision: descriptor.revision,
    policyRevision: descriptor.policyRevision,
    budgetMs: 1000,
  };
  const intent: ExecutionIntent = { ...value, argumentDigest: intentDigest(value) };
  return { bound, journal, gateway, descriptor, intent };
}

test('local/remote adapter persists, deduplicates and reconciles without automatically ACKing', async () => {
  const f = fixture();
  let executions = 0;
  let remote!: RemoteEnvironment;
  const local = new LocalEnvironment({
    nodeId: 'n',
    journal: f.journal,
    authorize: () => {},
    unfencedHarness: true,
    result: (record) => {
      void remote.receive(unsolicitedResult(record));
    },
  });
  local.provision(f.descriptor, {
    healthy: true,
    async execute() {
      executions++;
      return {
        state: 'completed',
        effect: 'completed',
        artifacts: [],
        truncated: false,
        output: 'done',
      };
    },
  });
  f.gateway.provision(f.bound, f.descriptor.revision, f.descriptor.policyRevision);
  remote = new RemoteEnvironment({
    nodeId: 'n',
    journal: f.gateway,
    authorize: () => {},
    send: async (message) => {
      await remote.receive(await dispatchEnvironment(local, message));
    },
  });
  expect(await remote.describe(f.bound)).toEqual(f.descriptor);
  await remote.start(f.intent);
  await Bun.sleep(10);
  expect((await remote.status(f.bound, f.intent.executionId)).state).toBe('completed');
  await remote.start(f.intent);
  expect(executions).toBe(1);
  const receipt = f.gateway.receipt(f.bound, f.intent.executionId)!;
  expect(receipt.resultDigest).toBeDefined();
  expect(f.journal.status(f.bound, f.intent.executionId).acknowledged).toBe(false);
  await remote.ack(f.bound, f.intent.executionId, receipt.resultDigest!);
  expect(f.journal.status(f.bound, f.intent.executionId).acknowledged).toBe(true);
  local.disconnect();
  remote.disconnect();
  await expect(remote.start(f.intent)).rejects.toThrow('offline');
  await local.close();
});

test('admission snapshots arguments and executor loss stays reconcilable', async () => {
  const f = fixture();
  let seen: unknown;
  const local = new LocalEnvironment({
    nodeId: 'n',
    journal: f.journal,
    authorize: () => {},
    unfencedHarness: true,
  });
  local.provision(f.descriptor, {
    healthy: true,
    async execute(intent, _signal, event) {
      seen = intent.arguments;
      for (let n = 0; n < 10_000; n++) event('progress', { text: 'bounded' });
      throw new Error('Executor lost after side effect');
    },
  });
  const starting = local.start(f.intent);
  (f.intent.arguments as Record<string, unknown>).mutated = true;
  await starting;
  await Bun.sleep(10);
  expect(seen).toEqual({});
  const record = await local.status(f.bound, f.intent.executionId);
  expect(record.state).toBe('unknown');
  expect(f.journal.events(f.bound, f.intent.executionId).length).toBeLessThanOrEqual(1);
  expect(
    f.journal.reconcile(f.bound, f.intent.executionId, {
      state: 'completed',
      effect: 'completed',
      artifacts: [],
      truncated: false,
    }).state,
  ).toBe('completed');
  await local.close();
});

test('hook receipts bind execution and capability, consume once and do not replay post-hooks', () => {
  const f = fixture();
  const receipts = new HookReceipts(':memory:');
  cleanups.push(() => receipts.close());
  const receipt = receipts.issue(f.intent, { path: 'rewritten' });
  expect(() =>
    receipts.consume({ ...f.intent, executionId: randomUUID() }, receipt.id, receipt.digest),
  ).toThrow('unavailable');
  expect(() =>
    receipts.consume({ ...f.intent, capability: 'bash' }, receipt.id, receipt.digest),
  ).toThrow('unavailable');
  expect(receipts.consume(f.intent, receipt.id, receipt.digest)).toEqual({ path: 'rewritten' });
  expect(() => receipts.consume(f.intent, receipt.id, receipt.digest)).toThrow('unavailable');
  expect(receipts.claimPost(f.bound, receipt.id)).toBe(true);
  expect(receipts.claimPost(f.bound, receipt.id)).toBe(false);
  receipts.finishPost(f.bound, receipt.id, false);
  expect(receipts.claimPost(f.bound, receipt.id)).toBe(false);
});

test('unprovisioned bindings, unavailable sandbox and wrong request direction fail closed', async () => {
  const f = fixture();
  const local = new LocalEnvironment({
    nodeId: 'n',
    journal: f.journal,
    authorize: () => {},
    unfencedHarness: true,
  });
  await expect(local.start(f.intent)).rejects.toThrow('binding');
  local.provision(f.descriptor, {
    healthy: false,
    async execute() {
      throw new Error('must not execute');
    },
  });
  await expect(local.start(f.intent)).rejects.toThrow('Sandbox');
  await expect(
    dispatchEnvironment(local, {
      version: 1,
      requestId: randomUUID(),
      type: 'execution.acknowledged',
    }),
  ).rejects.toThrow('direction');
  expect(() => f.journal.status(f.bound, f.intent.executionId)).toThrow('Unknown');
});

test('approval authority binds final arguments and expires on disconnect; replay cannot approve', async () => {
  const f = fixture();
  let notice: any;
  const authority = new ApprovalAuthority(':memory:', (value) => {
    notice = value;
  });
  cleanups.push(() => authority.close());
  const controller = new AbortController();
  const answer = authority.request(
    f.intent,
    {
      finalArgumentDigest: 'c'.repeat(64),
      action: 'danger',
      title: 'Allow?',
      message: 'exact command',
    },
    controller.signal,
  );
  expect(authority.humanAnswer(binding(), notice.interactionId, 'c'.repeat(64), true)).toBe(false);
  expect(authority.humanAnswer(f.bound, notice.interactionId, 'd'.repeat(64), true)).toBe(false);
  expect(authority.humanAnswer(f.bound, notice.interactionId, 'c'.repeat(64), true)).toBe(true);
  expect(await answer).toBe(true);
  expect(authority.humanAnswer(f.bound, notice.interactionId, 'c'.repeat(64), true)).toBe(false);
  const pending = authority.request(
    f.intent,
    {
      finalArgumentDigest: 'c'.repeat(64),
      action: 'host_exec',
      title: 'Host?',
      message: 'exact command',
    },
    controller.signal,
  );
  authority.disconnect();
  expect(await pending).toBe(false);
  authority.reconnect();
  expect(authority.humanAnswer(f.bound, notice.interactionId, 'c'.repeat(64), true)).toBe(false);
});

test('artifact ownership, content digest and transcript pin prevent unintended access/removal', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pirc-env-artifacts-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new EnvironmentArtifacts(dir);
  cleanups.push(() => store.close());
  const owner = binding();
  const artifact = await store.put(owner, Buffer.from('hello'), 'text/plain');
  expect(Buffer.from(await store.chunk(owner, artifact, 0)).toString()).toBe('hello');
  await expect(store.chunk(binding(), artifact, 0)).rejects.toThrow('owner');
  await expect(store.chunk(owner, { ...artifact, digest: '0'.repeat(64) }, 0)).rejects.toThrow(
    'digest',
  );
  store.pin(owner, artifact);
  await expect(store.removeUnreferenced(owner, artifact)).rejects.toThrow('referenced');
});
