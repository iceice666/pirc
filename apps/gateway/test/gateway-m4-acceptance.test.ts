import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { GatewayDatabase } from '../src/database.js';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayAgentRuntime } from '../src/gateway-runtime/runtime.js';
import { createGatewayRuntimeHost } from '../src/gateway-runtime/host.js';
import { GatewayWorkspaceMemory } from '../src/gateway-runtime/workspace-memory.js';
import { GatewayGoals } from '../src/gateway-runtime/goals.js';
import { gatewaySchedulerDispatch } from '../src/gateway-runtime/scheduler-dispatch.js';
import type { SessionRow } from '../src/database.js';
import { GatewayEnvironmentInteractions } from '../src/gateway-runtime/environment-interactions.js';
import { registerGatewayRuntimeRoutes } from '../src/gateway-runtime/routes.js';
import { ApprovalAuthority } from '../src/environment/approvals.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import {
  descriptorDigest,
  intentDigest,
  type Descriptor,
  type ExecutionIntent,
} from '../src/environment/protocol.js';
import { capabilityMetadata } from '../src/environment/catalog.js';
import { emptyUsage } from '../src/agent/messages.js';
import { OBS_RECORDED, hashId } from '../src/agent/features/memory/ledger.js';
import { createGoal } from '../src/agent/features/goal/model.js';
import { loadAgentConfig } from '../src/agent/config.js';
import { resolveChildEnvironment } from '../src/node/environment-child.js';
import type { WorkspaceItem } from '../src/agent/features/memory/workspace.js';
import type { WorkerAction } from '../src/gateway-runtime/worker.js';
import { waitFor } from './helpers.js';

const activate = (authority: GatewaySessionAuthority) =>
  authority.activate({
    ...authority.prepare({ owner: 'alice', nodeId: 'n', workspaceId: 'n:w', legacySessionIds: [] }),
    fenced: true,
  });
const input = () => ({
  runId: randomUUID(),
  turnId: randomUUID(),
  text: 'Continue project work',
  attachments: [],
});
function descriptor(lease: ReturnType<typeof activate>, names: string[] = []): Descriptor {
  const value: Descriptor = {
    binding: lease.binding,
    version: 1,
    revision: '',
    policyRevision: 'b'.repeat(64),
    repositoryKey: 'a'.repeat(16),
    capabilityCatalog: names.map((name) => ({
      name,
      ...capabilityMetadata(name),
      argumentSchema: { type: 'object' },
      resultSchema: { type: 'object' },
      hookRevision: 'a'.repeat(64),
    })),
    instructions: '',
    skills: [],
    role: 'general',
    platform: 'linux',
    cwdDisplay: '/node',
    sandboxStatus: { active: true },
    limits: { maxActive: 1, maxBudgetMs: 1000 },
  };
  value.revision = descriptorDigest(value);
  return value;
}
const workerFactory = () => ({
  drive: async (step: any, signal: AbortSignal) => {
    let action: WorkerAction = 'model';
    for (;;) {
      signal.throwIfAborted();
      const next: WorkerAction = await step(action);
      if (action === 'done') return;
      action = next;
    }
  },
  close: async () => {},
});
const reply = (model = 'main') => ({
  role: 'assistant' as const,
  api: 'fake',
  provider: 'fake',
  model,
  usage: emptyUsage(),
  timestamp: 1,
  stopReason: 'stop' as const,
  content: [{ type: 'text' as const, text: 'done' }],
});
const unavailable = async (): Promise<never> => {
  throw Error('No environment effects expected');
};

