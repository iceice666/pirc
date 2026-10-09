import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { gatewaySchedulerDispatch } from '../src/gateway-runtime/scheduler-dispatch.js';
import { descriptorDigest, type Descriptor } from '../src/environment/protocol.js';
import type { GatewayAgentRuntime } from '../src/gateway-runtime/runtime.js';
import type { SessionRow } from '../src/database.js';
test('scheduler progress correlates exact service run and never retargets legacy references', async () => {
  const authority = new GatewaySessionAuthority(':memory:');
  try {
    const lease = authority.activate({
      ...authority.prepare({
        owner: 'alice',
        nodeId: 'n',
        workspaceId: 'n:w',
        legacySessionIds: ['0123456789abcdef'],
      }),
      fenced: true,
    });
    const session = {
      id: 'directory',
      piSessionId: lease.binding.sessionId,
      workspaceId: 'n:w',
      nodeId: 'n',
      ownerUser: 'alice',
    } as SessionRow;
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
    const first = { runId: randomUUID(), turnId: randomUUID(), text: 'first', attachments: [] };
    authority.enrollServiceTurn(lease, first, 'scheduled-run', { runId: 'first' });
    authority.startRun(lease, authority.commitTurn(lease, first, descriptor, []));
    authority.finishRun(lease.binding, first.runId, 'completed');
    const second = { runId: randomUUID(), turnId: randomUUID(), text: 'second', attachments: [] };
    authority.enrollServiceTurn(lease, second, 'scheduled-run', { runId: 'second' });
    authority.commitTurn(lease, second, descriptor, []);
    const adapter = gatewaySchedulerDispatch({
      authority,
      runtime: {} as GatewayAgentRuntime,
      create: async () => {
        throw new Error('No create');
      },
      writer: () => lease,
    });
    expect(
      await adapter.progress(session, 'alice', 0, (message) => message.details?.runId === 'second'),
    ).toEqual({ state: 'working' });
    await adapter.close();
    await expect(
      adapter.deliver({ ...session, piSessionId: '0123456789abcdef' }, 'alice', {
        customType: 'scheduled-run',
        content: 'legacy',
      }),
    ).rejects.toThrow('Legacy');
  } finally {
    authority.close();
  }
});
