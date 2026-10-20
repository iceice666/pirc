/**
 * What the rooms page shows (plans/rewrite/01-rooms.md): the room list in
 * activity order with unread counts, the open room's messages, who is
 * typing, and the live stream that keeps them current on every device.
 */
import { ApiError } from './http';
import {
  connectRooms,
  roomsApi,
  type FacePresence,
  type Room,
  type RoomEvent,
  type RoomMessage,
  type RoomStream,
  type RoomView,
  type RoomsConnection,
} from './rooms';

/** Messages per page. */
export const ROOM_PAGE = 50;
/** At most one typing signal this often (the gateway's signals last 6 s). */
export const TYPING_THROTTLE_MS = 3_000;

const byActivity = (a: RoomView, b: RoomView) =>
  b.lastActivityAt - a.lastActivityAt || b.createdAt - a.createdAt;

export class RoomsState {
  rooms = $state<RoomView[]>([]);
  /** The asking user (the gateway says who): their own messages are read. */
  user = $state('');
  currentId = $state<string>('general');
  /** The open room when it is not in the list (archived, opened by URL). */
  #detached = $state<RoomView | undefined>();
  messages = $state<RoomMessage[]>([]);
  pinned = $state<RoomMessage[]>([]);
  hasMore = $state(false);
  loading = $state(true);
  error = $state('');
  connection = $state<RoomsConnection>('connecting');
  /** Others typing in each room: user → when their signal lapses. */
  typing = $state<Record<string, Record<string, number>>>({});
  /** Faces thinking in each room now: room → face ids (plan 02: the host). */
  thinking = $state<Record<string, string[]>>({});
  /** Bumped whenever an open loop changes (plan 04), for lists that show them. */
  loopsRevision = $state(0);
  /** Bumped whenever a wake changes (plan 05), for lists that show them. */
  wakesRevision = $state(0);

  #stream: RoomStream | undefined;
  #lastTyping = 0;
  #loadToken = 0;

  current = $derived<RoomView | undefined>(
    this.rooms.find((room) => room.id === this.currentId) ?? this.#detached,
  );

