import type { ProviderConfig } from '../config.js';
import { streamAnthropic } from './anthropic.js';
import { streamOpenAIChat } from './openai-chat.js';
import type { StreamFn } from './types.js';

export function streamFor(provider: ProviderConfig): StreamFn {
  return provider.api === 'anthropic-messages' ? streamAnthropic : streamOpenAIChat;
}

/** Errors worth retrying: rate limits, overload, 5xx, dropped connections. */
export function isRetryable(message: string | undefined): boolean {
  if (!message) return false;
  return /HTTP (408|409|429|5\d\d)|rate.?limit|overloaded|timeout|timed out|ECONNRESET|ECONNREFUSED|socket|network|fetch failed|terminated|unable to connect/i.test(
    message,
  );
}
