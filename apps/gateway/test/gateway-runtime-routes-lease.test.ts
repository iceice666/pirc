import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { ApiError } from '../src/errors.js';
import { registerErrorHandler } from '../src/http.js';
import { registerGatewayRuntimeRoutes } from '../src/gateway-runtime/routes.js';
import type { GatewayAgentRuntime } from '../src/gateway-runtime/runtime.js';
import type { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import type { WriterLease } from '../src/gateway-runtime/contracts.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sessionId = randomUUID();
const holder = { clientId: 'holder-tab', generation: 3 };

function setup(options: { control?: boolean; user?: string } = {}) {
  const calls: string[] = [];
  const controlCalls: Array<[string, string, string, number]> = [];
  const lease = { binding: { sessionId, workspaceId: randomUUID() } } as unknown as WriterLease;
  const runtime = {
    run: async () => {
      calls.push('run');
      return { state: 'completed' };
    },
    steer: () => calls.push('steer'),
    selectModel: () => calls.push('selectModel'),
    selectThinking: () => calls.push('selectThinking'),
    cancel: async () => {
      calls.push('cancel');
    },
    reconcile: async (_id: string, _owner: string, after: number) => {
      calls.push(`reconcile:${after}`);
      return { reconciled: true };
    },
  } as unknown as GatewayAgentRuntime;
  const authority = {
    assertOwner(id: string, owner: string) {
      if (id !== sessionId || owner !== 'alice') throw Error('not owner');
    },
  } as unknown as GatewaySessionAuthority;
  const app = Fastify();
  cleanups.push(() => app.close());
  registerErrorHandler(app);
  registerGatewayRuntimeRoutes(app, {
    runtime,
    authority,
    authenticate(request) {
      request.identity = { user: options.user ?? 'alice' } as never;
    },
    writer: () => {
      calls.push('writer');
      return lease;
    },
    ...(options.control === false
      ? {}
      : {
          control(id: string, owner: string, clientId: string, generation: number) {
            controlCalls.push([id, owner, clientId, generation]);
            if (clientId !== holder.clientId || generation !== holder.generation)
              throw new ApiError(
                409,
                'lost_control',
                'Control lease is missing, expired, or superseded',
              );
          },
        }),
  });
  const post = (route: 'commands' | 'reconcile', payload?: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/${route}`,
      ...(payload ? { payload } : {}),
    });
  return { calls, controlCalls, post };
}

const input = () => ({ runId: randomUUID(), turnId: randomUUID(), text: 'hi', attachments: [] });
const commands = () => [
  { type: 'prompt', input: input() },
  { type: 'steer', input: input() },
  { type: 'stop' },
  { type: 'set_model', provider: 'openai', modelId: 'gpt-x' },
  { type: 'set_thinking', thinking: 'high' },
];

test('commands and reconcile fail closed without a control-lease verifier', async () => {
  const f = setup({ control: false });
  for (const command of commands()) {
    const response = await f.post('commands', { ...command, ...holder });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('forbidden');
  }
  const reconcile = await f.post('reconcile', { ...holder, after: 0 });
  expect(reconcile.statusCode).toBe(403);
  expect(f.calls).toEqual([]);
});

test('commands and reconcile reject missing or malformed lease fields before any runtime call', async () => {
  const f = setup();
  const bad: Array<Record<string, unknown>> = [
    {},
    { clientId: holder.clientId },
    { generation: holder.generation },
    { clientId: '', generation: 1 },
    { clientId: 'x'.repeat(201), generation: 1 },
    { clientId: holder.clientId, generation: -1 },
    { clientId: holder.clientId, generation: 1.5 },
    { clientId: holder.clientId, generation: '3' },
    { clientId: 7, generation: holder.generation },
  ];
  for (const fields of bad) {
    for (const command of commands())
      expect((await f.post('commands', { ...command, ...fields })).statusCode).toBe(400);
    expect((await f.post('reconcile', { ...fields, after: 0 })).statusCode).toBe(400);
  }
  expect((await f.post('reconcile')).statusCode).toBe(400);
  expect(f.calls).toEqual([]);
  expect(f.controlCalls).toEqual([]);
});

test('an authenticated owner client that does not hold the lease cannot mutate', async () => {
  const f = setup();
  const others = [
    { clientId: 'other-tab', generation: holder.generation },
    { clientId: holder.clientId, generation: holder.generation - 1 },
    { clientId: holder.clientId, generation: holder.generation + 1 },
  ];
  for (const other of others) {
    for (const command of commands()) {
      const response = await f.post('commands', { ...command, ...other });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('lost_control');
    }
    expect((await f.post('reconcile', { ...other, after: 2 })).statusCode).toBe(409);
  }
  // The lease is verified before the trusted writer lookup or any runtime effect.
  expect(f.calls).toEqual([]);
  expect(f.controlCalls.every(([id, owner]) => id === sessionId && owner === 'alice')).toBe(true);
});

test('a non-owner is rejected before lease verification', async () => {
  const f = setup({ user: 'mallory' });
  expect((await f.post('commands', { type: 'stop', ...holder })).statusCode).toBe(403);
  expect((await f.post('reconcile', { ...holder })).statusCode).toBe(403);
  expect(f.controlCalls).toEqual([]);
  expect(f.calls).toEqual([]);
});

test('the lease holder can run every command and reconcile', async () => {
  const f = setup();
  const prompt = await f.post('commands', { type: 'prompt', input: input(), ...holder });
  expect(prompt.statusCode).toBe(200);
  expect(prompt.json().run.state).toBe('completed');
  for (const command of commands().slice(1)) {
    const response = await f.post('commands', { ...command, ...holder });
    expect(response.statusCode).toBe(200);
    expect(response.json() as unknown).toEqual({ ok: true });
  }
  expect(f.calls).toEqual([
    'writer',
    'run',
    'writer',
    'steer',
    'writer',
    'cancel',
    'writer',
    'selectModel',
    'writer',
    'selectThinking',
  ]);
  const reconcile = await f.post('reconcile', { ...holder, after: 5 });
  expect(reconcile.statusCode).toBe(200);
  expect(reconcile.json() as unknown).toEqual({ reconciled: true });
  expect((await f.post('reconcile', { ...holder })).statusCode).toBe(200);
  expect(f.calls.slice(-2)).toEqual(['reconcile:5', 'reconcile:0']);
  expect(f.controlCalls).toHaveLength(7);
  expect(f.controlCalls[0]).toEqual([sessionId, 'alice', holder.clientId, holder.generation]);
});