  /** Load the list and the room the address names, then follow the stream. */
  async start(roomId = roomFromUrl()) {
    this.currentId = roomId ?? 'general';
    await this.reload();
    this.#stream = connectRooms({
      onEvent: (event) => this.apply(event),
      onReset: () => void this.reload(),
      onState: (state) => (this.connection = state),
      onPresence: (presence) => this.setPresence(presence),
    });
  }

  stop() {
    this.#stream?.close();
    this.#stream = undefined;
  }

  async reload() {
    try {
      const { rooms, user } = await roomsApi.list();
      this.rooms = rooms.sort(byActivity);
      this.user = user;
      this.error = '';
      await this.open(this.currentId, { address: false });
    } catch (error) {
      this.error = message(error, 'Unable to load rooms.');
    } finally {
      this.loading = false;
    }
  }

  /** Show a room: its latest messages, and read them. */
  async open(roomId: string, { address = true } = {}) {
    const token = ++this.#loadToken;
    this.currentId = roomId;
    if (address) setRoomInUrl(roomId);
    try {
      const [{ room, pinned }, page] = await Promise.all([
        roomsApi.get(roomId),
        roomsApi.messages(roomId, undefined, ROOM_PAGE),
      ]);
      if (token !== this.#loadToken) return;
      this.#detached = this.rooms.some((item) => item.id === room.id) ? undefined : room;
      this.#merge(room);
      this.pinned = pinned;
      this.messages = page.messages;
      this.hasMore = page.hasMore;
      this.error = '';
      void this.markRead();
    } catch (error) {
      if (token !== this.#loadToken) return;
      this.messages = [];
      this.error =
        error instanceof ApiError && error.status === 404
          ? 'This room does not exist.'
          : message(error, 'Unable to open the room.');
    }
  }

  async loadOlder() {
    const first = this.messages[0];
    if (!first || !this.hasMore) return;
    const roomId = this.currentId;
    const page = await roomsApi.messages(roomId, first.seq, ROOM_PAGE);
    if (roomId !== this.currentId) return;
    const known = new Set(this.messages.map((item) => item.id));
    this.messages = [...page.messages.filter((item) => !known.has(item.id)), ...this.messages];
    this.hasMore = page.hasMore;
  }

  /**
   * Send at once: stored and shown everywhere straight away. `immediate`
   * (Cmd+Enter) asks the brain not to wait for more (plan 02).
   */
  async send(text: string, { immediate = false, files = [] as File[] } = {}) {
    const roomId = this.currentId;
    const uploads = [];
    for (const file of files) uploads.push((await roomsApi.upload(roomId, file)).upload.id);
    const { message } = await roomsApi.send(roomId, text, uploads, immediate);
    this.#append(message);
    this.#lastTyping = 0;
  }

  /** A keystroke in the composer: tell the others, at most every 3 s. */
  keystroke(now = Date.now()) {
    if (now - this.#lastTyping < TYPING_THROTTLE_MS) return;
    this.#lastTyping = now;
    void roomsApi.typing(this.currentId).catch(() => {});
  }

  /** Read the open room up to its newest message, if the page is visible. */
  async markRead() {
    const room = this.current;
    if (!room || room.readSeq >= room.lastSeq) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    try {
      const { room: read } = await roomsApi.read(room.id, room.lastSeq);
      this.#merge(read);
    } catch {
      // The next look tries again.
    }
  }

  async createRoom(name: string) {
    const { room } = await roomsApi.create(name);
    await this.#refreshList();
    await this.open(room.id);
  }

  async setArchived(roomId: string, archived: boolean) {
    const { room } = await roomsApi.update(roomId, { archived });
    await this.#refreshList();
    if (roomId === this.currentId)
      this.#detached = this.rooms.some((item) => item.id === roomId) ? undefined : room;
  }

  async rename(roomId: string, name: string) {
    const { room } = await roomsApi.update(roomId, { name });
    this.#merge(room);
  }

  async moveTo(toRoomId: string) {
    await roomsApi.move(this.currentId, toRoomId);
    await this.open(toRoomId);
  }

  async pin(message: RoomMessage, pinned: boolean) {
    const { message: updated } = await roomsApi.pin(message.roomId, message.id, pinned);
    this.#replace(updated);
  }

  /** Who else is typing in a room right now. */
  typingIn(roomId: string, now = Date.now()): string[] {
    return Object.entries(this.typing[roomId] ?? {})
      .filter(([user, until]) => user !== this.user && until > now)
      .map(([user]) => user);
  }

  /** Which faces think in a room right now. */
  thinkingIn(roomId: string): string[] {
    return this.thinking[roomId] ?? [];
  }

  /** Where faces think as the stream (re)starts. */
  setPresence(presence: FacePresence[]) {
    const thinking: Record<string, string[]> = {};
    for (const { face, roomId } of presence) thinking[roomId] = [...(thinking[roomId] ?? []), face];
    this.thinking = thinking;
  }

  /** One event of the stream. */
  apply(event: RoomEvent) {
    switch (event.type) {
      case 'brain_presence': {
        const { face, state } = event.data;
        const others = this.thinkingIn(event.roomId).filter((item) => item !== face);
        this.thinking = {
          ...this.thinking,
          [event.roomId]: state === 'thinking' ? [...others, face] : others,
        };
        break;
      }
      case 'room_message': {
        const message: RoomMessage = event.data.message;
        if (message.roomId === this.currentId) this.#append(message);
        const mine = message.speaker === 'user' && message.user === this.user;
        if (!mine) this.#bump(message.roomId, message.seq);
        if (message.speaker === 'user' && message.user)
          this.#stopTyping(message.roomId, message.user);
        if (message.roomId === this.currentId) void this.markRead();
        break;
      }
      case 'room_message_updated':
        this.#replace(event.data.message);
        break;
      case 'loop_changed':
        this.loopsRevision++;
        break;
      case 'wake_changed':
        this.wakesRevision++;
        break;
      case 'room_changed': {
        const room: Room = event.data.room;
        if (!this.rooms.some((item) => item.id === room.id) && !room.archivedAt)
          void this.#refreshList();
        else this.#merge(room);
        break;
      }
      case 'room_read': {
        if (event.data.user !== this.user) break;
        const room = this.rooms.find((item) => item.id === event.roomId);
        // Another device read it: the count is the gateway's to say.
        if (room && event.data.readSeq > room.readSeq) void this.#refreshRoom(room.id);
        break;
      }
      case 'room_typing': {
        const { user, expiresAt } = event.data;
        this.typing = {
          ...this.typing,
          [event.roomId]: { ...this.typing[event.roomId], [user]: expiresAt },
        };
        break;
      }
    }
  }

  #append(message: RoomMessage) {
    if (this.messages.some((item) => item.id === message.id)) return;
    const last = this.messages[this.messages.length - 1];
    this.messages =
      !last || message.seq > last.seq
        ? [...this.messages, message]
        : [...this.messages, message].sort((a, b) => a.seq - b.seq);
  }

  #replace(message: RoomMessage) {
    this.messages = this.messages.map((item) => (item.id === message.id ? message : item));
    const pinned = this.pinned.filter((item) => item.id !== message.id);
    this.pinned =
      message.pinnedAt && message.roomId === this.currentId ? [...pinned, message] : pinned;
  }

  /** Someone else's new message: unread until read. A replayed one counts once. */
  #bump(roomId: string, seq: number) {
    this.rooms = this.rooms.map((room) =>
      room.id === roomId && seq > room.readSeq && seq > room.lastSeq
        ? { ...room, unread: room.unread + 1, lastSeq: seq }
        : room,
    );
  }

  #stopTyping(roomId: string, user: string) {
    const { [user]: _gone, ...rest } = this.typing[roomId] ?? {};
    this.typing = { ...this.typing, [roomId]: rest };
  }

  /** A room's shared fields changed: keep the user's own (reads, unread). */
  #merge(room: Room | RoomView) {
    const keep = (old: RoomView): RoomView => ({ ...old, ...room });
    if (this.rooms.some((item) => item.id === room.id)) {
      this.rooms = this.rooms
        .map((item) => (item.id === room.id ? keep(item) : item))
        .filter((item) => !item.archivedAt || item.id === this.currentId)
        .sort(byActivity);
    }
    if (this.#detached?.id === room.id) this.#detached = keep(this.#detached);
  }

  async #refreshRoom(roomId: string) {
    try {
      const { room } = await roomsApi.get(roomId);
      this.#merge(room);
    } catch {
      // The list reloads on the next reset.
    }
  }

  async #refreshList() {
    const { rooms } = await roomsApi.list();
    this.rooms = rooms.sort(byActivity);
  }
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** `?room=<id>` names the room to open. */
export function roomFromUrl(url = new URL(location.href)): string | undefined {
  const room = url.searchParams.get('room');
  return room && room.length <= 100 ? room : undefined;
}

function setRoomInUrl(roomId: string) {
  if (typeof history === 'undefined') return;
  const url = new URL(location.href);
  url.searchParams.set('room', roomId);
  history.replaceState(history.state, '', url.pathname + url.search);
}

export const rooms = new RoomsState();
