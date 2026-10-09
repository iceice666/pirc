# Gateway runtime M4 continuation: mixed transport and lifecycle recovery

Status: **M4 remains in progress, not accepted for cutover.** This continuation
builds on [the WIP record](m4-in-progress.md); it does not turn scaffolding or
skipped checks into completed product parity. All changes remain opt-in.

## Implemented continuation

- Reverse central RPC is demultiplexed through the authenticated Environment
  WebSocket, with bounded concurrent admissions, closed result validation,
  original-ID status retrieval and cancellation. Handlers admit work without
  holding the flow receiver, so control/status traffic can progress.
- Mixed scripts retain the original inner intent for deduplication while carrying
  separately schema-checked node hook-final arguments. The node executor applies
  the shared local policy chain, including pre/post hooks, write-slot acquisition
  after rewrites and the refusal latch. Preflight/central/post phase facts are
  durably recorded by the node supervisor before their respective work.
- Central database mutations and results share the gateway inner journal's
  transaction. The gateway checks the authoritative outer manifest, binding,
  descriptor/policy and immutable final arguments. A duplicate cannot create a
  second effect. Lost replies reconcile original inner IDs; scripts are not replayed.
- Control cancellation that overtakes data is remembered in bounded binding-scoped
  tombstones. A cancellation completion waits for gateway work to settle; timeout
  or lost central outcome faults the node executor rather than letting a caught
  script cancellation release its write slot and continue.
- Child-supplied central results must agree with supervisor evidence. A started,
  unresolved central phase cannot be reported as completed or not started.
- Gateway team children receive a bound broker callback (not a model-supplied caller
  identity). Parent-only stop rules remain enforced. Team records/tasks/latest
  snapshots can restore without starting a child; interrupted task ownership is
  released back to pending. Cancellation after delayed provisioning is checked
  before configure/prompt dispatch.
- Node descriptors explicitly advertise lifecycle hook presence. Gateway
  sessionStart/beforePrompt/agentSettled calls run through journaled node executor
  operations with stable IDs, cancellation and bounded deadlines. Authoritative
  phase obligations/results persist before dispatch/ACK and remain status-recoverable.
  Known context is reused from the authority after node result reclamation.
- Direct gateway core tools (including `web_search`) have an opt-in central service
  path using the same authorization/hooks/durable operation registry as PTC. Direct
  output projection is deterministic across start/status, contains tool-result
  content, and fences web content. Active handlers remain nonterminal until they
  drain; cancellation cannot clear the original admission obligation. Active and
  absolute budgets use the shared budget helper.
- Assistant memory adapters reuse existing MemoryStore tables on the exact shared
  operation/authority SQLite connection. USER proposals remain pending and require
  authoritative quoted user messages; peer/tool text cannot create approval.
  Observational memory now reuses the validated observer/reflector/dropper ledger,
  prompts and tools in the admitted gateway model loop. Explicit observer model and
  fallback choices are supported with per-candidate authorization and conservative
  context/output estimates; only successful stop/tool-use replies can settle worker
  work, never token-truncated output or turn-budget exhaustion. Provider request
  failures seal their auxiliary receipt before fallback. Exact tokenizer/backend
  output-limit acceptance is not claimed. OM provider/quota failures
  do not interrupt successful main work; generic compaction remains the fallback
  unless the actual recorded observer coverage exactly reaches the discarded prefix.
  Workspace memory has a node-owned fresh-source ledger, repository attestation,
  owner-filtered frozen snapshot and explicit promotion callback. Prepared promotion
  batches now persist all validated proposals before the first node append, retaining
  original operation/marker IDs across authority restart and lost replies. The node
  records effect and hashed receipt in one flushed ledger line under its lock;
  cleared/forgotten/legacy sources terminate without resurrecting or adopting evidence.
  Successful selections mark all considered candidates independently of promoted
  provenance, avoiding first-page starvation. Model-driven selection and fresh
  assistant mirroring integration remain open.
- History gains bounded PTC operation projections. An experimental client snapshot
  uses newest bounded history, durable latest-run state and the actual outbox
  watermark; its route is disabled by default until live interactions and event
  compatibility are complete. No historical sandbox admission is presented as
  current gateway-loop containment.

