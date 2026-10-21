# Calendar

[User guides](README.md) · [Schedules and notifications](schedules.md)

The Web and native Android Calendar combines **personal events** and **Agent
tasks**. Switch between Month, Week, Day and List. Personal events never run an
agent. List keeps the existing schedule editor, run history, Run now,
pause/resume, missed-run approval and Open session actions.

## Personal events

New defaults to a personal event. Choose Agent task explicitly to create an
existing workspace schedule. Personal events have a title, description,
location, start/end, event time zone, all-day dates, recurrence and optional
reminders. An all-day end date is exclusive: October 20 to October 23 covers
October 20, 21 and 22.

The selected display time zone does not reschedule events or tasks. Timed events
are displayed in that zone; an all-day event retains its calendar dates. General
recurrence supports daily, weekly, monthly and yearly rules, an interval,
optional final date/count, and selected weekly weekdays (Sunday is 0). A missing
month day is skipped: January 31 repeats next on March 31, not February 28.
Leap-day yearly events repeat in leap years. Local times in a DST gap move
forward; overlapping wall times choose the first instant. These rules match the
Gateway scheduler's time-zone resolver.

Edit/delete scope is explicit for repeating events: this occurrence, this and
following, or the whole series. A moved occurrence keeps its original identity;
cancelling it does not create a second event. Splits are atomic, preserve the
remaining repetition count and carry applicable single-occurrence exceptions.
Changing a whole series' starting time, time zone or recurrence resets its
previous exceptions. A concurrent edit returns a conflict with the current
version; the client keeps the draft for review.

## Agent access

Calendar's **Agent calendar access** settings have independent **read** and
**propose changes** grants. Both start disabled. The schedule capability and
Full access command mode do not grant access to private events. Gateway-owned
workspace feature/tool restrictions still apply; a repository cannot change the
grants. Reading or changing an existing event requires read access too.

The `calendar` tool can query a range, read an event and propose creating,
editing or deleting one. Every change needs a confirmation in its originating
chat, including proposals from unattended tasks. The card shows the current and
proposed dates, zone, recurrence/scope, reminders and details. Approval checks
the current revision, permissions and expiry again. Confirming the same card on
two devices applies it once. `proposal_result` reports applied, rejected,
expired or stale results; a pending proposal is not a saved event.

## Notifications and synchronization

Personal reminders use the existing encrypted Web Push / Android UnifiedPush
subscriptions and open the selected calendar occurrence. Delivery is Gateway
owned; an offline phone does not schedule its own local alarms. The Gateway
scans every 30 seconds. Each due occurrence/reminder is recorded before an
asynchronous delivery attempt, so restart cannot resend a backlog. With no
subscription, no reminder is claimed. After downtime, an event that has not
ended may still receive a reminder; ended events are skipped. Delivery attempts
are not proof that a remote device displayed the notification.

Calendar changes reuse the existing owner-scoped `schedules_changed` hint. Both
clients reconcile through authoritative reads; after a connection/mutation
failure, a creation retry keeps its idempotency key. The display can retain the
last loaded range and an open draft while offline; writes require the Gateway.
True remote UnifiedPush delivery remains an explicit device acceptance step.

## Storage and API

Gateway schema 1006 adds events, exceptions, permissions, proposals and reminder
delivery records. Existing databases migrate in order; back up before starting
the new Gateway. There is no node database migration or protocol bump. Personal
events belong to the user, independent of a workspace/project. Deleting a chat
removes its pending proposals, while already approved events remain personal
calendar entries. Deleting an event removes its body/overrides; an opaque request
identity prevents delayed creation retries from restoring it; the original
content hash is cleared on deletion too.

- `GET /api/calendar?from=<epoch-ms>&to=<epoch-ms>&timezone=<IANA>` reads a UTC
  `[from,to)` range of up to 93 days. Expansion happens on the Gateway.
- `POST /api/calendar/events` accepts `{idempotencyKey,event}`.
- `GET /api/calendar/events/:id` reads a personal event.
- `PATCH /api/calendar/events/:id` accepts
  `{revision,event,scope,occurrence?}`; DELETE accepts
  `{revision,scope,occurrence?}`. `occurrence` is the original local start.
- `GET/PATCH /api/calendar/permissions` uses `{allowRead,allowPropose}`.
- `GET /api/calendar/context` returns an opaque account preference namespace and
  whether a push subscription is available. The namespace is not a credential.

Responses contain at most 256 items and an explicit `limited` / `nextCursor`.
Use that cursor with the same range/zone to read more; no agent is started by a
calendar query. Agent task previews have no invented duration. Past task items
come from retained run records, not from today's edited cron rule. New automatic
runs share their forecast identity, manual runs remain distinct and legacy runs
are not guessed to be manual or automatic. `historyLimited` reminds clients that
older task runs may already have been pruned by the existing retention policy.

The initial limits are 1000 active event series per user, 1000 exceptions per
series, 366 days per event and up to five reminders (0 to 30 days before start).
There is no external calendar sync, invitation or shared/team calendar yet.
