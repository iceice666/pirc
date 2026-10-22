/**
 * What the rooms page shows (plans/rewrite/01-rooms.md): the room list in
 * activity order with unread counts, the open room's messages, who is
 * typing, and the live stream that keeps them current on every device.
 */
import { facesApi, type Face, type FaceInput, type FacePresence as FaceState } from './faces';
import { ApiError } from './http';
import {
  appendMessage,
  byActivity,
  facePresenceFrom,
  mergeRoom,
  reduceRoomEvent,
  replaceMessage,
  thinkingFrom,
  upsertFace,
  type RoomEffect,
  type RoomsView,
  type ThreadActivity,
} from './room-events';
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
import { workersApi, type ThreadMessage, type Worker } from './workers';

/** Messages per page. */
export const ROOM_PAGE = 50;
/** At most one typing signal this often (the gateway's signals last 6 s). */
export const TYPING_THROTTLE_MS = 3_000;

export class RoomsState {
  // Raw state: the reducer (room-events.ts) never mutates, it replaces whole
  // values, so deep proxies would only cost.
  rooms = $state.raw<RoomView[]>([]);
  /** Archived rooms, once the list's fold is opened. */
  archived = $state.raw<RoomView[]>([]);
  #archivedLoaded = false;
  /** The asking user (the gateway says who): their own messages are read. */
  user = $state('');
  currentId = $state<string>('general');
  /** The open room when it is not in the list (archived, opened by URL). */
  #detached = $state.raw<RoomView | undefined>();
  messages = $state.raw<RoomMessage[]>([]);
  pinned = $state.raw<RoomMessage[]>([]);
  hasMore = $state(false);
  loading = $state(true);
  error = $state('');
  connection = $state<RoomsConnection>('connecting');
  /** Others typing in each room: user → when their signal lapses. */
  typing = $state.raw<Record<string, Record<string, number>>>({});
  /** Faces thinking in each room now: room → face ids. */
  thinking = $state.raw<Record<string, string[]>>({});
  /** Every face (plan 10), hidden ones too: old messages still name them. */
  faces = $state.raw<Face[]>([]);
  /** What each face is doing now: face id → its presence. */
  facePresence = $state.raw<Record<string, FaceState>>({});
  /** Bumped whenever an open loop changes (plan 04), for lists that show them. */
  loopsRevision = $state(0);
  /** Bumped whenever a wake changes (plan 05), for lists that show them. */
  wakesRevision = $state(0);
  /** The thread open beside the room (plan 06), its messages and workers. */
  threadId = $state<string | undefined>();
  threadMessages = $state.raw<ThreadMessage[]>([]);
  threadWorkers = $state.raw<Worker[]>([]);
  threadError = $state('');
  /** What each thread's workers did last (plan 11: the anchor's progress). */
  threadActivity = $state.raw<Record<string, ThreadActivity>>({});
  #threadToken = 0;

