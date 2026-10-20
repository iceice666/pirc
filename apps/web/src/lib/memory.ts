import { tr } from './i18n.svelte';
/**
 * The assistant's memory, held by the gateway (docs/architecture/assistant-memory.md): USER
 * entries (who you are; changed only with your approval), the assistant's
 * MEMORY notes, and its USER proposals waiting for you.
 */
import { request } from './http';

export type MemoryKind = 'user' | 'note';

export interface MemorySources {
  /** The chat a change came from. */
  sessionId?: string;
  entryIds?: string[];
  /** Your exact words the change rests on. */
  quote?: string;
  proposalId?: string;
}

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  status: 'active' | 'removed' | 'forgotten';
  revision: number;
  origins: string[];
  sources: MemorySources;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryProposal {
  id: string;
  action: 'add' | 'replace' | 'remove';
  targetId: string | null;
  targetRevision: number | null;
  content: string | null;
  quote: string;
  sources: MemorySources;
  sessionId: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  decidedAt: number | null;
  /** The USER entry it changes, as it is now. */
  target: { id: string; content: string; revision: number } | null;
}

export interface MemoryVersion {
  revision: number;
  op: 'add' | 'replace' | 'remove' | 'restore' | 'forget';
  content: string | null;
  origins: string[];
  sources: MemorySources;
  /** `user:<name>` or `session:<chat id>`. */
  actor: string;
  at: number;
}

export interface MemoryView {
  usage: Record<MemoryKind, { used: number; max: number }>;
  user: MemoryEntry[];
  notes: MemoryEntry[];
  removed: MemoryEntry[];
  proposals: MemoryProposal[];
  /** Names of the chats entries and proposals came from, by id. */
  sessions: Record<string, string>;
}

/** Memory is personal: never from a browser cache. */
const noStore = <T>(path: string, init: RequestInit = {}) =>
  request<T>(path, { cache: 'no-store', ...init });
const change = (path: string, body: Record<string, unknown> = {}) =>
  noStore<MemoryView>(path, { method: 'POST', body: JSON.stringify(body) });
const part = encodeURIComponent;

/** Every change answers with the whole view. */
export const memoryApi = {
  view: () => noStore<MemoryView>('/api/memory'),
  history: async (entryId: string) =>
    (await noStore<{ versions: MemoryVersion[] }>(`/api/memory/entries/${part(entryId)}/history`))
      .versions,
  /** `targetRevision`: the version of the changed entry you were shown. */
  approve: (proposalId: string, targetRevision?: number) =>
    change(
      `/api/memory/proposals/${part(proposalId)}/approve`,
      targetRevision === undefined ? {} : { targetRevision },
    ),
  reject: (proposalId: string) => change(`/api/memory/proposals/${part(proposalId)}/reject`),
  forget: (entryId: string) => change(`/api/memory/entries/${part(entryId)}/forget`),
  /** Bring back a removed entry, or restore an earlier version. */
  restore: (entryId: string, revision?: number) =>
    change(
      `/api/memory/entries/${part(entryId)}/restore`,
      revision === undefined ? {} : { revision },
    ),
};

/** Where an entry's text came from, for people. */
export function describeOrigins(origins: string[]): string {
  const tools = origins
    .filter((origin) => origin.startsWith('tool:'))
    .map((o) => (o === 'tool:bash:network' ? tr('bash fetching from the network') : o.slice(5)));
  const others = origins
    .filter((origin) => origin.startsWith('custom:'))
    .map((origin) => origin.slice(7));
  const parts = [
    ...(origins.includes('user') ? [tr('your words')] : []),
    ...(origins.includes('assistant') ? [tr('the assistant')] : []),
    ...(tools.length ? [tr('tool output ({0})', [tools.join(', ')])] : []),
    ...(others.length ? [tr('{0} messages', [others.join(', ')])] : []),
    ...(origins.includes('unknown') ? [tr('an unknown source')] : []),
  ];
  return parts.length ? tr('From {0}', [parts.join(', ')]) : '';
}

const OPS: Record<MemoryVersion['op'], string> = {
  add: 'Added',
  replace: 'Changed',
  remove: 'Removed',
  restore: 'Restored',
  forget: 'Forgotten',
};
/** "Changed by the assistant (Trip planning)", "Added by you". */
export function describeVersion(version: MemoryVersion, sessions: Record<string, string>) {
  const who = version.actor.startsWith('session:')
    ? tr('the assistant{0}', [
        sessions[version.actor.slice(8)] ? ` (${sessions[version.actor.slice(8)]})` : '',
      ])
    : 'you';
  return tr('{0} by {1}', [OPS[version.op] ?? version.op, who]);
}
