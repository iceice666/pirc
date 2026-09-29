/**
 * Client side of the node's browser (node/browser.ts). Under a node with a
 * browser (`PIRC_BROWSER=1`) a request goes out on stdout as
 * `browser_request` and is answered on stdin by `browser_response` (routed
 * here by serveRpc). An aborted tool sends `browser_cancel`. Only a node's
 * main agent drives the browser: team members and subagents have none.
 */
import { randomUUID } from 'node:crypto';
import { teamChildName } from './features/team/channel.js';

export class BrowserError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserError';
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class NodeBrowser {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly write: (value: unknown) => void) {}

  /**
   * Run a browser operation. No lost-reply timer: some operations wait for
   * the user (handoff); the node answers every request, and the runner
   * closing ends them all.
   */
  request(op: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const settle = () => {
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const onAbort = () => {
        settle();
        this.write({ type: 'browser_cancel', id });
        reject(new BrowserError('aborted', 'Aborted'));
      };
      this.pending.set(id, {
        resolve: (value) => (settle(), resolve(value)),
        reject: (error) => (settle(), reject(error)),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.write({ type: 'browser_request', id, op, args });
    });
  }

  respond(message: { id?: unknown; ok?: unknown; result?: unknown; error?: any }): void {
    const pending = typeof message.id === 'string' ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    if (message.ok === true) return pending.resolve(message.result);
    const error = message.error ?? {};
    pending.reject(
      new BrowserError(
        typeof error.code === 'string' ? error.code : 'browser_error',
        typeof error.message === 'string' ? error.message : 'The browser request failed',
      ),
    );
  }

  closeAll(): void {
    for (const pending of [...this.pending.values()])
      pending.reject(new BrowserError('closed', 'The browser channel closed'));
  }
}

let instance: NodeBrowser | undefined;
export function nodeBrowser(): NodeBrowser {
  instance ??= new NodeBrowser((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  return instance;
}

/** This process's browser, or undefined when it has none (see module comment). */
export function processBrowser(): NodeBrowser | undefined {
  return process.env.PIRC_BROWSER === '1' && !teamChildName() ? nodeBrowser() : undefined;
}
