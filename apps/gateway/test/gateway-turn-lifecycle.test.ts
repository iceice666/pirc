import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayTurnLifecycle } from '../src/gateway-runtime/turn-lifecycle.js';
import { EnvironmentArtifacts } from '../src/environment/artifacts.js';
import { ArtifactTransfer } from '../src/environment/artifact-transfer.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import { RemoteEnvironment } from '../src/environment/remote.js';
import { dispatchEnvironment } from '../src/environment/service.js';
import { canonicalJson } from '../src/environment/json.js';
import {
  descriptorDigest,
  intentDigest,
  encodeMessage,
  decodeMessage,
  type Descriptor,
  type Environment,
} from '../src/environment/protocol.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-turn-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = path.join(root, 'authority.sqlite');
  let authority = new GatewaySessionAuthority(db);
  let storage = new EnvironmentArtifacts(path.join(root, 'artifacts'));
  const journal = new ExecutionJournal(path.join(root, 'gateway.sqlite'));
  cleanups.push(() => {
    authority.close();
    storage.close();
    journal.close();
  });
  const transfer = authority.prepare({
    owner: 'alice',
    nodeId: 'test',
    workspaceId: 'test:workspace',
    legacySessionIds: [],
  });
  // Synthetic fencing receipt, no live writer termination or containment claim.
  const lease = authority.activate({ ...transfer, fenced: true });
  let descriptor: Descriptor = {
    binding: lease.binding,
    version: 1,
    revision: '',
    policyRevision: 'b'.repeat(64),
    capabilityCatalog: [
      {
        name: 'read',
        argumentSchema: {},
        resultSchema: {},
        placement: 'node',
        effects: 'read',
        concurrency: 'read',
        approval: 'none',
        hookRevision: 'c'.repeat(64),
      },
    ],
    instructions: 'untrusted node instructions',
    skills: [],
    role: 'general',
    platform: 'linux',
    cwdDisplay: '/node-only/workspace',
    sandboxStatus: { active: true },
    limits: { maxActive: 1, maxBudgetMs: 1000 },
  };
  descriptor.revision = descriptorDigest(descriptor);
  journal.provision(lease.binding, descriptor.revision, descriptor.policyRevision);
  let online = true;
  let pins = 0;
  let fetches = 0;
  let afterFetch: (() => void) | undefined;
  let beforeDescribe: (() => Promise<void>) | undefined;
  let corrupt = false;
  let losePin = false;
  const authorize = (binding: typeof lease.binding) => {
    if (canonicalJson(binding, 65536) !== canonicalJson(lease.binding, 65536))
      throw new Error('Foreign binding');
  };
  const artifacts = () => new ArtifactTransfer({ authorize, storage, online: () => online });
  let remote!: RemoteEnvironment;
  const unsupported = async (): Promise<never> => {
    throw new Error('No executor in turn fixture');
  };
  const environment: Environment = {
    describe: async () => {
      await beforeDescribe?.();
      return descriptor;
    },
    start: unsupported,
    status: unsupported,
    cancel: unsupported,
    ack: unsupported,
  };
  remote = new RemoteEnvironment({
    nodeId: 'test',
    journal,
    authorize,
    timeoutMs: 1000,
    send: async (message) => {
      const request = decodeMessage(encodeMessage(message));
      if (request.type === 'artifact.pin') pins++;
      const reply = await dispatchEnvironment(environment, request, artifacts());
      if (request.type === 'artifact.pin' && losePin) {
        losePin = false;
        remote.disconnect();
        return;
      }
      if (reply.type === 'artifact.chunk') {
        fetches++;
        afterFetch?.();
        if (corrupt)
          reply.data = Buffer.alloc(Buffer.from(reply.data, 'base64').length, 1).toString('base64');
      }
      await remote.receive(decodeMessage(encodeMessage(reply)));
    },
  });
  cleanups.push(() => remote.disconnect());
  const lifecycle = () =>
    new GatewayTurnLifecycle({ authority, environment: remote, online: () => online });
  let runtime = lifecycle();
  const artifact = await storage.put(
    lease.binding,
    Buffer.from('synthetic image bytes'),
    'image/png',
  );
  const input = () => ({
    runId: randomUUID(),
    turnId: randomUUID(),
    text: 'inspect image',
    attachments: [artifact],
  });
  return {
    lease,
    artifact,
    input,
    remote,
    get authority() {
      return authority;
    },
    get storage() {
      return storage;
    },
    get runtime() {
      return runtime;
    },
    get descriptor() {
      return descriptor;
    },
    get pins() {
      return pins;
    },
    get fetches() {
      return fetches;
    },
    update(patch: Partial<Descriptor>) {
      descriptor = { ...descriptor, ...patch };
      descriptor.revision = descriptorDigest(descriptor);
    },
    online(value: boolean) {
      online = value;
      if (value) remote.reconnect();
      else remote.disconnect();
    },
    onFetch(fn: () => void) {
      afterFetch = fn;
    },
    onDescribe(fn: () => Promise<void>) {
      beforeDescribe = fn;
    },
    corrupt() {
      corrupt = true;
    },
    losePin() {
      losePin = true;
    },
    restart() {
      authority.close();
      storage.close();
      authority = new GatewaySessionAuthority(db);
      storage = new EnvironmentArtifacts(path.join(root, 'artifacts'));
      runtime = lifecycle();
    },
  };
}

