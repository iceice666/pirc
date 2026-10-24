# Rooms, faces, memory, open loops, workers and sources

[User guides](README.md) · [Memory reference](../architecture/memory.md)

pirc lives in the gateway and talks with you in rooms. This guide covers what it keeps
between conversations. The reference has the exact rules and routes.

## Rooms

`#general` always exists; make a room per topic if you like. Messages you send close
together are answered as one batch a few seconds after you stop typing (Cmd+Enter sends
at once). Every device sees the same rooms. What you were writing stays in each room until
you send it, even across reloads.

Archived rooms are folded under the room list. The bell in a room's header mutes it on
this device only: no notifications from it here, while your phone keeps its own choice
(Settings → Notifications lists the muted rooms). On a phone the bottom tabs lead to the
rooms, the members, the engine and Settings.

The **Engine** (`/engine`, at the foot of the room list) is what runs behind the rooms:
the computers pirc works on and what each can do, the brain's recent turns per room, open
loops, wakes, memory and sources, and every worker's session, read-only. Lines in a room
link to the matching page with **Details**; a thread links to its worker's session.

Keyboard: arrows move through the room list; Tab into the messages and use the arrows (Home,
End) to read them one by one; Alt+Up/Down opens the previous or next room; Escape closes a
thread or the member list.

## Faces

pirc is one mind with several faces. **pirc**, the host, is always there and answers in
`#general` and in every room nobody else has. A project can have a face of its own ("make
SlimeOS a lead", or **Add** in the member list): its name, who it is, how it talks, what it
does, the rooms it answers in, the workspaces it is about and the sources it watches. Every
message shows which face said it; they share one memory.

Who answers: the face you name with `@` (type `@` for a list), else the one that spoke
last in the room, else the room's own face, else pirc. The host may hand something over
and the project's face answers in the same turn; faces never chat with each other.

The **Members** button beside the room lists the faces and what each is doing (thinking,
working on something, waiting for your answer). Click one, or a face's name on a message,
for its page: change anything there and it applies from its next reply; see the loops it
holds and what it did lately. pirc's own page also holds `SOUL.md`, `CHAT.md` and your
preferences. **Archive** a face when its project is done: it stays in the list, greyed
out, until you **Hide** it, and answers nowhere.

Ask pirc and it does the same from a room, on your own words there: make a room,
archive one or bring it back (nothing is deleted; it never archives the room it is
answering in), and change a face's name, bio, tone, role, rooms, workspaces, sources or
archive it. It suggests a face when a project or a topic keeps coming back, and makes
one only once you agree.

When a conversation in one room keeps going about something another room covers (15
messages or more), pirc asks once that day whether to continue there; say yes and it moves,
with the open loops of that conversation and a copy of what was said about it: the new room
shows the messages as a quote — who said it, when, their words and the names of any files —
while the old room keeps every message and still takes new ones. The copy keeps the newest
50 messages (up to 20,000 characters, a longer message cut at 4,000) and says how many older
ones did not fit; files are named, never copied.

## Memory

pirc keeps two kinds of memory about you, and shows a small line in the room each time it
writes one:

- **Preferences** ("replies in Traditional Chinese") are always on its mind. It saves one
  only when you say so or say yes when it offers.
- **Facts** ("uses TLP for power management") are kept without asking and brought up when
  what you say touches them.

**Don't keep** on the line, or "forget that", forgets it for real. The engine's Memory page
lists both; your preferences are also on pirc's own page.

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

The engine's Open loops page lists what is open, with the next time of each, and what closed
recently. A loop pirc opened from something it read (a search, an email) is marked as
such, and never counts as your word for anything it does.

## When pirc speaks up by itself

pirc wakes up on its own when an open loop's time comes, the day before a deadline,
when it said it would come back to something ("I'll look at your dotfiles tonight"), and
when one of your [sources](#sources) has something new that matters. Awake,
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

The engine's Wakes page lists what is coming and how recent wakes went.

## Sources

pirc can read your mail, your calendars, Moodle and your repositories' commits. Add them in
Settings → Models & sources:

- **Email**: Gmail with an [app password](https://myaccount.google.com/apppasswords)
  (2-Step Verification must be on), or another IMAP mailbox. pirc only reads; nothing is
  marked read.
- **Calendar**: an ICS address (Google Calendar's "Secret address in iCal format", Moodle's
  calendar export) or a CalDAV calendar.
- **Moodle**: your school's Moodle address with your user name and password, the way the
  Moodle app signs in; only the token Moodle gives back is kept. If your school signs in on
  another page, choose the app login and paste back the `moodlemobile://…` address it ends at.
- **Workspace**: a repository; once a day pirc looks at its new commits.

Adding one tries it first. pirc reads mail every 5 minutes, calendars every 15, Moodle every
hour. Most of what it sees it only keeps (you can ask "did Prof. Lin write about HW3?"); it
wakes up for something new only when it touches one of your open loops ("HW3 extended to
Friday" when HW3 is open), or when the room follows the source: the **feed icon** in a room's
header lists your sources, and a room that follows one hears of everything new in it. You can
also just say "follow my school mail here". **Pause** stops pirc reading a source at all;
**Read now** reads it at once; **What it saw** lists what it kept.

What a source says is never your word: an email can say anything. pirc may remind you of it
and remember it (the memory line says it came from the source), but it does nothing because an
email said so. Passwords, tokens and calendar addresses stay on your gateway and are never
shown again; to change one, use **Sign in again**. If a source cannot be read three times in a
row, pirc says so once in the room.

## Workers

Ask pirc for work in one of your repositories ("run the tests in pirc") and it calls a
worker: a coding agent with its own session in that workspace. It does not ask first. The
room shows **I asked a worker to: …** with its status (**Working**, **Asking you**,
**Done**) and a **Thread** where you can follow what the worker does, its helpers
(indented), and answer its questions; a line in the room tells you when it asks
something. While it works, its message shows what it is doing right now, and a question
still waiting for you stays above the composer. Say something in the thread to steer it, or
to give a finished worker more to do; **Stop** ends it. When it ends, pirc says in the room how it went, with a
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
