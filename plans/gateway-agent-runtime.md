# Gateway agent runtime: centralize the agent loop, keep execution environments on nodes

Status: **Plan reviewed and accepted by the maintainer; implementation and deployment cutover have not been authorized by this documentation-only request.** The maintainer requested a plan first, then approved it for translation and commit. The boundaries, protocols, performance thresholds, and migration approach below describe the proposed implementation; detailed contracts and measurement budgets remain subject to the review gates below. No milestones have started.

Code baseline: `17a91a0`. This investigation used static architecture inspection only, with no latency measurements; the benefits below are hypotheses to validate.

## 1. Goals and non-goals

Move the agent loop, model context, and authoritative conversation state to the gateway. Nodes retain workspaces, files, shells, browsers, sandboxes, and environment execution capabilities.

Primary goals:

1. Model streams no longer travel gateway → node → gateway before reaching the UI.
2. Nodes no longer upload the complete system prompt, history, and tool schemas on every model call.
3. The gateway owns context, sessions, and agent coordination together, rather than moving only the loop and leaving frequent synchronous state RPCs behind.
4. Preserve local batch efficiency, security boundaries, tool semantics, and session recoverability.

Non-goals:

- Do not replace the model provider adapter or send provider credentials to nodes.
- Do not redesign the model-facing tool interface; preserve the accepted hybrid direct tools + PTC surface rather than reverting to PTC-only.
- Do not execute workspace bash, project hooks, or arbitrary model-generated native programs on the gateway.
- Do not also introduce multi-user isolation, automatic cross-node workspace migration, offline model operation, or transparent process checkpointing.
- Do not promise faster execution for every task or exactly-once semantics for arbitrary external side effects.
- Retain the environment role of `pirc-chat` for now; executable consolidation is a separate decision.

## 2. Current topology and latency hypotheses

Current:

```text
node agent ──full model context──▶ gateway ──▶ provider
provider ──▶ gateway ──delta──▶ node agent ──session event──▶ gateway ──▶ UI
```

Target:

```text
UI ◀──▶ gateway: agent loop / session / context / team
             ├──▶ provider
             └──environment operation or PTC script──▶ node
                ◀──result / progress / artifact────────┘
```

Evidence from the current implementation; paths are relative to `apps/gateway/src/`:

| Responsibility                                         | Current implementation                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Node starts a sandboxed agent                          | `node/runner.ts`                                                                   |
| Per-turn model requests, tool loop, steering           | `agent/agent.ts`                                                                   |
| Full-context wire projection and Unix socket transport | `inference-wire.ts`, `agent/providers/remote.ts`, `node/inference.ts`              |
| Gateway provider calls and node link                   | `backends/inference.ts`, `daemon/nodes.ts`                                         |
| Node session events returned to the gateway            | `node/runtime.ts`                                                                  |
| Local JSONL and its readers                            | `agent/session-store.ts`, `node/branch-cache.ts`, `node/recap.ts`                  |
| Local coupling in tools, config, hooks, and teams      | `agent/tools/`, `agent/config.ts`, `agent/hooks.ts`, `agent/features/team/team.ts` |
| PTC capability broker and QuickJS guest                | `agent/ptc/index.ts`, `agent/ptc/runtime.ts`                                       |

Expected savings are full-context retransmission over the node link, the delta detour, and some JSON encoding/decoding. **This does not eliminate gateway → provider context uploads, provider inference time, or tool execution time.**

A single "model → node tool → next model call" cycle already sends the model result gateway → node and the next context node → gateway. After migration, these become a tool request and result. Both can require one node–gateway RTT, so the migration must not be described as saving an additional RTT on every tool iteration.

## 3. Responsibilities and data ownership

| Area                    | Gateway                                                                                  | Node                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Agent                   | Loop, steering, retries, compaction, model selection, team/subagent scheduling           | No model loop                                                                            |
| Conversation            | Authoritative transcripts, branches, context snapshots, runs, and interactions           | Migration sources or explicitly defined read-only replicas only                          |
| Environment description | Assemble prompts and tool sets from versioned descriptors                                | Resolve workspaces, cwd, OS, trusted config, AGENTS.md, skills, and role data            |
| Tools                   | Gateway-native memory, search, schedules, delegation, etc.                               | read/edit/write, find/grep, Git, bash, background processes, browser                     |
| Security                | Validate session/project policy, authorize central capabilities, enforce resource limits | Final path checks, OS sandbox, local approvals, write leases, hooks, process termination |
| PTC                     | Accept model calls; own context and authoritative branch-scoped store                    | Constrained execution of environment scripts and local capability dispatch               |
| Artifacts               | Conversation references, UI access routing, attachment content needed by the model       | Files, uploads, browser profiles, large raw outputs                                      |
| Execution recovery      | Track intents and unfinished tools; deduplicate results                                  | Durable execution journal, job handles, results, and necessary short-term retention      |

