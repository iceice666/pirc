import type WebSocket from 'ws';
import { ApiError } from '../errors.js';
import {
  RELAY_MESSAGE_MAX_BYTES,
  type TerminalStream,
  type TerminalStreamHandlers,
} from './nodes.js';

/** Only live browser frames may be skipped while this much is queued. */
export const BROWSER_SOCKET_BACKLOG_BYTES = 2 * 1024 * 1024;

/**
 * Fastify shares the node link's large maxPayload across all routes. Give
 * browser sockets their own receiver limit, before ws buffers a large frame.
 */
export function limitIncoming(socket: object, bytes: number): void {
  const receiver = (socket as { _receiver?: { _maxPayload?: unknown } })._receiver;
  if (receiver && typeof receiver._maxPayload === 'number') receiver._maxPayload = bytes;
}

export function wsCloseCode(error: unknown): number {
  const status = error instanceof ApiError ? error.statusCode : 500;
  return status === 401 ? 4401 : status === 403 ? 4403 : status === 404 ? 4404 : 4400;
}

type RelaySocket = Pick<
  WebSocket,
  'OPEN' | 'readyState' | 'bufferedAmount' | 'send' | 'close' | 'on' | 'once' | 'removeListener'
>;

/** Browser-facing terminal/browser glue; authentication stays in the route's open callback. */
export function relaySocket(
  socket: RelaySocket,
  options: {
    kind: 'terminal' | 'browser';
    maxBufferedBytes: number;
    open(handlers: TerminalStreamHandlers): TerminalStream;
    track(close: (code: number, reason: string) => void): () => void;
  },
): void {
  const maxBytes = RELAY_MESSAGE_MAX_BYTES[options.kind];
  limitIncoming(socket, maxBytes);
  let finished = false;
  let stream: TerminalStream | undefined;
  let untrack: (() => void) | undefined;

  // Resources can arrive after a synchronous close during open/track. Drain
  // them even when already finished, and clear them before reentrant callbacks.
  const done = () => {
    finished = true;
    socket.removeListener('message', onMessage);
    const opened = stream;
    const tracked = untrack;
    stream = undefined;
    untrack = undefined;
    try {
      opened?.close();
    } finally {
      tracked?.();
    }
  };
  const close = (code: number, reason: string) => {
    if (finished) return;
    done();
    if (socket.readyState === socket.OPEN) socket.close(code, reason.slice(0, 120));
  };
  const onMessage = (raw: unknown) => {
    if (finished) return;
    const text = String(raw);
    if (Buffer.byteLength(text) > maxBytes) {
      close(1009, 'message too large');
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return; // Malformed JSON has always been ignored on these routes.
    }
    stream?.send(message);
  };
  socket.once('close', done);
  // Keep the harmless error listener for late errors after close as well.
  socket.on('error', done);
  try {
    stream = options.open({
      onFrame(frame) {
        if (finished || socket.readyState !== socket.OPEN) return;
        const live = (frame as { type?: unknown })?.type === 'frame';
        if (
          options.kind === 'browser' &&
          live &&
          socket.bufferedAmount > BROWSER_SOCKET_BACKLOG_BYTES
        )
          return;
        if (socket.bufferedAmount > options.maxBufferedBytes) {
          close(1013, 'resync required');
          return;
        }
        socket.send(JSON.stringify(frame));
      },
      onClose: close,
    });
    if (finished) {
      done();
      return;
    }
    untrack = options.track(close);
    if (finished) done();
    else socket.on('message', onMessage);
  } catch (error) {
    close(wsCloseCode(error), error instanceof Error ? error.message : 'invalid request');
  }
}