test('runtime uses its admitted model loop for workspace selection without an injected selector', async () => {
  const authority = new GatewaySessionAuthority(':memory:');
  let runtime: GatewayAgentRuntime | undefined;
  try {
    const lease = activate(authority),
      doc = descriptor(lease),
      seed = authority.commitTurn(lease, input(), doc, []);
    const sourceId = hashId('Durable project decision');
    authority.append(lease, randomUUID(), {
      type: 'custom',
      customType: OBS_RECORDED,
      data: {
        coversUpToId: seed.entry.id,
        observations: [
          {
            id: sourceId,
            content: 'Durable project decision',
            timestamp: '2026-10-09 12:00',
            relevance: 'high',
            sourceEntryIds: [seed.entry.id],
            tokenCount: 10,
          },
        ],
      },
    });
    const appended: any[] = [];
    let selectionCalls = 0;
    runtime = new GatewayAgentRuntime({
      authority,
      environment: {
        describe: async () => doc,
        pinArtifact: unavailable,
        fetchArtifact: unavailable,
      } as any,
      online: () => true,
      models: [{ provider: 'fake', id: 'main', thinking: 'off', contextWindow: 100000 }],
      authorizeModel: () => {},
      workerExecutable: '/unused',
      workerFactory,
      systemPrompt: '',
      tools: [],
      workspaceMemory: new GatewayWorkspaceMemory({
        authority,
        maxTokens: 1000,
        snapshot: async () => ({ repositoryKey: doc.repositoryKey!, items: [] }),
        append: async (_binding, value) => {
          appended.push(value);
          return {
            id: hashId(value.content),
            ...value,
            timestamp: '2026-10-09',
            sessionId: lease.binding.sessionId,
            sessionDir: '',
            tokenCount: 10,
            source: {
              authority: 'gateway',
              nodeId: 'n',
              repositoryKey: doc.repositoryKey!,
              sessionId: lease.binding.sessionId,
              branchId: lease.branchId,
            },
          } as WorkspaceItem;
        },
      }),
      inference: {
        run: async (request) => {
          if (!request.tools.some((tool) => tool.name === 'record_workspace_memory'))
            return reply();
          selectionCalls++;
          if (selectionCalls === 1)
            return {
              ...reply(),
              stopReason: 'toolUse',
              content: [
                {
                  type: 'toolCall',
                  id: 'select',
                  name: 'record_workspace_memory',
                  arguments: {
                    add: [
                      {
                        content: 'Keep project decision',
                        relevance: 'high',
                        sourceMemoryIds: [sourceId],
                      },
                    ],
                  },
                },
              ],
            };
          return reply();
        },
      },
    });
    expect((await runtime.run(lease, 'alice', input())).state).toBe('completed');
    expect(selectionCalls).toBe(2);
    expect(appended).toHaveLength(1);
    expect(appended[0].sourceMemoryIds).toEqual([sourceId]);
    expect(
      authority.customEntries(
        lease.binding.sessionId,
        'alice',
        lease.branchId,
        'runtime.workspace_memory.failed',
      ),
    ).toHaveLength(0);
  } finally {
    await runtime?.close();
    authority.close();
  }
});

