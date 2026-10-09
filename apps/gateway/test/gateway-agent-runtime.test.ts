import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewayAgentRuntime } from '../src/gateway-runtime/runtime.js';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayInference } from '../src/backends/inference.js';
import { LocalEnvironment, dispatchEnvironment } from '../src/environment/service.js';
import { RemoteEnvironment } from '../src/environment/remote.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import {
  descriptorDigest,
  intentDigest,
  encodeMessage,
  decodeMessage,
  type Descriptor,
  type ExecutionIntent,
} from '../src/environment/protocol.js';
import { emptyUsage, type AssistantMessage } from '../src/agent/messages.js';
import type { StreamRequest } from '../src/agent/providers/types.js';
import type { RuntimeWorker } from '../src/gateway-runtime/worker-process.js';
import type { WorkerAction } from '../src/gateway-runtime/worker.js';
import { EnvironmentArtifacts } from '../src/environment/artifacts.js';
import { ArtifactTransfer } from '../src/environment/artifact-transfer.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const answer = (text: string, calls = false): AssistantMessage => ({
  role: 'assistant',
  api: 'openai-chat',
  provider: 'fake',
  model: 'fake',
  content: calls
    ? [
        {
          type: 'toolCall',
          id: 'provider_call_non_uuid',
          name: 'read',
          arguments: { path: 'hello.txt' },
          thoughtSignature: 'opaque-tool-signature',
        },
      ]
    : [{ type: 'text', text, textSignature: 'opaque-text-signature' }],
  usage: emptyUsage(),
  stopReason: calls ? 'toolUse' : 'stop',
  timestamp: Date.now(),
  responseId: randomUUID(),
});
const fakeWorker = (): RuntimeWorker => ({
  async drive(step, signal) {
    let action: WorkerAction = 'model';
    for (;;) {
      signal.throwIfAborted();
      const next = await step(action);
      if (action === 'done') return;
      action = next;
    }
  },
  async close() {},
});
async function fixture(
  options: {
    stream?: (request: StreamRequest) => Promise<AssistantMessage>;
    loseAck?: boolean;
    unknown?: boolean;
    auxiliary?: readonly ('title' | 'memory')[];
    realWorker?: string;
    fallback?: boolean;
    contextWindow?: number;
    toolArtifact?: boolean;
  } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-runtime-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'authority.sqlite');
  let authority = new GatewaySessionAuthority(file);
  const transfer = authority.prepare({
    owner: 'alice',
    nodeId: 'node',
    workspaceId: 'node:workspace',
    legacySessionIds: ['0123456789abcdef'],
  });
  const lease = authority.activate({ ...transfer, fenced: true });
  const storage = new EnvironmentArtifacts(path.join(root, 'artifacts'));
  cleanups.push(() => storage.close());
  const toolArtifact = options.toolArtifact
    ? await storage.put(lease.binding, Buffer.from('private node artifact'), 'text/html')
    : undefined;
  const nodeJournal = new ExecutionJournal(path.join(root, 'node.sqlite'));
  const gatewayJournal = new ExecutionJournal(path.join(root, 'gateway.sqlite'));
  cleanups.push(() => {
    authority.close();
    nodeJournal.close();
    gatewayJournal.close();
  });
  let online = true;
  let effects = 0;
  let queries = 0;
  let loseAck = !!options.loseAck;
  const descriptor: Descriptor = {
    binding: lease.binding,
    version: 1,
    revision: '',
    policyRevision: 'a'.repeat(64),
    capabilityCatalog: [
      {
        name: 'read',
        argumentSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        resultSchema: {},
        placement: 'node',
        effects: 'read',
        concurrency: 'read',
        approval: 'policy',
        hookRevision: 'b'.repeat(64),
      },
    ],
    instructions: 'Node project instructions',
    skills: [],
    role: 'coding',
    platform: 'linux',
    cwdDisplay: '/node-only/workspace',
    sandboxStatus: { active: true },
    limits: { maxActive: 1, maxBudgetMs: 1000 },
  };
  descriptor.revision = descriptorDigest(descriptor);
  const authorize = (binding: typeof lease.binding) => {
    if (JSON.stringify(binding) !== JSON.stringify(lease.binding))
      throw new Error('Foreign binding');
  };
  const local = new LocalEnvironment({ nodeId: 'node', journal: nodeJournal, authorize });
  local.provision(descriptor, {
    healthy: true,
    async execute() {
      effects++;
      return {
        state: options.unknown ? 'unknown' : 'completed',
        effect: options.unknown ? 'unknown' : 'completed',
        truncated: false,
        artifacts: toolArtifact ? [toolArtifact] : [],
        output: { content: [{ type: 'text', text: 'hello from node' }], isError: false },
      };
    },
  });
  gatewayJournal.provision(lease.binding, descriptor.revision, descriptor.policyRevision);
  const wire: string[] = [];
  let remote!: RemoteEnvironment;
  remote = new RemoteEnvironment({
    nodeId: 'node',
    journal: gatewayJournal,
    authorize,
    timeoutMs: 1000,
    send: async (frame) => {
      wire.push(encodeMessage(frame));
      if (frame.type === 'execution.status') queries++;
      const reply = await dispatchEnvironment(
        local,
        decodeMessage(encodeMessage(frame)),
        new ArtifactTransfer({ authorize, storage, online: () => online }),
      );
      if (frame.type === 'execution.ack' && loseAck) {
        loseAck = false;
        remote.disconnect();
        online = false;
        return;
      }
      await remote.receive(decodeMessage(encodeMessage(reply)));
    },
  });
  const requests: StreamRequest[] = [];
  const inference = new GatewayInference(
    {
      resolve: async () => ({
        provider: {
          api: 'openai-chat',
          baseUrl: 'https://fake.invalid',
          headers: {},
          compat: {},
          models: [],
        },
        model: {
          id: 'fake',
          name: 'Fake',
          contextWindow: 100_000,
          maxTokens: 4096,
          reasoning: true,
          input: ['text'],
          compat: {},
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        apiKey: 'gateway-secret-never-sent-to-node',
      }),
    },
    undefined,
    () => async (request, delta) => {
      requests.push(request);
      const message = await (options.stream?.(request) ??
        Promise.resolve(answer(requests.length === 1 ? '' : 'done', requests.length === 1)));
      delta({ type: 'text_delta', contentIndex: 0, delta: 'direct gateway delta' }, message);
      return message;
    },
  );
  const events: unknown[] = [];
  const create = () =>
    new GatewayAgentRuntime({
      authority,
      environment: remote,
      inference,
      online: () => online,
      models: [
        {
          provider: 'fake',
          id: 'fake',
          thinking: 'off',
          contextWindow: options.contextWindow ?? 100_000,
        },
        ...(options.fallback
          ? [{ provider: 'backup', id: 'backup', thinking: 'off' as const, contextWindow: 100_000 }]
          : []),
      ],
      authorizeModel() {},
      systemPrompt: 'Gateway system prompt',
      tools: [{ name: 'read', description: 'Read a node file', parameters: {} }],
      workerExecutable: options.realWorker ?? '/unused-in-synthetic-fixture',
      ...(options.realWorker ? {} : { workerFactory: fakeWorker }),
      ...(options.auxiliary ? { auxiliary: options.auxiliary } : {}),
      event: (event) => events.push(event),
    });
  let runtime = create();
  cleanups.push(async () => {
    await runtime.close();
    remote.disconnect();
    await local.close();
  });
  return {
    lease,
    descriptor,
    nodeJournal,
    requests,
    wire,
    events,
    toolArtifact,
    get runtime() {
      return runtime;
    },
    get authority() {
      return authority;
    },
    get effects() {
      return effects;
    },
    get queries() {
      return queries;
    },
    input: (text = 'Read hello.txt') => ({
      runId: randomUUID(),
      turnId: randomUUID(),
      text,
      attachments: [],
    }),
    online(value: boolean) {
      online = value;
      value ? remote.reconnect() : remote.disconnect();
    },
    async restart() {
      await runtime.close();
      authority.close();
      authority = new GatewaySessionAuthority(file);
      runtime = create();
    },
  };
}

