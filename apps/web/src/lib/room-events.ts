/**
 * How the room stream changes what a client shows (plans/rewrite/11-web.md):
 * one pure step per event, so every client can be held to the same golden
 * cases (`fixtures/timeline/rooms`). `RoomsState` keeps the result in Svelte
 * state and carries out the follow-ups (`effects`) an event asks for; the
 * reducer itself never fetches anything.
 */
import type { Face, FacePresence as FaceState } from './faces';
import type { FacePresence, Room, RoomEvent, RoomMessage, RoomView } from './rooms';
import type { ThreadMessage } from './workers';

/** Everything the stream changes. */
export interface RoomsView {
  /** The asking user: their own messages are read. */
  user: string;
  currentId: string;
  /** In activity order; archived ones only while open. */
  rooms: RoomView[];
  /** The open room when it is not in the list (archived, opened by URL). */
  detached: RoomView | undefined;
  /** The open room's messages, in seq order. */
  messages: RoomMessage[];
  pinned: RoomMessage[];
  /** Others typing in each room: user → when their signal lapses. */
  typing: Record<string, Record<string, number>>;
  /** Faces thinking in each room now: room → face ids. */
  thinking: Record<string, string[]>;
  faces: Face[];
  /** What each face is doing now: face id → its presence. */
  facePresence: Record<string, FaceState>;
  /** Bumped whenever an open loop changes, for lists that show them. */
  loopsRevision: number;
  /** Bumped whenever a wake changes, for lists that show them. */
  wakesRevision: number;
  /** The thread open beside the room, and its messages in seq order. */
  threadId: string | undefined;
  threadMessages: ThreadMessage[];
}

/** What an event asks the client to fetch or send after it. */
export type RoomEffect =
  /** A room appeared that the list does not have. */
  | { type: 'refresh_list' }
  /** Another device read a room: the gateway says how many are unread. */
  | { type: 'refresh_room'; roomId: string }
  /** Something new in the open room: read it if the page is visible. */
  | { type: 'mark_read' }
  /** A worker started or ended in the open thread. */
  | { type: 'refresh_thread_workers' };

export interface Reduced {
  /** Only the fields that changed. */
  patch: Partial<RoomsView>;
  effects: RoomEffect[];
}

export const byActivity = (a: RoomView, b: RoomView) =>
  b.lastActivityAt - a.lastActivityAt || b.createdAt - a.createdAt;

/** One event of the stream. */
export function reduceRoomEvent(view: RoomsView, event: RoomEvent): Reduced {
  const none: Reduced = { patch: {}, effects: [] };
  switch (event.type) {
    case 'brain_presence': {
      const { face, state } = event.data;
      const others = (view.thinking[event.roomId] ?? []).filter((item) => item !== face);
      return {
        patch: {
          thinking: {
            ...view.thinking,
            [event.roomId]: state === 'thinking' ? [...others, face] : others,
          },
        },
        effects: [],
      };
    }
    case 'room_message': {
      const message: RoomMessage = event.data.message;
      const open = message.roomId === view.currentId;
      const patch: Partial<RoomsView> = {};
      if (open) patch.messages = appendMessage(view.messages, message);
      const mine = message.speaker === 'user' && message.user === view.user;
      if (!mine) patch.rooms = bumpUnread(view.rooms, message.roomId, message.seq);
      if (message.speaker === 'user' && message.user)
        patch.typing = stopTyping(view.typing, message.roomId, message.user);
      return { patch, effects: open ? [{ type: 'mark_read' }] : [] };
    }
    case 'room_message_updated':
      return { patch: replaceMessage(view, event.data.message), effects: [] };
    case 'room_changed': {
      const room: Room = event.data.room;
      if (!view.rooms.some((item) => item.id === room.id) && !room.archivedAt)
        return { patch: {}, effects: [{ type: 'refresh_list' }] };
      return { patch: mergeRoom(view, room), effects: [] };
    }
    case 'room_read': {
      if (event.data.user !== view.user) return none;
      const room = view.rooms.find((item) => item.id === event.roomId);
      // Another device read it: the count is the gateway's to say.
      return room && event.data.readSeq > room.readSeq
        ? { patch: {}, effects: [{ type: 'refresh_room', roomId: room.id }] }
        : none;
    }
    case 'room_typing': {
      const { user, expiresAt } = event.data;
      return {
        patch: {
          typing: {
            ...view.typing,
            [event.roomId]: { ...view.typing[event.roomId], [user]: expiresAt },
          },
        },
        effects: [],
      };
    }
    case 'loop_changed':
      return { patch: { loopsRevision: view.loopsRevision + 1 }, effects: [] };
    case 'wake_changed':
      return { patch: { wakesRevision: view.wakesRevision + 1 }, effects: [] };
    case 'face_changed':
      return { patch: { faces: upsertFace(view.faces, event.data.face) }, effects: [] };
    case 'face_presence': {
      const presence: FaceState = event.data;
      return {
        patch: { facePresence: { ...view.facePresence, [presence.faceId]: presence } },
        effects: [],
      };
    }
    case 'thread_message':
    case 'thread_message_updated': {
      if (event.data.threadId !== view.threadId) return none;
      const message: ThreadMessage = event.data.message;
      return {
        patch: { threadMessages: upsertBySeq(view.threadMessages, message) },
        // A worker started or ended: its list says so.
        effects: message.kind === 'line' ? [{ type: 'refresh_thread_workers' }] : [],
      };
    }
    default:
      return none;
  }
}

