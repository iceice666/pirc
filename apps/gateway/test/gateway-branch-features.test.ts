import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { branchFeatures } from '../src/gateway-runtime/branch-features.js';
import { intentDigest, type ExecutionIntent } from '../src/environment/protocol.js';
test('transactional todo snapshots inherit selected branch ancestry rather than silently resetting', () => {
  const authority = new GatewaySessionAuthority(':memory:');
  try {
    const lease = authority.activate({
      ...authority.prepare({
        owner: 'alice',
        nodeId: 'n',
        workspaceId: 'n:w',
        legacySessionIds: [],
      }),
      fenced: true,
    });
    const make = (target: typeof lease) => {
      const value = {
        binding: target.binding,
        executionId: randomUUID(),
        runId: randomUUID(),
        turnId: randomUUID(),
        toolCallId: randomUUID(),
        descriptorRevision: 'a'.repeat(64),
        policyRevision: 'b'.repeat(64),
        capability: 'todo',
        arguments: {},
        budgetMs: 1000,
      };
      const intent: ExecutionIntent = { ...value, argumentDigest: intentDigest(value) };
      authority.persistExecution(target, intent);
      return intent;
    };
    const handlers = branchFeatures(
        (intent) => authority.executionBranch(intent),
        () => true,
        authority,
      ),
      db = authority.inner.operations.db;
    const first = make(lease);
    db.transaction(() =>
      handlers.get('todo')!.mutate!(db, { action: 'add', text: 'first' }, first),
    )();
    const boundary = authority.read(lease.binding.sessionId, 'alice').entries.at(-1)!.id;
    const second = make(lease);
    db.transaction(() =>
      handlers.get('todo')!.mutate!(db, { action: 'add', text: 'second' }, second),
    )();
    const fork = authority.fork(lease, boundary),
      read = make(fork);
    const state = db.transaction(() =>
      handlers.get('todo')!.mutate!(db, { action: 'list' }, read),
    )();
    expect((state.todos as any[]).map((item) => item.text)).toEqual(['first']);
  } finally {
    authority.close();
  }
});
