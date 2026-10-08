export type RunnerState = 'stopped' | 'starting' | 'ready' | 'failed';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'stopping'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type CommandStatus = 'received' | 'dispatched' | 'accepted' | 'rejected' | 'outcome_unknown';
export type InteractionStatus = 'pending' | 'answered' | 'cancelled' | 'expired' | 'stale';

/**
 * `directory`: a real directory on the node (a repository or folder).
 * `chat`: the assistant's chats, in a directory the node manages and hides
 * (docs/history/assistant.md, chat workspaces).
 */
export type WorkspaceKind = 'directory' | 'chat';

export interface Workspace {
  id: string;
  hostId: string;
  displayName: string;
  canonicalPath: string;
  defaults: Record<string, unknown>;
  kind: WorkspaceKind;
}

export interface SessionSummary {
  id: string;
  workspaceId: string;
  name: string;
  /** `auto`: a placeholder or generated title that a new generated title may replace. */
  nameSource: 'user' | 'auto';
  runnerState: RunnerState;
  runStatus: RunStatus | null;
  runnerEpoch: number;
  /** When the user pinned the session to the top of its workspace; `null` if not pinned. */
  pinnedAt: number | null;
  /** When the user marked the session settled (done); `null` while it is open. */
  settledAt: number | null;
  /** The agent finished a run or asked something since the user last read the session. */
  unread: boolean;
  createdAt: number;
  updatedAt: number;
}

/** What started a session other than the user: a scheduled run or a delegated task. */
export type SessionOrigin =
  | { kind: 'schedule'; scheduleId: string; title: string; dueAt: number }
  | { kind: 'delegation'; delegationId: string; title: string; fromSessionId: string };

export type CommandPayload =
  | { type: 'prompt' | 'steer' | 'follow_up'; message: string; uploadIds?: string[] }
  | { type: 'stop' }
  | { type: 'clear_queue' }
  | { type: 'send_now'; queue: 'steering' | 'followUp'; index: number; message: string }
  | { type: 'set_model'; provider: string; modelId: string }
  | {
      type: 'set_thinking';
      level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    };

export interface GatewayEvent {
  sessionId: string;
  epoch: number;
  sequence: number;
  type: string;
  data: unknown;
  timestamp: number;
}

export interface EventCursor {
  epoch: number;
  sequence: number;
}

export interface Snapshot {
  widgets?: Record<string, string[]>;
  statuses?: Record<string, string>;
  /** Current agent model and thinking level: live from the runner, else as recorded in the session file. */
  agent?: {
    model: { provider: string; id: string } | null;
    thinkingLevel: string | null;
  } | null;
  session: SessionSummary;
  history: unknown[];
  partialMessage: unknown | null;
  /** `ptc` operations still running (`node/reducer.ts`); finished ones are in `history`. */
  operations?: Array<{
    toolCallId: string;
    parentToolCallId: string;
    toolName: string;
    args: unknown;
  }>;
  queue: { steering: string[]; followUp: string[] };
  run: Record<string, unknown> | null;
  interactions: unknown[];
  notifications: unknown[];
  watermark: EventCursor;
  partialOutputLost: boolean;
  /**
   * Whether the running agent is inside the node's OS sandbox (docs/history/sandbox.md);
   * null with no runner. Clients show a lasting badge when it is not.
   */
  sandbox?: { active: boolean; reason?: string } | null;
}

export interface AuthIdentity {
  user: string;
  /** Set when the caller authenticated with a device token instead of forward auth. */
  deviceId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    identity?: AuthIdentity;
  }
}
