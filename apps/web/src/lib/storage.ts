import { uuid } from './id';

const CLIENT_KEY = 'relay.client-id';
const DRAFT_PREFIX = 'relay.draft.';
const LAYOUT_PREFIX = 'relay.layout.';

/*
 * localStorage throws when storage is disabled (some private modes, blocked
 * site data) and on quota errors. Nothing here is critical: reads fall back,
 * writes are best effort.
 */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

function keys(prefix: string): string[] {
  try {
    return Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    ).filter((key): key is string => !!key?.startsWith(prefix));
  } catch {
    return [];
  }
}

/** Without storage the id still stays stable for this page. */
let clientId: string | undefined;

export function getClientId(): string {
  clientId ??= read(CLIENT_KEY) ?? undefined;
  if (!clientId) {
    clientId = uuid();
    write(CLIENT_KEY, clientId);
  }
  return clientId;
}

export function loadDraft(sessionId: string): string {
  return read(`${DRAFT_PREFIX}${sessionId}`) ?? '';
}

export function saveDraft(sessionId: string, draft: string): void {
  const key = `${DRAFT_PREFIX}${sessionId}`;
  if (!draft) {
    remove(key);
    return;
  }
  if (write(key, draft)) return;
  // Probably over quota: other sessions' drafts are the only thing that grows.
  for (const other of keys(DRAFT_PREFIX)) if (other !== key) remove(other);
  write(key, draft);
}

export function removeDraft(sessionId: string): void {
  remove(`${DRAFT_PREFIX}${sessionId}`);
}

/** Drop drafts of sessions that no longer exist. */
export function pruneDrafts(sessionIds: Iterable<string>): void {
  const known = new Set(Array.from(sessionIds, (id) => `${DRAFT_PREFIX}${id}`));
  for (const key of keys(DRAFT_PREFIX)) if (!known.has(key)) remove(key);
}

/** Persisted layout preferences (panel width, collapsed sidebars). */
export function loadLayout(name: string, fallback: number): number;
export function loadLayout(name: string, fallback: boolean): boolean;
export function loadLayout(name: string, fallback: number | boolean): number | boolean {
  const raw = read(`${LAYOUT_PREFIX}${name}`);
  if (raw === null) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === typeof fallback ? (value as number | boolean) : fallback;
  } catch {
    return fallback;
  }
}

export function saveLayout(name: string, value: number | boolean): void {
  // Layout just won't persist without storage.
  write(`${LAYOUT_PREFIX}${name}`, JSON.stringify(value));
}
