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
});

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
