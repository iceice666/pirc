# Conversation binding migration (U2)

[Unified conversations](unified-conversations.md) · [Execution contracts](conversation-execution-contracts.md)

Status: U2 in progress locally, 2026-10-27. Schema 1021 delivered the durable
legacy adapter; schema 1022 adds explicit project membership, configured mode
and workspace-capability histories, and an owner-scoped environment read model.
Schema **1023** captures new global-memory version/proposal write-time origins.
Resource provenance, full effect fences and supported environment transitions
remain to implement. No mount, move, grant, process restart or U1 activation is enabled.

## Identity mapping and current migration

| Existing identity or state                          | Schema 1021 mapping                                                                        | Preservation rule                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Public `sessions.id`                                | Same conversation ID                                                                       | Keep deep links, command/approval targets, schedules, pots and memory/checkpoint sources     |
| `sessions.workspace_id`                             | `membership.legacyWorkspaceId` plus `execution.workspaceId`                                | Explicit compatibility association; does not declare every directory workspace a project     |
| Chat project                                        | Existing workspace ID, classified by `project_links::is_project` using the current catalog | Preserve project files, rules and links; links are ordering/defaults, never folder grants    |
| Top-level `chats` / directory workspace             | Existing workspace association                                                             | No invented project or implicit membership in linked workspaces                              |
| Custom mode ID, including unavailable IDs           | Exact `execution.modeId`                                                                   | Preserve it; unavailable modes remain unavailable under existing checks                      |
| Node ID / private Node session                      | Same host and private mapping                                                              | Public binding contains the already-public Node ID, never private Node session/path or owner |
| First-send accepted session without Node allocation | Same binding at generation 1                                                               | The first private ID completes that allocation; it is not an environment switch              |
| Checkpoint continuation                             | Its existing new public ID and private recovery workspace                                  | Preserve ownership/isolation; retry returns that same binding                                |
| Runner epoch                                        | Existing epoch, separate from binding                                                      | Restarting a runner does not move the conversation                                           |
| Device control generation                           | Existing control lease, separate from membership/binding                                   | Takeover does not move the conversation or grant folder access                               |
| Memory/history/provenance                           | Unchanged stored data                                                                      | Do not infer historical membership from today's workspace; do not replay commands            |

`conversation_bindings` is seeded within the existing single migration transaction.
Its insert trigger covers every session creator, including first-send acceptance,
ordinary creation, schedules/delegations/pots and checkpoint continuation. Rollback
removes both rows; final session deletion cascades the identity-only binding.
An invalid historical workspace reference refuses migration atomically rather
than silently omitting that conversation from the public list.

Membership revision and execution generation start at **1** independently. A
legacy workspace reassignment advances both; replacing an established Node
mapping advances execution only. A mode-ID reassignment conservatively advances
both because the old catalog can classify project membership. A same-ID Node
announcement, display-name/repository refresh, rename, runner restart, device
lease change and first private mapping do not advance either. Values must remain
positive, exact JavaScript integers. These storage-adapter cases do **not** expose
a supported workspace-switch API.

The compatibility `binding.version: 1` is included in ordinary session responses,
lists and snapshots. Web retains it in its API model; native Android retains it
through Session parsing, timeline state, edits and serialization to Flutter.
Missing bindings remain compatible with old Gateways. An advertised unsupported
version or conflicting workspace reference is rejected, not treated as an old
server or used to choose a different execution destination.

## Explicit membership and configured policy (schema 1022)

`conversation_project_memberships` stores one canonical project association per
conversation, separately from `membership.legacyWorkspaceId`. Its own revision
starts at 1. The current validated mode's `projects` capability and existing
`project_links::is_project` identity rule classify legacy projects. Top-level
`chats` and directory workspaces do not become projects. No files are copied.

Resolution is `unresolved` before the first catalog adoption, `member` for a
confirmed project, `none` for a confirmed non-project, or `mode_unavailable` when
the mode cannot be resolved. A missing mode retains the last known project ID only
if the source workspace is unchanged. That retained reference grants nothing.
Initial migration/adoption does not pretend to have observed a past membership
transition. Later changes to the project ID or resolution advance the canonical
revision; moving between two non-project directories only changes the legacy
association and execution generation. These adapter cases remain internal, not a
new user-facing move API.

`mode_policy_versions` stores each full validated mode definition, including rules,
under an append-only revision. Removal appends a null definition rather than
rewriting history. Startup/reload installs the catalog, resolves memberships and
advances affected execution generations in one transaction; a failed write leaves
the prior in-memory catalog intact and publishes no replacement to Nodes. The
first adoption does not advance existing execution generations. Identical reloads
and restarts do not append versions. All definition changes, including labels,
conservatively advance the version; finer semantic classification is deferred.

`workspace_policy_versions` seeds each workspace's current capabilities (or its
existing default) at revision 1. Actual policy changes and reset-to-default append
snapshots and advance affected execution generations; no-op patches do neither.
The read/modify/write patch is now an IMMEDIATE transaction, so simultaneous patches
to different fields retain both edits. Snapshot failure/overflow rolls back the
policy change. Histories reject UPDATE and direct DELETE; workspace policy history
is removed with the workspace through its existing authorized deletion flow. Mode
history remains part of Gateway configuration state. No new memory data is stored.

`GET /api/sessions/{id}/environment` reads one consistent snapshot with:

- `version: 1`, the unchanged `sessionId` and compatibility `binding`;
- `project: {revision, workspaceId, resolution}`;
- `modePolicy: {revision, definition}` (null policy for an unknown mode, null
  definition for a recorded removal), and `workspacePolicy: {revision, capabilities}`;
