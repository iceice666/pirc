// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectEvents } from './api';

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  constructor(readonly url: string) {
    super();
    FakeSocket.all.push(this);
  }
  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    queueMicrotask(() => this.dispatchEvent(new Event('close')));
  }
  fail() {
    this.dispatchEvent(new Event('error'));
  }
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const lastSocket = () => FakeSocket.all[FakeSocket.all.length - 1]!;

const connect = () =>
  connectEvents({ sessionId: 's1', onEvent: () => undefined, onState: () => undefined });

it('does not open a second socket while one is connecting', () => {
  const connection = connect();
  window.dispatchEvent(new Event('online'));
  expect(FakeSocket.all).toHaveLength(1);
  connection.close();
});

it("ignores a replaced socket's late error and close", async () => {
  const connection = connect();
  const first = FakeSocket.all[0]!;
  first.readyState = FakeSocket.CLOSED;
  window.dispatchEvent(new Event('online'));
  const second = FakeSocket.all[1]!;
  expect(second).toBeDefined();
  // The first socket errors late: it must neither close the second nor schedule a retry.
  first.fail();
  first.dispatchEvent(new Event('close'));
  await Promise.resolve();
  expect(second.readyState).toBe(FakeSocket.CONNECTING);
  vi.advanceTimersByTime(30_000);
  expect(FakeSocket.all).toHaveLength(2);
  connection.close();
});

it('caps the reconnect backoff at about 20 seconds', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const connection = connect();
  // Fail every attempt; each close schedules the next one with a longer wait.
  for (let attempt = 0; attempt < 8; attempt++) {
    const socket = lastSocket();
    socket.readyState = FakeSocket.CLOSED;
    socket.dispatchEvent(new Event('close'));
    vi.advanceTimersByTime(20_000);
  }
  const opened = FakeSocket.all.length;
  // Well past the cap: the wait no longer doubles (750 ms × 2^8 would be 192 s).
  lastSocket().readyState = FakeSocket.CLOSED;
  lastSocket().dispatchEvent(new Event('close'));
  vi.advanceTimersByTime(19_999);
  expect(FakeSocket.all).toHaveLength(opened);
  vi.advanceTimersByTime(1);
  expect(FakeSocket.all).toHaveLength(opened + 1);
  connection.close();
});

it('reconnects at once when back online or on reconnectNow(), skipping the backoff', () => {
  const states: string[] = [];
  const connection = connectEvents({
    sessionId: 's1',
    onEvent: () => undefined,
    onState: (state) => states.push(state),
  });
  const first = FakeSocket.all[0]!;
  first.readyState = FakeSocket.CLOSED;
  first.dispatchEvent(new Event('close'));
  expect(states[states.length - 1]).toBe('reconnecting');
  // A retry is scheduled; `online` does not wait for it.
  window.dispatchEvent(new Event('online'));
  expect(FakeSocket.all).toHaveLength(2);
  const second = FakeSocket.all[1]!;
  second.readyState = FakeSocket.CLOSED;
  second.dispatchEvent(new Event('close'));
  connection.reconnectNow();
  expect(FakeSocket.all).toHaveLength(3);
  // The cancelled retry timers never open another socket.
  vi.advanceTimersByTime(30_000);
  expect(FakeSocket.all).toHaveLength(3);
  // An open socket is left alone.
  FakeSocket.all[2]!.readyState = FakeSocket.OPEN;
  connection.reconnectNow();
  expect(FakeSocket.all).toHaveLength(3);
  connection.close();
});

it('routes directory changes without moving the cursor', () => {
  const events: unknown[] = [];
  let directory = 0;
  const connection = connectEvents({
    sessionId: 's1',
    cursor: '2:5',
    onEvent: (event) => events.push(event),
    onState: () => undefined,
    onDirectory: () => directory++,
  });
  const first = FakeSocket.all[0]!;
  expect(new URL(first.url).searchParams.get('directory')).toBe('1');
  first.dispatchEvent(
    new MessageEvent('message', { data: JSON.stringify({ type: 'directory_changed' }) }),
  );
  expect(directory).toBe(1);
  expect(events).toHaveLength(0);
  // The next socket resumes from the session cursor, not from the directory event.
  first.readyState = FakeSocket.CLOSED;
  connection.reconnectNow();
  expect(new URL(FakeSocket.all[1]!.url).searchParams.get('cursor')).toBe('2:5');
  connection.close();
});

it('does not ask for directory changes without a handler', () => {
  const connection = connect();
  expect(new URL(FakeSocket.all[0]!.url).searchParams.has('directory')).toBe(false);
  expect(new URL(FakeSocket.all[0]!.url).searchParams.has('memory')).toBe(false);
  connection.close();
});

it('routes memory changes, when asked for, without resetting the session', () => {
  const events: unknown[] = [];
  let memory = 0;
  const connection = connectEvents({
    sessionId: 's1',
    cursor: '2:5',
    onEvent: (event) => events.push(event),
    onState: () => undefined,
    onMemory: () => memory++,
  });
  const socket = FakeSocket.all[0]!;
  expect(new URL(socket.url).searchParams.get('memory')).toBe('1');
  socket.dispatchEvent(
    new MessageEvent('message', { data: JSON.stringify({ type: 'memory_changed' }) }),
  );
  expect(memory).toBe(1);
  // Not a session event: no reset, no cursor change.
  expect(events).toHaveLength(0);
  connection.close();
});
