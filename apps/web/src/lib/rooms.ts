/**
 * The rooms API and its event stream (plans/rewrite/01-rooms.md): the
 * gateway's `/api/rooms` routes and `/api/events?rooms=1`.
 */
import { request } from './http';
import type { RememberedLine } from './memory';

export interface Room {
  id: string;
  name: string;
  kind: 'general' | 'topic';
  createdAt: number;
  archivedAt: number | null;
  lastActivityAt: number;
  sourceScope: unknown;
  movedToRoomId: string | null;
  movedFromRoomId: string | null;
  /** The seq of its newest message (0: none yet). */
  lastSeq: number;
}

/** A room as the asking user sees it. */
export interface RoomView extends Room {
  readSeq: number;
  unread: number;
  /** A face waits for this user's reply there. */
  waiting: boolean;
  waitingSince: number | null;
}

export interface RoomAttachment {
  id: string;
  kind: 'image' | 'file';
  filename: string | null;
  mimeType: string;
  byteSize: number;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  seq: number;
  /** `user`, or `face:<id>`. */
  speaker: string;
  /** Who sent a `user` message. */
  user: string | null;
  kind: 'text' | 'line' | 'progress' | 'question';
  body: {
    text?: string;
    attachments?: RoomAttachment[];
    move?: { direction: 'to' | 'from'; roomId: string; roomName: string };
    /** A face's reply still coming in (plan 02). */
    streaming?: boolean;
    /** A line saying what the brain remembered (plan 03), which "Don't keep" undoes. */
    memory?: RememberedLine;
  };
  threadId: string | null;
  createdAt: number;
  editedAt: number | null;
  pinnedAt: number | null;
}