test('fresh gateway coding loop streams directly, keeps context off node wire, and preserves provider tool IDs', async () => {
  const f = await fixture();
  const input = f.input();
  expect((await f.runtime.run(f.lease, 'alice', input)).state).toBe('completed');
  expect(f.effects).toBe(1);
  expect(f.requests).toHaveLength(2);
  expect(f.events.filter((event) => (event as any).type === 'message_update')).toHaveLength(2);
  const { reducePiEvent, emptyReducedState } = await import('../src/node/reducer.js');
  const reduced = emptyReducedState();
  for (const event of f.events) reducePiEvent(reduced, event as Record<string, unknown>);
  expect(reduced.partialMessage).toBeNull();
  expect(reduced.history).toHaveLength(2);
  expect(f.wire.some((frame) => /model_request|systemPrompt|gateway-secret/.test(frame))).toBe(
    false,
  );
  const view = f.runtime.project(f.lease.binding.sessionId, 'alice');
  const result = view.history.find((message) => message.role === 'toolResult');
  expect(result?.role === 'toolResult' && result.toolCallId).toBe('provider_call_non_uuid');
  expect(
    f.requests[1]!.messages.some(
      (message) => message.role === 'toolResult' && message.toolCallId === 'provider_call_non_uuid',
    ),
  ).toBe(true);
  expect(f.authority.executions(f.lease.binding.sessionId, 'alice')[0]!.acknowledged).toBe(true);
  expect(
    f.authority
      .events(f.lease.binding.sessionId, 'alice')
      .some((event) => (event.event as any).type === 'run.finished'),
  ).toBe(true);
  await f.restart();
  expect((await f.runtime.run(f.lease, 'alice', input)).state).toBe('completed');
  expect(f.requests).toHaveLength(2);
  expect(f.effects).toBe(1);
  await expect(f.runtime.run(f.lease, 'alice', { ...input, text: 'changed' })).rejects.toThrow(
    'conflict',
  );
  expect(f.runtime.project(f.lease.binding.sessionId, 'alice').snapshot).toBeDefined();
  expect(() => f.runtime.project(f.lease.binding.sessionId, 'mallory')).toThrow('owner');
  expect(() => f.runtime.project('0123456789abcdef', 'alice')).toThrow('Legacy');
});

