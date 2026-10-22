import { ApiError, request } from './http';
import { getClientId } from './storage';
import type {
  BackendModel,
  BackendPreset,
  BackendProbeInput,
  BackendProviderInput,
  BackendSettingsSnapshot,
  ConnectionTestResult,
  DiscoveredModel,
  ProviderAuthSession,
  ControlLease,
  EventEnvelope,
  GatewayEvent,
  ModeInfo,
  NewWorkspace,
  NodeSummary,
  SessionOrigin,
  SessionSnapshot,
  SessionSummary,
  SessionUpdateInput,
  Workspace,
} from './types';

export { ApiError } from './http';

/**
 * Backend settings errors are curated gateway messages (e.g. "consent required",
 * "paste the complete callback URL"). Defense in depth: never render anything
 * that looks like a credential or an upstream body.
 */
function safeBackendMessage(body: any, status: number): string {
  return safeBackendText(
    body?.error?.message,
    `Backend request failed (${status}). Check your settings and try again.`,
  );
}

/** A curated gateway message, or `fallback` when it could carry a credential or upstream body. */
export function safeBackendText(message: unknown, fallback: string): string {
  if (typeof message !== 'string' || !message || message.length > 200) return fallback;
  return /bearer|token|secret|api[_-]?key|[=:{}]|https?:\/\//i.test(message) ? fallback : message;
}

const iso = (value: unknown) =>
  new Date(typeof value === 'number' ? value : Date.now()).toISOString();

function sessionSummary(raw: any): SessionSummary {
  return {
    id: raw.id,
    workspaceId: raw.workspaceId,
    name: raw.name,
    lastActivityAt: iso(raw.updatedAt),
    runStatus: raw.runStatus ?? undefined,
    runnerStatus: raw.runnerState ?? 'stopped',
    ...(raw.unread === true ? { unread: true } : {}),
    pinned: raw.pinnedAt != null,
    settled: raw.settledAt != null,
    ...(raw.writeLease === true ? { writeLease: true } : {}),
    ...(sessionOrigin(raw.origin) ? { origin: sessionOrigin(raw.origin) } : {}),
  };
}

function sessionOrigin(raw: any): SessionOrigin | undefined {
  if (raw?.kind === 'delegation' && typeof raw.roomId === 'string')
    return {
      kind: 'delegation',
      delegationId: String(raw.delegationId ?? ''),
      title: String(raw.title ?? ''),
      roomId: raw.roomId,
      ...(typeof raw.threadId === 'string' ? { threadId: raw.threadId } : {}),
      ...(['running', 'waiting_input', 'completed', 'failed'].includes(raw.status)
        ? { status: raw.status }
        : {}),
      ...(typeof raw.approval?.sessionId === 'string' &&
      typeof raw.approval?.interactionId === 'string'
        ? {
            approval: {
              sessionId: raw.approval.sessionId,
              interactionId: raw.approval.interactionId,
              title: String(raw.approval.title ?? ''),
              ...(typeof raw.approval.message === 'string'
                ? { message: raw.approval.message }
                : {}),
            },
          }
        : {}),
    };
  return undefined;
}

function controlLease(raw: any, clientId = getClientId()): ControlLease {
  const lease = raw?.lease ?? raw;
  if (!lease) return { heldByCurrentClient: false };
  return {
    holderClientId: lease.clientId,
    heldByCurrentClient: lease.clientId === clientId && !lease.expired,
    expired: !!lease.expired,
    generation: lease.generation,
    expiresAt: iso(lease.expiresAt),
  };
}

async function normalizeSnapshot(raw: any): Promise<SessionSnapshot> {
  const lease = await request<any>(`/api/sessions/${encodeURIComponent(raw.session.id)}/control`);
  return snapshotFromRaw(raw, lease);
}

/**
 * A gateway snapshot (plus its control lease) as what the engine keeps of a
 * session: no history, questions or queues (plan 12 decision 4).
 */
