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
}

export const emptyReducedState = (): ReducedSessionState => ({
  history: [],
  partialMessage: null,
  queue: { steering: [], followUp: [] },
  notifications: [],
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
  } else if (event.type === 'queue_update')
    state.queue = { steering: event.steering ?? [], followUp: event.followUp ?? [] };
  else if (event.type === 'extension_ui_request' && event.method === 'notify')
    state.notifications.push({ ...event, receivedAt: Date.now() });
}