Sessions remain bound to their original workspace/node; centralizing the loop does not allow execution on an arbitrary node. Nodes must resolve relative paths and cwd. Gateway string validation cannot replace node-side realpath, symlink, and policy checks.

Descriptors carry only necessary, bounded text, metadata, and revisions, not local secrets/environment variables. Project content remains untrusted input; migration must not weaken trust decisions or configuration precedence. The gateway cannot promise that it "never sees real paths": tool text, instructions, and existing history can contain paths, but resolving them must not depend on the gateway's local filesystem.

## 4. Execution boundaries and security invariants

### 4.1 Nodes retain final authority over environment execution

- Run environment tools inside a session-scoped sandboxed executor. Do not replace the current sandboxed agent with direct fs/Bun.spawn calls inside the unconfined node daemon.
- Preserve existing policy; do not incidentally switch to workspace-only reads or expand existing read/write access.
- Nodes independently validate sessions, workspaces, executor epochs, capabilities, and actual arguments, and retain cross-session write leases.
- Environment operations preserve the existing validation → before hook → revalidation → policy/lease → execution → after hook semantics. Recheck arguments after a hook rewrites them.
- Project hooks stay on nodes. If local hooks still apply to gateway-native operations, explicitly route their pre/post processing through the node rather than silently skipping it, and include that cost in performance measurements.
- Human approvals are bound to the session, operation content, policy revision, and validity period. Reconnection, stale descriptors, and model-supplied approval IDs cannot create new authorization.
- Reject environment execution when the node sandbox is unavailable; never fall back to unsandboxed operation. Propagate cancellation to process groups, browser requests, and PTC scopes.
- Preserve `sandbox_allow_domains` and `unsandboxed_bash`: the gateway may only request them; the node owns approval interactions, the reserved ID namespace, and anti-spoofing checks. An explicitly approved individual host execution is an existing exception, not a fallback for sandbox startup failure. A working sandboxed executor is still required, and the node validates cwd, strips secrets, bounds output, and terminates process groups.

### 4.2 Gateway runtime and credentials

Centralization changes deployment location and ownership; it does not mean placing all execution inside the HTTP process that holds secrets.

The proposed agent runtime uses constrained workers/processes and narrow interfaces. It must not inherit provider secrets or execute arbitrary workspace shells. PTC guests continue to use QuickJS/WASM without ambient authority, not ordinary JavaScript eval. Worker separation alone is not security isolation: M1 must define and test actual filesystem, environment, IPC, and OS permissions rather than claiming isolation merely because a subprocess exists.

Add per-session and global limits for concurrency, context memory, workers, queues, output size, and timeouts so one centralized session cannot overwhelm all nodes. Preserve existing authentication, project capabilities, child-policy intersections, and credential protection.

## 5. Tool RPC and disconnect recovery

Reuse the authenticated node WebSocket with a versioned environment protocol; do not open another public tool port. The following is a conceptual protocol; M1 finalizes field names:

- `environment.describe`: obtain the descriptor, policy revision, available capabilities, and limits.
- `execution.start`: include execution ID, session/run/turn/tool-call IDs, node/workspace, epoch, descriptor revision, capability name, arguments, and deadline.
- `execution.event`: progress, approval requests, and bounded output with monotonically increasing sequence numbers.
- `execution.result`: typed result/error, attachments, truncation, and side-effect status.
- `execution.status` / `execution.cancel`: recovery and cancellation; a cancellation acknowledgment does not mean all external side effects have been undone.
- `execution.ack`: acknowledge after the gateway persists the terminal state, allowing nodes to reclaim results under the retention policy; expiration tombstones must still prevent old IDs from executing again.

An execution ID is a correlation and deduplication key, not authorization. Reject the same ID with different arguments. Late events cannot mutate a run in a new epoch; verified older results can still reconcile their original execution.

Proposed state machine: `accepted → running → completed | failed | cancelled | unknown`. Also retain rejection/`not_started` and external-effect status `not_started | completed | unknown`, so "returned an error" is not mistaken for "nothing happened."

Recovery rules:

1. The gateway persists intent before dispatch; the node records acceptance before allowing side effects to begin.
2. The node persists the terminal state and result before returning them. The gateway acknowledges only after writing the transcript/result. Duplicate events and results must not create a second tool result.
3. Query execution status after a disconnect; do not automatically turn a timeout into a new execution. Reusing an ID can only retrieve existing state, not start execution again.
4. A node crash between the side effect and result persistence leaves the outcome `unknown`. Do not claim exactly-once behavior or assume that `git commit`, payments, or arbitrary bash can safely be rerun.
5. During a temporary disconnect, accepted foreground operations may finish only within their original deadline and authorization; no new operations or approvals start. Established background jobs follow their own timeout/lifecycle and are queried again after reconnection.
6. Gateway/runtime restarts do not transparently restore QuickJS stacks. Recover only verifiable executions, transcripts, and job handles. Report partial success accurately without replaying the whole script.
7. When a node is offline, the gateway can serve history, but by default does not start new environment-dependent runs. Do not silently omit environment capabilities and continue. An existing model stream may finish and be saved; subsequent environment operations explicitly wait or fail.

The protocol also needs frame/output/artifact limits, cancellable flow control, and scheduling that prevents control/approval traffic and large outputs from starving each other. Do not describe the current bounded fail-fast buffering as end-to-end backpressure.

## 6. PTC: keep batch execution close to the data

Use predictable static routing in the initial implementation, without arbitrary script partitioning or migration during execution:

- **Environment-only scripts:** send the whole script to the bound node's constrained QuickJS executor; internal read/bash/edit calls remain local.
- **Gateway-only scripts:** execute in a constrained gateway guest using central capabilities.
- **Mixed scripts:** initially execute on the node if the manifest includes environment capabilities; route central capabilities back to the gateway through a session-scoped broker. Every central call still validates project policy. Do not recreate an agent loop on the node.

Routing must follow validated capability metadata/manifests; role/tool allowlists remain unchanged. Inner operations cannot bypass existing hooks, approvals, refusal propagation, concurrency, or cancellation rules. A mixed script must not receive blanket approval.

The gateway owns the authoritative branch-scoped `ptc.store`. Dispatch includes a bounded store snapshot, revision, and untrusted provenance. On completion, preserve existing commit semantics: deduplicate by execution ID, check the branch/revision, then save the store/result. Conflicts or failures must not rerun environment side effects that already occurred. M1 must define consistency rules for partial failure and store commits.

Every central capability call within mixed PTC must carry stable parent execution and inner-operation IDs. For side-effecting central operations, the gateway broker also persists intent/result, checks argument consistency, and deduplicates calls. Commit database mutations and result records atomically wherever a transaction can cover both. If the gateway commits a schedule/delegation change but the node disconnects before receiving the reply, query and reconcile each operation during recovery without replaying the script. Unverifiable effects involving external systems remain `unknown`. The node-side journal must likewise retain started inner operations and known results, making partial success traceable rather than recording only the outer script's terminal state.

Mixed PTC traces/artifacts, human waits, deadlines, and background ownership all require integration tests. If this approach cannot meet the security or performance gates, return to design review rather than silently falling back to one WAN RPC per tool.

## 7. Session migration and cutover

The proposed rollout is development on a branch followed by a single cutover after acceptance. Tests may retain legacy/new harnesses, but production should not retain switchable dual loops indefinitely.

1. **Inventory:** transcripts, branches, context, PTC stores, runs, interactions, team relationships, workspace memory, recaps, uploads/attachments, and scheduled/delegated session references. Distinguish node-local file references from migratable data; preserve provider replay metadata.
2. **Quiescence:** stop new run/schedule dispatch, finish or explicitly terminate foreground work, and cancel old pending approvals rather than carrying old process authorizations forward. Background jobs need a separately verified handoff; otherwise explicitly stop them before cutover, without implicit restarts.
3. **Import:** transfer immutable snapshots with manifests/checksums over a controlled channel. Preserve gateway-facing session IDs, node-qualified workspaces, branch/message IDs, signatures, and parent relationships. Repeated imports must be idempotent. Reject cross-node ID conflicts during preflight or create explicit mappings.
4. **Verification:** compare entry/branch counts, hashes, attachment resolution, context replay, history/recaps, and UI behavior. An offline node or incomplete snapshot is not a completed migration; keep affected sessions migration-pending/read-only until the node returns and import can complete.
5. **Ownership transfer:** the gateway obtains the sole writer epoch; old node agents must no longer write authoritative transcripts. Start the new sandboxed environment executor and update schedules/delegations and session readers.
6. **Retention and rollback:** keep old JSONL and backups read-only; do not delete them automatically. Before the first new write, returning to the old version is possible. After new writes, rollback requires downtime and reverse export/compatibility validation. Otherwise, do not restore the old writer or claim lossless one-click rollback.