test('turn descriptor, verified model bytes and pinned provenance survive restart; offline projection is explicit', async () => {
  const f = await fixture();
  const input = f.input();
  const turn = await f.runtime.begin(f.lease, input);
  expect(turn.descriptor.cwdDisplay).toBe('/node-only/workspace');
  expect((turn.entry as any).message.content[1].data).toBe(
    Buffer.from('synthetic image bytes').toString('base64'),
  );
  expect(f.pins).toBe(1);
  await expect(f.storage.removeUnreferenced(f.lease.binding, f.artifact)).rejects.toThrow(
    'referenced',
  );
  f.restart();
  const replay = await f.runtime.begin(f.lease, input);
  expect(replay.entry.id).toBe(turn.entry.id);
  expect(f.fetches).toBe(1);
  await expect(f.storage.removeUnreferenced(f.lease.binding, f.artifact)).rejects.toThrow(
    'referenced',
  );
  f.online(false);
  const event = f.runtime.project(f.lease.binding.sessionId, 'alice')[0]!;
  expect(event.attachments[0]!.reference.availability).toBe('unavailable');
  expect(event.attachments[0]!.classification).toBe('private-session-content');
  expect(JSON.stringify(event)).not.toContain(
    Buffer.from('synthetic image bytes').toString('base64'),
  );
  expect(() => f.runtime.project(f.lease.binding.sessionId, 'bob')).toThrow('owner');
  await expect(f.runtime.begin(f.lease, f.input())).rejects.toThrow('offline');
  expect(f.authority.read(f.lease.binding.sessionId, 'alice').history).toHaveLength(1);
  f.online(true);
  expect(
    f.runtime.project(f.lease.binding.sessionId, 'alice')[0]!.attachments[0]!.reference
      .availability,
  ).toBe('available');
});

test('changed descriptors fail closed before another turn or after async attachment fetch', async () => {
  const f = await fixture();
  await f.runtime.begin(f.lease, f.input());
  f.update({ instructions: 'new config' });
  await expect(f.runtime.begin(f.lease, f.input())).rejects.toThrow('handoff');
  expect(f.pins).toBe(1);
  f.restart();
  await expect(f.runtime.begin(f.lease, f.input())).rejects.toThrow('handoff');
  const g = await fixture();
  g.onFetch(() => g.update({ instructions: 'changed while fetching' }));
  await expect(g.runtime.begin(g.lease, g.input())).rejects.toThrow('changed during');
  expect(g.authority.read(g.lease.binding.sessionId, 'alice').entries).toHaveLength(0);
});

