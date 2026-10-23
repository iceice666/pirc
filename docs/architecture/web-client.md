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
  sources and archive. The connection state sits in the subtitle
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

## The worker's thread

Opening a thread from its card in the log (or from the Threads column) puts the
design's 420px column beside the room
(`src/lib/components/rooms/ThreadPanel.svelte`); the log narrows and its rows
lose their 16px right inset (32px instead of 48px), and the open thread's card
gets a 2px accent inset ring with its row tinted. Below a 1100px window the
column gives way down to 300px rather than squeezing the log.

- **Header**: the thread mark, the anchor's title at 15px, and a 12px line
  "from <face> · <workspace>" with the face in its colour — the node is engine
  state the rooms page may not load, so it is left out — followed by the
  anchor's status with its glyph and a read-only marker. An **Engine** link
  (with an outward arrow) opens the worker's session, and the close button ends
  the column. **Stop** is not here: it stays on the worker's card in the room,
  where the design draws it.
- **Worker strip** (`role="status"`): a 30px row per worker, the worker first
  and each teammate indented under it with an elbow, a status glyph, the name
  in mono and its last word. `workerTree()` in `lib/workers.ts` builds it: the
  worker's state is the gateway's `Worker.status`; a teammate's is known only
  when it asked something (waiting) or when the team record says it finished
  (`result` → done, `error` → failed), and is otherwise shown idle rather than
  guessed at.
- **Messages**: 32px avatars (workers are 8px-rounded squares with their name
  in mono), name and a WORKER tag, the time, a "↳ <worker>" marker on a
  teammate's reply, Markdown for what a worker writes and the text as typed for
  a person. A tool call is a 34px chip on the `--code-bg` well: the tool in
  words and its one line in mono. Lines ("Started …") are 12px at a 60px
  inset. The gateway sends a tool call's name and its one-line summary, not its
  output or exit status, so the comp's "exit 101"/"running" suffix has no data
  behind it and is not drawn.
- **Reply box**: a filled 44px bar, always there, "Jump in — the workers will
  see it". Only whom the worker works for may send; for anyone else the field
  is disabled and says who it waits for. The design's "always show" is kept
  without promising a reply the gateway would refuse.
- **States the comp omits**: a two-line skeleton with "Loading the thread…"
  while it is fetched (`RoomsState.threadLoading`), "Nothing in this thread
  yet." for an empty one, and a failed load as an alert line at the top of the
  log.

## A face's page

Clicking a face in the members column — or its name on a message — opens its
profile in the design's 360px column (`FacePanel.svelte`; the grid track is
360px only while a face is open):

- A 104px hero in the face's colour with a 36px translucent round back button,
  the 80px avatar ringed in `--bg-sidebar` and overlapping it by 40px, and a
  16px status square on its edge (yellow waiting, green working, ring idle).
- The name at 20px with its HOST/PROJECT badge, the bio, the amber waiting
  strip ("Waiting for you · <request>" in mono) when the face waits, and two
  actions: a full-width accent **Mention in room** and a secondary **Edit**.
- Read-only cards on the `--code-bg` well: **Role** (with "Edit role"), **Territory**
  as the design's 88px definition grid (rooms by name, workspaces as name and
  node in mono, sources by name), **Open loops · N** with each loop's anchor or
  age, and **Recently** (workers with their status, wakes) with "See all in
  Engine" into the engine's brain section.
- **Edit** opens the form that used to be the whole page — name, bio, tone,
  avatar, colour, role, territory checkboxes, Save, Cancel and Archive — and
  Cancel returns to the profile. "Mention in room" opens the room the face
  answers in (its first room, else the open one) with `@name ` in the
  composer's draft and does not send.
- The host's page keeps what the comp omits and the person asked to keep:
  SOUL.md and CHAT.md (editable where the files allow) and the remembered
  preferences (`MemorySettings`), below the cards in both views. Creating,
  archiving and hiding a face stay where they were — the members column's menu
  and this page's Edit form.

## The phone

Below 650px the rooms are one column (`Rooms.svelte`'s media query,
`MobileTabs.svelte`):

- A 56px header with a 44px menu button that opens the room list, the 20px
  hash, the room's name at 17px and a 44px mute button. The comp draws nothing
  else; the room's threads, pins, search, sources and archive moved into the
  room menu button so nothing became unreachable, and members live in the
  bottom navigation (as the comp draws).
- The log is bottom-aligned when it is short (`margin-top: auto` on its first
  row) and scrolls as usual when it is not, with 36px avatars, 12px gaps and
  10px between messages; the question card's answers stack full width at 44px
  in DOM order (Yes, Allow again this session, No), which keeps the tab order
  and the drawn order the same.
- The composer is a 48px pill (24px radius) with a 32px **+**, a 16px field
  that stays one line, and a 36px accent circular send.
- The bottom navigation is 64px with 22px icons over 11px labels on
  `--bg-sidebar`, a yellow count on Rooms, and `env(safe-area-inset-bottom)`
  kept in its height and in the room's bottom padding.
