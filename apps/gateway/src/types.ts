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
  runnerState: RunnerState;
  runStatus: RunStatus | null;
  runnerEpoch: number;
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
