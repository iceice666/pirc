import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import {
  GatewayClientProjection,
  runtimeClientSnapshot,
} from '../src/gateway-runtime/client-projection.js';
import { GatewayInteractions } from '../src/gateway-runtime/interactions.js';
import { GatewayWorkspaceRecords } from '../src/gateway-runtime/workspace-records.js';
import { selectWorkspaceMemory } from '../src/gateway-runtime/workspace-selection.js';
import { descriptorDigest, intentDigest, type Descriptor } from '../src/environment/protocol.js';
import { emptyUsage } from '../src/agent/messages.js';
import { capabilityMetadata } from '../src/environment/catalog.js';
import { createGoal } from '../src/agent/features/goal/model.js';

const activate = (authority: GatewaySessionAuthority, owner = 'alice') =>
  authority.activate({
    ...authority.prepare({ owner, nodeId: 'n', workspaceId: 'n:w', legacySessionIds: [] }),
    fenced: true,
  });

test('client streaming and inner operations survive reconnect with atomic dedup and branch isolation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-m4-')),
    file = path.join(root, 'authority.sqlite');
  let authority = new GatewaySessionAuthority(file);
  try {
    const lease = activate(authority),
      clients = new GatewayClientProjection(authority),
      runId = randomUUID(),
      callId = randomUUID();
    const message = {
      role: 'assistant' as const,
      api: 'fake',
      provider: 'fake',
      model: 'fake',
      usage: emptyUsage(),
      timestamp: 1,
      stopReason: 'stop' as const,
      content: [],
    };
    clients.runtime(lease, {
      sessionId: lease.binding.sessionId,
      runId,
      callId,
      seq: 1,
      type: 'message_start',
      message,
    });
    const delta = {
      sessionId: lease.binding.sessionId,
      runId,
      callId,
      seq: 2,
      type: 'message_update' as const,
      assistantMessageEvent: { type: 'text_delta' as const, contentIndex: 0, delta: 'hello' },
    };
    clients.runtime(lease, delta);
    clients.runtime(lease, delta);
    expect(clients.snapshot(lease, 'alice').partialMessage?.content[0]?.text).toBe('hello');
    expect(() =>
      clients.runtime(lease, {
        ...delta,
        assistantMessageEvent: { ...delta.assistantMessageEvent, delta: 'forged' },
      }),
    ).toThrow('conflict');
    const descriptor: Descriptor = {
      binding: lease.binding,
      version: 1,
      revision: '',
      policyRevision: 'b'.repeat(64),
      capabilityCatalog: [
        {
          name: 'read',
          ...capabilityMetadata('read'),
          argumentSchema: {},
          resultSchema: {},
          hookRevision: 'a'.repeat(64),
        },
      ],
      instructions: '',
      skills: [],
      role: 'general',
      platform: 'linux',
      cwdDisplay: '/node',
      sandboxStatus: { active: true },
      limits: { maxActive: 1, maxBudgetMs: 1000 },
    };
    descriptor.revision = descriptorDigest(descriptor);
    const turnId = randomUUID();
    authority.commitTurn(lease, { runId, turnId, text: 'Read', attachments: [] }, descriptor, []);
    const intent = {
      binding: lease.binding,
      runId,
      turnId,
      toolCallId: randomUUID(),
      executionId: randomUUID(),
      descriptorRevision: descriptor.revision,
      policyRevision: descriptor.policyRevision,
      capability: 'ptc',
      arguments: { code: 'return await tools.read({});' },
      budgetMs: 1000,
    };
    authority.persistExecution(lease, { ...intent, argumentDigest: intentDigest(intent) });
    const operation = {
      type: 'tool_execution_start',
      toolCallId: `${intent.executionId}:op1`,
      toolName: 'read',
      args: { path: 'private.txt' },
    };
    clients.operation(lease, intent.executionId, operation, 1);
    expect(clients.snapshot(lease, 'alice').operations[0]?.parentToolCallId).toBe(
      intent.toolCallId,
    );
    expect(() =>
      clients.operation(lease, intent.executionId, { ...operation, toolCallId: 'foreign:op1' }, 2),
    ).toThrow('identity');
    const cursor = authority.watermark(lease.binding.sessionId, 'alice');
    authority.close();
    authority = new GatewaySessionAuthority(file);
    const restored = new GatewayClientProjection(authority);
    expect(restored.snapshot(lease, 'alice').operations).toHaveLength(1);
    expect(restored.events(lease, 'alice').filter((item) => item.type === 'pi_event')).toHaveLength(
      3,
    );
    expect(restored.events(lease, 'alice', cursor)).toHaveLength(0);
    expect(() => restored.snapshot(lease, 'bob')).toThrow('owner');
    const fork = authority.fork(lease, null);
    expect(restored.snapshot(fork, 'alice').operations).toHaveLength(0);
    expect(() => restored.operation(lease, intent.executionId, operation, 2)).toThrow();
    const stopped = runtimeClientSnapshot({
      authority,
      lease: fork,
      owner: 'alice',
      running: false,
      live: restored.snapshot(lease, 'alice'),
    });
    expect(stopped.partialMessage).toBeNull();
    expect(stopped.operations).toHaveLength(0);
    authority.append(fork, randomUUID(), {
      type: 'custom',
      customType: 'runtime.feature.todo',
      data: {
        version: 1,
        nextId: 2,
        todos: [{ id: 1, text: 'Verify reconnect', status: 'pending', blockedBy: [] }],
      },
    });
    authority.append(fork, randomUUID(), {
      type: 'custom',
      customType: 'runtime.feature.goal',
      data: JSON.parse(JSON.stringify(createGoal(randomUUID(), 'Finish M4', 2))),
    });
    const snapshot = () =>
      runtimeClientSnapshot({ authority, lease: fork, owner: 'alice', running: false });
    expect(snapshot().widgets['local-todo']).toEqual(['TODO · 0/1', '☐ Verify reconnect']);
    expect(snapshot().widgets.goal?.[0]).toContain('disarmed');
    expect(restored.events(fork, 'alice').at(-1)?.type).toBe('reset');
    const empty = authority.fork(fork, null);
    expect(
      runtimeClientSnapshot({ authority, lease: empty, owner: 'alice', running: false }).widgets,
    ).toEqual({});
  } finally {
    authority.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('gateway questions publish reconnect events and cannot cross branches or node approval namespaces', async () => {
  const authority = new GatewaySessionAuthority(':memory:'),
    lease = activate(authority),
    questions = new GatewayInteractions(authority),
    signal = new AbortController();
  try {
    const answer = questions.ask(
      lease,
      'alice',
      { question: 'Choose', options: [{ label: 'one' }, { label: 'two' }] },
      signal.signal,
    );
    const question = questions.list(lease.binding.sessionId, 'alice')[0]!;
    expect(question.id.startsWith('gateway-question-')).toBe(true);
    const events = authority.events(lease.binding.sessionId, 'alice');
    expect(events.some((item) => (item.event as any).event?.type === 'interaction_created')).toBe(
      true,
    );
    const fork = authority.fork(lease, null);
    expect(questions.list(lease.binding.sessionId, 'alice')).toHaveLength(0);
    expect(() => questions.answer(fork, 'alice', question.id, { selected: ['one'] })).toThrow(
      'stale',
    );
    signal.abort();
    expect((await answer).status).toBe('cancelled');
  } finally {
    questions.close();
    authority.close();
  }
});

test('workspace model selection preserves host provenance and rejects partial or invented source evidence', async () => {
  const candidates = [
    {
      id: 'a'.repeat(12),
      kind: 'reflection' as const,
      content: 'Repository decision',
      origins: ['tool:web_search'],
    },
  ];
  const result = await selectWorkspaceMemory(
    candidates,
    async (_system, _prompt, tool) => {
      expect(() =>
        tool.execute({
          add: [{ content: 'Forged', relevance: 'high', sourceMemoryIds: ['b'.repeat(12)] }],
        }),
      ).toThrow('source');
      tool.execute({
        add: [
          { content: 'Keep the decision', relevance: 'high', sourceMemoryIds: [candidates[0]!.id] },
        ],
      });
    },
    new AbortController().signal,
  );
  expect(result.add[0]?.origins).toEqual(['tool:web_search']);
  await expect(
    selectWorkspaceMemory(
      candidates,
      async (_s, _p, tool) => {
        tool.execute({
          add: [{ content: 'Incomplete', relevance: 'high', sourceMemoryIds: [candidates[0]!.id] }],
        });
        throw new Error('Truncated memory reply');
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow('Truncated');
});

test('fresh workspace mirror is owner checked and forgetting removes search and recall without legacy fallback', () => {
  const authority = new GatewaySessionAuthority(':memory:');
  try {
    const lease = activate(authority),
      records = new GatewayWorkspaceRecords(authority);
    const descriptor: Descriptor = {
      binding: lease.binding,
      version: 1,
      revision: '',
      policyRevision: 'a'.repeat(64),
      repositoryKey: 'a'.repeat(16),
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
    authority.commitTurn(
      lease,
      { runId: randomUUID(), turnId: randomUUID(), text: 'private', attachments: [] },
      descriptor,
      [],
    );
    const item = {
      id: 'b'.repeat(12),
      content: 'Private repository decision',
      relevance: 'high' as const,
      timestamp: '2026-10-09',
      sessionId: lease.binding.sessionId,
      sessionDir: '',
      source: {
        authority: 'gateway' as const,
        nodeId: 'n',
        repositoryKey: descriptor.repositoryKey!,
        sessionId: lease.binding.sessionId,
        branchId: lease.branchId,
      },
      sourceMemoryIds: ['c'.repeat(12)],
      tokenCount: 8,
    };
    records.sync(lease.binding, 'alice', {
      repositoryKey: descriptor.repositoryKey!,
      items: [item],
    });
    expect(records.search('alice', 'repository').hits).toHaveLength(1);
    expect(records.search('bob', 'repository').hits).toHaveLength(0);
    expect(() =>
      records.sync(lease.binding, 'bob', {
        repositoryKey: descriptor.repositoryKey!,
        items: [item],
      }),
    ).toThrow('owner');
    expect(() =>
      records.sync(lease.binding, 'alice', { repositoryKey: 'f'.repeat(16), items: [item] }),
    ).toThrow('repository');
    expect(records.search('alice', 'repository').hits).toHaveLength(1);
    records.sync(lease.binding, 'alice', { repositoryKey: descriptor.repositoryKey!, items: [] });
    expect(records.search('alice', 'repository').hits).toHaveLength(0);
    expect(records.recall('alice', item.id).status).toBe('source_unavailable');
  } finally {
    authority.close();
  }
});
