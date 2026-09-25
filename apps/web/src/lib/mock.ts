import type { ModelOption, SessionSnapshot, SessionSummary, Workspace } from './types';

export const demoWorkspaces: Workspace[] = [
  {
    id: 'ws-pirc',
    hostId: 'homolab',
    displayName: 'Pi Remote Client',
    canonicalPath: '~/code/pirc',
    defaults: { modelId: 'claude-sonnet', thinkingLevel: 'high' },
    activeSessionCount: 1,
  },
  {
    id: 'ws-dotfiles',
    hostId: 'homolab',
    displayName: 'Dotfiles',
    canonicalPath: '~/dotfiles',
    defaults: { modelId: 'claude-sonnet', thinkingLevel: 'medium' },
  },
];

export const demoSessions: SessionSummary[] = [
  {
    id: 'session-m3',
    workspaceId: 'ws-pirc',
    name: 'Build the mobile web client',
    lastActivityAt: new Date().toISOString(),
    runStatus: 'running',
    runnerStatus: 'ready',
    unreadCount: 0,
    preview: 'Implementing the responsive conversation workspace…',
  },
  {
    id: 'session-sync',
    workspaceId: 'ws-pirc',
    name: 'Audit reconnect semantics',
    lastActivityAt: new Date(Date.now() - 3_600_000).toISOString(),
    runStatus: 'waiting_input',
    runnerStatus: 'ready',
    unreadCount: 1,
    pendingInteractionCount: 1,
    preview: 'Which cursor policy should be used?',
  },
  {
    id: 'session-nix',
    workspaceId: 'ws-dotfiles',
    name: 'Prepare homolab service',
    lastActivityAt: new Date(Date.now() - 86_400_000).toISOString(),
    runStatus: 'succeeded',
    runnerStatus: 'stopped',
    unreadCount: 0,
    preview: 'Drafted the service configuration.',
  },
];

export const demoModels: ModelOption[] = [
  {
    id: 'claude-sonnet',
    provider: 'Anthropic',
    displayName: 'Claude Sonnet',
    contextWindow: 200000,
    thinkingLevels: ['off', 'low', 'medium', 'high'],
    available: true,
  },
  {
    id: 'gpt-5-codex',
    provider: 'OpenAI',
    displayName: 'GPT-5 Codex',
    contextWindow: 200000,
    thinkingLevels: ['minimal', 'low', 'medium', 'high'],
    available: true,
  },
];

