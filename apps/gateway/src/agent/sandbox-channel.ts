/**
 * Client side of the node's sandbox requests (node/runner.ts handleSandbox).
 * Under a sandboxing node (`PIRC_SANDBOX=srt`) a request goes out on stdout
 * as `sandbox_request` and is answered on stdin by `sandbox_response`
 * (routed here by serveRpc); an aborted tool sends `sandbox_cancel`. The
 * node asks the human itself before it grants anything. Only a node's main
 * agent talks to the node: team members and subagents have no channel.
 */
import { randomUUID } from 'node:crypto';
import { teamChildName } from './features/team/channel.js';

export class SandboxRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxRequestError';
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class NodeSandboxChannel {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly write: (value: unknown) => void) {}

  /** No lost-reply timer: approvals wait for the human, and the node answers every request. */
  request(
    op: 'network' | 'exec',
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, any>> {
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const settle = () => {
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const onAbort = () => {
        settle();
        this.write({ type: 'sandbox_cancel', id });
        reject(new SandboxRequestError('aborted', 'Aborted'));
      };
      this.pending.set(id, {
        resolve: (value) => (settle(), resolve(value as Record<string, any>)),
        reject: (error) => (settle(), reject(error)),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.write({ type: 'sandbox_request', id, op, args });
    });
  }

  respond(message: { id?: unknown; ok?: unknown; result?: unknown; error?: any }): void {
    const pending = typeof message.id === 'string' ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    if (message.ok === true) return pending.resolve(message.result ?? {});
    const error = message.error ?? {};
    pending.reject(
      new SandboxRequestError(
        typeof error.code === 'string' ? error.code : 'sandbox_error',
        typeof error.message === 'string' ? error.message : 'The sandbox request failed',
      ),
    );
  }

  closeAll(): void {
    for (const pending of [...this.pending.values()])
      pending.reject(new SandboxRequestError('closed', 'The sandbox channel closed'));
  }
}

let instance: NodeSandboxChannel | undefined;
export function nodeSandboxChannel(): NodeSandboxChannel {
  instance ??= new NodeSandboxChannel((value) =>
    process.stdout.write(`${JSON.stringify(value)}\n`),
  );
  return instance;
}

/** This process's channel to a sandboxing node, or undefined (see module comment). */
export function processSandboxChannel(): NodeSandboxChannel | undefined {
  return process.env.PIRC_SANDBOX === 'srt' && !teamChildName() ? nodeSandboxChannel() : undefined;
}
