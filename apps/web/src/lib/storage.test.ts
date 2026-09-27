// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuid } from './id';
import { loadDraft, loadLayout, pruneDrafts, saveDraft, saveLayout } from './storage';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
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
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(loadDraft('s1')).toBe('');
    expect(() => saveDraft('s1', 'hi')).not.toThrow();
    expect(loadLayout('panelWidth', 360)).toBe(360);
    expect(() => saveLayout('panelWidth', 400)).not.toThrow();
  });

  it('makes room for a draft by dropping other drafts on quota errors', () => {
    saveDraft('old', 'old draft');
    const setItem = Storage.prototype.setItem;
    let failures = 1;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (failures-- > 0) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    saveDraft('s1', 'new draft');
    expect(loadDraft('s1')).toBe('new draft');
    expect(loadDraft('old')).toBe('');
  });

  it('prunes drafts of sessions that are gone', () => {
    saveDraft('keep', 'a');
    saveDraft('gone', 'b');
    saveLayout('panelWidth', 400);
    pruneDrafts(['keep']);
    expect(loadDraft('keep')).toBe('a');
    expect(loadDraft('gone')).toBe('');
    expect(loadLayout('panelWidth', 360)).toBe(400);
  });
});
