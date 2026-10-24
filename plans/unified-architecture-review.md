# Integrated unified-conversation architecture review

[Plans](README.md) · [Product plan](unified-conversations.md) · [Execution contracts](conversation-execution-contracts.md) · [Library extraction](pots-and-library-extraction.md)

Review date: 2026-10-24. Scope: Chat/Work unification, projects/tasks/resources,
pots, independent clients and reusable Rust foundations, including their links
to current modes, mobile, memory deletion and checkpoints. This is a review of
that architecture family, not a claim to revalidate every historical plan or
all running code. The fetched `origin/main` baseline is `aca6eeb6`.

The user authorized this review, corrections and, after verification, a pull/rebase
and push of the local repository commits. That permission does not implement the
new architecture, change deployment permissions, replace Web, publish crates or
create a release. Existing App fixes in the unpublished commit range need their
own relevant verification; document checks alone do not validate those changes.

## Review outcome and corrected contradictions

The product direction is coherent after the corrections below. It can be published
as a planning baseline with explicit implementation gates. It is not yet a complete
implementation specification, and no sandbox/client guarantees are considered
verified merely because they are written down.

| Finding                                                                                                           | Correction                                                                                                                                                             | Acceptance/reference                                              |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Task required an originating conversation, but tracking a pots suggestion must not create an empty work session   | Separate immutable request/suggestion origin, record owner and optional execution conversation; first authorized dispatch creates/maps the execution conversation once | Task lifecycle in the main plan; P7-2/P7-3 in execution contracts |
| A conversation can move projects, but deletion could classify all its memory using today's membership             | Record write-time membership generation for new memory versions/proposals; keep stable original-entry/session provenance and review insufficient legacy evidence       | Memory deletion contract and L5-3                                 |
| Project deletion could internally invoke single-chat memory deletion and undo its mixed-history Keep/Edit choices | Project deletion owns one memory cleanup plan; child session cleanup uses that scope and cannot run a second standalone memory purge                                   | L5-3, including crash/retry and moved conversations               |
| Default-off OAuth was labelled undecided while the feature-test gate assumed it was chosen                        | Keep the packaging choice proposed; test the selected feature matrix, including both OAuth states if that proposal is chosen                                           | Library packaging table and API proof gates                       |
| Earlier “keep local/no push” status could be mistaken for the current publication instruction                     | Record the latest review/rebase/push authorization separately from unchanged planning-only implementation scope                                                        | Status paragraphs in the plans                                    |

Other apparent tensions were checked and are intentional distinctions:

- Leaving removes project-derived grants; an independent disclosed file grant can
  survive. Explicitly blocking a folder overrides overlapping grants. This is not
  permission to retain ambient broad reads as a fictitious independent grant.
- Retained context does not promise erasure of previously read data. Fresh resource
  access, known managed cache cleanup and explicit deletion have separate contracts.
- Archive, pause coordination, takeover, stop and deletion have different effects.
  Taking over one task does not kill unrelated work or silently resume stopped work.
- Same visible conversation does not require one surviving OS process. A Node
  switch does not move files, profiles, external effects or recovery authority.
- Reusable-loop extraction supplies mechanics. Project permissions, product tasks,
  memory ownership, provenance and pots authority remain in the pirc host.

## Product settings still needing a concrete choice

These do not block publishing the plan. Settle them before the corresponding
implementation/default is enabled; do not ask the user to reconfirm already
adopted behavior. Recommendations in this table are proposals, not newly applied
permissions or settings.

| Choice                                               | Recommended proposal to review                                                                                                                                                             | When needed                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Initial cwd and mount permissions                    | Choose the main folder explicitly; show its read/write scope. Default additional folders to read-only unless explicitly granted writes; preserve existing grants on migration              | Workspace-creation/settings slice                      |
| Managed empty-folder allocation                      | Keep choices in a draft; allocate at first accepted send unless the user explicitly invokes Create folder. Never delete an explicitly created user work folder on draft abandonment        | Draft/workspace-creation slice                         |
| New shared notes/board retention and editing presets | Keep durable notes until explicit removal; separate operational board retention from notes, and show exact editor scopes. Do not invent an automatic destructive retention period          | Project collaboration storage/settings slice           |
| pots initial observation/execution scopes            | Start from user-selected scopes, distinguish progress from full content, and suggest without autonomous dispatch unless an explicit request or standing grant permits it                   | pots onboarding/activation                             |
| pots spending/concurrency and notification values    | Configure finite budgets and bounded concurrency before enabling proactive runs; use quiet digests for nonurgent suggestions. Exact amounts, quiet hours and cadence still need a proposal | pots activation and settings                           |
| App sign-in and server exposure                      | Review account/bootstrap and management security separately; preserve independent-client requirements and existing authorization meanwhile                                                 | Native independent onboarding, explicitly deferred     |
| Flutter Web                                          | Compare a measured vertical slice with the existing Web client before deciding whether to migrate                                                                                          | Optional later evaluation, explicitly deferred         |
| Reusable-crate packaging/names                       | Review the working `pirc-llm-types`, `pirc-llm`, `pirc-agent-loop` names, optional OAuth/defaults and feature layout as one bounded packaging proposal                                     | Before extraction; no crates.io publication is implied |

