/** Agent adapter for the authenticated node-local Unix socket. No provider secrets. */
import {
  INFERENCE_BUFFER_MAX_BYTES,
  INFERENCE_REQUEST_MAX_BYTES,
  INFERENCE_STREAM_MAX_BYTES,
  INFERENCE_TIMEOUT_MS,
  inferenceErrorMessage,
  inferenceEventSchema,
  inferenceRequest,
  type InferenceConfig,
} from '../../inference-wire.js';
import { modelsSchema, type ModelsConfig } from '../../models.js';
import { emptyUsage, type AssistantMessage } from '../messages.js';
import type { StreamFn } from './types.js';

async function* lines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > INFERENCE_STREAM_MAX_BYTES) throw new Error('limit');
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        if (Buffer.byteLength(line) > INFERENCE_BUFFER_MAX_BYTES) throw new Error('limit');
        buffer = buffer.slice(newline + 1);
        if (line) yield line;
      }
      if (Buffer.byteLength(buffer) > INFERENCE_BUFFER_MAX_BYTES) throw new Error('limit');
    }
    if (buffer.trim()) throw new Error('incomplete');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function fetchRemoteModels(config: InferenceConfig): Promise<ModelsConfig> {
  const response = await fetch('http://localhost/models', {
    unix: config.socketPath,
    headers: { authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Node model catalog is unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > INFERENCE_BUFFER_MAX_BYTES) throw new Error('Node model catalog exceeds limit');
      chunks.push(value);
    }
    return modelsSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createRemoteStream(config: InferenceConfig): StreamFn {
  return async (request, onDelta) => {
    const partial: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: request.model.api ?? request.provider.api,
      provider: request.providerName,
      model: request.model.id,
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    const failure = (errorMessage: string): AssistantMessage => ({
      ...partial,
      stopReason: request.signal.aborted ? 'aborted' : 'error',
      errorMessage: request.signal.aborted ? 'Inference request cancelled' : errorMessage,
      completedAt: Date.now(),
    });
    const deadline = AbortSignal.timeout(INFERENCE_TIMEOUT_MS);
    const signal = AbortSignal.any([request.signal, deadline]);
    try {
      const body = JSON.stringify(inferenceRequest(request));
      if (Buffer.byteLength(body) > INFERENCE_REQUEST_MAX_BYTES)
        return failure(inferenceErrorMessage('limit_exceeded'));
      const response = await fetch('http://localhost/inference', {
        unix: config.socketPath,
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body,
        signal,
        redirect: 'error',
      });
      if (!response.body) return failure(inferenceErrorMessage('unavailable'));
      for await (const line of lines(response.body)) {
        const event = inferenceEventSchema.parse(JSON.parse(line));
        if (event.type === 'model_delta') {
          onDelta(event.delta, partial);
        } else if (event.type === 'model_end') return event.message;
        else return failure(inferenceErrorMessage(event.code));
      }
      return failure(inferenceErrorMessage('unavailable'));
    } catch {
      return failure(inferenceErrorMessage(deadline.aborted ? 'timeout' : 'unavailable'));
    }
  };
}
