import {
  interleave,
  piHistory,
  piMessage,
  piNotification,
  piPartialMessage,
  toolResultFields,
} from './pi-messages';
import type { NewWorkspace } from './chats';
import { request } from './http';
import { uuid } from './id';
import { getClientId } from './storage';
import type {
  Attachment,
  BackendModel,
  BackendPreset,
  BackendProbeInput,
  BackendProviderInput,
  BackendSettingsSnapshot,
  ConnectionTestResult,
  DiscoveredModel,
  ProviderAuthSession,
  CommandReceipt,
  ControlLease,
  CreateSessionInput,
  EventEnvelope,
  GatewayEvent,
  InteractionAnswer,
  ModelOption,
  NodeSummary,
  PendingInteraction,
  QueueItem,
  SessionOrigin,
  SessionCommandInput,
  SessionSnapshot,
  SessionSummary,
  SessionUpdateInput,
  ThinkingLevel,
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
  if (raw?.kind === 'schedule' && typeof raw.scheduleId === 'string')
    return {
      kind: 'schedule',
      scheduleId: raw.scheduleId,
      title: String(raw.title ?? ''),
      dueAt: Number(raw.dueAt) || 0,
    };
  if (raw?.kind === 'delegation' && typeof raw.fromSessionId === 'string')
    return {
      kind: 'delegation',
      delegationId: String(raw.delegationId ?? ''),
      title: String(raw.title ?? ''),
      fromSessionId: raw.fromSessionId,
    };
  return undefined;
}

function interaction(raw: any): PendingInteraction {
  const request = raw.request ?? {};
  const base = {
    id: raw.id,
    runnerEpoch: String(raw.runnerEpoch),
    ...(typeof request.toolCallId === 'string' ? { toolCallId: request.toolCallId } : {}),
    title: request.title ?? 'The agent needs your input',
    description: request.message,
    ...(typeof raw.expiresAt === 'number' ? { expiresAt: iso(raw.expiresAt) } : {}),
    status: raw.status ?? 'pending',
  } as const;
  if (raw.kind === 'select')
    return {
      ...base,
      kind: 'select',
      ...(request.multiple ? { multiple: true } : {}),
      options: (request.options ?? []).map((value: string, index: number) => ({
        value,
        label: value,
        ...(request.optionDescriptions?.[index]
          ? { description: request.optionDescriptions[index] }
          : {}),
      })),
    };
  if (raw.kind === 'confirm')
    return {
      ...base,
      kind: 'confirm',
      ...(typeof request.confirmLabel === 'string' ? { confirmLabel: request.confirmLabel } : {}),
      ...(typeof request.cancelLabel === 'string' ? { cancelLabel: request.cancelLabel } : {}),
      ...(request.modelChoice && typeof request.modelChoice === 'object'
        ? {
            modelChoice: {
              model:
                typeof request.modelChoice.model?.provider === 'string' &&
                typeof request.modelChoice.model?.id === 'string'
                  ? {
                      provider: request.modelChoice.model.provider,
                      id: request.modelChoice.model.id,
                    }
                  : null,
              thinking:
                typeof request.modelChoice.thinking === 'string'
                  ? request.modelChoice.thinking
                  : null,
            },
          }
        : {}),
    };
  if (raw.kind === 'editor')
    return { ...base, kind: 'editor', initialValue: request.prefill ?? '' };
  return { ...base, kind: 'input', placeholder: request.placeholder };
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
 * A gateway snapshot (plus its control lease) as client state. Pure, so the
 * shared timeline fixtures (`fixtures/timeline`) can pin it for every client.
 */
export function snapshotFromRaw(raw: any, lease: unknown): SessionSnapshot {
  const partial = piPartialMessage(raw.partialMessage);
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
    messages: interleave(
      piHistory(raw.history ?? [], Array.isArray(raw.operations) ? raw.operations : []),
      (raw.notifications ?? [])
        .filter((item: any) => item?.method === 'notify')
        .map(piNotification),
    ),
    partialMessage: partial,
    interactions: (raw.interactions ?? []).map(interaction),
    queue: queueItems(raw.queue ?? {}, iso(undefined)),
    control: controlLease(lease),
    cursor: `${raw.watermark?.epoch ?? 0}:${raw.watermark?.sequence ?? 0}`,
    runnerEpoch: String(raw.watermark?.epoch ?? raw.session.runnerEpoch ?? 0),
    widgets: raw.widgets ?? {},
    statuses: raw.statuses ?? {},
    ...(typeof raw.sandbox?.active === 'boolean'
      ? {
          sandbox: {
            active: raw.sandbox.active,
            ...(typeof raw.sandbox.reason === 'string' ? { reason: raw.sandbox.reason } : {}),
          },
        }
      : {}),
    ...(raw.agent?.model?.id ? { selectedModelId: raw.agent.model.id } : {}),
    ...(raw.agent?.model?.provider ? { selectedModelProvider: raw.agent.model.provider } : {}),
    ...(thinkingLevels.includes(raw.agent?.thinkingLevel)
      ? { thinkingLevel: raw.agent.thinkingLevel as ThinkingLevel }
      : {}),
  };
}