## Independent review fixes

Two bounded review rounds covered mixed transport. Findings fixed:

| Priority | Finding                                                                    | Resolution                                                    |
| -------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| P1       | Cancellation could overtake admission and be lost                          | Bounded binding-qualified tombstones, checked before dispatch |
| P1       | Local request cancellation was mistaken for remote effect drain            | Completion handshake; unknown/timeout fences executor         |
| P1       | Child could forge a central success or replace verified central evidence   | Compare normalized result against supervisor phase evidence   |
| P1       | Child cancellation could still release the write slot before central drain | Fail/kill on inner result while central phase is running      |

Separate lifecycle/team review identified missing node cancellation, invisible
lifecycle obligations, unreclaimable in-progress tasks and late child prompts
following cancelled provisioning. These were corrected with tests. A later
projection review found cached lifecycle output/ACK recovery needed to survive
node tombstones, unknown-effect predicates needed to agree between admission and
recovery, and pre-aborted hooks must not persist unqueryable obligations. The
continuation fixes those paths; the crash-after-persist-before-node-admission
window remains conservatively unresolved rather than presumed side-effect-free.

## Verification evidence and limits

- Authenticated mixed integration (fake-srt by default; opt-in real embedded srt) verifies original arguments versus
  rewritten final arguments, a single central transaction, intentionally lost
  reply, executor fencing, original-ID central status and inner unknown refinement.
  Fake-srt is functional/recovery evidence, not OS containment evidence. Linux real
  embedded-srt mixed/subprocess run passed **13 tests / 1 delegated-cgroup skip /
  0 failures**, 63 assertions; the mixed executor itself used real containment.
- New focused continuation regressions validate workspace prepared-batch recovery
  through a reopened authority database, lost replies/forgetting, legacy/clear
  suppression, exact goal leases and rollback, service-queue restart/configuration
  dedup, cancellation during configuration and five simultaneous preparations.
  Darwin durable-delivery/lifecycle run passed **14 tests / 88 assertions**, and
  the latest Linux native suite passed **11 tests / 40 assertions**. Darwin
  configured-memory fallback/truncation/context regressions passed **5 tests /
  20 assertions**; partial observations preceding a truncated reply are not
  committed as complete coverage. Darwin's
  strengthened CPU-bound parent-death/resource regressions passed **4 tests /
  11 assertions**. Legacy schedule/delegation integration was re-run from its
  required `apps/gateway` cwd under the compatibility namespace: **16 tests /
  225 assertions / 0 failures** (earlier wrong-cwd fixture runs failed to find
  their relative `test/fixtures/fake-pi.mjs`; they are not acceptance evidence).
- Subprocess regressions cover hook rewrites/refusal, cancellation with a held
  central operation, lifecycle phases, ten local dependent reads, browser taint,
  background ownership and shutdown.
- A later synchronized macOS continuation suite passed **14 tests / 0 failures**,
  75 assertions (`continuation_macos_status=0`), covering native guest, gateway
  runtime child ask/reply, real-srt mixed transport, direct central lifecycle,
  memory adapters, lifecycle recovery and bounded history paging.
- macOS arm64 native worker build and actual launcher tests passed **7 tests,
  28 assertions**, covering dependent batch/store, 40 quick broker replies,
  prototype-poisoning idle forgery and runaway cancellation.
- macOS focused Environment/mixed/central-link run passed **16 tests / 1 delegated
  cgroup skip / 0 failures**, 70 assertions. The ten-read and containment fixture
  used real embedded srt; that initial mixed authenticated fixture still used
  fake-srt. A follow-up opt-in real-srt macOS mixed fixture then passed **1 test /
  19 assertions**, `real_mixed_macos_status=0`. The node's unrelated legacy fixture
  runner logs fake-srt; the separately prepared mixed Environment executor used
  embedded srt.
- macOS full `bun run check` passed on a synchronized checkpoint: **1128 gateway
  tests / 160 skipped / 0 failures**, **284 Web tests**, **121 compiled-role tests**,
  typechecks/format/builds (`full_macos_check_status=0`). Native opt-ins remain
  separately recorded above; the full check's skips are not native acceptance.
