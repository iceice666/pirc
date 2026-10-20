# Rooms, memory and open loops

[User guides](README.md) · [Assistant memory reference](../architecture/assistant-memory.md)

pirc lives in the gateway and talks with you in rooms. This guide covers what it keeps
between conversations. The reference has the exact rules and routes.

## Rooms

`#general` always exists; make a room per topic if you like. Messages you send close
together are answered as one batch a few seconds after you stop typing (Cmd+Enter sends
at once). Every device sees the same rooms.

## Memory

pirc keeps two kinds of memory about you, and shows a small line in the room each time it
writes one:

- **Preferences** ("replies in Traditional Chinese") are always on its mind. It saves one
  only when you say so or say yes when it offers.
- **Facts** ("uses TLP for power management") are kept without asking and brought up when
  what you say touches them.

**Don't keep** on the line, or "forget that", forgets it for real. Settings → Memory lists
both.

## Open loops

An open loop is something still open between you and pirc: a problem not solved yet, a
reminder, a deadline. pirc keeps every open loop in front of it until it is closed, so it
can come back to them.

- **Opening.** Say what is open ("my laptop battery still dies by noon") or ask to be
  reminded ("remind me about the team meeting every Wednesday at 18:00"). pirc opens the
  loop and the room shows "Holding on to: …". Loops with a time show when it comes next.
- **Closing.** pirc closes a loop when it is resolved ("it works now") or when you say it no
  longer matters ("that one is not needed"), and says so: "Closed: … (reason)". A meeting or
  deadline closes itself once its time passes; a repeating one ends at its last date.
- **Undo.** **Don't keep** on "Holding on to: …" closes it; **Not done yet** on a closing
  line opens it again. Saying it works too.
- **Too many.** pirc keeps at most 40 open. Past that, the ones without a time that nobody
  mentioned for the longest go into memory as facts ("This sat untouched for a while, so I
  put it in memory: …"); **Not done yet** brings one back.

Settings → Open loops lists what is open, with the next time of each, and what closed
recently. A loop pirc opened from something it read (a search, later an email) is marked as
such, and never counts as your word for anything it does.

pirc does not yet speak up by itself when a time comes (that is the self-wake still to
come): for now a time closes its loop, waits for you, or moves on to the next one quietly.
