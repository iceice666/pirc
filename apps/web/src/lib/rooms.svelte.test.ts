// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/?room=general"}
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Rooms from './components/rooms/Rooms.svelte';
import type { RoomEvent, RoomMessage, RoomView } from './rooms';
import { RoomsState, TYPING_THROTTLE_MS, roomFromUrl } from './rooms.svelte';

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  constructor(readonly url: string) {
    super();
    FakeSocket.all.push(this);
  }
  close() {}
  frame(value: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
}

const ME = 'me@example.com';
const room = (id: string, extra: Partial<RoomView> = {}): RoomView => ({
  id,
  name: id,
  kind: id === 'general' ? 'general' : 'topic',
  createdAt: 1,
  archivedAt: null,
  lastActivityAt: 1,
  sourceScope: null,
  movedToRoomId: null,
  movedFromRoomId: null,
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  waiting: false,
  waitingSince: null,
  ...extra,
});
const message = (roomId: string, seq: number, user = ME, text = `m${seq}`): RoomMessage => ({
  id: `${roomId}-${seq}`,
  roomId,
  seq,
  speaker: 'user',
  user,
  kind: 'text',
  body: { text },
  threadId: null,
  createdAt: 1_700_000_000_000 + seq,
  editedAt: null,
  pinnedAt: null,
});
const event = (
  type: RoomEvent['type'],
  roomId: string,
  data: unknown,
  sequence = 1,
): RoomEvent => ({
  type,
  roomId,
  epoch: 1,
  sequence,
  data,
  timestamp: 0,
});

let calls: Array<{ method: string; url: string; body: any }>;
let listed: RoomView[];
let pages: Record<string, RoomMessage[]>;

function reply(value: unknown, status = 200) {
  return new Response(value === undefined ? null : JSON.stringify(value), { status });
}