/** A new message of the open room, once, in seq order. */
export function appendMessage(messages: RoomMessage[], message: RoomMessage): RoomMessage[] {
  if (messages.some((item) => item.id === message.id)) return messages;
  const last = messages[messages.length - 1];
  return !last || message.seq > last.seq
    ? [...messages, message]
    : [...messages, message].sort((a, b) => a.seq - b.seq);
}

/** A message changed: in place, and among the pins while it is pinned. */
export function replaceMessage(
  view: Pick<RoomsView, 'messages' | 'pinned' | 'currentId'>,
  message: RoomMessage,
): Pick<RoomsView, 'messages' | 'pinned'> {
  const pinned = view.pinned.filter((item) => item.id !== message.id);
  return {
    messages: view.messages.map((item) => (item.id === message.id ? message : item)),
    pinned: message.pinnedAt && message.roomId === view.currentId ? [...pinned, message] : pinned,
  };
}

/** Someone else's new message: unread until read. A replayed one counts once. */
export function bumpUnread(rooms: RoomView[], roomId: string, seq: number): RoomView[] {
  return rooms.map((room) =>
    room.id === roomId && seq > room.readSeq && seq > room.lastSeq
      ? { ...room, unread: room.unread + 1, lastSeq: seq }
      : room,
  );
}

export function stopTyping(
  typing: RoomsView['typing'],
  roomId: string,
  user: string,
): RoomsView['typing'] {
  const { [user]: _gone, ...rest } = typing[roomId] ?? {};
  return { ...typing, [roomId]: rest };
}

/** A room's shared fields changed: keep the user's own (reads, unread). */
export function mergeRoom(
  view: Pick<RoomsView, 'rooms' | 'detached' | 'currentId'>,
  room: Room | RoomView,
): Pick<RoomsView, 'rooms' | 'detached'> {
  const keep = (old: RoomView): RoomView => ({ ...old, ...room });
  const rooms = view.rooms.some((item) => item.id === room.id)
    ? view.rooms
        .map((item) => (item.id === room.id ? keep(item) : item))
        .filter((item) => !item.archivedAt || item.id === view.currentId)
        .sort(byActivity)
    : view.rooms;
  const detached = view.detached?.id === room.id ? keep(view.detached) : view.detached;
  return { rooms, detached };
}

export function upsertFace(faces: Face[], face: Face): Face[] {
  return faces.some((item) => item.id === face.id)
    ? faces.map((item) => (item.id === face.id ? face : item))
    : [...faces, face];
}

/** A thread message, new or changed, in seq order. */
export function upsertBySeq(messages: ThreadMessage[], message: ThreadMessage): ThreadMessage[] {
  const others = messages.filter((item) => item.id !== message.id);
  return [...others, message].sort((a, b) => a.seq - b.seq);
}

/** Where faces think as the stream (re)starts. */
export function thinkingFrom(presence: FacePresence[]): RoomsView['thinking'] {
  const thinking: RoomsView['thinking'] = {};
  for (const { face, roomId } of presence) thinking[roomId] = [...(thinking[roomId] ?? []), face];
  return thinking;
}

/** What each face is doing as the stream (re)starts. */
export function facePresenceFrom(presence: FaceState[]): RoomsView['facePresence'] {
  const next: RoomsView['facePresence'] = {};
  for (const item of presence) next[item.faceId] = item;
  return next;
}
