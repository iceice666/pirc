import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { GatewayCapabilities } from '../src/gateway-runtime/capabilities.js';
import { InnerJournal } from '../src/environment/inner-journal.js';
import { capabilityMetadata } from '../src/environment/catalog.js';
import { innerIntent } from '../src/environment/ptc-operation.js';
import {
  descriptorDigest,
  intentDigest,
  type Descriptor,
  type ExecutionIntent,
} from '../src/environment/protocol.js';

test('central DB mutation and original-ID result commit together on the same connection', async () => {
  const db = new Database(':memory:');
  const inner = new InnerJournal(db);
  db.exec('CREATE TABLE effects(id TEXT PRIMARY KEY);');
  const binding = {
    nodeId: 'n',
    workspaceId: 'n:w',
    sessionId: randomUUID(),
    writerEpoch: randomUUID(),
    executorEpoch: randomUUID(),
  };
  const descriptor: Descriptor = {
    binding,
    version: 1,
    revision: '',
    policyRevision: 'b'.repeat(64),
    capabilityCatalog: [
      {
        name: 'schedule',
        ...capabilityMetadata('schedule'),
        argumentSchema: { type: 'object' },
        resultSchema: {},
        hookRevision: 'c'.repeat(64),
      },
    ],
    instructions: '',
    skills: [],
    role: 'general',
    platform: 'linux',
    cwdDisplay: '/node',
    sandboxStatus: { active: true },
    limits: { maxActive: 1, maxBudgetMs: 120_000 },
  };
  descriptor.revision = descriptorDigest(descriptor);
  const value = {
    binding,
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    descriptorRevision: descriptor.revision,
    policyRevision: descriptor.policyRevision,
    capability: 'ptc',
    arguments: { code: 'await tools.schedule({});' },
    budgetMs: 120_000,
  };
  const parent: ExecutionIntent = { ...value, argumentDigest: intentDigest(value) };
  inner.register(parent, ['schedule']);
  const call = innerIntent(parent, `${parent.executionId}:op1`, 'schedule', {});
  inner.accept(call);
  let mutations = 0;
  const capabilities = new GatewayCapabilities({
    inner,
    descriptor: () => descriptor,
    authorize: () => {},
    capabilities: new Map([
      [
        'schedule',
        {
          mutate: (transaction: Database) => {
            expect(transaction).toBe(db);
            mutations++;
            transaction.query('INSERT INTO effects VALUES (?)').run(call.executionId);
            return { text: 'created' };
          },
        },
      ],
    ]),
  });
  try {
    expect((await capabilities.execute(call, new AbortController().signal)).ok).toBe(true);
    expect((await capabilities.execute(call, new AbortController().signal)).ok).toBe(true);
    expect(mutations).toBe(1);
    expect(db.query('SELECT * FROM effects').all()).toHaveLength(1);
  } finally {
    db.close();
  }
});