- Members, a face's page, Threads, Pinned and an open thread are full-screen
  panels above the tabs (`inset: 0 0 calc(64px + env(safe-area-inset-bottom))`),
  each with its own close button. The document stays exactly 390px wide at
  390×844.

## The engine dashboard

The engine's front page is the design's one scrolling dashboard
(`src/lib/components/engine/EngineOverview.svelte`), in a column of at most
1040px on the design's `--bg-room` surface. Above the dashboard the strip that
used to swap panels is now **anchors**: Overview, Nodes, Brain, Open loops,
Wakes, Memory and Sources are links to `#overview`, `#nodes`, … (and
`?open=<id>`, which `engineOverview` reads on load and scrolls to). Overview is
the dashboard itself; each other anchor lands on its full section below.

- **Overview** is the design's stack. **Nodes** is a card per connected node
  with its id in mono, `linux · x86_64 · connected 3 m ago`, the state word
  (Busy / Free — `load.running`), a segmented load meter (`load.max`
  segments, the running ones lit), capability chips (each GPU as
  `GPU · 2× nvidia RTX 4090`, browse, terminals, `bwrap · ready`) and its
  workspaces. **Brain** is the newest turns of every room in one table —
  Started, Room, Why, Outcome, Took, Used — with the "one turn at a time, every
  room" note; it asks each room for its latest four and merges them. The three
  cards are Open loops (`N of limit in prompt`, the first four loops with their
  anchor, room and the raw `user` / `tool:<source>` origin chip), Wakes
  (today's count against the allowance with a progress bar, two coming wakes
  with **Cancel**, two recent ones) and Sources (a row per source, the failing
  one tinted red with its last error, the paused one muted).
- **The sections** keep the full lists and the editors the anchors name:
  Nodes is each machine's detail (machine, GPU with VRAM, what it can do, its
  sandbox, load, workspaces), Brain is one room at a time with the room
  selector, Open loops and Wakes are the editors (close, reopen, cancel,
  recently closed), Memory is the preferences and facts view, and Sources is
  the list with when each was read and who follows it.
- **The "All …" links** go where the decision put them: `All nodes` →
  `#nodes`, `All turns` → `#brain`, `All loops` → `#loops`, and
  `Manage in Settings` opens Settings on **Models & sources**. The face page's
  `See all in Engine` still opens `#brain`.
- Data the comp draws that the client does not have: there is no "hands online"
  count (the heading counts connected **nodes**), no worker initials anywhere in
  the dashboard, and the comp's `[GPU MODEL]`, `[sha]` and illustrative
  counts are the real `capabilities.gpus`, the real commit shas and the real
  `usage.totalTokens` here. A card's own action (a wake's Cancel) bumps a
  revision so the section below reloads with it.

## A worker's session page

The session page (`Engine.svelte` + `components/panel/`) is the design's
screen 6:

- **Topbar**, 10px 16px: the breadcrumb (workspace in mono, a slash, the
  session's name), then the 17px title with a 28px rename pencil
  (`engine.renameSession`, the same call the sidebar's F2 makes), the
  orange **Worker · <title>** chip (its `--worker` tint is the comp's) linking
  to the room it was called in, and the "Not sandboxed" chip when it applies.
  On the right: Jobs, the Live/Offline/Reconnecting pill and Take control.
- **Waiting band**, full width under the topbar, amber (`--warning-soft`):
  "Waiting for you in #SlimeOS" and **Answer in the room**
  (`components/engine/WaitingBand.svelte`). It appears only when the open
  session's run is `waiting_input` **and** it was delegated into a room
  (`origin.roomId`), whose name comes from `/api/rooms`; the request itself is
  not in the engine's data (a session snapshot carries its run's state, not the
  question's text), so the band stops at the room. The narrow viewer banner
  stays above the panes beside it, as the decision asked.
- **Pane tabs** are the design's: 15px icons, 13px labels and a 2px accent
  underline on a full-width hairline (44px rows on touch, a dot for a busy tab).
- **Git** is two columns (`GitTab.svelte`): the left holds the branch card
  (`fix-lint` in mono, `1 ahead · not pushed` when there is no upstream and
  `N ahead`/`N behind` when there is, then `N uncommitted` or the clean
  line), the staged and unstaged changes and the history (sha, subject,
  `author · 10m ago`, the `HEAD`/`origin/…` refs, **Load more**); the right
  is the diff card — the newest commit by default, with its message, author,
  date and refs above the hunk lines, `+2`/`−4` counted from the hunks, and a
  changed file's own diff when one is selected. Refresh sits in the History
  header, and a changed file's path still opens it in Files. The
  Changes/History segmented control and its drill-down are gone; they offered
  no staging or committing (the panel API has neither), so nothing became
  unreachable.
- The engine's shell has one definite grid row, so the main column's pages
  scroll inside it (the dashboard's column, a session's panes) instead of
  growing the shell, which clips.

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
