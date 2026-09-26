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

export interface Workspace {
  id: string;
  hostId: string;
  displayName: string;
  canonicalPath: string;
  defaults: Record<string, unknown>;
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
  createdAt: number;
  updatedAt: number;
}

export type CommandPayload =
  | { type: 'prompt' | 'steer' | 'follow_up'; message: string; uploadIds?: string[] }
  | { type: 'stop' }
  | { type: 'clear_queue' }
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
  /** Current agent model and thinking level, when the runner is live. */
  agent?: {
    model: { provider: string; id: string } | null;
    thinkingLevel: string | null;
  } | null;
  session: SessionSummary;
  history: unknown[];
  partialMessage: unknown | null;
  queue: { steering: string[]; followUp: string[] };
  run: Record<string, unknown> | null;
  interactions: unknown[];
  notifications: unknown[];
  watermark: EventCursor;
  partialOutputLost: boolean;
}

export interface AuthIdentity {
  user: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    identity?: AuthIdentity;
  }
}
