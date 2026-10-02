import { version } from '../../../package.json';
import { expect, test } from 'bun:test';
import { streamAnthropic } from '../src/agent/providers/anthropic.js';
import { streamOpenAIChat } from '../src/agent/providers/openai-chat.js';
import type { StreamRequest } from '../src/agent/providers/types.js';
import { opencodeGoHeaders } from '../src/agent/providers/opencode-go.js';

for (const [api, stream] of [
  ['openai-chat', streamOpenAIChat],
  ['anthropic-messages', streamAnthropic],
] as const) {
  test(`native ${api} sends OpenCode Go headers on the wire`, async () => {
    const seen: Headers[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(req.headers);
        return new Response('data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    try {
      const request: StreamRequest = {
        providerName: 'go',
        apiKey: undefined,
        provider: {
          api,
          baseUrl: server.url.toString(),
          opencodeGo: true,
          headers: {},
          compat: {},
          models: [],
        },
        model: {
          id: 'model',
          contextWindow: 1000,
          maxTokens: 100,
          reasoning: false,
          input: ['text'],
          compat: {},
        },
        systemPrompt: '',
        messages: [],
        tools: [],
        thinking: 'off',
        sessionId: 'stable-session',
        signal: new AbortController().signal,
      };
      await stream(request, () => {});
      expect(seen[0]?.get('x-opencode-session')).toBe('stable-session');
      expect(seen[0]?.get('user-agent')).toBe(`pirc/${version}`);
      request.provider.opencodeGo = false;
      expect(opencodeGoHeaders(request)).toEqual({});
      request.provider.baseUrl = 'https://opencode.ai.evil.example/zen/go/v1';
      expect(opencodeGoHeaders(request)).toEqual({});
      request.provider.baseUrl = 'https://opencode.ai/zen/gopher';
      expect(opencodeGoHeaders(request)).toEqual({});
    } finally {
      server.stop(true);
    }
  });
}