export function snapshotFromRaw(raw: any, lease: unknown): SessionSnapshot {
  return {
    session: sessionSummary(raw.session),
    runnerStatus: raw.session.runnerState ?? 'stopped',
    run: raw.run
      ? {
          id: raw.run.id,
          status: raw.run.status,
          startedAt: raw.run.startedAt ? iso(raw.run.startedAt) : undefined,
          endedAt: raw.run.endedAt ? iso(raw.run.endedAt) : undefined,
          failureReason: raw.run.failureReason ?? undefined,
        }
      : null,
    control: controlLease(lease),
    cursor: `${raw.watermark?.epoch ?? 0}:${raw.watermark?.sequence ?? 0}`,
    runnerEpoch: String(raw.watermark?.epoch ?? raw.session.runnerEpoch ?? 0),
    ...(typeof raw.sandbox?.active === 'boolean'
      ? {
          sandbox: {
            active: raw.sandbox.active,
            ...(typeof raw.sandbox.reason === 'string' ? { reason: raw.sandbox.reason } : {}),
          },
        }
      : {}),
  };
}

/** Settings never use browser caches or expose upstream error bodies. */
function backendRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, { cache: 'no-store', ...init }, { errorMessage: safeBackendMessage });
}

const authPath = (id: string) => `/api/provider-auth/sessions/${encodeURIComponent(id)}`;

