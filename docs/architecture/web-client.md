# Web client: theme, type, status language and messages

Current contract for `apps/web` (Svelte 5). The design it implements, with the
person's answers, is [the rooms/engine review](../design/pirc-rooms-ui-review.md);
the client's command reference stays in [apps/web/README.md](../../apps/web/README.md).

## Theme and type tokens

`src/app.css` is the only place the palette lives:

- Dark is the shipped theme. `:root` carries the design's surfaces (`#0f0f11`,
  `#17171a`, `#1d1d20`, `#26262b`, `#121214`, `#111113`), ink steps, `#5686fe`
  accent and its tints, success `#3fbf86`, warning `#f0b232` and danger
  `#e5534b`, plus the 6/8/10/12px radii and the font stacks.
- `:root[data-theme='light']` keeps the previous light palette for later. Nothing
  sets `data-theme` yet; `src/lib/theme.ts` (`isDarkTheme()`) is how code that
  cannot read CSS variables (Mermaid, xterm) asks the app which theme is on.
- Type: rooms use the 15px `:root` base, the engine shell sets 14px
  (`Engine.svelte` `.app-shell`), section labels are 12px/0.04em uppercase and
  `--font-mono` (JetBrains Mono) marks workspace, session and worker identifiers.

Fonts are self-hosted from `@fontsource-variable/{ibm-plex-sans,jetbrains-mono,noto-sans-tc}`;
`main.ts` imports only each package's `wght.css` (normal weights). Noto Sans TC is
split by unicode range, so a browser downloads only the slices it needs. Web
assets are shipped as files (`nix/web.nix`, `scripts/package-release.ts`), never
embedded in the Rust binaries, so fonts do not count against the gateway or node
size budgets.

## Status language

`src/lib/components/StatusGlyph.svelte` is the one status marker:

| State     | Glyph                       | Meaning           |
| --------- | --------------------------- | ----------------- |
| `working` | green dot, optional pulse   | working / live    |
| `idle`    | hollow ring (also for done) | idle, finished    |
| `waiting` | amber 2px-radius square     | waiting, asks you |
| `error`   | red dot                     | failed, failing   |

`glyphOf(state)` maps server and UI state words (`thinking`, `ongoing`,
`waiting_input`, `failed`, `completed`, …) onto those four; unknown values fall
back to `idle`. The underlying state values are unchanged. An unread count stays
a red badge and is not a status.

## Messages

`src/lib/i18n/` holds the two catalogues:

- `messages/{common,rooms,thread,face,engine,panel,settings}.ts` each export
  `{ en, zh }` as const, keyed by flat dotted namespaces (`rooms.composer.send`).
- `messages/index.ts` spreads the fragments; `MessageKey` is derived from the
  English keys and the zh-TW catalogue is typed `Record<MessageKey, string>`, so a
  missing or extra key fails `bun run typecheck`.
- `index.svelte.ts` exports `t(key, vars)` (`{name}` placeholders), `locale()`,
  `setLocale()`, `LOCALES`, `DEFAULT_LOCALE` and `detectLocale()`. The locale is
  `$state`, so a component that calls `t()` re-renders when it changes; reads fall
  back to English, then the key itself.
- Traditional Chinese is the default; `detectLocale` gives any `zh*` browser
  language zh-TW and everything else English. The person's choice is stored under
  `relay.layout.locale` (see `lib/storage.ts`), and `initLocale()` sets the
  document's `lang`.
- Product words (Engine, room, thread, face, worker, session, workspace) stay
  English in both catalogues, as do provider, model and source names. Ordinary UI
  words — "Your turn", "ASKS YOU", "Waiting for you" — are translated. "Nodes"
  is 節點; the catalogue never says "hands".

Adding or changing copy means editing both languages in the owning fragment, then
running `bunx vitest run src/lib/i18n/i18n.test.ts`. That test checks the key sets
match per fragment and in total, that no value is empty, that placeholders match
per key, that keys stay namespaced and that no value says "hands".

The one language selector lives in the settings dialog header, shared by the
rooms and the engine.
