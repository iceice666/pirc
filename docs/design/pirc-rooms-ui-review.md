# pirc rooms and engine: review of the "Discord-shaped UI" design

[All documentation](../README.md) · [Architecture references](../architecture/README.md) ·
[Web client](../../apps/web/README.md)

A person handed us a claude.ai artifact called "pirc rooms — Discord-shaped UI": six fixed-size
comps for the rooms, a face's page, a phone room and two engine screens. This document unpacks
that file, describes each screen and compares it with what `apps/web` ships today. It is a review
only: no app code, tests or styles changed, and nothing here authorizes an implementation.

The artifact is a person's untracked file under `.pirc/uploads/` (ignored by git) and is not
reproduced in the repository. The sizes below are from that file.

## What the file is

The export is two layers of claude.ai's bundler format:

1. **The board.** The outer page is only a design board: six `<section><h2>` titles, each with
   an `<iframe width height>` (1440×900 for screens 1, 2 and 6; 360×900 for 3; 390×844 for 4;
   1440×1060 for 5). The screen documents are not iframe `srcdoc`: they sit in
   `<script type="__bundler/manifest">` as base64(gzip(HTML)), keyed by uuid, and
   `<script type="__bundler/page_order">` lists the six uuids in board order. The board's own HTML
   is the JSON string in `<script type="__bundler/template">`.
2. **Each screen.** Every entry decodes to _another_ bundler page whose
   `__bundler/template` JSON string is the actual comp: `<!DOCTYPE html>` … `</html>`, an
   `<x-dc>` document with inline styles, one `text/x-dc` DCLogic script and a
   `<script src="<uuid>">` for the comp runtime. That runtime is React 18.3.1 (UMD from
   cdn.jsdelivr.net) in the intermediate page's `ext_resources`; the comp markup itself is plain
   HTML with inline `style` attributes, not JSX and not Babel.

Unpacking is uninvolved but must not execute the page's JavaScript: the data is all in the two
template scripts and the manifest.

## Unpacking it

There is no `sqlite3`-style CLI dependency and nothing to install. `python3` is enough. The
script below strips the two bundler layers, names each screen after its board `<h2>` in order and
writes the comps outside git.

```bash
python3 - <<'PY'
import base64, gzip, json, pathlib, re

src = pathlib.Path(".pirc/uploads/upload_22f8842e-c488-434d-8f90-f37052d96905-pirc rooms — Discord-shaped UI (1).html")
out = pathlib.Path("/tmp/pirc-rooms-ui-unpacked")  # anywhere outside git
html = src.read_text(encoding="utf-8")

def bundler(text, kind):
    m = re.search(r'<script type="__bundler/%s">(.*?)</script>' % kind, text, re.S)
    return json.loads(m.group(1)) if m else None

board, manifest, order = (bundler(html, k) for k in ("template", "manifest", "page_order"))
titles = re.findall(r"<h2>(.*?)</h2>", board, re.S)
uuids = re.findall(r"about:blank#([0-9a-f-]{36})", board)
assert len(titles) == len(uuids) == len(order)

out.mkdir(parents=True, exist_ok=True)
for n, (title, uuid) in enumerate(zip(titles, uuids), 1):
    entry = manifest[uuid]
    raw = base64.b64decode(entry["data"])
    page = gzip.decompress(raw) if entry.get("compressed") else raw
    doc = bundler(page.decode("utf-8"), "template")  # layer 2: the comp
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    path = out / ("%02d-%s.html" % (n, slug))
    path.write_text(doc, encoding="utf-8")
    print(path.name, len(doc.encode()), title)
PY
```

`.pirc/` is ignored by git, so its output stays out of the repository either way. (The agent
sandbox also refuses writes under `.pirc/`, which is why the command above writes to `/tmp`.)
Then check the decodes without a browser:

```bash
for f in /tmp/pirc-rooms-ui-unpacked/*.html; do
  printf '%s ' "$(basename "$f")"
  head -c 15 "$f"; printf ' … '; tail -c 8 "$f" | tr -d '\n'; printf ' %s bytes\n' "$(wc -c <"$f")"
done
grep -c '@font-face' /tmp/pirc-rooms-ui-unpacked/*.html
```

## What each screen decodes to

All six are complete documents: each starts with `<!DOCTYPE html>`, ends with `</html>`, is
non-empty, and has no classes at all (every rule is an inline `style`). Each carries the same
360 `@font-face` rules (IBM Plex Sans, JetBrains Mono and, mostly, Noto Sans TC character-range
subsets, 114 distinct woff2 URLs, all on `fonts.gstatic.com`), about 387 KB of the file, and a
157–177 byte global stylesheet for `body`, `a`, `button`, `input`. Icons are inline SVG in a
lucide-like style. There are no `<img>` tags, no local assets, and no external scripts inside the
comp itself; the only outside references are the Google Fonts files.

| #   | Screen (board title)                | File                                      |   Bytes | Style attrs | Article/button/svg | Framework                                      |
| --- | ----------------------------------- | ----------------------------------------- | ------: | ----------: | -----------------: | ---------------------------------------------- |
| 1   | Room · #SlimeOS (desktop)           | `01-room-slimeos-desktop.html`            | 421,465 |         190 |        7 / 16 / 25 | Static HTML, inline CSS, x-dc comp, React host |
| 2   | Thread open in right column         | `02-thread-open-in-right-column.html`     | 413,985 |         158 |         9 / 9 / 21 | Same; no framework in the markup               |
| 3   | Face page · SlimeOS PM              | `03-face-page-slimeos-pm.html`            | 395,269 |          52 |          0 / 1 / 5 | Same; one custom prop `faceColor`              |
| 4   | Room · phone                        | `04-room-phone.html`                      | 398,731 |          54 |         3 / 7 / 11 | Same                                           |
| 5   | Engine · overview                   | `05-engine-overview.html`                 | 417,409 |         230 |          2 / 8 / 6 | Same; `sc-raw-*` table tags                    |
| 6   | Engine · worker session (read-only) | `06-engine-worker-session-read-only.html` | 408,625 |         111 |        0 / 12 / 15 | Same                                           |

Two design-comp knobs appear as `{{accent}}` (default `#5686fe`) and, on screen 3,
`{{faceColor}}` (default `#8a4b17`): the DCLogic `renderVals()` exposes them in the preview. They
are a color editor in the comp host, not app theming. `lang` is `zh-Hant` on every screen, and
the copy is mixed Traditional Chinese and English.

### Shared visual language

The six screens are one dark theme, with no light variant anywhere:

- Surfaces `#0f0f11` (shell), `#17171a` (sidebars, cards, thread), `#1d1d20` (main room),
  `#26262b` (composer), `#121214` (footer band), `#111113` (inset wells, code).
- Ink `#f2f3f5`, body `#dbdee1`, secondary `#a1a5ad`, muted `#8b9099`; borders are black at 40%
  over the dark surface (`#00000066`) or white at 8–12% (`#ffffff14`).
