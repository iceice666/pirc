/**
 * Scripted OpenAI Chat / Anthropic Messages SSE server for agent tests.
 * Each request pops the next scripted reply; received bodies are recorded.
 */
export type Reply =
  | { text: string; thinking?: string; promptTokens?: number }
  | { tool: { id: string; name: string; args: Record<string, unknown> }; text?: string }
  | { status: number; body: string }
  | { hang: true }
  /** Compute the reply from the request body. */
  | { dynamic: (body: any) => Reply };

export interface FakeLlm {
  url: string;
  requests: Array<{ path: string; body: any; headers: Record<string, string> }>;
  push(...replies: Reply[]): void;
  stop(): void;
  /** Consulted before the queue; return undefined to fall through. */
  route?: ((body: any, path: string) => Reply | undefined) | undefined;
}

const encoder = new TextEncoder();

function openai(reply: Reply): string[] {
  const chunk = (delta: unknown, finish: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const out: string[] = [];
  if ('thinking' in reply && reply.thinking) out.push(chunk({ reasoning_content: reply.thinking }));
  if ('text' in reply && reply.text) {
    const half = Math.ceil(reply.text.length / 2);
    out.push(
      chunk({ content: reply.text.slice(0, half) }),
      chunk({ content: reply.text.slice(half) }),
    );
  }
  if ('tool' in reply) {
    const args = JSON.stringify(reply.tool.args);
    out.push(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: reply.tool.id,
            type: 'function',
            function: { name: reply.tool.name, arguments: '' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, 5) } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] }),
      chunk({}, 'tool_calls'),
    );
  } else out.push(chunk({}, 'stop'));
  out.push(
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 'promptTokens' in reply && reply.promptTokens ? reply.promptTokens : 100, completion_tokens: 10, total_tokens: ('promptTokens' in reply && reply.promptTokens ? reply.promptTokens : 100) + 10, prompt_tokens_details: { cached_tokens: 40 } } })}\n\n`,
    'data: [DONE]\n\n',
  );
  return out;
}

function anthropic(reply: Reply): string[] {
  const ev = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const out = [
    ev('message_start', {
      message: { usage: { input_tokens: 50, cache_read_input_tokens: 20, output_tokens: 1 } },
    }),
  ];
  let index = 0;
  if ('thinking' in reply && reply.thinking) {
    out.push(
      ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } }),
      ev('content_block_delta', {
        index,
        delta: { type: 'thinking_delta', thinking: reply.thinking },
      }),
      ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'sig' } }),
      ev('content_block_stop', { index }),
    );
    index++;
  }
  if ('text' in reply && reply.text) {
    out.push(
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: reply.text } }),
      ev('content_block_stop', { index }),
    );
    index++;
  }
  if ('tool' in reply) {
    out.push(
      ev('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: reply.tool.id, name: reply.tool.name, input: {} },
      }),
      ev('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.tool.args) },
      }),
      ev('content_block_stop', { index }),
    );
  }
  out.push(
    ev('message_delta', {
      delta: { stop_reason: 'tool' in reply ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: 12 },
    }),
    ev('message_stop', {}),
  );
  return out;
}

export function startFakeLlm(): FakeLlm {
  const queue: Reply[] = [];
  const requests: FakeLlm['requests'] = [];
  const api = { requests } as FakeLlm;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.json();
      requests.push({ path: url.pathname, body, headers: Object.fromEntries(request.headers) });
      let reply = api.route?.(body, url.pathname) ?? queue.shift() ?? { text: 'default reply' };
      while ('dynamic' in reply) reply = reply.dynamic(body);
      if ('status' in reply) return new Response(reply.body, { status: reply.status });
      if ('hang' in reply)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(': keepalive\n\n'));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      const events = url.pathname.endsWith('/v1/messages') ? anthropic(reply) : openai(reply);
      return new Response(
        new ReadableStream({
          async start(controller) {
            for (const event of events) {
              controller.enqueue(encoder.encode(event));
              await Bun.sleep(1);
            }
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  Object.assign(api, {
    url: `http://127.0.0.1:${server.port}`,
    push: (...replies: Reply[]) => queue.push(...replies),
    stop: () => server.stop(true),
  });
  return api;
}