The user does not need to choose Rust boxing, lock algorithms, database column
names or every task-classification heuristic. Implementers should propose/test
those within the adopted contracts. Public licensing/external publication is a
separate later owner decision, not a prerequisite for publishing this repository
planning work or considering path dependencies.

## Engineering specifications and proof gates still missing

| Gate                                           | Concrete deliverable and practical limit                                                                                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation/task identity and state ownership | Map existing Node-local/composite session IDs to stable conversation/task identities, history segments and owners; preserve old links and first-send/retry semantics. A tracking-only task needs no execution session                                            |
| Cross-host context custody                     | Specify who journals/exports the authorized history and interruption point before worker retirement. No fresh response with complete history is promised if neither an authorized runtime nor required context is available; cached reading/drafts remain useful |
| Real resource revocation                       | Platform-specific proof for open descriptors, child processes, shells, aliases and unrestricted paths, plus host acknowledgements. Pending/offline is not completed revocation; unsupported arrangements must fail visibly                                       |
| Distributed transitions and event ordering     | Persist command/result identities, binding/control generations, snapshot/event handoff, crash receipts and timeout/unknown outcomes. No exactly-once guarantee for arbitrary external side effects                                                               |
| Multi-agent coordination                       | Specify wait wake-ups, fairness/deadlocks, ownership and stale-edit handling; test external edits and multiple Nodes sharing storage. Per-Node leases/checkpoints are not a universal filesystem lock                                                            |
| Project movement and deletion                  | Design immutable write-time provenance, project-level versus chat-level cleanup scope, legacy classification and reference ownership. Exercise mixed histories, concurrent edits, restart and retained recovery evidence                                         |
| Client/content migration                       | Preserve upload ownership and legacy restrictions, account-separated caches, live file identity and deletion reconciliation; keep real phone/IME/background-push acceptance distinct from local tests                                                            |
| pots triggering and bounded execution          | Define occurrence/deduplication keys, evidence freshness, task-link transactions, control races and concurrent budget accounting; prevent retries or bots from manufacturing new authority                                                                       |
| Rust extraction compatibility                  | Prototype local/Send use, streaming/cancellation/resume/error boundaries and feature combinations; preserve old serialized bytes, transport routing and pirc event order before deduplicating implementations                                                    |
| Upgrade and rollback                           | Inventory old data/client/Node versions, validate restart-safe migration on representative large histories and retained work, and name the supported rollback data version; a UI revert is not a database rollback                                               |

These gates are dependencies of implementation stages, not ten new approval forms.
A gate is complete only with the specified design/evidence, not by updating its
checkbox. Initial mount defaults, retention amounts and pots settings must not be
smuggled into engineering work as though the user had already chosen them.

## Suggested bounded first implementation proposal

Before changing code, present one small delivery: define the resource/capability
and identity contracts with compatibility fixtures, then apply them to a selected
same-conversation workflow. Keep provider extraction independently reviewable;
do not make full loop extraction, Flutter Web migration or a new auth mechanism
prerequisites for every product change. A default that changes access or deletion
behavior needs its corresponding product choice first.

Current fixed Chat/Work tabs describe shipped navigation; they are not the desired
end state. Existing modes/mobile backlog remains available, but further old-layout
UI expansion should be assessed against the unified contracts. This does not close
existing security, rendering, physical-device or push acceptance gaps.

## Verification scope for publication

Repository publication should check Markdown formatting, local links/anchors,
scenario numbering, and the final diff; verify the included App fixes through
relevant existing automated tests/static analysis after integration. Do not start
new runtime architecture implementation to make this review appear complete.
Record actual command results separately from the future acceptance scenarios.

### Verification performed before push

After `git pull --rebase origin main`, the branch was up to date with baseline
`aca6eeb6` and had no integration conflicts. At `311b995a`, the included App changes
passed `flutter analyze --no-pub` and **230 tests** across these existing suites:

- `html_keyboard_events_test.dart`
- `browser_parity_test.dart`
- `terminal_parity_test.dart`
- `timeline_parity_test.dart`
- `document_absolute_position_test.dart`
- `document_absolute_basis_test.dart`
- `document_live_runtime_dialog_author_position_test.dart`

Tests used `flutter test --no-pub --concurrency=2 --reporter=expanded` in
`apps/android`. These verify the included keyboard protocol/localized error and
modal-positioning changes, not the future architecture. No emulator or Chrome
instance was started. Only this run's newly created `build/native_assets`,
`build/test_cache` and `build/unit_test_assets` were removed; pre-existing releases
and parity artifacts were preserved.

Markdown formatting, local references/heading anchors, the 32 numbered future
acceptance cases and diff whitespace were checked. This verification record changes
no runtime source. Release publication and new architecture implementation remain
outside the current request.