test('chat flow, title and memory call paths stay gateway-local and retain auxiliary metadata', async () => {
  const f = await fixture({
    stream: async (request) => answer(request.maxTokens === 256 ? 'A short title' : 'Chat answer'),
    auxiliary: ['title', 'memory'],
  });
  expect((await f.runtime.run(f.lease, 'alice', f.input('Hello'))).state).toBe('completed');
  expect(f.effects).toBe(0);
  expect(f.requests).toHaveLength(3);
  const view = f.authority.read(f.lease.binding.sessionId, 'alice');
  expect(
    view.entries.some((entry) => entry.type === 'session_info' && entry.name === 'A short title'),
  ).toBe(true);
  expect(
    view.entries.filter(
      (entry) => entry.type === 'custom' && entry.customType.startsWith('runtime.model.'),
    ),
  ).toHaveLength(2);
  expect(view.context.filter((entry) => entry.message.role === 'assistant')).toHaveLength(1);
});

test('lost result ACK and both-end reconnect reconcile by original ID without repeating effects or model calls', async () => {
  const f = await fixture({ loseAck: true });
  const input = f.input();
  await expect(f.runtime.run(f.lease, 'alice', input)).rejects.toThrow('offline');
  expect(f.authority.runState(f.lease.binding.sessionId, 'alice', input.runId)?.state).toBe(
    'interrupted',
  );
  expect(f.effects).toBe(1);
  expect(
    f.authority
      .read(f.lease.binding.sessionId, 'alice')
      .history.filter((message) => message.role === 'toolResult'),
  ).toHaveLength(1);
  await f.restart();
  f.online(true);
  await f.runtime.reconcile(f.lease.binding.sessionId, 'alice');
  expect(f.effects).toBe(1);
  expect(f.requests).toHaveLength(1);
  expect(f.queries).toBeGreaterThan(0);
  expect(f.authority.executions(f.lease.binding.sessionId, 'alice')[0]!.acknowledged).toBe(true);
});