/** Pi's steering and follow-up queues (snapshot or `queue_update`) as queue items. */
function queueItems(
  raw: { steering?: string[]; followUp?: string[] },
  createdAt: string,
): QueueItem[] {
  return [
    ...(raw.steering ?? []).map((content, index) => ({
      id: `steer-${index}`,
      kind: 'steer' as const,
      index,
      content,
      createdAt,
    })),
    ...(raw.followUp ?? []).map((content, index) => ({
      id: `follow-${index}`,
      kind: 'follow_up' as const,
      index,
      content,
      createdAt,
    })),
  ];
}

const thinkingLevels: unknown[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

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
  createWorkspace: async (input: NewWorkspace) =>
    (
      await request<{ workspace: Workspace }>('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify(input),
      })
    ).workspace,
  sessions: async () =>
    ((await request<any>('/api/sessions')).sessions as any[]).map(sessionSummary),
  createSession: async (input: CreateSessionInput) =>
    sessionSummary(
      (
        await request<any>('/api/sessions', {
          method: 'POST',
          // The agent titles the session from the first message.
          body: JSON.stringify({ workspaceId: input.workspaceId }),
        })
      ).session,
    ),
  deleteSession: (sessionId: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
  /** Rename, pin or settle a session. */
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
  snapshot: async (sessionId: string) => {
    const prefix = `/api/sessions/${encodeURIComponent(sessionId)}`;
    const raw = await request<any>(`${prefix}/snapshot`);
    if (raw.authority === 'gateway' && raw.session) {
      const cursors = new Set<string>();
      let bytes = JSON.stringify(raw.history ?? []).length;
      while (raw.historyPage?.olderAvailable) {
        const before = raw.historyPage.olderCursor;
        if (typeof before !== 'string' || cursors.has(before) || cursors.size >= 256)
          throw new Error('Gateway history pagination is invalid or exceeds client limit');
        cursors.add(before);
        const page = await request<any>(`${prefix}/history?before=${encodeURIComponent(before)}`);
        if (!Array.isArray(page.history)) throw new Error('Invalid gateway history page');
        bytes += JSON.stringify(page.history).length;
        if (bytes > 32 * 1024 * 1024)
          throw new Error('Gateway history exceeds client memory budget');
        raw.history = [...page.history, ...(raw.history ?? [])];
        raw.historyPage = page.historyPage;
      }
    }
    return normalizeSnapshot(raw);
  },
  command: async (sessionId: string, input: SessionCommandInput): Promise<CommandReceipt> => {
    // A selection can be made before this browser acquires control, while a new
    // session has no runner yet. Apply the visible settings before the prompt;
    // putting modelId on a message payload does not change the agent's model.
    if (input.kind === 'prompt') {
      const applySetting = async (setting: Partial<SessionCommandInput>) => {
        const receipt = await api.command(sessionId, {
          ...input,
          ...setting,
          commandId: uuid(),
        });
        if (receipt.status !== 'accepted')
          throw new Error(receipt.message ?? 'Session settings were not accepted.');
      };
      if (input.modelId) {
        if (!input.provider) throw new Error('The selected model has no provider.');
        await applySetting({ kind: 'set_model' });
      }
      if (input.thinkingLevel) await applySetting({ kind: 'set_thinking' });
    }
    const payload =
      input.kind === 'prompt' || input.kind === 'steer' || input.kind === 'follow_up'
        ? { type: input.kind, message: input.content ?? '', uploadIds: input.attachmentIds }
        : input.kind === 'send_now'
          ? {
              type: input.kind,
              queue: input.queued?.kind === 'follow_up' ? 'followUp' : 'steering',
              index: input.queued?.index ?? 0,
              message: input.content ?? '',
            }
          : input.kind === 'set_model'
            ? { type: input.kind, provider: input.provider ?? '', modelId: input.modelId ?? '' }
            : input.kind === 'set_thinking'
              ? { type: input.kind, level: input.thinkingLevel ?? 'off' }
              : { type: input.kind };
    const response = await request<any>(`/api/sessions/${encodeURIComponent(sessionId)}/commands`, {
      method: 'POST',
      body: JSON.stringify({
        commandId: input.commandId,
        clientId: getClientId(),
        generation: input.controlGeneration,
        payload,
      }),
    });
    return {
      commandId: response.command.id,
      status: response.command.status,
      message: response.command.error ?? undefined,
    };
  },
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
  answerInteraction: (
    sessionId: string,
    interactionId: string,
    answer: InteractionAnswer,
    generation: number,
  ) => {
    const rpcAnswer =
      answer.action === 'cancel'
        ? { cancelled: true }
        : typeof answer.value === 'boolean'
          ? {
              confirmed: answer.value,
              ...(answer.value && answer.model !== undefined ? { model: answer.model } : {}),
              ...(answer.value && answer.thinking !== undefined
                ? { thinking: answer.thinking }
                : {}),
            }
          : Array.isArray(answer.value)
            ? { value: answer.value.join(', '), values: answer.value }
            : { value: answer.value };
    return request<void>(
      `/api/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/answer`,
      {
        method: 'POST',
        body: JSON.stringify({
          clientId: getClientId(),
          generation,
          answer: rpcAnswer,
        }),
      },
    );
  },
  /**
   * Stored on the session's node. Images ride in the model's context;
   * anything else is copied into the workspace for the agent's file tools —
   * `filename` lets the node tell them apart and name the copy.
   */
  upload: async (sessionId: string, file: File): Promise<Attachment> => {
    const query = `?filename=${encodeURIComponent(file.name)}`;
    const raw = await request<any>(
      `/api/sessions/${encodeURIComponent(sessionId)}/uploads${query}`,
      {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      },
    );
    return {
      id: raw.upload.id,
      name: file.name,
      mimeType: raw.upload.mimeType,
      size: raw.upload.byteSize,
      kind: raw.upload.kind ?? 'image',
    };
  },
  /** The gateway's models; every session and node uses the same list. */
  models: async (sessionId?: string): Promise<ModelOption[]> => {
    const raw = await request<any>(
      sessionId ? `/api/models?sessionId=${encodeURIComponent(sessionId)}` : '/api/models',
    );
    return (raw.models ?? []).map((model: any) => ({
      id: model.id,
      provider: model.provider,
      displayName: model.name ?? model.id,
      contextWindow: model.contextWindow,
      thinkingLevels: (model.reasoning
        ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
        : ['off']) as ThinkingLevel[],
      available: true,
    }));
  },
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

/** A `ptc` operation's link to its `ptc` call. */
const parentOf = (pi: any): { parentId?: string } =>
  typeof pi.parentToolCallId === 'string' ? { parentId: pi.parentToolCallId } : {};

function piEvent(pi: any, timestamp: unknown): GatewayEvent {
  switch (pi.type) {
    case 'message_start': {
      if (pi.message?.role !== 'assistant') return { type: 'noop' };
      const message = piMessage(pi.message);
      return message
        ? { type: 'message_started', message: { ...message, isPartial: true } }
        : { type: 'noop' };
    }
    case 'message_update': {
      const delta = pi.assistantMessageEvent ?? {};
      if (delta.type === 'text_delta' || delta.type === 'thinking_delta')
        return {
          type: 'message_delta',
          delta: delta.delta ?? '',
          channel: delta.type === 'thinking_delta' ? 'thinking' : 'text',
        };
      if (delta.type === 'toolcall_start' && delta.id)
        return {
          type: 'tool_updated',
          tool: { id: delta.id, name: delta.toolName ?? 'tool', status: 'running' },
        };
      if (delta.type === 'toolcall_end' && delta.toolCall?.id)
        return {
          type: 'tool_updated',
          tool: {
            id: delta.toolCall.id,
            name: delta.toolCall.name ?? 'tool',
            input: delta.toolCall.arguments,
            status: 'running',
          },
        };
      return { type: 'noop' };
    }
    case 'message_end': {
      const raw = pi.message;
      if (raw?.role === 'toolResult')
        return {
          type: 'tool_updated',
          tool: {
            id: raw.toolCallId,
            name: raw.toolName,
            status: raw.isError ? 'failed' : 'succeeded',
            ...toolResultFields(raw),
          },
        };
      const message = piMessage(raw);
      return message ? { type: 'message_completed', message } : { type: 'noop' };
    }
    case 'tool_execution_start':
      return {
        type: 'tool_updated',
        tool: {
          id: pi.toolCallId,
          name: pi.toolName,
          input: pi.args,
          status: 'running',
          startedAt: iso(timestamp),
          ...parentOf(pi),
        },
      };
    case 'tool_execution_update':
      return {
        type: 'tool_updated',
        tool: { id: pi.toolCallId, ...toolResultFields(pi.partialResult), ...parentOf(pi) },
      };
    case 'tool_execution_end':
      return {
        type: 'tool_updated',
        tool: {
          id: pi.toolCallId,
          name: pi.toolName,
          status: pi.isError ? 'failed' : 'succeeded',
          endedAt: iso(timestamp),
          ...toolResultFields(pi.result),
          ...parentOf(pi),
        },
      };
    case 'queue_update':
      return { type: 'queue_updated', queue: queueItems(pi, iso(timestamp)) };
    case 'panel_changed':
      return {
        type: 'panel_changed',
        sections: Array.isArray(pi.sections) ? pi.sections.map(String) : [],
      };
    default:
      return RUN_EVENTS.has(pi.type)
        ? { type: 'reset', reason: 'cursor_expired' }
        : { type: 'noop' };
  }
}

export function normalizeEvent(raw: any): EventEnvelope {
  const cursor = `${raw.epoch ?? 0}:${raw.sequence ?? 0}`;
  let event: GatewayEvent = { type: 'reset', reason: 'epoch_changed' };
  if (raw.type === 'reset') event = { type: 'reset', reason: raw.reason ?? 'cursor_expired' };
  else if (raw.type === 'session_deleted') event = { type: 'session_deleted' };
  else if (
    raw.type === 'interaction_created' &&
    (raw.data?.id?.startsWith('memory:') ||
      raw.data?.id?.startsWith('gateway-question-') ||
      raw.data?.id?.startsWith('node-environment-'))
  )
    event = { type: 'interaction_updated', interaction: interaction(raw.data) };
  else if (
    raw.type === 'interaction_answered' &&
    (raw.data?.interactionId?.startsWith('memory:') ||
      raw.data?.interactionId?.startsWith('gateway-question-') ||
      raw.data?.interactionId?.startsWith('node-environment-'))
  )
    event = { type: 'interaction_removed', interactionId: raw.data.interactionId };
  else if (raw.type === 'pi_event') event = piEvent(raw.data ?? {}, raw.timestamp);
  else if (raw.type === 'notification')
    event =
      raw.data?.method === 'notify'
        ? {
            type: 'message_completed',
            message: piNotification({ ...raw.data, receivedAt: raw.timestamp }),
          }
        : raw.data?.method === 'setWidget'
          ? {
              type: 'widget_updated',
              key: String(raw.data.widgetKey ?? ''),
              ...(Array.isArray(raw.data.widgetLines) ? { lines: raw.data.widgetLines } : {}),
            }
          : raw.data?.method === 'setStatus'
            ? {
                type: 'status_updated',
                key: String(raw.data.statusKey ?? ''),
                ...(typeof raw.data.statusText === 'string' ? { text: raw.data.statusText } : {}),
              }
            : { type: 'noop' };
  else if (raw.type === 'session_renamed' && typeof raw.data?.name === 'string')
    event = { type: 'session_renamed', name: raw.data.name };
  else if (raw.type === 'runner_stderr') event = { type: 'noop' };
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
  /** Your assistant memory changed (`memory=1`), for example a new proposal to approve. */
  onMemory?: () => void;
  /** Your schedules or their runs changed (`schedules=1`). */
  onSchedules?: () => void;
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
    if (options.onSchedules) query.set('schedules', '1');
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
        if (raw?.type === 'schedules_changed') {
          options.onSchedules?.();
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
