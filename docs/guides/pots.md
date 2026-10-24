# pots: bounded progress suggestions and tracking

[User guides](README.md) · [Library boundaries](../architecture/reusable-llm.md) · [Remaining plan](../../plans/pots-and-library-extraction.md)

## Current checkpoint

pots has a personal, owner-scoped overview, responsibilities, a durable suggestion
inbox and tracking-only tasks. The Web sidebar and native Android navigation open
**pots**. Both clients have locally tested tracking-only views; APK installation,
physical-device and push acceptance remain open. These are locally implemented staged changes, not a
deployment or a completed autonomous assistant.

**Automatic execution is unavailable.** The overview reports
`executionAvailable: false`. The Web shows **Start unavailable**; calling the
Start API returns `503` / `not_ready` without creating an execution session or
marking a task running. Configuring a dispatch budget or resuming coordination
does not change this.

## Configure and explicitly activate

1. Enter a purpose and select the workspaces to observe. There is no implicit
   “all workspaces” grant. Select between 1 and 32 distinct available workspaces.
2. Supply all three finite limits. Nothing omitted means unlimited:
   - **Observation budget:** 1–1,000,000 distinct sourced issues, over the
     responsibility's lifetime.
   - **Dispatch budget:** 0–1,000,000. Zero records that dispatch is disabled;
     positive values still cannot enable execution in this checkpoint.
   - **Concurrency limit:** 1–32. This is recorded configuration, not a running
     worker pool. There are no background model workers in this checkpoint.
3. Choose **Save disabled responsibility**. Saving does not begin observation.
4. Review the selected scopes and limits, then choose **Activate observation**.
   Observation and coordination are separate controls; coordination starts paused.

Only **session progress events** are supported. A currently authorized pending
interaction may produce the generic suggestion **Session needs your input**.
Ordinary tool progress stays quiet. pots does not read transcripts, inspect files,
call a model, answer an interaction or synthesize a repair plan through this flow.
Purpose text describes the responsibility; it is not a new execution grant.

Budgets do not reset when you pause, disable, resume, refresh or restart Gateway.
A repeated issue, delivery retry or reconnect does not spend another observation.
Overlapping responsibilities share one issue; its first recorded responsibility
owns the provenance and quota charge. At exhaustion, new items are skipped without
model calls, fallback spending or interrupting unrelated sessions. Used/configured
counts remain visible. There is no automatic replenishment or budget-edit/reset
operation in this checkpoint.

## Reading, deciding and tracking are different

| Action                         | Current effect                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Open pots or read a suggestion | Read the authoritative record; no acceptance, takeover or dispatch.                                                        |
| Review source conversation     | Navigate to the existing source session; its normal access checks still apply.                                             |
| Dismiss                        | Keep that occurrence quiet. A replay cannot restore it to pending.                                                         |
| Snooze                         | Persist a chosen wake time. Web currently offers one hour. It does not dispatch or automatically accept when time elapses. |
| Track only                     | Atomically create/link one canonical task for the suggestion, without an execution session or run.                         |
| Start                          | Unavailable; the API returns `503 not_ready`.                                                                              |

Two devices tracking the same current suggestion, even with different command IDs
or a lost response, receive the same canonical task. A stale revision instead
requires refreshing and reviewing the current record; the client does not silently
retry a changed decision. A tracking task records its immutable originating
suggestion and accepted action/target separately from its owner and optional
execution-session binding. In this checkpoint that binding remains empty.

Snooze is not a freshness extension. While snoozed, Track is blocked until the
chosen time; afterwards the source, binding and expiry are still checked. An
expired or answered request, or a runner lifecycle change, makes an unlinked
suggestion `superseded`; a linked suggestion becomes `needs_refresh`. This does
not complete its task, revive dismissed work or claim the original issue remains
current.

## Controls have different scopes