test('unknown effects stop the run without another model request or automatic tool replay', async () => {
  const f = await fixture({ unknown: true });
  const input = f.input();
  expect((await f.runtime.run(f.lease, 'alice', input)).state).toBe('unknown');
  await f.restart();
  await f.runtime.reconcile(f.lease.binding.sessionId, 'alice');
  expect((await f.runtime.run(f.lease, 'alice', input)).state).toBe('unknown');
  expect(f.effects).toBe(1);
  expect(f.requests).toHaveLength(1);
});

test('offline admission, durable interrupted provider calls, and owner separation survive restart', async () => {
  const f = await fixture({ stream: async () => answer('chat') });
  const input = f.input();
  f.online(false);
  await expect(f.runtime.run(f.lease, 'alice', input)).rejects.toThrow('offline');
  expect(f.requests).toHaveLength(0);
  await expect(f.runtime.run(f.lease, 'mallory', input)).rejects.toThrow('owner');
  f.online(true);
  const { GatewayTurnLifecycle } = await import('../src/gateway-runtime/turn-lifecycle.js');
  const turn = await new GatewayTurnLifecycle({
    authority: f.authority,
    environment: {
      describe: async () => f.descriptor,
      pinArtifact: async () => {},
      fetchArtifact: async () => ({ offset: 0, data: '' }),
    },
    online: () => true,
  }).begin(f.lease, input);
  f.authority.startRun(f.lease, turn);
  f.authority.beginModel(f.lease, input.runId, { request: 'never replay' }, {});
  await f.restart();
  expect((await f.runtime.run(f.lease, 'alice', input)).state).toBe('interrupted');
  expect(f.requests).toHaveLength(0);
});

test('steering is durably admitted at a tool/model boundary and duplicate steering is consumed once', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const streaming = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const f = await fixture({
    stream: async () => {
      if (++calls === 1) {
        started();
        await blocked;
      }
      return answer('reply');
    },
  });
  const input = f.input();
  const running = f.runtime.run(f.lease, 'alice', input);
  await streaming;
  const steering = { ...f.input('Use the correction'), runId: input.runId };
  f.runtime.steer(f.lease, 'alice', steering);
  f.runtime.steer(f.lease, 'alice', steering);
  release();
  expect((await running).state).toBe('completed');
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]!.messages.filter((message) => message.role === 'user')).toHaveLength(2);
  expect(
    f.authority
      .read(f.lease.binding.sessionId, 'alice')
      .history.filter((message) => message.role === 'user'),
  ).toHaveLength(2);
});

test('fallback stays in the gateway provider service and persists the selected model', async () => {
  const f = await fixture({
    fallback: true,
    stream: async (request) =>
      request.providerName === 'fake'
        ? { ...answer(''), stopReason: 'error', errorMessage: 'HTTP 503' }
        : answer('fallback answer'),
  });
  expect((await f.runtime.run(f.lease, 'alice', f.input())).state).toBe('completed');
  expect(f.requests.map((request) => request.providerName)).toEqual(['fake', 'backup']);
  expect(
    f.authority
      .read(f.lease.binding.sessionId, 'alice')
      .entries.some((entry) => entry.type === 'model_change' && entry.provider === 'backup'),
  ).toBe(true);
  expect(f.effects).toBe(0);
  await f.restart();
  await f.runtime.run(f.lease, 'alice', f.input('continue on the fallback model'));
  expect(f.requests.map((request) => request.providerName)).toEqual(['fake', 'backup', 'backup']);
});

