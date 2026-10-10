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
  | 'send_now'
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
  /** `chat`: the assistant's chats or a chat project (absent from older gateways: `directory`). */
  kind?: 'directory' | 'chat';
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
  /** The agent finished a run or asked something since you last read it (any device). */
  unread?: boolean;
  /** Pinned sessions sort first in their workspace. */
  pinned?: boolean;
  /** Settled (done) sessions are tucked away at the bottom of their workspace. */
  settled?: boolean;
  preview?: string;
  pendingInteractionCount?: number;
  /** Holds the write lease on its workspace right now (only one session at a time may write). */
  writeLease?: boolean;
  /** A scheduled run or a delegated task started it. */
  origin?: SessionOrigin;
}

export type SessionOrigin =
  | { kind: 'schedule'; scheduleId: string; title: string; dueAt: number }
  | { kind: 'delegation'; delegationId: string; title: string; fromSessionId: string };

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
  /** A saved browser recording (`browser_record` stop), relative to the session's workspace. */
  recording?: string;
  startedAt?: string;
  endedAt?: string;
  /**
   * A `ptc` operation: the id of the `ptc` call it ran in. Live updates carry
   * it so the reducer can nest the operation under that call.
   */
  parentId?: string;
  /** The operations a `ptc` call ran, in start order (each a capability call). */
  operations?: ToolCall[];
}

/**
 * Non-conversational entries that share the timeline with user/assistant turns.
 * - notice: extension notifications and gateway/runner diagnostics
 * - compaction / branch: agent context summaries
 * - bash: `!command` executions typed by the user
 * - custom: extension-injected messages
 */
export type SystemKind =
  | 'notice'
  | 'compaction'
  | 'branch'
  | 'bash'
  | 'custom'
  | 'team'
  | 'background';
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
  /** Images ride in the model's context; other files are copied into the workspace for tools to read. */
  kind?: 'image' | 'file';
}

interface InteractionBase {
  id: string;
  runnerEpoch: string;
  /** The `ptc` operation that asks (shown as waiting on it); absent for anything else. */
  toolCallId?: string;
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
  /**
   * A delegation: the user picks the model and thinking level it runs on.
   * Holds the assistant's suggestion; null is the workspace default.
   */
  modelChoice?: {
    model: { provider: string; id: string } | null;
    thinking: ThinkingLevel | null;
  };
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
  /** Position among the user messages of its queue; `send_now` addresses it by this. */
  index: number;
  content: string;
  createdAt: string;
}

export interface ControlLease {
  holderClientId?: string;
  holderName?: string;
  heldByCurrentClient: boolean;
  /** The lease row exists but its TTL has passed; anyone may acquire it. */
  expired?: boolean;
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
  /** Several backends can expose the same model ID; the provider disambiguates. */
  selectedModelProvider?: string;
  thinkingLevel?: ThinkingLevel;
  /** Extension panels (e.g. the todo list), keyed by extension. */
  widgets?: Record<string, string[]>;
  statuses?: Record<string, string>;
  /** The running agent's OS sandbox; absent with no runner. */
  sandbox?: { active: boolean; reason?: string };
}

/** Stable selection key: model IDs are only unique within one backend. */
export const modelKey = (model: { provider: string; id: string }) =>
  JSON.stringify([model.provider, model.id]);

export interface ModelOption {
  id: string;
  provider: string;
  displayName: string;
  contextWindow?: number;
  thinkingLevels: ThinkingLevel[];
  available: boolean;
}

/** Public gateway settings metadata. Credentials are deliberately never returned. */
export interface BackendModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<'text' | 'image'>;
  api?: string;
  [key: string]: unknown;
}

export interface BackendProvider {
  id: string;
  name: string;
  source: 'file' | 'ui' | 'oauth';
  readOnly: boolean;
  api: string;
  baseUrl?: string;
  opencodeGo?: boolean;
  /** The pi-ai catalog preset a web-managed backend was set up from. */
  preset?: string;
  hasApiKey: boolean;
  models: BackendModel[];
}

/** A known service to start a new API-key backend from. */
export interface BackendPreset {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  /** A local server that normally needs no key. */
  keyless?: boolean;
  /** Models come from pi-ai's catalog; saving keeps its request compatibility. */
  catalog: boolean;
  models: BackendModel[];
}

/** A model an endpoint lists; `known` when pi-ai's catalog supplied its limits. */
export interface DiscoveredModel extends BackendModel {
  known: boolean;
}

/** An unsaved backend form to probe; no `apiKey` reuses the edited backend's saved key. */
export interface BackendProbeInput {
  api: string;
  baseUrl: string;
  opencodeGo?: boolean;
  apiKey?: string;
  preset?: string;
  backendId?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

export interface OAuthProviderOption {
  id: string;
  name: string;
  connected: boolean;
  providerId: string;
  requiresPolicyConsent: boolean;
  usesCallbackServer: boolean;
  modelCount: number;
}

export interface BackendSettingsSnapshot {
  providers: BackendProvider[];
  oauthProviders: OAuthProviderOption[];
  defaultModel?: { provider: string; id: string; thinking?: ThinkingLevel };
}

export interface BackendProviderInput {
  api: string;
  baseUrl: string;
  opencodeGo?: boolean;
  apiKey?: string;
  preset?: string;
  models: BackendModel[];
}

export interface ProviderAuthPrompt {
  id: string;
  kind: 'prompt' | 'manual' | 'select';
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
  options?: Array<{ id: string; label: string }>;
}

export interface ProviderAuthSession {
  id: string;
  providerId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  /** `userCode`: a device-flow code to type on the authorization page. */
  auth?: { url: string; instructions?: string; userCode?: string };
  prompts: ProviderAuthPrompt[];
  progress?: string;
  error?: string;
  expiresAt: number;
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
  /** `send_now`: the queued message to deliver immediately (`content` must match it). */
  queued?: Pick<QueueItem, 'kind' | 'index'>;
}

export interface CommandReceipt {
  commandId: string;
  status: 'received' | 'dispatched' | 'accepted' | 'rejected' | 'outcome_unknown';
  message?: string;
}

export type InteractionAnswer =
  | {
      action: 'answer';
      value: string | string[] | boolean;
      /** With a confirm that offers `modelChoice`: what the user picked (null = default). */
      model?: { provider: string; id: string } | null;
      thinking?: ThinkingLevel | null;
    }
  | { action: 'cancel' };

export interface EventEnvelope<T extends GatewayEvent = GatewayEvent> {
  sessionId: string;
  runnerEpoch: string;
  sequence: number;
  cursor: string;
  event: T;
}

export type GatewayEvent =
  | { type: 'session_deleted' }
  | { type: 'message_started'; message: ConversationMessage }
  | {
      type: 'message_delta';
      /** Omitted for live agent streams: applies to the newest partial assistant message. */
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
