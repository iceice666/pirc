import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { ApiError } from '../src/errors.js';
import { RELAY_MESSAGE_MAX_BYTES, type TerminalStreamHandlers } from '../src/daemon/nodes.js';
import {
  BROWSER_SOCKET_BACKLOG_BYTES,
  limitIncoming,
  relaySocket,
} from '../src/daemon/socket-relay.js';

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  _receiver = { _maxPayload: 16 * 1024 * 1024 };
  sent: unknown[] = [];
  closes: [number, string][] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code: number, reason: string) {
    this.closes.push([code, reason]);
    this.readyState = 3;
    this.emit('close');
  }
}

function setup(
  kind: 'terminal' | 'browser' = 'terminal',
  hooks: {
    open?: (handlers: TerminalStreamHandlers, socket: FakeSocket) => void;
    track?: (close: (code: number, reason: string) => void) => void;
    close?: (handlers: TerminalStreamHandlers, socket: FakeSocket) => void;
  } = {},
) {
  const socket = new FakeSocket();
  const input: unknown[] = [];
  let handlers!: TerminalStreamHandlers;
  let streamCloses = 0;
  let tracks = 0;
  let untracks = 0;
  let revoke!: () => void;
  relaySocket(socket as unknown as WebSocket, {
    kind,
    maxBufferedBytes: 4 * 1024 * 1024,
    open(value) {
      handlers = value;
      hooks.open?.(handlers, socket);
      return {
        send: (message) => input.push(message),
        close() {
          streamCloses++;
          hooks.close?.(handlers, socket);
        },
      };
    },
    track(close) {
      tracks++;
      revoke = () => close(4401, 'device token revoked or expired');
      hooks.track?.(close);
      return () => untracks++;
    },
  });
  return {
    socket,
    input,
    handlers,
    revoke: () => revoke(),
    counts: () => ({ streamCloses, tracks, untracks }),
  };
}

for (const kind of ['terminal', 'browser'] as const) {
  describe(`${kind} relay`, () => {
    it('sets the per-kind receiver limit, ignores malformed JSON and preserves valid values', () => {
      const { socket, input } = setup(kind);
      expect(socket._receiver._maxPayload).toBe(RELAY_MESSAGE_MAX_BYTES[kind]);
      for (const text of ['{', 'undefined', '', '{"type":"input"}', 'null', 'false', '0'])
        socket.emit('message', Buffer.from(text));
      expect(input).toEqual([{ type: 'input' }, null, false, 0]);
      expect(socket.closes).toEqual([]);
    });

    it('allows the exact byte limit and closes only this stream on oversized input', () => {
      const relay = setup(kind);
      const { socket, input } = relay;
      const allowed = 'a'.repeat(RELAY_MESSAGE_MAX_BYTES[kind] - 2);
      socket.emit('message', JSON.stringify(allowed));
      expect(input).toEqual([allowed]);
      // Multibyte text exceeds the byte limit even though its character count does not.
      socket.emit('message', JSON.stringify('é'.repeat(RELAY_MESSAGE_MAX_BYTES[kind] / 2)));
      socket.emit('message', '{"late":true}');
      expect(input).toHaveLength(1);
      expect(socket.closes).toEqual([[1009, 'message too large']]);
      expect(relay.counts()).toEqual({ streamCloses: 1, tracks: 1, untracks: 1 });
    });

    it('untracks and detaches once on device revocation and ignores late callbacks', () => {
      const relay = setup(kind, {
        close(handlers, socket) {
          handlers.onClose(1011, 'reentrant');
          socket.emit('error', new Error('reentrant'));
        },
      });
      relay.revoke();
      relay.revoke();
      relay.handlers.onFrame({ type: 'state' });
      relay.handlers.onClose(1011, 'late');
      relay.socket.emit('error', new Error('late'));
      relay.socket.emit('close');
      expect(relay.socket.sent).toEqual([]);
      expect(relay.socket.closes).toEqual([[4401, 'device token revoked or expired']]);
      expect(relay.counts()).toEqual({ streamCloses: 1, tracks: 1, untracks: 1 });
      expect(relay.socket.listenerCount('message')).toBe(0);
    });

    for (const event of ['close', 'error']) {
      it(`cleans up on socket ${event} without waiting for the other event`, () => {
        const relay = setup(kind);
        relay.socket.emit(event);
        relay.socket.emit('error');
        relay.socket.emit('close');
        relay.handlers.onFrame({ type: 'output' });
        expect(relay.socket.sent).toEqual([]);
        expect(relay.counts()).toEqual({ streamCloses: 1, tracks: 1, untracks: 1 });
      });
    }
  });
}