test('owner-checked model and thinking choices survive restart and follow branch ancestry', async () => {
  const f = await fixture({ fallback: true, stream: async () => answer('done') });
  expect(() => f.runtime.selectModel(f.lease, 'bob', 'backup', 'backup')).toThrow('owner');
  expect(() => f.runtime.selectModel(f.lease, 'alice', 'missing', 'model')).toThrow('unavailable');
  f.runtime.selectModel(f.lease, 'alice', 'backup', 'backup');
  f.runtime.selectThinking(f.lease, 'alice', 'high');
  const boundary = f.authority.read(f.lease.binding.sessionId, 'alice').entries.at(-1)!;
  await f.restart();
  await f.runtime.run(f.lease, 'alice', f.input('selected model'));
  expect(f.requests.at(-1)!.providerName).toBe('backup');
  expect(f.requests.at(-1)!.thinking).toBe('high');
  const fork = f.authority.fork(f.lease, boundary.id);
  await f.runtime.run(fork, 'alice', f.input('new branch'));
  expect(f.runtime.project(fork.binding.sessionId, 'alice').settings).toEqual({
    model: { provider: 'backup', id: 'backup' },
    thinking: 'high',
    title: undefined,
  });
  expect(f.requests.at(-1)!.thinking).toBe('high');
});

test('recovery pages bound pending executions and exclude acknowledged history', async () => {
  const f = await fixture();
  const input = f.input();
  await f.runtime.run(f.lease, 'alice', input);
  for (let index = 0; index < 41; index++) {
    const value = {
      binding: f.lease.binding,
      executionId: randomUUID(),
      runId: input.runId,
      turnId: input.turnId,
      toolCallId: randomUUID(),
      descriptorRevision: f.descriptor.revision,
      policyRevision: f.descriptor.policyRevision,
      capability: 'read',
      arguments: { path: `pending-${index}` },
      budgetMs: 1000,
    };
    f.authority.persistExecution(f.lease, { ...value, argumentDigest: intentDigest(value) });
  }
  const first = f.authority.recoveryPage(f.lease.binding.sessionId, 'alice');
  expect(first.executions).toHaveLength(32);
  expect(first.nextCursor).not.toBeNull();
  const second = f.authority.recoveryPage(f.lease.binding.sessionId, 'alice', first.nextCursor!);
  expect(second.executions).toHaveLength(9);
  expect(second.nextCursor).toBeNull();
  expect(f.queries).toBeGreaterThan(0);
  expect(f.effects).toBe(1);
  expect(() => f.authority.recoveryPage(f.lease.binding.sessionId, 'bob')).toThrow('owner');
});

test('automatic compaction retains the newest complete user turn, with summary calls outside normal context', async () => {
  const f = await fixture({
    contextWindow: 512,
    stream: async (request) =>
      answer(request.systemPrompt.includes('handoff summary') ? 'Earlier facts' : 'normal answer'),
  });
  await f.runtime.run(f.lease, 'alice', f.input('previous context '.repeat(160)));
  await f.runtime.run(f.lease, 'alice', f.input('continue'));
  expect(f.requests).toHaveLength(3);
  const context = f.authority.modelContext(f.lease.binding.sessionId, 'alice');
  expect(context[0]!.message.role).toBe('compactionSummary');
  expect(context.filter((entry) => entry.message.role === 'user')).toHaveLength(1);
  expect(context.filter((entry) => entry.message.role === 'assistant')).toHaveLength(1);
  const view = f.authority.read(f.lease.binding.sessionId, 'alice');
  expect(view.history.filter((message) => message.role === 'assistant')).toHaveLength(2);
  expect(
    view.entries.some(
      (entry) => entry.type === 'custom' && entry.customType === 'runtime.model.compaction',
    ),
  ).toBe(true);
  await f.restart();
  expect(f.authority.modelContext(f.lease.binding.sessionId, 'alice')).toEqual(view.context);
});

