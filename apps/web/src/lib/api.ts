import {
  interleave,
  piHistory,
  piMessage,
  piNotification,
  piPartialMessage,
  toolResultFields,
} from './pi-messages';
import { getClientId } from './storage';
import type {
  Attachment,
  CommandReceipt,
  ControlLease,
  CreateSessionInput,
  EventEnvelope,
  GatewayEvent,
  InteractionAnswer,
  ModelOption,
  NodeSummary,
  PendingInteraction,
  SessionCommandInput,
  SessionSnapshot,
  SessionSummary,
  ThinkingLevel,
  Workspace,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = 'unknown_error',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !(init.body instanceof Blob))
    headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'include' });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(
      body?.error?.message ?? body?.message ?? `Request failed (${response.status})`,
      response.status,
      body?.error?.code ?? body?.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
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
    unreadCount: 0,
  };
}

function interaction(raw: any): PendingInteraction {
  const request = raw.request ?? {};
  const base = {
    id: raw.id,
    runnerEpoch: String(raw.runnerEpoch),
    title: request.title ?? 'Pi needs your input',
    description: request.message,
    expiresAt: iso(raw.expiresAt),
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
  if (raw.kind === 'confirm') return { ...base, kind: 'confirm' };
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
    generation: lease.generation,
    expiresAt: iso(lease.expiresAt),
  };
}

async function normalizeSnapshot(raw: any): Promise<SessionSnapshot> {
  const lease = await request<any>(`/api/sessions/${encodeURIComponent(raw.session.id)}/control`);
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
      piHistory(raw.history ?? []),
      (raw.notifications ?? [])
        .filter((item: any) => item?.method === 'notify')
        .map(piNotification),
    ),
    partialMessage: partial,
    interactions: (raw.interactions ?? []).map(interaction),
    queue: [
      ...(raw.queue?.steering ?? []).map((content: string, index: number) => ({
        id: `steer-${index}`,
        kind: 'steer' as const,
        content,
        createdAt: new Date().toISOString(),
      })),
      ...(raw.queue?.followUp ?? []).map((content: string, index: number) => ({
        id: `follow-${index}`,
        kind: 'follow_up' as const,
        content,
        createdAt: new Date().toISOString(),
      })),
    ],
    control: controlLease(lease),
    cursor: `${raw.watermark?.epoch ?? 0}:${raw.watermark?.sequence ?? 0}`,
    runnerEpoch: String(raw.watermark?.epoch ?? raw.session.runnerEpoch ?? 0),
    widgets: raw.widgets ?? {},
    statuses: raw.statuses ?? {},
    ...(raw.agent?.model?.id ? { selectedModelId: raw.agent.model.id } : {}),
    ...(thinkingLevels.includes(raw.agent?.thinkingLevel)
      ? { thinkingLevel: raw.agent.thinkingLevel as ThinkingLevel }
      : {}),
  };
}

const thinkingLevels: unknown[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export const api = {
  nodes: async () => (await request<{ nodes: NodeSummary[] }>('/api/nodes')).nodes,
  workspaces: async () => (await request<any>('/api/workspaces')).workspaces as Workspace[],
  createWorkspace: async (input: { nodeId: string; path: string; displayName: string }) =>
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
          body: JSON.stringify({
            workspaceId: input.workspaceId,
            name: input.name || 'New session',
          }),
        })
      ).session,
    ),
  snapshot: async (sessionId: string) =>
    normalizeSnapshot(
      await request<any>(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot`),
    ),
  command: async (sessionId: string, input: SessionCommandInput): Promise<CommandReceipt> => {
    const payload =
      input.kind === 'prompt' || input.kind === 'steer' || input.kind === 'follow_up'
        ? { type: input.kind, message: input.content ?? '', uploadIds: input.attachmentIds }
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
          ? { confirmed: answer.value }
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
  upload: async (file: File): Promise<Attachment> => {
    const raw = await request<any>('/api/uploads', {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    return {
      id: raw.upload.id,
      name: file.name,
      mimeType: raw.upload.mimeType,
      size: raw.upload.byteSize,
    };
  },
  /** Models a session's agent can use; a daemon-only gateway lists none without one. */
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
/** Pi lifecycle events that change run status. */
const RUN_EVENTS = new Set(['agent_start', 'agent_end', 'agent_settled']);

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
        },
      };
    case 'tool_execution_update':
      return {
        type: 'tool_updated',
        tool: { id: pi.toolCallId, ...toolResultFields(pi.partialResult) },
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
        },
      };
    case 'queue_update':
      return {
        type: 'queue_updated',
        queue: [
          ...(pi.steering ?? []).map((content: string, index: number) => ({
            id: `steer-${index}`,
            kind: 'steer' as const,
            content,
            createdAt: iso(timestamp),
          })),
          ...(pi.followUp ?? []).map((content: string, index: number) => ({
            id: `follow-${index}`,
            kind: 'follow_up' as const,
            content,
            createdAt: iso(timestamp),
          })),
        ],
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
}): EventConnection {
  let socket: WebSocket | undefined;
  let closed = false;
  let attempts = 0;
  let cursor = options.cursor;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    if (closed) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = new URLSearchParams({ sessionId: options.sessionId });
    if (cursor) query.set('cursor', cursor);
    socket = new WebSocket(`${protocol}//${location.host}/api/events?${query}`);
    socket.addEventListener('open', () => {
      attempts = 0;
      options.onState('connected');
    });
    socket.addEventListener('message', (message) => {
      try {
        const envelope = normalizeEvent(JSON.parse(String(message.data)));
        cursor = envelope.cursor;
        options.onEvent(envelope);
      } catch {
        socket?.close(1003, 'Invalid event');
      }
    });
    socket.addEventListener('close', () => {
      if (closed) return;
      options.onState(navigator.onLine ? 'reconnecting' : 'offline');
      retryTimer = setTimeout(open, Math.min(20_000, 750 * 2 ** attempts++) + Math.random() * 400);
    });
    socket.addEventListener('error', () => socket?.close());
  };
  const online = () => {
    if (!closed && socket?.readyState !== WebSocket.OPEN) {
      if (retryTimer) clearTimeout(retryTimer);
      open();
    }
  };
  const offline = () => options.onState('offline');
  window.addEventListener('online', online);
  window.addEventListener('offline', offline);
  open();
  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close(1000, 'Session changed');
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    },
  };
}
