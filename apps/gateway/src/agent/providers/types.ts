import type { ModelConfig, ProviderConfig, ThinkingLevel } from '../config.js';
import type { AssistantDelta, AssistantMessage, Message } from '../messages.js';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StreamRequest {
  providerName: string;
  provider: ProviderConfig;
  model: ModelConfig;
  apiKey: string | undefined;
  systemPrompt: string;
  messages: Message[];
  tools: ToolSpec[];
  thinking: ThinkingLevel;
  sessionId: string;
  signal: AbortSignal;
  maxTokens?: number;
  toolChoice?: 'auto' | 'none';
}

/**
 * Provider stream: yields deltas and resolves with the final assistant
 * message. Errors are folded into `stopReason:'error'` rather than thrown.
 */
export type StreamFn = (
  request: StreamRequest,
  onDelta: (delta: AssistantDelta, partial: AssistantMessage) => void,
) => Promise<AssistantMessage>;

/** Parse a `text/event-stream` body into `{event, data}` records. */
export async function* sse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = 'message';
          data = [];
        } else if (line.startsWith(':')) continue;
        else {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
        }
      }
    }
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    reader.releaseLock();
  }
}

export async function httpError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return `HTTP ${response.status}: ${text.slice(0, 2000) || response.statusText}`;
}

/** Parse streamed tool-call JSON; malformed JSON becomes `{}` plus a marker so the model sees it. */
export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  } catch {
    return { __invalid_json: raw };
  }
}
