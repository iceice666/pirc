import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { NodeWriterFence } from '../src/gateway-runtime/node-writer-fence.js';
import type { WriterLease } from '../src/gateway-runtime/contracts.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import { RemoteEnvironment } from '../src/environment/remote.js';
import { LocalEnvironment, dispatchEnvironment } from '../src/environment/service.js';
import {
  intentDigest,
  type ExecutionIntent,
  type ExecutionRecord,
  type EnvironmentMessage,
} from '../src/environment/protocol.js';
import { emptyUsage } from '../src/agent/messages.js';
import { digest } from '../src/environment/json.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-authority-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'authority.sqlite');
  let authority = new GatewaySessionAuthority(file);
  let node = new NodeWriterFence(path.join(root, 'node.sqlite'), 'test');
  cleanup.push(() => {
    authority.close();
    node.close();
  });
  const prepare = () =>
    authority.prepare({
      owner: 'alice',
      nodeId: 'test',
      workspaceId: 'test:workspace',
      legacySessionIds: ['0123456789abcdef', `session_${randomUUID()}`],
    });
  const activate = async (transfer = prepare()) =>
    authority.activate(await node.fence(transfer, async () => {}));
  return {
    root,
    file,
    get authority() {
      return authority;
    },
    get node() {
      return node;
    },
    prepare,
    activate,
    restart() {
      authority.close();
      node.close();
      authority = new GatewaySessionAuthority(file);
      node = new NodeWriterFence(path.join(root, 'node.sqlite'), 'test');
    },
  };
}
const user = (text: string) => ({
  type: 'message' as const,
  message: { role: 'user' as const, content: text, timestamp: 1 },
});
const intentFor = (lease: WriterLease): ExecutionIntent => {
  const value = {
    binding: lease.binding,
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    descriptorRevision: 'a'.repeat(64),
    policyRevision: 'b'.repeat(64),
    capability: 'read',
    arguments: { path: 'file' },
    budgetMs: 1000,
  };
  return { ...value, argumentDigest: intentDigest(value) };
};
function resultFor(intent: ExecutionIntent, unknown = false): ExecutionRecord {
  const terminal = {
    state: unknown ? ('unknown' as const) : ('completed' as const),
    effect: unknown ? ('unknown' as const) : ('completed' as const),
    truncated: false,
    artifacts: [],
    output: { content: [{ type: 'text', text: unknown ? 'unknown outcome' : 'result' }] },
  };
  const record = {
    binding: intent.binding,
    executionId: intent.executionId,
    argumentDigest: intent.argumentDigest,
    state: terminal.state,
    effect: terminal.effect,
    terminal,
    finalSeq: 0,
    cancelRequested: false,
    acknowledged: false,
    reclaimed: false,
  };
  return {
    ...record,
    resultDigest: digest(
      {
        binding: record.binding,
        executionId: record.executionId,
        argumentDigest: record.argumentDigest,
        finalSeq: 0,
        terminal,
      },
      16 * 1024 * 1024,
    ),
  };
}

