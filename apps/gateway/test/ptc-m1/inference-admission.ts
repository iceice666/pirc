/** Test-only Unix front door accounts for body receipt before production model_start. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { InferenceConfig } from '../../src/models.js';
import { INFERENCE_REQUEST_MAX_BYTES } from '../../src/inference-wire.js';
import type { ProviderActivity } from './activity.js';

export async function startAdmissionProxy(
  stateDir: string,
  upstream: InferenceConfig,
  activity: ProviderActivity,
  limits: { requestBytes?: number; timeoutMs?: number } = {},
) {
  const requestBytes = limits.requestBytes ?? INFERENCE_REQUEST_MAX_BYTES;
  const timeoutMs = limits.timeoutMs ?? 10 * 60_000;
  if (
    !Number.isSafeInteger(requestBytes) ||
    requestBytes < 1 ||
    requestBytes > INFERENCE_REQUEST_MAX_BYTES ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 600000
  )
    throw new Error('Invalid admission limits');
  const directory = await mkdtemp(path.join(stateDir, 'a-'));
  await chmod(directory, 0o700);
  const config = {
    socketPath: path.join(directory, 'socket'),
    token: randomBytes(32).toString('hex'),
  };
  let closed = false;
  const clients = new Set<import('node:net').Socket>();
  const upstreams = new Set<ReturnType<typeof httpRequest>>();
  const server = createServer((request, response) => {
    const actual = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${config.token}`);
    if (closed || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (
      !(
        (request.method === 'POST' && request.url === '/inference') ||
        (request.method === 'GET' && request.url === '/models')
      )
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    const finish = activity.begin();
    let completed = false;
    let bytes = 0;
    const outgoing = httpRequest(
      {
        socketPath: upstream.socketPath,
        path: request.url,
        method: request.method,
        headers: { authorization: `Bearer ${upstream.token}`, 'content-type': 'application/json' },
      },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, {
          'content-type': incoming.headers['content-type'] ?? 'application/x-ndjson',
        });
        incoming.on('error', stop);
        incoming.pipe(response);
      },
    );
    upstreams.add(outgoing);
    const timer = setTimeout(stop, timeoutMs);
    function done() {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      upstreams.delete(outgoing);
      outgoing.destroy();
      finish();
    }
    function stop() {
      response.destroy();
      request.destroy();
      done();
    }
    request.setTimeout(30000, stop);
    request.on('end', () => request.setTimeout(0));
    request.on('aborted', stop);
    request.on('error', stop);
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > requestBytes) stop();
    });
    outgoing.on('error', stop);
    response.on('finish', done);
    response.on('close', done);
    request.pipe(outgoing);
  });
  server.on('connection', (socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
  });
  server.headersTimeout = 30000;
  server.requestTimeout = 30000;
  server.maxConnections = 64;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(config.socketPath, 0o600);
  } catch {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw new Error('Evaluation admission unavailable');
  }
  return {
    config,
    async close() {
      if (closed) return;
      closed = true;
      for (const outgoing of upstreams) outgoing.destroy();
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
