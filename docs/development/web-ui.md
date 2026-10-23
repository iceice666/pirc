# Web UI: strings, theme and fonts

Short recipe for changing what the web client says or looks like. The contract is
in [architecture/web-client.md](../architecture/web-client.md); commands are in
[apps/web/README.md](../../apps/web/README.md).

## Add or change copy

1. Find the owning namespace in `apps/web/src/lib/i18n/messages/` (`common`,
   `rooms`, `thread`, `face`, `engine`, `panel`, `settings`).
2. Add the key to both `en` and `zh` with the same `{placeholders}`, or change
   both values. Keep product words (Engine, room, thread, face, worker, session,
   workspace) in English in both.
3. Render it with `t('namespace.key')` in markup or script; pass variables as
   `t('key', { name })`. Module-level tables hold `MessageKey`s and translate in
   the markup, so a language switch re-renders.
4. Run `bunx vitest run src/lib/i18n/i18n.test.ts` (key parity, placeholders, no
   "hands"), then `bunx svelte-check --tsconfig ./tsconfig.json`.

Components never hold user-visible English: aria-labels, titles, placeholders,
alt text, empty states and error fallbacks all come from the catalogue. Text
produced once into state (a terminal notice, a backend error string) does not
retranslate on a switch; prefer a key in state and `t(key)` in markup.

## Theme and fonts

Palette and type tokens live in `apps/web/src/app.css`; use the variables, not
hex values. The status mark is `StatusGlyph.svelte`, never a hand-rolled dot.
Fonts come from the three `@fontsource-variable` packages; `main.ts` imports
their `wght.css` only, and the build copies the woff2 files into
`apps/web/dist/assets`. Web assets ship as files, so the dist size grows while
the gateway/node binaries do not.
