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

export interface ToolCall {
  id: string;
  name: string;
  title?: string;
  status: 'running' | 'succeeded' | 'failed';
  input?: unknown;
  output?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  isPartial?: boolean;
  tools?: ToolCall[];
  attachments?: Attachment[];
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
  name?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
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
  | { type: 'message_delta'; messageId: string; delta: string }
  | { type: 'message_completed'; message: ConversationMessage }
  | { type: 'tool_updated'; messageId: string; tool: ToolCall }
  | { type: 'run_updated'; run: RunState | null; runnerStatus?: RunnerStatus }
  | { type: 'interaction_updated'; interaction: PendingInteraction }
  | { type: 'interaction_removed'; interactionId: string }
  | { type: 'queue_updated'; queue: QueueItem[] }
  | { type: 'control_updated'; control: ControlLease }
  | { type: 'session_updated'; session: SessionSummary }
  | { type: 'reset'; reason: 'cursor_expired' | 'epoch_changed' | 'backpressure' };

export interface ClientSessionState extends SessionSnapshot {
  needsSnapshot: boolean;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  requestId?: string;
}
