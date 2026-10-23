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

## The rooms screen

The desktop room is the design's three columns
(`src/lib/components/rooms/Rooms.svelte`):

- **Room list**, 240px: a 52px header with `pirc` and "gateway · N faces"
  (faces, not machines: the rooms page does not load nodes — see
  `lib/boundaries.test.ts`), a server menu holding **New room**, the ROOMS
  eyebrow, 36px rows (hash, name, "Your turn" pill, red unread count, a 4×8px
  rail on an unread row) and an "Archived · N" fold that loads the archived list
  on mount for its count. The footer is the darker `--bg-footer` band with
  Engine and Settings.
- **Room header**, 52px: hash, name, hairline, then the subtitle — the room's
  kind and the face whose territory it is, both real fields. The engine's
  workspace/node names are not available here, so that part of the comp's line
  is omitted rather than invented. On the right: Threads, Pinned, Mute and
  Members toggles, a 180×30 search field (`--code-bg`, client-side over the
  messages already loaded: words, a question's request and attachment names;
  Escape clears it) and a room menu holding the controls the comp drops —
  sources, archive and "Continue in…". The connection state sits in the subtitle
  while it is not connected.
- **Log**: 40px avatars, 16px gap, 48px right inset, face names in their colour
  with a HOST/PROJECT badge, mention chips for plain-text messages
  (`mentionParts()` in `lib/faces.ts`), a thread preview card for a worker
  anchor (title, status glyph and count, the thread's last activity, Open
  thread), file attachments as a card with "Download" and images at 240×135.
  Lines (worker, loop, memory, wake, move) sit at the same 72px inset with an
  icon and their compact actions. A "Today"/date hairline begins each day, and
  a red "New" divider marks where the unread messages began: `RoomsState`
  keeps `unreadMark` (the room's `readSeq` when it opened) because opening a
  room marks it read. A question is a warning-tinted card with an "ASKS YOU"
  badge, its request in mono, Yes / Allow again this session / No / Thread and
  "or just reply" — the same `workersApi.answer` call as before.
- **Composer**: a filled `--bg-composer` surface, a round 28px attach button
  (files, paste and drag-and-drop), a one-line textarea that grows, the
  "@ to bring in a face" placeholder, an accent 32px circular send, and at most
  three attachment tiles plus "+N". The asking strip is fused to its top edge in
  the asking face's colour with a yellow square and Show. A failed send is one
  line above it; an archived room, or a send the gateway refuses with 409,
  replaces the composer with the read-only banner and its Unarchive button.
- **Members**, 248px: groups Waiting for you / Idle / In other rooms (a face
  working in the room is in Idle, the comp has no fourth group), 44px rows,
  a second line with what the face is doing via `presenceText()` and the shared
  `StatusGlyph`. Clicking a face opens its page (the person's decision). The
  add-face control and the hidden-faces toggle stay in this column's header
  menu, as the person asked (the comp's "no add/hide controls" would have made
  them unreachable); the only per-row control left is Hide/Show on an archived
  face, as before. Threads and Pinned open their own columns
  (`ThreadsPanel.svelte`, `PinnedPanel.svelte`), derived from the loaded
  anchors and the pinned messages.

Data the comp draws that the client does not have: the worker initials on a
thread card (an anchor carries a worker count, not names, so the card shows the
count), "slimeos on arch-desktop" in the room header (engine-only state), and
the "Host · runs the rooms" second line (the face's `bio` is not a status line;
the column shows its presence). Mention chips render for plain text and lines;
a face's Markdown keeps its `@name` as written.

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
