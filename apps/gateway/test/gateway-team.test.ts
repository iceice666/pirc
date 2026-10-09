import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { gatewayTeam } from '../src/gateway-runtime/team.js';
import type { RuntimeEvent, GatewayAgentRuntime } from '../src/gateway-runtime/runtime.js';
import { emptyUsage } from '../src/agent/messages.js';

test('cancelled gateway child provisioning never starts a late prompt', async () => {
  const authority = new GatewaySessionAuthority(':memory:');
  const activate = () =>
    authority.activate({
      ...authority.prepare({
        owner: 'alice',
        nodeId: 'n',
        workspaceId: 'n:w',
        legacySessionIds: [],
      }),
      fenced: true,
    });
  const parent = activate();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve)),
    started = new Promise<void>((resolve) => (entered = resolve));
  let prompts = 0,
    stops = 0;
  const team = gatewayTeam({
    authority,
    parent,
    owner: 'alice',
    team: {
      models: { providers: {} },
      deliverParent: () => {},
      askUser: async () => ({ status: 'cancelled', answers: [] }),
    },
    provision: async () => {
      entered();
      await held;
      return {
        lease: activate(),
        runtime: {
          run: async () => {
            prompts++;
            return { state: 'completed' };
          },
          cancel: async () => {
            stops++;
          },
          close: async () => {},
        } as unknown as GatewayAgentRuntime,
        subscribe: () => () => {},
      };
    },
  });
  const controller = new AbortController();
  const spawn = team.spawn(
    { name: 'child', task: 'work' },
    { cwd: '.', model: 'fake/fake' },
    controller.signal,
  );
  await started;
  controller.abort();
  release();
  await expect(spawn).rejects.toThrow();
  expect(prompts).toBe(0);
  expect(stops).toBe(1);
  await team.close();
  authority.close();
});

test('gateway team adapter launches no node Agent and delegates cwd validation before runtime', async () => {
  const authority = new GatewaySessionAuthority(':memory:');
  const activate = () =>
    authority.activate({
      ...authority.prepare({
        owner: 'alice',
        nodeId: 'n',
        workspaceId: 'n:w',
        legacySessionIds: [],
      }),
      fenced: true,
    });
  const parent = activate();
  let provisioned = 0,
    stopped = 0;
  const deliveries: unknown[] = [];
  let childCall:
    | ((operation: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>)
    | undefined;
  const team = gatewayTeam({
    authority,
    parent,
    owner: 'alice',
    team: {
      models: { providers: {} },
      deliverParent: (entry) => deliveries.push(entry),
      askUser: async () => ({ status: 'cancelled', answers: [] }),
    },
    provision: async (request) => {
      provisioned++;
      childCall = request.call;
      expect(request.cwd).toBe('subdir');
      const lease = activate();
      let emit: (event: RuntimeEvent) => void = () => {};
      const runtime = {
        run: async () => {
          emit({
            sessionId: lease.binding.sessionId,
            runId: randomUUID(),
            callId: randomUUID(),
            seq: 1,
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'child result' }],
              api: 'fake',
              provider: 'fake',
              model: 'fake',
              usage: emptyUsage(),
              stopReason: 'stop',
              timestamp: 1,
            },
          });
          return { state: 'completed' };
        },
        cancel: async () => {
          stopped++;
        },
        close: async () => {},
        steer: () => {},
      } as unknown as GatewayAgentRuntime;
      return {
        runtime,
        lease,
        subscribe: (listener) => {
          emit = listener;
          return () => {};
        },
      };
    },
  });
  try {
    const child = await team.spawn(
      { name: 'child', task: 'work', cwd: 'subdir' },
      { cwd: '/node/parent', model: 'fake/fake' },
    );
    expect(child.name).toBe('child');
    expect(provisioned).toBe(1);
    await expect(
      childCall!('agent_stop', { agent: 'child' }, new AbortController().signal),
    ).rejects.toThrow('Only parent');
    expect(await childCall!('agent_list', {}, new AbortController().signal)).toBeDefined();
    await expect(
      childCall!('agent_wait', { agent: 'parent' }, new AbortController().signal),
    ).rejects.toThrow();
    const question = (await childCall!(
      'agent_ask',
      { question: 'Need clarification' },
      new AbortController().signal,
    )) as { id: string };
    const reply = (await team.call(
      'parent',
      'agent_reply',
      { question_id: question.id, answer: 'Clarified' },
      new AbortController().signal,
    )) as { question_id: string };
    expect(reply.question_id).toBe(question.id);
    await expect(
      team.call(
        'parent',
        'agent_reply',
        { question_id: question.id, answer: 'twice' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('already answered');
    await Bun.sleep(10);
    expect(team.list().agents[0]?.status).toBe('idle');
    expect(deliveries.length).toBeGreaterThan(0);
    expect(
      authority
        .read(parent.binding.sessionId, 'alice')
        .entries.some(
          (entry) => entry.type === 'custom' && entry.customType === 'runtime.team.event',
        ),
    ).toBe(true);
    await team.stop('child');
    expect(stopped).toBe(1);
    await team.close();
    const restored = gatewayTeam({
      authority,
      parent,
      owner: 'alice',
      team: {
        models: { providers: {} },
        deliverParent: () => {},
        askUser: async () => ({ status: 'cancelled', answers: [] }),
      },
      provision: async () => {
        throw new Error('Restart must not launch a child');
      },
    });
    expect(restored.list().agents[0]?.status).toBe('stopped');
    expect(restored.records.length).toBeGreaterThan(0);
    await restored.close();
  } finally {
    await team.close();
    authority.close();
  }
});
