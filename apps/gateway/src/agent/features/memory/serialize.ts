import type { Message } from '../../messages.js';
import type { SessionEntry } from '../../session-store.js';
import { estimateStringTokens, isSource, localStamp } from './ledger.js';

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((part: any) => part?.type === 'text')
          .map((part: any) => part.text)
          .join('\n')
      : '';

/**
 * Where a message came from, from its role (never from the model): `user`,
 * `assistant`, `tool:<name>` or `custom:<type>`.
 */
export function messageOrigin(message: Message): string {
  switch (message.role) {
    case 'toolResult':
      return `tool:${message.toolName}`;
    case 'custom':
      return `custom:${message.customType}`;
    default:
      return message.role;
  }
}

/**
 * What the observer sees instead of recall output: recalled memory replays
 * older evidence, and learning it again would let memory reinforce itself.
 */
export const RECALL_OMITTED = '[recalled memory omitted: not new evidence]';

/** Render one message for the observer (and recall). */
export function renderMessage(message: Message, style: 'observer' | 'recall' = 'observer'): string {
  const time = localStamp(message.timestamp);
  const at = time.startsWith('?') && style === 'recall' ? 'Unknown time' : time;
  switch (message.role) {
    case 'user':
      return `[User @ ${at}]: ${textOf(message.content)}`;
    case 'assistant': {
      const body = message.content
        .map((part) => {
          if (part.type === 'text') return part.text;
          if (part.type === 'thinking') return part.redacted ? '' : `[thinking: ${part.thinking}]`;
          if (part.type === 'toolCall') return `[${part.name}(${JSON.stringify(part.arguments)})]`;
          return '[non-text content omitted]';
        })
        .join('\n')
        .split('\n')
        .filter((line) => line.trim())
        .join('\n');
      return body ? `[Assistant @ ${at}]: ${body}` : '';
    }
    case 'toolResult':
      return style === 'recall'
        ? `[Tool result: ${message.toolName} @ ${at}]: ${textOf(message.content)}`
        : `[Tool result for ${message.toolName} @ ${at}]: ${message.toolName === 'recall' ? RECALL_OMITTED : textOf(message.content)}`;
    case 'custom':
      return style === 'recall'
        ? `[Custom message (${message.customType}) @ ${at}]: ${textOf(message.content)}`
        : `[Custom (${message.customType}) @ ${at}]: ${textOf(message.content)}`;
    default:
      return '';
  }
}

const MIDDLE =
  '\n\n[… middle omitted: source exceeds observer input budget; original source remains in the session ledger …]\n\n';

export interface Chunk {
  text: string;
  sourceEntryIds: string[];
  /** `messageOrigin` of every source entry in the chunk, by entry id. */
  origins: Record<string, string>;
  estimatedTokens: number;
}

/** Serialize source entries oldest-first until `maxTokens`. */
export function serializeChunk(entries: SessionEntry[], maxTokens: number): Chunk {
  const blocks: string[] = [];
  const ids: string[] = [];
  const origins: Record<string, string> = {};
  let estimated = 0;
  for (const entry of entries) {
    if (!isSource(entry)) continue;
    const rendered = renderMessage(entry.message);
    if (!rendered) continue;
    let block = `[Source entry id: ${entry.id}]\n${rendered}`;
    const cost = estimateStringTokens((blocks.length ? '\n\n' : '') + block);
    if (estimated + cost > maxTokens) {
      if (blocks.length) break;
      const maxChars = maxTokens * 4;
      const room = Math.max(0, maxChars - MIDDLE.length);
      block = block.slice(0, Math.floor(room / 2)) + MIDDLE + block.slice(-Math.floor(room / 2));
      blocks.push(block);
      ids.push(entry.id);
      origins[entry.id] = messageOrigin(entry.message);
      estimated = estimateStringTokens(block);
      break;
    }
    blocks.push(block);
    ids.push(entry.id);
    origins[entry.id] = messageOrigin(entry.message);
    estimated += cost;
  }
  return { text: blocks.join('\n\n'), sourceEntryIds: ids, origins, estimatedTokens: estimated };
}
