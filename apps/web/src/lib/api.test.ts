// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { api, normalizeEvent, snapshotFromRaw } from './api';
afterEach(() => vi.unstubAllGlobals());

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

it('reads an approval mode from events', () => {
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
        roomId: 'general',
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
