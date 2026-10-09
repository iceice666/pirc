import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayInteractions } from '../src/gateway-runtime/interactions.js';
test('gateway general question preserves owner and cannot impersonate node sandbox approval', async () => {
  const authority = new GatewaySessionAuthority(':memory:');
  const lease = authority.activate({
      ...authority.prepare({
        owner: 'alice',
        nodeId: 'n',
        workspaceId: 'n:w',
        legacySessionIds: [],
      }),
      fenced: true,
    }),
    interactions = new GatewayInteractions(authority);
  try {
    const waiting = interactions.ask(
      lease,
      'alice',
      { question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
      new AbortController().signal,
    );
    const id = interactions.list(lease.binding.sessionId, 'alice')[0]!.id;
    expect(id.startsWith('gateway-question-')).toBe(true);
    expect(() => interactions.answer(lease, 'bob', id, { selected: ['A'] })).toThrow('owner');
    expect(() =>
      interactions.answer(lease, 'alice', 'node-environment-' + randomUUID(), { confirmed: true }),
    ).toThrow();
    interactions.answer(lease, 'alice', id, { selected: ['A'], custom: 'detail' });
    expect((await waiting).status).toBe('answered');
    expect(() => interactions.answer(lease, 'alice', id, { selected: ['A'] })).toThrow('stale');
  } finally {
    interactions.close();
    authority.close();
  }
});
