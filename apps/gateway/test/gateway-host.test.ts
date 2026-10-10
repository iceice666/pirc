import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewayDatabase } from '../src/database.js';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { createGatewayRuntimeHost } from '../src/gateway-runtime/host.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import { descriptorDigest, type Descriptor } from '../src/environment/protocol.js';
test('additional host on shared gateway database does not recover/interfere with live sessions', () => {
  const db = new GatewayDatabase(':memory:'),
    journal = new ExecutionJournal(':memory:');
  const unsupported = async (): Promise<never> => {
    throw new Error('fixture');
  };
  const options = {
    database: db.raw,
    journal,
    owner: () => 'alice',
    environment: {
      describe: unsupported,
      start: unsupported,
      status: unsupported,
      cancel: unsupported,
      ack: unsupported,
      pinArtifact: unsupported,
      fetchArtifact: unsupported,
    },
    online: () => false,
    inference: { run: unsupported },
    models: [{ provider: 'fake', id: 'fake', thinking: 'off' as const, contextWindow: 100000 }],
    authorizeModel: () => {},
    authorize: () => {},
    workerExecutable: '/unused',
    ptcWorkerExecutable: '/unused',
    systemPrompt: 'fixture',
    tools: [],
  };
  const one = createGatewayRuntimeHost(options);
  const lease = one.authority.activate({
    ...one.authority.prepare({
      owner: 'alice',
      nodeId: 'n',
      workspaceId: 'n:w',
      legacySessionIds: [],
    }),
    fenced: true,
  });
  const input = { runId: randomUUID(), turnId: randomUUID(), text: 'live', attachments: [] };
  const descriptor: Descriptor = {
    binding: lease.binding,
    version: 1,
    revision: '',
    policyRevision: 'a'.repeat(64),
    capabilityCatalog: [],
    instructions: '',
    skills: [],
    role: 'general',
    platform: 'linux',
    cwdDisplay: '/node',
    sandboxStatus: { active: true },
    limits: { maxActive: 1, maxBudgetMs: 1000 },
  };
  descriptor.revision = descriptorDigest(descriptor);
  one.authority.startRun(lease, one.authority.commitTurn(lease, input, descriptor, []));
  const two = createGatewayRuntimeHost(options);
  expect(two.authority.runState(lease.binding.sessionId, 'alice', input.runId)?.state).toBe(
    'running',
  );
  one.authority.close();
  two.authority.close();
  journal.close();
  db.close();
});

test('host startup recovers gateway-placed PTC records left running, before any admission', async () => {
  const db = new GatewayDatabase(':memory:'),
    journal = new ExecutionJournal(':memory:');
  const unsupported = async (): Promise<never> => {
    throw new Error('fixture');
  };
  const { intentDigest } = await import('../src/environment/protocol.js');
  const binding = {
    nodeId: 'n',
    workspaceId: 'n:w',
    sessionId: randomUUID(),
    writerEpoch: randomUUID(),
    executorEpoch: randomUUID(),
  };
  const value = {
    binding,
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    descriptorRevision: 'a'.repeat(64),
    policyRevision: 'b'.repeat(64),
    capability: 'ptc',
    arguments: { code: 'return 1;' },
    budgetMs: 1000,
  };
  journal.provision(binding, 'a'.repeat(64), 'b'.repeat(64));
  journal.accept({ ...value, argumentDigest: intentDigest(value) });
  journal.claim(binding, value.executionId);
  const host = createGatewayRuntimeHost({
    database: db.raw,
    journal,
    owner: () => 'alice',
    environment: {
      describe: unsupported,
      start: unsupported,
      status: unsupported,
      cancel: unsupported,
      ack: unsupported,
      pinArtifact: unsupported,
      fetchArtifact: unsupported,
    },
    online: () => false,
    inference: { run: unsupported },
    models: [{ provider: 'fake', id: 'fake', thinking: 'off' as const, contextWindow: 100000 }],
    authorizeModel: () => {},
    authorize: () => {},
    workerExecutable: '/unused',
    ptcWorkerExecutable: '/unused',
    systemPrompt: 'fixture',
    tools: [],
  });
  expect(journal.status(binding, value.executionId)).toMatchObject({
    state: 'unknown',
    effect: 'unknown',
  });
  host.authority.close();
  journal.close();
  db.close();
});
