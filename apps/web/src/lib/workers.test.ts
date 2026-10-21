// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import RoomMessageRow from './components/rooms/RoomMessageRow.svelte';
import ThreadPanel from './components/rooms/ThreadPanel.svelte';
import type { RoomEvent, RoomMessage } from './rooms';
import { RoomsState } from './rooms.svelte';
import {
  questionOutcome,
  speakerName,
  statusLabel,
  stoppable,
  threadWorkers,
  type ThreadMessage,
  type Worker,
} from './workers';

const ME = 'me@example.com';
const NOW = Date.UTC(2026, 9, 21, 10, 0);

const said = (seq: number, extra: Partial<ThreadMessage>): ThreadMessage => ({
  id: `tmsg_${seq}`,
  threadId: 'thread_1',
  seq,
  speaker: 'worker:session_1',
  user: null,
  kind: 'text',
  body: {},
  depth: 0,
  createdAt: NOW + seq,
  updatedAt: null,
  ...extra,
});

const worker = (extra: Partial<Worker> = {}): Worker => ({
  id: 'd1',
  roomId: 'general',
  faceId: 'host',
  threadId: 'thread_1',
  anchorMessageId: 'msg_1',
  title: 'Run the tests',
  workspace: 'Repo on work',
  workspaceId: 'work:repo',
  status: 'running',
  note: null,
  readOnly: false,
  follows: null,
  for: ME,
  targetSessionId: 'session_1',
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});

const thread: ThreadMessage[] = [
  said(1, { speaker: 'face:host', body: { text: 'Run the tests.' } }),
  said(2, { kind: 'tool', body: { tool: 'bash', summary: 'bash cargo test' } }),
  said(3, {
    speaker: 'worker:session_1/checker',
    depth: 1,
    kind: 'line',
    body: { text: 'joined' },
  }),
  said(4, {
    kind: 'question',
    body: {
      interactionId: 'interaction-1',
      kind: 'select',
      request: { title: 'Which suite?', options: ['unit', 'all'] },
      status: 'pending',
      delegationId: 'd1',
    },
  }),
];

async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await tick();
  }
}

describe('worker words', () => {
  it('says what a worker is doing and who spoke', () => {
    expect(statusLabel('queued')).toBe('Waiting its turn');
    expect(statusLabel('running', 3)).toBe('Working (3)');
    expect(statusLabel('running')).toBe('Working');
    expect(statusLabel('waiting_input')).toBe('Asking you');
    expect(stoppable('running')).toBe(true);
    expect(stoppable('completed')).toBe(false);
    expect(speakerName({ speaker: 'face:host', user: null })).toBe('pirc');
    expect(speakerName({ speaker: 'user', user: ME })).toBe(ME);
    expect(speakerName({ speaker: 'worker:s1/checker', user: null })).toBe('checker');
    expect(speakerName({ speaker: 'worker:s1', user: null })).toBe('worker');
    expect(threadWorkers(thread)).toEqual([
      { speaker: 'worker:session_1', depth: 0 },
      { speaker: 'worker:session_1/checker', depth: 1 },
    ]);
  });
});

