# UI redesign (turn 2: 2a–2d)

Status (2026-09-29): built on gateway, web and Android (see "As built" at the end). Not committed yet.

Source: the design zip `遠端助手UI設計改進.zip` (`pirc Redesign.dc.html`, options 2a–2d).
Screenshots of 2a–2d are in `.pirc/tmp/ui/`.

Scope: web and Android together.

## Decisions

### Chat / Work modes

- Chat is the existing chat workspace: its chats and projects. The main area shows no engineering chips (run, lease, jobs).
- Work is every other workspace. The sidebar is grouped by state: Needs you, Running, Recent.
- Desktop: a segmented Chat / Work switch at the top of the sidebar.
- Phone: bottom tabs only, with no top segmented switch. The tabs are **Chat / Work / Schedules / Settings**. The app opens on Chat. Work has a red dot showing the Needs-you count.

### Write lease

- Blocked writes are **not** retried or queued. The node's broker keeps refusing at once (`node/runner.ts` `grantWrite`), and the UI only makes the failure clear.
- A lock icon appears only on the sidebar rows of sessions that **hold** a lease. A blocked session gets no sidebar mark.
- The failed tool card says it was blocked by session X and links to X.
- Removed from the design: the "waiting for write lease" row subtitle and the lease status above the composer.
- Backend work: add an event exposing which roots each session currently holds (`node/write-broker.ts` `leases()`). The lease is held until the run ends.

### Run cards

- Tool calls from one assistant turn collapse into one card. The collapsed card shows the title, tool count, duration, status and file chips.
- Failed cards start expanded.

### Needs you (one inbox)

Each item has inline actions:

- Missed schedule runs: Allow & run, Dismiss.
- Runs waiting for input: Reply.
- Delegation and schedule proposals: Approve, Reject.
- Memory proposals: Review.

The Settings badge goes away. Needs you is the one place for everything waiting on the user.

### Schedules

- They move out of Settings.
- Desktop: a Schedules entry at the bottom of the Work sidebar, above Settings, with a line showing the next run. It opens the schedule list and run history in the main area.
- Phone: its own bottom tab.
- A session started by a schedule has a clock icon and the schedule title as its subtitle. Its header has a chip ("Scheduled · <title> · #n") that links back to the schedule.
- In Recent, repeated runs of one schedule collapse into one row ("<title> · n runs"), which expands to show each run.
- Chat mode: a schedule that targets a chat still produces a chat, shown with a clock icon. Schedules are managed only from Work.

### Delegations

- A delegated session gets its own icon and a link back to the chat that started it.

## Open issues in the mock

- In 2a, the file pane covers the chat column. 2b does not have this problem.
- The area above the composer differs between 2a and 2b (goal/todo progress vs. lease status). With the lease status removed, keep goal/todo.

## As built

### Gateway

- Node protocol 7. The node sends `activity` messages: `{ sessions: [{ id, run?, writeLease? }] }`. Each message lists every session that has an open run (queued, running, waiting_input or stopping) or holds a write lease. The node sends it after registering, and again, merged, within 100 ms of each change. The change hooks are `GatewayDatabase.onRunsChanged` and `WriteBroker.onChange`.
- The daemon keeps this activity in memory for each node and clears it when the node disconnects. Before this, `GET /api/sessions` had no live run status for node sessions: the daemon's own runs table is empty for them.
- `GET /api/sessions` adds three things:
  - `runStatus` is now live.
  - `writeLease: true` when the session holds a lease.
  - `origin`, from `schedule_runs` and `delegations` (`GatewayDatabase.sessionOrigins`):
    - `{kind:'schedule', scheduleId, title, dueAt}`
    - `{kind:'delegation', delegationId, title, fromSessionId}`
- The events WS takes `sessions=1`. It then sends `sessions_changed` (outside the session's sequence) when a run starts or ends, a lease changes, or the agent renames a session.
- Test: `test/session-activity.integration.test.ts`.

### Web

- `lib/work.ts` holds pure helpers, tested in `work.test.ts`: work grouping, Recent folding, write-block parsing and holder lookup, timeline run grouping, and run summaries.
- The sidebar (`Sidebar.svelte`) has a Chat / Work switch, remembered as layout `workMode`. Without a chat node there is only Work.
  - Chat: Projects (expandable, each with its chats) and Chats.
  - Work:
    - Needs you: waiting sessions (Reply), missed runs (Allow & run / Dismiss), memory proposals (Approve / Reject; the text opens Settings → Memory).
    - Running.
    - Recent: pinned first; "Show done" toggle; runs of one schedule folded.
    - A workspace filter popover (all / a node / a workspace, with "writing" marks and Add workspace).
    - Footer: Schedules (showing the next run) and Settings.
  - Rows: a clock or forward icon for the origin, a lock only on lease holders, and a workspace chip.
- Schedules is a main-column page (`SchedulesPage.svelte`, wrapping `ScheduleSettings`). It was removed from Settings. Schedule notifications open it.
- Phone: `MobileTabs.svelte` gives bottom tabs Chat / Work (badge) / Schedules / Settings.
  - The list is a full page, and the app opens on it unless `?session=` is set.
  - A session is full screen, with a back chevron.
- Timeline:
  - `RunCard.svelte` folds two or more consecutive tool-only turns, or one message with two or more tools. Collapsed, it shows its title, tool count, duration, file chips and status. It starts open on failure.
  - A failed tool with the lease-refusal text shows a "Write blocked" note with a button to open the holder. There is no retry.
- Header:
  - An origin chip: "Scheduled · …" opens the schedule; "Delegated · …" opens the chat that delegated it.
  - Chat sessions hide the jobs menu and the "In control" pill.
- Session list updates come from `sessions_changed` while a session is open, plus a 60 s poll.

### Android

- `core/Work.kt` (tests in `WorkTest.kt`) and `core/AssistantMemory.kt`.
- New UI files: `ui/HomeScreen.kt` (bottom nav), `ChatTab.kt`, `WorkTab.kt`, `SettingsTab.kt` and `SessionRows.kt`. `SessionsScreen.kt` was removed.
- Run cards, the write-blocked note and the origin chip are in `session/MessageViews.kt`, `ToolCard.kt` and `SessionScreen.kt`.
- The list still polls.

### Deviations from the design

- Inbox items for delegation and schedule proposals are the chat session waiting for input (Reply). Answering inline would need the control lease.
- Run card titles are generic ("Made changes", "Ran commands", "Explored the code"). The design's model-written titles do not exist.
- Rows have no two-line "current tool" subtitle: the list API has no preview text.
