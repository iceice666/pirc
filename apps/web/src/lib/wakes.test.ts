// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import WakesSettings from './components/WakesSettings.svelte';
import RoomMessageRow from './components/rooms/RoomMessageRow.svelte';
import type { RoomMessage } from './rooms';
import { reactiveProps } from './testing/props.svelte';
import { describeOutcome, describeTrigger, type Wake } from './wakes';

/** Tuesday 2026-10-20 10:00 UTC. */
const NOW = Date.UTC(2026, 9, 20, 10, 0);

const wake = (id: string, extra: Partial<Wake> = {}): Wake => ({
  id,
  kind: 'self',
  trigger: { at: NOW + 3_600_000, why: 'look at the dotfiles' },
  roomId: 'general',
  faceId: 'host',
  user: 'me@example.com',
  scheduledAt: NOW + 3_600_000,
  startedAt: null,
  endedAt: null,
  outcome: null,
  note: null,
  attempt: 1,
  turnId: null,
  createdAt: NOW,
  ...extra,
});

describe('wake labels', () => {
  it('says what woke pirc', () => {
    expect(describeTrigger(wake('w1'))).toBe('Coming back to look at: look at the dotfiles');
    const anchor = (moment: 'due' | 'eve' | 'next') =>
      wake('w2', { kind: 'anchor', trigger: { loopId: 'l1', moment } });
    expect(describeTrigger(anchor('due'))).toBe("An open loop's time came");
    expect(describeTrigger(anchor('eve'))).toBe('The day before an open loop is due');
    expect(describeTrigger(anchor('next'))).toBe('A recurring open loop came round');
  });

  it('says how one went, or when it comes', () => {
    expect(describeOutcome(wake('w1'), 'UTC', NOW)).toMatch(/^At Tue.*(11:00|11:00 AM)$/);
    expect(describeOutcome(wake('w1', { startedAt: NOW }), 'UTC', NOW)).toBe('Awake now');
    expect(describeOutcome(wake('w1', { outcome: 'spoke' }))).toBe('Said something in the room');
    expect(describeOutcome(wake('w1', { outcome: 'silent' }))).toBe('Nothing to say');
    expect(describeOutcome(wake('w1', { outcome: 'silent', note: 'people took over again' }))).toBe(
      'Nothing to say (people took over again)',
    );
    expect(describeOutcome(wake('w1', { outcome: 'quota' }))).toBe(
      "Skipped: today's wakes were used up",
    );
    expect(describeOutcome(wake('w1', { outcome: 'failed', note: 'interrupted' }))).toBe(
      'Failed: interrupted',
    );
  });
});

async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await tick();
  }
}

describe('wakes in the web app', () => {
  let target: HTMLDivElement;
  let component: ReturnType<typeof mount> | undefined;
  let calls: Array<{ url: string; method: string }>;
  let list: Wake[];

  const button = (text: string) =>
    Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (item) => item.textContent?.trim() === text,
    )!;

  beforeEach(() => {
    calls = [];
    list = [
      wake('wake_1'),
      wake('wake_2', {
        kind: 'anchor',
        trigger: { loopId: 'l1', moment: 'due' },
        startedAt: NOW,
        endedAt: NOW,
        outcome: 'spoke',
      }),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        calls.push({ url, method });
        if (method === 'DELETE') {
          const id = url.split('/').pop()!;
          list = list.map((item) =>
            item.id === id ? { ...item, outcome: 'cancelled', endedAt: NOW } : item,
          );
          return new Response(JSON.stringify({ wake: list.find((item) => item.id === id) }));
        }
        return new Response(JSON.stringify({ wakes: list, today: { used: 3, limit: 24 } }));
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

  it('lists what is coming and what happened, and cancels one', async () => {
    const props = reactiveProps({ revision: 0 });
    component = mount(WakesSettings, { target, props });
    await flush();
    expect(target.textContent).toContain('Today: 3 of 24');
    expect(target.textContent).toContain('Coming back to look at: look at the dotfiles');
    expect(target.textContent).toContain('Said something in the room · #general');
    button('Cancel').click();
    await flush();
    expect(calls.find((call) => call.method === 'DELETE')).toEqual({
      url: '/api/wakes/wake_1',
      method: 'DELETE',
    });
    expect(target.textContent).toContain('Nothing coming.');
    expect(target.textContent).toContain('Cancelled');
    // A wake changed in a room: the list loads again.
    const before = calls.length;
    props.revision++;
    await flush();
    expect(calls.length).toBeGreaterThan(before);
  });

  it('offers Cancel on the line that says pirc will come back, once', async () => {
    const message: RoomMessage = {
      id: 'msg_1',
      roomId: 'general',
      seq: 3,
      speaker: 'face:host',
      user: null,
      kind: 'line',
      body: {
        text: "I'll come back Tue 11:00 to look at: look at the dotfiles",
        wake: { id: 'wake_1', event: 'scheduled' },
      },
      threadId: null,
      createdAt: Date.now(),
      editedAt: null,
      pinnedAt: null,
    };
    component = mount(RoomMessageRow, { target, props: { message } });
    button('Cancel').click();
    await flush();
    expect(calls).toEqual([{ url: '/api/wakes/wake_1', method: 'DELETE' }]);
    expect(button('Cancel')).toBeUndefined();
  });

  it('offers nothing on the line that says it was cancelled', () => {
    const message: RoomMessage = {
      id: 'msg_2',
      roomId: 'general',
      seq: 4,
      speaker: 'face:host',
      user: null,
      kind: 'line',
      body: {
        text: "I won't come back about: look at the dotfiles",
        wake: { id: 'wake_1', event: 'cancelled' },
      },
      threadId: null,
      createdAt: Date.now(),
      editedAt: null,
      pinnedAt: null,
    };
    component = mount(RoomMessageRow, { target, props: { message } });
    expect(target.textContent).toContain("I won't come back about");
    expect(target.querySelector('button')).toBeNull();
  });
});
