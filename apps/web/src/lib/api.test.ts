// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { api, normalizeEvent, snapshotFromRaw } from './api';
import type { SessionCommandInput } from './types';

const input: SessionCommandInput = {
  commandId: 'first-message',
  kind: 'prompt',
  controlGeneration: 1,
  content: 'hello',
  provider: 'anthropic',
  modelId: 'claude-opus-5-5',
  thinkingLevel: 'high',
  attachmentIds: ['image-1'],
};

function mockCommands(status = 'accepted') {
  const bodies: any[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    return new Response(JSON.stringify({ command: { id: body.commandId, status, error: null } }), {
      status: 200,
    });
  });
  vi.stubGlobal('fetch', fetch);
  return { bodies, fetch };
}

afterEach(() => vi.unstubAllGlobals());

it('applies the selected model and thinking before sending the first prompt', async () => {
  const { bodies } = mockCommands();
  const receipt = await api.command('new-session', input);
  expect(bodies.map((body) => body.payload)).toEqual([
    { type: 'set_model', provider: 'anthropic', modelId: 'claude-opus-5-5' },
    { type: 'set_thinking', level: 'high' },
    { type: 'prompt', message: 'hello', uploadIds: ['image-1'] },
  ]);
  expect(new Set(bodies.map((body) => body.commandId)).size).toBe(3);
  expect(bodies.every((body) => body.generation === 1)).toBe(true);
  expect(receipt.commandId).toBe('first-message');
});

