/**
 * Client side of the node's write-permission broker. File tools ask for a
 * lease on the workspace root they are about to write under; the node refuses
 * when another session holds an overlapping lease.
 *
 * - Team/subagent children forward to their parent agent, sharing its lease.
 * - Under a node (`PIRC_WRITE_BROKER=1`) the request goes out on stdout as
 *   `write_lease_request` and is answered on stdin by `write_lease_response`
 *   (routed here by serveRpc).
 * - Standalone agents have no broker and are always granted.
 */
import { randomUUID } from 'node:crypto';
import { parentChannel, teamChildName } from './features/team/channel.js';

export type AcquireWrite = (root: string, signal?: AbortSignal) => Promise<void>;

type Pending = { resolve: () => void; reject: (error: Error) => void };

export class NodeWriteBroker {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly write: (value: unknown) => void) {}

  acquire(root: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(new Error('Aborted'));
      };
      const settle = () => signal?.removeEventListener('abort', onAbort);
      this.pending.set(id, {
        resolve: () => (settle(), resolve()),
        reject: (error) => (settle(), reject(error)),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.write({ type: 'write_lease_request', id, path: root });
    });
  }

  respond(message: { id?: unknown; granted?: unknown; error?: unknown }): void {
    const pending = typeof message.id === 'string' ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    this.pending.delete(message.id as string);
    if (message.granted === true) pending.resolve();
    else
      pending.reject(
        new Error(typeof message.error === 'string' ? message.error : 'Write lease refused'),
      );
  }

  closeAll(): void {
    for (const pending of this.pending.values()) pending.reject(new Error('Write broker closed'));
    this.pending.clear();
  }
}

let nodeBroker: NodeWriteBroker | undefined;
export function nodeWriteBroker(): NodeWriteBroker {
  nodeBroker ??= new NodeWriteBroker((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  return nodeBroker;
}

/** The lease transport for this process (see module comment). */
export function processWriteLease(): AcquireWrite {
  if (teamChildName())
    return async (root, signal) => {
      await parentChannel().call('write_lease', { path: root }, signal);
    };
  if (process.env.PIRC_WRITE_BROKER === '1')
    return (root, signal) => nodeWriteBroker().acquire(root, signal);
  return async () => undefined;
}