- Accent blue `#5686fe`; face colors `#8a4b17` (PM), `#2f4f99` (host), `#5b3a8a`, `#1f6b4f`;
  success `#3fbf86`; warning/asks-you `#f0b232`; danger `#e5534b`/`#ff7b72`.
- Type: IBM Plex Sans at 15px/1.45 (rooms), 14px (engine, face page, thread messages), 13px
  dense metadata, 12px labels with `0.04em` uppercase tracking; JetBrains Mono for identifiers,
  commands, worker names, input shorthand.
- Shape: 52px headers, 6–8px radii on controls, 8–10px on cards, 50% avatars, 3–4px status
  squares vs circles, 1px hairlines, no drop shadows; separation comes from surface steps.
- Status vocabulary: green dot = working/live; hollow ring = idle/done; yellow square = waiting
  for you / asks you; red badge = unread count or failure.

`#5686fe` is exactly the app's dark `--accent`; the surfaces sit one step darker than today's
dark theme (`#151517`/`#1c1c1e`). This is close to Discord's shape but cooler and flatter than
Discord, with fewer rounded pills and no blurple gradient.

## Screen 1: Room · #SlimeOS (desktop)

**What it shows.** A three-column frame, 1440×900.

- Room list, `flex 1 1 240px`, background `#17171a`, full height. 52px header with "pirc" and
  "gateway · 2 hands online" on two lines, a chevron button on the right (server menu). A "ROOMS"
  eyebrow, then 36px rows with an 18px hash, name, and either a yellow "Your turn" pill on the
  open room, a red "2" unread count on `school`, or nothing. The open row uses `#ffffff14`;
  the unread row has a 4×8px white marker on the left edge. "Archived · 1" fold at the bottom
  (12px uppercase, chevron, count). Darker 8px-padded footer with Engine and Settings rows.
- Room column, `flex 999 1 560px`, `#1d1d20`. 52px header: hash, "SlimeOS" (16px/600), a 1×24
  divider, then "Project room · @SlimeOS PM · slimeos on arch-desktop" (13px, the face name in
  its color); on the right four 36px icon buttons (Threads, Pinned, Mute, Members; Members is
  pressed) and a 180×30 search field with a magnifier. No presence pill.
- Message log, 16px vertical padding. A "Today" hairline divider. Message rows: 40px avatar,
  16px gap, content, 48px right padding, 12px top margin. Name 15px/600 plus a 12px time; faces
  carry an 11px badge (`HOST`, `PROJECT`) in the face color at 15% fill. `@SlimeOS PM` mentions
  are an inline chip with an 18% face-color fill. A thread preview card (max 520px, `#17171a`,
  1px border, radius 8) holds the thread title, a status ("Done · 3" with a hollow dot or
  "Working · 3" green), a row of three 20px overlapping worker initials (`w1`, `rv`, `w2` in
  JetBrains Mono) and "All ended · told the room at 14:11", plus "Open thread".
- Line rows sit at a 72px left inset, 13px muted, 14px icon, and inline actions: "Called a worker
  · Fix the lint job on arch-desktop" with Stop and Details; "Opened a loop · …" with Close it;
  "Remembered · 你在意 SlimeOS 的 boot 時間" with Don't keep. A file attachment card
  (`boot-trace.log`, Download as a second line) and a 240×135 pasted-image placeholder.
- A red "NEW" divider (11px/700, `#ff7b72`), then a worker report with a two-item list and a
  thread link.
- A question card: an inset tinted block (8px margins, radius 8, `#f0b2321a`, 1px
  `#f0b23259`), avatar, name and time, a yellow "ASKS YOU" badge with a shield icon, the question
  with `git push origin fix-lint` as inline code, then `Yes` (accent, 32px),
  `Allow again this session`, `No` (both `#ffffff1a`), "Thread" and "or just reply".
- Composer: a "waiting for you" bar attached above it (`#17171a`, radius 8 8 0 0, yellow square,
  "SlimeOS PM is waiting for you · git push origin fix-lint", Show), then a filled `#26262b`
  composer with an attachment row (40px thumbnail, name, "pasted", remove), a 28px round `+`
  button, a single-line input with placeholder "Message #SlimeOS — @ to bring in a face", and a
  32px send arrow.
- Members column, `flex 1 1 248px`, `#17171a`: "WAITING FOR YOU — 1", one 44px row (32px avatar,
  name in face color, second line "Waiting · git push origin fix-lint", yellow square status
  badge); "IDLE — 1" with pirc ("Host · runs the rooms", hollow ring); "IN OTHER ROOMS — 1" with
  學校助理 at 72% opacity ("Working in #school · reading Moodle", green dot).

**Today.** `apps/web/src/lib/components/rooms/Rooms.svelte` (grid, list, header, composer),
`RoomMessageRow.svelte` (message, line and question anatomy), `MembersPanel.svelte`,
`RoomSources.svelte`, `app.css` tokens.

**What differs.**

- Widths: 248px list today (design 240px), no fixed members width today (the thread-open grid
  adds `minmax(280px, 380px)`; the members/face column is the third grid track).
- The list is flat today: no "ROOMS" eyebrow, no server subtitle, no server menu, and the new-room
  `+` lives in the header. "Archived" has no count. Unread is an 8px dot, not a red count. The
  "Your turn" pill and the open-row tint already exist.
- The room header today has a presence pill ("pirc is here" / "X is thinking"), Members, mute,
  sources, archive and a "Continue in…" select, but no subtitle line, no search, and no Threads or
  Pinned buttons. Pinned messages are a horizontal strip above the log, not a panel.