export interface RoomUpload extends RoomAttachment {
  roomId: string;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const path = (roomId: string, rest = '') => `/api/rooms/${encodeURIComponent(roomId)}${rest}`;

export const roomsApi = {
  list: (archived = false) =>
    request<{ rooms: RoomView[]; user: string }>(`/api/rooms${archived ? '?archived=1' : ''}`),
  get: (roomId: string) => request<{ room: RoomView; pinned: RoomMessage[] }>(path(roomId)),
  create: (name: string) =>
    request<{ room: Room }>('/api/rooms', { method: 'POST', ...json({ name }) }),
  update: (roomId: string, patch: { name?: string; archived?: boolean }) =>
    request<{ room: RoomView }>(path(roomId), { method: 'PATCH', ...json(patch) }),
  move: (roomId: string, toRoomId: string) =>
    request<{ from: Room; to: Room }>(path(roomId, '/move'), {
      method: 'POST',
      ...json({ toRoomId }),
    }),
  messages: (roomId: string, before?: number, limit?: number) => {
    const query = new URLSearchParams();
    if (before) query.set('before', String(before));
    if (limit) query.set('limit', String(limit));
    const suffix = query.size ? `?${query}` : '';
    return request<{ messages: RoomMessage[]; hasMore: boolean }>(
      path(roomId, `/messages${suffix}`),
    );
  },
  send: (roomId: string, text: string, attachments: string[] = [], immediate = false) =>
    request<{ message: RoomMessage }>(path(roomId, '/messages'), {
      method: 'POST',
      ...json({ text, attachments, immediate }),
    }),
  pin: (roomId: string, messageId: string, pinned: boolean) =>
    request<{ message: RoomMessage }>(
      path(roomId, `/messages/${encodeURIComponent(messageId)}/pin`),
      { method: 'POST', ...json({ pinned }) },
    ),
  read: (roomId: string, seq: number) =>
    request<{ room: RoomView }>(path(roomId, '/read'), { method: 'POST', ...json({ seq }) }),
  typing: (roomId: string) => request<void>(path(roomId, '/typing'), { method: 'POST' }),
  upload: (roomId: string, file: File) => {
    const query = new URLSearchParams({ filename: file.name });
    return request<{ upload: RoomUpload }>(path(roomId, `/uploads?${query}`), {
      method: 'POST',
      body: file,
      headers: { 'content-type': file.type || 'application/octet-stream' },
    });
  },
  uploadUrl: (roomId: string, uploadId: string) =>
    path(roomId, `/uploads/${encodeURIComponent(uploadId)}`),
};

/**
 * One event of the room stream; sequence 0 is ephemeral (typing, a face's
 * presence) and never replayed.
 */
export interface RoomEvent {
  type:
    | 'room_message'
    | 'room_message_updated'
    | 'room_changed'
    | 'room_read'
    | 'room_typing'
    | 'brain_presence';
  roomId: string;
  epoch: number;
  sequence: number;
  data: any;
  timestamp: number;
}

export type RoomsConnection = 'connecting' | 'connected' | 'reconnecting' | 'offline';

/** A face thinking in a room now (a room socket's `ready`). */
export interface FacePresence {
  face: string;
  roomId: string;
  state: 'thinking';
  since: number;
}

export interface RoomStream {
  close(): void;
  reconnectNow(): void;
}

/**
 * Follow `/api/events?rooms=1`, reconnecting with the cursor of the last
 * numbered event. A `reset` (the gateway restarted, or the client fell too
 * far behind) means: reload what is shown.
 */
export function connectRooms(options: {
  onEvent: (event: RoomEvent) => void;
  onReset: () => void;
  onState: (state: RoomsConnection) => void;
  /** Where faces are thinking as the socket starts (presence is not replayed). */
  onPresence?: (presence: FacePresence[]) => void;
  socket?: (url: string) => WebSocket;
}): RoomStream {
  let socket: WebSocket | undefined;
  let closed = false;
  let attempts = 0;
  let cursor: string | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const make = options.socket ?? ((url: string) => new WebSocket(url));
  const open = () => {
    if (closed) return;
    retryTimer = undefined;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = new URLSearchParams({ rooms: '1' });
    if (cursor) query.set('cursor', cursor);
    const ws = make(`${protocol}//${location.host}/api/events?${query}`);
    socket = ws;
    ws.addEventListener('open', () => {
      if (ws !== socket) return;
      attempts = 0;
      options.onState('connected');
    });
    ws.addEventListener('message', (message) => {
      if (ws !== socket) return;
      let frame: any;
      try {
        frame = JSON.parse(String(message.data));
      } catch {
        ws.close(1003, 'Invalid event');
        return;
      }
      const at = (watermark: any) => `${watermark.epoch}:${watermark.sequence}`;
      if (frame?.type === 'ready') {
        cursor = at(frame.watermark);
        options.onPresence?.(Array.isArray(frame.presence) ? frame.presence : []);
      } else if (frame?.type === 'reset') {
        cursor = at(frame.watermark);
        options.onReset();
      } else if (
        typeof frame?.type === 'string' &&
        (frame.type.startsWith('room_') || frame.type === 'brain_presence')
      ) {
        if (frame.sequence > 0) cursor = `${frame.epoch}:${frame.sequence}`;
        options.onEvent(frame as RoomEvent);
      }
    });
    ws.addEventListener('close', () => {
      if (closed || ws !== socket) return;
      options.onState(navigator.onLine ? 'reconnecting' : 'offline');
      retryTimer = setTimeout(open, Math.min(20_000, 750 * 2 ** attempts++) + Math.random() * 400);
    });
    ws.addEventListener('error', () => {
      if (ws === socket) ws.close();
    });
  };
  const reconnectNow = () => {
    if (closed) return;
    const state = socket?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
    if (retryTimer) clearTimeout(retryTimer);
    attempts = 0;
    socket?.close();
    open();
  };
  const offline = () => options.onState('offline');
  window.addEventListener('online', reconnectNow);
  window.addEventListener('offline', offline);
  options.onState('connecting');
  open();
  return {
    reconnectNow,
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close(1000, 'Closed');
      window.removeEventListener('online', reconnectNow);
      window.removeEventListener('offline', offline);
    },
  };
}
