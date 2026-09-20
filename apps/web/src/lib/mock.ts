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
      id: 'msg-partial',
      role: 'assistant',
      content:
        'The event reducer is in place. I’m now connecting the session workspace and making the composer adapt between prompt, steer, and follow-up while preserving',
      createdAt: new Date(Date.now() - 25_000).toISOString(),
      isPartial: true,
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