describe('workers in the web app', () => {
  let target: HTMLDivElement;
  let component: ReturnType<typeof mount> | undefined;
  let calls: Array<{ url: string; method: string; body: unknown }>;

  const button = (text: string) =>
    Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (item) => item.textContent?.trim() === text,
    )!;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (url.startsWith('/api/threads/thread_1') && method === 'GET')
          return new Response(
            JSON.stringify({ thread: {}, messages: thread, workers: [worker()] }),
          );
        return new Response(JSON.stringify({ status: 'ok' }));
      }),
    );
    target = document.createElement('div');
    document.body.append(target);
  });
  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    target.remove();
    vi.unstubAllGlobals();
  });

  it('asks a red line in the room and answers it, once or again', async () => {
    const message: RoomMessage = {
      id: 'msg_q',
      roomId: 'general',
      seq: 5,
      speaker: 'face:host',
      user: null,
      kind: 'question',
      body: {
        text: 'The worker for “Run the tests” asks: Auto mode: allow sending this out?',
        question: {
          interactionId: 'interaction-2',
          threadMessageId: 'tmsg_5',
          request: { title: 'Auto mode: allow sending this out?', allowAgain: true },
          status: 'pending',
        },
        worker: { delegationId: 'd1', threadId: 'thread_1', event: 'question' },
      },
      threadId: null,
      createdAt: NOW,
      editedAt: null,
      pinnedAt: null,
    };
    component = mount(RoomMessageRow, { target, props: { message } });
    await flush();
    expect(target.textContent).toContain('asks you');
    button('Allow again this session').click();
    await flush();
    expect(calls[calls.length - 1]).toEqual({
      url: '/api/threads/thread_1/answer',
      method: 'POST',
      body: { interactionId: 'interaction-2', answer: { confirmed: true, again: true } },
    });
    button('No').click();
    await flush();
    expect(calls[calls.length - 1]?.body).toEqual({
      interactionId: 'interaction-2',
      answer: { confirmed: false },
    });
    expect(
      questionOutcome({
        status: 'answered',
        answeredBy: ME,
        answer: { confirmed: true, again: true },
      }),
    ).toBe(`Allowed for the rest of its session by ${ME}.`);
    expect(questionOutcome({ status: 'answered', answer: { confirmed: false } })).toBe('Declined.');
    expect(questionOutcome({ status: 'expired' })).toBe(
      'Nobody answered in time: the worker was told no.',
    );
  });

  it('shows the anchor’s status, opens its thread and stops it', async () => {
    const opened: string[] = [];
    const message: RoomMessage = {
      id: 'msg_1',
      roomId: 'general',
      seq: 2,
      speaker: 'face:host',
      user: null,
      kind: 'text',
      body: {
        text: 'I asked a worker to: Run the tests (Repo on work)',
        worker: {
          delegationId: 'd1',
          threadId: 'thread_1',
          status: 'running',
          title: 'Run the tests',
          workspace: 'Repo on work',
          workers: 2,
          readOnly: false,
          note: null,
        },
      },
      threadId: 'thread_1',
      createdAt: NOW,
      editedAt: null,
      pinnedAt: null,
    };
    component = mount(RoomMessageRow, {
      target,
      props: { message, onopenthread: (id: string) => opened.push(id) },
    });
    await flush();
    expect(target.textContent).toContain('Working (2)');
    button('Thread').click();
    expect(opened).toEqual(['thread_1']);
    button('Stop').click();
    await flush();
    expect(calls).toContainEqual({
      url: '/api/delegations/d1/stop',
      method: 'POST',
      body: undefined,
    });
  });

  it('follows an open thread, answers its question and talks to the worker', async () => {
    const state = new RoomsState();
    await state.openThread('thread_1');
    expect(state.threadMessages.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    const event = (type: RoomEvent['type'], data: unknown): RoomEvent => ({
      type,
      roomId: 'general',
      epoch: 1,
      sequence: 9,
      data,
      timestamp: NOW,
    });
    state.apply(
      event('thread_message', {
        threadId: 'thread_1',
        message: said(5, { body: { text: 'Running now.' } }),
      }),
    );
    state.apply(
      event('thread_message', { threadId: 'thread_other', message: said(6, { threadId: 'x' }) }),
    );
    expect(state.threadMessages.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);

    component = mount(ThreadPanel, {
      target,
      props: {
        threadId: 'thread_1',
        messages: state.threadMessages,
        workers: state.threadWorkers,
        user: ME,
        onclose: () => state.closeThread(),
      },
    });
    await flush();
    expect(target.textContent).toContain('Which suite?');
    expect(target.textContent).toContain('checker');
    expect(target.querySelector('li.child')).not.toBeNull();
    button('all').click();
    await flush();
    expect(calls[calls.length - 1]).toEqual({
      url: '/api/threads/thread_1/answer',
      method: 'POST',
      body: { interactionId: 'interaction-1', answer: { value: 'all' } },
    });
    const input = target.querySelector<HTMLInputElement>(
      'input[aria-label="Say something to the worker"]',
    )!;
    input.value = 'also run clippy';
    input.dispatchEvent(new Event('input'));
    await flush();
    target.querySelector<HTMLFormElement>('form.composer')!.requestSubmit();
    await flush();
    expect(calls[calls.length - 1]).toEqual({
      url: '/api/threads/thread_1/messages',
      method: 'POST',
      body: { text: 'also run clippy' },
    });
    button('Stop').click();
    await flush();
    expect(calls[calls.length - 1]?.url).toBe('/api/delegations/d1/stop');
  });

  it('leaves acting on a worker to whom it works for', async () => {
    component = mount(ThreadPanel, {
      target,
      props: {
        threadId: 'thread_1',
        messages: thread,
        workers: [worker({ for: 'ann@example.com' })],
        user: ME,
        onclose: () => {},
      },
    });
    await flush();
    expect(target.textContent).toContain('Waiting for ann@example.com.');
    expect(button('Stop')).toBeUndefined();
    expect(target.querySelector('form.composer')).toBeNull();
  });
});
