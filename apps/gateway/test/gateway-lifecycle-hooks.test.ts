import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import {
  descriptorDigest,
  type Descriptor,
  type Environment,
  type ExecutionIntent,
} from '../src/environment/protocol.js';
import { GatewayLifecycleHooks } from '../src/gateway-runtime/lifecycle-hooks.js';

test('aborting a lifecycle hook relays node cancellation rather than only dropping the wait', async () => {
  const binding = {
    nodeId: 'n',
    workspaceId: 'n:w',
    sessionId: randomUUID(),
    writerEpoch: randomUUID(),
    executorEpoch: randomUUID(),
  };
  let started!: () => void;
  const admission = new Promise<void>((resolve) => (started = resolve));
  let cancelled = 0;
  const environment = {
    start: async () => {
      started();
      return new Promise(() => {});
    },
    cancel: async () => {
      cancelled++;
      return {} as never;
    },
  } as unknown as Environment;
  const hooks = new GatewayLifecycleHooks(environment),
    controller = new AbortController();
  const run = hooks.run(
    { binding, branchId: randomUUID() },
    { runId: randomUUID(), turnId: randomUUID(), text: 'x', attachments: [] },
    {
      binding,
      revision: 'a'.repeat(64),
      policyRevision: 'b'.repeat(64),
      lifecycleHooks: ['beforePrompt'],
      limits: { maxBudgetMs: 1000 },
    } as Descriptor,
    'beforePrompt',
    controller.signal,
  );
  await admission;
  controller.abort();
  await expect(run).rejects.toThrow();
  expect(cancelled).toBe(1);
});

test('interrupted lifecycle phase remains authoritative and blocks work until original-ID status recovery', async () => {
  const authority = new GatewaySessionAuthority(':memory:'),
    journal = new ExecutionJournal(':memory:');
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
      lifecycleHooks: ['beforePrompt'],
    };
    descriptor.revision = descriptorDigest(descriptor);
    journal.provision(lease.binding, descriptor.revision, descriptor.policyRevision);
    let started!: () => void, intent: ExecutionIntent | undefined;
    const admitted = new Promise<void>((resolve) => (started = resolve));
    const environment: Environment = {
      describe: async () => descriptor,
      start: async (value) => {
        intent = value;
        journal.accept(value);
        journal.claim(value.binding, value.executionId);
        started();
        return new Promise(() => {});
      },
      status: async (binding, id) => journal.status(binding, id),
      cancel: async (binding, id) => journal.cancel(binding, id),
      ack: async (binding, id, hash) => {
        journal.ack(binding, id, hash);
      },
    };
    const controller = new AbortController(),
      hooks = new GatewayLifecycleHooks(environment, authority);
    const running = hooks.run(
      lease,
      { runId: randomUUID(), turnId: randomUUID(), text: 'prompt', attachments: [] },
      descriptor,
      'beforePrompt',
      controller.signal,
    );
    await admitted;
    controller.abort();
    await expect(running).rejects.toThrow();
    expect(authority.hasUnresolvedExecutions(lease.binding.sessionId, 'alice')).toBe(true);
    const record = journal.finish(lease.binding, intent!.executionId, {
      state: 'completed',
      effect: 'completed',
      output: { text: 'original-hook-context' },
      artifacts: [],
      truncated: false,
    });
    authority.commitLifecycle(record);
    await environment.ack(record.binding, record.executionId, record.resultDigest!);
    authority.markLifecycleAck(record.binding, record.executionId);
    expect(authority.hasUnresolvedExecutions(lease.binding.sessionId, 'alice')).toBe(false);
    expect(
      authority.customEntries(
        lease.binding.sessionId,
        'alice',
        lease.branchId,
        'runtime.lifecycle.result',
      ),
    ).toHaveLength(1);
    expect(authority.lifecycleRecovery(lease.binding.sessionId, 'alice')).toEqual([]);
    let replay = 0;
    const retained = {
      ...environment,
      start: async () => {
        replay++;
        throw new Error('Node reclaimed output');
      },
    };
    const cached = await new GatewayLifecycleHooks(retained, authority).run(
      lease,
      { runId: intent!.runId, turnId: intent!.turnId, text: 'prompt', attachments: [] },
      descriptor,
      'beforePrompt',
      new AbortController().signal,
    );
    expect(cached).toBe('original-hook-context');
    expect(replay).toBe(0);
  } finally {
    journal.close();
    authority.close();
  }
});
