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
  holds the room's sources, archiving and "Continue in…". The search box filters
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

The composer takes files with the round **+**, by pasting a picture, or by
dragging them onto it; up to three show as tiles and the rest as "+N". When a
face asks you something, its bar sits on top of the composer and **Show** takes
you to the question. If a room is archived, the composer is replaced by a line
saying so and an **Unarchive** button.