test('host memory search refreshes forgotten content and refuses stale mirrors while node is offline', async () => {
  const database = new GatewayDatabase(':memory:'),
    journal = new ExecutionJournal(':memory:');
  let items: WorkspaceItem[] = [],
    online = true,
    snapshots = 0,
    remoteRecall = false;
  const host = createGatewayRuntimeHost({
    database: database.raw,
    journal,
    owner: () => 'alice',
    online: () => online,
    environment: {
      describe: unavailable,
      start: unavailable,
      status: unavailable,
      cancel: unavailable,
      ack: unavailable,
      pinArtifact: unavailable,
      fetchArtifact: unavailable,
    },
    inference: { run: unavailable },
    models: [{ provider: 'fake', id: 'main', thinking: 'off', contextWindow: 100000 }],
    authorizeModel: () => {},
    authorize: () => {},
    workerExecutable: '/unused',
    ptcWorkerExecutable: '/unused',
    systemPrompt: '',
    tools: [],
    memory: {
      budgets: { user: 4000, note: 4000 },
      chat: () => true,
      remoteRecall: () => remoteRecall,
    },
    workspaceMemory: {
      maxTokens: 1000,
      snapshot: async () => {
        snapshots++;
        return { repositoryKey: 'a'.repeat(16), items };
      },
      append: unavailable,
    },
  });
  try {
    const lease = activate(host.authority),
      doc = descriptor(lease, ['memory_search', 'recall']);
    host.authority.commitTurn(lease, input(), doc, []);
    items = [
      {
        id: 'c'.repeat(12),
        content: 'Private architecture decision',
        relevance: 'high',
        timestamp: '2026-10-09',
        sessionId: lease.binding.sessionId,
        sessionDir: '',
        tokenCount: 8,
        source: {
          authority: 'gateway',
          nodeId: 'n',
          repositoryKey: doc.repositoryKey!,
          sessionId: lease.binding.sessionId,
          branchId: lease.branchId,
        },
        sourceMemoryIds: ['d'.repeat(12)],
      },
    ];
    const search = async (recallId?: string) => {
      const turn = input();
      host.authority.commitTurn(lease, turn, doc, []);
      const value = {
        binding: lease.binding,
        runId: turn.runId,
        turnId: turn.turnId,
        toolCallId: randomUUID(),
        executionId: randomUUID(),
        descriptorRevision: doc.revision,
        policyRevision: doc.policyRevision,
        capability: recallId ? 'recall' : 'memory_search',
        arguments: recallId ? { id: recallId } : { query: 'architecture' },
        budgetMs: 1000,
      };
      const intent: ExecutionIntent = { ...value, argumentDigest: intentDigest(value) };
      host.authority.persistExecution(lease, intent);
      return host.central.start(intent, new AbortController().signal);
    };
    const first = await search();
    expect(first.state).toBe('completed');
    expect(JSON.stringify(first.terminal!.output)).toContain('Private architecture');
    items = [];
    const forgotten = await search();
    expect(forgotten.state).toBe('completed');
    expect(JSON.stringify(forgotten.terminal!.output)).not.toContain('Private architecture');
    expect(snapshots).toBe(2);
    expect((await search('d'.repeat(12))).state).toBe('completed');
    expect(snapshots).toBe(2);
    remoteRecall = true;
    expect((await search('d'.repeat(12))).state).toBe('completed');
    expect(snapshots).toBe(3);
    online = false;
    expect((await search()).state).not.toBe('completed');
  } finally {
    await host.close();
    journal.close();
    database.close();
  }
});

test('goal runtime continues on the fallback model with trusted turns and stops at the durable limit', async () => {
  const authority = new GatewaySessionAuthority(':memory:');
  let runtime: GatewayAgentRuntime | undefined;
  try {
    const lease = activate(authority),
      doc = descriptor(lease),
      goals = new GatewayGoals(authority),
      goal = createGoal(randomUUID(), 'Finish work', 2);
    authority.append(lease, randomUUID(), {
      type: 'custom',
      customType: 'runtime.feature.goal',
      data: JSON.parse(JSON.stringify(goal)),
    });
    goals.arm(lease);
    const models: string[] = [];
    runtime = new GatewayAgentRuntime({
      authority,
      goals,
      environment: {
        describe: async () => doc,
        pinArtifact: unavailable,
        fetchArtifact: unavailable,
      } as any,
      online: () => true,
      models: ['main', 'fallback'].map((id) => ({
        provider: 'fake',
        id,
        thinking: 'off' as const,
        contextWindow: 100000,
      })),
      authorizeModel: () => {},
      workerExecutable: '/unused',
      workerFactory,
      systemPrompt: '',
      tools: [],
      inference: {
        run: async (request) => {
          models.push(request.modelId);
          return {
            ...reply(request.modelId),
            stopReason: request.modelId === 'main' ? 'error' : 'stop',
          };
        },
      },
    });
    expect((await runtime.run(lease, 'alice', input())).state).toBe('completed');
    expect(models).toEqual(['main', 'fallback', 'fallback', 'fallback']);
    expect(goals.state(lease, 'alice')?.rounds).toBe(2);
    expect(goals.state(lease, 'alice')?.phase).toBe('paused');
    expect(runtime.clientSnapshot(lease, 'alice').widgets.goal?.[0]).toBe('GOAL · paused · 2/2');
    expect(
      authority
        .serviceMessages(lease.binding.sessionId, 'alice')
        .filter((value) => value.customType === 'goal.continuation'),
    ).toHaveLength(2);
    expect(
      authority
        .modelContext(lease.binding.sessionId, 'alice', lease.branchId)
        .filter((value) => value.message.role === 'user'),
    ).toHaveLength(1);
  } finally {
    await runtime?.close();
    authority.close();
  }
});

