// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { i18n, tr } from './i18n.svelte';
import en from './locales/en.json';
import zh from './locales/zh-TW.json';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
});
afterEach(() => {
  i18n.setLanguage('en');
  vi.unstubAllGlobals();
});
test('English default and fallback; language persists without translating user values', () => {
  expect(i18n.language).toBe('en');
  expect(tr('Settings')).toBe('Settings');
  i18n.setLanguage('zh-TW');
  expect(tr('Settings')).toBe('設定');
  expect(document.documentElement.lang).toBe('zh-TW');
  expect(localStorage.getItem('pirc-language')).toBe('zh-TW');
  expect(tr('Unknown source')).toBe('Unknown source');
  expect(tr('New {0}', ['<Project $1>'])).toContain('<Project $1>');
  i18n.setLanguage('fr');
  expect(tr('Settings')).toBe('Settings');
});
test('catalog keys and interpolation arguments agree', () => {
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  const parameters = (s: string) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
  for (const [key, value] of Object.entries(en)) {
    expect(parameters(value), key).toEqual(parameters(key));
    expect(parameters((zh as Record<string, string>)[key]!), key).toEqual(parameters(value));
  }
});
