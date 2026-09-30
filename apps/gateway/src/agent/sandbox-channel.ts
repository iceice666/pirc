/**
 * Client side of the node's sandbox requests (node/runner.ts handleSandbox).
 * Under a sandboxing node (`PIRC_SANDBOX=srt`) a request goes out on stdout
 * as `sandbox_request` and is answered on stdin by `sandbox_response`
 * (routed here by serveRpc); an aborted tool sends `sandbox_cancel`. The
 * node asks the human itself before it grants anything. Only a node's main
 * agent talks to the node: team members and subagents share its sandbox and
 * forward their requests to it over the team channel (`sandbox_request`),
 * which names them to the human.
 */
import { randomUUID } from 'node:crypto';
import { parentChannel, teamChildName } from './features/team/channel.js';

export type SandboxOp = 'network' | 'exec';

/** Whatever carries this process's sandbox requests to the node. */
export interface SandboxRequester {
  request(
    op: SandboxOp,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, any>>;
}

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

export class NodeSandboxChannel implements SandboxRequester {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly write: (value: unknown) => void) {}

  /** No lost-reply timer: approvals wait for the human, and the node answers every request. */
  request(
    op: SandboxOp,
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

/** What a parent answers a child's `sandbox_request` with. Errors are values: the team channel carries only messages. */
export interface RelayedAnswer {
  result?: Record<string, any>;
  error?: { code: string; message: string };
}

/** A team child's requests go to its parent, which forwards them (relaySandboxRequest). */
const viaParent: SandboxRequester = {
  async request(op, args, signal) {
    const answer = (await parentChannel().call(
      'sandbox_request',
      { op, args },
      signal,
    )) as RelayedAnswer;
    if (answer?.error) throw new SandboxRequestError(answer.error.code, answer.error.message);
    return answer?.result ?? {};
  },
};

/** This process's way to a sandboxing node, or undefined (see module comment). */
export function processSandboxChannel(): SandboxRequester | undefined {
  if (process.env.PIRC_SANDBOX !== 'srt') return undefined;
  return teamChildName() ? viaParent : nodeSandboxChannel();
}

/**
 * The parent's side of a child's `sandbox_request`: pass it on (to the node,
 * or up to this agent's own parent) with the child named in the reason.
 */
export async function relaySandboxRequest(
  child: string,
  message: { op?: unknown; args?: unknown },
  signal?: AbortSignal,
): Promise<RelayedAnswer> {
  const channel = processSandboxChannel();
  if (!channel)
    return {
      error: { code: 'unavailable', message: 'This team is not running inside a node sandbox' },
    };
  if (message.op !== 'network' && message.op !== 'exec')
    return { error: { code: 'invalid_input', message: 'Unknown sandbox operation' } };
  const args: Record<string, unknown> =
    message.args && typeof message.args === 'object'
      ? { ...(message.args as Record<string, unknown>) }
      : {};
  const reason =
    typeof args.reason === 'string' && args.reason.trim()
      ? args.reason.trim()
      : '(no reason given)';
  args.reason = `[asked by ${child}] ${reason}`;
  try {
    return { result: await channel.request(message.op, args, signal) };
  } catch (error) {
    if (error instanceof SandboxRequestError)
      return { error: { code: error.code, message: error.message } };
    throw error;
  }
}