test('fresh approval presentation uses owner/control ingress and the immutable node receipt', async () => {
  const authority = new GatewaySessionAuthority(':memory:'),
    lease = activate(authority),
    bridge = new GatewayEnvironmentInteractions(authority),
    app = Fastify();
  let approvals: ApprovalAuthority | undefined;
  const controller = new AbortController();
  try {
    const value = {
      binding: lease.binding,
      runId: randomUUID(),
      turnId: randomUUID(),
      toolCallId: randomUUID(),
      executionId: randomUUID(),
      descriptorRevision: 'a'.repeat(64),
      policyRevision: 'b'.repeat(64),
      capability: 'bash',
      arguments: { command: 'echo test' },
      budgetMs: 1000,
    };
    const intent: ExecutionIntent = { ...value, argumentDigest: intentDigest(value) };
    authority.persistExecution(lease, intent);
    approvals = new ApprovalAuthority(':memory:', (approval) =>
      bridge.publish(lease, intent.executionId, approval, async (record, confirmed) => {
        if (
          !approvals!.humanAnswer(
            record.binding,
            record.interactionId,
            record.finalArgumentDigest,
            confirmed,
          )
        )
          throw Error('Node receipt stale');
      }),
    );
    const waiting = approvals.request(
      intent,
      {
        finalArgumentDigest: intent.argumentDigest,
        action: 'host_exec',
        title: 'Confirm host execution',
        message: 'Review command',
      },
      controller.signal,
    );
    const question = bridge.list(lease, 'alice')[0]!;
    const runtime = new GatewayAgentRuntime({
      authority,
      environment: {} as any,
      inference: {} as any,
      online: () => true,
      models: [{ provider: 'fake', id: 'main', thinking: 'off', contextWindow: 100000 }],
      authorizeModel: () => {},
      workerExecutable: '/unused',
      systemPrompt: '',
      tools: [],
    });
    registerGatewayRuntimeRoutes(app, {
      runtime,
      authority,
      clientProjection: true,
      environmentInteractions: bridge,
      authenticate: (request) => {
        request.identity = { user: 'alice' } as any;
      },
      writer: () => lease,
      control: (_id, _owner, client, generation) => {
        if (client !== 'held' || generation !== 1) throw Error('Control lease required');
      },
    });
    const url = `/api/sessions/${lease.binding.sessionId}/interactions/${question.id}/answer`;
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/sessions/${lease.binding.sessionId}/snapshot`,
        })
      ).json().interactions[0].kind,
    ).toBe('confirm');
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { clientId: 'forged', generation: 1, answer: { confirmed: true } },
        })
      ).statusCode,
    ).not.toBe(200);
    expect(bridge.list(lease, 'alice')).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: {
            clientId: 'held',
            generation: 1,
            answer: { confirmed: true, finalArgumentDigest: 'f'.repeat(64) },
          },
        })
      ).statusCode,
    ).not.toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { clientId: 'held', generation: 1, answer: { confirmed: true } },
        })
      ).statusCode,
    ).toBe(200);
    expect(await waiting).toBe(true);
    expect(bridge.list(lease, 'alice')).toHaveLength(0);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { clientId: 'held', generation: 1, answer: { confirmed: true } },
        })
      ).statusCode,
    ).not.toBe(200);
    await runtime.close();
  } finally {
    controller.abort();
    await app.close();
    await bridge.close();
    approvals?.close();
    authority.close();
  }
});

test('node child policy intersects role and requested tools, rejecting symlink escapes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-m4-child-')),
    authority = new GatewaySessionAuthority(':memory:');
  try {
    const workspace = path.join(root, 'workspace'),
      configDir = path.join(root, 'config'),
      roles = path.join(configDir, 'roles');
    mkdirSync(path.join(workspace, 'subdir'), { recursive: true });
    mkdirSync(roles, { recursive: true });
    writeFileSync(
      path.join(roles, 'reader.md'),
      '---\ntools: [read, grep, write]\n---\nRead the project.\n',
    );
    symlinkSync(root, path.join(workspace, 'escape'), 'dir');
    const config = loadAgentConfig(workspace, { providers: {} }, { PIRC_CONFIG_DIR: configDir });
    const parent = descriptor(activate(authority), ['read', 'grep']);
    const resolved = resolveChildEnvironment({
      config,
      parent,
      cwd: 'subdir',
      role: 'reader',
      tools: ['read', 'write', 'bash'],
    });
    expect(resolved.cwd).toBe(path.join(workspace, 'subdir'));
    expect(resolved.allowedTools).toEqual(['read']);
    expect(() =>
      resolveChildEnvironment({ config, parent, cwd: 'escape', role: 'reader' }),
    ).toThrow();
    expect(() => resolveChildEnvironment({ config, parent, cwd: '.', role: 'unknown' })).toThrow(
      'Unknown',
    );
  } finally {
    authority.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('schedule and delegation deliveries respect shared runtime capacity, ownership and original IDs', async () => {
  const authority = new GatewaySessionAuthority(':memory:');
  let runtime: GatewayAgentRuntime | undefined;
  let dispatch: ReturnType<typeof gatewaySchedulerDispatch> | undefined, release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  try {
    const leases = Array.from({ length: 9 }, () => activate(authority)),
      byId = new Map(leases.map((lease) => [lease.binding.sessionId, lease]));
    const sessions = leases.map(
      (lease) =>
        ({
          id: randomUUID(),
          piSessionId: lease.binding.sessionId,
          ownerUser: 'alice',
          nodeId: 'n',
          workspaceId: 'n:w',
        }) as SessionRow,
    );
    let models = 0,
      configured = 0;
    runtime = new GatewayAgentRuntime({
      authority,
      environment: {
        describe: async (binding: any) => descriptor(byId.get(binding.sessionId)!),
        pinArtifact: unavailable,
        fetchArtifact: unavailable,
      } as any,
      online: () => true,
      models: [{ provider: 'fake', id: 'main', thinking: 'off', contextWindow: 100000 }],
      authorizeModel: () => {},
      workerExecutable: '/unused',
      workerFactory,
      systemPrompt: '',
      tools: [],
      inference: {
        run: async () => {
          models++;
          await held;
          return reply();
        },
      },
    });
    dispatch = gatewaySchedulerDispatch({
      authority,
      runtime,
      create: unavailable,
      writer: (session) => byId.get(session.piSessionId!)!,
      configure: async (lease, owner) => {
        configured++;
        runtime!.selectModel(lease, owner, 'fake', 'main');
      },
    });
    const messages = sessions.map((_session, i) => ({
      customType: i % 2 ? 'delegation-progress' : 'scheduled-run',
      content: `Service task ${i}`,
      details: { runId: `task-${i}` },
      model: { provider: 'fake', id: 'main' },
    }));
    for (let i = 0; i < sessions.length; i++)
      await dispatch.deliver(sessions[i]!, 'alice', messages[i]!);
    await waitFor(() => models === 8, true);
    expect(configured).toBe(8);
    expect(
      await dispatch.progress(sessions[8]!, 'alice', 0, (msg) => msg.details?.runId === 'task-8'),
    ).toEqual({ state: 'queued' });
    await expect(dispatch.deliver(sessions[8]!, 'bob', messages[8]!)).rejects.toThrow('owner');
    release();
    await waitFor(() => models === 9, true);
    await waitFor(
      () =>
        (
          authority.inner.operations.db
            .query("SELECT COUNT(*) AS n FROM runtime_service_deliveries WHERE state='completed'")
            .get() as { n: number }
        ).n === 9,
      true,
    );
    expect(configured).toBe(9);
    for (let i = 0; i < sessions.length; i++) {
      await dispatch.deliver(sessions[i]!, 'alice', messages[i]!);
      const result = await dispatch.progress(
        sessions[i]!,
        'alice',
        0,
        (msg) => msg.details?.runId === `task-${i}`,
      );
      expect(result).toMatchObject({ state: 'over', status: 'succeeded', answer: 'done' });
      expect(
        authority
          .modelContext(leases[i]!.binding.sessionId, 'alice', leases[i]!.branchId)
          .some((entry) => entry.message.role === 'user'),
      ).toBe(false);
    }
    expect(models).toBe(9);
  } finally {
    release();
    await dispatch?.close();
    await runtime?.close();
    authority.close();
  }
});
