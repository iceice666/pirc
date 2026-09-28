/**
 * A stand-in gateway for trying the Android app without a real deployment:
 * serves one session from the shared timeline fixture, plus a markdown-heavy
 * reply, and streams a new answer word by word whenever the events socket
 * opens. It hands out the control lease, accepts uploads, and echoes prompts
 * back as a streamed reply. Only for local development (plain HTTP).
 *
 *   bun apps/android/dev/fake-gateway.ts            # listens on :8799
 *   adb shell am start -a android.intent.action.VIEW \
 *     -d "pirc://pair?url=http%3A%2F%2F10.0.2.2%3A8799&token=$(bun apps/android/dev/fake-gateway.ts --token)"
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TOKEN = `pirc_dev_${'d'.repeat(43)}`;
if (process.argv.includes('--token')) {
  console.log(TOKEN);
  process.exit(0);
}
const PORT = Number(process.env.PORT ?? 8799);

const fixture = JSON.parse(
  readFileSync(
    path.join(import.meta.dir, '../../../fixtures/timeline/streaming-turn.json'),
    'utf8',
  ),
);

const RICH = `Here is what I found in **the parser**:

1. The tokenizer drops trailing whitespace.
2. \`parseExpr\` never resets its cursor.

\`\`\`ts
export function parseExpr(tokens: Token[], at = 0): Expr {
  const head = tokens[at];
  if (!head) throw new SyntaxError('unexpected end of input, expected an expression here');
  return head.kind === 'number' ? { kind: 'lit', value: Number(head.text) } : parseCall(tokens, at);
}
\`\`\`

| File | Lines | Status |
| --- | ---: | --- |
| lexer.ts | 120 | fixed |
| parser.ts | 342 | needs review |

> Run \`bun test\` again after the change.`;

const snapshot = {
  ...fixture.snapshot,
  partialMessage: null,
  run: { ...fixture.snapshot.run, status: 'succeeded' },
  history: [
    ...fixture.snapshot.history,
    { role: 'user', content: 'Summarise what is wrong with the parser.', timestamp: 8600 },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Look at lexer.ts and parser.ts first.' },
        { type: 'text', text: RICH },
      ],
      model: 'm1',
      stopReason: 'stop',
      timestamp: 8700,
      completedAt: 8800,
    },
  ],
  watermark: { epoch: 2, sequence: 10 },
};

const sessions = [
  snapshot.session,
  {
    ...snapshot.session,
    id: 's2',
    name: 'Settled chore',
    settledAt: 1,
    updatedAt: 100,
    runStatus: 'succeeded',
  },
];

const ANSWER =
  'Streaming works: each word arrives as its own **delta**, and the list stays pinned to the bottom while it grows. ' +
  'Scroll up to stop following; the ↓ button brings you back.';

const json = (value: unknown, status = 200) => Response.json(value, { status });
let sequence = 10;
const event = (type: string, data: unknown) => ({
  sessionId: 's1',
  epoch: 2,
  sequence: ++sequence,
  type,
  timestamp: Date.now(),
  data,
});

/** Open event sockets, for replies to prompts. */
const sockets = new Set<import('bun').ServerWebSocket<unknown>>();
const broadcast = (type: string, data: unknown) => {
  const message = JSON.stringify(event(type, data));
  for (const socket of sockets) socket.send(message);
};
let lease: { clientId: string; generation: number; expiresAt: number } | null = null;
const leaseReply = () => ({
  lease: lease && { ...lease, expired: lease.expiresAt < Date.now() },
});

async function streamReply(text: string, at = Date.now()) {
  broadcast('pi_event', {
    type: 'message_start',
    message: { role: 'assistant', content: [], timestamp: at },
  });
  for (const word of text.split(/(?<= )/)) {
    broadcast('pi_event', {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: word },
    });
    await Bun.sleep(90);
  }
  broadcast('pi_event', {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'm1',
      stopReason: 'stop',
      timestamp: at,
      completedAt: Date.now(),
    },
  });
}

