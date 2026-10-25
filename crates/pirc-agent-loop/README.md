# pirc-agent-loop — host-driven checkpoint

Unpublished, runtime-neutral state machine using `pirc-llm-types` messages.
Implementation baseline: `eb45f71d8fdefb35a796704ebd9ba7accdf098ff`.

## Scope, honestly

This is the **state-machine checkpoint**, not the completed extraction of
`pirc-agent::Agent::run`. It is executable progression logic, not only a trait.
No provider, tool, project, sandbox, policy, session storage or authority is
embedded in this crate.

The production agent drives its run through this core via a thin adapter,
`crates/pirc-agent/src/run_loop.rs`: each model call takes a ticket, the final
reply goes through `finish_model`, tool calls are taken from the validated
`Step::Tools` batch and each result is fenced by its call key, an overflow
compaction is `ReplaceHistory`, and the run ends in an explicit terminal state.
The adapter emits and writes nothing. Its core history is a record of the run,
**not** the request context: requests are still built from the session store,
and the adapter drops each `ModelRequest` at once, so the history is never
copied per request (only once when an overflow compaction hands it back).
Where the core is stricter than the agent, the agent's behavior wins (rejected
call ids still run, unfenced, and the reply is kept with `supersede`; an
interrupted reply supersedes its request instead of cancelling; retries stay
inside the agent's `stream`, so the core only sees final attempts and never
`Recovery::Retry`).

