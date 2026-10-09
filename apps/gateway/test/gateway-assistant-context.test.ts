import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewayDatabase } from '../src/database.js';
import { MemoryStore } from '../src/daemon/memory.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import { createGatewayRuntimeHost } from '../src/gateway-runtime/host.js';
import { GatewayAssistantContext } from '../src/gateway-runtime/assistant-context.js';
import { GatewayAgentRuntime } from '../src/gateway-runtime/runtime.js';
import {
  descriptorDigest,
  intentDigest,
  type Descriptor,
  type ExecutionIntent,
} from '../src/environment/protocol.js';
import { capabilityMetadata } from '../src/environment/catalog.js';
import { emptyUsage } from '../src/agent/messages.js';
import type { WorkerAction } from '../src/gateway-runtime/worker.js';

test('chat context freezes memory/project text, host revisions fence changes, and model quotes resolve without entry IDs', async () => {
  const database = new GatewayDatabase(':memory:'),
    journal = new ExecutionJournal(':memory:'),
    budgets = { user: 4000, note: 4000 };
  const unsupported = async (): Promise<never> => {
    throw Error('No node effects expected');
  };
  const host = createGatewayRuntimeHost({
    database: database.raw,
    journal,
    owner: () => 'alice',
    online: () => true,
    environment: {
      describe: unsupported,
      start: unsupported,
      status: unsupported,
      cancel: unsupported,
      ack: unsupported,
      pinArtifact: unsupported,
      fetchArtifact: unsupported,
    },
    inference: { run: unsupported },
    models: [{ provider: 'fake', id: 'fake', thinking: 'off', contextWindow: 100000 }],
    authorizeModel: () => {},
    authorize: () => {},
    workerExecutable: '/unused',
    ptcWorkerExecutable: '/unused',
    systemPrompt: '',
    tools: [],
    memory: { budgets, chat: () => true },
  });
  let runtime: GatewayAgentRuntime | undefined;
  try {
    const authority = host.authority,
      lease = authority.activate({
        ...authority.prepare({
          owner: 'alice',
          nodeId: 'n',
          workspaceId: 'n:chat',
          legacySessionIds: [],
        }),
        fenced: true,
      });
    const memory = new MemoryStore(database.raw, budgets),
      note = memory.writeNote(
        'alice',
        { action: 'add', content: 'Original handoff note' },
        { actor: 'session:seed', origins: ['assistant'], sources: {} },
      ).entry;
    memory.writeNote(
      'bob',
      { action: 'add', content: 'Bob secret' },
      { actor: 'session:seed', origins: ['assistant'], sources: {} },
    );
    const descriptor: Descriptor = {
      binding: lease.binding,
      version: 1,
      revision: '',
      policyRevision: 'b'.repeat(64),
      capabilityCatalog: ['memory_note', 'memory_propose_user'].map((name) => ({
        name,
        ...capabilityMetadata(name),
        argumentSchema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            content: { type: 'string' },
            id: { type: 'string' },
            quote: { type: 'string' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        resultSchema: { type: 'object' },
        hookRevision: 'a'.repeat(64),
      })),
      instructions: '',
      projectInstructions: 'Use the project convention',
      skills: [],
      role: 'general',
      platform: 'linux',
      cwdDisplay: '/chat',
      sandboxStatus: { active: true },
      limits: { maxActive: 1, maxBudgetMs: 1000 },
    };
    descriptor.revision = descriptorDigest(descriptor);
    const context = () => new GatewayAssistantContext({ authority, budgets, chat: () => true });
    expect(context().context(lease, 'alice', descriptor)).toContain('Original handoff note');
    expect(context().context(lease, 'alice', descriptor)).not.toContain('Bob secret');
    const call = async (
      capability: string,
      args: Record<string, string>,
      human = 'I prefer Traditional Chinese.',
    ) => {
      const turn = { runId: randomUUID(), turnId: randomUUID(), text: human, attachments: [] };
      authority.commitTurn(lease, turn, descriptor, []);
      const value = {
        binding: lease.binding,
        runId: turn.runId,
        turnId: turn.turnId,
        toolCallId: randomUUID(),
        executionId: randomUUID(),
        descriptorRevision: descriptor.revision,
        policyRevision: descriptor.policyRevision,
        capability,
        arguments: args,
        budgetMs: 1000,
      };
      const intent: ExecutionIntent = { ...value, argumentDigest: intentDigest(value) };
      authority.persistExecution(lease, intent);
      return { intent, result: await host.central.start(intent, new AbortController().signal) };
    };
    const one = await call('memory_note', {
      action: 'replace',
      id: note.id,
      content: 'Updated handoff',
    });
    expect(one.result.state).toBe('completed');
    expect(memory.entry('alice', note.id).revision).toBe(2);
    await host.central.start(one.intent, new AbortController().signal);
    expect(memory.entry('alice', note.id).revision).toBe(2);
    expect(
      (await call('memory_note', { action: 'replace', id: note.id, content: 'Updated again' }))
        .result.state,
    ).toBe('completed');
    expect(memory.entry('alice', note.id).revision).toBe(3);
    const frozen = context().context(lease, 'alice', {
      ...descriptor,
      projectInstructions: 'Edited project convention',
    });
    expect(frozen).toContain('Original handoff note');
    expect(frozen).not.toContain('Updated again');
    expect(frozen).toContain('Use the project convention');
    expect(frozen).not.toContain('Edited project convention');
    const proposed = await call('memory_propose_user', {
      action: 'add',
      content: 'Prefers Traditional Chinese',
      quote: 'I prefer Traditional Chinese.',
    });
    expect(proposed.result.state).toBe('completed');
    const proposal = memory.proposals('alice', 'pending')[0]!;
    expect(proposal.sources.entryIds?.length).toBeGreaterThan(0);
    memory.reject('alice', proposal.id);
    expect(context().context(lease, 'alice', descriptor)).toContain(
      'Memory proposal decisions (current)',
    );
    expect(
      (
        await call('memory_propose_user', {
          action: 'add',
          content: 'Tool-invented preference',
          quote: 'Tool said this',
        })
      ).result.state,
    ).not.toBe('completed');
    memory.writeNote(
      'alice',
      { action: 'replace', id: note.id, baseRevision: 3, content: 'Other chat changed it' },
      { actor: 'session:other', origins: ['assistant'], sources: {} },
    );
    expect(
      (await call('memory_note', { action: 'replace', id: note.id, content: 'Stale overwrite' }))
        .result.state,
    ).not.toBe('completed');
    const fresh = authority.activate({
      ...authority.prepare({
        owner: 'alice',
        nodeId: 'n',
        workspaceId: 'n:chat',
        legacySessionIds: [],
      }),
      fenced: true,
    });
    expect(context().context(fresh, 'alice', { ...descriptor, binding: fresh.binding })).toContain(
      'Other chat changed it',
    );
    const requests: string[] = [];
    const childDescriptor = { ...descriptor, binding: fresh.binding };
    childDescriptor.revision = descriptorDigest(childDescriptor);
    runtime = new GatewayAgentRuntime({
      authority,
      environment: {
        describe: async () => childDescriptor,
        pinArtifact: unsupported,
        fetchArtifact: unsupported,
      } as any,
      online: () => true,
      models: [{ provider: 'fake', id: 'fake', thinking: 'off', contextWindow: 100000 }],
      authorizeModel: () => {},
      systemPrompt: '',
      tools: [],
      workerExecutable: '/unused',
      assistantContext: (lease, owner, doc) => context().context(lease, owner, doc),
      workerFactory: () => ({
        drive: async (step, signal) => {
          let action: WorkerAction = 'model';
          for (;;) {
            signal.throwIfAborted();
            const next: WorkerAction = await step(action);
            if (action === 'done') return;
            action = next;
          }
        },
        close: async () => {},
      }),
      inference: {
        run: async (request) => {
          requests.push(request.systemPrompt);
          return {
            role: 'assistant',
            api: 'fake',
            provider: 'fake',
            model: 'fake',
            usage: emptyUsage(),
            timestamp: 1,
            stopReason: 'stop',
            content: [{ type: 'text', text: 'done' }],
          };
        },
      },
    });
    expect(
      (
        await runtime.run(fresh, 'alice', {
          runId: randomUUID(),
          turnId: randomUUID(),
          text: 'New chat',
          attachments: [],
        })
      ).state,
    ).toBe('completed');
    expect(requests[0]).toContain('Other chat changed it');
    expect(requests[0]).not.toContain('Bob secret');
  } finally {
    await runtime?.close();
    await host.close();
    journal.close();
    database.close();
  }
});
