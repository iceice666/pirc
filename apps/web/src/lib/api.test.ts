// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { api, normalizeEvent, snapshotFromRaw } from './api';
afterEach(() => vi.unstubAllGlobals());

const snapshot = (extra: object = {}) =>
  snapshotFromRaw(
    {
      session: { id: 's1', workspaceId: 'n:ws', name: 'Fix', runnerState: 'ready', updatedAt: 0 },
      watermark: { epoch: 3, sequence: 9 },
      ...extra,
    },
    null,
  );

it('keeps a session’s record, run and cursor from a snapshot, not its history or questions', () => {
  const state = snapshot({
    run: { id: 'r1', status: 'running', startedAt: 0 },
    history: [{ role: 'user', content: 'hi' }],
    interactions: [{ id: 'q1', runnerEpoch: 0, kind: 'confirm', request: { title: 'Ok?' } }],
    queue: { steering: ['later'] },
  });
  expect(state).toMatchObject({
    session: { id: 's1', name: 'Fix' },
    runnerStatus: 'ready',
    run: { id: 'r1', status: 'running' },
    control: { heldByCurrentClient: false },
    cursor: '3:9',
    runnerEpoch: '3',
  });
  for (const key of ['messages', 'interactions', 'queue', 'delegations', 'widgets'])
    expect(state).not.toHaveProperty(key);
});

it('reads the sandbox status, absent without a runner', () => {
  expect(snapshot({ sandbox: { active: false, reason: 'srt is not installed' } }).sandbox).toEqual({
    active: false,
    reason: 'srt is not installed',
  });
  expect(snapshot({ sandbox: { active: true } }).sandbox).toEqual({ active: true });
  expect(snapshot({ sandbox: null })).not.toHaveProperty('sandbox');
});

it('turns questions and run changes into a fresh snapshot, and ignores what the agent says', () => {
  const event = (extra: object) =>
    normalizeEvent({ sessionId: 's1', epoch: 2, sequence: 1, ...extra }).event;
  const reset = { type: 'reset', reason: 'cursor_expired' };
  expect(event({ type: 'interaction_created', data: { id: 'q1', runnerEpoch: 0 } })).toEqual(reset);
  expect(event({ type: 'interaction_answered', data: { interactionId: 'q1' } })).toEqual(reset);
  expect(event({ type: 'pi_event', data: { type: 'agent_end' } })).toEqual(reset);
  expect(event({ type: 'pi_event', data: { type: 'message_end', message: {} } })).toEqual({
    type: 'noop',
  });
  expect(event({ type: 'notification', data: { method: 'notify' } })).toEqual({ type: 'noop' });
  expect(event({ type: 'delegations_changed', data: { delegations: [] } })).toEqual({
    type: 'noop',
  });
  expect(event({ type: 'session_deleted' })).toEqual({ type: 'session_deleted' });
  // Anything unknown is safest as a fresh start.
  expect(event({ type: 'something_new' })).toEqual({ type: 'reset', reason: 'epoch_changed' });
});

it('reads a delegated session’s origin and the approval it waits on', () => {
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
    roomId: 'general',
    status: 'waiting_input',
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
  await expect(api.stopDelegation('d1')).resolves.toEqual({ status: 'stopping' });
  expect(calls.map(([url]) => url)).toEqual([
    '/api/sessions/chat/interactions/relay.d1.i/answer',
    '/api/delegations/d1/stop',
  ]);
  expect(JSON.parse(calls[0]![1].body as string)).toEqual({ answer: { confirmed: false } });
  expect(calls[1]![1]).toMatchObject({ method: 'POST' });
  expect(calls[1]![1].body).toBeUndefined();
});