export const backendApi = {
  settings: () => backendRequest<BackendSettingsSnapshot>('/api/providers'),
  create: (id: string, input: BackendProviderInput) =>
    backendRequest<BackendSettingsSnapshot>('/api/providers', {
      method: 'POST',
      body: JSON.stringify({ id, ...input }),
    }),
  update: (id: string, input: BackendProviderInput) =>
    backendRequest<BackendSettingsSnapshot>(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    backendRequest<BackendSettingsSnapshot>(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  presets: async () =>
    (await backendRequest<{ presets?: BackendPreset[] }>('/api/providers/presets')).presets ?? [],
  discover: async (input: BackendProbeInput) =>
    (
      await backendRequest<{ models?: DiscoveredModel[] }>('/api/providers/discover', {
        method: 'POST',
        body: JSON.stringify(input),
      })
    ).models ?? [],
  testConnection: async (input: BackendProbeInput & { model: BackendModel }) => {
    const result = await backendRequest<ConnectionTestResult>('/api/providers/test', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return result.ok
      ? result
      : { ...result, message: safeBackendText(result.message, 'The connection test failed.') };
  },
  setDefault: (model: BackendSettingsSnapshot['defaultModel'] | null) =>
    backendRequest<BackendSettingsSnapshot>('/api/providers/default-model', {
      method: 'PUT',
      body: JSON.stringify(model),
    }),
  startLogin: (providerId: string, policyConsent: boolean) =>
    backendRequest<ProviderAuthSession>('/api/provider-auth/sessions', {
      method: 'POST',
      body: JSON.stringify({ providerId, policyConsent }),
    }),
  login: (id: string) => backendRequest<ProviderAuthSession>(authPath(id)),
  answer: (id: string, promptId: string, value?: string) =>
    backendRequest<ProviderAuthSession>(`${authPath(id)}/input`, {
      method: 'POST',
      body: JSON.stringify({ promptId, value }),
    }),
  cancelLogin: (id: string) =>
    backendRequest<ProviderAuthSession>(authPath(id), { method: 'DELETE', keepalive: true }),
};

export const api = {
  nodes: async () => (await request<{ nodes: NodeSummary[] }>('/api/nodes')).nodes,
  workspaces: async () => (await request<any>('/api/workspaces')).workspaces as Workspace[],
  /** The gateway's workspace mode catalog; empty from older gateways (404). */
  modes: async (): Promise<ModeInfo[]> => {
    try {
      return (await request<{ modes?: ModeInfo[] }>('/api/modes')).modes ?? [];
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return [];
      throw error;
    }
  },
  createWorkspace: async (input: NewWorkspace) =>
    (
      await request<{ workspace: Workspace }>('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify(input),
      })
    ).workspace,
  sessions: async () =>
    ((await request<any>('/api/sessions')).sessions as any[]).map(sessionSummary),
  /** Rename a session (the engine keeps nothing else to change). */
  updateSession: async (sessionId: string, input: SessionUpdateInput) =>
    sessionSummary(
      (
        await request<any>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        })
      ).session,
    ),
  /** You have read the session: its unread mark clears on every device. */
  markRead: async (sessionId: string) =>
    sessionSummary(
      (
        await request<any>(`/api/sessions/${encodeURIComponent(sessionId)}/read`, {
          method: 'POST',
        })
      ).session,
    ),
  snapshot: async (sessionId: string) =>
    normalizeSnapshot(
      await request<any>(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot`),
    ),
  control: async (sessionId: string) =>
    controlLease(await request<any>(`/api/sessions/${encodeURIComponent(sessionId)}/control`)),
  takeControl: async (sessionId: string, clientId: string) =>
    controlLease(
      await request<any>(`/api/sessions/${encodeURIComponent(sessionId)}/control/acquire`, {
        method: 'POST',
        body: JSON.stringify({ clientId, force: true }),
      }),
      clientId,
    ),
  /** Acquire without force: the node refuses while another client holds a live lease. */
  acquireControl: async (sessionId: string) =>
    controlLease(
      await request<any>(`/api/sessions/${encodeURIComponent(sessionId)}/control/acquire`, {
        method: 'POST',
        body: JSON.stringify({ clientId: getClientId(), force: false }),
      }),
    ),
  heartbeatControl: async (sessionId: string, generation: number) =>
    controlLease(
      await request<any>(`/api/sessions/${encodeURIComponent(sessionId)}/control/heartbeat`, {
        method: 'POST',
        body: JSON.stringify({ clientId: getClientId(), generation }),
      }),
    ),
  releaseControl: (sessionId: string, generation: number) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}/control/release`, {
      method: 'POST',
      body: JSON.stringify({ clientId: getClientId(), generation }),
    }),
  /**
   * Allow or deny a delegated session's confirm relayed to the chat that
   * started it (`relay.` ids). No control lease: the gateway answers it
   * for whoever may see the chat, even while another device controls it.
   */
  answerRelayed: (sessionId: string, interactionId: string, confirmed: boolean) =>
    request<void>(
      `/api/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/answer`,
      { method: 'POST', body: JSON.stringify({ answer: { confirmed } }) },
    ),
  /** Stop a delegation's run (no lease; 409 when another device controls it or nothing runs). */
  stopDelegation: (delegationId: string) =>
    request<{ status: string }>(`/api/delegations/${encodeURIComponent(delegationId)}/stop`, {
      method: 'POST',
    }),
};

export interface EventConnection {
  close(): void;
  /**
   * Reconnect at once, skipping the backoff wait (whose timer a browser also
   * throttles in the background). A no-op while a socket is open or opening.
   */
  reconnectNow(): void;
}

/** Events that change run/runner state only a snapshot reports accurately. */
const SNAPSHOT_EVENTS = new Set([
  'interaction_created',
  'interaction_answered',
  'runner_ready',
  'runner_error',
  'runner_exit',
  'node_offline',
  'node_reconnected',
]);
/** Agent lifecycle events that change run status. */
const RUN_EVENTS = new Set(['agent_start', 'agent_end', 'agent_settled']);
/**
 * What the agent says, its widgets and the delegations a chat started: the
 * engine shows no conversation (plan 12 decision 4), so they only move the cursor.
 */
const CONVERSATION_EVENTS = new Set(['notification', 'delegations_changed', 'runner_stderr']);

function piEvent(pi: any): GatewayEvent {
  if (pi.type === 'panel_changed')
    return {
      type: 'panel_changed',
      sections: Array.isArray(pi.sections) ? pi.sections.map(String) : [],
    };
  return RUN_EVENTS.has(pi.type) ? { type: 'reset', reason: 'cursor_expired' } : { type: 'noop' };
}

export function normalizeEvent(raw: any): EventEnvelope {
  const cursor = `${raw.epoch ?? 0}:${raw.sequence ?? 0}`;
  let event: GatewayEvent = { type: 'reset', reason: 'epoch_changed' };
  if (raw.type === 'reset') event = { type: 'reset', reason: raw.reason ?? 'cursor_expired' };
  else if (raw.type === 'session_deleted') event = { type: 'session_deleted' };
  else if (raw.type === 'pi_event') event = piEvent(raw.data ?? {});
  else if (raw.type === 'session_renamed' && typeof raw.data?.name === 'string')
    event = { type: 'session_renamed', name: raw.data.name };
  else if (CONVERSATION_EVENTS.has(raw.type)) event = { type: 'noop' };
  else if (SNAPSHOT_EVENTS.has(raw.type)) event = { type: 'reset', reason: 'cursor_expired' };
  return {
    sessionId: raw.sessionId ?? '',
    runnerEpoch: String(raw.epoch ?? 0),
    sequence: raw.sequence ?? 0,
    cursor,
    event,
  };
}

export function connectEvents(options: {
  sessionId: string;
  cursor?: string;
  onEvent: (envelope: EventEnvelope) => void;
  onState: (state: 'connected' | 'reconnecting' | 'offline') => void;
  /**
   * A node connected or left, or a workspace was added: reload those lists.
   * Subscribing adds `directory=1`; the gateway sends these outside the
   * session's sequence, so they never move the cursor.
   */
  onDirectory?: () => void;
  /** Your assistant memory changed (`memory=1`). */
  onMemory?: () => void;
  /** A run started or ended, or a write lease changed hands, in any of your sessions (`sessions=1`). */
  onSessions?: () => void;
}): EventConnection {
  let socket: WebSocket | undefined;
  let closed = false;
  let attempts = 0;
  let cursor = options.cursor;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    if (closed) return;
    retryTimer = undefined;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = new URLSearchParams({ sessionId: options.sessionId });
    if (cursor) query.set('cursor', cursor);
    if (options.onDirectory) query.set('directory', '1');
    if (options.onMemory) query.set('memory', '1');
    if (options.onSessions) query.set('sessions', '1');
    // Handlers act only for the current socket: a replaced socket's late
    // error/close must not close or reschedule its successor.
    const ws = new WebSocket(`${protocol}//${location.host}/api/events?${query}`);
    socket = ws;
    ws.addEventListener('open', () => {
      if (ws !== socket) return;
      attempts = 0;
      options.onState('connected');
    });
    ws.addEventListener('message', (message) => {
      if (ws !== socket) return;
      try {
        const raw = JSON.parse(String(message.data));
        if (raw?.type === 'directory_changed') {
          options.onDirectory?.();
          return;
        }
        if (raw?.type === 'memory_changed') {
          options.onMemory?.();
          return;
        }
        if (raw?.type === 'sessions_changed') {
          options.onSessions?.();
          return;
        }
        const envelope = normalizeEvent(raw);
        cursor = envelope.cursor;
        options.onEvent(envelope);
      } catch {
        ws.close(1003, 'Invalid event');
      }
    });
    ws.addEventListener('close', () => {
      if (closed || ws !== socket) return;
      options.onState(navigator.onLine ? 'reconnecting' : 'offline');
      retryTimer = setTimeout(open, Math.min(20_000, 750 * 2 ** attempts++) + Math.random() * 400);
    });
    ws.addEventListener('error', () => {
      if (ws === socket) ws.close();
    });
  };
  /** Back online or in the foreground: reconnect now instead of waiting out the backoff. */
  const reconnectNow = () => {
    if (closed) return;
    const state = socket?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    attempts = 0;
    socket?.close();
    open();
  };
  const online = reconnectNow;
  const offline = () => options.onState('offline');
  window.addEventListener('online', online);
  window.addEventListener('offline', offline);
  open();
  return {
    reconnectNow,
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close(1000, 'Session changed');
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    },
  };
}
