// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/?room=general"}
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Rooms from './components/rooms/Rooms.svelte';
import type { Face } from './faces';
import type { RoomEvent, RoomMessage, RoomView } from './rooms';
import { RoomsState, TYPING_THROTTLE_MS, roomFromUrl } from './rooms.svelte';
import type { ThreadMessage, Worker } from './workers';

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

const threadMessage = (
  seq: number,
  speaker: string,
  body: Record<string, unknown>,
  extra: Partial<ThreadMessage> = {},
): ThreadMessage => ({
  id: `tm_${seq}`,
  threadId: 'thr_1',
  seq,
  speaker,
  user: speaker === 'user' ? ME : null,
  kind: 'text',
  body,
  depth: 0,
  createdAt: 1_700_000_100_000 + seq * 1000,
  updatedAt: null,
  ...extra,
});

const workerRecord = (extra: Partial<Worker> = {}): Worker => ({
  id: 'dlg_1',
  roomId: 'general',
  faceId: 'face_pm',
  threadId: 'thr_1',
  anchorMessageId: 'anchor',
  title: 'Fix the lint job',
  workspace: 'slimeos',
  workspaceId: 'ws:slimeos',
  status: 'running',
  note: null,
  readOnly: false,
  follows: null,
  for: ME,
  targetSessionId: 'session_1',
  createdAt: 1,
  updatedAt: 2,
  ...extra,
});

const face = (id: string, name: string, extra: Partial<Face> = {}): Face => ({
  id,
  name,
  bio: '',
  tone: '',
  avatar: null,
  color: null,
  roleMd: '',
  territory: { rooms: [], workspaces: [], sources: [] },
  isHost: id === 'host',
  createdAt: 1,
  archivedAt: null,
  hiddenAt: null,
  ...extra,
});

let calls: Array<{ method: string; url: string; body: any }>;
let listed: RoomView[];
let faces: Face[];
let pages: Record<string, RoomMessage[]>;
/** A thread's messages and workers, by id, for the column beside the room. */
let threads: Record<string, ThreadMessage[]>;
let workersOf: Record<string, Worker[]>;
/** A room that looks writable but refuses a message (the archived 409). */
let refuseSend: boolean;

function reply(value: unknown, status = 200) {
  return new Response(value === undefined ? null : JSON.stringify(value), { status });
}