- Message rows today: 36px avatars, 12px gap, 6px 20px padding, 40px gutter; no face badges, no
  mention chips, no day divider, no NEW divider, no thread preview card (only an "Open the
  thread" link under a worker pill), no 20px worker-initial cluster. Attachments render as an
  image (max 360×280) or a one-line file chip; the design's file card, "Download" subtitle and
  pasted-image tile have no equivalent.
- Lines today are plain text with link actions and no icons, at 72px inset (same inset). "Don't
  keep", "Close it"/loop undo, "Cancel" for wakes and "Details" already exist with different
  wording and colors.
- A question today is the message itself with a 3px accent left border and the choices below it;
  the design wraps it in a warning-tinted card with an "ASKS YOU" badge and an explicit
  "or just reply".
- The waiting banner above the composer exists today as an `asking` strip (3px warning left
  border, "X is waiting for your answer: <request>", Show), but it is not attached to the
  composer and has no face-colored text or yellow square.
- Composer today is an outlined box with a paperclip, a textarea and an accent send icon; no
  filled pill, no round `+`, no attachment thumbnails (file names only), no "@ to bring in a
  face" hint.
- Members today is one flat list with host/this-room tags, a presence label per face, add-face
  and hidden-face controls. The design groups by waiting/idle/other rooms, uses the face's second
  line for what it is doing, and has no add/hide controls in the column.

## Screen 2: Thread open in right column

**What it shows.** Same shell as screen 1 with the members column replaced by a 420px thread
column (`#17171a`, left hairline).

- The list keeps its width; the main column narrows (`flex 1 1 480px`) and message rows use 32px
  right padding. The thread card in the log is the selected one: 2px accent inset ring, 8px
  radius, status "Working · 3" in green, and the row behind it is tinted `#ffffff08`. Threads
  icon in the header is pressed.
- Thread header: 20px thread icon, title "Fix the lint job" (15px), "from SlimeOS PM · slimeos on
  arch-desktop" (12px), an "Engine" link with an outward arrow, close button.
- A worker strip under the header (`role="status"`): three 30px rows, each a status glyph,
  monospace worker name (`lint`, `reviewer`, `tests`), and the latest state ("Done · committed
  4f2a9c1", "Done", green "Working · cargo test --workspace"). The nested worker is indented with
  a small elbow line.
- Thread messages: 32px avatars (workers use rounded squares with 10–11px mono initials), 12px
  gap, name + optional `WORKER` tag + time, then text. A tool call is a full-width 34px button:
  "bash `cargo clippy --all-targets -- -D warnings` exit 101" with a red exit, or the same with a
  green "running". The nested reviewer reply is indented 60px with a "↳ lint" marker. "Started
  <worker> in <workspace> · <node>" lines at 12px. Composer: "Jump in — the workers will see it".
- The main composer on this screen is the plain one ("Message #SlimeOS"), without the waiting
  banner, attachments or `+`.

**Today.** `ThreadPanel.svelte` (header, workers list, messages, composer), `Rooms.svelte`
(`thread-open` grid), `RoomMessageRow.svelte` (thread card not present), `rooms.svelte.ts`
(`threadId`, `threadMessages`, `threadWorkers`, `threadActivity`), `mock.ts` `demoThread`.

**What differs.**

- Layout is already "thread replaces the third column"; the design fixes it at 420px and hides
  the members instead of stacking. Today the third track is `minmax(280px, 380px)` and a thread
  takes precedence over members (`roomId && !threadId`).
- The thread header today has title, status, workspace, an Engine link, Stop and close; it lacks
  the "from <face>" line and the selected-thread state in the log.
- The worker strip today is a flat list (name plus last said, one line, 12px); the design is a
  three-level tree with status glyphs and per-worker state text.
- Thread messages today are a compact three-column grid (who / body / time) at 13px, with tool
  calls as plain code, questions as accent-bordered blocks, and a `details` "What it was given".
  The design gives every message an avatar and a header, tool calls as chips with exit status,
  and nested workers their own indented rows; there is no context disclosure in the design.
- The thread composer today only appears when you own the newest worker ("Tell the worker…" /
  "Give it more to do…"); the design always shows "Jump in — the workers will see it" (which is
  a permissions question, see below).
- The design's read-only marker for a thread is a status word next to the worker; today it is
  appended to the status line (`· read-only`), same idea.

## Screen 3: Face page · SlimeOS PM

**What it shows.** A single 360×900 panel (the third column on a desktop room), background
`#17171a`, 14px base.

- A 104px hero in the face color with a 36px translucent round back button, an 80px avatar with
  a 6px `#17171a` ring overlapping the hero by 40px, and a 16px status square at its edge.
- Below, 52px top padding: name "SlimeOS PM" at 20px/700 with a `PROJECT` badge; bio "Keeps
  SlimeOS moving." in secondary ink.
- A waiting strip (`#f0b2321a`, 8px radius, yellow square): "Waiting for you ·
  `git push origin fix-lint`".
- Actions: a full-width accent "Mention in room" button and a secondary "Edit".
- Cards (`#111113`, 8px radius, 12px padding): Role text plus "Edit role" link; Territory as a
  two-column grid (Rooms `# SlimeOS`, Workspaces `slimeos · arch-desktop` in mono, Sources
  "None"); "Open loops · 2" with a loop and a recurring item, each with a 12px context line;
  "Recently" with "Called a worker · Fix the lint job" and "Remembered · 你在意 boot 時間" and
  "See all in Engine".

**Today.** `FacePanel.svelte` (the whole page), `faces.ts` (presence, territory, avatar), with
`MemorySettings` inside for the host.

**What differs.**

- Today the panel is a 360-ish third column with a 32px avatar header row (back, avatar, name,
  presence, close), then an always-editable form: name, bio, tone, avatar, color, role, territory
  checkboxes, Save/Archive. The design turns the page into a profile: hero, bio, read-only cards,
  and an "Edit" entry point that does not exist.
- "Mention in room" has no equivalent; the room composer's `@` completion is the only way to
  mention a face today.
- The design shows territory as a compact definition grid, not checkboxes, and no "this room"
  or ownership notes.
- The design's "Open loops" and "Recently" mirror today's "Loops it holds" and "Lately", with
  richer rows (type icon, origin, recurrence "every Wed 18:00 · next 10/28"). Today those are
  plain list items with an `ago()` stamp.
- The design omits everything host-specific: SOUL.md/CHAT.md editing and the host's remembered
  preferences. On a 360px panel those are not reachable at all today (the page is a form, not a
  hub).
- The design's face-color hero and 80px avatar are new; today the avatar is 32px everywhere and
  the color is used only for the circle.

## Screen 4: Room · phone

**What it shows.** A 390×844 phone frame, 15px base, `#1d1d20`.

- 56px header: 44px menu button, 20px hash, "SlimeOS" at 17px, a 44px mute button. No presence,
  no members, no search.
- Log is bottom-aligned (`justify-content: flex-end`) with 8px vertical padding: 36px avatars,
  12px gap, 16px/12px padding, 10px between messages. A thread card (44px, full width) with
  "Working · 3". A "Remembered · …" line with "Don't keep". A two-paragraph user message. A red
  NEW divider. A question card (`#f0b2321a`, radius 10, "ASKS YOU" at 10px) with a full-width
  `Yes` and `No` (44px, side by side) and no "Allow again" or "or just reply".
- Composer: 8px 12px 10px, a 48px pill (radius 24) with a 32px `+`, a 16px input, and a 36px
  accent circular send arrow ("Send now (long-press)").
- 64px bottom navigation over four equal tabs (Rooms with a yellow "1", Members, Engine,
  Settings), icon 22px above an 11px label, 1px top hairline.

**Today.** `Rooms.svelte` (`@media (max-width: 650px)`), `MobileTabs.svelte`, `RoomMessageRow`,
`app.css` (16px fields on touch), `viewport.ts`.

**What differs.**

- Today the phone starts on the open room; the room list is an overlay reached from the Rooms
  tab, with no hamburger in the header. The design puts a menu button in the room header, which
  is a second way to the same list.
- The shipped phone header carries the presence pill, Members toggle, mute, sources, archive and
  the continue-in select; the design keeps only title, hash, menu and mute.
- Messages today are the same component as desktop (36px avatar, 12px gap), but top-aligned and
  scrolling; the design bottom-aligns short logs and uses 36px avatars with 10px spacing.
- The thread preview card, NEW divider and the question card styling are new (see screen 1).
- The composer today is the desktop box with a paperclip and textarea; the design is a 48px
  rounded pill with a `+` and a filled accent send button, 16px input.
- Bottom tabs are 56px today with a 56px page inset, four tabs with 20px icons and a count badge
  on Rooms (rooms waiting). The design is 64px with 22px icons, an 11px label, and the same four
  destinations. Today's safe-area padding is kept by the app and must stay.
- The design's "long-press to send now" has no counterpart; today Enter sends, Cmd/Ctrl+Enter
  sends immediately.

## Screen 5: Engine · overview

**What it shows.** 1440×1060, 14px base.

- Engine sidebar (about 260px at 1440, `#17171a`): 52px header "Engine" + "behind the rooms";
  "Overview" row;
  a 32px search field; "NEEDS YOU" with a yellow count and one tinted row ("Fix the lint job ·
  lint", "Delegated · answer in #SlimeOS"); device sections "arch-desktop" with a green dot and
  "1 / 4", a mono workspace label `slimeos`, session rows (yellow square "Fix the lint job ·
  lint", hollow ring "Fix the lint job · tests", indented `reviewer`); "mac-mini" "0 / 2",
  workspace `dotfiles`, "No sessions yet."; footer Rooms (with a yellow "1" badge) and Settings.
- Main column (`#1d1d20`, max 1040px): h1 "Engine" 22px, subtitle "What runs behind the rooms.
  You don't need to look here unless something goes wrong."; a tab strip Overview, Nodes, Brain,
  Open loops, Wakes, Memory, Sources (accent underline on Overview).
- "HANDS · 2 ONLINE" with an "All nodes" link and two node cards (grid, min 300px): 36px icon
  tile, mono node id, "linux · x86_64 · connected 3 d ago", state "Busy" (green) or "Free"
  (hollow), a "Running 1 of 4" line with a four-segment meter, and capability chips:
  `GPU · [GPU MODEL] ×1`, `browse`, `terminals`, `bubblewrap · ready`; "Workspaces · slimeos,
  pirc".
- "BRAIN · RECENT TURNS" with "one turn at a time, every room" and "All turns": a card containing
  a table with Started, Room, Why, Outcome, Took, Used, five rows across rooms (`# SlimeOS`,
  `# school`, `# general`).
- Three cards in an auto-fit grid: "OPEN LOOPS" ("4 of 40 in prompt") with four items (what,
  anchor/origin, a mono origin chip such as `tool:moodle` or `user`, a room) and "All loops";
  "WAKES" ("9 of 24 today") with a 37.5% progress bar, "Coming" two items with a Cancel on one,
  and "Recent"; "SOURCES" with "Manage in Settings" and rows `個人 Gmail`, `Moodle`, a failing
  `學校 Gmail` in a red tint ("Failing · 3×", "IMAP login rejected…"), a paused `課表 (ICS)`.

**Today.** `Engine.svelte` (shell, sidebar slot), `Sidebar.svelte` (inbox and device/workspace
tree), `EngineOverview.svelte` (tabs and one panel), `NodeCards.svelte`, `BrainTurns.svelte`,
`SourcesStatus.svelte`, `LoopsSettings.svelte`, `WakesSettings.svelte`, `routes.ts`
(`OVERVIEW_SECTIONS`).

**What differs.**

- Today the overview is a tabbed panel showing one section at a time (Nodes, Brain, Open loops,
  Wakes, Memory, Sources), max 880px. The design is a single dashboard that stacks Hands, recent
  turns, and the loops/wakes/sources cards; its "Overview" tab is a seventh tab beside the six,
  which does not exist in `OVERVIEW_SECTIONS`. This is the biggest structural change in the set.
- The sidebar is close (Overview, search, Needs you, device → workspace → sessions, Rooms badge),
  but today workspaces are rows with unread/running counts and sessions can be filtered by
  settled; the design collapses that into a mono workspace label plus session rows and a
  "0 / 2" load count per node.
- "Hands" is not a section today: nodes are one tab. Node cards today use a definition list
  (Machine, GPU, Can, Sandbox, Load, Workspaces) with no Busy/Free word, no segmented meter, no
  capability chips, and no "All nodes".
- Brain turns today are per-room (a `Room` select), with columns Started/Why/Outcome/Took/Used;
  the design crosses rooms and adds a Room column and the "one turn at a time, every room" note.
- Loops and wakes today are settings-style editors (`LoopsSettings`, `WakesSettings`), not
  summary cards with "4 of 40 in prompt", a daily progress bar, coming/recent lists and inline
  Cancel.
- Sources is close: today a list with dot, name, kind, state ("Failing (N in a row)"), last read,
  rooms and last error. The design compresses it into a card with a failing tint and a diagonal
  status marker, and adds "Manage in Settings".
- The design's "Needs you" row says "Delegated · answer in #SlimeOS"; today the inbox row
  says "Delegated · <delegation title> · waiting for you" (or the workspace name) and offers
  Reply. Same idea, a different sentence and no room named.

## Screen 6: Engine · worker session (read-only)

**What it shows.** 1440×900, 14px base.

- Engine sidebar: same as screen 5 but the selected session is highlighted, and there is no "No
  sessions yet." under mac-mini.
- Session header: 10px 16px, breadcrumb `slimeos / Fix the lint job · lint` (workspace in mono),
  then h1 at 17px, a 28px rename pencil, and an orange worker chip "Worker · Fix the lint job"
  with a forward arrow. Right side: a "Jobs" button, a green "Live" pill, and an accent "Take
  control" button with a shield.
- A full-width yellow status band: "Waiting for you in **# SlimeOS** ·
  `git push origin fix-lint`" with "Answer in the room" underlined.
- Pane tabs: Files, Git (selected), Memory, Context, Tasks, Terminal, Browser, each 15px icon +
  13px label, 10px padding, accent underline on Git.
- Git pane, two columns at 16px gap: left (flex 1 1 280px) a branch card (`fix-lint`, chip "1
  ahead · not pushed", "Working tree clean") and "HISTORY" with two selectable rows (sha +
  subject, then "worker lint · 14:07 · HEAD" or "origin/fix-lint"); right (flex 999 1 460px) a
  diff card: header `kernel/sched.rs`, `+2` green, `−4` red, then hunk header and monospace
  lines with red/green tints and +/- markers.
- "Read-only" is expressed by the title of the comp, the "Take control" button and the waiting
  band; there is no separate read-only chip.

**Today.** `Engine.svelte` (topbar, origin chip, connection pill, Take control), `SessionPanes`
(seven tabs), `GitTab` + `DiffView` (changes/history, branch line, file groups, commit list,
drill-down diff), `Sidebar.svelte`.

**What differs.**

- Today's topbar has breadcrumb (only the workspace crumb is visible), h1, origin chip, a
  "Not sandboxed" chip when relevant, Jobs, a Live/Offline/Reconnecting pill, and
  Take control/In control; it lacks the rename affordance and the explicit "Worker ·" chip is
  styled differently (pill with border, not orange tint). The comp's "Live" pill matches the
  connected pill.
- The "Waiting for you … Answer in the room" band has no equivalent; today a room question is
  visible only in the room or the thread.
- Pane tabs match one-to-one (Files, Git, Memory, Context, Tasks, Terminal, Browser), but today
  they are 30px (40px on touch) with 12.5px labels and 16px icons; the design is 13px labels
  with 15px icons and a full-width underline.
- Git today switches between Changes and History (segmented control) and shows one pane at a
  time; a selected commit replaces the list with a drill-down card and diff. The design shows
  branch + history + diff at once in two columns, with the diff as the primary pane. Today's
  branch line (branch, upstream, ahead/behind chips) and "Working tree clean." exist; the comp's
  "1 ahead · not pushed" wording is new.
- The design's history rows combine sha, subject and an author/time/HEAD line; today's commit
  rows are subject + meta in a list, with a drill-down for details.
- Today read-only is communicated by the viewer banner ("You're viewing this session … has
  control") and the Take control button; the comp has no viewer banner, so a faithful build must
  decide which one wins.

## Mapping: screen to current file

| Screen                       | Current files                                                                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Room · #SlimeOS (desktop) | `rooms/Rooms.svelte` (grid, list, header, composer, mobile), `rooms/RoomMessageRow.svelte`, `rooms/MembersPanel.svelte`, `rooms/RoomSources.svelte`                                                                                     |
| 2. Thread open               | `rooms/ThreadPanel.svelte`, `rooms/Rooms.svelte` (`thread-open` grid), `rooms/RoomMessageRow.svelte`, `rooms.svelte.ts`, `mock.ts`                                                                                                      |
| 3. Face page · SlimeOS PM    | `rooms/FacePanel.svelte`, `faces.ts` (`hueOf`, `initialOf`, `presenceLabel`, territory), `rooms/Rooms.svelte` (side state)                                                                                                              |
| 4. Room · phone              | `rooms/Rooms.svelte` (`@media (max-width: 650px)`), `components/MobileTabs.svelte`, `app.css`, `viewport.ts`                                                                                                                            |
| 5. Engine · overview         | `Engine.svelte` (shell), `components/Sidebar.svelte`, `engine/EngineOverview.svelte`, `engine/NodeCards.svelte`, `engine/BrainTurns.svelte`, `engine/SourcesStatus.svelte`, `LoopsSettings.svelte`, `WakesSettings.svelte`, `routes.ts` |
| 6. Engine · worker session   | `Engine.svelte` (topbar, origin chip, control), `panel/SessionPanes.svelte`, `panel/GitTab.svelte`, `panel/DiffView.svelte`, `components/Sidebar.svelte`, `types.ts` (`SessionOrigin`)                                                  |

## Changes the design implies

Grouped, smallest first. Nothing here is scheduled; each line is a concrete difference the comps
would require.

1. **Theme.** A dark palette with the design's exact surface/ink steps (today the app is
   light-first with a dark `prefers-color-scheme` variant whose steps are `#151517`/`#1c1c1e`, not
   the design's). Decide whether the design replaces both themes or adds a third "rooms dark".
2. **Type.** Self-host IBM Plex Sans, JetBrains Mono and Noto Sans TC (the comps pull 114 woff2
   slices from Google Fonts at runtime, which the app must not do; all three are OFL). Move the
   base to 15px in rooms, 14px in the engine and face page, and adopt 12px/`0.04em` uppercase
   section labels and mono identifiers.
3. **Room list.** 240px width, 52px header with a "gateway · N hands online" subtitle and a
   server menu, "ROOMS" eyebrow, 36px rows, red unread counts instead of a dot, an
   "Archived · N" fold count, 4×8px unread marker, and a darker footer band.
4. **Room header.** A subtitle line ("Project room · @face · workspace on node"), Threads,
   Pinned and Mute icon buttons, a 180×30 search field, and Members as the fourth toggle. The
   present sources/archive/continue-in controls have no place in the comp and need a home.
5. **Message anatomy.** 40px avatars, 16px gap, 48px right inset, face badges (`HOST`,
   `PROJECT`), face-colored mention chips, 20px initial clusters for workers, a thread preview
   card with status and last activity, attachment cards with a "Download" second line, a
   240×135 pasted-image tile.
6. **Dividers.** A "Today" hairline and an unread "NEW" divider; today neither exists.
7. **Lines.** Icons per line type (worker, loop, memory, wake), the same 72px inset, Stop /
   Details / Close it / Don't keep as compact inline buttons. Behavior exists; the presentation
   does not.
8. **Question card.** A warning-tinted panel with an "ASKS YOU" shield badge, the request as
   code, and Yes / Allow again this session / No / Thread / "or just reply". Today it is an
   accent-bordered message; the wording "or just reply" implies the composer is the fourth
   answer, which already works but is not explained.
9. **Waiting banner.** The `asking` strip becomes a bar fused to the top of the composer, in face
   color with a yellow square, title and Show. Same data (`asking`, `question.request.title`).
10. **Composer.** Filled `#26262b` surface, round `+` attach button, one-line input with the
    "@ to bring in a face" hint, accent circular send, thumbnail attachment row with a type tile
    and "pasted"/size subtitle, all at 48px height; on the phone a 24px-radius pill and 36px
    accent send.
11. **Members.** Group by what faces are doing ("Waiting for you", "Idle", "In other rooms"),
    44px rows with a second line of detail, colored status shapes (square = waiting, dot =
    working, ring = idle), no add/hide controls in the column (they would move to a menu).
12. **Face page.** A profile layout: 104px color hero, 80px overlapping avatar, name and badge,
    bio, waiting strip, "Mention in room" + "Edit", read-only Role/Territory cards, open loops,
    recently; editing moves behind Edit instead of always-on fields.
13. **Phone.** 56px header with a menu button, bottom-aligned log, 36px avatars, 64px bottom nav
    with 22px icons, 48px pill composer with a circular accent send, question card with two
    full-width buttons. Keep `env(safe-area-inset-*)`.
14. **Engine overview.** One scrolling dashboard instead of one tab at a time: a Hands section of
    node cards (state word, segmented load meter, capability chips, workspaces), a cross-room
    recent turns table with a Room column, and summary cards for open loops (n of 40 in prompt),
    wakes (n of 24 today, progress, coming/recent, Cancel) and sources (failing tint). The tab
    strip needs an "Overview" member or to become anchors.
15. **Engine session.** A "Waiting for you in #room · request" band with "Answer in the room"; a
    "Worker · title" chip in the topbar; a rename affordance; a two-column Git pane (branch +
    history on the left, diff on the right) instead of Changes/History drill-down.
16. **Status language.** Adopt the same glyphs everywhere: green dot working, hollow ring idle,
    yellow square waiting/asks you, red tint failure. Today's dots are generic
    (`state-dot` idle/ongoing/done/error) and the rooms use a different set.

## Blockers and gaps for a faithful build

- **The comps are single-state visual comps with baked-in data.** Every screen is one static
  HTML document; no loading, empty, error or interaction states exist beyond what is written in
  the markup. The `DCLogic` script only exposes `accent`/`faceColor`. They cannot be used as
  behavioral specs.
- **Fonts.** The type depends on IBM Plex Sans, JetBrains Mono and Noto Sans TC; the comps link
  them from `fonts.gstatic.com` and ship no font files. We would have to add the woff2 files to
  the app (or choose the system stack and lose the look). Noto Sans TC is essential for the
  Chinese UI; today's stack already has PingFang/JhengHei fallbacks.
- **Assets.** No logo, no illustrations, no imagery. All avatars are initials on colored
  circles; the only "image" is a `[pasted screenshot]` placeholder. Icons are inline SVG copies
  of a lucide-like set; the app already uses `@lucide/svelte`, so icon parity is achievable but
  each glyph must be matched by hand.
- **Placeholders that stand for unavailable data:** `[GPU MODEL]`, `[sha]`,
  `[PR#123's last commit]`, `[img]`, "connected 3 d ago", "2 hands online", `9 of 24 today`,
  `4 of 40 in prompt`, "3.1k tokens". The numbers are illustrative; the app has real values
  for most (node capabilities, turns usage, loop/wake counts) and none for a few ("hands
  online"; worker initials `w1`/`rv`/`w2` are labels, not avatars).
- **Screens too sparse to build from:** the face page (no edit affordances, no host content, no
  empty state), the phone (no list screen, no members screen, no thread, no settings), and the
  engine session (one Git pane only; no Files, Memory, Context, Tasks, Terminal or Browser
  content, no empty/error pane). The thread screen has no "no thread yet", no error and no
  read-only variant.
- **Data-model questions the designs raise:** per-room unread counts (today the API returns
  `unread` as a count on `RoomView`, so the red badge is feasible); "gateway · 2 hands online"
  (there is no "hands" count; the closest is connected nodes or online faces); worker avatars
  with initials (today workers have names only, e.g. `lint`, `reviewer`, so `w1`/`rv` would need
  a new convention); a face's "Waiting for you" second line (`FacePresence` has
  `state`/`line`, so this is feasible); "In other rooms" grouping (today `facePresence` has
  `roomId`, so feasible); per-worker status in the thread strip (today `Worker` has `status`).

## Questions for the person

States the comps do not show:

1. **Loading and reconnecting.** What do the room log, the members column, the thread and the
   engine dashboard look like while loading, offline or reconnecting? Today there is an empty
   message ("Nothing here yet"), a connection badge, and "Connecting to your sessions…" in the
   engine.
2. **Empty room.** "Nothing here yet. Say something." is today's line; the design has none. Is
   there an on-ramp (mention a face, ask pirc) for a new room?
3. **Error and failure.** A failed send, a 409 on an archived room, a failed thread load, a
   source failing, a node offline: the design shows only one source failure. Where do errors
   live in the new layout?
4. **Archived rooms.** The list folds them; what does an archived room's page look like (today
   the composer is replaced by "This room is archived. Unarchive it to write here.")? Is a
   read-only banner like the engine's wanted?
5. **Long messages, markdown, code.** The comps show one-line prose, a two-item list, inline
   code and a shell command. No long message, no headings, no tables, no fenced code, no
   streaming caret. Does the message column stay at 48px right inset for wide markdown, and do
   code blocks get the `#111113` well?
6. **Uploads.** One attachment card and one pasted image; no upload progress, failure, remove,
   drag-and-drop or multi-file layout. The composer shows a thumbnail row; what is the limit and
   the look for many files?
7. **Presence and typing.** The comps use presence in the members column and in face status, but
   the room header has no presence and no typing line. Is "X is thinking…" gone, or moved?
8. **Threads list and pins.** The header has Threads and Pinned buttons; the comps show neither
   panel. What opens there, and does the pinned strip stay?
9. **Search.** A 180px "Search SlimeOS" field in the room header and one in the engine sidebar.
   Is room search scoped to the room, and does it search server-side? Today there is no room
   search.
10. **Face editing and creation.** The face page shows "Edit" and no add-face control; the
    members column has no "+". Where do creating, hiding, archiving and editing a face live in
    the new shape? Does the host page keep SOUL.md/CHAT.md and remembered preferences?
11. **"Mention in room".** What does it do: open the room with `@face ` prefilled, or post a
    mention now? And is "Waiting for you" on a face the same as a room's "Your turn"?
12. **`Allow again this session` on the phone.** The desktop question card has it; the phone card
    has only Yes/No. Is that a deliberate narrower answer on mobile, or an omission?
13. **"or just reply".** Does a free-text answer to the question card go to the worker
    (today it does through the thread), and is that clear enough to promise in the copy?
14. **Unread semantics.** Red counts in the room list, a "NEW" divider in the log, "Your turn" on
    the open room. Are these three derived from the same `waiting`/`unread` fields, and should
    the count clear on open (today `markRead` clears unread)?
15. **Engine overview tabs.** Do the seven tabs stay as filters over one dashboard, or become
    anchors that scroll? Today each tab swaps the whole panel; the design stacks everything and
    also has an "Overview" tab.
16. **"All nodes", "All turns", "All loops", "See all in Engine", "Manage in Settings".** These
    are links in the comps to pages or sections that do not exist as such; what should each open?
17. **Git pane.** Does the two-column branch/history + diff replace the Changes/History
    segmented control, and where do uncommitted changes go? Does the diff still drill into a
    commit, or only show the selected one?
18. **Read-only sessions.** The comp is titled "read-only" and shows "Take control"; today a
    viewer banner appears when someone else holds control. Which is the canonical treatment, and
    does the waiting band stay while read-only?
19. **Theme and density.** Is the dark palette the only target, and does it replace the light
    theme? Should the rooms be 15px and the engine 14px, as drawn, on a 1440-wide desktop?
20. **Copy.** The comps mix Traditional Chinese and English and use "hands", "Engine",
    "faces", "workers", "Your turn", "ASKS YOU". Which of these are product words, and is there
    a copy deck? Some strings differ from today's ("Waiting for your answer" vs "is waiting for
    you", "Jump in — the workers will see it" vs "Tell the worker…").

## How faithful can an implementation be

The layout, spacing, type scale, palette and component anatomy can be reproduced closely: they
are explicit numbers and hex values in inline styles, and the app's data model already carries
most of what is drawn (rooms with `waiting`/`unread`, faces with color/territory/presence,
threads with workers and tool calls, questions with `allowAgain`, nodes with capabilities and
load, brain turns with usage, loops/wakes/sources). The parts that cannot be reproduced from the
file alone are the fonts (must be added), the icons (must be matched), the missing states and
copy (must be decided), and the one genuinely new structure: the engine overview as a single
dashboard instead of a tabbed panel. Screens 3, 4 and 6 are sparse enough that building from them
without answers to the questions above would mean inventing behavior.

## Decisions

The person answered four of the questions above in conversation (2026-10-23). Quoted as
he wrote them, with what each one settles:

1. **Engine overview (Q15):** "動" — the overview becomes one scrolling dashboard. The
   seven tabs survive as anchors over it, **Overview** first. A later phase.
2. **Theme (Q19):** "先照著做深色" — dark first. The design's dark palette is now what
   the web client ships, on every device and regardless of the operating system's
   preference. The light tokens are kept under `:root[data-theme='light']` but nothing
   sets that attribute, so light no longer ships. The type scale is the drawn one: rooms
   at 15px, the engine at 14px, 12px/0.04em uppercase section labels, JetBrains Mono for
   identifiers.
3. **Face details (Q10):** "就在成員列表點他就能顯示詳細資料" — clicking a face in the
   members list shows its detail page. Creating, archiving and editing a face stay where
   they are today (the add control and the hide/show controls in the members column; the
   host's page keeps SOUL.md, CHAT.md and the remembered preferences). There is no new
   "+" in the members column and no Engine Faces section until he says otherwise.
4. **Copy (Q20):** "做i18n" — real internationalisation. Every user-visible string goes
   through a message catalogue; `zh-TW` (Traditional Chinese, the default) and `en`
   ship. Product words (Engine, room, thread, face, worker) stay English in both
   languages. "hands" is gone: the word for machines is 節點/nodes.

### Defaults adopted for the questions he did not answer

These follow the review's own proposal, written out so the next phase can build from
them. None of them is a new decision by the person; each can be revisited.

| #   | Question              | Default adopted                                                                                                                                                                   |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Loading, reconnecting | Keep today's words and shapes: the empty log line, the engine's "Connecting to your sessions…", the connection pill. No skeleton screens.                                         |
| 2   | Empty room            | Keep "Nothing here yet. Say something." (translated). No on-ramp cards in this design round.                                                                                      |
| 3   | Errors                | Shown where they happen: a failed send under the composer, a refused archive beside its button, a failed thread load in the thread, a failing source in its row. No toast system. |
| 4   | Archived rooms        | The archived room keeps a read-only banner; it moves into the room header with the new layout. The list keeps the "Archived · N" fold.                                            |
| 5   | Long messages         | The message column keeps its width and Markdown; code stays in the `#111113` well. The 48px right inset arrives with the layout.                                                  |
| 6   | Uploads               | The composer shows at most three thumbnails and a "+N" for the rest; a list holds the names.                                                                                      |
| 7   | Presence, typing      | "X is thinking…" stays at the bottom of the log; the header loses its presence pill in the layout phase.                                                                          |
| 8   | Threads, pins         | Threads and Pinned open right-column panels. The pinned strip stops being a strip above the log.                                                                                  |
| 9   | Search                | Room search is client-side over the messages already loaded.                                                                                                                      |
| 10  | Faces                 | As answered above: the detail page comes from the members list; creation, hiding, archiving and editing stay where they are; no Engine Faces section for now.                     |
| 11  | Mention in room       | Opens the room with `@face ` prefilled in the composer and does not send.                                                                                                         |
| 12  | Phone questions       | The phone question card gets "Allow again this session" too, the same answers as the desktop card.                                                                                |
| 13  | "or just reply"       | A free-text answer goes through the thread; the copy may promise that.                                                                                                            |
| 14  | Unread                | The red count, the "NEW" divider and "Your turn" all come from the same `waiting`/`unread` fields; opening a room still marks it read.                                            |
| 15  | Engine tabs           | Seven anchors over one scrolling dashboard, Overview first.                                                                                                                       |
| 16  | "All …" links         | Each points at the matching engine tab (nodes, turns, loops) or the matching Settings section ("Manage in Settings" opens Settings → Models & sources).                           |
| 17  | Git pane              | Two columns: branch card, the uncommitted changes and history on the left, the diff on the right. Selecting a commit still drills into its diff.                                  |
| 18  | Read-only sessions    | The narrow viewer banner stays and the waiting band ("Waiting for you in #room · request") joins it; Take control stays.                                                          |
| 19  | Theme and density     | Dark only, as answered: rooms 15px, engine 14px, as drawn for a 1440-wide desktop. Light tokens are kept, unused.                                                                 |
| 20  | Copy                  | Product nouns (Engine, room, thread, face, worker) stay English; ordinary UI words ("Your turn", "ASKS YOU", "Waiting for you") are translated. No "hands".                       |

### What this round changes

The foundation only, with the current layouts kept: the design's dark palette and type
scale as CSS custom properties, the three typefaces self-hosted, one status vocabulary,
and every string routed through the new message catalogue (`apps/web/src/lib/i18n`,
`zh-TW` default, `en`, chosen from the browser's language, remembered per device, and
switchable from the Settings header). The room list, message anatomy, thread, face page,
phone layout and engine dashboard keep their present structure; they are the next
phases, in that order of risk: room desktop layout, thread, face page, phone, engine
dashboard.

### What the rooms layout round built

The desktop room screen is now the design's three columns (240px list, the room,
248px beside it): the list with its gateway line and red unread counts, the
header with Threads/Pinned/Mute/Members and the 180×30 client-side search, the
message anatomy (40px avatars, face badges, mention chips, thread card,
attachment cards, day and "New" dividers), the amber question card, the waiting
strip fused to the composer, the filled composer with three tiles and "+N", and
members grouped by what they are doing. Threads and Pinned open columns of their
own. The contract is in
[architecture/web-client.md](../architecture/web-client.md#the-rooms-screen).

Three comp details could not be reproduced from the app's data, so they were
interpreted rather than invented:

- **Worker initials on a thread card.** A room anchor carries how many workers
  spoke (`WorkerAnchor.workers`), not their names; the card shows that count in
  the 20px circle instead of `w1`/`rv`/`w2`.
- **"slimeos on arch-desktop" in the room header.** Workspaces and nodes are
  engine state and the rooms page may not load them (`lib/boundaries.test.ts`);
  the subtitle shows only the room's kind and its face.
- **Add/hide controls in the members column.** Change 11 would remove them, but
  the person's decision keeps creating and hiding faces where they were; they
  moved into the column's own header menu so the rows stay the design's, and
  nothing became unreachable.

### What the thread, face and phone round built

The rest of the design is now in the web client: the thread column
(screen 2) at 420px, the face page (screen 3) at 360px, and the phone layout
(screen 4). The nth-degree details are in
[architecture/web-client.md](../architecture/web-client.md#the-workers-thread).

Where the comps or the data left a gap, these were the calls made, rather than
silently deviating:

- **The thread's status and its Stop.** The comp's thread header has no status
  (it lives on the card in the log) and no Stop (Stop sits on the room's line
  about the worker). The header keeps a status line because the person asked
  for "the thread header with its anchor message and status"; Stop stays on the
  card in the room, still reachable a few pixels to the left, rather than a
  second copy in the header that pushed the header past its 52px.
- **A tool call's exit status.** The comp's chip ends in "exit 101" or a green
  "running". A thread message carries a tool's name and its one-line summary
  and nothing else (no output, no exit code), so the chip draws those two and
  stops there.
- **"Done · committed 4f2a9c1".** The worker's own state comes from the
  gateway (`Worker.status`), but a teammate is not a worker record: its state
  is drawn only when the data settles it (a pending question → waiting, a team
  `result`/`error` → done/failed) and is otherwise the idle ring. No "committed
  <sha>" line is invented.
- **"from SlimeOS PM · slimeos on arch-desktop".** Workspaces and nodes are
  engine state the rooms page may not load, so the line is the face and the
  workspace, as in the room header.
- **The reply box.** The comp always shows it; the gateway lets only whom the
  worker works for add to its thread. It is always drawn, and for anyone else
  it is disabled and names who it waits for, instead of promising a send that
  would be refused.
- **The face's 80px avatar** shows the name's first letter (the app's
  `initialOf`), not the comp's two-letter initials.
- **The host's page.** The comp omits SOUL.md, CHAT.md and the remembered
  preferences; the person asked that nothing disappear, so they stay below the
  profile's cards (and in the Edit view) rather than behind Edit alone.
- **"Mention in room"** opens the room the face answers in — the first room of
  its territory, else the open room — with `@name ` in the composer's draft,
  and sends nothing.
- **"See all in Engine"** points at the engine's brain section, because the
  "Recently" card mixes workers and wakes and no single tab holds both.
- **The phone's header.** The comp draws a menu button and mute only. The
  room's threads, pins, search, sources, archive and "Continue in…" moved into
  the menu button beside mute (a third control the comp does not draw) and
  members moved to the bottom navigation, so nothing became unreachable.
- **The phone's question card** stacks all three answers full width at 44px in
  DOM order. The comp draws two side by side; "Allow again this session" was
  kept on the phone (decision #12), and stacking keeps the tab order and the
  drawn order the same instead of reordering the buttons in CSS.
- **The phone's side panels** (members, a face, threads, pins, a thread) are
  full-screen above the tabs, not sheets.
- **A long log on a phone** is bottom-aligned with an auto top margin on its
  first row rather than `justify-content: flex-end`, which would clip the top
  of a log that overflows.
- **Narrower desktops.** The thread's 420px is exact from 1100px up; below that
  the column may give way to 300px so the log stays readable. The face page's
  360px track applies only while a face is open; members stay at 248px.

### What the engine round built

The last two screens are in: the engine's front page is one scrolling dashboard
(screen 5) inside a 1040px column, and a session's page has the design's header,
waiting band, pane tabs and two-column Git (screen 6). The contract is in
[architecture/web-client.md](../architecture/web-client.md#the-engine-dashboard)
and [its session page](../architecture/web-client.md#a-workers-session-page).

Where the comps or the data left a gap, these were the calls made, rather than
silently deviating:

- **"Hands · 2 online."** There is no count of hands: the word is gone
  everywhere (the person's copy decision), and the Hands heading is
  "Nodes · N online" over the nodes that are actually connected. The card's
  health is the node's own `load.running` (Busy / Free), not a new field.
- **`[GPU MODEL]`, `connected 3 d ago`, "1 of 4", `[sha]`, "3.1k tokens".**
  All are real fields on this side — `capabilities.gpus` (vendor, model,
  count), `connectedAt`, `load.running`/`load.max`, `Commit.short` and
  `usage.totalTokens` — so the comp's placeholders are filled with them. The
  GPU chip drops the VRAM the card has no room for; the Nodes section keeps it.
- **Worker initials.** The dashboard draws none (the comp's `w1`/`rv` are
  labels, not avatars); no worker is named on it at all.
- **Where the tabs go.** The seven tabs are anchors, Overview first, and each
  lands on a full section _below_ the dashboard. That is what gives "All nodes",
  "All turns" and "All loops" somewhere real to point (the per-node details, the
  per-room table with its room selector, the loops editor with its close and
  reopen actions); the cards above stay read-only apart from a wake's **Cancel**,
  which is the one action the comp draws in a card. "Manage in Settings" opens
  Settings → Models & sources, as the defaults table set out, and the face
  page's "See all in Engine" still opens the brain section.
- **Two loop lists, two wakes lists.** The dashboard's cards preview four loops
  and two coming wakes; the sections hold the full lists and the editors. That
  is the duplication anchors-over-one-page implies, and it keeps every control
  that existed (close, reopen, cancel, recently closed) where it was.
- **The waiting band's request.** A session's snapshot carries its run's state
  (`waiting_input`), not the question's text, and the engine deliberately shows
  no conversation; the gateway has no route that returns a pending
  interaction's content. The band therefore says "Waiting for you in #room" and
  links to the room, and does not print the comp's
  `git push origin fix-lint`. For the same reason a session that is _not_ a
  delegation has no band: no room is known for it, so the band is left out
  rather than pointed at a guess.
- **The rename pencil.** The client can rename a session (`engine.renameSession`,
  already the sidebar's double-click and F2), so the topbar's pencil is real: it
  turns the title into a field, Enter or leaving it commits, Escape does not.
- **Read-only.** The comp's title says read-only and draws no banner; the
  person's decision keeps the narrow viewer banner, so it stays where it was,
  above the panes, and the waiting band sits above it as a full-width row.
- **Git's "1 ahead · not pushed".** The gateway reports `ahead`/`behind` and
  `upstream`; "not pushed" is the absence of an upstream, so the chip says
  "1 ahead · not pushed" only then, and "N ahead"/"N behind" otherwise.
- **Git's uncommitted changes.** The comp's left column shows a branch card and
  history only. The uncommitted changes keep a home there (the staged and
  unstaged groups the Changes view had), because their diffs are what a person
  opens the pane for; the newest commit is selected on arrival so the right
  column is never empty.
- **The sidebar.** The Overview row takes the design's 36px shape and the footer
  gains **Rooms** beside Settings. The rest of the sidebar (workspace rows with
  their unread and running counts, the session filter, the "Needs you" rows)
  stays as the earlier rounds built it: the comp's mono workspace labels,
  "1 / 4" node load counts and "behind the rooms" header were not part of this
  round's changes, and the rows still do more than the comp draws.
