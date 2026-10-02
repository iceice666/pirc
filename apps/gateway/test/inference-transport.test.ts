import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { startNodeInference } from '../src/node/inference.js';
import { createRemoteStream, fetchRemoteModels } from '../src/agent/providers/remote.js';
import { emptyUsage, type AssistantMessage } from '../src/agent/messages.js';
import type { StreamRequest } from '../src/agent/providers/types.js';
import {
  INFERENCE_REQUEST_MAX_BYTES,
  inferenceRequest,
  inferenceRequestSchema,
} from '../src/inference-wire.js';
import { ModelStore, modelsSchema } from '../src/models.js';
import { NodeRegistry } from '../src/daemon/nodes.js';
import { NODE_PROTOCOL_VERSION, type NodeToDaemon } from '../src/protocol.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const models = modelsSchema.parse({
  providers: {
    test: {
      api: 'openai-chat',
      baseUrl: 'https://secret.invalid',
      apiKey: 'provider-secret',
      headers: { authorization: 'header-secret' },
      models: [{ id: 'model' }],
    },
  },
});
function request(signal = new AbortController().signal): StreamRequest {
  return {
    providerName: 'test',
    provider: models.providers.test!,
    model: models.providers.test!.models[0]!,
    apiKey: 'request-secret',
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
    tools: [],
    thinking: 'off',
    sessionId: 'session',
    signal,
  };
}
const final: AssistantMessage = {
  role: 'assistant',
  api: 'openai-chat',
  provider: 'test',
  model: 'model',
  content: [{ type: 'text', text: 'hello', textSignature: 'sig' }],
  usage: emptyUsage(),
  stopReason: 'stop',
  timestamp: 1,
  responseId: 'response',
  canonicalProvider: 'openai',
};
async function relay(
  send: (message: Extract<NodeToDaemon, { type: 'model_start' | 'model_cancel' }>) => boolean,
  timeoutMs?: number,
) {
  const stateDir = await mkdtemp('/tmp/pirc-i-');
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const server = await startNodeInference({
    stateDir,
    send,
    getModels: () => ({ ...models, inference: server.config }),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  cleanups.push(() => server.close());
  return server;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

describe('node-local inference transport', () => {
  test('authenticates Unix socket, projects requests, preserves replay metadata and cleans socket', async () => {
    let sent = '';
    const server = await relay((message) => {
      if (message.type === 'model_start') {
        sent = JSON.stringify(message);
        server.receive(message.requestId, {
          type: 'model_delta',
          delta: { type: 'text_delta', contentIndex: 0, delta: 'hello' },
        });
        server.receive(message.requestId, { type: 'model_end', message: final });
      }
      return true;
    });
    expect((await stat(server.config.socketPath)).mode & 0o777).toBe(0o600);
    const forbidden = await fetch('http://localhost/models', { unix: server.config.socketPath });
    expect(forbidden.status).toBe(401);
    await forbidden.text();
    expect((await fetchRemoteModels(server.config)).inference).toEqual(server.config);
    const deltas: string[] = [];
    expect(
      await createRemoteStream(server.config)(request(), (delta) => deltas.push(delta.type)),
    ).toEqual(final);
    expect(deltas).toEqual(['text_delta']);
    for (const secret of [
      'provider-secret',
      'header-secret',
      'request-secret',
      'secret.invalid',
      'apiKey',
      'baseUrl',
    ])
      expect(sent).not.toContain(secret);
    expect(JSON.parse(sent).request.modelId).toBe('model');
    expect(JSON.parse(sent).requestId).toMatch(/^[a-f0-9-]{36}$/);
    await server.close();
    expect(await stat(server.config.socketPath).catch(() => null)).toBeNull();
  });
  test('abort cancels exactly once with node-generated id and does not retry', async () => {
    const messages: NodeToDaemon[] = [];
    const server = await relay((message) => {
      messages.push(message);
      return true;
    });
    const abort = new AbortController();
    const pending = createRemoteStream(server.config)(request(abort.signal), () => {});
    await until(() => messages.length === 1);
    abort.abort();
    expect((await pending).stopReason).toBe('aborted');
    await until(() => messages.length === 2);
    expect(messages[1]).toEqual({
      type: 'model_cancel',
      requestId: (messages[0] as { requestId: string }).requestId,
    });
  });
  test('disconnect terminates active streams without retry; timeouts cancel relay', async () => {
    let count = 0;
    const server = await relay(() => {
      count++;
      return true;
    });
    const pending = createRemoteStream(server.config)(request(), () => {});
    await until(() => count === 1);
    server.disconnect();
    expect((await pending).errorMessage).toBe('Gateway inference is unavailable');
    expect(count).toBe(1);
    const timed: NodeToDaemon[] = [];
    const timeoutServer = await relay((message) => {
      timed.push(message);
      return true;
    }, 20);
    expect((await createRemoteStream(timeoutServer.config)(request(), () => {})).errorMessage).toBe(
      'Inference request timed out',
    );
    expect(timed.map((message) => message.type)).toEqual(['model_start', 'model_cancel']);
  });
  test('rejects oversize requests locally and malformed/secret-bearing wire input', async () => {
    let sent = 0;
    const server = await relay(() => {
      sent++;
      return true;
    });
    const large = request();
    large.systemPrompt = 'x'.repeat(INFERENCE_REQUEST_MAX_BYTES);
    expect((await createRemoteStream(server.config)(large, () => {})).errorMessage).toContain(
      'limit',
    );
    expect(sent).toBe(0);
    const payload = { ...inferenceRequest(request()), apiKey: 'forbidden' };
    expect(inferenceRequestSchema.safeParse(payload).success).toBe(false);
    const response = await fetch('http://localhost/inference', {
      unix: server.config.socketPath,
      method: 'POST',
      headers: { authorization: `Bearer ${server.config.token}` },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('forbidden');
    expect(sent).toBe(0);
  });
});

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  frames: Record<string, any>[] = [];
  send(frame: string, callback?: (error?: Error) => void) {
    this.frames.push(JSON.parse(frame));
    callback?.();
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  input(message: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }
}
function registry() {
  const store = new ModelStore();
  store.set(models);
  const nodes = new NodeRegistry(store);
  cleanups.push(() => nodes.close());
  const socket = new FakeSocket();
  nodes.attach('node', socket as unknown as WebSocket);
  socket.input({ type: 'register', role: 'node', protocol: NODE_PROTOCOL_VERSION, workspaces: [] });
  return { nodes, socket };
}
describe('gateway inference multiplexing', () => {
  test('catalogs are secret-free and streams are correlated without repeated partials', async () => {
    const { nodes, socket } = registry();
    expect(JSON.stringify(socket.frames)).not.toContain('provider-secret');
    expect(JSON.stringify(socket.frames)).not.toContain('header-secret');
    nodes.onInference = async (input, signal, delta, nodeId) => {
      expect(input.modelId).toBe('model');
      expect(signal.aborted).toBe(false);
      expect(nodeId).toBe('node');
      delta({ type: 'text_delta', contentIndex: 0, delta: 'hello' }, final);
      return final;
    };
    socket.input({
      type: 'model_start',
      requestId: 'request',
      request: inferenceRequest(request()),
    });
    await until(() => socket.frames.some((frame) => frame.type === 'model_end'));
    expect(socket.frames[1]).toEqual({
      type: 'model_delta',
      requestId: 'request',
      delta: { type: 'text_delta', contentIndex: 0, delta: 'hello' },
    });
    expect(socket.frames[2]!.message).toEqual(final);
  });
  test('disconnect and cancellation abort provider, ignore late results and sanitize throws', async () => {
    const { nodes, socket } = registry();
    let signal: AbortSignal | undefined;
    let resolve!: (message: AssistantMessage) => void;
    nodes.onInference = async (_request, current) => {
      signal = current;
      return new Promise((done) => {
        resolve = done;
      });
    };
    socket.input({
      type: 'model_start',
      requestId: 'request',
      request: inferenceRequest(request()),
    });
    socket.input({ type: 'model_cancel', requestId: 'request' });
    expect(signal?.aborted).toBe(true);
    resolve(final);
    await Bun.sleep(0);
    expect(socket.frames).toHaveLength(1);
    socket.input({
      type: 'model_start',
      requestId: 'another',
      request: inferenceRequest(request()),
    });
    socket.close();
    expect(signal?.aborted).toBe(true);
    const second = registry();
    second.nodes.onInference = async () => {
      throw new Error('provider-secret');
    };
    second.socket.input({
      type: 'model_start',
      requestId: 'failure',
      request: inferenceRequest(request()),
    });
    await until(() => second.socket.frames.length === 2);
    expect(second.socket.frames[1]).toEqual({
      type: 'model_error',
      requestId: 'failure',
      code: 'inference_failed',
    });
  });
  test('buffer limits abort a provider rather than queueing indefinitely', async () => {
    const { nodes, socket } = registry();
    let signal: AbortSignal | undefined;
    nodes.onInference = async (_request, current, delta) => {
      signal = current;
      socket.bufferedAmount = 16 * 1024 * 1024;
      delta({ type: 'text_delta', contentIndex: 0, delta: 'hello' }, final);
      return final;
    };
    socket.input({
      type: 'model_start',
      requestId: 'request',
      request: inferenceRequest(request()),
    });
    expect(signal?.aborted).toBe(true);
    expect(socket.readyState).toBe(3);
  });
});
