# pirc-agent-loop — host-driven checkpoint

Unpublished, runtime-neutral state machine using `pirc-llm-types` messages.
Implementation baseline: `eb45f71d8fdefb35a796704ebd9ba7accdf098ff`.

## Scope, honestly

This is the **fake-adapter/state-machine checkpoint**, not the completed extraction
of `pirc-agent::Agent::run`. It is executable progression logic, not only a trait,
but the production agent does **not** depend on it yet. No provider, tool, project,
sandbox, policy, session storage or authority is embedded in this crate.

The source inventory for this checkpoint was the production agent's `stream`
and `run` implementations. The existing host owns all of the following, and
this checkpoint intentionally has not moved or changed them:

- before-end persistence preceding message_end, panel/microtask event ordering;
- role fallback, retry classification/backoff, redaction and remote Node routing;
- sequential production tool execution, validation/hooks/approval/write leases;
- admission/steering/team queues, features, context preparation and compaction;
- completion waits, budgets, session recovery and host cancellation signals.

The future integration gate is an explicit pirc adapter plus unchanged agent and
pirc-conformance event traces. Passing fake tests alone does not meet that gate.
In particular, accepting parallel results here does not switch pirc tools to
parallel scheduling or grant permission to run them.

## Effect/resume contract

1. Create `Loop` with a host generation and initial history. `advance` admits
   input at Idle and returns one `Step::Model`. Host constructs the prompt/tools,
   chooses its adapter and performs I/O; core holds no credentials or callbacks.
2. Supply ordered `Progress` deltas **and full snapshots** while streaming. The
   adapter owns their consistency; core does not implement provider delta parsing.
   Snapshots retain partial usage and are not appended repeatedly to history.
3. `finish_model` consumes a canonical final reply. Tools are emitted only on
   successful ToolUse, never on progressive partials/error/aborted responses.
   Empty/duplicate provider IDs within one batch fail atomically. Provider IDs
   are preserved; opaque model tickets plus call indexes correlate each effect.
4. Host validates/approves/dispatches tools. It may label a pending call with an
   approval/resource wait without recording a failure or reissuing the effect.
   `resume_tool` accepts one terminal result per call in any order. Only after
   all results does it return the next model effect; history is always call-order.
   Denied/interrupted/failed/unknown statuses are retained in `tool_records` and
   mapped to error results in neutral message history.
5. A successful non-tool reply returns Idle, **not Done**. The host can deliver
   more input or call `complete` after its own feature/completion checks.
6. Failure suspends with typed reason/retry hint, raw error and optional partial
   reply/usage retained in `failures`. No automatic retry, sleep or compaction
   occurs. Explicit retry refuses partial content or unknown outcomes; overflow
   recovery accepts host-compacted history. Host remains responsible for retry
   budgets, safe retry classification, error masking and progress publication.
7. `cancel` is terminal/idempotent and returns operations the host must abort.
   Suspended errors/partials stay in failure records. `rebind` requires a strictly
   greater generation, invalidates in-flight work, appends a trusted host notice,
   and returns Idle without silently restarting. Old callbacks/resumes cannot
   produce new tool effects. Already completed parallel outcomes are retained;
   unresolved ones become **Unknown**, never a claim that side effects rolled back.

Tickets are scoped to one live core instance. They are not durable globally unique
IDs. This core has no restart protocol, journal or exactly-once external effect
guarantee. Hosts must not mix callbacks from different instances. The host must
check ticket generation **immediately before effect dispatch**, deliver aborts and
coordinate mount/lock revocation itself. A state machine fence cannot revoke an
already-open file descriptor, undo an effect, or close a network request on its own.
Do not persist and blindly replay returned `Step` values.

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
cargo clippy -p pirc-agent-loop --all-targets -- -D warnings
```

The tests exercise model/tool round trips, progressive snapshots, blocked/denied
results, parallel call correlation/order, duplicate/stale resume rejection,
streaming/tool-wait generation changes, suspended/streaming cancellation, partial
usage/errors, explicit retry/overflow handoff, and Idle versus terminal Done.
