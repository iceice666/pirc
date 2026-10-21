// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://pirc.example/"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectRooms, type RoomEvent } from './rooms';

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = FakeSocket.CONNECTING;
  closedWith: [number?, string?] | undefined;
  constructor(readonly url: string) {
    super();
  }
  close(code?: number, reason?: string) {
    this.closedWith = [code, reason];
  }
  frame(data: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) }),
    );
  }
}

afterEach(() => vi.useRealTimers());

function follow() {
  const sockets: FakeSocket[] = [];
  const events: RoomEvent[] = [];
  const resets: number[] = [];
  const presence: unknown[] = [];
  const faces: unknown[] = [];
  const stream = connectRooms({
    onEvent: (event) => events.push(event),
    onReset: () => resets.push(1),
    onState: () => {},
    onPresence: (value) => presence.push(value),
    onFaces: (value) => faces.push(value),
    socket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { sockets, events, resets, presence, faces, stream };
}

const frame = (type: string, sequence: number) => ({
  type,
  roomId: 'general',
  epoch: 3,
  sequence,
  timestamp: 1,
  data: {},
});

describe('the room stream', () => {
  it('passes room, thread, face, loop and wake events on, and nothing else', () => {
    const { sockets, events, stream } = follow();
    expect(sockets[0]!.url).toBe('wss://pirc.example/api/events?rooms=1');
    for (const type of [
      'room_message',
      'room_message_updated',
      'room_changed',
      'room_read',
      'room_typing',
      'brain_presence',
      'loop_changed',
      'wake_changed',
      'thread_message',
      'thread_message_updated',
      'face_changed',
      'face_presence',
      'session_event',
      'memory_changed',
      'ping',
    ])
      sockets[0]!.frame(frame(type, 1));
    expect(events.map((event) => event.type)).toEqual([
      'room_message',
      'room_message_updated',
      'room_changed',
      'room_read',
      'room_typing',
      'brain_presence',
      'loop_changed',
      'wake_changed',
      'thread_message',
      'thread_message_updated',
      'face_changed',
      'face_presence',
    ]);
    stream.close();
  });

  it('reads presence from ready, reloads on reset, and closes on garbage', () => {
    const { sockets, resets, presence, faces, stream } = follow();
    const socket = sockets[0]!;
    socket.frame({
      type: 'ready',
      watermark: { epoch: 3, sequence: 0 },
      presence: [{ face: 'host', roomId: 'general', state: 'thinking', since: 1 }],
      faces: [{ faceId: 'host', state: 'thinking' }],
    });
    // An older gateway without presence: none.
    socket.frame({ type: 'ready', watermark: { epoch: 3, sequence: 0 } });
    expect(presence).toEqual([
      [{ face: 'host', roomId: 'general', state: 'thinking', since: 1 }],
      [],
    ]);
    expect(faces).toEqual([[{ faceId: 'host', state: 'thinking' }]]);
    socket.frame({ type: 'reset', watermark: { epoch: 4, sequence: 9 } });
    expect(resets).toHaveLength(1);
    socket.frame('not json');
    expect(socket.closedWith).toEqual([1003, 'Invalid event']);
    stream.close();
  });

  it('resumes from the last numbered event, never an ephemeral one', () => {
    vi.useFakeTimers();
    const { sockets, stream } = follow();
    sockets[0]!.frame({ type: 'ready', watermark: { epoch: 3, sequence: 2 } });
    sockets[0]!.frame(frame('room_message', 7));
    sockets[0]!.frame(frame('room_typing', 0));
    sockets[0]!.dispatchEvent(new Event('close'));
    vi.advanceTimersByTime(30_000);
    expect(sockets[1]!.url).toBe('wss://pirc.example/api/events?rooms=1&cursor=3%3A7');
    stream.close();
  });
});
