# pirc pots and reusable Rust foundations

[Plans](README.md) · [Unified conversations](unified-conversations.md) · [Modes](modes.md) · [Checkpoints](checkpoints.md)

Status: integrated research/design proposal, 2026-10-24. The user requested
analysis of a supplied library-extraction handoff together with Chat/Work
unification and pirc pots. Only planning/documentation is authorized. No crate,
runtime, transport, permission, deployment or UI change is implemented here.
Crate names and API sketches in the handoff remain proposals, not approvals.
On 2026-10-24 the user accepted the specification-review recommendations as the
planning baseline: staged delivery, compatibility/failure gates, unified product
tasks and preservation of pirc-owned authority boundaries. See the
[accepted decisions](unified-conversations.md#accepted-specification-review-recommendations-2026-10-24).
This settles the recommended direction, not final Rust signatures, feature/API
choices that were only listed as questions, implementation or publication.

The accepted follow-up is detailed in [Conversation execution contracts](conversation-execution-contracts.md):
capability composition, one foreground response flow with attributed parallel
tasks, and project-grant removal versus an explicit conversation folder block.
These remain pirc host responsibilities. A generic loop must expose cancel/resume
and correlated results so the host can reject obsolete work; it must not decide
user-message targets, create resource grants or silently restart stopped tasks.
Items 4–7 are recorded in the [main plan](unified-conversations.md#accepted-follow-up-behavior-and-detailed-contracts-2026-10-24).

## Combined direction

The product should have one conversation/work experience, project-mounted
resources, explicit tasks for substantial work, and **pirc pots**, a persistent
personal assistant that observes, suggests and coordinates within configured
permissions. Reusable crates supply model I/O and a small execution loop; pirc
continues to own projects, tasks, permissions, scheduling and client interaction.

| Layer                       | Responsibility                                                                    | Must remain separate from                                                         |
| --------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Web / App                   | Conversation, project, task and pots views; commands and decision UI              | Provider credentials, authority decisions and background scheduling               |
| Gateway / pirc coordination | Identity, resource grants, task/decision records, pots dispatch and notifications | Generic transport/loop internals                                                  |
| Node / pirc agent host      | Mounts, sandbox, tools, write coordination, features, memory and checkpoints      | Frontend presence or a privileged generic loop                                    |
| Reusable loop               | Model/tool progression, cancellation and explicit suspension points               | Project membership, pots identity, approval policy, storage and notifications     |
| Reusable LLM layer          | Provider request/stream mechanics and optional OAuth flows                        | pirc settings files, Node identities, environment loading and global TLS mutation |

Keep the existing inference route when extracting: agent → Node's authenticated
Unix socket → Gateway → provider. Sharing a crate must not give project agents
provider secrets, make the App call providers directly or bypass Gateway policy.
A Node-side loop can use the existing remote adapter; standalone consumers can
supply a direct model adapter.

## Product requirements clarified by the user

The following are requested design requirements, not implementation approval:

- Configure a conversation workspace at creation. Mount selected existing
  folders, or explicitly create an empty folder under a configured server area.
- A project behaves like an organizational folder and shares one or several
  mounted folders and configuration/rule files with its conversations.
- Leaving the project removes its project-derived mounts and content access.
  Separately granted folder access remains disclosed; an explicit conversation
  folder block overrides overlapping grants and must be enforced by the host.
- Explore a project board/shared memory to help agents communicate and understand
  concurrent work, especially another agent holding a conflicting write lease.
- Recommend tasks for most complex work; long/background and multi-agent work
  should normally require tracked tasks and visible progress.
- pots can observe allowed information and conversation progress, offer opinions,
  and dispatch instructions after user authorization. Its messages must be marked
  as originating from pots, with permissions configurable in settings.
- App connection security is deferred for a separate design discussion. Flutter
  Web remains an evaluation option.

Detailed journeys and pending decisions are in [Unified conversations](unified-conversations.md).
The user subsequently selected **A** on 2026-10-24: preserve existing conversation
context after project departure and stop project-derived mounts/new access.
The accepted follow-up separately discloses retained independent folder grants.
During an active run, warn first; if the user proceeds, enforce revocation of subsequent
access and notify the agent of the user-initiated change. The agent can decide
whether it needs to ask a follow-up question. These product behaviors are decided;
OS revocation/rebuild and offline-host acknowledgement remain technical design.
Unmounting does not erase retained information or undo completed writes, and a
communication board does not itself prevent concurrent filesystem writes.

## Reference capabilities: dots and Grok Bot

Official sources checked 2026-10-24 at the user's request. These describe external
product behavior; the pirc choices below are our proposals, not their internals.

- [OpenAI dots](https://learn.chatgpt.com/docs/dots): ongoing responsibility across
  conversations, background work, remembered context, delegated tasks and results
  or decisions brought back to the user. This supports a persistent pots identity
  with separate task contexts rather than one unlimited mixed transcript.
- [Dots controls](https://learn.chatgpt.com/docs/dots/controls): proactive research
  is read-only; later actions follow instructions, permissions and approval rules.
  Use this distinction when defining pots observation and dispatch grants.
- [Grok Bot](https://docs.x.ai/grok-bot/overview): persistent execution resources,
  parallel agents, direct handoffs and work continuing when clients are closed.
  Its documented shared computer/browser model is not a requirement for pirc;
  project mounts, private state and browser access retain explicit boundaries.

Proposed pots first scope: one personal assistant identity, task-specific threads,
scoped observation, event/scheduled wake-ups, durable suggestions, quiet digests,
explicitly attributed dispatch and user takeover. Voice, external messaging
channels, multiple named assistants and full computer-use capability are possible
later scope decisions, not implied by these references.

A persistent responsibility is distinct from a task: for example, "watch this
project for blocked work" can have bounded ongoing observation, while each
accepted repair becomes a task with a finish condition. Both need pause/revoke
controls, budgets and durable wake-up state. An always-on service need not keep
an LLM generating continuously. Required Gateway and execution Nodes still need
to be online; closing Web/App must not own their lifetime.

## Library handoff: findings checked against this checkout

Handoff baseline: main `aca6eeb` (0.9.3). Reviewed local head before this update:
`1aed8533`; no remote fetch or runtime test was performed for this design pass.
The reported line counts and third-party crate versions were not remeasured.

Confirmed in the current sources:

- Workspace Rust 2024, MSRV 1.97, `publish = false`, `unsafe_code = forbid`.
- `pirc-providers/src/inference.rs` routes six transport implementations. Both
  pi-style and native paths are selected by existing configuration.
- Inference currently reads `PI_CACHE_RETENTION`, installs the default ring TLS
  provider and derives a cache/session identifier from Node, session and provider.
  Error masking belongs to the pirc integration boundary.
- `models_file.rs` calls `pirc_config::env_allowlist::is_secret_env`; settings,
  discovery/catalog integration and environment policy need not enter the library.
- The agent uses local futures and `Rc`/`RefCell`; its loop mixes persistence,
  compaction, retries, feature hooks and event ordering. Generic extraction is a
  more substantial change than relocating provider modules.

### Corrections to resolve before implementing the handoff

1. **Keep a lightweight dependency graph.** `pirc-protocol` currently needs only
   data/serialization dependencies (plus its existing Linux socket support).
   Re-exporting Provider/Model from an HTTP/OAuth-heavy `pirc-llm` would pull that
   layer into every protocol consumer unless features are carefully separated.
   Recommend pure shared metadata/types at the leaf; endpoint/credential runtime
   configuration in the LLM layer; pirc wire envelopes in `pirc-protocol`.
   Exact Provider/Model placement remains a decision, not a settled move.
2. **The whole inference/models files are not generic types.** `InferenceRequest`
   carries pirc session routing; `Models.inference` and `InferenceConfig` contain
   the private Node socket. `ThinkingLevel` and serde's `opaque::present` helper
   are additional dependencies to classify. Preserve the distinction between a
   missing field and an explicit null. Common types may be re-exported; pirc
   envelopes stay and adapt without changing old wire bytes.
3. **OAuth is not just moving `flows.rs`.** It imports backend `Credentials`,
   `catalog_models`, sibling domain/base-URL helpers and callback-server handling.
   Separate credential DTOs from persistence; inject optional post-login discovery
   and presentation/callback adapters. Model-provider OAuth is unrelated to the
   user's sign-in to the pirc App.
4. **The Send sketch is internally inconsistent.** A `Send + Sync` Transport
   returning `BoxFuture` with a Send callback does not serve the existing local
   agent's non-Send callback/state unchanged. Evaluate a minimal model-source
   interface with local and Send adapters or generic conditional bounds first.
   Do not adopt trait-variant or change runtime scheduling before a small proof
   and an event-order comparison. Send capability does not itself prove ordering.
5. **Specify suspension and resume, not only `next()`.** The proposed five Steps
   omit how to submit approval/tool results, streaming progress, cancellation,
   parallel call correlation and terminal completion. Distinguish idle from done,
   and blocked tools from failed tools. A resume must not execute a tool twice.
   Approval, lock and mount-revocation policy live in the pirc host; a generic
   tool request/result boundary may be cleaner than building pirc policy into
   the core. Host-originated environment changes must be deliverable while a
   run is waiting/streaming, with denied/interrupted results correlated to calls;
   do not let loop resume replay effects under an obsolete workspace generation.
6. **Retain failure information without leaking it.** Preserve partial replies,
   cancellation and structured retry/error reasons in the generic interface.
   The pirc adapter can retain `StopReason::Error` wire behavior and redact errors
   before they reach clients. Do not make raw provider errors safe by assumption.
7. **Compatibility helpers need classification.** JS-like coercion needed for
   existing provider bytes may stay in a private compatibility module initially.
   Host microtask scheduling and pirc config truthiness stay outside the core.
   Deleting every JS-named helper during the move would conflict with parity.
8. **TLS remains an explicit contract.** Inject a configured client/provider or
   use a documented explicit construction path; library construction must not
   install global crypto state. Retain the recently added distrust regression
   and the actual production verifier behavior after changing ownership.

Root license selection remains an owner decision before any external publication;
preserve existing attribution/notices when moving source. No public release is
part of this plan. Verify dependency APIs and candidate crate versions separately
if they are selected; the supplied ecosystem comparisons are not acceptance proof.

## Proposed extraction boundary

Working names, pending confirmation:

| Crate / adapter              | Proposed contents                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pirc-llm-types`             | Pure messages, deltas, tool schemas, stop/error metadata and required neutral value types; ordered serde compatibility          |
| `pirc-llm`                   | Six existing transports initially, HTTP/SSE/parsing, explicit cache settings, injected credentials/client; optional OAuth       |
| `pirc-agent-loop`            | Small model/tool state machine with host-controlled effect/resume boundaries; no pirc session, task board or UI dependencies    |
| Existing `pirc-providers`    | Gateway backend storage, catalogs/configuration, environment policy, cache identity derivation and safe error adaptation        |
| Existing `pirc-agent` / Node | Remote inference adapter, features, memory, team/task integration, scheduling compatibility, sandbox/tools and checkpoint hooks |

OAuth off by default and one feature per wire API are recommendations from the
handoff, not yet confirmed. Test the intended feature combinations individually:
workspace feature unification can hide missing optional dependencies. Preserve
pi/native route selection until fixture comparisons justify a separate change.

A product task can contain many loop runs. pots can coordinate many product
tasks. Neither belongs inside the reusable loop, and neither requires the loop
extraction to be finished before its product behavior can be designed.

## API specification still needed before crate extraction

The handoff and boundary table identify code ownership, but they do not yet define
a callable library contract. Complete this review alongside the product
[specification gaps](unified-conversations.md#specification-review-what-is-not-detailed-enough-2026-10-24).
All signatures/names remain to be proposed; adding a trait alone is not completion.

| Boundary                  | Questions the specification must answer                                                                                         | Required proof                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Shared types              | Which fields are generic; wire-only wrappers; absent/null; ordered JSON; metadata versus endpoint credentials                   | Old fixtures serialize identically; no dependency cycle or unintended HTTP/OAuth in protocol consumers                        |
| Model adapter             | Request ownership/lifetimes; delta versus partial snapshot callbacks; final reply consistency; backpressure; cancellation owner | Partial, canceled and malformed streams behave predictably without duplicate final messages                                   |
| Errors/retries            | Typed failure categories; partial usage; retryability; masking boundary; behavior after an effect may have occurred             | pirc keeps existing wire/errors; raw credentials/provider responses are not leaked; unknown outcomes are not replayed blindly |
| Loop suspension           | Stable call IDs; one/many tools; concurrent results; approval/lock waits; continuation input; terminal reason                   | Duplicate/stale resume is refused; suspended work cancels; idle and completed remain distinguishable                          |
| Host policy changes       | How revocation/stop notices interrupt work; grant-generation checks; preserving conversation on host restart                    | An in-flight old model reply cannot execute a removed-resource tool after rebinding                                           |
| Scheduling/runtime        | Local and Send requirements; callback bounds; spawn/runtime assumptions; effect ordering                                        | Existing local adapter compiles and preserves conformance; Send consumer works without changing pirc scheduling               |
| OAuth/client construction | HTTP/TLS ownership; browser/callback presentation; credential refresh/cancel; callback cleanup; optional discovery              | Local synthetic flow tests; no global provider installation, unexpected listeners or credential persistence in the library    |
| Packaging                 | Feature dependency matrix; public exports; internal compatibility helpers; MSRV and notice retention                            | Build intended feature sets independently, including default-off OAuth; path dependencies remain unpublished                  |

Adopted design sequence: inventory existing request/result/event shapes;
write a minimal local-adapter example and a separate Send-use example as proposed
contracts; define suspension/resume state transitions; then, only when authorized,
implement fake-adapter proofs before moving the full agent loop. Generic-loop
persistence should expose state/effect boundaries the host can journal, without
owning pirc session files or promising exactly-once arbitrary tool effects.

For each extraction change, record the baseline revision and exact fixtures/gates.
Do not approve deduplication of native/pi transports merely because happy-path
answers look alike. Compare request headers/body, cache identity, reasoning/tool
stream semantics, aborts, usage and error behavior separately. Public API names,
type ownership and local/Send strategy need a review; the user does not need to
choose implementation-level boxing or lock algorithms.

## Combined delivery sequence — adopted direction, no implementation authorization

| Stage                          | Deliverable                                                                                                   | Dependencies / gate                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A. Specify adopted contracts   | Project mounts, departure/revocation, workspace switching, task identity, board/wait protocol, pots authority | Complete remaining contracts/settings in Unified conversations; only planning now       |
| B1. Provider extraction        | Pure types, compatible adapters, then transport and optional OAuth separation                                 | Owner settles names/type placement; isolate this refactor from product behavior changes |
| B2. Product foundations        | Versioned workspace bindings, mount enforcement, durable tasks/decisions, independent-client state            | Stage A; can use the existing agent loop and provider adapter                           |
| C. Unified workflow            | Same-conversation work, project resources, meaningful waiting/progress, Web/App contract parity               | Mount transitions, replay prevention and concurrent-writer acceptance                   |
| D. pots                        | Overview and attributed dispatch, then scoped proactive observation/digests                                   | Tasks, provenance, grants, durable wake-ups and notification reconciliation             |
| E. Loop extraction             | Fake-adapter core, pirc integration and event-order/conformance checks                                        | Stable provider boundary plus understood tool-wait/approval/cancel semantics            |
| F. Optional frontend migration | Flutter Web comparison against current Web on difficult interactions                                          | Separate decision after measurement; not a dependency of App independence               |

B1/B2 are independent work streams in planning; this does not authorize spawning
agents or changing both at once. Keep integration checkpoints small so a provider
regression can be distinguished from a workspace/task migration regression.
App authentication/connection security remains a separate design gate; APIs and
state flows can be specified now, but no new listener or public port is implied.

## Acceptance gates for later implementation

- **Types:** existing decode/round-trip tests plus fixed serialized bytes, field
  ordering, omitted/null fields, enum tags, old session fixtures and tool-schema
  insertion order. Re-exporting a type alone is not byte-compatibility proof.
- **Provider/OAuth:** existing inference/parity/TLS/backend/flow tests; both routing
  paths; canceled and partial streams; cache IDs; redacted errors; feature matrix;
  no direct environment reads or global TLS installation in the new library.
  Inspect transitive client/environment behavior too, not only a grep result.
- **Loop:** fake model tool round trip, progressive deltas, refusal/resume, waiting
  for resources, cancellation while suspended, tool ordering/IDs, overflow handoff,
  retries, completion and no duplicate side effects. Then existing agent tests and
  pirc-conformance with unchanged event ordering.
- **Workspace/project:** multi-root aliases and overlap, revoked mounts, leaving
  while tools/children run, stale queues, unavailable Node, crashes mid-transition,
  project rules and memory access, retained conversation context (decision A),
  cancelable warnings, trusted agent notifications, open-descriptor revocation,
  partial-command effects, old approval rejection and historical/copy limitations.
  No forced user question, silent remount or retargeted retry after removal.
- **Collaboration:** A holds a file, B waits with owner/reason visible, no busy
  polling or false completion; release wakes B; B rereads before editing; cyclic
  waits and stopped owners resolve without forcing unsafe lock expiry.
- **pots and clients:** actor provenance cannot be forged by prompt text; narrowed
  grants remain narrowed through delegation; user takeover fences queued dispatch;
  duplicate approvals, missed push and closed Web do not replay work.
- Run workspace tests and clippy at each actual extraction checkpoint, plus the
  focused compatibility gates. Nix verification remains waived as previously
  requested; physical-device/remote-push limitations are not silently cleared.
  Clean disposable test/build outputs after actual runs.

No tests, builds, OAuth logins, deployments or prototype execution were performed
for this documentation update. Existing checkpoints, memory and App behavior have
not been changed by writing this plan.
