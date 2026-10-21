// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uuid } from './id';
import { loadLayout, loadRoomDraft, saveLayout, saveRoomDraft } from './storage';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

let storage: Storage;

beforeEach(() => {
  // Node 26's localStorage global is unavailable without --localstorage-file.
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('uuid', () => {
  it('falls back to getRandomValues outside secure contexts', () => {
    // Shadow the prototype method as insecure contexts do (it is simply absent).
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const id = uuid();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(uuid()).not.toBe(id);
    } finally {
      delete (crypto as { randomUUID?: unknown }).randomUUID;
    }
  });
});

describe('storage', () => {
  it('survives unavailable storage', () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(loadRoomDraft('general')).toBe('');
    expect(() => saveRoomDraft('general', 'hi')).not.toThrow();
    expect(loadLayout('panelWidth', 360)).toBe(360);
    expect(() => saveLayout('panelWidth', 400)).not.toThrow();
  });

  it('makes room for a draft by dropping other drafts on quota errors', () => {
    saveRoomDraft('old', 'old draft');
    // A session draft of the old composer.
    storage.setItem('relay.draft.s1', 'stale');
    const setItem = storage.setItem;
    let failures = 1;
    vi.spyOn(storage, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (failures-- > 0) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    saveRoomDraft('general', 'new draft');
    expect(loadRoomDraft('general')).toBe('new draft');
    expect(loadRoomDraft('old')).toBe('');
    expect(storage.getItem('relay.draft.s1')).toBeNull();
  });

  it('clears a room draft that was emptied, and keeps the layout apart', () => {
    saveRoomDraft('general', 'a');
    saveLayout('panelWidth', 400);
    saveRoomDraft('general', '');
    expect(storage.getItem('relay.room-draft.general')).toBeNull();
    expect(loadLayout('panelWidth', 360)).toBe(400);
  });
});
