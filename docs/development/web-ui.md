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

## Work on the room screen

The desktop room is split by responsibility, so a change lands in one place:

- `components/rooms/Rooms.svelte` — the three-column grid, room list, room
  header, search, log dividers, composer and which column is open beside the
  log (`side`: members, a face, threads, pinned, or the worker's thread).
- `components/rooms/RoomMessageRow.svelte` — one message, line or question:
  avatars, face badges, mention chips, the worker thread card, attachments.
- `components/rooms/MembersPanel.svelte`, `ThreadsPanel.svelte`,
  `PinnedPanel.svelte` — the columns beside the room.
- `lib/rooms.svelte.ts` — store state; `unreadMark` is the room's `readSeq`
  when it opened, which is what the log's "New" divider uses (opening a room
  marks it read at once).

Sizes and colours come from the tokens in `app.css`; the design's numbers are
in [the review](../design/pirc-rooms-ui-review.md) (240px list, 52px headers,
36px list rows, 44px member rows, 40px avatars, 16px gap, 48px right inset,
72px line inset, 180×30 search, 240×135 images). New strings go into
`messages/rooms.ts` in both languages. The room tests are the "rooms page"
cases in `src/lib/rooms.svelte.test.ts`, which mount the real component against
a fake `fetch` and a fake socket; add a case there for new behaviour.

## Theme and fonts

Palette and type tokens live in `apps/web/src/app.css`; use the variables, not
hex values. The status mark is `StatusGlyph.svelte`, never a hand-rolled dot.
Fonts come from the three `@fontsource-variable` packages; `main.ts` imports
their `wght.css` only, and the build copies the woff2 files into
`apps/web/dist/assets`. Web assets ship as files, so the dist size grows while
the gateway/node binaries do not.