Artifacts may remain on nodes. References must identify ownership and show unavailable when the node is offline rather than pretending attachments have moved to the gateway. Update gateway/node backup guidance and private-content retention policies, explicitly documenting that the gateway will now retain complete transcripts long-term.

## 8. Milestones and acceptance

Checkboxes below track implementation progress only; writing or approving the plan does not complete a milestone.

### M0 — Baseline and performance feasibility

- [ ] Build reproducible tests with a synthetic/fake provider and a controlled-latency link, avoiding attribution of provider variability to architecture improvements.
- [ ] Record node-link RTT, context bytes, time from gateway delta receipt to UI receipt, tool queue/execution time, total traffic, socket backlog, and CPU/RSS.
- [ ] Cover loopback and simulated 30/100/200 ms RTT; small/large contexts, single tools, PTC with 10 dependent environment operations, mixed PTC, and multiple sessions.
- [ ] Use monotonic clocks for local spans; measure cross-machine timing through traces/round trips or calibration rather than directly subtracting unsynchronized wall clocks.

Acceptance: a reproducible baseline report distinguishing streaming presentation from total task time. Document separate manual steps for measurements on real remote deployments. Paid-model runs and private-history evaluation require separate authorization.

### M1 — Finalize contracts, security model, and migration design

- [ ] Complete the inventory of capabilities (including `sandbox_allow_domains` and `unsandboxed_bash`), feature hooks, config, session readers, and artifact ownership.
- [ ] Finalize the Environment interface, descriptors, execution protocol, PTC placement/store commits, and disconnect state machine.
- [ ] Finalize gateway runtime permissions, the node sandbox executor, approval authority, resource quotas, and data retention/reclamation.
- [ ] Define the test matrix for version incompatibility, unknown execution outcomes, offline nodes, import failure, and rollback.

Acceptance: human review of the responsibility boundaries, major behavior changes, and §10 choices before behavior-changing implementation begins. Documentation is not a substitute for authorization.

### M2 — Extract environment capabilities and reliable RPC

- [ ] Extract local/remote environment adapters and a sandboxed executor without moving the production loop yet.
- [ ] Implement the execution journal, deduplication, status/cancel, events, approval relay, artifact references, and flow control.
- [ ] Share the same policy/execution entry points between direct tools and PTC inner operations; give gateway-native hooks an explicit route.

Acceptance: reject forged workspaces/sessions, symlink escapes, invalid approvals, and unavailable sandboxes. Test duplicate starts, disconnects, restarts at both ends, lost result acknowledgments, and crashes after side effects, without automatically rerunning side effects.

### M3 — Gateway loop and session authority

- [ ] Build the constrained gateway agent runtime and connect it to the existing provider service; streaming directly produces gateway session events.
- [ ] Move transcripts/context/branches, steering, compaction, model fallback, and model-call paths such as titles and memory.
- [ ] Build the session snapshot importer and writer-epoch fencing; adapt history, recaps, the context panel, and file-reference readers.
- [ ] Verify gateway restarts, offline nodes, reconnection, and multi-session resource limits.

Acceptance: main coding/chat flows work end to end with a fake provider. UI deltas no longer detour through nodes; the node link no longer carries complete inference context every turn; each session has exactly one authoritative writer.

### M4 — PTC, teams, and product feature parity

- [ ] Implement §6 PTC routing, branch stores, consistent inner-operation events, attachments, and partial failure.
- [ ] Convert teams/subagents to gateway runtime instances. Nodes still validate cwd and environment access; preserve policy inheritance and parent/child stop/wait/ask semantics.
- [ ] Verify background jobs, browsers, project instructions/skills/roles, hooks, workspace memory, recaps, schedules, delegation, and chat-project behavior.
- [ ] Preserve Web/Android operation trees, approvals, sandbox status, interrupts, and reconnection presentation. Do not show a misleading badge equating the gateway loop itself with the environment sandbox.

Acceptance: preserve the existing hybrid model interface and identical direct/PTC permissions. Ten dependent environment-only PTC operations must not create ten cross-node tool round trips. Mixed scripts must neither bypass refusals nor replay after approval denial or disconnection. Cover recovery before/after central inner-operation commits, lost replies, and node crashes. Verify that network/host-exec exceptions require node-owned approval and cannot be obtained through forged interactions or sandbox failure.

