interface PartialContent {
  type: 'text' | 'thinking' | 'toolCall';
  text?: string;
  id?: string;
  toolName?: string;
  arguments?: string;
  toolCall?: unknown;
}
export interface ReducedSessionState {
  history: unknown[];
  partialMessage: { base: unknown; content: Record<number, PartialContent> } | null;
  queue: { steering: string[]; followUp: string[] };
  notifications: Record<string, unknown>[];
  /** Extension panels (`setWidget`) and status-line entries (`setStatus`), keyed by extension. */
  widgets: Record<string, string[]>;
  statuses: Record<string, string>;
  /**
   * `ptc` operations still running (started, not ended), so a snapshot can
   * show them under their `ptc` call — e.g. one waiting for an approval.
   * Finished ones are in the session file's history.
   */
  operations: RunningOperation[];
}

export interface RunningOperation {
  toolCallId: string;
  parentToolCallId: string;
  toolName: string;
  args: unknown;
}

/** A ptc execution has at most 8 operations in flight; keep a margin, never grow unbounded. */
const MAX_RUNNING_OPERATIONS = 32;
/** Arguments kept per running operation (e.g. a `write` may carry 1 MiB of content). */
const MAX_ARGS_CHARS = 4096;

/** Arguments for display: long strings are cut, and anything larger than the bound is dropped. */
function boundedArgs(args: unknown): unknown {
  const cut = (value: unknown): unknown =>
    typeof value === 'string' && value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
  const shallow =
    args && typeof args === 'object' && !Array.isArray(args)
      ? Object.fromEntries(Object.entries(args).map(([key, value]) => [key, cut(value)]))
      : cut(args);
  return JSON.stringify(shallow ?? {}).length <= MAX_ARGS_CHARS ? (shallow ?? {}) : {};
}

export const emptyReducedState = (): ReducedSessionState => ({
  history: [],
  partialMessage: null,
  queue: { steering: [], followUp: [] },
  notifications: [],
  widgets: {},
  statuses: {},
  operations: [],
});

export function reducePiEvent(state: ReducedSessionState, event: Record<string, any>): void {
  if (event.type === 'message_start') state.partialMessage = { base: event.message, content: {} };
  else if (event.type === 'message_update') {
    if (!state.partialMessage) state.partialMessage = { base: null, content: {} };
    const delta = event.assistantMessageEvent as Record<string, any> | undefined;
    if (!delta || typeof delta.contentIndex !== 'number') return;
    const index = delta.contentIndex;
    const existing = state.partialMessage.content[index];
    if (delta.type === 'text_start')
      state.partialMessage.content[index] = { type: 'text', text: '' };
    else if (delta.type === 'text_delta')
      state.partialMessage.content[index] = {
        type: 'text',
        text: `${existing?.text ?? ''}${delta.delta ?? ''}`,
      };
    else if (delta.type === 'text_end')
      state.partialMessage.content[index] = {
        type: 'text',
        text: delta.content ?? existing?.text ?? '',
      };
    else if (delta.type === 'thinking_start')
      state.partialMessage.content[index] = { type: 'thinking', text: '' };
    else if (delta.type === 'thinking_delta')
      state.partialMessage.content[index] = {
        type: 'thinking',
        text: `${existing?.text ?? ''}${delta.delta ?? ''}`,
      };
    else if (delta.type === 'thinking_end')
      state.partialMessage.content[index] = {
        type: 'thinking',
        text: delta.content ?? existing?.text ?? '',
      };
    else if (delta.type === 'toolcall_start')
      state.partialMessage.content[index] = {
        type: 'toolCall',
        id: delta.id,
        toolName: delta.toolName,
        arguments: '',
      };
    else if (delta.type === 'toolcall_delta')
      state.partialMessage.content[index] = {
        ...(existing ?? { type: 'toolCall' }),
        type: 'toolCall',
        arguments: `${existing?.arguments ?? ''}${delta.delta ?? ''}`,
      };
    else if (delta.type === 'toolcall_end')
      state.partialMessage.content[index] = {
        ...(existing ?? { type: 'toolCall' }),
        type: 'toolCall',
        toolCall: delta.toolCall,
      };
  } else if (event.type === 'message_end') {
    state.history.push(event.message);
    state.partialMessage = null;
  } else if (
    event.type === 'tool_execution_start' &&
    typeof event.parentToolCallId === 'string' &&
    typeof event.toolCallId === 'string'
  ) {
    state.operations = [
      ...state.operations.filter((item) => item.toolCallId !== event.toolCallId),
      {
        toolCallId: event.toolCallId,
        parentToolCallId: event.parentToolCallId,
        toolName: String(event.toolName ?? 'tool'),
        args: boundedArgs(event.args),
      },
    ].slice(-MAX_RUNNING_OPERATIONS);
  } else if (event.type === 'tool_execution_end' && typeof event.parentToolCallId === 'string')
    state.operations = state.operations.filter((item) => item.toolCallId !== event.toolCallId);
  else if (event.type === 'agent_end' || event.type === 'agent_settled') state.operations = [];
  else if (event.type === 'queue_update')
    state.queue = { steering: event.steering ?? [], followUp: event.followUp ?? [] };
  else if (event.type === 'extension_ui_request' && event.method === 'notify')
    state.notifications.push({ ...event, receivedAt: Date.now() });
  else if (event.type === 'extension_ui_request' && event.method === 'setWidget') {
    const key = String(event.widgetKey ?? '');
    if (Array.isArray(event.widgetLines) && event.widgetLines.length)
      // Room for a header plus the todo list's 50 tasks.
      state.widgets[key] = event.widgetLines.map(String).slice(0, 64);
    else delete state.widgets[key];
  } else if (event.type === 'extension_ui_request' && event.method === 'setStatus') {
    const key = String(event.statusKey ?? '');
    if (typeof event.statusText === 'string' && event.statusText)
      state.statuses[key] = event.statusText;
    else delete state.statuses[key];
  }
}
