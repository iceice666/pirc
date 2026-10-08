# Gateway runtime M1: reviewed contracts and security design

Status: **M1 accepted by the maintainer, with no legacy JSONL migration. The
subsequent M2 request authorizes only its first foundation slice; remaining
implementation, production RPC activation and deployment/cutover require further
authorization**. See [M2 scope and validation](m2-foundation.md).
The maintainer reviewed this design with “LGTM” and clarified that this breaking
change does not need to migrate old JSONL records. New gateway sessions start fresh;
legacy transcripts and their derived branch/context/store state are not imported.
This does not authorize deleting old data or resetting unrelated gateway records.
No production behavior is changed. [Plan](../../../plans/gateway-agent-runtime.md)
remains authoritative; [M0](m0-baseline.md) is a component baseline, not proof of
isolation or feature parity. The initial limits below are accepted design budgets,
not measured deployment capacity. Subsequent material adjustments require review.

## 1. Inventory and responsibility boundary

Paths in this section are relative to `apps/gateway/src/`. The inventory covers
`agent/tools/index.ts`, `agent/features/index.ts`, `agent/ptc/registry.ts` and their
registered capabilities at the source baseline. Wrappers and internal observer
helpers are explicitly distinguished from model-visible capabilities. Future
registrations must declare placement; absence is a startup error, not a default
gateway execution permission. Existing roles/capabilities still filter availability.

