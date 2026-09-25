/**
 * Conversion from Pi RPC message shapes (pi-ai / pi-coding-agent) into the
 * client timeline model. Tool results are folded into the assistant turn that
 * issued the call, so the timeline reads as conversation, not as a raw log.
 */
import type { ConversationMessage, InlineImage, NoticeLevel, ToolCall } from './types';

type Raw = Record<string, any>;

const iso = (value: unknown) =>
  new Date(typeof value === 'number' ? value : Date.now()).toISOString();

/** Stable per-message id: Pi messages carry no id, but role + timestamp is unique in practice. */
export function piMessageId(raw: Raw | null | undefined): string {
  return `${raw?.role ?? 'message'}-${raw?.timestamp ?? 'live'}`;
}

function images(content: unknown): InlineImage[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part?.type === 'image' && typeof part.data === 'string')
    .map((part) => ({
      mimeType: part.mimeType ?? 'image/png',
      url: `data:${part.mimeType ?? 'image/png'};base64,${part.data}`,
    }));
}

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

function thinking(content: unknown): { text: string; redacted: boolean } {
  if (!Array.isArray(content)) return { text: '', redacted: false };
  const blocks = content.filter((part) => part?.type === 'thinking');
  return {
    text: blocks
      .map((part) => part.thinking ?? part.text ?? '')
      .filter(Boolean)
      .join('\n\n'),
    redacted: blocks.some((part) => part.redacted),
  };
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toolFromCall(part: Raw, status: ToolCall['status']): ToolCall {
  return {
    id: part.id ?? `tool-${part.name ?? part.toolName}`,
    name: part.name ?? part.toolName ?? 'tool',
    status,
    input: parseArguments(part.arguments ?? part.toolCall?.arguments),
  };
}

/** Tool result payload (`toolResult` message or `tool_execution_*` result). */
export function toolResultFields(result: Raw | null | undefined): Partial<ToolCall> {
  if (!result) return {};
  const output = text(result.content);
  const diff = typeof result.details?.diff === 'string' ? result.details.diff : undefined;
  const found = images(result.content);
  return {
    ...(output ? { output } : {}),
    ...(diff ? { diff } : {}),
    ...(found.length ? { images: found } : {}),
  };
}

function assistantMessage(raw: Raw, id: string): ConversationMessage {
  const reasoning = thinking(raw.content);
  const failed = raw.stopReason === 'error' || raw.stopReason === 'aborted';
  const tools = Array.isArray(raw.content)
    ? raw.content
        .filter((part: Raw) => part?.type === 'toolCall')
        .map((part: Raw) => toolFromCall(part, failed ? 'failed' : 'running'))
    : [];
  return {
    id,
    role: 'assistant',
    content: text(raw.content),
    createdAt: iso(raw.timestamp),
    ...(reasoning.text ? { thinking: reasoning.text } : {}),
    ...(reasoning.redacted ? { thinkingRedacted: true } : {}),
    ...(failed ? { stopReason: raw.stopReason } : {}),
    ...(raw.errorMessage ? { errorMessage: raw.errorMessage } : {}),
    ...(raw.model ? { model: raw.model } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

/**
 * Convert one Pi message. Returns null for messages that should not appear
 * (hidden custom messages). Tool results become an orphan system entry here;
 * {@link piHistory} folds them into their owning assistant turn.
 */
export function piMessage(
  raw: Raw | null | undefined,
  id = piMessageId(raw),
): ConversationMessage | null {
  if (!raw) return null;
  const createdAt = iso(raw.timestamp);
  switch (raw.role) {
    case 'assistant':
      return assistantMessage(raw, id);
    case 'user': {
      const found = images(raw.content);
      return {
        id,
        role: 'user',
        content: text(raw.content),
        createdAt,
        ...(found.length ? { images: found } : {}),
      };
    }
    case 'toolResult':
      return {
        id,
        role: 'system',
        systemKind: 'custom',
        label: `${raw.toolName ?? 'Tool'} result`,
        content: '',
        createdAt,
        tools: [
          {
            id: raw.toolCallId ?? id,
            name: raw.toolName ?? 'tool',
            status: raw.isError ? 'failed' : 'succeeded',
            ...toolResultFields(raw),
          },
        ],
      };
    case 'bashExecution': {
      const exit = raw.cancelled
        ? 'cancelled'
        : raw.exitCode === undefined || raw.exitCode === null
          ? undefined
          : `exit ${raw.exitCode}`;
      return {
        id,
        role: 'system',
        systemKind: 'bash',
        label: raw.command ?? '',
        content: raw.output ?? '',
        createdAt,
        level: raw.cancelled || (raw.exitCode ?? 0) !== 0 ? 'warning' : 'info',
        ...(exit || raw.truncated
          ? { meta: [exit, raw.truncated ? 'truncated' : ''].filter(Boolean).join(' · ') }
          : {}),
      };
    }
    case 'compactionSummary':
      return {
        id,
        role: 'system',
        systemKind: 'compaction',
        label: 'Context compacted',
        content: raw.summary ?? '',
        createdAt,
        ...(typeof raw.tokensBefore === 'number'
          ? { meta: `${raw.tokensBefore.toLocaleString()} tokens before` }
          : {}),
      };
    case 'branchSummary':
      return {
        id,
        role: 'system',
        systemKind: 'branch',
        label: 'Branch summary',
        content: raw.summary ?? '',
        createdAt,
      };
    case 'custom': {
      if (raw.display === false) return null;
      const found = images(raw.content);
      return {
        id,
        role: 'system',
        systemKind: 'custom',
        label: raw.customType ?? 'Extension',
        content: text(raw.content),
        createdAt,
        ...(found.length ? { images: found } : {}),
      };
    }
    default:
      return {
        id,
        role: 'system',
        systemKind: 'custom',
        label: typeof raw.role === 'string' ? raw.role : 'Message',
        content: text(raw.content) || (typeof raw.summary === 'string' ? raw.summary : ''),
        createdAt,
      };
  }
}

/** Merge a result into a tool, keeping whatever the newer data does not override. */
export function mergeTool(
  existing: ToolCall | undefined,
  update: Partial<ToolCall> & { id: string },
): ToolCall {
  const base: ToolCall = existing ?? {
    id: update.id,
    name: update.name ?? 'tool',
    status: 'running',
  };
  const merged = { ...base } as ToolCall;
  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined) (merged as unknown as Raw)[key] = value;
  }
  // A finished tool never regresses to running because of a stale re-send.
  if (existing && existing.status !== 'running' && update.status === 'running')
    merged.status = existing.status;
  return merged;
}

/** Convert a full Pi history, folding tool results into their assistant turn. */
export function piHistory(history: unknown[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const owners = new Map<string, number>();
  const seen = new Set<string>();
  history.forEach((entry, index) => {
    const raw = entry as Raw;
    let id = piMessageId(raw);
    if (seen.has(id)) id = `${id}-${index}`;
    seen.add(id);

    if (raw?.role === 'toolResult' && owners.has(raw.toolCallId)) {
      const ownerIndex = owners.get(raw.toolCallId)!;
      const owner = messages[ownerIndex]!;
      messages[ownerIndex] = {
        ...owner,
        tools: (owner.tools ?? []).map((tool) =>
          tool.id === raw.toolCallId
            ? mergeTool(tool, {
                id: tool.id,
                status: raw.isError ? 'failed' : 'succeeded',
                ...toolResultFields(raw),
              })
            : tool,
        ),
      };
      return;
    }

    const message = piMessage(raw, id);
    if (!message) return;
    messages.push(message);
    for (const tool of message.tools ?? [])
      if (message.role === 'assistant') owners.set(tool.id, messages.length - 1);
  });
  return messages;
}

interface PartialBlock {
  type: 'text' | 'thinking' | 'toolCall';
  text?: string;
  id?: string;
  toolName?: string;
  arguments?: string;
  toolCall?: Raw;
}

/** Gateway-assembled partial assistant message (`{ base, content: {index: block} }`). */
export function piPartialMessage(raw: Raw | null | undefined): ConversationMessage | undefined {
  if (!raw) return undefined;
  const blocks = Object.entries(raw.content ?? {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, block]) => block as PartialBlock);
  const reasoning = blocks
    .filter((block) => block.type === 'thinking')
    .map((block) => block.text ?? '')
    .join('\n\n');
  const tools = blocks
    .filter((block) => block.type === 'toolCall')
    .map((block) =>
      toolFromCall(
        block.toolCall ?? { id: block.id, name: block.toolName, arguments: block.arguments },
        'running',
      ),
    );
  return {
    id: piMessageId(raw.base ?? { role: 'assistant' }),
    role: 'assistant',
    content: blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join(''),
    createdAt: iso(raw.base?.timestamp),
    isPartial: true,
    ...(reasoning ? { thinking: reasoning } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

/** Extension `notify` request → timeline notice. */
export function piNotification(raw: Raw, index = 0): ConversationMessage {
  const level: NoticeLevel =
    raw.notifyType === 'error' || raw.notifyType === 'warning' ? raw.notifyType : 'info';
  const at = typeof raw.receivedAt === 'number' ? raw.receivedAt : raw.timestamp;
  return {
    id: `notice-${raw.id ?? `${at ?? 'live'}-${index}`}`,
    role: 'system',
    systemKind: 'notice',
    level,
    content: String(raw.message ?? ''),
    createdAt: iso(at),
  };
}

/** Insert notices into an already chronological timeline by timestamp. */
export function interleave(
  messages: ConversationMessage[],
  notices: ConversationMessage[],
): ConversationMessage[] {
  if (!notices.length) return messages;
  const result = [...messages];
  for (const notice of notices) {
    const at = Date.parse(notice.createdAt);
    const index = result.findIndex((message) => Date.parse(message.createdAt) > at);
    if (index === -1) result.push(notice);
    else result.splice(index, 0, notice);
  }
  return result;
}