| Control                                    | What changes                                                          | What does not change                                                         |
| ------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Pause observation / Disable responsibility | Stop new observations and evidence refreshes for that responsibility. | Existing records are not erased; independent sessions are not stopped.       |
| Pause coordination                         | Persist a fence against future pots coordination in that scope.       | It is not an observation pause, and no dispatcher exists here to start/stop. |
| Resume observation / coordination          | Change the corresponding durable control.                             | Do not replenish budgets, replay suppressed events or restart stopped tasks. |
| Take over task                             | Fence that task's pots coordination with a new control generation.    | Do not kill tools, complete the task or take over another task.              |
| Stop tracking                              | Mark the tracking task stopped and fence its coordination.            | Do not cancel or kill the pre-existing source conversation's runner.         |

Taking over or stopping one task does not affect unrelated responsibilities or
tasks. Resuming coordination elsewhere cannot release a takeover. There is no
implicit resume of a stopped/taken-over task.

## Privacy and freshness

Suggestion evidence stores identifiers and revisions only: workspace, source
session, interaction ID, Gateway binding epoch and expiry. No source transcript,
interaction prompt, session title or model-written instructions are copied into
pots. The **From pots** attribution is a host-created record, not authority that a
board post, prompt or client-supplied label can forge. There is no REST endpoint
for injecting an observation or suggestion.

Gateway checks current workspace availability/private visibility, source-session
ownership and its current binding when ingesting, listing, opening or accepting
sourced items. Removed/deleting/checking workspaces and unavailable/foreign sources
cannot supply actionable suggestions. Unauthorized records are hidden as 404;
lists omit inaccessible sourced suggestions/tasks rather than expose previews.
Expiry is checked on reads and acceptance, without requiring a browser timer.
Reconnect refreshes the same occurrence only through a newly authorized host event;
it preserves dismissal, snooze and task links and cannot extend the old expiry.

Records and controls persist in Gateway SQLite while clients are closed. Web
refreshes on opening/focus and after commands and offers explicit Refresh. Android
uses the existing paired transport, refreshes on resume and clears records/drafts
on re-pairing or account changes; late replies cannot restore the old account.
Neither client persists pots snapshots in a client data cache; responses use no-store. This is
not a claim of mobile push reconciliation, offline execution or deletion of old
backups/copies.

## Limits and remaining work

Each owner has at most **100 responsibilities, 100 suggestions and 100 linked
tasks**; list requests are capped at 100. There is no cursor pagination, automatic
retention or deletion/reset workflow yet. A full suggestion inbox stops new issue
creation without spending extra quota. Historical records remain part of that cap.

Still absent: transcript/content observation grants, periodic or model-driven
analysis, digests and dedicated pots push delivery, standing execution grants,
attributed dispatch, first-Start session mapping, worker cancellation/reconciliation,
and the full P7 cross-client/runtime acceptance cases. Real browser/device journeys
still require verification; synthetic Web/backend/Android tests do not close those
gaps. Local browser acceptance was blocked by the operator setting
`PIRC_BROWSER_ALLOW_PRIVATE`; no alternate route was used.

## Verification at this checkpoint

Local focused verification passed `cargo test -p pirc-gateway pots::`: 22 tests
(19 store, 2 HTTP/host tests and a 1009-to-1010 migration test). Coverage includes persistent controls/reopen,
concurrent acceptance/create/quota reservations, rollback on insert/link failures,
strict input rejection, owner hiding, source revocation/expiry, overlapping-scope
and reconnect deduplication, and no execution session on tracking/Start.
Gateway-only strict clippy passed with `--all-targets --no-deps -- -D warnings`.
The enclosing Gateway suite also passed all 178 tests, including the additional
1009-to-1010 migration regression. These focused passes do not imply a clean full
workspace or executable-conformance gate.

Web verification passed 61 test files / 436 tests, including 14 pots cases,
Svelte check (zero errors/warnings), production build and formatting. The build
retains the existing large-chunk warning. Android verification passed 31 focused
and existing regression tests (11 new pots tests), including phone/tablet widget
layouts, pairing/account fences and no POST replay; changed-file analysis and
formatting passed. These are widget tests, not pixel/screenshot or installed-APK
acceptance. No live-provider login, pots dispatch,
physical-device acceptance, deployment or crate publication is established here.
