/**
 * The web client's two languages (a person's decision: real i18n).
 *
 * `t('rooms.empty')` reads the reactive locale, so a component that shows a
 * message re-renders when someone switches language. Values may carry
 * `{name}` placeholders filled from the second argument.
 *
 * The locale starts from the browser's languages (any `zh` variant gets
 * Traditional Chinese, everything else English), then follows the person's
 * own choice stored on this device.
 */
import { presenceLabel, type FacePresence } from '../faces';
import { loadLocale, saveLocale } from '../storage';
import { MESSAGES, type MessageKey } from './messages';

export type Locale = keyof typeof MESSAGES;

export const LOCALES: readonly { id: Locale; label: string }[] = [
  { id: 'zh-TW', label: '繁體中文' },
  { id: 'en', label: 'English' },
];

export const DEFAULT_LOCALE: Locale = 'zh-TW';

/** Any Chinese browser gets the only Chinese catalogue we ship. */
export function detectLocale(languages: readonly (string | undefined)[]): Locale {
  return languages.some((language) => language?.toLowerCase().startsWith('zh')) ? 'zh-TW' : 'en';
}

function browserLanguages(): string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? [...navigator.languages] : [navigator.language];
}

const state = $state<{ locale: Locale }>({
  locale: (loadLocale() as Locale | null) ?? detectLocale(browserLanguages()),
});

/** The locale in use. Read it through `t` rather than branching on it. */
export function locale(): Locale {
  return state.locale;
}

export function setLocale(next: Locale): void {
  state.locale = next;
  saveLocale(next);
  if (typeof document !== 'undefined')
    document.documentElement.lang = next === 'en' ? 'en' : 'zh-Hant-TW';
}

/** Apply the starting locale's `<html lang>` (the catalogue itself needs no setup). */
export function initLocale(): void {
  setLocale(state.locale);
}

/**
 * A message in the current locale. An unknown key falls back to English, then
 * to the key itself: a missing translation must never blank out the UI.
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const message: string = MESSAGES[state.locale][key] ?? MESSAGES.en[key] ?? key;
  if (!vars) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** What a face is doing, in the current locale ("Working · the PR"). */
export function presenceText(presence: FacePresence | undefined): string {
  const label = presenceLabel(presence);
  return label.line ? `${t(label.word)} · ${label.line}` : t(label.word);
}
