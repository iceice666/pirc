const CLIENT_KEY = 'relay.client-id';
const DRAFT_PREFIX = 'relay.draft.';

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
