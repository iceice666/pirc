// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import LoopsSettings from './components/LoopsSettings.svelte';
import RoomMessageRow from './components/rooms/RoomMessageRow.svelte';
import { describeAnchor, describeClosed, lineAction, type LoopLine, type OpenLoop } from './loops';
import type { RoomMessage } from './rooms';
import { reactiveProps } from './testing/props.svelte';

/** Tuesday 2026-10-20 10:00 UTC. */
const NOW = Date.UTC(2026, 9, 20, 10, 0);

const loop = (id: string, what: string, extra: Partial<OpenLoop> = {}): OpenLoop => ({
  id,
  user: 'me@example.com',
  roomId: 'general',
  faceId: 'host',
  what,
  why: '',
  origin: 'user',
  anchor: null,
  nextCheck: null,
  status: 'open',
  closedReason: null,
  closedAt: null,
  createdAt: NOW,
  lastTouchedAt: NOW,
  dueAt: null,
  ...extra,
});

describe('open loop labels', () => {
  it('says when an anchor comes', () => {
    const weekly = loop('l1', 'Team meeting', {
      anchor: { cron: '0 18 * * 3', zone: 'UTC', nextAt: Date.UTC(2026, 9, 21, 18) },
      dueAt: Date.UTC(2026, 9, 21, 18),
    });
    expect(describeAnchor(weekly, NOW)).toMatch(
      /^Next: Wed.*(18:00|06:00 PM) · repeats \(0 18 \* \* 3\)$/,
    );
    const deadline = loop('l2', 'HW3', {
      anchor: { at: Date.UTC(2026, 10, 24, 15, 59), zone: 'Asia/Taipei', autoClose: true },
      dueAt: Date.UTC(2026, 10, 24, 15, 59),
    });
    expect(describeAnchor(deadline, NOW)).toMatch(
      /^Due .*Nov.*(23:59|11:59 PM) · closes itself then$/,
    );
    const passed = loop('l3', 'Call the bank', {
      anchor: { at: Date.UTC(2026, 9, 20, 9), zone: 'UTC', passed: true },
    });
    expect(describeAnchor(passed, NOW)).toMatch(/^Was due /);
    expect(describeAnchor(loop('l4', 'No time'), NOW)).toBe('');
  });

  it('says why one was closed', () => {
    expect(describeClosed('elapsed')).toBe('its time has passed');
    expect(describeClosed('recurrence_ended')).toBe('it does not come again');
    expect(describeClosed('demoted')).toBe('kept in memory (untouched for a while)');
    expect(describeClosed('He fixed it')).toBe('He fixed it');
  });

  it('undoes an opening, and opens again what was closed', () => {
    expect(lineAction({ id: 'l1', event: 'opened' }).label).toBe("Don't keep");
    expect(lineAction({ id: 'l1', event: 'reopened' }).label).toBe("Don't keep");
    expect(lineAction({ id: 'l1', event: 'closed' }).label).toBe('Not done yet');
    expect(lineAction({ id: 'l1', event: 'demoted' }).label).toBe('Not done yet');
  });
});

/** A fetch that answers from `answer` and logs the calls. */
function stubFetch(
  calls: Array<{ url: string; method: string; body: unknown }>,
  answer: (url: string, method: string) => unknown,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(answer(url, method)), { status: 200 });
    }),
  );
}

async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await tick();
  }
}

describe('open loops in the web app', () => {
  let target: HTMLDivElement;
  let component: ReturnType<typeof mount> | undefined;
  let calls: Array<{ url: string; method: string; body: unknown }>;
  let open: OpenLoop[];
  let closed: OpenLoop[];

  const button = (text: string) =>
    Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (item) => item.textContent?.trim() === text,
    )!;

  const line = (loopLine: LoopLine, text: string): RoomMessage => ({
    id: 'msg_1',
    roomId: 'general',
    seq: 3,
    speaker: 'face:host',
    user: null,
    kind: 'line',
    body: { text, loop: loopLine },
    threadId: null,
    createdAt: Date.now(),
    editedAt: null,
    pinnedAt: null,
  });

  beforeEach(() => {
    calls = [];
    open = [loop('l1', 'Tune the power policy', { why: 'battery dies by noon' })];
    closed = [
      loop('l2', 'Read chapter 7', { status: 'closed', closedReason: 'demoted', closedAt: NOW }),
    ];
    stubFetch(calls, (url, method) => {
      if (method === 'PATCH') {
        const id = url.split('/').pop()!;
        const moved = [...open, ...closed].find((item) => item.id === id)!;
        open = open.filter((item) => item.id !== id);
        closed = closed.filter((item) => item.id !== id);
        return { loop: moved };
      }
      return url.includes('status=closed')
        ? { loops: closed, limit: 40 }
        : { loops: open, limit: 40 };
    });
    target = document.createElement('div');
    document.body.append(target);
  });
  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    target.remove();
    vi.unstubAllGlobals();
  });

  it('lists what is open and closed, and closes or reopens one', async () => {
    const props = reactiveProps({ revision: 0 });
    component = mount(LoopsSettings, { target, props });
    await flush();
    expect(target.textContent).toContain('Tune the power policy');
    expect(target.textContent).toContain('From your words · battery dies by noon');
    expect(target.textContent).toContain('Closed: kept in memory');
    button('Not needed').click();
    await flush();
    expect(calls.find((call) => call.method === 'PATCH')).toEqual({
      url: '/api/loops/l1',
      method: 'PATCH',
      body: { status: 'closed' },
    });
    expect(target.textContent).toContain('Nothing open.');
    button('Not done yet').click();
    await flush();
    expect(calls.filter((call) => call.method === 'PATCH')[1]).toEqual({
      url: '/api/loops/l2',
      method: 'PATCH',
      body: { status: 'open' },
    });
    // pirc changed a loop in a room: the list loads again.
    const before = calls.length;
    props.revision++;
    await flush();
    expect(calls.length).toBeGreaterThan(before);
  });

  it("offers Don't keep on an opening line, once", async () => {
    component = mount(RoomMessageRow, {
      target,
      props: {
        message: line({ id: 'l1', event: 'opened' }, 'Holding on to: Tune the power policy'),
      },
    });
    expect(target.textContent).toContain('Holding on to: Tune the power policy');
    button("Don't keep").click();
    await flush();
    expect(calls).toEqual([{ url: '/api/loops/l1', method: 'PATCH', body: { status: 'closed' } }]);
    expect(button("Don't keep")).toBeUndefined();
  });

  it('offers Not done yet on a demoted line', async () => {
    component = mount(RoomMessageRow, {
      target,
      props: {
        message: line(
          { id: 'l2', event: 'demoted' },
          'This sat untouched for a while, so I put it in memory: Read chapter 7',
        ),
      },
    });
    button('Not done yet').click();
    await flush();
    expect(calls).toEqual([{ url: '/api/loops/l2', method: 'PATCH', body: { status: 'open' } }]);
  });
});
