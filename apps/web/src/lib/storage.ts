const CLIENT_KEY = 'relay.client-id';
const DRAFT_PREFIX = 'relay.draft.';
const LAYOUT_PREFIX = 'relay.layout.';

export function getClientId(): string {
  let id = localStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

export function loadDraft(sessionId: string): string {
  return localStorage.getItem(`${DRAFT_PREFIX}${sessionId}`) ?? '';
}

export function saveDraft(sessionId: string, draft: string): void {
  const key = `${DRAFT_PREFIX}${sessionId}`;
  if (draft) localStorage.setItem(key, draft);
  else localStorage.removeItem(key);
}

/** Persisted layout preferences (panel width, collapsed sidebars). */
export function loadLayout(name: string, fallback: number): number;
export function loadLayout(name: string, fallback: boolean): boolean;
export function loadLayout(name: string, fallback: number | boolean): number | boolean {
  try {
    const raw = localStorage.getItem(`${LAYOUT_PREFIX}${name}`);
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    return typeof value === typeof fallback ? (value as number | boolean) : fallback;
  } catch {
    return fallback;
  }
}

export function saveLayout(name: string, value: number | boolean): void {
  try {
    localStorage.setItem(`${LAYOUT_PREFIX}${name}`, JSON.stringify(value));
  } catch {
    /* storage may be unavailable (private mode); layout just won't persist */
  }
}
