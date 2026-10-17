/** Small OpenAI-compatible scripted model used by the isolated Rust-node helper. */
import { createServer } from 'node:http';

type ToolSpec = { id: string; name: string; args: Record<string, unknown> };
export type Reply =
  | { text: string; thinking?: string; promptTokens?: number }
  | { tool: ToolSpec; also?: ToolSpec[]; text?: string }
  | { status: number; body: string }
  | { hang: true; text?: string }
  | { dynamic: (body: any) => Reply };

export interface FakeLlm {
  url: string;
  requests: Array<{ path: string; body: any; headers: Record<string, string> }>;
  push(...replies: Reply[]): void;
  stop(): void;
  route?: ((body: any, path: string) => Reply | undefined) | undefined;
}

function openAiEvents(reply: Reply): string[] {
  if ('status' in reply || 'hang' in reply) {
    throw new Error('A non-streaming fake reply reached the OpenAI encoder.');
  }
  const chunk = (delta: unknown, finish: string | null = null) =>
    'data: ' +
    JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) +
    '\n\n';
  const out: string[] = [];
  if ('thinking' in reply && reply.thinking)
    out.push(chunk({ reasoning_content: reply.thinking }));
  if ('text' in reply && reply.text) {
    const half = Math.ceil(reply.text.length / 2);
    out.push(
      chunk({ content: reply.text.slice(0, half) }),
      chunk({ content: reply.text.slice(half) }),
    );
  }
  if ('tool' in reply) {
    [reply.tool, ...(reply.also ?? [])].forEach((tool, index) => {
      const args = JSON.stringify(tool.args);
      out.push(
        chunk({
          tool_calls: [
            { index, id: tool.id, type: 'function', function: { name: tool.name, arguments: '' } },
          ],
        }),
        chunk({ tool_calls: [{ index, function: { arguments: args.slice(0, 5) } }] }),
        chunk({ tool_calls: [{ index, function: { arguments: args.slice(5) } }] }),
      );
    });
    out.push(chunk({}, 'tool_calls'));
  } else {
    out.push(chunk({}, 'stop'));
  }
  const promptTokens = 'promptTokens' in reply && reply.promptTokens ? reply.promptTokens : 100;
  out.push(
    'data: ' +
      JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: 10,
          total_tokens: promptTokens + 10,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }) +
      '\n\n',
    'data: [DONE]\n\n',
  );
  return out;
}

async function requestBody(request: import('node:http').IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function startFakeLlm(): Promise<FakeLlm> {
  const queue: Reply[] = [];
  const requests: FakeLlm['requests'] = [];
  const api = { requests } as FakeLlm;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://' + (request.headers.host ?? '127.0.0.1'));
    if (request.method === 'GET' && url.pathname.endsWith('/v1/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    if (request.method !== 'POST' || !url.pathname.endsWith('/v1/chat/completions')) {
      response.writeHead(404);
      response.end();
      return;
    }
    let body: any;
    try {
      body = JSON.parse((await requestBody(request)).toString('utf8'));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }));
      return;
    }
    const headers = Object.fromEntries(
      Object.entries(request.headers).flatMap(([key, value]) =>
        value === undefined
          ? []
          : [[key, Array.isArray(value) ? value.join(', ') : value]],
      ),
    ) as Record<string, string>;
    requests.push({ path: url.pathname, body, headers });
    let reply = api.route?.(body, url.pathname) ?? queue.shift() ?? { text: 'default reply' };
    while ('dynamic' in reply) reply = reply.dynamic(body);
    if ('status' in reply) {
      response.writeHead(reply.status, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(reply.body);
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    if ('hang' in reply) {
      response.write(': keepalive\n\n');
      if (reply.text) {
        response.write(
          'data: ' +
            JSON.stringify({
              choices: [{ index: 0, delta: { content: reply.text }, finish_reason: null }],
            }) +
            '\n\n',
        );
      }
      return;
    }
    for (const event of openAiEvents(reply)) {
      if (response.destroyed) return;
      response.write(event);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake model server did not bind TCP.');
  Object.assign(api, {
    url: 'http://127.0.0.1:' + address.port,
    push: (...replies: Reply[]) => queue.push(...replies),
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  });
  return api;
}
