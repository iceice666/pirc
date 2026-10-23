/**
 * Sources (plans/rewrite/09-sources.md): what pirc reads beyond the rooms — a
 * mailbox over IMAP (Gmail with an app password), a calendar (an ICS address or
 * CalDAV), Moodle (signed in like the Moodle app), a workspace's commits. All
 * read-only; the credentials stay on the gateway and no answer holds one. The
 * gateway polls each and wakes pirc only when a room follows the source or a
 * change touches an open loop.
 */
import { request } from './http';
import { t } from './i18n';

export type SourceKind = 'email' | 'calendar' | 'moodle' | 'workspace';

export interface Source {
  id: string;
  kind: SourceKind;
  name: string;
  /** Who added it. */
  user: string;
  /** What it is, without any credential (host, user name, site, workspace). */
  config: Record<string, unknown>;
  pausedAt: number | null;
  lastPolledAt: number | null;
  lastError: string | null;
  /** Polls failed in a row. */
  failures: number;
  createdAt: number;
  updatedAt: number;
  /** Rooms that follow it. */
  rooms: string[];
  cadenceMs: number;
}

export interface SourceList {
  sources: Source[];
  kinds: SourceKind[];
  webSearch: { available: boolean };
}

export interface SourceItem {
  id: string;
  sourceId: string;
  externalId: string;
  kind: 'message' | 'event' | 'assignment' | 'notification' | 'commit';
  title: string;
  who: string | null;
  at: number | null;
  summary: string;
  url: string | null;
  createdAt: number;
  updatedAt: number;
}

/** What adding (or changing) a source sends. */
export interface SourceInput {
  kind?: SourceKind;
  name?: string;
  config?: Record<string, unknown>;
  /** Write-only: a password, an app password, an ICS address, a Moodle login. */
  secret?: Record<string, unknown>;
}

export interface PollResult {
  source: Source;
  baseline: boolean;
  changed: SourceItem[];
  wake: { id: string } | null;
  error: { message: string; auth: boolean } | null;
}

const path = (id: string, rest = '') => `/api/sources/${encodeURIComponent(id)}${rest}`;
const send = (method: string, body?: unknown): RequestInit => ({
  method,
  cache: 'no-store',
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const sourcesApi = {
  list: () => request<SourceList>('/api/sources', { cache: 'no-store' }),
  create: (input: SourceInput) =>
    request<{ source: Source; test: string }>('/api/sources', send('POST', input)),
  update: (id: string, input: SourceInput) =>
    request<{ source: Source; test: string | null }>(path(id), send('PUT', input)),
  remove: (id: string) => request<{ deleted: string }>(path(id), send('DELETE')),
  test: (id: string) => request<{ ok: true; test: string }>(path(id, '/test'), send('POST')),
  pause: (id: string) => request<{ source: Source }>(path(id, '/pause'), send('POST')),
  resume: (id: string) => request<{ source: Source }>(path(id, '/resume'), send('POST')),
  poll: (id: string) => request<PollResult>(path(id, '/poll'), send('POST')),
  items: (id: string, query = '', limit = 20) => {
    const search = new URLSearchParams({ limit: String(limit) });
    if (query.trim()) search.set('q', query.trim());
    return request<{ items: SourceItem[] }>(path(id, `/items?${search}`), { cache: 'no-store' });
  },
  /** Start a Moodle app login: open `launchUrl`, sign in, paste where it ends. */
  moodleLaunch: (url: string) =>
    request<{ site: string; launchUrl: string }>(
      '/api/sources/moodle/launch',
      send('POST', { url }),
    ),
};

/**
 * What a kind of source is called, in the current locale. Getters, so a
 * component that reads `KIND_LABELS[source.kind]` re-renders with the rest of
 * the page when someone switches language.
 */
export const KIND_LABELS: Record<SourceKind, string> = {
  get email() {
    return t('engine.source.kind.email');
  },
  get calendar() {
    return t('engine.source.kind.calendar');
  },
  get moodle() {
    return t('engine.source.kind.moodle');
  },
  get workspace() {
    return t('engine.source.kind.workspace');
  },
};

/** What a source is, in one line (no credential is ever in `config`). */
export function describeSource(source: Source): string {
  const text = (key: string) =>
    typeof source.config[key] === 'string' ? (source.config[key] as string) : '';
  switch (source.kind) {
    case 'email':
      return [text('username'), text('host'), text('mailbox')].filter(Boolean).join(' · ');
    case 'calendar':
      return text('mode') === 'caldav'
        ? `CalDAV · ${text('username')} · ${text('host')}`
        : `ICS · ${text('host')}`;
    case 'moodle':
      return [text('siteName'), text('fullName') || text('username'), text('url')]
        .filter(Boolean)
        .join(' · ');
    case 'workspace':
      return text('workspaceName') || text('workspace');
  }
}

/** How often it is read, for people. */
export function cadence(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t('engine.source.cadence.minutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  return hours >= 24
    ? t('engine.source.cadence.daily')
    : t('engine.source.cadence.hours', { count: hours });
}

/** Its state, for people: paused, failing, read, or not yet. */
export function sourceStatus(source: Source): { text: string; tone: 'muted' | 'ok' | 'error' } {
  if (source.pausedAt) return { text: t('common.status.paused'), tone: 'muted' };
  if (source.failures > 0 && source.lastError)
    return { text: t('engine.source.cannotRead', { error: source.lastError }), tone: 'error' };
  if (source.lastPolledAt)
    return {
      text: t('engine.source.read', { when: cadence(source.cadenceMs) }),
      tone: 'ok',
    };
  return { text: t('engine.source.notRead'), tone: 'muted' };
}

/** The source ids a room's `sourceScope` follows. */
export function followedSources(scope: unknown): string[] {
  if (!scope || typeof scope !== 'object') return [];
  const sources = (scope as { sources?: unknown }).sources;
  return Array.isArray(sources) ? sources.filter((id): id is string => typeof id === 'string') : [];
}

/** A room's `sourceScope` with these sources followed (other keys kept). */
export function withFollowed(scope: unknown, ids: string[]): Record<string, unknown> {
  const base = scope && typeof scope === 'object' ? { ...(scope as Record<string, unknown>) } : {};
  return { ...base, sources: ids };
}
