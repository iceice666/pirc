/**
 * A stand-in gateway for trying the Android app without a real deployment:
 * serves one session from the shared timeline fixture, plus a markdown-heavy
 * reply, and streams a new answer word by word whenever the events socket
 * opens. Only for local development (plain HTTP on the emulator's host alias).
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

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch(request, server) {
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
    return json({ error: { code: 'not_found', message: 'Not in the fake gateway' } }, 404);
  },
  websocket: {
    async open(socket) {
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
