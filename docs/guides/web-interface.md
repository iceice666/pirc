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
