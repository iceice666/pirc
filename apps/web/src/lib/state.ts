import type { ClientSessionState, EventEnvelope, SessionSnapshot, ToolCall } from './types';

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
    case 'message_started':
      return {
        ...base,
        messages: [
          ...state.messages.filter((message) => message.id !== event.message.id),
          event.message,
        ],
      };
    case 'message_delta': {
      const existing = state.messages.find((message) => message.id === event.messageId);
      if (!existing) return base;
      return {
        ...base,
        messages: state.messages.map((message) =>
          message.id === event.messageId
            ? { ...message, content: message.content + event.delta, isPartial: true }
            : message,
        ),
      };
    }
    case 'message_completed':
      return {
        ...base,
        messages: state.messages.some((message) => message.id === event.message.id)
          ? state.messages.map((message) =>
              message.id === event.message.id ? event.message : message,
            )
          : [...state.messages, event.message],
      };
    case 'tool_updated':
      return {
        ...base,
        messages: state.messages.map((message) =>
          message.id === event.messageId
            ? { ...message, tools: upsertTool(message.tools ?? [], event.tool) }
            : message,
        ),
      };
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

function upsertTool(tools: ToolCall[], tool: ToolCall): ToolCall[] {
  return tools.some((item) => item.id === tool.id)
    ? tools.map((item) => (item.id === tool.id ? tool : item))
    : [...tools, tool];
}
