export type ConnectionState = 'connected' | 'reconnecting' | 'offline';
export type RunnerStatus = 'stopped' | 'starting' | 'ready' | 'failed';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'stopping'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type CommandKind =
  | 'prompt'
  | 'steer'
  | 'follow_up'
  | 'stop'
  | 'clear_queue'
  | 'set_model'
  | 'set_thinking';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface WorkspaceDefaults {
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface Workspace {
  id: string;
  hostId: string;
  displayName: string;
  canonicalPath?: string;
  color?: string;
  defaults: WorkspaceDefaults;
  activeSessionCount?: number;
}

export interface NodeSummary {
  id: string;
  connectedAt: number;
  lastSeenAt: number;
  workspaces: Array<{ id: string; displayName: string }>;
}

export interface SessionSummary {
  id: string;
  workspaceId: string;
  name: string;
  lastActivityAt: string;
  runStatus?: RunStatus;
  runnerStatus: RunnerStatus;
  unreadCount: number;
  /** Pinned sessions sort first in their workspace. */
  pinned?: boolean;
  /** Settled (done) sessions are tucked away at the bottom of their workspace. */
  settled?: boolean;
  preview?: string;
  pendingInteractionCount?: number;
}

export interface RunState {
  id?: string;
  status: RunStatus;
  startedAt?: string;
  endedAt?: string;
  failureReason?: string;
}

export interface InlineImage {
  mimeType: string;
  url: string;
}

export interface ToolCall {
  id: string;
  name: string;
  title?: string;
  status: 'running' | 'succeeded' | 'failed';
  input?: unknown;
  output?: string;
  /** Unified diff reported by edit-style tools. */
  diff?: string;
  images?: InlineImage[];
  startedAt?: string;
  endedAt?: string;
}

/**
 * Non-conversational entries that share the timeline with user/assistant turns.
 * - notice: extension notifications and gateway/runner diagnostics
 * - compaction / branch: Pi context summaries
 * - bash: `!command` executions typed by the user in Pi
 * - custom: extension-injected messages
 */
export type SystemKind = 'notice' | 'compaction' | 'branch' | 'bash' | 'custom';
export type NoticeLevel = 'info' | 'warning' | 'error';

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  /** When a streamed assistant message finished; orders notices raised meanwhile. */
  completedAt?: string;
  isPartial?: boolean;
  thinking?: string;
  thinkingRedacted?: boolean;
  /** Assistant turn ended with an error or was aborted. */
  stopReason?: 'error' | 'aborted';
  errorMessage?: string;
  model?: string;
  tools?: ToolCall[];
  attachments?: Attachment[];
  images?: InlineImage[];
  systemKind?: SystemKind;
  level?: NoticeLevel;
  /** Short heading for system entries (e.g. extension custom type, bash command). */
  label?: string;
  /** Secondary detail for system entries (e.g. exit code, token count). */
  meta?: string;
}

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url?: string;
}

interface InteractionBase {
  id: string;
  runnerEpoch: string;
  title: string;
  description?: string;
  expiresAt?: string;
  status: 'pending' | 'answered' | 'cancelled' | 'expired';
}

export interface SelectInteraction extends InteractionBase {
  kind: 'select';
  options: Array<{ value: string; label: string; description?: string }>;
  multiple?: boolean;
}

export interface ConfirmInteraction extends InteractionBase {
  kind: 'confirm';
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface InputInteraction extends InteractionBase {
  kind: 'input';
  placeholder?: string;
  initialValue?: string;
}

export interface EditorInteraction extends InteractionBase {
  kind: 'editor';
  language?: string;
  initialValue?: string;
}

export type PendingInteraction =
  | SelectInteraction
  | ConfirmInteraction
  | InputInteraction
  | EditorInteraction;

export interface QueueItem {
  id: string;
  kind: 'steer' | 'follow_up';
  content: string;
  createdAt: string;
}

export interface ControlLease {
  holderClientId?: string;
  holderName?: string;
  heldByCurrentClient: boolean;
  generation?: number;
  expiresAt?: string;
}

export interface SessionSnapshot {
  session: SessionSummary;
  runnerStatus: RunnerStatus;
  run: RunState | null;
  messages: ConversationMessage[];
  partialMessage?: ConversationMessage;
  interactions: PendingInteraction[];
  queue: QueueItem[];
  control: ControlLease;
  cursor: string;
  runnerEpoch: string;
  selectedModelId?: string;
  thinkingLevel?: ThinkingLevel;
  /** Extension panels (e.g. the todo list), keyed by extension. */
  widgets?: Record<string, string[]>;
  statuses?: Record<string, string>;
}

export interface ModelOption {
  id: string;
  provider: string;
  displayName: string;
  contextWindow?: number;
  thinkingLevels: ThinkingLevel[];
  available: boolean;
}

export interface CreateSessionInput {
  workspaceId: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface SessionUpdateInput {
  name?: string;
  pinned?: boolean;
  settled?: boolean;
}

export interface SessionCommandInput {
  commandId: string;
  kind: CommandKind;
  controlGeneration: number;
  content?: string;
  modelId?: string;
  provider?: string;
  thinkingLevel?: ThinkingLevel;
  attachmentIds?: string[];
}

export interface CommandReceipt {
  commandId: string;
  status: 'received' | 'dispatched' | 'accepted' | 'rejected' | 'outcome_unknown';
  message?: string;
}

export type InteractionAnswer =
  | { action: 'answer'; value: string | string[] | boolean }
  | { action: 'cancel' };

export interface EventEnvelope<T extends GatewayEvent = GatewayEvent> {
  sessionId: string;
  runnerEpoch: string;
  sequence: number;
  cursor: string;
  event: T;
}

export type GatewayEvent =
  | { type: 'message_started'; message: ConversationMessage }
  | {
      type: 'message_delta';
      /** Omitted for live Pi streams: applies to the newest partial assistant message. */
      messageId?: string;
      delta: string;
      channel?: 'text' | 'thinking';
    }
  | { type: 'message_completed'; message: ConversationMessage }
  | {
      type: 'tool_updated';
      /** Omitted when the owner is resolved by tool id. */
      messageId?: string;
      /** Fields merge into any existing tool with the same id. */
      tool: Pick<ToolCall, 'id'> & Partial<ToolCall>;
    }
  | { type: 'noop' }
  | { type: 'run_updated'; run: RunState | null; runnerStatus?: RunnerStatus }
  | { type: 'interaction_updated'; interaction: PendingInteraction }
  | { type: 'interaction_removed'; interactionId: string }
  | { type: 'queue_updated'; queue: QueueItem[] }
  | { type: 'widget_updated'; key: string; lines?: string[] }
  | { type: 'status_updated'; key: string; text?: string }
  | { type: 'control_updated'; control: ControlLease }
  | { type: 'session_updated'; session: SessionSummary }
  | { type: 'session_renamed'; name: string }
  /** Side-panel data changed (memory, background, team, git); refetch lazily. */
  | { type: 'panel_changed'; sections: string[] }
  | { type: 'reset'; reason: 'cursor_expired' | 'epoch_changed' | 'backpressure' };

export interface ClientSessionState extends SessionSnapshot {
  needsSnapshot: boolean;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  requestId?: string;
}
