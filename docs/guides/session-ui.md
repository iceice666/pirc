# Session navigation and activity

[User guides](README.md) · [All documentation](../README.md)

Shared web/Android behavior from the completed UI redesign of 2026-09-29, implemented in `4ce2c40`, `4a3e46f` and `ea76001`. The original design source was `遠端助手UI設計改進.zip` (`pirc Redesign.dc.html`, options 2a–2d); mock screenshots were local `.pirc/tmp/ui/` artifacts, not product requirements. See also the [Android client](../../apps/android/README.md).

## Chat, Work, and Needs you

Chat contains assistant projects and chats (workspaces whose [mode](modes.md) has `assistant: full`), without engineering run/lease/jobs chips. Work contains every other workspace, listed by device, with sessions grouped as Needs you, Running and Recent; panels and settings follow each mode's capabilities. **Add workspace** picks a device, then one of the modes it accepts when there is more than one, and asks for a path only for modes that work in a directory. Desktop web has a remembered Chat/Work sidebar switch (only Work without a chat node); phones use bottom tabs Chat / Work / Schedules / Settings. Work shows a Needs-you badge. Android opens on Chat; web phones open the list unless a session URL is selected, and sessions have a back action.

Needs you collects waiting sessions (Reply), missed schedules (Allow & run / Dismiss), and memory proposals (Approve / Reject, with text opening memory settings). Delegation and schedule proposals appear as sessions waiting for Reply: approving them directly from the inbox would require the control lease. It is not a separate Settings badge inbox.

Recent places pinned sessions first, has Show done and workspace filtering, and folds repeated runs of one schedule into an expandable row. Work's desktop footer links Schedules and Settings. Schedules are a main page rather than a Settings subpage, and have their own phone tab. A schedule targeting Chat still produces a chat; schedule management is reached from Work.

Scheduled sessions carry a clock/origin indicator and a header link to their schedule. Delegated sessions carry their own origin indicator and link to the initiating chat. Chat headers omit jobs and the control pill.

## Writes and run cards

Blocked writes fail immediately: they are not queued or retried. A sidebar lock marks only a lease holder, not the blocked session. The failed tool card names and links to the holder. There is no waiting-for-write-lease subtitle or composer lease banner; the broker's authority/coordination policy remains unchanged by these UI affordances.

Web run cards fold two or more consecutive tool-only turns, or one message with at least two tools. Collapsed cards show a generic title, count, duration, file chips and status; failures start expanded. Android also provides run cards and write-block/origin links. Model-written card titles from the mock were not implemented. Rows do not show a two-line current-tool preview because the list API supplies no preview text.

## Editing messages and conversation versions

Web and Android support editing your own messages in both Chat and Work. Once a session is idle and you hold control, choose **Edit message**, change the text, then **Save and regenerate**. Cancel leaves the conversation unchanged; a failed save keeps the draft available for correction or retry. Existing image attachments are retained.

Saving creates a new conversation version at that message and asks the assistant to answer the revised text. It does not overwrite the original message or its replies. Use the previous/next version buttons beside a user message to return to another version and its latest continuation. Switching versions does not make a model request, and the selected conversation survives reconnects and runner restarts.

Only the selected version's conversation context is used for subsequent replies. Editing and switching are unavailable during active runs or pending work, or without session control. **Neither operation undoes tool effects**: files, shell commands, external actions, and shared memory already changed by the agent remain changed. In coding sessions, review the working tree before regenerating a request that may repeat an operation.

## Activity transport

The redesign introduced node protocol 7 activity messages:

```ts
{ sessions: [{ id, run?, writeLease? }] }
```

Each message lists every session with an open run (queued, running, waiting_input or stopping) or a write lease. Nodes publish after registration and coalesce run/lease change notifications within 100 ms (`GatewayDatabase.onRunsChanged`, `WriteBroker.onChange`). The daemon holds this node activity in memory and clears it on disconnect; its own run table does not establish live state for node sessions.

`GET /api/sessions` exposes live `runStatus`, lease-holder `writeLease`, and `origin` from schedule/delegation records:

- schedule: `{kind:'schedule', scheduleId, title, dueAt}`;
- delegation: `{kind:'delegation', delegationId, title, fromSessionId}`.

The events WebSocket opt-in `sessions=1` emits `sessions_changed` outside a session's event sequence when runs, leases or session names change. Web uses these updates while a session is open, plus a 60-second poll. Android's recorded implementation polls. The regression anchor is the `event_stream` conformance test in `crates/pirc-conformance/tests/events.rs` (snapshot `events__event_stream.snap`); pure web work/grouping helpers and Android Work helpers have corresponding unit tests. This documentation migration does not itself establish fresh runtime validation.

## Scope and remaining work

The mock's overlapping file pane and competing composer designs were historical design questions, not outstanding product tasks. Current mobile gaps belong to the [mobile follow-ups](../../plans/mobile.md); platform validation and Android distribution/polish decisions belong to the [backlog](../../plans/README.md). This reference preserves built behavior and known design deviations without authorizing new UI work.