beforeEach(() => {
  FakeSocket.all = [];
  calls = [];
  listed = [room('general', { lastSeq: 1, readSeq: 1 }), room('topic')];
  pages = { general: [message('general', 1)], topic: [] };
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost');
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : init.body;
      calls.push({ method, url: url.pathname + url.search, body });
      const [, , , id, rest] = url.pathname.split('/');
      if (url.pathname === '/api/rooms')
        return reply({ rooms: listed.filter((item) => !item.archivedAt), user: ME });
      const found = listed.find((item) => item.id === id);
      if (!found) return reply({ error: { code: 'not_found', message: 'Room not found' } }, 404);
      if (!rest && method === 'GET') return reply({ room: found, pinned: [] });
      if (rest === 'messages' && method === 'GET')
        return reply({ messages: pages[id!] ?? [], hasMore: false });
      if (rest === 'messages') {
        const sent = message(id!, found.lastSeq + 1, ME, body.text);
        found.lastSeq = sent.seq;
        found.readSeq = sent.seq;
        return reply({ message: sent }, 201);
      }
      if (rest === 'read') return reply({ room: { ...found, readSeq: body.seq, unread: 0 } });
      if (rest === 'typing') return reply(undefined, 204);
      return reply({}, 200);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('room state', () => {
  it('opens the room the address names and follows the stream', async () => {
    const rooms = new RoomsState();
    await rooms.start();
    expect(roomFromUrl()).toBe('general');
    expect(rooms.user).toBe(ME);
    expect(rooms.current?.id).toBe('general');
    expect(rooms.messages.map((item) => item.seq)).toEqual([1]);
    expect(FakeSocket.all[0]!.url).toBe('ws://localhost/api/events?rooms=1');
    rooms.stop();
  });

  it('counts others’ messages as unread, never your own', async () => {
    const rooms = new RoomsState();
    await rooms.start();
    rooms.apply(event('room_message', 'topic', { message: message('topic', 1, 'other') }));
    rooms.apply(event('room_message', 'topic', { message: message('topic', 2, ME) }));
    expect(rooms.rooms.find((item) => item.id === 'topic')!.unread).toBe(1);
    // In the open room it is shown at once, and read.
    listed[0]!.lastSeq = 2;
    rooms.apply(event('room_message', 'general', { message: message('general', 2, 'other') }));
    expect(rooms.messages.map((item) => item.seq)).toEqual([1, 2]);
    await vi.waitFor(() =>
      expect(calls.some((call) => call.url === '/api/rooms/general/read')).toBe(true),
    );
    // The same message twice (replay after a reconnect) is shown once.
    rooms.apply(event('room_message', 'general', { message: message('general', 2, 'other') }));
    expect(rooms.messages).toHaveLength(2);
    rooms.stop();
  });

  it('shows who else is typing until their signal lapses or they send', async () => {
    const rooms = new RoomsState();
    await rooms.start();
    rooms.apply(event('room_typing', 'general', { user: 'other', expiresAt: 10_000 }, 0));
    rooms.apply(event('room_typing', 'general', { user: ME, expiresAt: 10_000 }, 0));
    expect(rooms.typingIn('general', 5_000)).toEqual(['other']);
    expect(rooms.typingIn('general', 10_000)).toEqual([]);
    rooms.apply(event('room_message', 'general', { message: message('general', 2, 'other') }));
    expect(rooms.typingIn('general', 5_000)).toEqual([]);
    rooms.stop();
  });

  it('sends typing at most every three seconds', async () => {
    const rooms = new RoomsState();
    await rooms.start();
    rooms.keystroke(100_000);
    rooms.keystroke(100_000 + TYPING_THROTTLE_MS - 1);
    rooms.keystroke(100_000 + TYPING_THROTTLE_MS);
    expect(calls.filter((call) => call.url.endsWith('/typing'))).toHaveLength(2);
    rooms.stop();
  });

  it('keeps the cursor of the last numbered event for the next socket', async () => {
    const rooms = new RoomsState();
    await rooms.start();
    const socket = FakeSocket.all[0]!;
    socket.frame({ type: 'ready', watermark: { epoch: 5, sequence: 3 } });
    socket.frame({ ...event('room_typing', 'general', { user: 'x', expiresAt: 1 }, 0), epoch: 5 });
    socket.frame({ ...event('room_changed', 'general', { room: listed[0] }, 4), epoch: 5 });
    vi.useFakeTimers();
    socket.dispatchEvent(new Event('close'));
    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.all[1]!.url).toBe('ws://localhost/api/events?rooms=1&cursor=5%3A4');
    rooms.stop();
  });
});

describe('rooms page', () => {
  let target: HTMLElement;
  let component: ReturnType<typeof mount> | undefined;
  beforeEach(() => {
    target = document.createElement('div');
    document.body.append(target);
  });
  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    target.remove();
  });

  async function show() {
    const store = new RoomsState();
    component = mount(Rooms, { target, props: { store } });
    await vi.waitFor(() => expect(target.textContent).toContain('m1'));
    return store;
  }

  it('lists rooms by activity with unread dots, and the open room’s messages', async () => {
    listed[1] = room('topic', { lastActivityAt: 5, lastSeq: 2, unread: 2 });
    await show();
    const names = [...target.querySelectorAll('.room-name')].map((item) => item.textContent);
    expect(names).toEqual(['topic', 'general']);
    expect(target.querySelector('[aria-label="2 unread"]')).not.toBeNull();
    expect(target.querySelector('article .name')!.textContent).toBe(ME);
    expect(target.querySelector('a[href="/engine"]')).not.toBeNull();
  });

  it('sends on Enter, sends now on Cmd+Enter, and leaves Enter to an IME', async () => {
    await show();
    const box = target.querySelector('textarea')!;
    const type = (text: string, init: KeyboardEventInit) => {
      box.value = text;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      flushSync();
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }));
    };
    const sends = () =>
      calls.filter((call) => call.method === 'POST' && call.url.endsWith('/messages'));

    type('選字中', { isComposing: true });
    await tick();
    expect(sends()).toHaveLength(0);

    type('one', {});
    await vi.waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0]!.body).toEqual({ text: 'one', attachments: [], immediate: false });
    await vi.waitFor(() => expect(target.textContent).toContain('one'));
    await vi.waitFor(() => expect(box.value).toBe(''));

    type('now', { metaKey: true });
    await vi.waitFor(() => expect(sends()).toHaveLength(2));
    expect(sends()[1]!.body.immediate).toBe(true);
  });

  it('sends quick short messages in a row, in order, without losing any', async () => {
    await show();
    const box = target.querySelector('textarea')!;
    for (const text of ['SlimeOS', 'PR#123', '怎樣了？']) {
      box.value = text;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      flushSync();
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      flushSync();
      expect(box.value).toBe('');
    }
    await vi.waitFor(() =>
      expect(
        calls
          .filter((call) => call.method === 'POST' && call.url.endsWith('/messages'))
          .map((call) => call.body.text),
      ).toEqual(['SlimeOS', 'PR#123', '怎樣了？']),
    );
    await vi.waitFor(() => expect(target.querySelectorAll('article .text')).toHaveLength(4));
  });

  it('reads an archived room from its URL but takes nothing new', async () => {
    listed[0] = room('general', { lastSeq: 1, readSeq: 1 });
    const archived = room('old', { archivedAt: 9 });
    listed.push(archived);
    pages.old = [message('old', 1, 'other', 'kept')];
    const store = await show();
    await store.open('old');
    await tick();
    expect(target.textContent).toContain('kept');
    expect(target.textContent).toContain('Archived');
    expect(target.querySelector('textarea')).toBeNull();
  });
});