test('fresh identities require both durable fences; legacy files and references stay unavailable', async () => {
  const f = fixture();
  const oldFile = path.join(f.root, 'session.jsonl');
  writeFileSync(oldFile, '{"legacy":"private"}\n');
  const transfer = f.prepare();
  const lease = {
    binding: transfer.binding,
    branchId: f.authority.identities(transfer.binding.sessionId, 'alice').branchId,
  };
  expect(() => f.authority.append(lease, randomUUID(), user('blocked'))).toThrow('not active');
  expect(() => f.node.assertProvisioned(transfer.binding)).toThrow('Unfenced');
  await expect(
    f.node.fence(transfer, async () => {
      throw new Error('quarantined');
    }),
  ).rejects.toThrow('quarantined');
  f.restart();
  expect(() => f.node.assertLegacyAllowed(transfer.legacySessionIds[0]!)).toThrow(
    'permanently fenced',
  );
  expect(() => f.authority.read(transfer.legacySessionIds[0]!, 'alice')).toThrow('Legacy');
  expect(() => f.node.assertLegacyAllowed(transfer.legacySessionIds[1]!)).toThrow(
    'permanently fenced',
  );
  expect(() => f.authority.read(transfer.legacySessionIds[1]!, 'alice')).toThrow('Legacy');
  expect(() => f.authority.blockLegacy(['../../session'])).toThrow();
  expect(() => f.authority.read(randomUUID(), 'alice')).toThrow('Unknown');
  expect(() =>
    f.authority.activate({
      ...transfer,
      binding: { ...transfer.binding, writerEpoch: randomUUID() },
      fenced: true,
    }),
  ).toThrow('mismatch');
  const activated = await f.activate(transfer);
  f.node.assertProvisioned(activated.binding);
  expect(f.authority.read(activated.binding.sessionId, 'alice').entries).toEqual([]);
  expect(() => f.authority.blockLegacy([activated.binding.sessionId])).toThrow('reclassified');
  expect(() => f.authority.read(activated.binding.sessionId, 'bob')).toThrow('owner');
  const ids = f.authority.identities(activated.binding.sessionId, 'alice');
  expect(
    new Set([
      activated.binding.sessionId,
      activated.binding.writerEpoch,
      activated.binding.executorEpoch,
      ids.branchId,
      ids.contextId,
      ids.storeId,
    ]).size,
  ).toBe(6);
  expect(readFileSync(oldFile, 'utf8')).toBe('{"legacy":"private"}\n');
});

test('append dedup, schema bounds, replay metadata and compaction survive restart', async () => {
  const f = fixture();
  const lease = await f.activate();
  const operation = randomUUID();
  const first = f.authority.append(lease, operation, user('first'));
  expect(f.authority.append(lease, operation, user('first')).id).toBe(first.id);
  expect(() => f.authority.append(lease, operation, user('different'))).toThrow('conflict');
  const kept = f.authority.append(lease, randomUUID(), {
    type: 'message',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'thought', signature: 'opaque' },
        { type: 'text', text: 'answer', textSignature: 'phase' },
      ],
      api: 'responses',
      provider: 'alias',
      model: 'model',
      canonicalProvider: 'openai',
      responseId: 'response',
      responseModel: 'actual',
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: 2,
    },
  });
  expect(() =>
    f.authority.append(lease, randomUUID(), {
      type: 'compaction',
      summary: 'bad',
      firstKeptEntryId: randomUUID(),
      tokensBefore: 1,
    }),
  ).toThrow('boundary');
  f.authority.append(lease, randomUUID(), {
    type: 'compaction',
    summary: 'summary',
    firstKeptEntryId: kept.id,
    tokensBefore: 10,
  });
  expect(() =>
    f.authority.append(lease, randomUUID(), { ...user('bad'), extra: true } as any),
  ).toThrow();
  expect(() => f.authority.append(lease, randomUUID(), user('x'.repeat(8 * 1024 * 1024)))).toThrow(
    'byte limit',
  );
  expect(() =>
    f.authority.append(
      { ...lease, binding: { ...lease.binding, executorEpoch: randomUUID() } },
      randomUUID(),
      user('bad'),
    ),
  ).toThrow('Stale');
  f.restart();
  const view = f.authority.read(lease.binding.sessionId, 'alice');
  expect(view.history).toHaveLength(3);
  expect(view.context.map((item) => item.message.role)).toEqual(['compactionSummary', 'assistant']);
  expect(view.context[1]!.message).toEqual((kept as any).message);
});

