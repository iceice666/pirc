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
import { PendingRequests } from './pending-requests.js';
import { parentChannel, teamChildName } from './features/team/channel.js';

export type AcquireWrite = (root: string, signal?: AbortSignal) => Promise<void>;

export class NodeWriteBroker {
  private readonly pending = new PendingRequests<void>();
  constructor(private readonly write: (value: unknown) => void) {}

  acquire(root: string, signal?: AbortSignal): Promise<void> {
    return this.pending.request({
      signal,
      abortError: () => new Error('Aborted'),
      send: (id) => this.write({ type: 'write_lease_request', id, path: root }),
    });
  }

  respond(message: { id?: unknown; granted?: unknown; error?: unknown }): void {
    const pending = typeof message.id === 'string' ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    if (message.granted === true) pending.resolve(undefined);
    else
      pending.reject(
        new Error(typeof message.error === 'string' ? message.error : 'Write lease refused'),
      );
  }

  closeAll(): void {
    this.pending.closeAll(() => new Error('Write broker closed'));
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
