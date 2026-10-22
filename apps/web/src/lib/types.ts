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
/**
 * How much the agent may do without asking: only reads (`read-only`), what
 * auto mode's rules and classifier allow (`auto`), or everything
 * (`full-access`). The deny-list asks in every mode.
 */
export type ApprovalMode = 'read-only' | 'auto' | 'full-access';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface WorkspaceDefaults {
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
}

/**
 * A workspace mode from the gateway's catalog (`GET /api/modes`): what a
 * workspace in it can do. Clients ask these capabilities, never mode ids.
 */
export interface ModeInfo {
  id: string;
  label: string;
  description: string;
  ui: { noun: string; icon?: string };
  /** `workspace`: one existing directory; `per-session`: a node-managed directory per session. */
  workdir: 'workspace' | 'per-session';
  prompt?: unknown[];
  body?: string;
  features_off: string[];
  features_on: string[];
  /** `null`: the node's normal tools. */
  tools: string[] | null;
  delegate_target: boolean;
  project_config: boolean;
  workspace_memory: boolean;
  repository: boolean;
  recap: boolean;
}

export interface Workspace {
  id: string;
  hostId: string;
  displayName: string;
  /** The workspace's mode id (absent from older gateways). */
  mode?: string;
  /** False when its mode is missing from the catalog: history is read-only, no new sessions. */
  available?: boolean;
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
  /** Mode ids the node accepts (absent from older gateways). */
  modes?: string[];
  /** What its machine can do (plan 08); null when it did not say. */
  capabilities?: NodeCapabilities | null;
  /** Its agents running, against how many it means to run. */
  load?: { running: number; max: number | null };
}

export interface NodeCapabilities {
  os: string;
  arch: string;
  gpus: Array<{ vendor: string; count: number; model?: string; vramMb?: number }>;
  browser: boolean;
  terminals: boolean;
  sandbox: { backend: string; status: string; gpu: boolean };
  maxRunning: number;
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
  /** A delegated task started it. */
  origin?: SessionOrigin;
}

export type SessionOrigin = {
  kind: 'delegation';
  delegationId: string;
  title: string;
  /** The room pirc called the worker in, and its thread there (plan 06). */
  roomId: string;
  threadId?: string;
  /** The delegation's status; absent from older gateways. */
  status?: DelegationStatus;
  /** A confirm it waits on, relayed to the chat that started it (answer it there). */
  approval?: RelayedApproval;
};

/** A delegated session's pending confirm, as the chat that started it holds it. */
export interface RelayedApproval {
  /** The chat that holds the relayed interaction. */
  sessionId: string;
  /** `relay.…`: answering needs no control lease. */
  interactionId: string;
  title: string;
  message?: string;
}

/** A delegation's status once its session exists. */
export type DelegationStatus = 'running' | 'waiting_input' | 'completed' | 'failed';

export interface RunState {
  id?: string;
  status: RunStatus;
  startedAt?: string;
  endedAt?: string;
  failureReason?: string;
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

/**
 * What the engine keeps of a session (plan 12 decision 4: no conversation):
 * its record, run, runner and stream cursor, and the control lease its panes
 * (terminal, browser) need. The snapshot's history and questions are not read.
 */
export interface SessionSnapshot {
  session: SessionSummary;
  runnerStatus: RunnerStatus;
  run: RunState | null;
  control: ControlLease;
  cursor: string;
  runnerEpoch: string;
  /** The running agent's OS sandbox; absent with no runner. */
  sandbox?: { active: boolean; reason?: string };
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

export type NewWorkspace =
  /** A workspace in a catalog mode; `path` iff the mode's workdir is `workspace`. */
  | { nodeId: string; mode: string; displayName: string; path?: string }
  /** Older gateways: an existing directory. */
  | { nodeId: string; path: string; displayName: string };

export interface SessionUpdateInput {
  name?: string;
}

export interface EventEnvelope<T extends GatewayEvent = GatewayEvent> {
  sessionId: string;
  runnerEpoch: string;
  sequence: number;
  cursor: string;
  event: T;
}

export type GatewayEvent =
  | { type: 'session_deleted' }
  | { type: 'noop' }
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