  /** Offline demo data (dev builds without a gateway): nothing is sent anywhere. */
  demo = $state.raw<typeof import('./mock')>();
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
    if (this.demo) return;
    this.#stream = connectRooms({
      onEvent: (event) => this.apply(event),
      onReset: () => void this.reload(),
      onState: (state) => (this.connection = state),
      onPresence: (presence) => this.setPresence(presence),
      onFaces: (presence) => this.setFacePresence(presence),
    });
  }

  stop() {
    this.#stream?.close();
    this.#stream = undefined;
  }

  async reload() {
    if (this.demo) {
      await this.#startDemo(this.demo);
      this.loading = false;
      return;
    }
    try {
      const { rooms, user } = await roomsApi.list();
      this.rooms = rooms.sort(byActivity);
      this.user = user;
      this.error = '';
      await Promise.all([this.open(this.currentId, { address: false }), this.loadFaces()]);
    } catch (error) {
      // Dev only: the import is left out of production builds.
      if (import.meta.env.DEV && !this.demo) await this.#startDemo(await import('./mock'));
      else this.error = message(error, 'Unable to load rooms.');
    } finally {
      this.loading = false;
    }
  }

  async #startDemo(demo: typeof import('./mock')) {
    this.demo = demo;
    this.user = demo.demoUser;
    this.rooms = demo.demoRooms.filter((room) => !room.archivedAt).sort(byActivity);
    this.faces = demo.demoFaces;
    this.setFacePresence(demo.demoFacePresence);
    this.connection = 'offline';
    this.error = '';
    await this.open(this.currentId, { address: false });
  }

  /** Show a room: its latest messages, and read them. */
  async open(roomId: string, { address = true } = {}) {
    const token = ++this.#loadToken;
    if (this.threadId && roomId !== this.currentId) this.closeThread();
    this.currentId = roomId;
    if (address) setRoomInUrl(roomId);
    const demo = this.demo;
    if (demo) {
      const room = demo.demoRooms.find((item) => item.id === roomId);
      this.#detached = room && this.rooms.some((item) => item.id === room.id) ? undefined : room;
      this.messages = demo.demoMessages[roomId] ?? [];
      this.pinned = [];
      this.hasMore = false;
      this.error = room ? '' : 'This room does not exist.';
      return;
    }
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
    if (this.demo) {
      const last = this.messages[this.messages.length - 1];
      this.#append({
        id: `demo-${Date.now()}`,
        roomId,
        seq: (last?.seq ?? 0) + 1,
        speaker: 'user',
        user: this.user,
        kind: 'text',
        body: { text },
        threadId: null,
        createdAt: Date.now(),
        editedAt: null,
        pinnedAt: null,
      });
      return;
    }
    const uploads = [];
    for (const file of files) uploads.push((await roomsApi.upload(roomId, file)).upload.id);
    const { message } = await roomsApi.send(roomId, text, uploads, immediate);
    this.#append(message);
    this.#lastTyping = 0;
  }

  /** A keystroke in the composer: tell the others, at most every 3 s. */
  keystroke(now = Date.now()) {
    if (this.demo || now - this.#lastTyping < TYPING_THROTTLE_MS) return;
    this.#lastTyping = now;
    void roomsApi.typing(this.currentId).catch(() => {});
  }

  /** Read the open room up to its newest message, if the page is visible. */
  async markRead() {
    const room = this.current;
    if (!room || room.readSeq >= room.lastSeq || this.demo) return;
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

  /** The archived rooms, newest activity first. */
  async loadArchived() {
    const { rooms } = this.demo ? { rooms: this.demo.demoRooms } : await roomsApi.list(true);
    this.archived = rooms.filter((room) => room.archivedAt).sort(byActivity);
    this.#archivedLoaded = true;
  }

  async setArchived(roomId: string, archived: boolean) {
    const { room } = await roomsApi.update(roomId, { archived });
    await this.#refreshList();
    if (this.#archivedLoaded) await this.loadArchived();
    if (roomId === this.currentId)
      this.#detached = this.rooms.some((item) => item.id === roomId) ? undefined : room;
  }

  async rename(roomId: string, name: string) {
    const { room } = await roomsApi.update(roomId, { name });
    this.#merge(room);
  }

  /** The sources a room follows (plan 09): it hears of everything new in them. */
  async setSources(roomId: string, sourceScope: Record<string, unknown> | null) {
    const { room } = await roomsApi.update(roomId, { sourceScope });
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

  /** The faces and what they are doing; the list keeps what it had on failure. */
  async loadFaces() {
    try {
      const { faces, presence } = await facesApi.list(true);
      this.faces = faces;
      this.setFacePresence(presence);
    } catch {
      // Names fall back to ids until the next reload.
    }
  }

  face(id: string): Face | undefined {
    return this.faces.find((face) => face.id === id);
  }

  /** Make a face (the member list's "Add"); it shows up through its event too. */
  async createFace(name: string): Promise<Face> {
    const { face } = await facesApi.create({ name });
    this.#upsertFace(face);
    return face;
  }

  async updateFace(id: string, input: FaceInput): Promise<Face> {
    const { face } = await facesApi.update(id, input);
    this.#upsertFace(face);
    return face;
  }

  setFacePresence(presence: FaceState[]) {
    this.facePresence = facePresenceFrom(presence);
  }

  #upsertFace(face: Face) {
    this.faces = upsertFace(this.faces, face);
  }

  /** Which faces think in a room right now. */
  thinkingIn(roomId: string): string[] {
    return this.thinking[roomId] ?? [];
  }

  /** Where faces think as the stream (re)starts. */
  setPresence(presence: FacePresence[]) {
    this.thinking = thinkingFrom(presence);
  }

  /** What the stream changes, as the reducer sees it. */
  get view(): RoomsView {
    return {
      user: this.user,
      currentId: this.currentId,
      rooms: this.rooms,
      detached: this.#detached,
      messages: this.messages,
      pinned: this.pinned,
      typing: this.typing,
      thinking: this.thinking,
      faces: this.faces,
      facePresence: this.facePresence,
      loopsRevision: this.loopsRevision,
      wakesRevision: this.wakesRevision,
      threadId: this.threadId,
      threadMessages: this.threadMessages,
      threadActivity: this.threadActivity,
    };
  }

  /** One event of the stream (`room-events.ts`), then what it asks for. */
  apply(event: RoomEvent) {
    const { patch, effects } = reduceRoomEvent(this.view, event);
    this.#patch(patch);
    for (const effect of effects) this.#run(effect);
  }

  #patch(patch: Partial<RoomsView>) {
    if (patch.user !== undefined) this.user = patch.user;
    if (patch.currentId !== undefined) this.currentId = patch.currentId;
    if (patch.rooms) this.rooms = patch.rooms;
    if ('detached' in patch) this.#detached = patch.detached;
    if (patch.messages) this.messages = patch.messages;
    if (patch.pinned) this.pinned = patch.pinned;
    if (patch.typing) this.typing = patch.typing;
    if (patch.thinking) this.thinking = patch.thinking;
    if (patch.faces) this.faces = patch.faces;
    if (patch.facePresence) this.facePresence = patch.facePresence;
    if (patch.loopsRevision !== undefined) this.loopsRevision = patch.loopsRevision;
    if (patch.wakesRevision !== undefined) this.wakesRevision = patch.wakesRevision;
    if ('threadId' in patch) this.threadId = patch.threadId;
    if (patch.threadMessages) this.threadMessages = patch.threadMessages;
    if (patch.threadActivity) this.threadActivity = patch.threadActivity;
  }

  #run(effect: RoomEffect) {
    switch (effect.type) {
      case 'refresh_list':
        void this.#refreshList();
        break;
      case 'refresh_room':
        void this.#refreshRoom(effect.roomId);
        break;
      case 'mark_read':
        void this.markRead();
        break;
      case 'refresh_thread_workers':
        void this.#refreshThreadWorkers();
        break;
    }
  }

  #append(message: RoomMessage) {
    this.messages = appendMessage(this.messages, message);
  }

  /** Open a thread beside the room: its messages, live from then on. */
  async openThread(threadId: string) {
    const token = ++this.#threadToken;
    this.threadId = threadId;
    this.threadError = '';
    if (this.demo) {
      this.threadMessages = this.demo.demoThread.messages;
      this.threadWorkers = this.demo.demoThread.workers;
      return;
    }
    try {
      const { messages, workers } = await workersApi.thread(threadId);
      if (token !== this.#threadToken) return;
      // Events that came meanwhile are kept.
      const known = new Set(messages.map((item) => item.id));
      const later = this.threadMessages.filter(
        (item) => item.threadId === threadId && !known.has(item.id),
      );
      this.threadMessages = [...messages, ...later].sort((a, b) => a.seq - b.seq);
      this.threadWorkers = workers;
    } catch (error) {
      if (token !== this.#threadToken) return;
      this.threadMessages = [];
      this.threadWorkers = [];
      this.threadError = message(error, 'Unable to open the thread.');
    }
  }

  closeThread() {
    this.#threadToken++;
    this.threadId = undefined;
    this.threadMessages = [];
    this.threadWorkers = [];
    this.threadError = '';
  }

  async #refreshThreadWorkers() {
    const threadId = this.threadId;
    if (!threadId) return;
    try {
      const { workers } = await workersApi.thread(threadId);
      if (threadId === this.threadId) this.threadWorkers = workers;
    } catch {
      // Kept as it was; the next line refreshes it.
    }
  }

  #replace(message: RoomMessage) {
    this.#patch(replaceMessage(this.view, message));
  }

  /** A room's shared fields changed: keep the user's own (reads, unread). */
  #merge(room: Room | RoomView) {
    this.#patch(mergeRoom(this.view, room));
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
