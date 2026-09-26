/**
 * Child side of the team broker: a reverse RPC over this process's own
 * stdio. Calls go out on stdout as `team_call`; the parent answers on stdin
 * with `team_result` (routed here by serveRpc).
 */
import { randomUUID } from 'node:crypto';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class ParentChannel {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly write: (value: unknown) => void) {}

  call(operation: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        this.write({ type: 'team_cancel', id });
        reject(new Error('Aborted'));
      };
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.write({ type: 'team_call', id, operation, args });
    });
  }

  receive(message: { id?: unknown; result?: unknown; error?: unknown }): void {
    const pending = typeof message.id === 'string' ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    this.pending.delete(message.id as string);
    if (typeof message.error === 'string') pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  closeAll(): void {
    for (const pending of this.pending.values()) pending.reject(new Error('Team channel closed'));
    this.pending.clear();
  }
}

let channel: ParentChannel | undefined;
/** Name of this agent when it runs as a team child. */
export const teamChildName = () => process.env.PIRC_TEAM_AGENT || undefined;
/** `subagent` children are one-shot workers without team tools. */
export const teamChildMode = (): 'team' | 'subagent' | undefined =>
  teamChildName() ? (process.env.PIRC_TEAM_MODE === 'subagent' ? 'subagent' : 'team') : undefined;
export function parentChannel(): ParentChannel {
  channel ??= new ParentChannel((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  return channel;
}
