/**
 * A stand-in gateway for trying the Android app without a real deployment:
 * serves one session from the shared timeline fixture, plus a markdown-heavy
 * reply, and streams a new answer word by word whenever the events socket
 * opens. It hands out the control lease, accepts uploads, and echoes prompts
 * back as a streamed reply. Only for local development (plain HTTP).
 *
 *   bun apps/android/dev/fake-gateway.ts            # listens on 127.0.0.1:8799
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

const sessions: Array<Record<string, any>> = [
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

/** A small in-memory workspace for the files panel (never the real disk). */
const FILES: Record<string, string> = {
  'README.md':
    '# Demo workspace\n\nSee [the parser](src/parser.ts#L3-L5) and `src/lexer.ts:2`.\n\n- [notes](docs/notes.md)\n',
  'docs/notes.md': 'Back to [the README](../README.md).\n',
  'src/lexer.ts':
    "export type Token = { kind: 'number' | 'name'; text: string };\nexport const tokenize = (source: string): Token[] =>\n  source.trim().split(/\\s+/).map((text) => ({ kind: /^\\d/.test(text) ? 'number' : 'name', text }));\n",
  'src/parser.ts': RICH.split('```ts\n')[1]!.split('```')[0]!,
};
function listing(dir: string) {
  const prefix = dir ? `${dir}/` : '';
  const names = new Map<string, 'dir' | 'file'>();
  for (const file of Object.keys(FILES))
    if (file.startsWith(prefix)) {
      const [head, ...rest] = file.slice(prefix.length).split('/');
      names.set(head!, rest.length ? 'dir' : 'file');
    }
  if (dir && !names.size) return null;
  return {
    path: dir,
    truncated: false,
    entries: [...names]
      .map(([name, kind]) => ({
        name,
        kind,
        ...(kind === 'file' ? { size: FILES[prefix + name]!.length } : {}),
      }))
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
      ),
  };
}

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

const DIFF = [
  'diff --git a/src/parser.ts b/src/parser.ts',
  'index 1111111..2222222 100644',
  '--- a/src/parser.ts',
  '+++ b/src/parser.ts',
  '@@ -1,4 +1,5 @@',
  ' export function parseExpr(tokens: Token[], at = 0): Expr {',
  '   const head = tokens[at];',
  "-  if (!head) throw new Error('eof');",
  "+  if (!head) throw new SyntaxError('unexpected end of input, expected an expression here');",
  '+  // Numbers are literals; anything else starts a call.',
  "   return head.kind === 'number' ? { kind: 'lit', value: Number(head.text) } : parseCall(tokens, at);",
  '',
].join('\n');
const COMMITS = Array.from({ length: 8 }, (_, index) => ({
  sha: `${index}`.padStart(40, 'a'),
  short: `${index}`.padStart(7, 'a'),
  author: 'Demo Author',
  email: 'demo@example.com',
  time: Date.now() - index * 3_600_000,
  refs: index === 0 ? ['HEAD -> main', 'origin/main'] : [],
  subject: ['Fix the parser cursor', 'Tokenize trailing whitespace', 'Add the lexer'][index % 3]!,
}));
const tasks = [
  {
    id: 'bg1',
    command: 'bun test --watch',
    cwd: '/w',
    status: 'running',
    pid: 42,
    exited: false,
    startedAt: new Date().toISOString(),
  },
  {
    id: 'bg2',
    command: 'bun run build',
    cwd: '/w',
    status: 'completed',
    exitCode: 0,
    exited: true,
    startedAt: new Date().toISOString(),
  },
];
const meter = (value: number, max: number) => ({ value, max });
const terminals: Array<{
  id: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  exitCode: null;
  exited: boolean;
}> = [];
const leaseHeld = (input: any) =>
  lease && lease.clientId === input.clientId && lease.generation === input.generation;

