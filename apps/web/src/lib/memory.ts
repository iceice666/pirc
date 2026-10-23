/**
 * The brain's memory, held by the gateway (docs/architecture/memory.md):
 * preferences (always in its prompt, only on your word) and facts (searchable; the
 * household's, and the repositories' workspace notes).
 */
import { request } from './http';
import { t } from './i18n';
import type { MessageKey } from './i18n/messages';

export interface MemorySources {
  /** The room it was said in. */
  roomId?: string;
  entryIds?: string[];
  /** Your exact words it rests on. */
  quote?: string;
}

export interface Preference {
  id: string;
  content: string;
  status: 'active' | 'removed' | 'forgotten';
  revision: number;
  origins: string[];
  sources: MemorySources;
  createdAt: number;
  updatedAt: number;
  createdInRoom: string | null;
}

export interface MemoryVersion {
  revision: number;
  op: 'add' | 'replace' | 'remove' | 'restore' | 'forget';
  content: string | null;
  origins: string[];
  sources: MemorySources;
  /** `user:<name>`, `face:<id>` or `om`. */
  actor: string;
  at: number;
}

export interface PreferencesView {
  usage: { used: number; max: number };
  preferences: Preference[];
  removed: Preference[];
  /** Names of the rooms preferences were said in, by id. */
  rooms: Record<string, string>;
}

/** A fact as search shows it. */
export interface MemoryRecord {
  id: string;
  /** `fact`: the household's; `workspace`: a repository's note; `delegation`. */
  kind: 'fact' | 'workspace' | 'delegation';
  content: string;
  date: string;
  status: string;
  /** Facts: `user`, `tool:<name>`, `om:promoted`. */
  origin?: string;
  roomId?: string;
  /** Notes and delegations: where. */
  workspace?: string;
  git?: string;
}

export type RecordScope = 'person' | 'repo' | 'all';

/** Memory is personal: never from a browser cache. */
const noStore = <T>(path: string, init: RequestInit = {}) =>
  request<T>(path, { cache: 'no-store', ...init });
const change = (path: string, body: Record<string, unknown> = {}) =>
  noStore<PreferencesView>(path, { method: 'POST', body: JSON.stringify(body) });
const part = encodeURIComponent;

/** Every preference change answers with the whole view. */
export const memoryApi = {
  view: () => noStore<PreferencesView>('/api/memory/preferences'),
  history: async (id: string) =>
    (await noStore<{ versions: MemoryVersion[] }>(`/api/memory/preferences/${part(id)}/history`))
      .versions,
  /** Out of the prompt; it can come back. */
  remove: (id: string) => change(`/api/memory/preferences/${part(id)}/remove`),
  forget: (id: string) => change(`/api/memory/preferences/${part(id)}/forget`),
  /** Bring back a removed preference, or restore an earlier version. */
  restore: (id: string, revision?: number) =>
    change(
      `/api/memory/preferences/${part(id)}/restore`,
      revision === undefined ? {} : { revision },
    ),
  /** Facts newest first, or those matching `q`. */
  records: async (scope: RecordScope, q = '') => {
    const query = new URLSearchParams({ scope });
    if (q.trim()) query.set('q', q.trim());
    return (await noStore<{ records: MemoryRecord[] }>(`/api/memory/records?${query}`)).records;
  },
  /** Forget a household fact for real ("don't keep this"). */
  forgetRecord: (id: string) =>
    noStore<{ record: unknown }>(`/api/memory/records/${part(id)}`, { method: 'DELETE' }),
};

/** Where a fact or preference came from, for people. */
export function describeOrigin(origin: string): string {
  if (origin === 'user') return t('settings.memory.originUser');
  if (origin === 'om:promoted') return t('settings.memory.originEarlier');
  if (origin === 'tool:assistant') return t('settings.memory.originAssistant');
  if (origin.startsWith('tool:'))
    return t('settings.memory.originRead', { source: origin.slice(5) });
  return origin ? t('settings.memory.originOther', { origin }) : '';
}

/** Where a preference's text came from, for people. */
export function describeOrigins(origins: string[]): string {
  return origins.includes('user')
    ? t('settings.memory.originUser')
    : describeOrigin(origins[0] ?? '');
}

/** How a version changed it, in one word. */
const OPS: Record<MemoryVersion['op'], MessageKey> = {
  add: 'settings.memory.opAdd',
  replace: 'settings.memory.opReplace',
  remove: 'settings.memory.opRemove',
  restore: 'settings.memory.opRestore',
  forget: 'settings.memory.opForget',
};

/** "Added by pirc", "Restored by you". */
export function describeVersion(version: MemoryVersion) {
  const who = version.actor.startsWith('face:')
    ? t('settings.memory.whoPirc')
    : version.actor === 'om'
      ? t('settings.memory.whoEarlier')
      : t('settings.memory.whoYou');
  const op = OPS[version.op] ? t(OPS[version.op]) : version.op;
  return t('settings.memory.version', { op, who });
}

/** What a room line says it remembered (`body.memory`). */
export interface RememberedLine {
  kind: 'fact' | 'preference';
  id: string;
  origin?: string;
  user?: string;
  forgotten?: boolean;
}

/** "Don't keep this" on a room line. */
export function forgetRemembered(memory: RememberedLine) {
  return memory.kind === 'fact' ? memoryApi.forgetRecord(memory.id) : memoryApi.forget(memory.id);
}
