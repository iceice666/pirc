# Conversation binding migration (U2)

[Unified conversations](unified-conversations.md) · [Execution contracts](conversation-execution-contracts.md)

Status: U2 started locally, 2026-10-27. Schema 1021 delivers the durable legacy
association adapter below. Independent project membership, mode-policy snapshots,
authority fences and environment transitions remain to implement. No new mount,
move, grant, process restart or first-send activation is enabled by this slice.
The U1 implementation/activation gates remain separate from continued U2 work.

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

**Boundary:** these revisions identify the relationship, not all mutable policy.
Editing a mode file under the same ID or changing workspace capabilities still
uses the existing catalog/current-policy checks. Generation 1 is not proof of
Node-installed sandbox policy. There is no new client command precondition or
old-client authority fence yet; U4 must install those before exposing transitions.

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

1. Persist explicit project membership separately from the legacy association,
   including detached and unavailable-catalog cases. Joining/moving/departure stays
   unavailable until U4 can revoke project resources. Keep original context.
2. Add immutable policy/resource provenance and a read model for current versus
   pending/acknowledged bindings. Persist membership at new memory write time;
   historical unknown provenance stays unknown. Do not rewrite existing memory.
3. Carry expected membership/binding versions through affected client and Node
   commands, approvals and effect boundaries. Old clients cannot bypass changed
   authority. Runner epoch and device control remain independent inputs.
4. Test conflicts, restart, missing/changed modes, same-ID policy reloads, pending
   first Send, project deletion and checkpoint recovery across the full transition.
   Existing unchanged session behavior is only the migration baseline.

Local validation and the reproduced pre-change macOS memory-counter snapshot
difference are recorded in the [U2 checkpoint](unified-conversations.md#u2-implementation-checkpoint-durable-legacy-binding-versions-2026-10-27). Physical
Android process/Keystore/MethodChannel and deployment/rollback acceptance are not
claimed by JVM or synthetic process checks. UI redesign stays deferred; no remote
push, deployment or Release is part of this slice.