it('terminal output closes for resync above (not at) the configured backlog', () => {
  const { socket, handlers, counts } = setup();
  socket.bufferedAmount = 4 * 1024 * 1024;
  handlers.onFrame({ type: 'output', data: 'at limit' });
  socket.bufferedAmount++;
  handlers.onFrame({ type: 'output', data: 'over limit' });
  expect(socket.sent).toEqual([{ type: 'output', data: 'at limit' }]);
  expect(socket.closes).toEqual([[1013, 'resync required']]);
  expect(counts().streamCloses).toBe(1);
});

it('browser drops only live frames above its backlog; state/error frames still relay', () => {
  const { socket, handlers } = setup('browser');
  socket.bufferedAmount = BROWSER_SOCKET_BACKLOG_BYTES;
  handlers.onFrame({ type: 'frame', data: 'at limit' });
  socket.bufferedAmount++;
  handlers.onFrame({ type: 'frame', data: 'dropped' });
  handlers.onFrame({ type: 'state' });
  handlers.onFrame({ type: 'error' });
  socket.bufferedAmount = 0;
  handlers.onFrame({ type: 'frame', data: 'caught up' });
  expect(socket.sent).toEqual([
    { type: 'frame', data: 'at limit' },
    { type: 'state' },
    { type: 'error' },
    { type: 'frame', data: 'caught up' },
  ]);
  expect(socket.closes).toEqual([]);
});

it('browser retains the global backlog close policy for non-live frames', () => {
  const { socket, handlers } = setup('browser');
  socket.bufferedAmount = 4 * 1024 * 1024 + 1;
  handlers.onFrame({ type: 'frame' });
  expect(socket.closes).toEqual([]);
  handlers.onFrame({ type: 'state' });
  expect(socket.closes).toEqual([[1013, 'resync required']]);
});

it('cleans up a stream returned after a synchronous initial node close', () => {
  const relay = setup('terminal', {
    open(handlers) {
      handlers.onClose(1013, 'initial failure');
      handlers.onFrame({ type: 'late' });
    },
  });
  expect(relay.socket.closes).toEqual([[1013, 'initial failure']]);
  expect(relay.socket.sent).toEqual([]);
  expect(relay.counts()).toEqual({ streamCloses: 1, tracks: 0, untracks: 0 });
  expect(relay.socket.listenerCount('message')).toBe(0);
});

it('cleans up a stream returned after the socket closes during open', () => {
  const relay = setup('terminal', { open: (_, socket) => socket.close(1000, 'gone') });
  expect(relay.counts()).toEqual({ streamCloses: 1, tracks: 0, untracks: 0 });
});

for (const [status, code] of [
  [401, 4401],
  [403, 4403],
  [404, 4404],
  [503, 4400],
] as const) {
  it(`maps initial open/auth failure ${status} without tracking a dead stream`, () => {
    const relay = setup('terminal', {
      open() {
        throw new ApiError(status, 'invalid_input', 'x'.repeat(200));
      },
    });
    expect(relay.socket.closes).toEqual([[code, 'x'.repeat(120)]]);
    expect(relay.counts()).toEqual({ streamCloses: 0, tracks: 0, untracks: 0 });
    relay.socket.emit('error');
  });
}

it('cleans up when tracking throws after opening a stream', () => {
  const relay = setup('terminal', {
    track: () => {
      throw new Error('tracking failed');
    },
  });
  expect(relay.socket.closes).toEqual([[4400, 'tracking failed']]);
  expect(relay.counts()).toEqual({ streamCloses: 1, tracks: 1, untracks: 0 });
});

it('untracks a subscription returned after synchronous revocation while tracking', () => {
  const relay = setup('terminal', { track: (close) => close(4401, 'revoked') });
  expect(relay.socket.closes).toEqual([[4401, 'revoked']]);
  expect(relay.counts()).toEqual({ streamCloses: 1, tracks: 1, untracks: 1 });
  expect(relay.socket.listenerCount('message')).toBe(0);
});

it('tolerates sockets without a ws receiver and does not invent receiver properties', () => {
  expect(() => limitIncoming({}, 100)).not.toThrow();
  const socket = { _receiver: {} };
  limitIncoming(socket, 100);
  expect(socket).toEqual({ _receiver: {} });
});
