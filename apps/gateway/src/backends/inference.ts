/** Gateway-only model execution. No provider configuration is accepted from a node. */
import type { AssistantDelta, AssistantMessage } from '../agent/messages.js';
import { emptyUsage } from '../agent/messages.js';
import { streamFor } from '../agent/providers/index.js';
import type { StreamFn } from '../agent/providers/types.js';
import type { InferenceRequest } from '../inference-wire.js';
import type { ModelConfig, ProviderConfig } from '../models.js';
import { streamPi } from './pi-adapter.js';

export interface BackendResolver {
  resolve(
    providerName: string,
    modelId: string,
  ): Promise<{
    provider: ProviderConfig;
    model: ModelConfig;
    apiKey?: string | undefined;
  }>;
}

/** Preserve actionable classifications, never reflect upstream response bodies/URLs/tokens. */
export function safeInferenceError(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (
    /context.?length|context.?window|too many tokens|prompt is too long|input is too long|request too large|HTTP 413/i.test(
      text,
    )
  )
    return 'Model context window exceeded';
  const status = /HTTP\s*(4\d\d|5\d\d)\b/i.exec(text)?.[1];
  if (status) return `Model request failed (HTTP ${status})`;
  if (/rate.?limit|overloaded/i.test(text)) return 'Model rate limit exceeded';
  if (/timed? ?out|timeout/i.test(text)) return 'Model request timed out';
  if (/ECONNRESET|ECONNREFUSED|network|fetch failed|unable to connect/i.test(text))
    return 'Model network request failed';
  return 'Model request failed; check backend configuration or sign in again';
}

export class GatewayInference {
  private readonly active = new Set<AbortController>();
  constructor(
    private readonly backends: BackendResolver,
    private readonly piStream: StreamFn = streamPi,
    private readonly nativeStream: (provider: ProviderConfig) => StreamFn = streamFor,
  ) {}

  /** Configuration/account changes invalidate in-flight requests, not just future tokens. */
  cancelAll(): void {
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }

  async run(
    request: InferenceRequest,
    signal: AbortSignal,
    onDelta: (delta: AssistantDelta, partial: AssistantMessage) => void,
    nodeId: string,
  ): Promise<AssistantMessage> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    this.active.add(controller);
    let message: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: '',
      provider: request.providerName,
      model: request.modelId,
      usage: emptyUsage(),
      stopReason: 'error',
      timestamp: Date.now(),
    };
    try {
      if (controller.signal.aborted) throw new Error('Aborted');
      const resolved = await this.backends.resolve(request.providerName, request.modelId);
      if (controller.signal.aborted) throw new Error('Aborted');
      const { model, provider } = resolved;
      message.api = model.api ?? provider.api;
      const usePi =
        !!provider.piProvider ||
        !!model.api ||
        !['openai-chat', 'anthropic-messages'].includes(provider.api);
      const stream = usePi ? this.piStream : this.nativeStream(provider);
      message = await stream(
        {
          providerName: request.providerName,
          provider,
          model,
          apiKey: resolved.apiKey,
          systemPrompt: request.systemPrompt,
          messages: request.messages,
          tools: request.tools,
          thinking: model.reasoning ? request.thinking : 'off',
          // Separate transport caches for node/session/backend, not a caller-selected global key.
          sessionId: JSON.stringify([nodeId, request.sessionId, request.providerName]),
          signal: controller.signal,
          ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
          ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
        },
        (delta, partial) => {
          if (!controller.signal.aborted) {
            message = partial;
            onDelta(delta, partial);
          }
        },
      );
      // Native adapters may embed upstream bodies; pi-ai adapter messages are already classified.
      if (message.errorMessage && !usePi)
        message.errorMessage = safeInferenceError(message.errorMessage);
      if (controller.signal.aborted) {
        message.stopReason = 'aborted';
        message.errorMessage = 'Model request cancelled';
      }
      return message;
    } catch (error) {
      return {
        ...message,
        stopReason: controller.signal.aborted ? 'aborted' : 'error',
        errorMessage: controller.signal.aborted
          ? 'Model request cancelled'
          : safeInferenceError(error),
      };
    } finally {
      signal.removeEventListener('abort', abort);
      this.active.delete(controller);
    }
  }
}
