/**
 * Offline demo data for dev builds without a gateway (plans/rewrite/11-web.md):
 * the rooms, faces and a worker's thread for the rooms page, and the sessions
 * the engine shows behind them. Loaded on demand only in dev, and by tests.
 */
import type { Face, FacePresence } from './faces';
import type { PanelState } from './panel-api';
import { LEGACY_DIRECTORY } from './modes';
import type { RoomMessage, RoomView } from './rooms';
import type { NodeSummary, ModeInfo, SessionSnapshot, SessionSummary, Workspace } from './types';
import type { ThreadMessage, Worker } from './workers';

const ago = (ms: number) => Date.now() - ms;

/** Who the demo's rooms belong to. */
export const demoUser = 'you@example.com';

const face = (id: string, name: string, extra: Partial<Face> = {}): Face => ({
  id,
  name,
  bio: '',
  tone: '',
  avatar: null,
  color: null,
  roleMd: '',
  territory: { rooms: [], workspaces: [], sources: [] },
  isHost: id === 'host',
  createdAt: ago(30 * 86_400_000),
  archivedAt: null,
  hiddenAt: null,
  ...extra,
});

export const demoFaces: Face[] = [
  face('host', 'pirc', { bio: 'Runs the household and hands work out.' }),
  face('face_pm', 'SlimeOS PM', {
    bio: 'Keeps SlimeOS moving.',
    color: '#3366cc',
    avatar: 'PM',
    territory: { rooms: ['room_slime'], workspaces: ['ws-pirc'], sources: [] },
  }),
];

export const demoFacePresence: FacePresence[] = [
  { faceId: 'host', state: 'idle' },
  {
    faceId: 'face_pm',
    state: 'working',
    roomId: 'room_slime',
    line: 'Fix the lint job',
    since: ago(120_000),
  },
];

const room = (id: string, name: string, extra: Partial<RoomView> = {}): RoomView => ({
  id,
  name,
  kind: id === 'general' ? 'general' : 'topic',
  createdAt: ago(30 * 86_400_000),
  archivedAt: null,
  lastActivityAt: ago(60_000),
  sourceScope: null,
  movedToRoomId: null,
  movedFromRoomId: null,
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  waiting: false,
  waitingSince: null,
  ...extra,
});

export const demoRooms: RoomView[] = [
  room('room_slime', 'SlimeOS', { lastSeq: 5, readSeq: 3, unread: 2, waiting: true }),
  room('general', 'general', { lastActivityAt: ago(3_600_000), lastSeq: 3, readSeq: 3 }),
  room('room_old', 'Moving house', { archivedAt: ago(7 * 86_400_000), lastSeq: 1, readSeq: 1 }),
];

const message = (
  roomId: string,
  seq: number,
  speaker: string,
  body: RoomMessage['body'],
  extra: Partial<RoomMessage> = {},
): RoomMessage => ({
  id: `${roomId}-${seq}`,
  roomId,
  seq,
  speaker,
  user: speaker === 'user' ? demoUser : null,
  kind: 'text',
  body,
  threadId: null,
  createdAt: ago((10 - seq) * 60_000),
  editedAt: null,
  pinnedAt: null,
  ...extra,
});

export const demoMessages: Record<string, RoomMessage[]> = {
  general: [
    message('general', 1, 'user', { text: '明天早上提醒我繳電費' }),
    message('general', 2, 'face:host', { text: '好，明早九點提醒你。' }),
    message(
      'general',
      3,
      'face:host',
      { text: 'Remembered: you pay the power bill monthly' },
      { kind: 'line' },
    ),
  ],
  room_slime: [
    message('room_slime', 1, 'user', { text: '@SlimeOS PM CI 怎麼又紅了' }),
    message('room_slime', 2, 'face:face_pm', { text: '我叫個工人看看。' }),
    message(
      'room_slime',
      3,
      'face:face_pm',
      {
        text: 'Fix the lint job',
        worker: {
          delegationId: 'dlg-1',
          threadId: 'thr-1',
          status: 'running',
          title: 'Fix the lint job',
          workspace: 'pirc',
          workers: 1,
          readOnly: false,
          note: null,
        },
      },
      { threadId: 'thr-1' },
    ),
    message('room_slime', 4, 'face:face_pm', { text: 'Reading the CI log…' }, { kind: 'progress' }),
    message(
      'room_slime',
      5,
      'face:face_pm',
      {
        text: 'The worker wants to push to origin.',
        worker: { delegationId: 'dlg-1', threadId: 'thr-1', event: 'question' },
        question: {
          interactionId: 'q-1',
          threadMessageId: 'tm-3',
          request: { title: 'git push origin fix-lint', allowAgain: true },
          status: 'pending',
        },
      },
      { kind: 'question', threadId: 'thr-1' },
    ),
  ],
  room_old: [message('room_old', 1, 'user', { text: '箱子都封好了。' })],
};