test('binding, sandbox, image owner, budget, digest and pin failures never append a partial turn', async () => {
  const f = await fixture();
  await expect(
    f.runtime.begin(f.lease, {
      ...f.input(),
      attachments: [{ ...f.artifact, sessionId: randomUUID() }],
    }),
  ).rejects.toThrow('owner');
  await expect(
    f.runtime.begin(f.lease, {
      ...f.input(),
      attachments: [{ ...f.artifact, bytes: 5 * 1024 * 1024 }],
    }),
  ).rejects.toThrow('budget');
  expect(f.pins).toBe(0);
  f.update({ sandboxStatus: { active: false } });
  await expect(f.runtime.begin(f.lease, f.input())).rejects.toThrow('sandbox');
  f.update({
    sandboxStatus: { active: true },
    binding: { ...f.lease.binding, executorEpoch: randomUUID() },
  });
  await expect(f.runtime.begin(f.lease, f.input())).rejects.toThrow('descriptor');
  f.update({ binding: f.lease.binding });
  f.losePin();
  const input = f.input();
  await expect(f.runtime.begin(f.lease, input)).rejects.toThrow('offline');
  expect(f.authority.read(f.lease.binding.sessionId, 'alice').entries).toHaveLength(0);
  f.online(true);
  f.corrupt();
  await expect(f.runtime.begin(f.lease, input)).rejects.toThrow('digest');
  expect(f.authority.read(f.lease.binding.sessionId, 'alice').entries).toHaveLength(0);
  await expect(f.storage.removeUnreferenced(f.lease.binding, f.artifact)).rejects.toThrow(
    'referenced',
  );
});

test('lost pin reply retries safely and changed turn IDs conflict without new reads', async () => {
  const f = await fixture();
  const input = f.input();
  f.losePin();
  await expect(f.runtime.begin(f.lease, input)).rejects.toThrow('offline');
  f.restart();
  f.online(true);
  await f.runtime.begin(f.lease, input);
  expect(f.pins).toBe(2);
  expect(f.fetches).toBe(1);
  await expect(f.runtime.begin(f.lease, { ...input, text: 'different' })).rejects.toThrow(
    'conflict',
  );
  expect(f.authority.read(f.lease.binding.sessionId, 'alice').history).toHaveLength(1);
});

test('branch/revocation/cancellation races cannot publish an admitted turn', async () => {
  for (const kind of ['fork', 'revoke', 'abort', 'offline']) {
    const f = await fixture();
    const controller = new AbortController();
    f.onFetch(() => {
      if (kind === 'fork') f.authority.fork(f.lease, null);
      if (kind === 'revoke') f.authority.revoke(f.lease.binding);
      if (kind === 'abort') controller.abort(new Error('cancelled'));
      if (kind === 'offline') f.online(false);
    });
    await expect(f.runtime.begin(f.lease, f.input(), controller.signal)).rejects.toThrow();
    expect(
      f.authority.read(f.lease.binding.sessionId, 'alice', f.lease.branchId).entries,
    ).toHaveLength(0);
  }
});

test('one preparation per session, snapshots inputs and validates execution against admitted turn', async () => {
  const f = await fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.onDescribe(() => wait);
  const input = f.input();
  const original = structuredClone(input);
  const pending = f.runtime.begin(f.lease, input);
  input.text = 'mutated after admission';
  await expect(f.runtime.begin(f.lease, f.input())).rejects.toThrow('quota');
  release();
  const turn = await pending;
  expect(turn.input.text).toBe(original.text);
  const base = {
    binding: f.lease.binding,
    executionId: randomUUID(),
    runId: original.runId,
    turnId: original.turnId,
    toolCallId: randomUUID(),
    descriptorRevision: turn.descriptor.revision,
    policyRevision: turn.descriptor.policyRevision,
    capability: 'read',
    arguments: {},
    budgetMs: 1000,
  };
  f.authority.persistExecution(f.lease, { ...base, argumentDigest: intentDigest(base) });
  const bad = { ...base, executionId: randomUUID(), descriptorRevision: 'f'.repeat(64) };
  expect(() =>
    f.authority.persistExecution(f.lease, { ...bad, argumentDigest: intentDigest(bad) }),
  ).toThrow('authoritative turn');
  const missing = { ...base, executionId: randomUUID(), turnId: randomUUID() };
  expect(() =>
    f.authority.persistExecution(f.lease, { ...missing, argumentDigest: intentDigest(missing) }),
  ).toThrow('No authoritative turn');
  f.authority.fork(f.lease, null);
  expect(f.runtime.project(f.lease.binding.sessionId, 'alice')).toEqual([]);
  expect(f.runtime.project(f.lease.binding.sessionId, 'alice', f.lease.branchId)).toHaveLength(1);
});

