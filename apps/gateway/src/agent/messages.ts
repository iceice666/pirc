/**
 * Internal conversation model. Shapes intentionally match the Pi RPC message
 * format so the gateway reducer and web client keep working unchanged.
 */

export interface TextContent {
  type: 'text';
  text: string;
}
export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  /** Provider-specific opaque signature needed to replay thinking (Anthropic). */
  signature?: string;
  redacted?: boolean;
}
export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}
export interface ToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
});

export interface UserMessage {
  role: 'user';
  content: string | Array<TextContent | ImageContent>;
  timestamp: number;
}
export interface AssistantMessage {
  role: 'assistant';
  content: Array<TextContent | ThinkingContent | ToolCall>;
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  /** Stream start; also the message's identity in the client (role + timestamp). */
  timestamp: number;
  /** Stream end, so clients can order notices raised while this message streamed. */
  completedAt?: number;
}
export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: Array<TextContent | ImageContent>;
  details?: unknown;
  isError: boolean;
  timestamp: number;
}
/** Extension-originated message. `display:false` hides it in the UI but it still reaches the model. */
export interface CustomMessage {
  role: 'custom';
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
  timestamp: number;
}
export interface CompactionSummaryMessage {
  role: 'compactionSummary';
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export type Message =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | CustomMessage
  | CompactionSummaryMessage;

/** Streaming deltas emitted by providers; mirrors Pi's `assistantMessageEvent`. */
export type AssistantDelta =
  | { type: 'text_start'; contentIndex: number }
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'text_end'; contentIndex: number; content: string }
  | { type: 'thinking_start'; contentIndex: number }
  | { type: 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_end'; contentIndex: number; content: string }
  | { type: 'toolcall_start'; contentIndex: number; id: string; toolName: string }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCall };

export function textOf(content: UserMessage['content'] | ToolResultMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** Rough token estimate (chars / 4) used where provider usage is unavailable. */
export function estimateTokens(message: Message): number {
  let chars = 0;
  switch (message.role) {
    case 'user':
      chars = typeof message.content === 'string' ? message.content.length : 0;
      if (Array.isArray(message.content))
        for (const part of message.content) chars += part.type === 'text' ? part.text.length : 4800;
      break;
    case 'assistant':
      for (const part of message.content)
        chars +=
          part.type === 'text'
            ? part.text.length
            : part.type === 'thinking'
              ? part.thinking.length
              : part.name.length + JSON.stringify(part.arguments).length;
      break;
    case 'toolResult':
      for (const part of message.content) chars += part.type === 'text' ? part.text.length : 4800;
      break;
    case 'custom':
      chars = message.content.length;
      break;
    case 'compactionSummary':
      chars = message.summary.length;
      break;
  }
  return Math.ceil(chars / 4);
}