beforeEach(() => {
  FakeSocket.all = [];
  calls = [];
  refuseSend = false;
  listed = [room('general', { lastSeq: 1, readSeq: 1 }), room('topic')];
  pages = { general: [message('general', 1)], topic: [] };
  threads = {};
  workersOf = {};
  faces = [face('host', 'pirc'), face('face_pm', 'PM', { color: '#3366cc', bio: 'Runs SlimeOS' })];
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
        return reply({
          rooms: url.search === '?archived=1' ? listed : listed.filter((item) => !item.archivedAt),
          user: ME,
        });
      if (url.pathname === '/api/faces' && method === 'GET')
        return reply({
          faces,
          presence: faces.map((item) => ({ faceId: item.id, state: 'idle' })),
        });
      if (url.pathname === '/api/faces') {
        const made = face(`face_${body.name.toLowerCase()}`, body.name);
        faces.push(made);
        return reply({ face: made }, 201);
      }
      if (url.pathname.startsWith('/api/faces/') && method === 'PATCH') {
        const at = faces.findIndex((item) => item.id === id);
        const patch = { ...body };
        if ('hidden' in patch) patch.hiddenAt = patch.hidden ? 9 : null;
        delete patch.hidden;
        faces[at] = { ...faces[at]!, ...patch };
        return reply({ face: faces[at] });
      }
      if (url.pathname.endsWith('/activity')) return reply({ loops: [], workers: [], wakes: [] });
      if (url.pathname.startsWith('/api/threads/')) {
        const [threadId, , , again] = url.pathname.split('/').slice(3);
        if (again === 'messages' && method === 'POST')
          return reply({ message: {}, handed: { delegation: 'd1', as: 'user' } }, 201);
        if (again === 'answer')
          return reply({ interactionId: body.interactionId, status: 'answered' });
        return reply({
          thread: { id: threadId },
          messages: threads[threadId!] ?? [],
          workers: workersOf[threadId!] ?? [],
        });
      }
      const found = listed.find((item) => item.id === id);
      if (!found) return reply({ error: { code: 'not_found', message: 'Room not found' } }, 404);
      if (!rest && method === 'GET')
        return reply({
          room: found,
          pinned: (pages[id!] ?? []).filter((item) => item.pinnedAt),
        });
      if (!rest && method === 'PATCH') {
        Object.assign(found, body);
        if (body.archived === true) found.archivedAt = 5;
        if (body.archived === false) found.archivedAt = null;
        return reply({ room: found });
      }
      if (rest === 'messages' && method === 'POST' && refuseSend)
        return reply({ error: { code: 'archived', message: 'This room is archived.' } }, 409);
      if (rest === 'uploads' && method === 'POST')
        return reply({ upload: { id: `up_${url.searchParams.get('filename')}` } }, 201);
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

  it('knows where the host thinks, from the socket start and its events', async () => {
    const rooms = new RoomsState();
    await rooms.start();
    const socket = FakeSocket.all[0]!;
    socket.frame({
      type: 'ready',
      watermark: { epoch: 5, sequence: 3 },
      presence: [{ face: 'host', roomId: 'topic', state: 'thinking', since: 1 }],
    });
    expect(rooms.thinkingIn('topic')).toEqual(['host']);
    expect(rooms.thinkingIn('general')).toEqual([]);
    socket.frame({ ...event('brain_presence', 'general', { face: 'host', state: 'thinking' }, 0) });
    socket.frame({ ...event('brain_presence', 'topic', { face: 'host', state: 'idle' }, 0) });
    expect(rooms.thinkingIn('general')).toEqual(['host']);
    expect(rooms.thinkingIn('topic')).toEqual([]);
    // A new socket's start replaces what was known.
    socket.frame({ type: 'ready', watermark: { epoch: 5, sequence: 3 }, presence: [] });
    expect(rooms.thinkingIn('general')).toEqual([]);
    rooms.stop();
  });

  it('knows the faces and what each is doing', async () => {
    const rooms = new RoomsState();
    await rooms.start();
    expect(rooms.faces.map((item) => item.name)).toEqual(['pirc', 'PM']);
    expect(rooms.facePresence.face_pm?.state).toBe('idle');
    const socket = FakeSocket.all[0]!;
    socket.frame({
      type: 'ready',
      watermark: { epoch: 5, sequence: 3 },
      presence: [],
      faces: [{ faceId: 'face_pm', state: 'working', line: 'the PR', roomId: 'topic' }],
    });
    expect(rooms.facePresence.face_pm).toMatchObject({ state: 'working', line: 'the PR' });
    socket.frame(event('face_presence', 'topic', { faceId: 'face_pm', state: 'thinking' }, 0));
    expect(rooms.facePresence.face_pm?.state).toBe('thinking');
    socket.frame(event('face_changed', 'general', { face: face('face_pm', 'Lead') }, 4));
    socket.frame(event('face_changed', 'general', { face: face('face_ops', 'Ops') }, 5));
    expect(rooms.faces.map((item) => item.name)).toEqual(['pirc', 'Lead', 'Ops']);
    rooms.stop();
  });

  it('shows demo rooms, faces and a thread in dev when there is no gateway', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const rooms = new RoomsState();
    await rooms.start();
    expect(rooms.demo).toBeDefined();
    expect(rooms.error).toBe('');
    expect(rooms.rooms.map((item) => item.name)).toEqual(['SlimeOS', 'general']);
    expect(rooms.messages.map((item) => item.kind)).toEqual(['text', 'text', 'line']);
    expect(FakeSocket.all).toHaveLength(0);
    await rooms.open('room_slime');
    expect(rooms.messages.map((item) => item.kind)).toEqual([
      'text',
      'text',
      'text',
      'progress',
      'question',
    ]);
    await rooms.openThread('thr-1');
    expect(rooms.threadWorkers[0]?.targetSessionId).toBe('session-pwa');
    await rooms.send('hello');
    expect(rooms.messages[rooms.messages.length - 1]?.body.text).toBe('hello');
    expect(rooms.faces.map((item) => item.name)).toEqual(['pirc', 'SlimeOS PM']);
    rooms.stop();
    history.replaceState(null, '', '/?room=general');
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
    localStorage.clear();
    // jsdom has no modal dialogs.
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
    target = document.createElement('div');
    document.body.append(target);
  });
  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    target.remove();
    // Opening a room writes it into the address; the next test starts in #general.
    history.replaceState(null, '', '/?room=general');
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

  it('folds the archived rooms under the list', async () => {
    listed.push(room('old', { archivedAt: 5 }));
    await show();
    const names = () => [...target.querySelectorAll('.room-name')].map((item) => item.textContent);
    expect(names()).not.toContain('old');
    const fold = target.querySelector<HTMLButtonElement>('button.fold')!;
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fold.click();
    await vi.waitFor(() =>
      expect(target.querySelector('[aria-label="Archived rooms"]')?.textContent).toContain('old'),
    );
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(calls.some((call) => call.url === '/api/rooms?archived=1')).toBe(true);
  });

  it('mutes a room on this device, and unmutes it from Settings', async () => {
    await show();
    const bell = () =>
      target.querySelector<HTMLButtonElement>('button[aria-pressed][aria-label*="this room"]')!;
    expect(bell().getAttribute('aria-pressed')).toBe('false');
    bell().click();
    flushSync();
    expect(bell().getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('relay.muted-rooms')).toBe('["general"]');
    expect(target.querySelector('.room [aria-label="Muted"]')).not.toBeNull();
    // Settings from the list's foot, on its notifications.
    [...target.querySelectorAll<HTMLButtonElement>('.list-foot button')]
      .find((item) => item.textContent?.includes('Settings'))!
      .click();
    flushSync();
    const dialog = document.querySelector('dialog')!;
    [...dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((item) => item.textContent === 'Notifications')!
      .click();
    flushSync();
    const unmute = [...dialog.querySelectorAll<HTMLButtonElement>('.muted-rooms button')];
    expect(dialog.querySelector('.muted-rooms')!.textContent).toContain('#general');
    unmute[0]!.click();
    flushSync();
    expect(localStorage.getItem('relay.muted-rooms')).toBeNull();
    dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click();
    flushSync();
    await vi.waitFor(() => expect(bell().getAttribute('aria-pressed')).toBe('false'));
  });

  it('has bottom tabs for the phone: the rooms and what waits there, members, the engine', async () => {
    listed[1] = room('topic', { waiting: true });
    await show();
    const tabs = target.querySelector('nav[aria-label="Sections"]')!;
    expect(tabs.querySelector('a[href="/engine"]')?.textContent).toContain('Engine');
    expect(tabs.querySelector('[aria-label="1 waiting for you"]')).not.toBeNull();
    const tab = (label: string) =>
      [...tabs.querySelectorAll<HTMLButtonElement>('button.tab')].find((item) =>
        item.textContent?.includes(label),
      )!;
    tab('Members').click();
    flushSync();
    expect(target.querySelector('.members')).not.toBeNull();
    expect(tab('Members').getAttribute('aria-current')).toBe('page');
    tab('Rooms').click();
    flushSync();
    expect(target.querySelector('.rooms')!.classList.contains('list-open')).toBe(true);
    expect(target.querySelector('.members')).toBeNull();
    expect(tab('Rooms').getAttribute('aria-current')).toBe('page');
    tab('Settings').click();
    flushSync();
    expect(tab('Settings').getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('dialog #settings-title')).not.toBeNull();
  });

  it('moves through rooms and messages by keyboard, and says what others wrote', async () => {
    pages.general = [message('general', 1), message('general', 2, 'other', 'two')];
    const store = await show();
    // The room list: one tab stop, arrows move between rooms.
    const rows = () => [...target.querySelectorAll<HTMLButtonElement>('button.room')];
    expect(rows().map((row) => row.tabIndex)).toEqual([0, -1]);
    rows()[0]!.focus();
    rows()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(rows()[1]);
    // The log: a tab stop; arrows go through its messages, newest first.
    const log = target.querySelector<HTMLElement>('[role="log"]')!;
    expect(log.getAttribute('aria-live')).toBe('off');
    log.focus();
    log.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement?.textContent).toContain('two');
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
    );
    expect(document.activeElement?.textContent).toContain('m1');
    // A finished message from someone else is announced once; your own is not.
    const live = () => target.querySelector('p.sr-only[role="status"]')!.textContent;
    store.apply(
      event('room_message', 'general', { message: message('general', 3, 'other', 'hi') }),
    );
    await tick();
    expect(live()).toBe('other: hi');
    store.apply(event('room_message', 'general', { message: message('general', 4, ME, 'mine') }));
    await tick();
    expect(live()).toBe('other: hi');
    // Alt+ArrowDown opens the next room.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }));
    await vi.waitFor(() => expect(store.currentId).toBe('topic'));
  });

  it('closes the thread with Escape', async () => {
    const store = await show();
    void store.openThread('thr_1');
    await tick();
    expect(store.threadId).toBe('thr_1');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(store.threadId).toBeUndefined();
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

  it('keeps what was being written in each room, across room switches and reloads', async () => {
    await show();
    const box = () => target.querySelector('textarea')!;
    const roomButton = (name: string) =>
      [...target.querySelectorAll('.room-name')]
        .find((item) => item.textContent === name)!
        .closest('button')!;
    box().value = 'half a thought';
    box().dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    roomButton('topic').click();
    await vi.waitFor(() => expect(box().value).toBe(''));
    roomButton('general').click();
    await vi.waitFor(() => expect(box().value).toBe('half a thought'));
    unmount(component!);
    component = undefined;
    await show();
    expect(box().value).toBe('half a thought');
    box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    flushSync();
    expect(localStorage.getItem('relay.room-draft.general')).toBeNull();
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

  it('takes an image pasted into the composer, once, and lets words paste as words', async () => {
    await show();
    const box = target.querySelector('textarea')!;
    const attached = () =>
      [...target.querySelectorAll('.files .file-name')].map((item) => item.textContent?.trim());
    const paste = (files: File[], text = '') => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
          getData: (type: string) => (type === 'text/plain' ? text : ''),
        },
      });
      box.dispatchEvent(event);
      flushSync();
      return event;
    };
    const shot = new File([new Uint8Array([1, 2, 3])], 'shot.png', {
      type: 'image/png',
      lastModified: 1,
    });

    // An image alone becomes an attachment; there is no text for the textarea.
    const image = paste([shot]);
    expect(image.defaultPrevented).toBe(true);
    expect(attached()).toEqual(['shot.png']);
    // The same picture pasted again is a new File with a new timestamp: one attachment.
    paste([new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })]);
    expect(attached()).toEqual(['shot.png']);
    // A clipboard with words too (a copied page and its picture): both land,
    // and the words are the browser's to paste.
    const both = paste([shot], 'look at this');
    expect(both.defaultPrevented).toBe(false);
    // Nothing but words: left alone.
    const words = paste([], 'plain words');
    expect(words.defaultPrevented).toBe(false);
    expect(attached()).toEqual(['shot.png']);

    const diagram = new File([new Uint8Array([9, 9])], 'diagram.png', {
      type: 'image/png',
      lastModified: 2,
    });
    paste([diagram]);
    expect(attached()).toEqual(['shot.png', 'diagram.png']);

    box.value = 'have a look';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() =>
      expect(
        calls.filter((call) => call.method === 'POST' && call.url.endsWith('/messages')),
      ).toHaveLength(1),
    );
    const sent = calls.find((call) => call.method === 'POST' && call.url.endsWith('/messages'))!;
    expect(sent.body).toEqual({
      text: 'have a look',
      attachments: ['up_shot.png', 'up_diagram.png'],
      immediate: false,
    });
    await vi.waitFor(() => expect(attached()).toEqual([]));
  });

  it('renders what pirc and its workers write as Markdown, and your own words as typed', async () => {
    const store = await show();
    store.apply(
      event('room_message', 'general', {
        message: {
          ...message('general', 2, ME, 'unused'),
          id: 'host-2',
          speaker: 'face:host',
          user: null,
          body: {
            text: '**Fixed** the lint job:\n\n```ts\nconst x = 1;\n```\n\nSee apps/web/src/App.svelte.',
          },
        },
      }),
    );
    store.apply(
      event('room_message', 'general', {
        message: { ...message('general', 3, ME, 'use **stars** for emphasis'), id: 'mine-3' },
      }),
    );
    await tick();
    const host = () => target.querySelector('#message-host-2')!;
    expect(host().querySelector('.markdown strong')?.textContent).toBe('Fixed');
    expect(host().querySelector('.code-block code')?.textContent).toContain('const x = 1;');
    // There is no Files pane here: the path reads as code, not a dead link.
    expect(host().querySelector('a[data-file-link]')).toBeNull();
    expect(host().querySelector('code.file-path')?.textContent).toBe('apps/web/src/App.svelte');
    // Your own words are exactly as typed.
    const mine = target.querySelector('#message-mine-3')!;
    expect(mine.querySelector('.markdown')).toBeNull();
    expect(mine.textContent).toContain('use **stars** for emphasis');
  });

  it('shows the host thinking, its reply streaming in, and its questions', async () => {
    const store = await show();
    store.apply(event('brain_presence', 'general', { face: 'host', state: 'thinking' }, 0));
    await tick();
    // The layout phase drops the header's presence pill; the log still says it.
    expect(target.querySelector('.presence')).toBeNull();
    expect(target.querySelector('.typing')!.textContent).toContain('pirc is thinking…');
    const reply: RoomMessage = {
      ...message('general', 2, ME, 'Let me'),
      id: 'reply',
      speaker: 'face:host',
      user: null,
      body: { text: 'Let me', streaming: true },
    };
    store.apply(event('room_message', 'general', { message: reply }));
    await tick();
    const article = () => target.querySelector('article[aria-busy="true"]');
    expect(article()?.textContent).toContain('Let me');
    // A face's reply streams in as Markdown, with its own caret.
    expect(article()?.querySelector('.markdown.streaming')).not.toBeNull();
    store.apply(
      event('room_message_updated', 'general', {
        message: { ...reply, body: { text: 'Let me check.' } },
      }),
    );
    store.apply(event('brain_presence', 'general', { face: 'host', state: 'idle' }, 0));
    await tick();
    expect(article()).toBeNull();
    expect(target.querySelector('.markdown.streaming')).toBeNull();
    expect(target.textContent).toContain('Let me check.');
    expect(target.querySelector('.typing')!.textContent).not.toContain('is thinking');
    store.apply(
      event('room_message', 'general', {
        message: { ...reply, id: 'q', seq: 3, kind: 'question', body: { text: 'Which one?' } },
      }),
    );
    await tick();
    const question = target.querySelector('article.question')!;
    expect(question.getAttribute('aria-label')).toMatch(/^pirc asks/);
  });

  it('shows a worker’s progress on its anchor, and a waiting question above the composer', async () => {
    const store = await show();
    const anchor: RoomMessage = {
      ...message('general', 2, ME, 'Fix lint'),
      id: 'anchor',
      speaker: 'face:host',
      user: null,
      threadId: 'thr_1',
      body: {
        text: 'Fix lint',
        worker: {
          delegationId: 'dlg_1',
          threadId: 'thr_1',
          status: 'running',
          title: 'Fix lint',
          workspace: 'slimeos',
          workers: 1,
          readOnly: false,
          note: null,
        },
      },
    };
    store.apply(event('room_message', 'general', { message: anchor }));
    const tool = (seq: number, summary: string) => ({
      threadId: 'thr_1',
      message: {
        id: `tm_${seq}`,
        threadId: 'thr_1',
        seq,
        speaker: 'worker:s1',
        user: null,
        kind: 'tool',
        body: { tool: 'bash', summary },
        depth: 0,
        createdAt: 100 + seq,
        updatedAt: null,
      },
    });
    store.apply(event('thread_message', 'general', tool(1, 'bun install')));
    store.apply(event('thread_message', 'general', tool(2, 'bun run lint')));
    await tick();
    expect(target.querySelector('#message-anchor .progress')?.textContent).toBe('bun run lint');
    // Done: the anchor says so instead.
    store.apply(
      event('room_message_updated', 'general', {
        message: {
          ...anchor,
          body: { ...anchor.body, worker: { ...anchor.body.worker!, status: 'completed' } },
        },
      }),
    );
    await tick();
    expect(target.querySelector('#message-anchor .progress')).toBeNull();

    expect(target.querySelector('.asking')).toBeNull();
    const asked: RoomMessage = {
      ...anchor,
      id: 'ask',
      seq: 3,
      kind: 'question',
      body: {
        text: 'May it push?',
        worker: { delegationId: 'dlg_1', threadId: 'thr_1', event: 'question' },
        question: {
          interactionId: 'i1',
          threadMessageId: 'tm_3',
          request: { title: 'git push' },
          status: 'pending',
        },
      },
    };
    store.apply(event('room_message', 'general', { message: asked }));
    await tick();
    expect(target.querySelector('.asking')?.textContent).toContain(
      'pirc is waiting for your answer: git push',
    );
    store.apply(
      event('room_message_updated', 'general', {
        message: {
          ...asked,
          body: { ...asked.body, question: { ...asked.body.question!, status: 'answered' } },
        },
      }),
    );
    await tick();
    expect(target.querySelector('.asking')).toBeNull();
  });

  it('shows a progress message as a line that changes in place', async () => {
    const store = await show();
    const progress: RoomMessage = {
      ...message('general', 2, ME, 'Reading the inbox…'),
      id: 'p',
      speaker: 'face:host',
      user: null,
      kind: 'progress',
    };
    store.apply(event('room_message', 'general', { message: progress }));
    await tick();
    expect(target.querySelector('.progress-line')?.textContent).toContain('Reading the inbox…');
    store.apply(
      event('room_message_updated', 'general', {
        message: { ...progress, body: { text: 'Read 12 mails' } },
      }),
    );
    await tick();
    expect(target.querySelectorAll('.progress-line')).toHaveLength(1);
    expect(target.querySelector('.progress-line')?.textContent).toContain('Read 12 mails');
  });

  it('names the face that spoke, and opens its profile page', async () => {
    pages.general = [
      message('general', 1),
      { ...message('general', 2, ME, 'Two reviews left.'), speaker: 'face:face_pm', user: null },
    ];
    await show();
    await vi.waitFor(() => expect(target.textContent).toContain('Two reviews left.'));
    const name = target.querySelector<HTMLButtonElement>('article button.face-name')!;
    expect(name.textContent).toBe('PM');
    name.click();
    await vi.waitFor(() =>
      expect(target.querySelector('[aria-label="PM\'s page"]')).not.toBeNull(),
    );
    const page = target.querySelector('.face-page')!;
    // The profile the design draws: hero, avatar, name, badge, bio and actions.
    // The avatar is the name's first letter, as everywhere in the rooms.
    expect(page.querySelector('.hero .portrait')?.textContent).toBe('P');
    expect(page.querySelector('.hero .presence')).not.toBeNull();
    expect(page.querySelector('h2')?.textContent).toBe('PM');
    expect(page.querySelector('.badge')?.textContent).toBe('Project');
    expect(page.querySelector('.bio')?.textContent).toBe('Runs SlimeOS');
    expect(page.querySelector('.actions .mention')?.textContent).toBe('Mention in room');
    expect(page.querySelector('.actions .edit')?.textContent).toBe('Edit');
    // Read-only cards, no always-on fields (the person's decision).
    expect(page.querySelector('.face-page form')).toBeNull();
    expect(page.querySelector('.card .territory')).not.toBeNull();
    // Everything editable is behind Edit.
    page.querySelector<HTMLButtonElement>('.actions .edit')!.click();
    await tick();
    const bio = target.querySelector<HTMLTextAreaElement>('.face-page textarea')!;
    expect(bio.value).toBe('Runs SlimeOS');
    bio.value = 'Runs SlimeOS and its releases';
    bio.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    target.querySelector<HTMLFormElement>('.face-page form')!.requestSubmit();
    await vi.waitFor(() =>
      expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
        bio: 'Runs SlimeOS and its releases',
      }),
    );
  });

  it('lists the members, greys out an archived face and hides it', async () => {
    faces.push(face('face_old', 'Old', { archivedAt: 5 }));
    await show();
    target.querySelector<HTMLButtonElement>('button[aria-label="Members"]')!.click();
    await tick();
    const members = () =>
      [...target.querySelectorAll('.members li')].map((item) => ({
        name: item.querySelector('.name')!.textContent,
        archived: item.classList.contains('archived'),
      }));
    expect(members()).toEqual([
      { name: 'pirc', archived: false },
      { name: 'PM', archived: false },
      { name: 'Old', archived: true },
    ]);
    const hide = [...target.querySelectorAll<HTMLButtonElement>('.members li button')].find(
      (button) => button.textContent === 'Hide',
    )!;
    hide.click();
    await vi.waitFor(() => expect(members()).toHaveLength(2));
    expect(calls.find((call) => call.method === 'PATCH')).toMatchObject({
      url: '/api/faces/face_old',
      body: { hidden: true },
    });
    expect(target.textContent).toContain('Show hidden (1)');
  });

  it('completes @ with a face’s name', async () => {
    await show();
    await vi.waitFor(() => expect(target.textContent).toContain('m1'));
    const box = target.querySelector('textarea')!;
    box.value = 'hi @p';
    box.setSelectionRange(5, 5);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    const options = () =>
      [...target.querySelectorAll('[role="option"]')].map((item) => item.textContent);
    expect(options()).toEqual(['@pirc', '@PMRuns SlimeOS']);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    flushSync();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    expect(box.value).toBe('hi @PM ');
    expect(options()).toEqual([]);
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/messages'))).toBe(
      false,
    );
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

  it('lists unread as a red count with a rail, and counts the archived rooms', async () => {
    listed[1] = room('topic', { lastActivityAt: 5, lastSeq: 2, unread: 2 });
    listed.push(room('old', { archivedAt: 5 }));
    await show();
    const count = target.querySelector('.room.unread .count')!;
    expect(count.textContent).toBe('2');
    expect(count.getAttribute('aria-label')).toBe('2 unread');
    expect(target.querySelector('.room.unread .rail')).not.toBeNull();
    // The fold knows how many there are without opening it.
    await vi.waitFor(() =>
      expect(target.querySelector('button.fold')?.textContent).toContain('Archived · 1'),
    );
    // The header's subtitle names the kind of room, and nothing it does not know.
    expect(target.querySelector('.room-head .subtitle')?.textContent).toContain('General room');
  });

  it('searches the messages already loaded, without asking the gateway', async () => {
    pages.general = [
      message('general', 1),
      message('general', 2, 'other', 'bench numbers'),
      message('general', 3, 'other', 'lint one'),
      message('general', 4, 'other', 'lint two'),
    ];
    await show();
    const search = target.querySelector<HTMLInputElement>('input[type="search"]')!;
    const type = (value: string) => {
      search.value = value;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      flushSync();
    };
    const said = () =>
      [...target.querySelectorAll('article .content')].map((item) => item.textContent ?? '');
    type('lint');
    expect(said()).toHaveLength(2);
    expect(said().join(' ')).not.toContain('bench');
    expect(target.querySelector('.search-note')?.textContent).toContain('2 matches');
    // Client-side only: no request carries what was typed.
    expect(calls.some((call) => call.url.includes('lint'))).toBe(false);
    type('nothing like this');
    expect(said()).toHaveLength(0);
    expect(target.querySelector('.search-note')?.textContent).toBe('Nothing matches here.');
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(search.value).toBe('');
    expect(said()).toHaveLength(4);
  });

  it('keeps three attachments and counts the rest', async () => {
    await show();
    const box = target.querySelector('textarea')!;
    const paste = (file: File) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
          getData: () => '',
        },
      });
      box.dispatchEvent(event);
      flushSync();
    };
    const names = () =>
      [...target.querySelectorAll('.files .file-name')].map((item) => item.textContent);
    for (const name of ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'])
      paste(new File([new Uint8Array([1])], name, { type: 'image/png', lastModified: 1 }));
    expect(names()).toEqual(['a.png', 'b.png', 'c.png']);
    const more = () => target.querySelector('.files .more');
    expect(more()?.querySelector('span')?.textContent).toBe('+2');
    expect(more()?.querySelector('.sr-only')?.textContent).toBe('2 more attachments');
    target.querySelector<HTMLButtonElement>('.files li button')!.click();
    await tick();
    expect(names()).toEqual(['b.png', 'c.png', 'd.png']);
    expect(more()?.querySelector('span')?.textContent).toBe('+1');
  });

  it('asks in a warning card, with the request in mono and every answer', async () => {
    const store = await show();
    const asked: RoomMessage = {
      ...message('general', 2, ME),
      id: 'ask',
      speaker: 'face:host',
      user: null,
      kind: 'question',
      threadId: 'thr_1',
      body: {
        text: 'May the worker push?',
        question: {
          interactionId: 'i1',
          threadMessageId: 'tm_3',
          request: { title: 'git push origin fix-lint', allowAgain: true },
          status: 'pending',
        },
      },
    };
    store.apply(event('room_message', 'general', { message: asked }));
    await tick();
    const card = target.querySelector('article.question')!;
    expect(card.querySelector('.asks')?.textContent).toBe('asks you');
    expect(card.querySelector('code.request')?.textContent).toBe('git push origin fix-lint');
    expect([...card.querySelectorAll('.choices button')].map((item) => item.textContent)).toEqual([
      'Yes',
      'Allow again this session',
      'No',
      'Thread',
    ]);
    // The fourth answer, in words: the composer already is it.
    expect(card.querySelector('.reply-note')?.textContent).toBe('or just reply');
  });

  it('replaces an archived room’s composer with the banner, and unarchives it there', async () => {
    listed.push(room('old', { archivedAt: 9 }));
    pages.old = [message('old', 1, 'other', 'kept')];
    const store = await show();
    await store.open('old');
    await tick();
    const banner = target.querySelector('.read-only')!;
    expect(banner.textContent).toContain('This room is archived.');
    expect(target.querySelector('textarea')).toBeNull();
    banner.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() =>
      expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ archived: false }),
    );
    await vi.waitFor(() => expect(store.current?.archivedAt).toBeNull());
    await vi.waitFor(() => expect(target.querySelector('textarea')).not.toBeNull());
  });

  it('turns a send the gateway refuses (409) into the same banner', async () => {
    await show();
    refuseSend = true;
    const box = target.querySelector('textarea')!;
    box.value = 'hello';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(target.querySelector('.read-only')).not.toBeNull());
    expect(target.querySelector('textarea')).toBeNull();
    expect(target.querySelector('.read-only')?.textContent).toContain('Unarchive');
  });

  it('marks where a day starts and where the unread messages begin', async () => {
    pages.general = [message('general', 1), message('general', 2, 'other', 'm1 unread')];
    await show();
    expect(target.querySelector('.day')).not.toBeNull();
    const divider = target.querySelector('.new')!;
    expect(divider.textContent).toContain('New');
    expect(divider.getAttribute('aria-label')).toBe('Unread messages start here');
    // It sits between the read message and the unread one.
    const order = [
      ...target.querySelectorAll('.messages > .day, .messages > .new, .messages > article'),
    ];
    expect(order.indexOf(divider)).toBeGreaterThan(
      order.findIndex((item) => item.id === 'message-general-1'),
    );
  });

  it('groups the members by what they are doing, and opens a face page on click', async () => {
    faces.push(face('face_ops', '學校助理', { color: '#5b3a8a' }));
    const store = await show();
    store.setFacePresence([
      { faceId: 'host', state: 'idle' },
      { faceId: 'face_pm', state: 'waiting', roomId: 'general', line: 'git push origin fix-lint' },
      { faceId: 'face_ops', state: 'working', roomId: 'topic', line: 'reading Moodle' },
    ]);
    await tick();
    target.querySelector<HTMLButtonElement>('button[aria-label="Members"]')!.click();
    await tick();
    const groups = [...target.querySelectorAll('.members section')].map((section) => ({
      label: section.querySelector('h3')!.textContent,
      names: [...section.querySelectorAll('.name')].map((item) => item.textContent),
    }));
    expect(groups).toEqual([
      { label: 'Waiting for you — 1', names: ['PM'] },
      { label: 'Idle — 1', names: ['pirc'] },
      { label: 'In other rooms — 1', names: ['學校助理'] },
    ]);
    const text = target.querySelector('.members')!.textContent;
    expect(text).toContain('Waiting · git push origin fix-lint');
    expect(text).toContain('#topic · Working · reading Moodle');
    // The rows carry no add or hide control (the person's decision keeps the
    // add and the hidden toggle in the column's own menu).
    expect(target.querySelector('.members li .small')).toBeNull();
    target.querySelector<HTMLButtonElement>('.members li .face')!.click();
    await vi.waitFor(() =>
      expect(target.querySelector('[aria-label="PM\'s page"]')).not.toBeNull(),
    );
  });

  it('opens the room’s threads and its pins beside the log', async () => {
    pages.general = [
      message('general', 1),
      { ...message('general', 2, ME, 'kept one'), pinnedAt: 5 },
    ];
    const store = await show();
    const anchor: RoomMessage = {
      ...message('general', 3, ME, 'Fix lint'),
      id: 'anchor',
      speaker: 'face:host',
      user: null,
      threadId: 'thr_1',
      body: {
        text: 'Fix lint',
        worker: {
          delegationId: 'dlg_1',
          threadId: 'thr_1',
          status: 'running',
          title: 'Fix the lint job',
          workspace: 'slimeos',
          workers: 3,
          readOnly: false,
          note: null,
        },
      },
    };
    store.apply(event('room_message', 'general', { message: anchor }));
    await tick();
    // The anchor is a thread card: its title, status, workers and thread.
    const card = target.querySelector('#message-anchor .thread-card')!;
    expect(card.textContent).toContain('Fix the lint job');
    expect(card.textContent).toContain('Working (3)');
    target.querySelector<HTMLButtonElement>('button[aria-label="Threads"]')!.click();
    await tick();
    const threads = target.querySelector('aside.panel[aria-label="Threads"]')!;
    expect(threads.textContent).toContain('Fix the lint job');
    expect(threads.textContent).toContain('No word yet');
    target.querySelector<HTMLButtonElement>('button[aria-label="Pinned"]')!.click();
    await tick();
    const pins = target.querySelector('aside.panel[aria-label="Pinned"]')!;
    expect(pins.textContent).toContain('kept one');
    // An empty panel says so rather than showing nothing.
    expect(target.querySelector('aside.panel[aria-label="Threads"]')).toBeNull();
  });

  it('opens a worker’s thread beside the room, with its tree and its tool calls', async () => {
    const anchor: RoomMessage = {
      ...message('general', 2, ME, 'Fix lint'),
      id: 'anchor',
      speaker: 'face:face_pm',
      user: null,
      threadId: 'thr_1',
      body: {
        text: 'Fix lint',
        worker: {
          delegationId: 'dlg_1',
          threadId: 'thr_1',
          status: 'running',
          title: 'Fix the lint job',
          workspace: 'slimeos',
          workers: 2,
          readOnly: false,
          note: null,
        },
      },
    };
    threads.thr_1 = [
      threadMessage(
        1,
        'worker:session_1',
        { tool: 'bash', summary: 'cargo clippy --all-targets' },
        { kind: 'tool' },
      ),
      threadMessage(
        2,
        'worker:session_1/reviewer',
        { text: 'Looks fine.', team: 'result' },
        {
          depth: 1,
        },
      ),
    ];
    workersOf.thr_1 = [workerRecord()];
    const store = await show();
    store.apply(event('room_message', 'general', { message: anchor }));
    await tick();
    target.querySelector<HTMLButtonElement>('#message-anchor .thread-card .open')!.click();
    await vi.waitFor(() =>
      expect(target.querySelectorAll('aside.thread .worker-row')).toHaveLength(2),
    );
    const panel = target.querySelector('aside.thread')!;
    expect(panel.getAttribute('aria-label')).toBe('Thread: Fix the lint job');
    expect(panel.querySelector('h2')!.textContent).toBe('Fix the lint job');
    // Where it came from, and what it is doing, in the header.
    expect(panel.querySelector('.from')!.textContent).toContain('from PM');
    expect(panel.querySelector('.from')!.textContent).toContain('slimeos');
    expect(panel.querySelector('.from .state')!.textContent).toContain('Working');
    // The worker strip: the worker, then its teammate indented under it.
    const rows = [...panel.querySelectorAll('.worker-row')].map((row) => ({
      name: row.querySelector('.worker-name')!.textContent,
      state: row.querySelector('.worker-state')!.textContent,
      child: row.classList.contains('child'),
    }));
    expect(rows).toEqual([
      { name: 'worker', state: 'Working · cargo clippy --all-targets', child: false },
      { name: 'reviewer', state: 'Done · Looks fine.', child: true },
    ]);
    // A tool call is a chip: the tool in words, its line in mono.
    const chip = panel.querySelector('.tool-chip')!;
    expect(chip.querySelector('.tool-name')!.textContent).toBe('bash');
    expect(chip.querySelector('code')!.textContent).toBe('cargo clippy --all-targets');
    // A teammate's reply says whom it answers.
    expect(panel.querySelector('li.item.child .parent')!.textContent).toBe('↳ worker');
    // The card in the log is the one open: ringed, and its row tinted.
    expect(target.querySelector('#message-anchor .thread-card.current')).not.toBeNull();
    expect(target.querySelector('#message-anchor')!.classList.contains('selected')).toBe(true);
    // The reply box is always there, in the design's words.
    expect(panel.querySelector<HTMLInputElement>('form.composer input')!.placeholder).toBe(
      'Jump in — the workers will see it',
    );
    // Escape closes it, and the card is no longer the open one.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(store.threadId).toBeUndefined();
    expect(target.querySelector('#message-anchor .thread-card.current')).toBeNull();
  });

  it('mentions a face from its page: the room opens with @name and nothing is sent', async () => {
    faces[1] = face('face_pm', 'PM', {
      territory: { rooms: ['topic'], workspaces: [], sources: [] },
    });
    pages.topic = [message('topic', 1, 'other', 'in topic')];
    const store = await show();
    target.querySelector<HTMLButtonElement>('button[aria-label="Members"]')!.click();
    await tick();
    const pm = [...target.querySelectorAll<HTMLButtonElement>('.members li button.face')].find(
      (row) => row.textContent?.includes('PM'),
    )!;
    pm.click();
    await vi.waitFor(() =>
      expect(target.querySelector('.face-page .actions .mention')).not.toBeNull(),
    );
    target.querySelector<HTMLButtonElement>('.face-page .actions .mention')!.click();
    // The room it answers in opens, with its name ready in the composer.
    await vi.waitFor(() => expect(store.currentId).toBe('topic'));
    const box = target.querySelector<HTMLTextAreaElement>('.composer textarea')!;
    await vi.waitFor(() => expect(box.value).toBe('@PM '));
    expect(target.querySelector('.face-page')).toBeNull();
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/messages'))).toBe(
      false,
    );
  });

  it('reaches the room list from the phone’s header, and threads and pins from its room menu', async () => {
    await show();
    const menu = target.querySelector<HTMLButtonElement>('button.list-btn')!;
    expect(menu.getAttribute('aria-label')).toBe('Open the room list');
    menu.click();
    flushSync();
    expect(target.querySelector('.rooms')!.classList.contains('list-open')).toBe(true);
    // The other controls the design drops from the phone header live here.
    const head = target.querySelector<HTMLElement>('.head-menu')!;
    const entries = [...head.querySelectorAll<HTMLButtonElement>('.phone-only .pop-row')].map(
      (row) => row.textContent?.trim(),
    );
    expect(entries).toEqual(['Threads', 'Pinned']);
    expect(head.querySelector('input.menu-search')).not.toBeNull();
    head.querySelector<HTMLButtonElement>('.phone-only .pop-row')!.click();
    flushSync();
    expect(target.querySelector('aside.panel[aria-label="Threads"]')).not.toBeNull();
    expect(head.hasAttribute('open')).toBe(false);
  });

  it('keeps no "Continue in another room" control in the room menu', async () => {
    // The menu carried a move select until the person found it useless. The
    // gateway still moves a room's loops (its move_room tool, "Continued in"
    // rows); only the manual control is gone.
    await show();
    const head = target.querySelector<HTMLElement>('.head-menu')!;
    expect(head.querySelector('select')).toBeNull();
    expect(head.textContent).not.toContain('Continue in');
  });

  it('takes files dropped on the composer, and highlights where they land', async () => {
    await show();
    const form = target.querySelector<HTMLFormElement>('.composer')!;
    const shot = new File([new Uint8Array([1, 2, 3])], 'dropped.png', { type: 'image/png' });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [shot], types: ['Files'] } });
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(over, 'dataTransfer', { value: { files: [], types: ['Files'] } });
    form.dispatchEvent(over);
    flushSync();
    expect(over.defaultPrevented).toBe(true);
    expect(form.classList.contains('dragging')).toBe(true);
    form.dispatchEvent(drop);
    flushSync();
    expect(drop.defaultPrevented).toBe(true);
    expect(form.classList.contains('dragging')).toBe(false);
    expect(
      [...target.querySelectorAll('.files .file-name')].map((item) => item.textContent),
    ).toEqual(['dropped.png']);
  });
});