test('cancel releases a stalled model promptly and rejects same-session concurrency', async () => {
  let started!: () => void;
  const streaming = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture({
    stream: async () => {
      started();
      return new Promise(() => {});
    },
  });
  const input = f.input();
  const running = f.runtime.run(f.lease, 'alice', input);
  void running.catch(() => {});
  await streaming;
  await expect(f.runtime.run(f.lease, 'alice', f.input())).rejects.toThrow('busy');
  await f.runtime.cancel(f.lease.binding.sessionId, 'alice');
  await expect(running).rejects.toThrow();
  expect(f.authority.runState(f.lease.binding.sessionId, 'alice', input.runId)?.state).toBe(
    'interrupted',
  );
  expect(f.effects).toBe(0);
});

test('eight global runs bound multiple sessions; shutdown releases all admission slots', async () => {
  const fixtures = [];
  const running: Promise<unknown>[] = [];
  for (let index = 0; index < 8; index++) {
    let started!: () => void;
    const streaming = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = await fixture({
      stream: async () => {
        started();
        return new Promise(() => {});
      },
    });
    fixtures.push(f);
    const operation = f.runtime.run(f.lease, 'alice', f.input());
    void operation.catch(() => {});
    running.push(operation);
    await streaming;
  }
  const ninth = await fixture({ stream: async () => answer('released') });
  await expect(ninth.runtime.run(ninth.lease, 'alice', ninth.input())).rejects.toThrow('busy');
  await Promise.all(fixtures.map((f) => f.runtime.close()));
  expect((await Promise.allSettled(running)).every((result) => result.status === 'rejected')).toBe(
    true,
  );
  expect((await ninth.runtime.run(ninth.lease, 'alice', ninth.input())).state).toBe('completed');
});

test('pending dispatch intent is committed with the assistant; restart never dispatches it', async () => {
  const f = await fixture();
  const input = f.input();
  const { GatewayTurnLifecycle } = await import('../src/gateway-runtime/turn-lifecycle.js');
  const turn = await new GatewayTurnLifecycle({
    authority: f.authority,
    environment: {
      describe: async () => f.descriptor,
      pinArtifact: async () => {},
      fetchArtifact: async () => ({ offset: 0, data: '' }),
    },
    online: () => true,
  }).begin(f.lease, input);
  f.authority.startRun(f.lease, turn);
  const callId = f.authority.beginModel(f.lease, input.runId, {}, {});
  const value = {
    binding: f.lease.binding,
    executionId: randomUUID(),
    runId: input.runId,
    turnId: input.turnId,
    toolCallId: randomUUID(),
    descriptorRevision: f.descriptor.revision,
    policyRevision: f.descriptor.policyRevision,
    capability: 'read',
    arguments: { path: 'hello.txt' },
    budgetMs: 1000,
  };
  const intent: ExecutionIntent = {
    ...value,
    argumentDigest: (await import('../src/environment/protocol.js')).intentDigest(value),
  };
  f.authority.commitModel(
    f.lease,
    callId,
    (await import('../src/gateway-runtime/contracts.js')).entrySchema.parse({
      type: 'message',
      message: answer('', true),
    }),
    [{ intent, modelToolCallId: 'provider_call_non_uuid' }],
  );
  await f.restart();
  await expect(f.runtime.reconcile(f.lease.binding.sessionId, 'alice')).rejects.toThrow();
  expect(f.effects).toBe(0);
  expect(f.requests).toHaveLength(0);
  expect(f.authority.executions(f.lease.binding.sessionId, 'alice')).toHaveLength(1);
});