async function body(request: Request): Promise<any> {
  return request.json().catch(() => ({}));
}

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(request, server) {
    const url = new URL(request.url);
    if (request.headers.get('authorization') !== `Bearer ${TOKEN}`)
      return json({ error: { code: 'unauthenticated', message: 'Bad device token' } }, 401);
    if (url.pathname === '/api/events') return server.upgrade(request) ? undefined : json({}, 400);
    if (url.pathname === '/api/sessions') return json({ sessions });
    if (url.pathname === '/api/workspaces')
      return json({ workspaces: [{ id: 'm5pro:pirc', hostId: 'm5pro', displayName: 'pirc' }] });
    if (url.pathname === '/api/nodes')
      return json({ nodes: [{ id: 'm5pro', workspaces: [{ id: 'pirc', displayName: 'pirc' }] }] });
    if (/^\/api\/sessions\/[^/]+\/snapshot$/.test(url.pathname))
      return json({ ...snapshot, watermark: { epoch: 2, sequence } });
    if (url.pathname === '/api/models')
      return json({
        models: [
          { id: 'm1', provider: 'p', name: 'Model One', reasoning: true },
          { id: 'm2', provider: 'p', name: 'Model Two', reasoning: false },
        ],
      });
    const control = /^\/api\/sessions\/[^/]+\/control(?:\/(acquire|heartbeat|release))?$/.exec(
      url.pathname,
    );
    if (control) {
      const input = request.method === 'POST' ? await body(request) : {};
      const live = lease && lease.expiresAt > Date.now();
      if (control[1] === 'acquire') {
        if (live && lease!.clientId !== input.clientId && !input.force)
          return json(
            { error: { code: 'lost_control', message: 'Another client holds control' } },
            409,
          );
        lease = {
          clientId: input.clientId,
          generation: (lease?.generation ?? 0) + 1,
          expiresAt: Date.now() + 30_000,
        };
      } else if (control[1] === 'heartbeat') {
        if (!live || lease!.clientId !== input.clientId || lease!.generation !== input.generation)
          return json({ error: { code: 'lost_control', message: 'Control lease expired' } }, 409);
        lease!.expiresAt = Date.now() + 30_000;
      } else if (control[1] === 'release') {
        lease = null;
        return new Response(null, { status: 204 });
      }
      return json(leaseReply());
    }
    if (/^\/api\/sessions\/[^/]+\/commands$/.test(url.pathname)) {
      const input = await body(request);
      if (!lease || lease.clientId !== input.clientId || lease.generation !== input.generation)
        return json(
          { error: { code: 'lost_control', message: 'Another client holds control' } },
          409,
        );
      const payload = input.payload ?? {};
      if (['prompt', 'steer', 'follow_up'].includes(payload.type)) {
        const at = Date.now();
        broadcast('pi_event', {
          type: 'message_end',
          message: { role: 'user', content: payload.message, timestamp: at },
        });
        void streamReply(
          `You said: “${payload.message}”. This is the fake gateway echoing it back.`,
          at + 1,
        );
      }
      return json({ command: { id: input.commandId, status: 'accepted' }, duplicate: false }, 202);
    }
    if (/^\/api\/sessions\/[^/]+\/uploads$/.test(url.pathname)) {
      const bytes = await request.arrayBuffer();
      return json(
        {
          upload: {
            id: `up-${crypto.randomUUID()}`,
            mimeType: request.headers.get('content-type'),
            byteSize: bytes.byteLength,
          },
        },
        201,
      );
    }
    return json({ error: { code: 'not_found', message: 'Not in the fake gateway' } }, 404);
  },
  websocket: {
    close(socket) {
      sockets.delete(socket);
    },
    async open(socket) {
      sockets.add(socket);
      const send = (type: string, data: unknown) => socket.send(JSON.stringify(event(type, data)));
      const at = Date.now();
      await Bun.sleep(1500);
      send('pi_event', {
        type: 'message_start',
        message: { role: 'assistant', content: [], timestamp: at },
      });
      send('pi_event', {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'Streaming a demo reply.',
        },
      });
      await Bun.sleep(800);
      for (const word of ANSWER.split(/(?<= )/)) {
        send('pi_event', {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: word },
        });
        await Bun.sleep(90);
      }
      send('pi_event', {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Streaming a demo reply.' },
            { type: 'text', text: ANSWER },
          ],
          model: 'm1',
          stopReason: 'stop',
          timestamp: at,
          completedAt: Date.now(),
        },
      });
    },
    message() {},
  },
});
console.log(`fake gateway on http://0.0.0.0:${PORT}; token ${TOKEN}`);
