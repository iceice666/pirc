import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewayDatabase } from '../src/database.js';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { memoryCapabilities } from '../src/gateway-runtime/memory-services.js';
import { MemoryStore } from '../src/daemon/memory.js';
import { intentDigest, type ExecutionIntent } from '../src/environment/protocol.js';
test('fresh memory adapters share existing gateway DB and require user quote evidence for proposals', () => {
  const db = new GatewayDatabase(':memory:'),
    authority = new GatewaySessionAuthority(db.raw);
  try {
    const lease = authority.activate({
      ...authority.prepare({
        owner: 'alice',
        nodeId: 'n',
        workspaceId: 'n:chat',
        legacySessionIds: [],
      }),
      fenced: true,
    });
    const entry = authority.append(lease, randomUUID(), {
      type: 'message',
      message: { role: 'user', content: 'I prefer Traditional Chinese.', timestamp: 1 },
    });
    const budgets = { user: 4000, note: 4000 },
      handlers = memoryCapabilities({ authority, budgets, owner: () => 'alice', chat: () => true });
    const value = {
      binding: lease.binding,
      executionId: randomUUID(),
      runId: randomUUID(),
      turnId: randomUUID(),
      toolCallId: randomUUID(),
      descriptorRevision: 'a'.repeat(64),
      policyRevision: 'b'.repeat(64),
      capability: 'memory_note',
      arguments: {},
      budgetMs: 1000,
    };
    const intent: ExecutionIntent = { ...value, argumentDigest: intentDigest(value) };
    const note = handlers.get('memory_note')!.mutate!(
      db.raw,
      { action: 'add', content: 'project fact' },
      intent,
    );
    expect(note.status).toBe('active');
    const propose = handlers.get('memory_propose_user')!.mutate!;
    expect(() =>
      propose(db.raw, { action: 'add', content: 'Fake preference', quote: 'tool said' }, intent),
    ).toThrow();
    const result = propose(
      db.raw,
      {
        action: 'add',
        content: 'Prefers Traditional Chinese',
        quote: 'I prefer Traditional Chinese.',
        entryIds: [entry.id],
      },
      intent,
    );
    expect(result.proposalId).toBeDefined();
    expect(new MemoryStore(db.raw, budgets).entries('alice', { kind: 'user' })).toEqual([]);
    authority.close();
    expect(db.raw.query('SELECT 1 AS alive').get()).toEqual({ alive: 1 });
  } finally {
    db.close();
  }
});