test('branch and writer fences exclude stale appends while old results reconcile their original branch', async () => {
  const f = fixture();
  const lease = await f.activate();
  const first = f.authority.append(lease, randomUUID(), user('first'));
  const intent = intentFor(lease);
  f.authority.persistExecution(lease, intent);
  const fork = f.authority.fork(lease, first.id);
  expect(() => f.authority.append(lease, randomUUID(), user('stale'))).toThrow('branch');
  f.authority.append(fork, randomUUID(), user('new branch'));
  const record = resultFor(intent);
  f.authority.commitResult(record);
  f.authority.commitResult({ ...record, acknowledged: true });
  expect(f.authority.read(lease.binding.sessionId, 'alice').history).toHaveLength(2);
  expect(f.authority.read(lease.binding.sessionId, 'alice', lease.branchId).history).toHaveLength(
    2,
  );
  f.authority.revoke(lease.binding);
  f.node.revoke(lease.binding);
  f.restart();
  expect(() => f.authority.append(fork, randomUUID(), user('revoked'))).toThrow('not active');
  expect(() => f.node.assertProvisioned(lease.binding)).toThrow('revoked');
  const transfer = f.authority.pending(lease.binding.sessionId);
  expect(() => f.authority.activate({ ...transfer, fenced: true })).toThrow('revoked');
  f.authority.commitResult(record);
});

test('result and receipt are atomic; ACK retries after restart never produce a second tool result', async () => {
  const f = fixture();
  const lease = await f.activate();
  const intent = intentFor(lease);
  f.authority.persistExecution(lease, intent);
  const duplicateCall = { ...intent, executionId: randomUUID() };
  duplicateCall.argumentDigest = intentDigest(duplicateCall);
  expect(() => f.authority.persistExecution(lease, duplicateCall)).toThrow();
  let acks = 0;
  const environment = {
    ack: async () => {
      acks++;
      if (acks === 1) throw new Error('lost ACK');
    },
  };
  await expect(
    f.authority.acknowledge(environment, lease.binding, intent.executionId),
  ).rejects.toThrow('No committed');
  const result = resultFor(intent);
  expect(() => f.authority.commitResult({ ...result, resultDigest: 'f'.repeat(64) })).toThrow(
    'digest',
  );
  const oversized = resultFor(intent);
  oversized.terminal!.output = { content: [{ type: 'text', text: 'x'.repeat(9 * 1024 * 1024) }] };
  oversized.resultDigest = digest(
    {
      binding: oversized.binding,
      executionId: oversized.executionId,
      argumentDigest: oversized.argumentDigest,
      finalSeq: oversized.finalSeq,
      terminal: oversized.terminal,
    },
    16 * 1024 * 1024,
  );
  expect(() => f.authority.commitResult(oversized)).toThrow('byte limit');
  expect(f.authority.read(lease.binding.sessionId, 'alice').history).toHaveLength(0);
  f.authority.commitResult(result);
  await expect(
    f.authority.acknowledge(environment, lease.binding, intent.executionId),
  ).rejects.toThrow('lost ACK');
  f.restart();
  f.authority.commitResult(result);
  await f.authority.acknowledge(environment, lease.binding, intent.executionId);
  expect(acks).toBe(2);
  expect(f.authority.read(lease.binding.sessionId, 'alice').history).toHaveLength(1);
});

test('unknown refinement preserves original uncertainty without duplicate model tool results', async () => {
  const f = fixture();
  const lease = await f.activate();
  const intent = intentFor(lease);
  f.authority.persistExecution(lease, intent);
  f.authority.commitResult(resultFor(intent, true));
  f.authority.commitResult(resultFor(intent));
  f.authority.commitResult(resultFor(intent));
  const view = f.authority.read(lease.binding.sessionId, 'alice');
  expect(view.history).toHaveLength(1);
  expect(view.entries[1]!.type).toBe('custom');
  expect((view.entries[1] as any).customType).toBe('execution.reconciled');
  expect(() => f.authority.commitResult(resultFor(intent, true))).toThrow('conflict');
});

test('node fence concurrent retry verifies once and conflicting transfer is refused', async () => {
  const f = fixture();
  const transfer = f.prepare();
  let verifies = 0;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = async () => {
    verifies++;
    await wait;
  };
  const a = f.node.fence(transfer, stop);
  const b = f.node.fence(transfer, stop);
  const conflict = f.node.fence(
    { ...transfer, binding: { ...transfer.binding, writerEpoch: randomUUID() } },
    stop,
  );
  release();
  await a;
  await b;
  await expect(conflict).rejects.toThrow('conflict');
  expect(verifies).toBe(1);
  f.restart();
  await f.node.fence(transfer, async () => {
    throw new Error('must not repeat');
  });
});

