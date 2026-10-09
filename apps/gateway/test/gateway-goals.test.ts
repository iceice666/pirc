import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayGoals } from '../src/gateway-runtime/goals.js';
import { createGoal } from '../src/agent/features/goal/model.js';
test('gateway goals preserve durable rounds but restart disarms automatic continuation', () => {
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
      }),
      goal = createGoal(randomUUID(), 'Finish fixture', 1);
    authority.append(lease, randomUUID(), {
      type: 'custom',
      customType: 'runtime.feature.goal',
      data: JSON.parse(JSON.stringify(goal)),
    });
    const scheduler = new GatewayGoals(authority);
    expect(scheduler.continuation(lease, 'alice')).toBeUndefined();
    scheduler.arm(lease);
    expect(scheduler.continuation(lease, 'alice')).toContain('not new human instructions');
    expect(scheduler.state(lease, 'alice')?.rounds).toBe(1);
    expect(new GatewayGoals(authority).continuation(lease, 'alice')).toBeUndefined();
    expect(scheduler.continuation(lease, 'alice')).toBeUndefined();
    expect(scheduler.state(lease, 'alice')?.phase).toBe('paused');
  } finally {
    authority.close();
  }
});
