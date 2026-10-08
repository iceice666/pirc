import type WebSocket from 'ws';
import { SharedNodeLink } from '../../src/shared-node-link.js';

/** Fake node speaks the same fragmented physical protocol as the shipped node runtime. */
export function sharedTestNode(socket: WebSocket): {
  send(value: unknown): Promise<void>;
  onMessage(callback: (value: any) => void): () => void;
} {
  let link: SharedNodeLink | undefined;
  const listeners = new Set<(value: any) => void>();
  const dispatch = (raw: string) => {
    const value = JSON.parse(raw);
    for (const listener of listeners) listener(value);
  };
  socket.on('message', (raw) => {
    const text = raw.toString();
    if (!link) {
      const value = JSON.parse(text);
      if (value.type === 'registered' && value.sharedLink === 1)
        link = new SharedNodeLink({
          send: (raw) =>
            new Promise((resolve, reject) =>
              socket.send(raw, (error) => (error ? reject(error) : resolve())),
            ),
          receive: dispatch,
          fail: () => socket.close(),
        });
      dispatch(text);
    } else void link.receive(text).catch(() => socket.close());
  });
  socket.on('close', () => link?.close());
  return {
    async send(value) {
      const raw = JSON.stringify(value);
      if (link) await link.send(raw);
      else socket.send(raw);
    },
    onMessage(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
}