Bun.serve({
  port: PORT,
  // The emulator reaches the host's loopback as 10.0.2.2; nothing else needs to.
  hostname: '127.0.0.1',
  async fetch(request, server) {
    const url = new URL(request.url);
    if (request.headers.get('authorization') !== `Bearer ${TOKEN}`)
      return json({ error: { code: 'unauthenticated', message: 'Bad device token' } }, 401);
    if (url.pathname === '/api/events')
      return server.upgrade(request, { data: { kind: 'events' } }) ? undefined : json({}, 400);
    const stream = /^\/api\/sessions\/[^/]+\/terminals\/([^/]+)\/stream$/.exec(url.pathname);
    if (stream)
      return server.upgrade(request, { data: { kind: 'terminal', id: stream[1] } })
        ? undefined
        : json({}, 400);
    if (url.pathname === '/api/sessions' && request.method === 'POST') {
      const created = {
        ...snapshot.session,
        id: `s-${crypto.randomUUID()}`,
        name: 'New session',
        pinnedAt: null,
        settledAt: null,
        updatedAt: Date.now(),
      };
      sessions.unshift(created);
      return json({ session: created }, 201);
    }
    if (url.pathname === '/api/sessions') return json({ sessions });
    const patch = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (patch && request.method === 'PATCH') {
      const input = await body(request);
      const index = sessions.findIndex((item) => item.id === patch[1]);
      if (index < 0)
        return json({ error: { code: 'not_found', message: 'Session not found' } }, 404);
      const current = sessions[index]!;
      sessions[index] = {
        ...current,
        ...(input.name ? { name: input.name } : {}),
        ...(input.pinned === undefined ? {} : { pinnedAt: input.pinned ? Date.now() : null }),
        ...(input.settled === undefined ? {} : { settledAt: input.settled ? Date.now() : null }),
      };
      return json({ session: sessions[index] });
    }
    if (url.pathname === '/api/workspaces' && request.method === 'POST')
      return json(
        { error: { code: 'invalid_input', message: 'The fake gateway has one fixed workspace' } },
        400,
      );
    const panel =
      /^\/api\/sessions\/[^/]+\/(git\/status|git\/diff|git\/log|git\/commits\/[0-9a-f]+|panel\/state|panel\/background\/[^/]+(?:\/stop)?|terminals(?:\/[^/]+\/close)?)$/.exec(
        url.pathname,
      );
    if (panel) {
      const route = panel[1]!;
      if (route === 'git/status')
        return json({
          repo: true,
          root: '/w',
          branch: 'main',
          upstream: 'origin/main',
          ahead: 1,
          behind: 0,
          truncated: false,
          files: [
            { path: 'src/parser.ts', index: 'M', worktree: ' ' },
            { path: 'src/lexer.ts', index: ' ', worktree: 'M' },
            { path: 'docs/new.md', index: '?', worktree: '?' },
          ],
        });
      if (route === 'git/diff') return json({ diff: DIFF, truncated: false });
      if (route === 'git/log') {
        const skip = Number(url.searchParams.get('skip') ?? 0);
        return json({ commits: COMMITS.slice(skip, skip + 5), more: skip + 5 < COMMITS.length });
      }
      if (route.startsWith('git/commits/')) {
        const commit = COMMITS.find((item) => item.sha === route.slice(12)) ?? COMMITS[0]!;
        return json({
          ...commit,
          message: `${commit.subject}\n\nA longer explanation of the change.`,
          diff: DIFF,
          truncated: false,
        });
      }
      if (route === 'panel/state')
        return json({
          agentRunning: true,
          memory: {
            enabled: true,
            passive: false,
            thresholds: {
              observation: meter(6_200, 10_000),
              reflection: meter(4_000, 20_000),
              compaction: meter(38_000, 81_000),
              visiblePool: meter(9_000, 20_000),
              activePool: meter(7_500, 10_000),
            },
            counts: {
              observations: 3,
              active: 2,
              dropped: 1,
              visibleObservations: 2,
              reflections: 1,
              visibleReflections: 1,
              compactions: 0,
            },
            observations: [
              {
                id: 'aaaaaaaaaaa1',
                content: 'The user prefers small commits.',
                timestamp: '10:02',
                relevance: 'critical',
                tokenCount: 12,
                dropped: false,
                visible: true,
              },
              {
                id: 'aaaaaaaaaaa2',
                content: 'parser.ts never resets its cursor.',
                timestamp: '10:05',
                relevance: 'high',
                tokenCount: 14,
                dropped: false,
                visible: true,
              },
              {
                id: 'aaaaaaaaaaa3',
                content: 'Ran bun test once.',
                timestamp: '10:06',
                relevance: 'low',
                tokenCount: 6,
                dropped: true,
                visible: false,
              },
            ],
            reflections: [
              {
                id: 'bbbbbbbbbbb1',
                content: 'Work on the parser: the cursor bug is the root cause.',
                supportingObservationIds: ['aaaaaaaaaaa2'],
                tokenCount: 18,
                visible: true,
              },
            ],
          },
          memoryRuntime: {
            phase: 'observer',
            autoCompacting: false,
            rateLimited: [],
            lastErrors: {},
          },
          backgroundTasks: tasks,
          team: {
            agents: [
              {
                name: 'scout',
                mode: 'subagent',
                status: 'running',
                model: 'm2',
                task: 'Read the lexer and report the token kinds.',
              },
            ],
            tasks: [
              {
                id: '1',
                subject: 'Fix the cursor',
                description: '',
                status: 'in_progress',
                owner: 'main',
                blockedBy: [],
                blocked: false,
                ready: false,
                revision: 1,
              },
            ],
            events: [
              {
                id: 'e1',
                time: '10:07',
                kind: 'message',
                from: 'scout',
                to: 'main',
                body: 'Two kinds: number and name.',
              },
            ],
          },
        });
      if (route.startsWith('panel/background/')) {
        const [id, action] = route.slice(17).split('/');
        const task = tasks.find((item) => item.id === id);
        if (!task) return json({ error: { code: 'not_found', message: 'Task not found' } }, 404);
        if (action === 'stop') {
          if (!leaseHeld(await body(request)))
            return json(
              { error: { code: 'lost_control', message: 'Another client holds control' } },
              409,
            );
          task.status = 'stopped';
          task.exited = true;
          return json({ task });
        }
        return json({
          task,
          output: Array.from({ length: 30 }, (_, index) => `✓ test ${index + 1} passed`).join('\n'),
        });
      }
      if (route === 'terminals' && request.method === 'GET') return json({ terminals });
      if (route === 'terminals') {
        const input = await body(request);
        if (!leaseHeld(input))
          return json(
            { error: { code: 'lost_control', message: 'Another client holds control' } },
            409,
          );
        const terminal = {
          id: `t${terminals.length + 1}`,
          title: 'fish',
          cwd: '/w',
          cols: input.cols ?? 80,
          rows: input.rows ?? 24,
          createdAt: Date.now(),
          exitCode: null,
          exited: false,
        };
        terminals.push(terminal);
        return json({ terminal }, 201);
      }
      if (route.endsWith('/close')) {
        if (!leaseHeld(await body(request)))
          return json(
            { error: { code: 'lost_control', message: 'Another client holds control' } },
            409,
          );
        terminals.splice(
          terminals.findIndex((item) => item.id === route.split('/')[1]),
          1,
        );
        return new Response(null, { status: 204 });
      }
    }
    if (url.pathname === '/api/workspaces')
      return json({ workspaces: [{ id: 'm5pro:pirc', hostId: 'm5pro', displayName: 'pirc' }] });
    if (url.pathname === '/api/nodes')
      return json({ nodes: [{ id: 'm5pro', workspaces: [{ id: 'pirc', displayName: 'pirc' }] }] });
    if (/^\/api\/sessions\/[^/]+\/snapshot$/.test(url.pathname))
      return json({ ...snapshot, watermark: { epoch: 2, sequence } });
    if (/^\/api\/sessions\/[^/]+\/files$/.test(url.pathname)) {
      const found = listing((url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, ''));
      return found
        ? json(found)
        : json({ error: { code: 'not_found', message: 'Path not found' } }, 404);
    }
    if (/^\/api\/sessions\/[^/]+\/files\/content$/.test(url.pathname)) {
      const path = (url.searchParams.get('path') ?? '').replace(/^\/+/, '');
      const content = FILES[path];
      if (content === undefined)
        return json({ error: { code: 'not_found', message: 'Path not found' } }, 404);
      return json({
        path,
        size: content.length,
        modifiedAt: Date.now() - 60_000,
        binary: false,
        truncated: false,
        content,
      });
    }
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
      const data = socket.data as { kind: string; id?: string };
      if (data.kind === 'terminal') {
        // A pretend shell: echoes what is typed, and runs nothing.
        socket.send(
          JSON.stringify({ type: 'ready', replay: 'fake shell: typing is echoed back\r\n$ ' }),
        );
        return;
      }
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
    message(socket, raw) {
      const data = socket.data as { kind: string };
      if (data.kind !== 'terminal') return;
      const message = JSON.parse(String(raw));
      if (!leaseHeld(message)) {
        socket.send(JSON.stringify({ type: 'error', code: 'lost_control' }));
        return;
      }
      if (message.type === 'input')
        socket.send(
          JSON.stringify({ type: 'output', data: message.data === '\r' ? '\r\n$ ' : message.data }),
        );
    },
  },
});
console.log(`fake gateway on http://127.0.0.1:${PORT}; token ${TOKEN}`);
