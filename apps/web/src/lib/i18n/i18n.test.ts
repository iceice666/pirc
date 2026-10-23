import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, detectLocale, LOCALES, setLocale, t } from '../i18n';
import { en, MESSAGES, PARTS, zhTW, type MessageKey } from './messages';

const keys = (catalogue: Record<string, string>) => Object.keys(catalogue).sort();
const values = (catalogue: Record<string, string>) => Object.values(catalogue);

describe('i18n', () => {
  it('has the same keys in both languages', () => {
    expect(keys(zhTW)).toEqual(keys(en));
    expect(localeKeys()).toEqual(['en', 'zh-TW']);
  });

  it('keeps every message file complete in both languages', () => {
    for (const [name, part] of Object.entries(PARTS)) {
      expect(keys(part.zh), name).toEqual(keys(part.en));
    }
  });

  it('has no empty message and no placeholder only one language fills', () => {
    for (const key of keys(en) as MessageKey[]) {
      expect(en[key].trim(), key).not.toBe('');
      expect(zhTW[key].trim(), key).not.toBe('');
      const placeholders = (text: string) =>
        [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(placeholders(zhTW[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('namespaces every key by its area', () => {
    const areas = ['common', 'rooms', 'thread', 'face', 'engine', 'panel', 'settings'];
    for (const key of keys(en))
      expect(
        areas.some((area) => key.startsWith(`${area}.`)),
        key,
      ).toBe(true);
  });

  it('never says "hands" (the person chose nodes)', () => {
    for (const text of [...values(en), ...values(zhTW)])
      expect(text.toLowerCase()).not.toMatch(/\bhands?\b/);
  });

  it('fills placeholders and lets a component switch language', () => {
    setLocale('en');
    expect(t('common.unread', { count: 3 })).toBe('3 unread');
    setLocale('zh-TW');
    expect(t('common.unread', { count: 3 })).toBe('3 則未讀');
    // Back to the test environment's default for the rest of the file.
    setLocale('en');
  });

  it('starts in Traditional Chinese for a Chinese browser, English otherwise', () => {
    expect(DEFAULT_LOCALE).toBe('zh-TW');
    expect(detectLocale(['zh-TW'])).toBe('zh-TW');
    expect(detectLocale(['zh-Hans-CN'])).toBe('zh-TW');
    expect(detectLocale(['en-GB', 'zh-TW'])).toBe('zh-TW');
    expect(detectLocale(['en-US'])).toBe('en');
    expect(detectLocale(['fr'])).toBe('en');
    expect(LOCALES.map((locale) => locale.id)).toEqual(['zh-TW', 'en']);
  });
});

function localeKeys() {
  return Object.keys(MESSAGES).sort();
}
