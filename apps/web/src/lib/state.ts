import { mergeTool } from './pi-messages';
import type {
  ClientSessionState,
  ConversationMessage,
  EventEnvelope,
  SessionSnapshot,
  ToolCall,
} from './types';

export function fromSnapshot(snapshot: SessionSnapshot): ClientSessionState {
  const messages = snapshot.partialMessage
    ? [
        ...snapshot.messages.filter((message) => message.id !== snapshot.partialMessage?.id),
        snapshot.partialMessage,
      ]
    : snapshot.messages;
  return { ...snapshot, messages, needsSnapshot: false };
}

export function reduceEvent(
  state: ClientSessionState,
  envelope: EventEnvelope,
): ClientSessionState {
  if (envelope.event.type !== 'reset' && envelope.runnerEpoch !== state.runnerEpoch) {
    return { ...state, needsSnapshot: true };
  }

  const base = { ...state, cursor: envelope.cursor };
  const event = envelope.event;
  switch (event.type) {
    case 'reset':
      return { ...base, needsSnapshot: true };
    case 'noop':
      return base;
    case 'widget_updated': {
      const widgets = { ...(state.widgets ?? {}) };
      if (event.lines?.length) widgets[event.key] = event.lines;
      else delete widgets[event.key];
      return { ...base, widgets };
    }
    case 'status_updated': {
      const statuses = { ...(state.statuses ?? {}) };
      if (event.text) statuses[event.key] = event.text;
      else delete statuses[event.key];
      return { ...base, statuses };
    }
    case 'message_started': {
      // Replace a stale partial with the same id; never clobber a finished message.
      const messages = state.messages.filter(
        (message) => !(message.id === event.message.id && message.isPartial),
      );
      return {
        ...base,
        messages: [
          ...messages,
          { ...event.message, id: uniqueId(messages, event.message.id, envelope) },
        ],
      };
    }
    case 'message_delta': {
      let messages = state.messages;
      let index = event.messageId
        ? messages.findIndex((message) => message.id === event.messageId)
        : findLastIndex(messages, (message) => message.role === 'assistant' && !!message.isPartial);
      if (index === -1) {
        if (event.messageId) return base;
        // Joined mid-stream without a message_start: open a live partial.
        messages = [
          ...messages,
          {
            id: uniqueId(messages, 'assistant-live', envelope),
            role: 'assistant',
            content: '',
            createdAt: new Date().toISOString(),
            isPartial: true,
          },
        ];
        index = messages.length - 1;
      }
      return {
        ...base,
        messages: messages.map((message, position) =>
          position !== index
            ? message
            : event.channel === 'thinking'
              ? { ...message, thinking: (message.thinking ?? '') + event.delta, isPartial: true }
              : { ...message, content: message.content + event.delta, isPartial: true },
        ),
      };
    }
    case 'message_completed': {
      const incoming = event.message;
      let index = state.messages.findIndex(
        (message) => message.id === incoming.id && message.isPartial,
      );
      // Pi may omit timestamps on partials; the newest partial of the same role is the one ending.
      if (index === -1 && incoming.role === 'assistant')
        index = findLastIndex(
          state.messages,
          (message) => message.role === 'assistant' && !!message.isPartial,
        );
      if (index === -1) {
        if (state.messages.some((message) => message.id === incoming.id && !message.isPartial)) {
          // Same message delivered twice (replay after reconnect): keep the newest copy.
          return {
            ...base,
            messages: state.messages.map((message) =>
              message.id === incoming.id ? withTools(incoming, message) : message,
            ),
          };
        }
        return { ...base, messages: [...state.messages, incoming] };
      }
      const previous = state.messages[index]!;
      return {
        ...base,
        messages: state.messages.map((message, position) =>
          position === index ? { ...withTools(incoming, previous), id: previous.id } : message,
        ),
      };
    }
    case 'tool_updated': {
      const tool = event.tool;
      let index = event.messageId
        ? state.messages.findIndex((message) => message.id === event.messageId)
        : findLastIndex(
            state.messages,
            (message) => !!message.tools?.some((item) => item.id === tool.id),
          );
      if (index === -1 && !event.messageId)
        index = findLastIndex(state.messages, (message) => message.role === 'assistant');
      if (index === -1) return base;
      return {
        ...base,
        messages: state.messages.map((message, position) =>
          position === index
            ? { ...message, tools: upsertTool(message.tools ?? [], tool) }
            : message,
        ),
      };
    }
    case 'run_updated':
      return { ...base, run: event.run, runnerStatus: event.runnerStatus ?? state.runnerStatus };
    case 'interaction_updated':
      return {
        ...base,
        interactions: state.interactions.some((item) => item.id === event.interaction.id)
          ? state.interactions.map((item) =>
              item.id === event.interaction.id ? event.interaction : item,
            )
          : [...state.interactions, event.interaction],
      };
    case 'interaction_removed':
      return {
        ...base,
        interactions: state.interactions.filter((item) => item.id !== event.interactionId),
      };
    case 'queue_updated':
      return { ...base, queue: event.queue };
    case 'control_updated':
      return { ...base, control: event.control };
    case 'session_updated':
      return { ...base, session: event.session };
  }
}

function upsertTool(tools: ToolCall[], tool: Pick<ToolCall, 'id'> & Partial<ToolCall>): ToolCall[] {
  return tools.some((item) => item.id === tool.id)
    ? tools.map((item) => (item.id === tool.id ? mergeTool(item, tool) : item))
    : [...tools, mergeTool(undefined, tool)];
}

/** Carry live tool results onto the final message, which only knows the calls. */
function withTools(
  incoming: ConversationMessage,
  previous: ConversationMessage,
): ConversationMessage {
  if (!previous.tools?.length) return incoming;
  const known = new Map(previous.tools.map((tool) => [tool.id, tool]));
  const tools = (incoming.tools ?? []).map((tool) => {
    const existing = known.get(tool.id);
    known.delete(tool.id);
    return existing ? mergeTool(existing, { ...tool, status: existing.status }) : tool;
  });
  return { ...incoming, tools: [...tools, ...known.values()] };
}

function uniqueId(messages: ConversationMessage[], id: string, envelope: EventEnvelope): string {
  return messages.some((message) => message.id === id) ? `${id}-${envelope.cursor}` : id;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1)
    if (predicate(items[index]!)) return index;
  return -1;
}