test('remote Environment receipt is not an ACK: authority commits before lost ACK/reconnect recovery', async () => {
  const f = fixture();
  const lease = await f.activate();
  const gatewayJournal = new ExecutionJournal(path.join(f.root, 'gateway-env.sqlite'));
  const nodeJournal = new ExecutionJournal(path.join(f.root, 'node-env.sqlite'));
  cleanup.push(() => {
    gatewayJournal.close();
    nodeJournal.close();
  });
  const intent = intentFor(lease);
  // The node journal generation is created only by LocalEnvironment.provision (fresh, M6 R4).
  gatewayJournal.provision(lease.binding, intent.descriptorRevision, intent.policyRevision);
  let effects = 0;
  let dropAck = false;
  const local = new LocalEnvironment({
    nodeId: 'test',
    journal: nodeJournal,
    authorize: (binding) => f.node.assertProvisioned(binding),
    unfencedHarness: true,
  });
  // Component executor, not real OS containment evidence. Descriptor uses protocol digest.
  const { descriptorDigest } = await import('../src/environment/protocol.js');
  const descriptor = {
    binding: lease.binding,
    version: 1 as const,
    revision: '',
    policyRevision: intent.policyRevision,
    capabilityCatalog: [
      {
        name: 'read',
        argumentSchema: {},
        resultSchema: {},
        placement: 'node' as const,
        effects: 'read' as const,
        concurrency: 'read' as const,
        approval: 'none' as const,
        hookRevision: 'c'.repeat(64),
      },
    ],
    instructions: '',
    skills: [],
    role: 'coding',
    platform: 'linux' as const,
    cwdDisplay: '/synthetic',
    sandboxStatus: { active: true },
    limits: { maxActive: 1, maxBudgetMs: 1000 },
  };
  descriptor.revision = descriptorDigest(descriptor);
  intent.descriptorRevision = descriptor.revision;
  intent.argumentDigest = intentDigest(intent);
  gatewayJournal.refresh(lease.binding, descriptor.revision, descriptor.policyRevision);
  local.provision(descriptor, {
    healthy: true,
    execute: async () => {
      effects++;
      return resultFor(intent).terminal!;
    },
  });
  let remote!: RemoteEnvironment;
  remote = new RemoteEnvironment({
    nodeId: 'test',
    journal: gatewayJournal,
    authorize: () => {},
    timeoutMs: 50,
    send: async (message: EnvironmentMessage) => {
      const reply = await dispatchEnvironment(local, message);
      if (dropAck && message.type === 'execution.ack') {
        dropAck = false;
        remote.disconnect();
        return;
      }
      await remote.receive(reply);
    },
  });
  cleanup.push(() => remote.disconnect());
  f.authority.persistExecution(lease, intent);
  await remote.start(intent);
  let result = await remote.status(lease.binding, intent.executionId);
  // Drain the synthetic executor without polling a worker/process.
  await new Promise((resolve) => setTimeout(resolve, 10));
  result = await remote.status(lease.binding, intent.executionId);
  expect(gatewayJournal.receipt(lease.binding, intent.executionId)?.resultDigest).toBe(
    result.resultDigest,
  );
  expect(nodeJournal.status(lease.binding, intent.executionId).acknowledged).toBe(false);
  f.authority.commitResult(result);
  dropAck = true;
  await expect(f.authority.acknowledge(remote, lease.binding, intent.executionId)).rejects.toThrow(
    'offline',
  );
  f.restart();
  remote.reconnect();
  f.authority.commitResult(await remote.status(lease.binding, intent.executionId));
  await f.authority.acknowledge(remote, lease.binding, intent.executionId);
  expect(effects).toBe(1);
  expect(f.authority.read(lease.binding.sessionId, 'alice').history).toHaveLength(1);
  remote.disconnect();
  await expect(remote.start(intentFor(lease))).rejects.toThrow('offline');
  expect(f.authority.read(lease.binding.sessionId, 'alice').history).toHaveLength(1);
});