### M5 — Comparative evaluation, migration rehearsal, and cutover decision

- [ ] Rerun M0 with identical fixtures, model conditions, and network settings. Report p50/p95, traffic, and success rates rather than selecting a single faster case.
- [ ] Use fixture backups to rehearse idempotent imports, data conflicts, offline nodes, cutover fencing, and rollback limitations before/after new writes.
- [ ] Have a fresh reviewer audit security, recovery, PTC, and data migration; run the full checks after fixes.
- [ ] Update topology, backend auth, sandbox, backup/recovery, upgrades, Nix/role packaging, and version-compatibility documentation.
- [ ] Present measurements and remaining risks for a human cutover decision. Deployment, stopping existing work, and deleting old data require separate explicit authorization.

Proposed performance gates (confirm with the human after M0 and before implementation; do not relax them after seeing results):

- At 100 ms RTT with a low-load synthetic stream, reduce p50 gateway-delta → UI delivery latency by at least 70 ms, with no p95 regression.
- Environment-only PTC must not add WAN round trips linearly with its number of dependent inner operations.
- For single-node-tool, mixed-PTC, chat, and loopback fixtures, p50/p95 task time must not exceed baseline by more than `max(10%, 50 ms)`. Exceeding this requires explanation and review, not concealment behind streaming improvements.
- Long-context fixtures must not retransmit complete history over the node link. Report bytes saved separately; do not count gateway → provider traffic as eliminated.
- All correctness and security tests pass, with no lost transcripts, duplicate tool results, weakened permissions, or unexplained feature removals.

## 9. Validation and implementation scope

During implementation, run the narrowest relevant tests first, then the repository's `bun run check` (version, format, typecheck, test, build, compiled-role tests). This documentation-only plan requires document checks, not paid-model runs or the full runtime test suite.

Priority areas for test expansion:

- `apps/gateway/test/inference-transport.test.ts`, `agent-remote-inference.test.ts`: existing inference paths and their post-cutover replacements.
- `agent-core`, `agent-compaction`, `agent-context`, team/subagent, and gateway/node integration tests.
- `sandbox-policy`, `sandbox.integration`, `sandbox-srt.integration`, and project trust/capability tests.
- `ptc-runtime`, `agent-ptc`, PTC lifecycle/continuation, and UI timeline tests.
- New environment protocol, journal/recovery, session migration, and latency fixtures.

Record real sandbox validation separately for Linux and macOS; passing fake-srt tests does not validate OS isolation. Where Android, manual browser checks, real node restarts, or sandbox environments are unavailable, provide handoff commands and mark them unverified rather than treating skipped tests as success.

Expected changes are concentrated in `apps/gateway/src/agent/`, `node/`, `daemon/`, `protocol*.ts`, `database.ts`, and role entrypoints/build/Nix packaging. M1 determines exact new module names; moving directories is not a substitute for removing local coupling.

## 10. Key choices and remaining review gates

The maintainer has accepted the plan's direction. The recommendations below record that direction; detailed contracts and post-M0 budgets still require the milestone reviews above.

1. **Overall direction:** should the gateway own both the loop and complete authoritative session state, rather than adding only a lighter streaming shortcut/context cache? Recommend the former; if M0 finds little benefit, stop this migration and evaluate a lighter approach separately.
2. **PTC placement:** accept fixed routing with environment/mixed scripts on the node and gateway-only scripts on the gateway? Recommend this to avoid fine-grained remote tool RPCs; do not implement automatic script partitioning.
3. **Offline-node semantics:** accept readable history but no new environment-dependent runs, with existing executions handled under §5? Recommend this conservative behavior initially, without adding a separate tool-free chat mode.
4. **Cutover:** accept a single cutover after branch validation, backups, and quiescence, with deferred import for offline sessions and no production dual loop? Recommend this approach.
5. **Performance and resource budgets:** after M0, confirm the §8 performance gates and gateway limits for sessions, workers, and context memory before implementation proceeds.

Related documents: [current topology](../docs/deploy/topology.md), [model backend architecture](../docs/architecture/backend-auth.md), [sandbox](../docs/history/sandbox.md), [PTC and hybrid cutover](../docs/evaluations/ptc/ptc-only.md), [project policy](project-isolation.md). This plan does not override their established policies; necessary architecture changes must be explicitly reflected during review and cutover.
