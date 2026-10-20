import en from './locales/en.json';
import zhTW from './locales/zh-TW.json';

export type Language = 'en' | 'zh-TW';
export const languages = [
  { value: 'en', label: 'English' },
  { value: 'zh-TW', label: '繁體中文' },
] as const;
const normalize = (value: unknown): Language => (value === 'zh-TW' ? 'zh-TW' : 'en');
function saved(): Language {
  try {
    return normalize(localStorage.getItem('pirc-language'));
  } catch {
    return 'en';
  }
}
class I18n {
  language = $state<Language>(saved());
  setLanguage(value: string) {
    this.language = normalize(value);
    try {
      localStorage.setItem('pirc-language', this.language);
    } catch {
      /* private storage */
    }
    if (typeof document !== 'undefined') document.documentElement.lang = this.language;
  }
}
export const i18n = new I18n();
export function tr(source: string, values: readonly unknown[] = []): string {
  const english = (en as Record<string, string>)[source] ?? source;
  const translated =
    i18n.language === 'zh-TW' ? (zhTW as Record<string, string>)[source] : undefined;
  return (translated ?? english).replace(/\{(\d+)\}/g, (match, index) =>
    index < values.length ? String(values[Number(index)] ?? '') : match,
  );
}

if (typeof document !== 'undefined') document.documentElement.lang = i18n.language;
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === 'pirc-language') {
      i18n.language = normalize(event.newValue);
      document.documentElement.lang = i18n.language;
    }
  });