export const demoSnapshot: SessionSnapshot = {
  session: demoSessions[0]!,
  runnerStatus: 'ready',
  run: { id: 'run-42', status: 'running', startedAt: new Date(Date.now() - 184_000).toISOString() },
  messages: [
    {
      id: 'msg-user',
      role: 'user',
      content:
        'Build the M3 web client. Keep the interface quiet and useful on a phone, but give me the full session context on desktop.',
      createdAt: new Date(Date.now() - 420_000).toISOString(),
    },
    {
      id: 'msg-assistant',
      role: 'assistant',
      content:
        'I’ll start with the state and transport boundary, then build the conversation surface around it. The layout will preserve the same actions across breakpoints rather than hiding controls on mobile.',
      createdAt: new Date(Date.now() - 390_000).toISOString(),
      tools: [
        {
          id: 'tool-read',
          name: 'read',
          title: 'Read product plan',
          status: 'succeeded',
          input: { path: 'plan.md' },
          output:
            'M3 requires a responsive chat, interactions, controls, image input and a conservative PWA cache.',
        },
        {
          id: 'tool-write',
          name: 'write',
          title: 'Create client state',
          status: 'succeeded',
          output: 'Created typed snapshot and event reducer.',
        },
      ],
    },
    {
      id: 'msg-notice',
      role: 'system',
      systemKind: 'notice',
      level: 'warning',
      content: 'Extension **guard** blocked `rm -rf dist` — confirm before deleting build output.',
      createdAt: new Date(Date.now() - 380_000).toISOString(),
    },
    {
      id: 'msg-math',
      role: 'assistant',
      model: 'claude-sonnet',
      thinking:
        'The reconnect backoff is exponential with jitter; worth stating the bound so the user can check it against the 20 s cap.',
      content: [
        '## Reconnect policy',
        '',
        'The delay for attempt $n$ is capped exponential backoff with jitter:',
        '',
        '$$',
        'd_n = \\min\\left(20\\,000,\\; 750 \\cdot 2^{n}\\right) + U(0, 400)\\ \\text{ms}',
        '$$',
        '',
        '| Attempt | Base delay | Worst case |',
        '|--:|--:|--:|',
        '| 0 | 750 ms | 1.15 s |',
        '| 3 | 6 s | 6.4 s |',
        '| 5 | 20 s | 20.4 s |',
        '',
        '```mermaid',
        'sequenceDiagram',
        '  participant C as Client',
        '  participant G as Gateway',
        '  C->>G: WS /api/events?cursor=1:18',
        '  G-->>C: replay 19..24',
        '  G-->>C: reset (cursor expired)',
        '  C->>G: GET /snapshot',
        '```',
        '',
        '- [x] Replay from cursor',
        '- [ ] Push notification on completion',
        '',
        '> Tool side effects are **not** exactly-once; see `plan.md` §2.',
        '',
        '```ts',
        'const delay = Math.min(20_000, 750 * 2 ** attempts++) + Math.random() * 400;',
        '```',
      ].join('\n'),
      createdAt: new Date(Date.now() - 300_000).toISOString(),
      tools: [
        {
          id: 'tool-bash',
          name: 'bash',
          status: 'succeeded',
          input: { command: 'npm test --workspace @pirc/web' },
          output:
            ' ✓ src/lib/state.test.ts (3 tests) 2ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)',
          startedAt: new Date(Date.now() - 296_000).toISOString(),
          endedAt: new Date(Date.now() - 293_600).toISOString(),
        },
        {
          id: 'tool-edit',
          name: 'edit',
          status: 'succeeded',
          input: { path: 'apps/web/src/lib/api.ts', edits: [] },
          output: 'Successfully replaced 1 block(s) in apps/web/src/lib/api.ts.',
          diff: "  364 socket.addEventListener('close', () => {\n  365   if (closed) return;\n- 366   retryTimer = setTimeout(open, 1000);\n+ 366   retryTimer = setTimeout(open, Math.min(20_000, 750 * 2 ** attempts++));\n  367 });",
        },
        {
          id: 'tool-fail',
          name: 'read',
          status: 'failed',
          input: { path: 'apps/web/src/lib/missing.ts' },
          output: 'ENOENT: no such file or directory',
        },
      ],
    },
    {
      id: 'msg-compaction',
      role: 'system',
      systemKind: 'compaction',
      label: 'Context compacted',
      meta: '182,400 tokens before',
      content:
        '### Progress\n- Transport and reducer done\n- Working on **conversation rendering**',
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    },
    {
      id: 'msg-bash',
      role: 'system',
      systemKind: 'bash',
      level: 'warning',
      label: 'git status --short',
      meta: 'exit 1',
      content: '?? plan.md\nfatal: not a git repository (or any parent up to mount point /)',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      id: 'msg-partial',
      role: 'assistant',
      content:
        'The event reducer is in place. I’m now connecting the session workspace and making the composer adapt between **prompt**, *steer*, and follow-up while preserving',
      createdAt: new Date(Date.now() - 25_000).toISOString(),
      isPartial: true,
      tools: [
        {
          id: 'tool-running',
          name: 'bash',
          status: 'running',
          input: { command: 'npm run build --workspace @pirc/web' },
        },
      ],
    },
  ],
  interactions: [],
  queue: [
    {
      id: 'queue-1',
      kind: 'follow_up',
      content: 'After the UI, run the reducer tests and production build.',
      createdAt: new Date().toISOString(),
    },
  ],
  control: { heldByCurrentClient: true, holderName: 'This browser', generation: 7 },
  cursor: 'demo-18',
  runnerEpoch: 'demo-epoch',
  selectedModelId: 'claude-sonnet',
  thinkingLevel: 'high',
};