- Latest Linux full `bun run check` passed: **1132 gateway tests / 177 skipped /
  0 failures**, **284 Web tests**, **121 compiled-role tests**, version/format,
  gateway/Web typechecks and builds. Logs remain in the coordinating session. Runs performed while source was
  being edited are not treated as final acceptance. The documented outer shell/PID
  namespace only supplies host compatibility; it is not isolation evidence.
- The maintainer chose to run Android verification separately rather than install
  an SDK here. No Android unit-test/APK/device acceptance is claimed. Handoff:

```sh
# JDK 21 and an already licensed Android SDK with platform 37 required.
export ANDROID_HOME=/path/to/android-sdk
cd apps/android
./gradlew --no-configuration-cache testDebugUnitTest assembleDebug
```

## Remaining gates

Complete product-service acceptance (fresh workspace mirroring and model-driven
selection, full memory-model acceptance, schedule/delegation durable
delivery product/global-capacity acceptance, complete goal continuation), real gateway-child/team
policy inheritance and end-to-end recovery,
live interaction/operation tree projections and client history paging remain.
The new host composition binds direct/PTC services, shared central memory and
general questions; trusted service turns retain custom-message provenance rather
than being promoted to user messages. Existing schedule/delegation services now
accept an explicit RuntimeDispatch injection; absent it, production routing remains
unchanged. The fresh adapter checks original SessionRow identity (no legacy remap),
persists bounded FIFO service deliveries with immutable owner/binding/branch and
configuration before returning admission. Shared global/session reservations precede
claim/configuration; busy/offline rows stay queued. Restart resumes only unclaimed
rows; claimed admissions reconcile original runs or become interrupted without
replaying configuration/lifecycle. Cancellation fences reserved configuration, and
trusted configuration uses token-scoped model/thinking changes. Exact service-turn
progress and opt-in daemon startup/periodic checks report pre-run failures. Repeated
delegation notices use monotonic revisions and revision-checked acknowledgments.
Focused queue restart/capacity tests pass; complete product installation, global
capacity and service permission acceptance remain open. Branch goal/todo state now has an authority-backed transactional snapshot path;
a selected-boundary fork inherits the corresponding snapshot (regression tested).
Goal runtime continuation now uses a distinct trusted service turn, process-local
exact writer-binding/branch/goal arming, post-transaction committed callbacks and
restart disarming. Dedicated regressions verify rollback preserves arming,
active-disarmed resume succeeds, and forged writer/fork leases cannot consume rounds;
complete fallback/multi-child/runtime continuation acceptance remains open.
General-question answer ingress requires a separately authenticated control-lease
callback and never shares the node approval namespace. Team provisioning now
carries selected model/thinking explicitly, and shared-database startup recovery
is fenced once per database object so child hosts cannot interrupt live parent runs.

Web/Android snapshot readers now follow bounded gateway history cursors; Android
compilation remains the explicit human handoff. Scheduler progress reads durable
service identities/run-scoped model answers instead of only the latest 32 entries.
Workspace legacy recall refuses gateway-source items rather than opening legacy
JSONL. Forgotten content is rejected under the node ledger lock.

Focused native acceptance now additionally tests eight-worker admission/refill,
RSS rejection, admitted allocation-loop failure/timeout slot release, and actual
CPU-bound guest disappearance after a disposable supervisor SIGKILL (no stdin-EOF
explanation), on Linux and macOS. These do not prove exact heap OOM/default RSS
thresholds, mixed worker quota or a fence-disabled negative control.

Ordinary gateway builds now require and build the pinned native PTC worker rather
than silently omitting it; portable Darwin release staging includes every worker
asset, license and provenance. Full native hostile-worker/resource/parent-death
coverage, Nix package execution and portable release archive acceptance remain
distinct from passing syntax/build checks and focused tests. Native sidecar notices
cover wasm3 and embedded QuickJS/quickjs-emscripten; real Darwin worker/role dylib
inspection passed the Apple-only dependency gate. The Nix evaluation/dry-run passed
using a disposable copy of tracked plus nonignored WIP files, but the actual package
build timed out while provisioning fixed-output dependencies; no Nix installation
acceptance is claimed. No production routing,
writer adoption, data migration/deletion or cutover is authorized by this record.