The adapter also feeds the core each streamed delta (`stream_start`,
`stream_delta`), and the core builds the attempt's partial reply itself
(`Partial`): only block boundaries change it (`*Start`, and `*End`, which
carries the block's whole content), so the partial lags at most the block
being streamed, no delta is copied and the host copies nothing per delta; a
retry restarts the partial, and tool-call arguments stay empty until the call
ends.
Waits of the running checked call use independent `begin_wait`/`finish_wait` tokens:
dialogs (`Approval` inside the auto-mode gate, otherwise `Other("dialog")`)
and the write lease (`Resource`). A wait is the call's when the waiting
future runs in the call's task, or carries the id of the call or of one of its
`ptc` operations; work of no call (other tasks, no operation) is not
labelled. Progress and waits are bookkeeping: the agent reads neither, and one
the core refuses is dropped rather than failing the run.

The source inventory for this checkpoint was the production agent's `stream`
and `run` implementations. The existing host still owns all of the following;
the adapter has not moved or changed them:

- before-end persistence preceding message_end, panel event ordering;
- role fallback, retry classification/backoff, redaction and remote Node routing;
- sequential production tool execution, validation/hooks/approval/write leases;
- admission/steering/team queues, features, context preparation and compaction;
- completion waits, budgets, session recovery and host cancellation signals.

The integration gate is the pirc adapter plus unchanged agent and
pirc-conformance event traces; fake tests alone do not meet it.
`crates/pirc-conformance/tests/agent_loop_order.rs` records the production
ordering this gate protects: persistence before `message_end` (and no
`message_end` when persistence fails), serial tool calls with send-now/abort
interruption records, retry/fallback/exhaustion events around unpersisted
attempts, and at most one overflow compaction per run. Completion waits are
covered by the team scenarios; the `completionWaitMs` timeout path and the
auto-mode gate's approval/lease waits are covered by adapter tests in
`crates/pirc-agent/src/agent/tests.rs`.
In particular, accepting parallel results here does not switch pirc tools to
parallel scheduling or grant permission to run them.

## Effect/resume contract

1. Create `Loop` with a host generation and initial history. `advance` admits
   input at Idle and returns one `Step::Model`. Host constructs the prompt/tools,
   chooses its adapter and performs I/O; core holds no credentials or callbacks.
   The request's messages share the core's history (`Arc`, copied on write only
   while a request is still held when the history grows), so a host that builds
   its context elsewhere and drops the request copies nothing.
2. While streaming, either give the core the attempt's skeleton and its ordered
   deltas (`stream_start`, `stream_delta`) and let it build the partial at
   block boundaries (`Partial`), or supply ordered `Progress` deltas **with
   full snapshots** you built yourself. Partials retain usage and are not
   appended repeatedly to history.
3. `finish_model` consumes a canonical final reply. Tools are emitted only on
   successful ToolUse, never on progressive partials/error/aborted responses.
   Empty/duplicate provider IDs within one batch fail atomically. Provider IDs
   are preserved; opaque model tickets plus call indexes correlate each effect.
4. Host validates/approves/dispatches tools. It may label a pending call with an
   approval/resource wait without recording a failure or reissuing the effect.
   Use `begin_wait`/`finish_wait` for independently endable overlapping reasons
   (`wait_tool`/`end_wait` keep a separate compatibility slot).
   `resume_tool` accepts one terminal result per call in any order. Only after
   all results does it return the next model effect; history is always call-order.
   Denied/interrupted/failed/unknown statuses are retained in `tool_records` and
   mapped to error results in neutral message history (`ToolOutcome::message`;
   `ToolOutcome::not_run` is the outcome of a call its host never ran).
5. A successful non-tool reply returns Idle, **not Done**. The host can deliver
   more input or call `complete` after its own feature/completion checks.
6. Failure suspends with typed reason/retry hint, raw error and optional partial
   reply/usage retained in `failures`. `Failure::of_reply` classifies an error
   reply by its message (`is_retryable`, `is_context_overflow`): a class, not
   a decision. No automatic retry, sleep or compaction occurs. Explicit retry
   refuses partial content or unknown outcomes; overflow recovery accepts
   host-compacted history. Host remains responsible for retry budgets, safe
   retry classification, error masking and progress publication.
7. `cancel` is terminal/idempotent and returns operations the host must abort.
   Suspended errors/partials stay in failure records. `rebind` requires a strictly
   greater generation, invalidates in-flight work, appends a trusted host notice,
   and returns Idle without silently restarting. Old callbacks/resumes cannot
   produce new tool effects. Already completed parallel outcomes are retained;
   unresolved ones become **Unknown**, never a claim that side effects rolled back.
   `supersede` instead settles a streaming request with a host-kept reply
   (recorded as given, replacing the partial, issuing no tools) and fences the
   old ticket with a strictly greater generation.

The `history` module is the provider-facing repair of a message history
(`project`): each tool-use reply is followed by its results in order, a call
without one gets an interrupted error result, and orphan results and calls of
no tool-use reply are dropped. Calls are paired by occurrence (`Pairing`), so a
provider may reuse an id after a completed group. It reads messages only; a
host with a richer journal (pirc's `ptc` operations) pairs through it and adds
its own evidence.

Tickets are scoped to one live core instance. They are not durable globally unique
IDs. This core has no restart protocol, journal or exactly-once external effect
guarantee. Hosts must not mix callbacks from different instances. The host must
check ticket generation **immediately before effect dispatch**, deliver aborts and
coordinate mount/lock revocation itself. A state machine fence cannot revoke an
already-open file descriptor, undo an effect, or close a network request on its own.
Do not persist and blindly replay returned `Step` values.

## Overlapping waits

`begin_wait(key, reason)` returns an opaque, cloneable `WaitToken`;
`finish_wait(&token)` ends exactly that wait. Ending one of several approvals
(or two identical resource reasons) cannot erase the others. Foreign, stale or
already-ended tokens return false, including tokens from another live loop
with identical call keys. Results and invalidation clean up the call's waits.
Dropping the token alone does not finish it; an async host may wrap it in its
own RAII guard, as the pirc adapter does.

`waiting_all()` exposes every overlapping reason in call/creation order;
`waiting()` preserves the latest-reason-per-call view. The older
`wait_tool`/`end_wait` API manages one separate compatibility slot and cannot
erase tokenized waits. None of these APIs approves or dispatches anything.

## History rewriting without a memory backend

`history::Rewrite` replaces one range in an `Arc<Vec<Message>>` snapshot with
messages supplied by the host. A host may insert retrieved context, replace
older turns with a summary, or use a sliding window; OM is not a dependency.
The core does not retrieve, summarize, choose retention policy, or store memory.
The result is context, never a new permission or a provenance guarantee.

- `history_snapshot()` supplies the exact immutable basis. `rewrite_history`
  accepts it only at Idle and starts no work. Stale/foreign snapshots fail even
  if their messages compare equal. Failed rewrites leave all state unchanged.
- `history::safe_boundaries` validates complete tool groups. Range endpoints
  (including insertions) cannot cut between an assistant call batch and any of
  its results. Source and candidate are checked strictly: orphan, duplicate
  active, empty or unresolved call IDs and calls outside ToolUse are refused,
  rather than silently repaired. IDs may be reused after completion.
- The final `resume_tool` immediately emits another model request. Intercept
  it **before dispatch** and use `rewrite_request(ticket, plan)` to receive a
  replacement request. Discard the old effect: its exact ticket is fenced,
  although generation is unchanged. Check `is_current_model(ticket)` immediately
  before dispatch, alongside the host's own authority checks.
- A stream with `stream_start` or `progress` is refused. Absence of a partial
  does not prove no I/O started: pre-dispatch is a host assertion. For actual
  in-flight changes, cancel I/O and use `rebind`; a ticket cannot undo effects.
- Tool records and failure records are not rewritten, replayed or erased.

`history::replace_prefix` is the separate, lazy metadata-preserving projection
primitive for richer journals. It deliberately performs **no** tool validation:
its host must choose/validate the cut and may retain existing provider repair.
Pirc uses it in `SessionStore::context_entries_of` after validating handoffs;
summary construction, original entry IDs, OM compatibility, storage and later
`history::project` repair stay host-owned. Core rewrite APIs do not change
pirc's request context by themselves: its adapter history is still a run record.

Run `cargo run -p pirc-agent-loop --example memory` for a memory-backend-free
consumer showing overlapping waits, retrieval insertion before a tool
continuation, and an Idle summary without an automatic restart. The model is
fake, and memory text is supplied explicitly by that host.

## Local and Send consumers

There is deliberately no boxed callback trait with unconditional Send bounds.
The pure reducer is callable synchronously from any async host, with explicit
owned input/output boundaries. The local example holds Rc/RefCell across awaits
and runs via spawn_local. The separate Send example moves its reducer and adapter
future into tokio::spawn on a multithread runtime. Tokio is dev-only; normal
consumers require no runtime. These proofs do not assert production event parity.

Both examples use fake model adapters. The current `pirc-llm::Transport::run`
callback still requires `Send`, and its variable resolver requires `Sync`; an
`Rc<RefCell<_>>`-capturing live transport callback is therefore not supported.
The local example proves the reducer boundary only, not a live non-Send provider
adapter. A future integration must resolve and test that separate boundary.

```sh
cargo test -p pirc-agent-loop
cargo run -p pirc-agent-loop --example local
cargo run -p pirc-agent-loop --example send
cargo run -p pirc-agent-loop --example memory
cargo clippy -p pirc-agent-loop --all-targets -- -D warnings
```

The tests exercise model/tool round trips, progressive snapshots, the
core-built partial and its attempt restarts, blocked/denied results, parallel
call correlation/order, duplicate/stale resume rejection, streaming/tool-wait
generation changes, ending waits, superseded streams, suspended/streaming
cancellation, partial usage/errors, error classification, history repair,
explicit retry/overflow handoff, and Idle versus terminal Done.
