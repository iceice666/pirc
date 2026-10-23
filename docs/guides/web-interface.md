# Web interface: theme, type and language

The web client has one dark theme, one type scale and two languages. Open
**Settings** (the gear in the rooms sidebar, or the footer of the engine sidebar)
to change the language.

## Languages

- **繁體中文** (default) and **English**. A first visit follows the browser: any
  Chinese language gets Traditional Chinese, anything else English.
- The choice is remembered on this device (browser storage) and applies to every
  label, button, error, empty state, aria-label and placeholder. It does not
  change the platform: Engine, room, thread, face, worker, session and workspace
  stay English in both languages.
- Reload-open pages keep their language; switching updates the open view without
  a reload. The page's `lang` attribute follows the choice, so screen readers
  and translation tools use the right language.

## Theme and type

The client ships dark, using the palette and spacing of the rooms/engine design.
The light palette is kept in the stylesheet for later but is not selectable today.
Rooms are set at 15px, the engine at 14px, small uppercase section labels are
12px, and workspace, session and worker identifiers are monospace.

## Status marks

The same four marks mean the same thing everywhere:

- **green dot** — working, live;
- **hollow ring** — idle, finished;
- **amber square** — waiting for you, or asking you something;
- **red dot** — failing or failed.

An unread count is a red badge, and the composer's "waiting for you" bar uses the
amber tint.

Fonts are self-hosted: IBM Plex Sans for the interface, JetBrains Mono for
identifiers and Noto Sans TC for Chinese. No font is loaded from a third-party
site.

## The room screen

On a desktop the room has three columns.

- **Rooms**, on the left: the server line ("gateway · 2 faces"), then every room
  with a "Your turn" pill when a face waits for you, a red count for unread
  messages and a rail on an unread row. Archived rooms fold at the bottom.
  The menu at the top makes a new room; Engine and Settings sit at the foot.
- **The room**, in the middle: its name and kind, the face that answers there,
  and—while it lasts—the connection state. Four buttons open **Threads**,
  **Pinned messages**, **mute** and the **members** column; the menu beside them
  holds the room's sources and archiving. The search box filters
  the messages already on screen; Escape clears it. A line at the top of the
  log marks today (or another day), and a red **New** line marks where unread
  messages began. A question from a worker is an amber card: answer Yes, No,
  "Allow again this session", in its **thread**, or just by typing in the box
  below.
- **Members**, on the right: faces waiting for you, faces here, and faces in
  other rooms. Click one for its page. The column's menu adds a face and shows
  hidden ones.

**Threads** lists a room's worker threads with their status and last word;
**Pinned** lists what is pinned and jumps to it.

Open a thread and it takes the right-hand column: the worker's title, where it
came from and its status, the team under it (the worker, then its helpers
indented, each with a dot and its last word), the messages with a tool call as
a chip, a helper's reply marked "↳" its parent, and a reply box — "Jump in — the
workers will see it" — for whoever the worker works for. The worker's card in
the log is ringed while its thread is open; Escape closes it. Stop stays on the
card in the room.

A face's page is a profile: its colour across the top, its big avatar, name and
badge, its bio, a strip when it is waiting for you, **Mention in room** and
**Edit**, then what it does, what it looks after, the loops it holds and what it
did lately. **Edit** opens the fields (name, bio, tone, avatar, colour, role,
whose rooms and workspaces it covers, Save, Archive). "Mention in room" opens
the room it answers in with `@name ` ready in the box, unsent. The host's page
also keeps SOUL.md, CHAT.md and what pirc remembers about you.

## The engine

Open **Engine** (the footer of the rooms sidebar, or `/engine`). Its front page is
one page you scroll, not one section at a time.

- At the top, everything the sections below hold, at a glance: a card per
  connected node with its state (Busy or Free), how full it is, what it can do
  and which workspaces live there; the newest brain turns of **every** room in
  one table, with the room each happened in (only one turn runs at a time,
  whichever room it came from); and three cards — **open loops** with how many
  of the allowance are in the prompt, **wakes** with today's count, a progress
  bar, what is coming (which you can cancel) and what just happened, and
  **sources**, with a failing one tinted red and its last error.
- The strip under the title — Overview, Nodes, Brain, Open loops, Wakes, Memory,
  Sources — jumps to that part of the page, and the address keeps it
  (`/engine?open=loops`), so a link from a face's page or a notification comes
  back to the same place.
- **All nodes**, **All turns** and **All loops** go to the full lists in the
  sections below, where the nodes' details are, a room's turns can be picked and
  a loop can be closed or opened again; **Manage in Settings** opens Settings on
  Models & sources. Closing a loop and cancelling a wake happen in the sections,
  so the cards stay quiet.

A session's page is what runs one worker:

- Its title says which worker it is (an amber **Worker · …** chip opens the room
  it was called in), and the pencil beside the title renames it. If it is asking
  you something in its room, an amber band under the title says which room and
  takes you there to answer; if another device is driving it, the line about that
  stays above the panes.
- The panes (Files, Git, Memory, Context, Tasks, Terminal, Browser) show one at a
  time. **Git** shows the branch and its history on the left, with what is
  uncommitted and a way to load more, and the diff of the newest commit (or of a
  file, or of any commit you pick) on the right, with the lines added and removed
  counted above it.

## On a phone

The room is one column. The header has a menu button that opens the room list,
the room's name, and mute; the room's threads, pins, search and other controls
are in the menu button beside mute, and members are the second bottom tab. The
log sits at the bottom of the screen when it is short, with smaller avatars; the
composer is a rounded pill with a round send; the four tabs at the foot are a
little taller, with the count on Rooms. Members, a face's page, threads, pins
and an open thread fill the screen above those tabs.

The composer takes files with the round **+**, by pasting a picture, or by
dragging them onto it; up to three show as tiles and the rest as "+N". When a
face asks you something, its bar sits on top of the composer and **Show** takes
you to the question. If a room is archived, the composer is replaced by a line
saying so and an **Unarchive** button.