test('first preparation durably enrolls before await, failure and restart; foundation executions cannot enroll', async () => {
  const f = await fixture();
  const input = f.input();
  const base = {
    binding: f.lease.binding,
    executionId: randomUUID(),
    runId: input.runId,
    turnId: input.turnId,
    toolCallId: randomUUID(),
    descriptorRevision: f.descriptor.revision,
    policyRevision: f.descriptor.policyRevision,
    capability: 'read',
    arguments: {},
    budgetMs: 1000,
  };
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.onDescribe(() => paused);
  const abort = new AbortController();
  const pending = f.runtime.begin(f.lease, input, abort.signal);
  const persist = () =>
    f.authority.persistExecution(f.lease, { ...base, argumentDigest: intentDigest(base) });
  expect(persist).toThrow('No authoritative turn');
  abort.abort(new Error('cancel first preparation'));
  await expect(pending).rejects.toThrow('cancel first');
  expect(persist).toThrow('No authoritative turn');
  f.restart();
  expect(persist).toThrow('No authoritative turn');
  release();
  const g = await fixture();
  const previous = { ...base, binding: g.lease.binding };
  g.authority.persistExecution(g.lease, { ...previous, argumentDigest: intentDigest(previous) });
  await expect(g.runtime.begin(g.lease, g.input())).rejects.toThrow('foundation session');
});

test('abort promptly releases quota for unresolved descriptor, pin and chunk requests; late replies never append', async () => {
  for (const phase of ['describe', 'pinArtifact', 'fetchArtifact'] as const) {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const runtime = new GatewayTurnLifecycle({
      authority: f.authority,
      online: () => true,
      environment: {
        describe: async (binding) => {
          if (phase === 'describe') {
            entered();
            await waiting;
          }
          return f.remote.describe(binding);
        },
        pinArtifact: async (binding, artifact) => {
          if (phase === 'pinArtifact') {
            entered();
            await waiting;
          }
          return f.remote.pinArtifact(binding, artifact);
        },
        fetchArtifact: async (binding, artifact, offset, limit) => {
          if (phase === 'fetchArtifact') {
            entered();
            await waiting;
          }
          return f.remote.fetchArtifact(binding, artifact, offset, limit);
        },
      },
    });
    const controller = new AbortController();
    const pending = runtime.begin(f.lease, f.input(), controller.signal);
    await started;
    controller.abort(new Error('cancel stalled request'));
    await expect(pending).rejects.toThrow('cancel stalled');
    const second = new AbortController();
    second.abort(new Error('slot is reusable'));
    await expect(runtime.begin(f.lease, f.input(), second.signal)).rejects.toThrow(
      'slot is reusable',
    );
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.authority.read(f.lease.binding.sessionId, 'alice').entries).toHaveLength(0);
  }
});

test('reference-only projection paginates branch ancestry without exposing image-bearing entries', async () => {
  const f = await fixture();
  for (let index = 0; index < 18; index++)
    await f.runtime.begin(f.lease, { ...f.input(), text: `turn ${index}` });
  const first = f.runtime.project(f.lease.binding.sessionId, 'alice');
  const second = f.runtime.project(f.lease.binding.sessionId, 'alice', undefined, 16);
  expect(first).toHaveLength(16);
  expect(second).toHaveLength(2);
  expect(second[0]!.text).toBe('turn 16');
  expect(JSON.stringify(first)).not.toContain('"data":');
  f.authority.fork(f.lease, null);
  expect(f.runtime.project(f.lease.binding.sessionId, 'alice')).toEqual([]);
  expect(() => f.runtime.project(f.lease.binding.sessionId, 'alice', undefined, -1)).toThrow(
    'page',
  );
});