const threadMessage = (
  seq: number,
  speaker: string,
  kind: ThreadMessage['kind'],
  body: ThreadMessage['body'],
): ThreadMessage => ({
  id: `tm-${seq}`,
  threadId: 'thr-1',
  seq,
  speaker,
  user: null,
  kind,
  body,
  depth: 0,
  createdAt: ago((6 - seq) * 30_000),
  updatedAt: null,
});

export const demoThread: { messages: ThreadMessage[]; workers: Worker[] } = {
  messages: [
    threadMessage(1, 'face:face_pm', 'line', { text: 'Started in pirc' }),
    threadMessage(2, 'worker:session-pwa', 'tool', { tool: 'bash', summary: 'bun run lint' }),
    threadMessage(3, 'worker:session-pwa', 'text', { text: 'Fixed 3 lint errors; pushing.' }),
  ],
  workers: [
    {
      id: 'dlg-1',
      roomId: 'room_slime',
      faceId: 'face_pm',
      threadId: 'thr-1',
      anchorMessageId: 'room_slime-3',
      title: 'Fix the lint job',
      workspace: 'pirc',
      workspaceId: 'ws-pirc',
      status: 'running',
      note: null,
      readOnly: false,
      follows: null,
      for: demoUser,
      targetSessionId: 'session-pwa',
      createdAt: ago(180_000),
      updatedAt: ago(30_000),
    },
  ],
};

/** Background work shown by the top-bar jobs menu in the offline demo. */
export const demoPanelState: PanelState = {
  agentRunning: true,
  memory: null,
  memoryRuntime: null,
  backgroundTasks: [
    {
      id: 'bg-1',
      command: 'bun test --watch',
      cwd: '~/code/pirc',
      status: 'completed',
      exitCode: 0,
      startedAt: new Date(Date.now() - 900_000).toISOString(),
      endedAt: new Date(Date.now() - 840_000).toISOString(),
    },
    {
      id: 'bg-2',
      command: 'bun run dev:web',
      cwd: '~/code/pirc',
      status: 'running',
      notifyOn: 'error',
      startedAt: new Date(Date.now() - 312_000).toISOString(),
    },
  ],
  team: {
    agents: [{ name: 'reviewer', mode: 'subagent', status: 'working', task: 'Audit the reducer' }],
  },
};

/**
 * The gateway's mode catalog: the default and the guide's scratch example
 * (one-off jobs on a coding node, each session in its own directory).
 */
export const demoModes: ModeInfo[] = [
  { ...LEGACY_DIRECTORY, description: 'Coding sessions in a repository.' },
  {
    ...LEGACY_DIRECTORY,
    id: 'scratch',
    label: 'Scratch',
    description: 'One-off jobs, each session in its own directory.',
    workdir: 'per-session',
    project_config: false,
    workspace_memory: false,
    repository: false,
    recap: false,
  },
];

export const demoWorkspaces: Workspace[] = [
  {
    id: 'ws-pirc',
    hostId: 'homolab',
    displayName: 'pirc',
    mode: 'directory',
    canonicalPath: '~/code/pirc',
    defaults: { modelId: 'claude-sonnet', thinkingLevel: 'high' },
    activeSessionCount: 1,
  },
  {
    id: 'ws-dotfiles',
    hostId: 'homolab',
    displayName: 'Dotfiles',
    mode: 'directory',
    canonicalPath: '~/dotfiles',
    defaults: { modelId: 'claude-sonnet', thinkingLevel: 'medium' },
  },
  {
    id: 'ws-gpu',
    hostId: 'homolab',
    displayName: 'GPU jobs',
    mode: 'scratch',
    defaults: {},
  },
];

export const demoNodes: NodeSummary[] = [
  {
    id: 'homolab',
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
    workspaces: [],
    modes: ['directory', 'scratch'],
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
    preview: 'Implementing the responsive conversation workspace…',
  },
  {
    id: 'session-sync',
    workspaceId: 'ws-pirc',
    name: 'Audit reconnect semantics',
    lastActivityAt: new Date(Date.now() - 3_600_000).toISOString(),
    runStatus: 'waiting_input',
    runnerStatus: 'ready',
    unread: true,
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
    preview: 'Drafted the service configuration.',
  },
  {
    id: 'session-pwa',
    workspaceId: 'ws-pirc',
    name: 'Fix PWA cache headers',
    lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    runStatus: 'running',
    runnerStatus: 'ready',
    writeLease: true,
    origin: {
      kind: 'delegation',
      delegationId: 'dlg-1',
      title: 'Cache only hashed assets',
      roomId: 'general',
    },
  },
  {
    id: 'session-render',
    workspaceId: 'ws-gpu',
    name: 'Render the cover image',
    lastActivityAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    runStatus: 'succeeded',
    runnerStatus: 'stopped',
    preview: 'Saved cover.png.',
  },
];

export const demoSnapshot: SessionSnapshot = {
  session: demoSessions[0]!,
  runnerStatus: 'ready',
  run: { id: 'run-42', status: 'running', startedAt: new Date(Date.now() - 184_000).toISOString() },
  control: { heldByCurrentClient: true, holderName: 'This browser', generation: 7 },
  cursor: 'demo-18',
  runnerEpoch: 'demo-epoch',
};
