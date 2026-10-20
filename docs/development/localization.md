# Client localization

Web and Android provide **English** and **繁體中文** in Settings → General → Language.
English is both the initial language and fallback, independently of the OS language.
The selection belongs to the local client: Web uses `pirc-language` in localStorage;
Android uses the existing native notification preferences so background UI can read it.

## Catalogs

- Web: `apps/web/src/lib/locales/{en,zh-TW}.json`, via `tr` in `i18n.svelte.ts`.
- Flutter: `apps/android/lib/l10n/{en,zh-TW}.json`, via `tr` in `app_i18n.dart`.
- Native Android: `apps/android/android/app/src/main/assets/locales/{en,zh-TW}.json`,
  via `NativeI18n.text` for system notification actions, overlay UI and native errors.

Translate whole sentences. Numbered placeholders such as `{0}` are replaced only
after lookup; their values can be user-authored names or content and must remain
literal. Never translate API keys, paths, CSS selectors, terminal sequences, model
identifiers, user messages or rendered document content. Some historical Chinese
source strings remain lookup keys, but their English catalog values define the default.
Missing keys use the English value (or source); an intentionally empty translation
is valid for an English plural suffix.

After changing Flutter catalogs, run from `apps/android`:

```sh
dart run tool/generate_l10n.dart
dart format lib/l10n/catalogs.g.dart
flutter test test/i18n_test.dart test/app_keyboard_stability_test.dart
```

The generator and Web/Flutter tests check key and placeholder parity. Widgets
subscribe through `I18nScope`; the application root only rebuilds for appearance
or language changes, not each stream event. Translation changes must retain
input focus, editing selection and the IME composing range. The initial Traditional
Chinese catalogs were translated/reviewed with 6Luna subagents and integrated locally.

Account or server-provided error details can still arrive in the language supplied
by the server. Provider/model names, code identifiers and key labels remain literal.
