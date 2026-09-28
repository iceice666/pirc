/**
 * Client side of the agent → gateway channel. Under a node (`PIRC_GATEWAY=1`)
 * a request goes out on stdout as `gateway_request` and is answered on stdin
 * by `gateway_response` (routed here by serveRpc). The node adds the session,
 * and the gateway decides what each operation may do (see protocol.ts). Only a
 * node's main agent has a gateway: team members, subagents and standalone
 * agents do not.
 */
import { randomUUID } from 'node:crypto';
import { teamChildName } from './features/team/channel.js';

export class GatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** The node answers within 30 s (or reports the gateway offline); this only guards a lost reply. */
const LOST_REPLY_MS = 45_000;

export class NodeGateway {
  private readonly pending = new Map<string, Pending>();
  constructor(
    private readonly write: (value: unknown) => void,
    private readonly lostReplyMs = LOST_REPLY_MS,
  ) {}

  /** Run a gateway operation; resolves with its result, rejects with a GatewayError. */
  request(op: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const onAbort = () => (settle(), reject(new Error('Aborted')));
      const timer = setTimeout(
        () => (settle(), reject(new GatewayError('gateway_timeout', 'The gateway did not answer'))),
        this.lostReplyMs,
      );
      this.pending.set(id, {
        resolve: (value) => (settle(), resolve(value)),
        reject: (error) => (settle(), reject(error)),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.write({ type: 'gateway_request', id, op, args });
    });
  }

  respond(message: { id?: unknown; ok?: unknown; result?: unknown; error?: any }): void {
    const pending = typeof message.id === 'string' ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    if (message.ok === true) return pending.resolve(message.result);
    const error = message.error ?? {};
    pending.reject(
      new GatewayError(
        typeof error.code === 'string' ? error.code : 'internal_error',
        typeof error.message === 'string' ? error.message : 'The gateway request failed',
        typeof error.status === 'number' ? error.status : undefined,
      ),
    );
  }

  closeAll(): void {
    for (const pending of [...this.pending.values()])
      pending.reject(new GatewayError('gateway_closed', 'The gateway channel closed'));
  }
}

let nodeGatewayInstance: NodeGateway | undefined;
export function nodeGateway(): NodeGateway {
  nodeGatewayInstance ??= new NodeGateway((value) =>
    process.stdout.write(`${JSON.stringify(value)}\n`),
  );
  return nodeGatewayInstance;
}

/** This process's gateway, or undefined when it has none (see module comment). */
export function processGateway(): NodeGateway | undefined {
  return process.env.PIRC_GATEWAY === '1' && !teamChildName() ? nodeGateway() : undefined;
}
