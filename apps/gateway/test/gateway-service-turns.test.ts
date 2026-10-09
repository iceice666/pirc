import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { descriptorDigest, type Descriptor } from '../src/environment/protocol.js';
test('trusted schedule/delegation ingress remains custom agent evidence, never user memory evidence', () => {
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
    const input = {
      runId: randomUUID(),
      turnId: randomUUID(),
      text: 'Service says I prefer X',
      attachments: [],
    };
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
    authority.enrollServiceTurn(lease, input, 'delegation', { fromSessionId: 'agent-source' });
    const turn = authority.commitTurn(lease, input, descriptor, []);
    expect(turn.entry.type).toBe('message');
    expect((turn.entry as any).message.role).toBe('custom');
    expect(
      authority.userEvidence(lease.binding.sessionId, 'alice', [turn.entry.id], 'I prefer X'),
    ).toEqual([]);
    expect(() =>
      authority.enrollServiceTurn(lease, { ...input, text: 'changed' }, 'delegation', {}),
    ).toThrow('conflict');
  } finally {
    authority.close();
  }
});
