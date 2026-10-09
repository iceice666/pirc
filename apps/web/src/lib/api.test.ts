// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { api, normalizeEvent } from './api';
import type { SessionCommandInput } from './types';

it('projects gateway questions and node approvals through separate reconnect event IDs', () => {
  for (const prefix of ['gateway-question-', 'node-environment-']) {
    const id = `${prefix}00000000-0000-4000-8000-000000000001`;
    const created = normalizeEvent({
      sessionId: 's',
      epoch: 'writer',
      sequence: 2,
      type: 'interaction_created',
      data: {
        id,
        runnerEpoch: 'writer',
        kind: prefix === 'node-environment-' ? 'confirm' : 'input',
        status: 'pending',
        request: { title: 'Review', message: 'Review this request' },
      },
    });
    expect(created.event).toMatchObject({
      type: 'interaction_updated',
      interaction: { id, title: 'Review' },
    });
    expect(
      normalizeEvent({
        sessionId: 's',
        epoch: 'writer',
        sequence: 3,
        type: 'interaction_answered',
        data: { interactionId: id },
      }).event,
    ).toEqual({ type: 'interaction_removed', interactionId: id });
  }
});

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