- `enforcement: "not_tracked"` — never a claim that Node installed these policies.

The route is owner scoped, respects checkpoint privacy and deletion fences, and
returns `Cache-Control: no-store` even on authentication failure. Paired Android
can read it directly without browser consent, a live Node or a private Node session
mapping. Web and native API adapters validate the version, requested session,
project/binding scope, revisions and enforcement marker; errors/older-server 404s
are not turned into synthetic authority. Existing list/snapshot shapes are unchanged
from schema 1021. No new UI or Flutter bridge operation is claimed in this slice.

**Boundary:** configured policy versions still are not installed/acknowledged
sandbox versions. Project files and mutable external rules/mounts are not yet
snapshotted. No general expected-version command precondition or
old-client authority fence is installed. U4 must provide real Node revocation and
acknowledgement before a project/environment transition can be exposed.

## Memory write-time source snapshots (schema 1023)

`memory_version_contexts` and `memory_proposal_contexts` are private, versioned
sidecars to the original memory log and proposal rows. Migration creates them empty:
no current workspace is used to backfill historical membership. New agent-authored
text/proposals capture the verified session, canonical membership resolution and
revision, execution generation/workspace/Node/mode, and configured policy revisions
inside the same transaction as the write. User/model-supplied source labels cannot
supply this snapshot. The existing `sources_json` and immutable creator attribution
keep their original meanings and wire formats.

USER approval copies the proposal's original snapshot; duplicate proposals retain
that same snapshot. Restore and project rollback copy the restored content version's
snapshot. They never recompute an origin from where its conversation lives today.
Legacy/missing snapshots remain explicitly unknown. Direct user edits have a user
origin rather than an invented project. A no-op note or restore creates no new
version or origin. Contentless Remove/Forget audit rows carry no source snapshot.

Sidecars reject UPDATE. Log/proposal deletion cascades their snapshots; project
history scrubbing and proposal redaction delete them in the same transaction.
Deleting an editing conversation preserves another creator's memory and the retained
version origins needed by project deletion. Global Forget and creator deletion
remove the relevant snapshots. Original entry ownership and mixed-history Keep/Edit/
Forget semantics are unchanged.

`memory.note` and `memory.proposeUser` compare the Gateway operation context's
binding to current state under the memory write transaction. A change while waiting
returns `stale_environment` without a memory/proposal row. This does **not** yet
fence a Node's old-generation request arriving after a change: the Node protocol
still needs expected binding generations at all effect boundaries. No switch API
is exposed by this change.

**Remaining integration:** the existing project-deletion planner still uses its
legacy session set. Before exposing cross-project moves, it must classify by these
frozen origins (including moved/deleted writers) and require explicit review when
historical evidence is insufficient. Do not turn a stored snapshot into a grant or
claim that provenance capture alone implements safe project moves.

## Mode-field inventory and preservation

Inventory source: `crates/pirc-protocol/src/mode.rs`. No field or safety validator
is removed in this slice.

| Fields                                             | Current consumers / target responsibility                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`, `label`, `description`, `ui`                 | Catalog, Gateway directory and Web/Android modes; identity/presentation, not authority                               |
| `workdir`                                          | Node chat/app/runner and checkpoints; retain workspace vs per-session working directory until a supported transition |
| `prompt`, `body`                                   | Agent config/prompt assembly; future attributed active rules, never reinterpret retained history as current policy   |
| `features_on`, `features_off`, `tools`             | Agent config/loop/features and tools; availability filters remain enforced, including PTC                            |
| `assistant`                                        | Gateway agent operations and Agent assistant feature; existing user/full scopes remain distinct                      |
| `delegate`, `delegate_target`                      | Gateway delegations/dispatch and Agent teams; no scope expansion or implicit target access                           |
| `schedule_scope`                                   | Gateway schedules; preserve own/any restriction and delegation requirement                                           |
| `project_instructions`, `project_files`            | Node chat/app/project-files and Gateway resource routes; preserve current project access                             |
| `project_config`, `repository`, `workspace_memory` | Node runner/side/workspace-memory/checkpoints and Agent config; preserve trust, repository and memory constraints    |
| `recap`                                            | Agent context construction; no new personal-history access                                                           |
| `delete_sessions`, `projects`                      | Gateway/Node deletion and project management; preserve mode restrictions and tombstones                              |

The full-assistant/workspace, delegate/delegate-target, repository/project-files,
workspace-memory/repository and schedule-any/delegation validations remain.

## Remaining U2 implementation and gates

1. Persist immutable resource provenance and consume frozen memory origins in the
   cross-project deletion planner with explicit legacy review. Historical unknown
   provenance stays unknown. Add pending/acknowledged transitions, not just configuration.
2. Carry expected membership/binding versions through affected client and Node
   commands, approvals and effect boundaries. Old clients cannot bypass changed
   authority. Runner epoch and device control remain independent inputs.
3. Implement joining/moving/departure only with U4 revocation of actual project
   resources, retaining original conversation context and protecting other writers.
4. Exercise the complete transition across Node disconnect/restart, project deletion,
   checkpoints and memory provenance. The current adapter/read-model tests do not
   prove those effects.

Local validation and the reproduced pre-change macOS memory-counter snapshot
difference are recorded in the [U2 checkpoints](unified-conversations.md#u2-implementation-checkpoint-project-membership-and-configured-policy-2026-10-27). Physical
Android process/Keystore/MethodChannel and deployment/rollback acceptance are not
claimed by JVM or synthetic process checks. UI redesign stays deferred; no remote
push, deployment or Release is part of this slice.
