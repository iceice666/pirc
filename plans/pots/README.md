# pirc pots

[Plans](../README.md) · [Product design](design.md) · [Acceptance cases](acceptance.md) · [User guide](../../docs/guides/pots.md) · [Library extraction](../library-extraction.md)

**pirc pots** is the user's persistent personal assistant: one owner-scoped identity
that observes allowed progress, records sourced suggestions, tracks tasks and, only
when the user authorizes it, dispatches attributed instructions. This folder holds
the remaining pots work. Current behavior lives in the [user guide](../../docs/guides/pots.md);
the host/library boundary lives in [Reusable LLM foundations](../../docs/architecture/reusable-llm.md#unreleased-pots-execution-boundary).

| File                           | Contents                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [README.md](README.md)         | Authorization, what is delivered, known risks and the remaining work queue                             |
| [design.md](design.md)         | Adopted product design: authorities, records, observe/suggest/dispatch flow, controls, quiet operation |
| [acceptance.md](acceptance.md) | P7-1 to P7-9 acceptance cases with their current local evidence                                        |

## Authorization

This is a work queue, not authorization. The user authorized two bounded
checkpoints: progress-only tracking (2026-10-24) and explicit controlled dispatch
(2026-10-25). Neither authorizes transcript/file observation, model-driven
suggestions, periodic or autonomous work, standing execution grants, digests or
push, deployment, paid evaluation or publication. Each item in the queue below
needs its own go-ahead.

## Delivered

Both checkpoints are local implementations. Neither is deployment, device
acceptance or a finished autonomous assistant.

### 1. Tracking (`24abca5e`, shipped in v0.10.0)

- Gateway schema **1010**: owner-scoped responsibilities, a durable suggestion
  inbox and canonical tracking tasks.
- Observation needs explicit activation, 1–32 selected workspaces and three finite
  lifetime limits (observation budget, dispatch budget, concurrency). A missing
  value never means unlimited.
- Only session-progress events feed it. The single generic suggestion is
  “Session needs your input”. No model calls, transcript reads or file reads.
- Deduplication is atomic: repeated events, reconnects and overlapping
  responsibilities share one issue and charge quota once.
- Dismiss, Snooze and Track only are separate actions. Two devices tracking the
  same suggestion get one task.
- Controls are durable: pause/resume observation, pause/resume coordination,
  take over, stop. Source revocation and expiry are checked on reads and acceptance.
- Each owner has at most 100 responsibilities, 100 suggestions and 100 tasks.
- Web and native Android have overview, inbox and task views.

### 2. Explicit controlled dispatch (`d4f1efbd`, unreleased)

- Upgrade fence: Gateway schema **1011**, Node schema **2003**, Node protocol **15**.
  Back up both states and upgrade Gateway and Nodes together.
- **Start** takes a written instruction (1–20,000 UTF-8 bytes). It creates one
  dedicated execution conversation in the same workspace. Each task gets one
  dispatch for its lifetime. Start never copies the source transcript and never
  answers the source interaction.
- Gateway reserves atomically (`reserve_start_task`) and binds the session before
  Node delivery. `authorize_dispatch` rechecks authority, budgets, controls,
  evidence expiry and the source runner epoch immediately before sending.
- The instruction arrives as a host-created **From pots** message. Prompt text and
  client-supplied labels cannot mint that attribution.
- Node keeps a durable send ledger and is fail-closed **at-most-once**. A crash
  after the send claim yields `dispatch_uncertain`; nothing resends it automatically.
- Progress and the redacted, bounded outcome are recorded. Takeover fences unsent
  work. Stop ends only the dedicated session, never the source conversation.
- Restart recovery observes and cancels. It never replays Prepare/Start or revives
  stopped work.
- Web and native Android have instruction entry, execution navigation/controls,
  en/zh-TW strings and a trusted pots-dispatch timeline entry.

Verification details, including exact test counts, are in the guide's
[verification section](../../docs/guides/pots.md#explicit-execution-checkpoint-verification).
In short, the focused gates passed: Gateway 202 (46 pots), Web 452, Android 35
pots/timeline, 23 conformance cases across 7 suites, and strict clippy. The full
sandboxed Rust workspace run still fails 2 Linux Node socket-enumeration tests
(not shown to be caused by pots). Full conformance was not rerun.

## Known risks in the delivered code

These come from implementation review and should be fixed before anything is
built on top.

1. **Stop is not tied to a specific run.** The ledger binds a dedicated _session_.
   Stop calls the session-level stop (`crates/pirc-node/src/pots.rs`). If Stop
   arrives after the pots run has finished but before Gateway has reconciled it,
   it can abort ordinary user work started later in that session. Options:
   correlate Stop with the dispatched run, or refuse ordinary input in the
   dedicated session until explicit takeover. The second was discussed but not
   implemented. Today input is refused only while the instruction is prepared or
   sending.
2. **Restart reconciliation is capped.** The owner/source-scoped scan has limit 100.
   Behavior beyond that cap has not been tested.

## Remaining work queue

Roughly in dependency order. Every step needs the user's go-ahead.

1. **Close the known risks** above, with regression tests.
2. **Verification debt:** a full conformance run, real browser and Android device
   journeys for tracking and Start, and an APK install. Resolve or classify the 2
   Node socket tests outside the sandbox (requires approval).
3. **Configuration values:** concrete defaults for budgets, concurrency and depth,
   plus quiet hours and digest cadence. The policy is adopted; the numbers were
   never chosen ([design](design.md#quiet-operation-failure-and-recovery)).
4. **Inbox lifecycle:** cursor pagination, retention, and a deletion/reset or
   budget-edit workflow. Historical records currently count toward the 100 caps.
5. **Content observation grants:** per-scope read-progress versus read-content.
   This must happen before any transcript- or file-aware suggestion.
6. **Bounded proactive analysis:** event and scheduled wake-ups with budgets and
   backoff, and an observer model running on an authorized execution service. No
   continuous polling.
7. **Digests and pots push:** grouped nonurgent items, a durable inbox ahead of
   push, and stale-push reconciliation (P7-8).
8. **Dispatch scope:** standing execution grants, dispatch into an existing or
   selected conversation, cross-workspace targets, and explicit retry semantics
   for failed attempts.
9. **Full P7 acceptance:** see [acceptance.md](acceptance.md). Focused tests do not
   close any case.

Prerequisites shared with other plans: durable tasks/decisions and grant
generations from [Unified conversations](../unified-conversations.md) stages B–C,
and real resource revocation from
[Conversation execution contracts](../conversation-execution-contracts.md).
The reusable loop must stay free of pots identity, grants and storage; see
[Library extraction](../library-extraction.md#combined-direction).
