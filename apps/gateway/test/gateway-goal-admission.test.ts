import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayGoals } from '../src/gateway-runtime/goals.js';
import { branchFeatures } from '../src/gateway-runtime/branch-features.js';
import { createGoal } from '../src/agent/features/goal/model.js';
import { intentDigest, type ExecutionIntent } from '../src/environment/protocol.js';

test('goal arming changes only after commit, supports restart resume, and fences branch/writer identity', () => {
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
    const goal = createGoal(randomUUID(), 'Finish fixture', 4);
    const entry = authority.append(lease, randomUUID(), {
      type: 'custom',
      customType: 'runtime.feature.goal',
      data: JSON.parse(JSON.stringify(goal)),
    });
    const goals = new GatewayGoals(authority),
      db = authority.inner.operations.db;
    const make = (capability: string) => {
      const value = {
        binding: lease.binding,
        executionId: randomUUID(),
        runId: randomUUID(),
        turnId: randomUUID(),
        toolCallId: randomUUID(),
        descriptorRevision: 'a'.repeat(64),
        policyRevision: 'b'.repeat(64),
        capability,
        arguments: {},
        budgetMs: 1000,
      };
      const intent: ExecutionIntent = { ...value, argumentDigest: intentDigest(value) };
      authority.persistExecution(lease, intent);
      return intent;
    };
    const handlers = branchFeatures(
      (intent) => authority.executionBranch(intent),
      () => true,
      authority,
      goals,
    );
    const resume = make('update_goal'),
      resumeArgs = { goal_id: goal.id, revision: goal.revision, action: 'resume' };
    expect(goals.isArmed(lease)).toBe(false);
    db.transaction(() => handlers.get('update_goal')!.mutate!(db, resumeArgs, resume))();
    expect(goals.isArmed(lease)).toBe(false);
    handlers.get('update_goal')!.committed!(resume, resumeArgs);
    expect(goals.isArmed(lease)).toBe(true);
    const pause = make('update_goal'),
      pauseArgs = { goal_id: goal.id, revision: goal.revision, action: 'pause' };
    expect(() =>
      db.transaction(() => {
        handlers.get('update_goal')!.mutate!(db, pauseArgs, pause);
        throw new Error('rollback');
      })(),
    ).toThrow('rollback');
    expect(goals.state(lease, 'alice')?.phase).toBe('active');
    expect(goals.isArmed(lease)).toBe(true);
    expect(() =>
      goals.continuation(
        { ...lease, binding: { ...lease.binding, writerEpoch: randomUUID() } },
        'alice',
      ),
    ).toThrow('Stale writer');
    expect(goals.state(lease, 'alice')?.rounds).toBe(0);
    const fork = authority.fork(lease, entry.id);
    expect(goals.continuation(fork, 'alice')).toBeUndefined();
    expect(goals.isArmed(fork)).toBe(false);
    authority.revoke(fork.binding);
    expect(() => goals.arm(fork)).toThrow('Writer is not active');
  } finally {
    authority.close();
  }
});