test('opt-in authenticated history/context/recap and artifact routes use fresh authority, including offline reads', async () => {
  const f = await fixture({ toolArtifact: true });
  const { default: Fastify } = await import('fastify');
  const { registerGatewayRuntimeRoutes } = await import('../src/gateway-runtime/routes.js');
  const { validateRequest } = await import('../src/daemon/auth.js');
  const { registerErrorHandler } = await import('../src/http.js');
  const app = Fastify();
  cleanups.push(() => app.close());
  registerErrorHandler(app);
  registerGatewayRuntimeRoutes(app, {
    runtime: f.runtime,
    authority: f.authority,
    writer: () => f.lease,
    authenticate(request, mutation) {
      validateRequest(
        request,
        {
          trustedProxies: new Set(['127.0.0.1']),
          allowedUsers: new Set(['alice', 'mallory']),
          allowedHosts: new Set(['test.example']),
          allowedOrigins: new Set(['https://test.example']),
          identityHeader: 'x-pirc-user',
        },
        {
          authenticate() {
            throw new Error('No device token provisioned');
          },
        },
        mutation,
      );
    },
  });
  const prefix = `/api/sessions/${f.lease.binding.sessionId}`;
  const headers = { host: 'test.example', origin: 'https://test.example', 'x-pirc-user': 'alice' };
  const command = await app.inject({
    method: 'POST',
    url: `${prefix}/commands`,
    headers,
    payload: { type: 'prompt', input: f.input() },
  });
  expect(command.statusCode).toBe(200);
  expect(command.json().run.state).toBe('completed');
  expect(
    (await app.inject({ method: 'GET', url: `${prefix}/snapshot`, headers })).json().authority,
  ).toBe('gateway');
  expect(
    (await app.inject({ method: 'GET', url: `${prefix}/panel/context`, headers })).json().source,
  ).toBe('gateway-authority');
  const recap = await app.inject({ method: 'GET', url: `${prefix}/recap`, headers });
  expect(recap.statusCode).toBe(200);
  expect(
    recap.json().sessions[0].evidence.some((entry: any) => entry.text === 'hello from node'),
  ).toBe(true);
  expect(
    (await app.inject({ method: 'GET', url: `${prefix}/events`, headers })).json().events.length,
  ).toBeGreaterThan(0);
  const artifact = `${prefix}/artifacts/${f.toolArtifact!.artifactId}`;
  const content = await app.inject({ method: 'GET', url: `${artifact}/content`, headers });
  expect(content.statusCode).toBe(200);
  expect(content.body).toBe('private node artifact');
  expect(content.headers['content-type']).toBe('application/octet-stream');
  expect(content.headers['x-content-type-options']).toBe('nosniff');
  expect(
    (
      await app.inject({
        method: 'GET',
        url: artifact,
        headers: { ...headers, 'x-pirc-user': 'mallory' },
      })
    ).statusCode,
  ).toBe(403);
  const bad = await app.inject({
    method: 'POST',
    url: `${prefix}/commands`,
    headers,
    payload: { type: 'stop', binding: f.lease.binding },
  });
  expect(bad.statusCode).toBe(400);
  f.online(false);
  expect((await app.inject({ method: 'GET', url: `${prefix}/snapshot`, headers })).statusCode).toBe(
    200,
  );
  expect((await app.inject({ method: 'GET', url: artifact, headers })).json().availability).toBe(
    'unavailable',
  );
  expect(
    (await app.inject({ method: 'GET', url: `${artifact}/content`, headers })).statusCode,
  ).toBe(503);
  expect(f.effects).toBe(1);
});

test.skipIf(!process.env.PIRC_TEST_GATEWAY_WORKER)(
  'real OS-constrained worker drives the fake-provider coding flow',
  async () => {
    const f = await fixture({ realWorker: process.env.PIRC_TEST_GATEWAY_WORKER! });
    expect((await f.runtime.run(f.lease, 'alice', f.input())).state).toBe('completed');
    expect(f.effects).toBe(1);
    expect(f.requests).toHaveLength(2);
  },
  15_000,
);
