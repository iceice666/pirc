/** Private OAuth subprocess protocol. Never forward stdout to logs or browser events. */
import {
  getOAuthProvider,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
} from '@mariozechner/pi-ai/oauth';
import { createInterface } from 'node:readline';
import { allowlistedEnv } from '../env-allowlist.js';
import { selfCommand } from '../self.js';

export type LoginRunner = (
  providerId: string,
  callbacks: OAuthLoginCallbacks,
) => Promise<OAuthCredentials>;
export type RefreshRunner = (
  providerId: string,
  credentials: OAuthCredentials,
  signal: AbortSignal,
) => Promise<OAuthCredentials>;
type WorkerRequest = { providerId: string; credentials?: OAuthCredentials };
type WorkerEvent =
  | { type: 'auth'; value: Parameters<OAuthLoginCallbacks['onAuth']>[0] }
  | { type: 'progress'; value: string }
  | { type: 'prompt'; id: number; value: Parameters<OAuthLoginCallbacks['onPrompt']>[0] }
  | { type: 'manual'; id: number }
  | {
      type: 'select';
      id: number;
      value: Parameters<NonNullable<OAuthLoginCallbacks['onSelect']>>[0];
    }
  | { type: 'result'; credentials: OAuthCredentials }
  | { type: 'error' };

/**
 * The worker runs provider login code; it needs to find its executable, a
 * temporary directory, certificates and the outbound proxy the gateway uses,
 * never the gateway's node tokens, web search or VAPID keys.
 */
const PROXY_ENV = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
];
export const oauthWorkerEnv = (
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> => ({
  ...allowlistedEnv(env, PROXY_ENV),
  PI_OAUTH_CALLBACK_HOST: '127.0.0.1',
});

async function runWorker(
  request: WorkerRequest,
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  if (callbacks.signal?.aborted) throw new Error('OAuth cancelled');
  const child = Bun.spawn([...selfCommand('gateway'), 'oauth-worker'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    env: oauthWorkerEnv(),
  });
  const abort = () => child.kill('SIGKILL');
  callbacks.signal?.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(abort, 10 * 60_000);
  const send = (value: unknown) => {
    child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const answer = (id: number, promise: Promise<string | undefined>) => {
    void promise.then(
      (value) => {
        if (!callbacks.signal?.aborted) send({ id, value });
      },
      () => abort(),
    );
  };
  try {
    send(request);
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 1_000_000) throw new Error('OAuth protocol limit');
      let index: number;
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        const event = JSON.parse(line) as WorkerEvent;
        if (callbacks.signal?.aborted) throw new Error('OAuth cancelled');
        switch (event.type) {
          case 'auth':
            callbacks.onAuth(event.value);
            break;
          case 'progress':
            callbacks.onProgress?.(event.value);
            break;
          case 'prompt':
            answer(event.id, callbacks.onPrompt(event.value));
            break;
          case 'manual':
            answer(event.id, callbacks.onManualCodeInput!());
            break;
          case 'select':
            answer(event.id, callbacks.onSelect!(event.value));
            break;
          case 'result':
            return event.credentials;
          case 'error':
            throw new Error('OAuth provider failed');
        }
      }
    }
    throw new Error('OAuth worker stopped');
  } finally {
    clearTimeout(deadline);
    callbacks.signal?.removeEventListener('abort', abort);
    child.kill('SIGKILL');
    await child.exited;
  }
}
export const workerLogin: LoginRunner = (providerId, callbacks) =>
  runWorker({ providerId }, callbacks);
export const workerRefresh: RefreshRunner = (providerId, credentials, signal) =>
  runWorker(
    { providerId, credentials },
    {
      signal,
      onAuth: () => {},
      onPrompt: async () => {
        throw new Error('Unexpected refresh prompt');
      },
    },
  );

export async function runOAuthWorker(): Promise<void> {
  console.log = console.info = console.warn = console.error = console.debug = () => {};
  const emit = (event: WorkerEvent) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const controller = new AbortController();
  const waiting = new Map<
    number,
    { resolve: (value: string | undefined) => void; reject: (error: Error) => void }
  >();
  let sequence = 0;
  const wait = (
    event:
      | { type: 'manual' }
      | { type: 'prompt'; value: Parameters<OAuthLoginCallbacks['onPrompt']>[0] }
      | { type: 'select'; value: Parameters<NonNullable<OAuthLoginCallbacks['onSelect']>>[0] },
  ) =>
    new Promise<string | undefined>((resolve, reject) => {
      const id = ++sequence;
      waiting.set(id, { resolve, reject });
      emit({ ...event, id } as WorkerEvent);
    });
  const lines = createInterface({ input: process.stdin });
  let started = false;
  const stop = () => {
    controller.abort();
    for (const entry of waiting.values()) entry.reject(new Error('OAuth cancelled'));
    waiting.clear();
  };
  lines.on('close', stop);
  lines.on('line', (line) => {
    if (line.length > 1_000_000) {
      stop();
      process.exit(1);
    }
    if (started) {
      try {
        const reply = JSON.parse(line);
        const pending = waiting.get(reply.id);
        waiting.delete(reply.id);
        pending?.resolve(reply.value);
      } catch {
        stop();
      }
      return;
    }
    started = true;
    void (async () => {
      try {
        const request = JSON.parse(line) as WorkerRequest;
        const provider = getOAuthProvider(request.providerId);
        if (!provider) throw new Error('Unknown provider');
        const credentials = request.credentials
          ? await provider.refreshToken(request.credentials)
          : await provider.login({
              signal: controller.signal,
              onAuth: (value) => {
                emit({ type: 'auth', value });
              },
              onProgress: (value) => {
                emit({ type: 'progress', value });
              },
              onPrompt: async (value) => (await wait({ type: 'prompt', value })) ?? '',
              onManualCodeInput: async () => (await wait({ type: 'manual' })) ?? '',
              onSelect: (value) => wait({ type: 'select', value }),
            });
        emit({ type: 'result', credentials });
      } catch {
        emit({ type: 'error' });
      } finally {
        stop();
        process.exit(0);
      }
    })();
  });
}
