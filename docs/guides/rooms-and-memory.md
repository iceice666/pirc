# Rooms, memory, open loops and workers

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
  deadline closes itself once its time passes and pirc has said so; a repeating one ends at
  its last date.
- **Undo.** **Don't keep** on "Holding on to: …" closes it; **Not done yet** on a closing
  line opens it again. Saying it works too.
- **Too many.** pirc keeps at most 40 open. Past that, the ones without a time that nobody
  mentioned for the longest go into memory as facts ("This sat untouched for a while, so I
  put it in memory: …"); **Not done yet** brings one back.

Settings → Open loops lists what is open, with the next time of each, and what closed
recently. A loop pirc opened from something it read (a search, later an email) is marked as
such, and never counts as your word for anything it does.

## When pirc speaks up by itself

pirc wakes up on its own when an open loop's time comes, the day before a deadline, and
when it said it would come back to something ("I'll look at your dotfiles tonight"). Awake,
it only reads and remembers: it never does anything for you that you did not ask for. It
says something in the room, with a notification, only when it is worth saying: a loop's
time always, the day before a deadline too, a look it took only when it found something.
Otherwise nothing shows in the room. Your house rules (`CHAT.md`) and preferences can
change when it speaks up.

- **"I'll come back … to look at: …"** in a room means it scheduled a look; **Cancel**
  calls it off.
- If you write while it is awake, you come first: it stops, answers you, and comes back
  once afterwards.
- It wakes at most 24 times a day (your gateway may set another number). Past that, a
  loop's time is still said, as "Reminder: …", without pirc thinking about it.

Settings → Wakes lists what is coming and how recent wakes went.

## Workers

Ask pirc for work in one of your repositories ("run the tests in pirc") and it calls a
worker: a coding agent with its own session in that workspace. It does not ask first. The
room shows **I asked a worker to: …** with its status (**Working**, **Asking you**,
**Done**) and a **Thread** where you can follow what the worker does, its helpers
(indented), and answer its questions; a line in the room tells you when it asks
something. Say something in the thread to steer it, or to give a finished worker more to
do; **Stop** ends it. When it ends, pirc says in the room how it went, with a
notification. At most four work at once; the others wait their turn, and a worker whose
computer is offline waits for it. Only the person a worker works for (whose words called
it) can answer, steer or stop it. Workers pirc calls while awake only look, never change
anything. Each worker's session is also in the engine.

A worker asks before two things only: sending something out (a push, a pull request, a
publish, a message) and leaving its sandbox. Those questions appear in the room itself
with **Yes**, **Allow again this session** and **No**, and a notification; you can also
just answer in words ("yes, push it"), and pirc passes your answer on. Everything else it
does and reports; some things (deleting outside its workspace, credentials, system
settings) it is never allowed. Work that belongs to no repository goes to a fresh scratch
directory on a computer that suits it ("on the mac", one with a GPU, an idle one). To
just look at a repository ("what does the README say?") pirc reads it itself, without a
worker.