it('waits for model acceptance before issuing any later command', async () => {
  const { fetch } = mockCommands();
  let accept!: (response: Response) => void;
  fetch.mockImplementationOnce(() => new Promise((resolve) => (accept = resolve)));
  const pending = api.command('new-session', input);
  expect(fetch).toHaveBeenCalledTimes(1);
  accept(new Response(JSON.stringify({ command: { id: 'model', status: 'accepted' } })));
  await pending;
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('does not send a prompt if model selection is rejected', async () => {
  const { bodies } = mockCommands('rejected');
  await expect(api.command('new-session', input)).rejects.toThrow('not accepted');
  expect(bodies).toHaveLength(1);
  expect(bodies[0].payload.type).toBe('set_model');
});

it('does not silently use the default when the selected provider is missing', async () => {
  const { fetch } = mockCommands();
  await expect(api.command('new-session', { ...input, provider: undefined })).rejects.toThrow(
    'no provider',
  );
  expect(fetch).not.toHaveBeenCalled();
});

it('does not change settings for steering or queued messages', async () => {
  const { bodies } = mockCommands();
  await api.command('session', { ...input, kind: 'steer' });
  await api.command('session', { ...input, kind: 'follow_up' });
  expect(bodies.map((body) => body.payload.type)).toEqual(['steer', 'follow_up']);
});

it('preserves prompts without explicit settings', async () => {
  const { bodies } = mockCommands();
  await api.command('session', {
    commandId: 'plain',
    kind: 'prompt',
    controlGeneration: 1,
    content: 'hello',
  });
  expect(bodies.map((body) => body.payload)).toEqual([{ type: 'prompt', message: 'hello' }]);
});

it('addresses a queued message by its queue and index for send_now', async () => {
  const { bodies } = mockCommands();
  await api.command('session', {
    commandId: 'now',
    kind: 'send_now',
    controlGeneration: 1,
    content: 'do this instead',
    queued: { kind: 'follow_up', index: 2 },
  });
  expect(bodies.map((body) => body.payload)).toEqual([
    { type: 'send_now', queue: 'followUp', index: 2, message: 'do this instead' },
  ]);
});

it('regenerates an edited tree entry with selected settings, without replacing attachments', async () => {
  const { bodies } = mockCommands();
  await api.command('session', { ...input, kind: 'edit_message', entryId: 'entry-1' });
  expect(bodies.map((body) => body.payload)).toEqual([
    { type: 'set_model', provider: 'anthropic', modelId: 'claude-opus-5-5' },
    { type: 'set_thinking', level: 'high' },
    { type: 'edit_message', entryId: 'entry-1', message: 'hello' },
  ]);
});

it('switches a branch without sending prompt settings or attachments', async () => {
  const { bodies } = mockCommands();
  await api.command('session', { ...input, kind: 'switch_branch', entryId: 'entry-2' });
  expect(bodies.map((body) => body.payload)).toEqual([
    { type: 'switch_branch', entryId: 'entry-2' },
  ]);
});

it('applies chat memory decisions without requiring a node snapshot', () => {
  const raw = { sessionId: 's1', epoch: 2, sequence: 1 };
  expect(
    normalizeEvent({
      ...raw,
      type: 'interaction_created',
      data: {
        id: 'memory:p1:0',
        runnerEpoch: 0,
        kind: 'confirm',
        status: 'pending',
        request: {
          title: 'Add USER memory?',
          message: 'Proposed memory:\nLikes tea.\n\nYour words:\nI like tea',
          confirmLabel: 'Approve',
          cancelLabel: 'Reject',
        },
      },
    }).event,
  ).toMatchObject({
    type: 'interaction_updated',
    interaction: {
      id: 'memory:p1:0',
      description: expect.stringContaining('Your words:'),
      confirmLabel: 'Approve',
      cancelLabel: 'Reject',
    },
  });
  expect(
    normalizeEvent({ ...raw, type: 'interaction_answered', data: { interactionId: 'memory:p1:0' } })
      .event,
  ).toEqual({ type: 'interaction_removed', interactionId: 'memory:p1:0' });
  expect(normalizeEvent({ ...raw, type: 'session_deleted' }).event).toEqual({
    type: 'session_deleted',
  });
});

it('normalizes all answered interactions with their row epoch', () => {
  expect(
    normalizeEvent({
      sessionId: 's1',
      epoch: 999,
      sequence: 3,
      type: 'interaction_answered',
      data: { interactionId: 'interaction:q1', interactionEpoch: 4 },
    }).event,
  ).toEqual({
    type: 'interaction_removed',
    interactionId: 'interaction:q1',
    runnerEpoch: '4',
  });

  expect(
    normalizeEvent({
      sessionId: 's1',
      epoch: 999,
      sequence: 4,
      type: 'interaction_created',
      data: {
        id: 'interaction:q2',
        runnerEpoch: 5,
        kind: 'confirm',
        status: 'pending',
        request: { title: 'Continue?' },
      },
    }).event,
  ).toMatchObject({
    type: 'interaction_updated',
    interaction: { id: 'interaction:q2', runnerEpoch: '5' },
  });
});

it('invalidates checkpoint panels when an automatic capture can close', () => {
  expect(
    normalizeEvent({
      sessionId: 's1',
      epoch: 2,
      sequence: 1,
      type: 'pi_event',
      data: { type: 'agent_settled' },
    }),
  ).toMatchObject({ checkpointInvalidation: true, event: { type: 'reset' } });
  expect(
    normalizeEvent({ sessionId: 's1', epoch: 2, sequence: 2, type: 'runner_exit' }),
  ).toMatchObject({ checkpointInvalidation: true, event: { type: 'reset' } });
});

it('sends the delegation checkbox only when an approval ticks it', async () => {
  const bodies: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(null, { status: 204 });
    }),
  );
  await api.answerInteraction('s', 'd1', { action: 'answer', value: true, asUserRequest: true }, 1);
  await api.answerInteraction(
    's',
    'd1',
    { action: 'answer', value: false, asUserRequest: true },
    1,
  );
  await api.answerInteraction('s', 'd1', { action: 'answer', value: true }, 1);
  expect(bodies.map((body) => body.answer)).toEqual([
    { confirmed: true, asUserRequest: true },
    { confirmed: false },
    { confirmed: true },
  ]);
});

