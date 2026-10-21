// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { reactiveProps } from './testing/props.svelte';
import MemorySettings from './components/MemorySettings.svelte';
import RoomMessageRow from './components/rooms/RoomMessageRow.svelte';
import {
  describeOrigin,
  describeVersion,
  type MemoryRecord,
  type Preference,
  type PreferencesView,
} from './memory';
import type { RoomMessage } from './rooms';

describe('memory labels', () => {
  it('says where a memory came from', () => {
    expect(describeOrigin('user')).toBe('From your words');
    expect(describeOrigin('tool:web_search')).toBe('From what it read (web_search)');
    expect(describeOrigin('om:promoted')).toBe('From an earlier conversation');
    expect(describeOrigin('')).toBe('');
  });

  it('says who changed a version', () => {
    const version = { revision: 2, content: 'x', origins: [], sources: {}, at: 0 };
    expect(describeVersion({ ...version, op: 'add', actor: 'face:host' })).toBe('Added by pirc');
    expect(describeVersion({ ...version, op: 'restore', actor: 'user:me' })).toBe(
      'Restored by you',
    );
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

describe('MemorySettings', () => {
  let target: HTMLDivElement;
  let component: ReturnType<typeof mount> | undefined;
  let calls: Array<{ url: string; method: string; body: unknown }>;
  let view: PreferencesView;
  let records: MemoryRecord[];

  const preference = (
    id: string,
    content: string,
    extra: Partial<Preference> = {},
  ): Preference => ({
    id,
    content,
    status: 'active',
    revision: 1,
    origins: ['user'],
    sources: { roomId: 'room_general', quote: 'keep it short' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdInRoom: 'room_general',
    ...extra,
  });

  const button = (text: string, within: ParentNode = target) =>
    Array.from(within.querySelectorAll<HTMLButtonElement>('button')).find(
      (item) => item.textContent?.trim() === text,
    )!;
  const row = (text: string, list?: string) =>
    Array.from(
      (list ? target.querySelector(`[aria-label="${list}"]`)! : target).querySelectorAll('li'),
    ).find((item) => item.textContent?.includes(text))!;
  const lastChange = () => {
    const changes = calls.filter((call) => call.method !== 'GET');
    return changes[changes.length - 1];
  };

  beforeEach(() => {
    calls = [];
    view = {
      usage: { used: 21, max: 2000 },
      preferences: [preference('p1', 'Prefers short answers.', { revision: 2 })],
      removed: [preference('p2', 'Old preference.', { status: 'removed' })],
      rooms: { room_general: 'general' },
    };
    records = [
      {
        id: 'aaaaaaaaaaaa',
        kind: 'fact',
        content: 'Uses TLP for power management',
        date: '2026-10-20 10:00',
        status: 'active',
        origin: 'user',
      },
    ];
    stubFetch(calls, (url, method) => {
      if (url.endsWith('/history'))
        return {
          versions: [
            {
              revision: 2,
              op: 'restore',
              content: 'Prefers short answers.',
              origins: ['user'],
              sources: {},
              actor: 'user:me',
              at: Date.now(),
            },
            {
              revision: 1,
              op: 'add',
              content: 'Prefers brief answers.',
              origins: ['user'],
              sources: {},
              actor: 'face:host',
              at: Date.now(),
            },
          ],
        };
      if (url.startsWith('/api/memory/records')) {
        if (method === 'DELETE') {
          records = [];
          return { record: {} };
        }
        return { records };
      }
      if (method === 'POST' && url.includes('/forget')) view = { ...view, preferences: [] };
      return view;
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

  it('shows preferences and facts, with where they came from', async () => {
    component = mount(MemorySettings, { target, props: {} });
    await flush();
    expect(calls.map((call) => call.url)).toEqual([
      '/api/memory/preferences',
      '/api/memory/records?scope=person',
    ]);
    const kept = row('Prefers short answers.', 'Preferences');
    expect(kept.textContent).toContain('you said “keep it short”');
    expect(kept.textContent).toContain('in #general');
    expect(target.textContent).toContain('21/2,000 characters');
    expect(row('Uses TLP', 'Facts').textContent).toContain('From your words');
  });

  it('removes, restores and forgets preferences; forgets facts after a second click', async () => {
    component = mount(MemorySettings, { target, props: {} });
    await flush();
    button('History', row('Prefers short')).click();
    await flush();
    const history = row('Prefers short').querySelector('[aria-label="History"]')!;
    expect(history.textContent).toContain('Added by pirc');
    button('Restore this', history).click();
    await flush();
    expect(lastChange()).toMatchObject({
      url: '/api/memory/preferences/p1/restore',
      body: { revision: 1 },
    });
    button('Remove', row('Prefers short')).click();
    await flush();
    expect(lastChange()).toMatchObject({ url: '/api/memory/preferences/p1/remove' });
    button('Restore', row('Old preference.')).click();
    await flush();
    expect(lastChange()).toMatchObject({ url: '/api/memory/preferences/p2/restore', body: {} });

    const fact = row('Uses TLP', 'Facts');
    button('Forget', fact).click();
    flushSync();
    expect(lastChange()?.method).toBe('POST');
    button('Forget for good', fact).click();
    await flush();
    expect(lastChange()).toMatchObject({
      url: '/api/memory/records/aaaaaaaaaaaa',
      method: 'DELETE',
    });
    expect(target.textContent).toContain('No facts yet.');
  });

  it('searches the chosen facts', async () => {
    component = mount(MemorySettings, { target, props: {} });
    await flush();
    const input = target.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = '電源';
    input.dispatchEvent(new Event('input'));
    const select = target.querySelector<HTMLSelectElement>('select')!;
    select.value = 'all';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(calls[calls.length - 1]?.url).toBe('/api/memory/records?scope=all&q=%E9%9B%BB%E6%BA%90');
  });

  it('reloads when the gateway says memory changed, and never calls it in demo mode', async () => {
    const props = reactiveProps({ revision: 0 });
    component = mount(MemorySettings, { target, props });
    await flush();
    const before = calls.length;
    props.revision++;
    await flush();
    expect(calls.length).toBe(before + 2);
    unmount(component);
    component = undefined;
    calls = [];
    component = mount(MemorySettings, { target, props: { disabled: true } });
    await flush();
    expect(calls).toEqual([]);
    expect(target.textContent).toContain('demo mode');
  });
});

describe('a line that says what was remembered', () => {
  let target: HTMLDivElement;
  let component: ReturnType<typeof mount> | undefined;
  let calls: Array<{ url: string; method: string; body: unknown }>;

  const line = (memory: NonNullable<RoomMessage['body']['memory']>): RoomMessage => ({
    id: 'msg_1',
    roomId: 'room_general',
    seq: 3,
    speaker: 'face:host',
    user: null,
    kind: 'line',
    body: { text: 'Noted: Uses TLP for power management', memory },
    threadId: null,
    createdAt: Date.now(),
    editedAt: null,
    pinnedAt: null,
  });

  beforeEach(() => {
    calls = [];
    stubFetch(calls, () => ({}));
    target = document.createElement('div');
    document.body.append(target);
  });
  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    target.remove();
    vi.unstubAllGlobals();
  });

  it("expands to where it came from and is undone by Don't keep", async () => {
    component = mount(RoomMessageRow, {
      target,
      props: {
        message: line({ kind: 'fact', id: 'aaaaaaaaaaaa', origin: 'user', user: 'me@example.com' }),
      },
    });
    const buttons = () => Array.from(target.querySelectorAll('button'));
    buttons()[0].click();
    flushSync();
    expect(target.textContent).toContain('A fact: found again when it matters. From your words');
    expect(target.querySelector('a[href="/engine?open=memory"]')?.textContent).toBe('Details');
    buttons()
      .find((button) => button.textContent === "Don't keep")!
      .click();
    await flush();
    expect(calls).toEqual([
      { url: '/api/memory/records/aaaaaaaaaaaa', method: 'DELETE', body: undefined },
    ]);
  });

  it('forgets a preference through its own route, and offers nothing once forgotten', async () => {
    component = mount(RoomMessageRow, {
      target,
      props: { message: line({ kind: 'preference', id: 'p1' }) },
    });
    Array.from(target.querySelectorAll('button'))
      .find((button) => button.textContent === "Don't keep")!
      .click();
    await flush();
    expect(calls[0]).toMatchObject({ url: '/api/memory/preferences/p1/forget', method: 'POST' });
    unmount(component);
    component = mount(RoomMessageRow, {
      target,
      props: { message: line({ kind: 'fact', id: 'aaaaaaaaaaaa', forgotten: true }) },
    });
    expect(target.querySelectorAll('button')).toHaveLength(0);
  });
});