| Capability / subsystem                                                                                                                                                                                                 | Current source                                                      | Target owner and qualification                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `read`, `write`, `edit`, `ls`, `find`, `grep`, Git via `bash`                                                                                                                                                          | `agent/tools/files.ts`, `bash.ts`                                   | Node; realpath/symlinks, final path policy and cross-session write lease. Preserve existing allowed read roots, not a new workspace-only rule.                                                   |
| `background_task` (all actions)                                                                                                                                                                                        | `agent/features/background/`                                        | Node process/job ownership; gateway holds references and UI state, never restarts jobs implicitly.                                                                                               |
| `web_fetch`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_select`, `browser_press`, `browser_wait_for`, `browser_screenshot`, `browser_tabs`, `browser_handoff`, `browser_record` | `agent/features/browser.ts`, browser service                        | Node browser/profile/network/recording ownership, including explicit human handoff.                                                                                                              |
| `sandbox_allow_domains`, `unsandboxed_bash`                                                                                                                                                                            | `agent/features/sandbox.ts`, `sandbox-channel.ts`, `node/runner.ts` | Node-only exceptions; retain always-confirm, reserved interaction namespace, cwd validation, stripped host environment and process-group cancellation. Require a healthy sandbox executor first. |
| `web_search`                                                                                                                                                                                                           | `agent/features/web-search.ts`, daemon search handler               | Gateway service; provider key remains in trusted service, not worker. Returned content remains untrusted.                                                                                        |
| `memory_note`, `memory_propose_user`, `memory_search`                                                                                                                                                                  | `agent/features/assistant/index.ts`, daemon memory handlers         | Gateway user/session memory authority; proposals retain explicit human approval. Do not confuse with workspace files.                                                                            |
| `delegate`, `delegation_status`, `schedule`                                                                                                                                                                            | assistant and schedules features, daemon handlers                   | Gateway durable scheduling/coordination; project authorization and approval remain action-specific. Child environment execution still binds to the original node.                                |
| `ask_user_question`                                                                                                                                                                                                    | `agent/features/ask-question.ts`                                    | Gateway interaction state/UI relay; a response to a general question never authorizes a node exception.                                                                                          |
| `todo`, `create_goal`, `get_goal`, `update_goal`                                                                                                                                                                       | todo/goal features                                                  | Gateway branch/session state; any verification command remains a node environment operation, not gateway shell execution.                                                                        |
| `recall`, observational memory, compaction                                                                                                                                                                             | memory and compact features                                         | Gateway transcript/branch memory and model calls. Workspace memory materialization and local indexing inputs remain node operations.                                                             |
| `agent_list`, `agent_inbox`, `agent_wait`, `agent_send`, `agent_ask`, `agent_reply`, `agent_spawn`, `agent_stop`, `subagent`, `board_read`, `board_post`, `task_list`, `task_get`, `task_create`, `task_update`        | `agent/features/team/index.ts`, `team.ts`                           | Gateway team scheduling/state; same parent/child stop/wait/ask rules and intersected policies. No node-side model loop. Child cwd is resolved on the node before scheduling a run.               |
| `ptc`, `ptc_docs`                                                                                                                                                                                                      | `agent/ptc/index.ts`, registry/preflight/runtime                    | Wrappers, not recursively callable capabilities. Preserve direct core tools + PTC model surface. Static validated placement as §5.                                                               |
| `record_observations`, `record_reflections`, `drop_observations`                                                                                                                                                       | memory observer helpers                                             | Internal gateway model-worker helpers, not newly exposed main-agent tools.                                                                                                                       |
| `record_workspace_memory`                                                                                                                                                                                              | memory/workspace helper                                             | Internal helper: gateway coordinates model output; node validates/appends workspace-memory files, with original trust/provenance.                                                                |

### Features, hooks and configuration

Every `builtinFeatures()` registration has an owner: title, compact, observational
memory, assistant memory/delegation, todo, goal, team and schedules execute central
coordination; project instructions, role, skills, recap inputs, browser, sandbox
and background environment portions use the node descriptor/executor. Web search
uses the trusted gateway service; question interactions use central UI state.
Title/compaction/memory model calls use the same credential-free worker provider
interface as turns. Goal continuation cannot evade run admission/offline checks.

`agent/config.ts` currently validates exact project trust hashes and inheritance;
node descriptor production must preserve global→trusted-project precedence and
exclude untrusted hooks/env/allowedPaths. AGENTS.md, skills, roles and project text
are untrusted context even when included by an otherwise trusted descriptor.
Do not transmit environment values, shell-hook command text, provider configuration,
or secret-bearing config. Paths may appear in text, but the gateway never resolves
node paths against its own filesystem.

All five hook phases stay on the node: `sessionStart`, `beforePrompt`, `beforeTool`,
`afterTool`, `agentSettled` (`agent/config.ts`, `hooks.ts`). Gateway requests each
phase through journaled executor operations; missing/offline hook execution is not
silently skipped. Before-tool validation → hook → rewritten-argument revalidation
→ operation policy/lease → execution → after hook remains ordered. Gateway-native
tools with local hooks use a node preflight receipt bound to the final argument hash
and policy/descriptor/epoch, then a gateway policy check and execution, then node
post-hook. A post-hook failure cannot retroactively erase a committed effect. Both
phases are journaled so recovery never replays a hook shell blindly. No hooks means
no hook RPC, but never infer absence from a stale descriptor.

### Authoritative data and existing file-backed readers (no legacy JSONL import)

| Data / reader                                             | Current source                                                                                   | Fresh-session ownership / legacy retention                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSONL entries, active branch and parent links             | `agent/session-store.ts`, `agent/main.ts`, `agent/agent.ts`                                      | Gateway owns all entry variants for new sessions, including provider replay metadata. Do not import legacy JSONL entries, branches or custom state; retain the original files without modification or automatic deletion.                                            |
| History/settings/context panel                            | `node/app.ts`, `node/branch-cache.ts`, `node/panel-routes.ts`                                    | Read new sessions from gateway authority, preserving operation trees and branch filtering. Do not fall back to legacy JSONL or imply old sessions are resumable in the new runtime.                                                                                  |
| Recaps                                                    | `node/recap.ts`, `node/runner.ts`, `agent/features/recap.ts`                                     | Gateway selects new authoritative sessions with owner/workspace/branch filters. Preserve recap exclusions; do not ingest legacy JSONL as a recap fallback.                                                                                                           |
| PTC stores and provenance                                 | `agent/ptc/index.ts`, `session-store.ts`                                                         | Create fresh branch-scoped stores for new sessions; do not import legacy JSONL stores or provenance. Revision checked as §5.                                                                                                                                         |
| Runs/interactions/team/task/goal/todo state               | `database.ts`, team/todo/goal features, custom session entries                                   | Do not import JSONL-backed custom state. Preserve existing central records; mark legacy-session references inactive/unavailable rather than retargeting them to new sessions. Cancel pending old approvals at authorized cutover; retain historical interactions.    |
| Workspace memories                                        | `agent/features/memory/workspace.ts`, node mirror routes                                         | Node retains filesystem ledger/materialization; gateway retains existing mirror plus authoritative conversation memory. No accidental second writer to workspace files.                                                                                              |
| Schedules/delegated sessions                              | daemon scheduling/delegation handlers and database                                               | Preserve existing gateway records, but block dispatch to legacy sessions. Do not silently remap or recreate schedules/delegations against fresh sessions; reconfiguration requires explicit operator action.                                                         |
| Uploads, images, raw outputs, browser recordings/profiles | `node/app.ts` upload route, `node/runner.ts` attachment materialization, `node/sandbox.ts` roots | Files remain node-owned. Model-needed bounded image content may be copied into central message data; retain owner/checksum and privacy classification. Legacy attachments are not automatically adopted by fresh sessions; browser profiles are not transcript data. |
| UI event/interaction projections, sandbox status          | daemon event services, node runner                                                               | Build from new authoritative entries and durable runs; legacy records are not active new-runtime sessions. Do not imply that the gateway loop is inside the node sandbox.                                                                                            |

Workspace-memory recall is also a transcript reader: `agent/features/memory/workspace.ts`
`recallWorkspaceItem` reads source session JSONL, called from `memory/index.ts`;
`node/memory-mirror.ts` rewrites source references to gateway session IDs. Preserve
existing workspace-memory files and mirrors, but legacy source-session evidence is
unavailable in the new runtime. Do not fall back to old `sessionDir` files, retarget
references, or manufacture evidence. New-session references resolve against the
gateway authoritative transcript with owner/project checks.

The context panel also reads the separate `context.json` snapshot via
`agent/context.ts` and `node/panel-routes.ts` when no runner is live. Do not import
legacy snapshots. Build new context from new authoritative entries and a versioned
descriptor; validate schema/branch/descriptor revisions before exposing a snapshot.
If reconstruction inputs are unavailable, show context unavailable, never stale
node snapshot data as the current context.

## 2. Environment interface and versioned envelope

Use the existing authenticated node WebSocket only, with a new negotiated protocol
version (exact integer allocated when M2 lands). Both ends reject incompatible
versions before admitting work; no fallback to the old loop. Service transport
identity supplies `nodeId`; no model argument can select a different node.

Proposed logical interface (wire schemas must be closed, size-bounded and fuzz-tested):

```ts
interface Environment {
  describe(binding: Binding): Promise<Descriptor>;
  start(intent: ExecutionIntent): Promise<ExecutionRecord>;
  status(binding: Binding, executionId: string): Promise<ExecutionRecord>;
  cancel(binding: Binding, executionId: string): Promise<ExecutionRecord>;
  ack(binding: Binding, executionId: string, resultDigest: string): Promise<void>;
}
```

`Binding` = `{nodeId, workspaceId, sessionId, writerEpoch, executorEpoch}`. Epochs
are opaque durable generation identifiers, not clocks. Workspace IDs are node-
qualified and resolved from node-owned registrations; session IDs must map to that
binding independently on both ends. A worker cannot create a binding by assertion.

`Descriptor` = binding + `{version, revision, policyRevision, capabilityCatalog,
instructions, skills, role, platform, cwdDisplay, sandboxStatus, limits}`. Revisions
are SHA-256 of canonical bounded descriptor content (sorted object keys, preserve
array order). Catalog entries include name, argument/result schema, placement
(`node`/`gateway`), effects/concurrency/approval metadata, hook-presence revisions.
Node signs no blanket authorization: every actual call is checked again. Unknown
or conflicting metadata fails closed. Descriptor total ≤1 MiB; instructions ≤512
KiB; at most 256 capabilities. Exceeding bounds produces an explicit configuration
error, never truncates policy or drops tools. A revision change invalidates pending
receipts; refresh before the next model turn. In-flight accepted work keeps its
recorded policy snapshot unless revoked, in which case cancel it.

`ExecutionIntent` = binding + `{executionId, runId, turnId, toolCallId,
parentExecutionId?, innerOperationId?, descriptorRevision, policyRevision,
capability, arguments, argumentDigest, budgetMs}`. IDs are service-generated UUIDs;
inner IDs are stable within the persisted outer execution. Digest covers canonical
arguments **and the complete binding/operation identity**, not just a request ID.
Non-finite numbers, duplicate JSON keys and unsupported values are rejected at
parsing/canonicalization. Deadline is node-local monotonic time established on
first acceptance from a bounded remaining budget; duplicate starts never extend
it. Human waits pause only the active-time budget where existing PTC permits it;
a separate absolute lease lifetime still expires. Clock skew cannot extend grants.

Wire kinds: `environment.describe`, `environment.descriptor`, `execution.start`,
`execution.event`, `execution.result`, `execution.status`, `execution.cancel`,
`execution.ack`, plus correlated replies. Error classes distinguish incompatible,
invalid binding, stale revision/epoch, unavailable sandbox, approval denied,
quota exceeded, expired, cancelled, failed and unknown. A rejection has
`state: rejected, effect: not_started` and is durably bound to that ID.

`execution.event` includes binding/ID and monotonic per-execution `seq` (persisted
across reconnect), event kind and bounded payload. Gateway deduplicates `(ID,seq)`;
missing ranges request replay/status, not execution restart. Results include
`state`, `effect`, typed output/error, truncation, artifact refs, final sequence and
result digest. UI text is a projection, never approval authority. A result from an
old epoch can reconcile its original intent only, not append to the new run.

Artifacts use opaque `{nodeId, workspaceId, sessionId, artifactId, digest, bytes,
mimeType, availability}` references; never gateway filesystem paths. Fetch is
session-authorized, bounded and checked against owner/hash. Offline artifacts show
unavailable and can be retried on reconnect. A model-facing attachment resolves
explicitly or fails; no silent missing image. No raw outputs in control frames.

## 3. Durable execution and reconnect state machine

Separate `state` from `effect`:

- `state`: rejected / accepted / running / completed / failed / cancelled / unknown.
- `effect`: not_started / completed / unknown. Completed means the recorded
  operation effect is verifiable, not that arbitrary external effects are reversible.

Gateway atomically persists intent before send. Node atomically records ID, digest,
binding and acceptance in its durable journal before starting any hook/process or
side effect; durability includes fsync/transaction semantics, not merely an in-memory
map. A duplicate with identical content returns recorded state; different content
returns conflict. A missing old ID cannot execute again: unknown/retired generations
are rejected. Only fresh starts in the active generation may create records.

Allowed progression: accepted→running→terminal; accepted→cancelled with
`not_started`; accepted→failed before work with `not_started`. Running failures or
cancellation default to `unknown` effect unless concrete evidence proves otherwise.
A crash with a running record becomes `unknown` unless a durable job/result can
prove its state. The node writes terminal output/result before sending it. Gateway
atomically appends the result/transcript and dedup record, then ACKs its digest.
A lost ACK only retains data, never reruns work. ACK/result retries are idempotent.
An unknown record can later gain verified evidence for its original execution;
it cannot be silently converted to a new start.

Status/cancel/ACK require the same authorized binding, even if an ID is guessed.
Cancel requests are durable and forwarded to process groups, browser requests and
PTC scopes; an ACK means receipt, not rollback. The UI keeps unknown partial effects
visible. Retries of `bash`, commits or external services require a new explicit
human decision informed by the unknown outcome, not an automatic new ID.

Disconnect: no new operations/approvals begin. Already accepted foreground work
may finish within its original budget/grant; known background jobs retain their
own lifecycle and handles. Gateway may finish/save an active model stream but
cannot start a subsequent environment operation while offline. New environment-
dependent runs fail admission with node-offline; central history remains readable.
QuickJS stacks are never restored/replayed after process restart. Reconcile known
inner records/artifacts/store state; report partial success.

## 4. Actual isolation, approval authority and limits

### Gateway runtime permissions (implementation acceptance requirements)

- Trusted supervisor/provider service owns secrets, database connections and node
  authentication. Agent workers receive no provider config, tokens, credentials,
  inherited host environment or raw database handles.
- Linux worker launcher must establish a separate non-root UID, private mount/PID/
  network namespaces, read-only runtime assets, empty private HOME, bounded tmpfs,
  no host home/workspace/state mounts, no network interfaces except loopback, no
  privileged capabilities, `no_new_privs`, and a syscall policy blocking ptrace,
  mount and new external sockets. Only inherited bounded IPC pipes connect to the
  supervisor; close every other FD. Writable tmpfs is not transcript authority.
- macOS must use an enforced sandbox profile with equivalent deny-by-default
  filesystem/network/process access plus resource supervision. This is an
  implementation gate, not a claim that a subprocess or environment scrub is a
  sandbox. If equivalent containment cannot be demonstrated, gateway runtime on
  that platform remains unsupported pending review; never silently weaken it.
- Workers execute shipped code only. No workspace hooks/shells/native programs;
  QuickJS/WASM guests have no ambient APIs and run under the same outer isolation.
  Capability IPC validates session/project policy and exact arguments in the trusted
  service, including output/frame quotas. Compromised workers cannot use the
  supervisor as a general filesystem or network proxy.
- M2/M3 tests must attempt host-file reads, env/FD leaks, network egress, subprocess
  and IPC impersonation from the restricted worker, on real Linux/macOS separately.
  Fake-srt tests and QuickJS `typeof process` checks alone are insufficient.

### Node executor and approvals

Keep the current OS sandbox mechanism (`node/sandbox.ts`) with a session-scoped
executor replacing the old agent only after M3. No direct daemon `fs`/spawn tool
implementation. Reject sandbox startup failure. Final path/realpath/symlink checks,
leases and argument revalidation remain node-owned, including all PTC inner calls.

Approval records are node-owned `{interactionId, binding, executionId, innerId?,
finalArgumentDigest, policyRevision, descriptorRevision, action, expiresAtLocal}`;
IDs use the reserved node namespace. Only a human-origin response on the authenticated
UI→gateway→node interaction channel can consume them, once, for that exact action.
No model-supplied approval token or peer answer is sufficient. Disconnect, epoch or
policy change expires unconsumed approvals; host execution approval expires after
5 minutes or the operation deadline, whichever is earlier. Existing session-scoped
network grants may persist only for the same healthy executor epoch/policy and
approved domain set; they do not become host-exec permission. No approval grants
permission after sandbox failure. Cancellation never implies approval.

### Accepted initial admission/flow-control budgets

| Resource                  | Initial bound / behavior                                                                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active workers/model runs | 8 global; 1 active run per session; excess rejected as busy (no hidden unbounded queue). Team children share the global budget.                                                                                                                                                                     |
| Context/worker memory     | 8 MiB serialized context per request; 512 MiB worker RSS, 4 GiB aggregate workers, supervised and killed with explicit interrupted run on violation. Provider adapters have separate quotas.                                                                                                        |
| Environment concurrency   | 4 active outer executions per node, 1 per session; preserve existing stricter inner PTC read/write limits and workspace leases.                                                                                                                                                                     |
| Admission queues          | 32 per node / 128 global maximum, fair round-robin by session, cancellable and deadline-aware. Queue expiry is not_started.                                                                                                                                                                         |
| Control/data frames       | Control ≤64 KiB; data chunks ≤64 KiB; logical request ≤8 MiB, result ≤16 MiB; reject overflow before allocation. Artifacts use chunked authorized transfer.                                                                                                                                         |
| Queues/flow control       | 4 MiB outstanding data credit per link, 256 KiB reserved control queue; ACK grants persisted receive credit. Weighted scheduler sends control first with bounded data progress. Pause producers or explicitly fail; never call a fail-fast bound backpressure.                                      |
| Descriptor/store          | Descriptor ≤1 MiB; PTC store preserves 262,144 characters per value / 1,048,576 total (not bytes); transport accommodates UTF-8 expansion within the logical result bound.                                                                                                                          |
| Time                      | Ordinary foreground default 120 s/max 10 min; PTC instead preserves its declared active timeout up to the existing 1 hour maximum. Human waits accumulate at most 30 min in addition to active time. Background jobs retain explicit declared timeout/lifecycle, separate from foreground defaults. |
| Outputs/artifacts         | Inline tool output keeps current tool/PTC bounds; artifact ≤32 MiB, 256 MiB retained artifacts per session by default. Overflow is explicit; artifacts referenced by transcripts cannot be silently removed.                                                                                        |
| Journal/retention         | Unacked terminal results kept ≥7 days and until acknowledged; 1 GiB node journal soft cap stops new work rather than evicting unacked records. ACKed bulky output retained 24 h, then compact to tombstones.                                                                                        |

Compact tombstones retain execution ID/digest/binding/terminal summary for the life
of an active writer generation. When that generation is permanently fenced, compact
them to a durable retired-generation fence: all old starts are rejected forever.
Never expire a tombstone while its generation can admit the same ID. Disk exhaustion
fails new admission; do not delete uncertain/unacked effects to make space.

Gateway transcripts now retain complete private conversation content long-term,
not only event projections. Default: no automatic transcript deletion. Backups must
cover transcript DB, runs, stores, epochs, cutover records and artifact references;
node backups retain workspace artifacts/journals. Explicit user deletion follows
existing privacy policy and must address backups separately. Redact credentials
from logs; trace IDs/counters are preferred to prompt text. Retention or deletion
policy changes are separate human decisions.

## 5. PTC placement, inner journal and branch store commits

Preflight manifest plus the trusted capability catalog selects a fixed location:
node if **any** capability is environment-bound; otherwise constrained gateway guest.
Mixed scripts stay node-local with a session-scoped central broker. Unknown placement
is rejected. No automatic splitting, replay, migration or broad script approval.
The same operation entrypoint applies hooks/policy/approvals/refusal/cancellation to
direct tools and each inner call. Gateway-only scripts with configured node hooks
still pay the explicit hook RPCs; count that cost in later benchmarks.

Dispatch includes `{branchId, storeRevision, boundedSnapshot, untrustedProvenance}`.
The gateway owns store authority. Preserve current behavior: only a normally
completed script with a returned changed store can propose a commit; failure,
cancellation, timeout or guest loss does not commit a partial store. Store reads
and no-op returns retain current semantics and provenance. Commit transaction
checks branch identity/revision and execution dedup, then records store revision
and result exactly once. Conflict leaves the old store intact and stores an explicit
store-conflict result with known external effects. It **never** reexecutes operations.
Branch switch while running fences store commit to the original branch; it cannot
write the current branch accidentally.

Each inner call carries stable `(parentExecutionId, innerOperationId)` and digest.
Node persists start/result/delivery evidence for local and central inner operations.
Gateway broker persists intent and enforces the same ID/content rule. Database-
covered schedule/delegation/memory/team mutations and their result record commit
in one transaction; process creation/external services are not claimed atomic.
Those use durable launch intents and recoverable handles, otherwise effect unknown.
Lost replies query the original inner ID. If a central mutation committed but its
reply was lost, return that result; if the guest died, preserve it in the partial
outer summary without restarting the script. Unknown external effects remain
unknown even if the outer guest reports a generic error.

Human waits, active/absolute deadlines, cancellation and background job ownership
are keyed to the parent and inner IDs. Job ownership outlives the QuickJS stack;
terminal script completion neither silently kills nor restarts established jobs.
Attachments/traces retain origin IDs and bounded retention; trace truncation must
not erase journal facts required for recovery.

## 6. Fresh-session cutover, ownership fencing and rollback

Legacy JSONL migration is explicitly out of scope for this breaking change. There
is no legacy transcript importer, branch/store/context conversion, or reverse-export
deliverable. This exception does not relax new-runtime durability or security.

1. Preflight each node: identify legacy sessions and central schedule/delegation/
   team/memory references that must not resolve to fresh sessions. Preserve existing
   records and workspace files; do not reset the gateway database. Document legacy
   history/resume unavailability in the new runtime.
2. With separate operator authorization, stop new runs/schedules/delegations; settle
   or explicitly stop foreground work. Cancel all old approvals. Stop background
   jobs unless an independently verified handoff exists; no implicit restarts.
3. Retain old JSONL, snapshots, artifacts and backups without automatic deletion.
   No legacy transcript transfer/import is required. Block legacy-session dispatch
   and stale references; reconfiguration is explicit, not automatic recreation.
4. Fence old writers durably on the node and gateway, acknowledge fencing, then
   publish the new gateway writer generation. A disconnected node cannot acknowledge
   fencing and remains ineligible for new-runtime environment work until it rejoins
   and completes the fence/version checks. Old binaries cannot obtain a new lease.
5. Create fresh session/branch/store/context state with distinct identities bound to
   the original node/workspace. Validate new history/context/recall/artifact paths;
   no legacy-file fallback or old ID reuse. Start the sandbox executor only after
   the relevant fencing and ownership checks succeed.
6. Before new writes, reverting requires revoking the new epoch and verifying that
   no new writes occurred. After new writes, no lossless rollback to the old runtime
   is provided: preserve new data and require a separately reviewed downtime and
   compatibility/recovery plan. Do not reopen old writers automatically. Restoring
   a backup must not restore a reusable old epoch. Data deletion remains separately
   authorized.

## 7. Required test matrix and review gates

| Test family       | Required evidence before production cutover                                                                                                                                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compatibility     | Unsupported versions/unknown schema fields, malformed/oversized frames and unknown capabilities rejected before execution; no legacy fallback.                                                                                                                                                                                                           |
| Boundary/security | Forged session/workspace/epochs, symlink escapes, role/child escalation, hooks rewriting paths, approval replay/spoofing, missing sandbox and host/network exceptions. Real OS worker/sandbox tests per platform.                                                                                                                                        |
| Durable execution | Duplicate same/different payload; crashes before acceptance, after acceptance, after effect, before result persistence, before/after gateway transcript commit; lost ACK and tombstone expiry/retired generation; disk-full admission. Assert no automatic replay.                                                                                       |
| PTC               | Ten dependent environment calls without linear WAN RPC; gateway-only and mixed routing; inner commit/lost reply, node/guest restart, denial/refusal, store conflict/branch change/failed store persistence, partial artifacts/human waits/background ownership.                                                                                          |
| Offline/reconnect | History available, artifacts unavailable, new runs rejected, active stream saved, old-epoch events quarantined, jobs queried, revoked approvals not resurrected.                                                                                                                                                                                         |
| Quotas/flow       | Flood one session while control/cancel/approval and other sessions progress; bounded memory/queues/frame parsing, exhausted credit/cancel, slow UI/node, provider rate limits and child budgets.                                                                                                                                                         |
| Feature parity    | Coding/chat, all inventory tools, titles/memory/compaction, hooks/AGENTS/skills/roles, goals/todos/check commands, team wait/ask/stop, schedules/delegations, Web/Android operation trees and sandbox indicators.                                                                                                                                        |
| Fresh cutover     | Legacy JSONL/snapshots remain untouched and are never loaded as new state; fresh IDs/stores/context, unavailable legacy recall/history, blocked legacy schedule/delegation references, offline-node admission, old-writer fencing, stale backup restore, new-session provider replay/artifact ownership; rollback restrictions before/after first write. |
| Performance       | Same M0 fixtures and synthetic provider; separate full-deployment runs include hooks, provider adapter and all processes. Original ≥70 ms streaming p50 improvement at 100 ms RTT, no p95 regression; task regression ≤max(10%,50 ms); no linear PTC WAN expansion; no repeated full context on node link.                                               |

### Human review outcome and remaining authorization

The maintainer's LGTM accepts M1 with the explicit no-legacy-JSONL amendment:

- [x] Accept gateway loop **and** complete transcript authority for new sessions; retain node binding.
- [x] Accept static PTC routing, partial-failure/store conflict behavior and no script replay.
- [x] Accept offline admission and node-owned hooks/approvals/host-exec rules.
- [x] Accept the concrete isolation requirements and fail-closed unsupported-platform behavior.
- [x] Confirm original M5 performance gates, with M0 remaining a component baseline.
- [x] Accept initial quotas, deadlines, journal and private-content retention.
- [x] Exclude legacy JSONL migration; use fresh sessions, retain old data, preserve fencing and do not promise lossless rollback after new writes.
- [x] Separately authorize the first M2 foundation slice (local operation extraction, logical protocol and journal); M2 as a whole remains incomplete.
- [ ] Authorize remaining M2 integration separately; production RPC activation, deployment/cutover/data deletion remain excluded.

M1 design review is complete; implementation and real-platform validation are not.
Any materially changed choice returns to review rather than being inferred from
this document.