it('sends an approval mode and reads it from events', async () => {
  const { bodies } = mockCommands();
  await api.command('s', {
    commandId: 'c',
    kind: 'set_approval_mode',
    controlGeneration: 1,
    approvalMode: 'full-access',
  });
  expect(bodies[0].payload).toEqual({ type: 'set_approval_mode', mode: 'full-access' });
  const event = (mode: unknown) =>
    normalizeEvent({ type: 'pi_event', data: { type: 'approval_mode_changed', mode } }).event;
  expect(event('read-only')).toEqual({ type: 'approval_mode_changed', mode: 'read-only' });
  expect(event('yolo')).toEqual({ type: 'noop' });
});

it('reads a relayed confirm, its origin approval and the chat delegations', () => {
  const raw = { sessionId: 'chat', epoch: 0, sequence: 5 };
  expect(
    normalizeEvent({
      ...raw,
      type: 'interaction_created',
      data: {
        id: 'relay.d1.interaction_1',
        runnerEpoch: 0,
        kind: 'confirm',
        status: 'pending',
        request: {
          method: 'confirm',
          title: 'Allow network access?',
          relayed: {
            sessionId: 'worker',
            sessionName: 'Fix the tests',
            workspace: 'repo on node',
            delegationId: 'd1',
          },
        },
      },
    }).event,
  ).toMatchObject({
    type: 'interaction_updated',
    interaction: {
      id: 'relay.d1.interaction_1',
      kind: 'confirm',
      relayed: {
        sessionId: 'worker',
        sessionName: 'Fix the tests',
        workspace: 'repo on node',
        delegationId: 'd1',
      },
    },
  });
  const delegation = {
    id: 'd1',
    title: 'Fix the tests',
    workspace: 'repo on node',
    status: 'waiting_input',
    dispatch: 'auto',
    targetSessionId: 'worker',
  };
  expect(
    normalizeEvent({
      ...raw,
      type: 'delegations_changed',
      data: { delegations: [delegation, { id: 'd2', status: 'completed' }] },
    }).event,
  ).toEqual({ type: 'delegations_changed', delegations: [delegation] });
  const snapshot = (extra: object) =>
    snapshotFromRaw({ session: { id: 'chat', updatedAt: 0 }, ...extra }, null);
  expect(snapshot({ delegations: [delegation] }).delegations).toEqual([delegation]);
  // Older gateways: no list, rather than an empty one.
  expect('delegations' in snapshot({})).toBe(false);
  const origin = snapshot({
    session: {
      id: 'worker',
      updatedAt: 0,
      origin: {
        kind: 'delegation',
        delegationId: 'd1',
        fromSessionId: 'chat',
        title: 'Fix the tests',
        status: 'waiting_input',
        approval: {
          sessionId: 'chat',
          interactionId: 'relay.d1.interaction_1',
          title: 'Allow network access?',
          message: 'curl example.com',
        },
      },
    },
  }).session.origin;
  expect(origin).toMatchObject({
    approval: {
      sessionId: 'chat',
      interactionId: 'relay.d1.interaction_1',
      title: 'Allow network access?',
      message: 'curl example.com',
    },
  });
});

it('answers relayed confirms and stops delegations without a control lease', async () => {
  const calls: Array<[string, RequestInit]> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ status: 'stopping' }), { status: 200 });
    }),
  );
  await api.answerRelayed('chat', 'relay.d1.i', false);
  await api.answerInteraction('chat', 'relay.d1.i', { action: 'answer', value: true });
  await expect(api.stopDelegation('d1')).resolves.toEqual({ status: 'stopping' });
  expect(calls.map(([url]) => url)).toEqual([
    '/api/sessions/chat/interactions/relay.d1.i/answer',
    '/api/sessions/chat/interactions/relay.d1.i/answer',
    '/api/delegations/d1/stop',
  ]);
  expect(JSON.parse(calls[0]![1].body as string)).toEqual({ answer: { confirmed: false } });
  const second = JSON.parse(calls[1]![1].body as string);
  expect(second.answer).toEqual({ confirmed: true });
  expect('generation' in second).toBe(false);
  expect(calls[2]![1]).toMatchObject({ method: 'POST' });
  expect(calls[2]![1].body).toBeUndefined();
});
