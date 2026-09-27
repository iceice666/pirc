/** Private, ephemeral agent → node inference endpoint. Never opens a TCP listener. */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import {
  INFERENCE_BUFFER_MAX_BYTES,
  INFERENCE_MAX_REQUESTS,
  INFERENCE_REQUEST_MAX_BYTES,
  INFERENCE_STREAM_MAX_BYTES,
  INFERENCE_TIMEOUT_MS,
  inferenceRequestSchema,
  type InferenceConfig,
  type InferenceEvent,
  type InferenceErrorCode,
} from '../inference-wire.js';
import type { ModelsConfig } from '../models.js';
import type { NodeToDaemon } from '../protocol.js';

type Outbound = Extract<NodeToDaemon, { type: 'model_start' | 'model_cancel' }>;
interface Pending {
  response: ServerResponse;
  timer: NodeJS.Timeout;
  bytes: number;
}
export async function startNodeInference(options: {
  stateDir: string;
  send: (message: Outbound) => boolean;
  getModels: () => ModelsConfig;
  /** Test seam; production uses the shared bounded deadline. */
  timeoutMs?: number;
}) {
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(options.stateDir, 'i-'));
  await chmod(directory, 0o700);
  const config: InferenceConfig = {
    socketPath: path.join(directory, 'socket'),
    token: randomBytes(32).toString('hex'),
  };
  const pending = new Map<string, Pending>();
  let receiving = 0;
  let closed = false;
  const send = (message: Outbound) => {
    try {
      return options.send(message);
    } catch {
      return false;
    }
  };
  const remove = (requestId: string) => {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    clearTimeout(request.timer);
    return request;
  };
  const fail = (requestId: string, code: InferenceErrorCode, cancel = true) => {
    const request = remove(requestId);
    if (!request) return;
    if (cancel) send({ type: 'model_cancel', requestId });
    request.response.end(JSON.stringify({ type: 'model_error', code }) + '\n');
  };
  const receive = (requestId: string, event: InferenceEvent) => {
    const request = pending.get(requestId);
    if (!request) return;
    const line = JSON.stringify(event) + '\n';
    const size = Buffer.byteLength(line);
    request.bytes += size;
    if (
      size > INFERENCE_BUFFER_MAX_BYTES ||
      request.response.writableLength + size > INFERENCE_BUFFER_MAX_BYTES ||
      request.bytes > INFERENCE_STREAM_MAX_BYTES
    ) {
      fail(requestId, 'limit_exceeded');
      return;
    }
    if (event.type === 'model_delta') request.response.write(line);
    else {
      remove(requestId);
      request.response.end(line);
    }
  };
  const error = (response: ServerResponse, status: number, code: InferenceErrorCode) => {
    response.writeHead(status, {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify({ type: 'model_error', code }) + '\n');
  };
  const server = createServer(async (request, response) => {
    const actual = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${config.token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return error(response, 401, 'unavailable');
    if (closed) return error(response, 503, 'unavailable');
    if (request.method === 'GET' && request.url === '/models') {
      const body = JSON.stringify(options.getModels());
      if (Buffer.byteLength(body) > INFERENCE_BUFFER_MAX_BYTES)
        return error(response, 503, 'limit_exceeded');
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(body);
      return;
    }
    if (request.method !== 'POST' || request.url !== '/inference')
      return error(response, 404, 'invalid_request');
    if (pending.size + receiving >= INFERENCE_MAX_REQUESTS)
      return error(response, 429, 'limit_exceeded');
    receiving++;
    let requestId: string | undefined;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      request.setTimeout(30_000, () => request.destroy());
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > INFERENCE_REQUEST_MAX_BYTES) return error(response, 413, 'limit_exceeded');
        chunks.push(Buffer.from(chunk));
      }
      request.setTimeout(0);
      if (closed || response.destroyed) return;
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return error(response, 400, 'invalid_request');
      }
      const parsed = inferenceRequestSchema.safeParse(value);
      if (!parsed.success) return error(response, 400, 'invalid_request');
      requestId = randomUUID();
      const id = requestId;
      response.writeHead(200, {
        'content-type': 'application/x-ndjson',
        'cache-control': 'no-store',
      });
      response.flushHeaders();
      const timer = setTimeout(
        () => fail(id, 'timeout'),
        options.timeoutMs ?? INFERENCE_TIMEOUT_MS,
      );
      timer.unref();
      pending.set(id, { response, timer, bytes: 0 });
      response.on('close', () => {
        if (remove(id)) send({ type: 'model_cancel', requestId: id });
      });
      if (!send({ type: 'model_start', requestId: id, request: parsed.data }))
        fail(id, 'unavailable', false);
    } catch {
      if (requestId) fail(requestId, 'unavailable');
      else if (!response.destroyed) error(response, 400, 'invalid_request');
    } finally {
      receiving--;
    }
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 30_000;
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
  } catch (error) {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    config,
    receive,
    disconnect() {
      for (const id of pending.keys()) fail(id, 'unavailable', false);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const id of pending.keys()) fail(id, 'unavailable');
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
