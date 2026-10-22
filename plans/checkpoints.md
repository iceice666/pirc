# Agent checkpoints and safe recovery

[Plans](README.md) · [Session UI](../docs/guides/session-ui.md) · [Tools](../docs/guides/tools.md)

Status: phase 1 safety spike implemented locally, 2026-10-22. The user authorized
phase 1 only; production capture, recovery APIs and Web/native Flutter Android
actions remain proposed. Multiple agents and preservation of both existing and
later user changes are hard requirements. Keep work local; no deployment, remote
push or Release is authorized. Integrate the independent memory update last,
after the user requests rebasing onto its published changes.

## Product decision

Recover a selected agent change **against the current workspace**, retaining
unrelated changes, rather than replacing the workspace with an old snapshot.
The default action builds a **new recovery workspace**; the original directory,
Git index, refs, user changes and running agents remain untouched. The user can
review the result and explicitly open a session in that workspace.

This is a deliberate safety boundary. A hash check followed by atomic rename is
not a filesystem compare-and-swap: an editor can write between those operations.
An in-process lock, advisory file lock or filesystem watcher does not stop an
uncooperative editor, terminal or another host. The first release therefore has
no automatic in-place restore or force-overwrite button. In-place publication
would need a separately reviewed design with an enforceable writer boundary;
it is not a hidden final step in this proposal.

The original workspace is never renamed, deleted, reset, stashed, staged,
committed or cleaned as a side effect of preparing or opening a recovery.

## Existing behavior and integration points

- `crates/pirc-node/src/write_broker.rs` coordinates overlapping paths between
  sessions within one node. Ownership is a session id, and a lease lasts until
  its run settles, exits or stops. It is not a per-operation or cross-node lock.
- `crates/pirc-node/src/runner/side.rs::grant_write` answers agent write requests.
  `crates/pirc-agent/src/agent.rs::acquire_write` and `tools/files.rs` use them.
  The current edit tool reads/computes its replacement before acquiring the
  lease; `write_checked` checks paths but does not compare a content revision.
  A checkpoint broker must coordinate read/transform/write and reject stale
  preimages, rather than merely add a snapshot around the existing final write.
- Teammates/subagents forward write requests through the parent in
  `features/team/broker.rs`. They share the parent's sandbox and lease authority;
  that does not establish exclusive per-agent ownership of a file.
- Bash, PTC, background jobs and the interactive terminal can change files.
  PTC's operation exclusivity is not a global filesystem transaction. A watcher
  supplies invalidation, not trustworthy writer identity or complete history.
- Web's `components/panel/{GitTab,DiffView}.svelte` and Android's
  `lib/live/{git_state,git_pane}.dart` provide existing diff/navigation patterns.
- Editing a message or switching conversation versions currently changes
  context only. This remains a separate action; it must not implicitly recover
  files or rerun tools.

These are confirmed code facts, not assumptions to replace with a new lease
model without review.

## Safety invariants

1. **Dirty baselines count.** Capture actual file bytes before the agent writes,
   including saved user changes not committed to Git. `HEAD` is never the sole
   baseline. Staged and unstaged state are distinct; recovery does not modify
   the original index. Unsaved editor buffers are not visible to the node and
   cannot be claimed as captured; the editor's original workspace stays intact.
2. **Only attributed effects are candidates.** A timestamp, Git diff or shared
   session id alone does not prove that a change belongs to Agent A. Uncertain
   changes are identified as uncertain and receive no automatic inverse.
3. **Later writes survive.** Recover by an inverse three-way merge with the
   latest observed content. A later write to the same hunk becomes a conflict;
   it is not silently replaced with the baseline.
4. **Source stays unchanged.** Read the source workspace, create results in a
   fresh node-owned destination, and publish that destination only after its
   journal reaches `ready`. Never use hard links to mutable source files.
5. **A preview is versioned.** A preview describes exactly which checkpoint,
   paths/hunks and observed source version produced it. Source changes make it
   stale and require a new preview; stale state is visible across clients.
6. **Unknown means unavailable.** Missing objects, interrupted captures,
   incomplete process quiescence, unsupported files or untrusted workspace
   identity produce an explicit gap/conflict, not an empty or successful restore.
7. **Recovery is recoverable.** Jobs have durable states, retained inputs,
   idempotency and crash cleanup. No half-built output is exposed as a usable
   workspace. A recovery never deletes its own source evidence.

## Multi-agent behavior

### Shared directory: group attribution

Existing sessions may continue to share their current execution arrangement.
A turn checkpoint includes the parent and all descendants whose writes belong
to that run, identified by node-issued run/group ids. A turn is stable only when
all writers and relevant background work have ended or are explicitly quiesced.
Returning a model response or a child result does not establish this condition.

Direct `write`/`edit` operations can record exact pre/post blobs and writer ids
at the write boundary. Interleaved operations are serialized and journaled by
the trusted node broker, with stale-base rejection. Hook-rewritten arguments,
PTC calls, parent and child tools use the same final-operation boundary.

Arbitrary shell commands, daemons and a user's editor can still write outside
that boundary. A shared-directory before/after scan is therefore **observed
change**, not proof of individual ownership. Do not label the difference as
Agent A's reversible changes merely because A's command was running. Such a
checkpoint can supply evidence, but uncertain files stay current in an
automatically prepared result and require explicit review.

### Independent parallel agents: isolated execution

For reliable agent-specific checkpoints, offer node-created isolated execution
workspaces. Start each agent from a captured version that includes the user's
existing dirty files. Each workspace has one writer group; children either join
that group or receive their own isolated root. Changes from one isolated agent
are proposed for integration and never copied into another agent's directory
automatically.

The workspace factory must use existing workspace authorization, trust and
sandbox construction. Do not let an agent choose an arbitrary new writable
root. Shared mutable `.git` metadata, writable alternates and hard-linked files
cannot allow one agent to modify another workspace. An independent checkout/copy
is the safe starting implementation; a Git worktree optimization requires a
separate verified metadata boundary. Neither operation changes user branches or
the original index.

Copy/checkout preparation must not run repository hooks, smudge filters,
submodule initialization or project scripts implicitly. Re-evaluate content-hash
trust before running anything in the candidate. Respect effective sensitive
path/deny-read policy during capture and copy, and preserve equivalent restrictions
at the new root: moving a protected file into a newly allowed path must not
bypass the sandbox. Validate this before enabling recovery continuation.

Within shared directories, extend coordination to all cooperating nodes on the
same host/account, using canonical physical-root identity and an account-level
broker/lock with fencing generations. Include parent/child writers and pirc
panel writes, not just the main agent. PID reuse is not ownership. Do not
advertise this as protection against external editors or network-filesystem
writers on other hosts. Overlapping/aliased roots and unverified multi-host
shared storage must be rejected for exclusive capture or marked observational.

### Required scenarios

| Situation                                              | Required result                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| User already changed a file before A starts            | A's baseline includes those bytes; recovery keeps them.                                                 |
| A edits one hunk; the user later edits another         | Merge A's inverse into current content in the recovery workspace; retain the user's hunk.               |
| A edits a hunk; the user later edits the same hunk     | Conflict. Preserve current bytes until reviewed.                                                        |
| A and B edit different hunks from known versions       | Recover only A's inverse; retain B's hunk.                                                              |
| B changes code introduced by A                         | Dependency/conflict review; no automatic removal of B's work. A clean text merge is not semantic proof. |
| Children share a directory and shell writes interleave | Group/uncertain attribution; no invented child ownership.                                               |
| Another device confirms the same recovery              | Return the same job/workspace; do not create or apply it twice.                                         |
| Source changes while a result is being prepared        | Original remains untouched; mark result stale and require refresh/review before continuation.           |

## Capture and storage

The node owns checkpoint blobs, manifests, operation journal and recovery jobs
under its private state directory. The agent sandbox must deny this storage,
including through the existing same-account daemon registry. The Gateway owns
authentication/routing and optional lightweight UI metadata; it is not the
authority for filesystem snapshots. Never send full checkpoint contents to a
model by default.

Suggested model (allocate schema/protocol versions during implementation):

- **Checkpoint:** id, owner, node/workspace identity, session/conversation branch,
  run, writer group, parent checkpoint, manifest revision, coverage and state
  (`capturing`, `stable`, `observational`, `incomplete`, `expired`).
- **File version:** path id, relative path, file kind, exact content digest,
  executable bit, size and blob reference; explicit `absent` state.
- **Operation:** node-issued actor/run/parent/tool ids, order and dependency
  edges, pre/post versions, effect status, verified or observational attribution.
- **Recovery preview/job:** owner, source/target checkpoint ids and revisions,
  selected file/hunk ids, observed source fingerprint, merge outcome per file,
  idempotency key, job revision and output identity.

Content-addressed blobs deduplicate identical bytes and can use bounded
compression. Save objects durably before committing their manifest references.
Preserve exact bytes/line endings; text diffs are a presentation layer. File
identity includes type and mode, not just a digest of textual content.

Default coverage: regular Git-tracked files and non-ignored untracked files
within the authorized root. Capture eligible nested directories without
crossing symlinks, mounts or nested repositories silently. Exclude `.git`, node
state, caches, dependencies/build output and configured sensitive files. Report
every exclusion relevant to a change; tracked secrets still make captured blobs
sensitive. Never promise that an ignored/oversized/unreadable file is protected.
Non-Git directory workspaces use the same manifests with explicit exclusion
rules and a recovery copy rather than a fabricated Git history.

Use bounded scans/streaming hashes, quotas and a visible coverage summary.
If an unmanaged source cannot provide a coherent capture, label it
observational; repeated hashes/watch events do not prove a multi-file atomic
snapshot. File changes between capture and preview invalidate the affected plan.

Proposed initial retention: 7 days, 100 stable checkpoints per workspace, a
1 GiB node-wide checkpoint budget, and a 10 MiB automatic per-file capture limit,
all configurable. Enforce the first applicable limit and show excluded files or
capture suspension. Keep an active run, pinned checkpoints and live recovery
inputs; if those fill the budget, suspend new captures visibly instead of
evicting them. Recovery workspace copies count against a separate displayed
disk reservation; refuse preparation before disk exhaustion. They are never
automatically deleted after a user has opened/modified them. Final defaults are
reviewable before implementation.

Deleting a session removes its checkpoint manifests and unreferenced blobs,
subject to references retained by another explicitly created recovery workspace
or job. Show those dependencies before deletion; do not silently destroy an
active recovery or a workspace containing new user edits. Cleanup, export and
backup guidance must treat checkpoint contents as private workspace data.

## Recovery algorithm

For one selected coherent checkpoint/range, compute its **net attributed
change** once; do not apply both a child operation and its parent aggregate.
Arbitrary overlapping multi-turn selection is deferred until dependency closure
can be validated.

For each selected text file:

```text
before = version before the selected agent change
after  = version after that change
current = latest observed source version
candidate = three_way_merge(base=after, ours=current, theirs=before)
```

Only clean, attributed inverses are included automatically. Retain current
content in conflicted output paths and keep before/after/current/candidate
versions separately in the trusted recovery store. Do not insert conflict
markers into source files or hide unresolved conflicts behind a success label.
A clean merge means textual compatibility, not that later code still works;
show dependency warnings and offer existing permitted test workflows.

- **Agent-created file:** remove from the recovery candidate only when current
  kind/content/mode exactly equal the agent's post-version. Later edits conflict.
- **Agent-deleted file:** recreate only if the current path is still absent and
  no directory/symlink/path collision exists.
- **Binary file:** exact post-version match permits inverse in the candidate;
  any later difference requires review. No text merge.
- **Rename/move:** operate on verified path history and both endpoints; Git
  similarity is display-only. Unknown ownership or occupied destination conflicts.
- **Directories:** never recursively delete unknown current contents. Build
  results from validated entries and keep unrelated files.
- **Symlinks, hard links, submodules, permissions/ACLs and special files:** no
  traversal or implicit recursive restoration. Start with ordinary files and
  executable bits; unsupported kinds remain explicit exclusions. Copies break
  hard links and never restore setuid/setgid or arbitrary ownership metadata.

Prepare results in a fresh unpublished destination. Preserve all eligible
current source files, including unrelated current untracked files, then apply
the validated inverse there. A source change or lost node/control authority
invalidates the job's acceptance revision. Interrupted copy/merge jobs remain
unavailable and can be retried idempotently or cleaned by their exact job id.

Before **Continue in recovery workspace**, revalidate the source observation,
job revision, conflicts and workspace trust. If the original has advanced, do
not present an old copy as containing its latest changes: refresh the candidate
against the new source or keep it as an explicitly historical copy. Opening the
result creates an authorized workspace/session linked to its source checkpoint;
it does not retarget a live runner or replay tool effects. Preserve origin and
untrusted-data provenance when transferring any conversation context.

## Service/API sketch

Route through existing authenticated session/workspace access and node requests.
Paths/names below are a proposal, not an API compatibility promise:

- `GET .../checkpoints`: paginated metadata/coverage and writer groups.
- `GET .../checkpoints/:id/diff`: bounded selected changes and attribution.
- `POST .../recoveries/preview`: checkpoint revision, opaque file/hunk selections;
  returns an expiring owner-bound preview id, source fingerprint and conflicts.
- `POST .../recoveries`: preview id/revision + idempotency key; starts preparation
  of a new workspace. The client cannot substitute arbitrary paths or blobs.
- `GET .../recoveries/:id`: authoritative job state and remaining conflicts.
- `POST .../recoveries/:id/continue`: explicit user intent plus current revision;
  revalidates and creates/opens the linked workspace/session once.

States: `previewing → review_required/ready → preparing → ready_to_continue →
continued`, with explicit `stale`, `failed`, `cancelled` and `expired`. Use distinct
preview/job state types so `ready` cannot mean both preview and usable output.
Return 409/current state for stale revisions; repeated requests return the
existing outcome. Nodes enforce authorization, root identity and journal state
again even when Gateway validation passed. A recovery is a user-only operation
in the first release; agents can report checkpoints but cannot approve recovery,
change retention or discard conflicts. Paired devices require the normal owner
and control rules; do not broaden short-lived management grants.

Owner-scoped invalidation makes Web/App refresh the authoritative job. A second
device's confirmation closes/disables the first device's stale action. Re-pair,
account changes, session switches and node reconnects fence old requests and
cached file contents. Node offline means metadata can be viewed if cached;
recovery actions are disabled and never replayed from an offline mutation queue.

## Web and native Android experience

Use the current pirc typography, colors, buttons, diff views and dialog/sheet
conventions, with English defaults and Traditional Chinese translations.

1. **Conversation entry:** a subtle checkpoint action on a completed user turn
   or run card, with coverage and parent/child group information. Incomplete or
   observational captures explain their limits instead of showing a green badge.
2. **Workspace history:** a Checkpoints section in the existing Git/changes
   panel, also accessible in non-Git workspaces. Filter by session/run/agent;
   distinguish individual verified effects from a shared writer group.
3. **Preview:** files marked safe inverse / retains later edits / conflict /
   excluded. Show original user baseline, agent change, current content and
   proposed result. Text such as “Current changes retained” must reflect the
   actual merge outcome, not merely an unchanged Git status.
4. **Action:** **Prepare recovery workspace**, with estimated disk usage and
   the statement that the current workspace is retained. Review unresolved files
   explicitly; default is to keep their current content.
5. **Result:** **Continue in recovery workspace**, **Open original**, and a
   link to the recovery's origin. Display stale/newer-source state before opening.
   Deleting an unused generated workspace has its own reviewed action.

Desktop Web/tablet uses file list plus diff/review pane. Phone Web and Flutter
use a full-height native review route/sheet with a file selector and Before /
Agent / Current / Result views. Provide keyboard-accessible controls on Web,
native scrolling, code highlighting and accessible status text on Android.
Large text, keyboard/IME, landscape and safe areas must not hide the action or
conflict state. Preserve selection/draft on reconnect; never store private blobs
in browser localStorage or notification payloads.

Recovery is independent of **Edit message / Save and regenerate**. A later
combined workflow would need an explicit choice and separate confirmation; the
first release never undoes files merely because a conversation branch changes.

## Implementation phases and acceptance

1. **Safety spike and fixtures.** Confirm file-effect hooks, descendant/process
   lifetimes, sandbox roots, same-host cross-node coordination and disk costs.
   Add a synthetic dirty workspace with user/A/B changes. Prove the inverse
   algorithm and the unchanged-source invariant before adding product actions.
2. **Node capture/journal.** Blob store, dirty baselines, trusted actor/group ids,
   coverage, retention and crash behavior; direct file tools plus explicit
   observational shell coverage. Do not claim individual parallel-agent recovery
   until isolated execution/root boundaries have passed acceptance.
3. **Safe preparation and isolation.** Recovery workspace factory, inverse
   merge, conflicts, idempotent durable jobs and isolated agent execution needed
   for full per-agent coverage. Inspect sandbox/trust and `.git` metadata behavior
   on Linux and macOS; allocate schema/protocol changes and mixed-version errors.
4. **Gateway and both clients.** Authorization/routing, invalidation, Web and
   native Flutter entry/history/preview/result UI, translations and parity.
   Phases 1–3 can be locally reviewed, but delivery is not complete with one client.
5. **Integrated acceptance.** Conformance plus actual filesystem concurrency,
   process crashes/restart, node disconnect/reconnect, two clients confirming,
   and real Android review/continuation when a device is available. Document any
   unverified platform behavior rather than marking it covered by unit tests.

### Phase 1 results and implementation gates

The executable experiment is
[`checkpoint_safety.rs`](../crates/pirc-node/tests/checkpoint_safety.rs), with a
test-only [helper](../crates/pirc-node/tests/checkpoint_support/mod.rs).
Neither file is linked into the node executable. There is no new API, database
schema, automatic checkpoint, sandbox permission, background capture worker or
memory/session-history integration. Runtime behavior remains unchanged.

**Code audit, reconfirmed against the current Rust implementation:**

| Boundary                      | Finding                                                                                                                                                                                                                 | Required before product capture                                                                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct writes                 | `tools/files.rs::EditTool::run` reads and transforms before `acquire_write`; `write_checked` checks paths and uses `O_NOFOLLOW`, but does not compare an expected file revision.                                        | Put preimage capture, stale-base rejection, final authorized mutation and postimage evidence at the trusted node boundary. Existing hooks or leases alone are insufficient.                                            |
| Child ownership               | `features/team/broker.rs` forwards child `write_lease` through the parent's acquire callback.                                                                                                                           | Node-issued run/group/operation identity; do not infer the child writer from the parent session lease.                                                                                                                 |
| Run completion                | `runner/process.rs` releases leases on `agent_settled`. `features/background/mod.rs` explicitly allows background tasks to survive run abort; session closure stops them. Panel terminals have a separate PTY lifetime. | Account for descendants, PTC, background tasks and terminals. Require quiescence or report observational/incomplete coverage. A model response is not the boundary.                                                    |
| Process cleanup               | Agent bash uses `GroupGuard`; node host commands use their own process session; runner exit kills its process group.                                                                                                    | These contain ordinary descendants but are not proof that detached processes or external editors have stopped. Test their lifetimes separately from run settlement.                                                    |
| Cross-node writes             | Each `Node` constructs a separate in-memory `WriteBroker`. Two broker instances grant the same canonical physical root concurrently in the experiment.                                                                  | Account-level coordination and fencing for cooperating nodes, including alias/nested-root handling. Until then, no cross-node exclusive-capture claim. Multi-host shared storage remains outside exclusive guarantees. |
| Private storage and new roots | The daemon registry includes the node state directory in private paths. Linux/macOS policy-generation tests deny a prospective `state/checkpoints/blob`; the original session cannot write the new recovery root.       | Keep blobs under private registered state. Reauthorize a new workspace and translate effective deny rules before continuation. A copied file is not automatically safe to reopen.                                      |

**Safety experiments: 25 passed on macOS arm64.** They exercise:

- Actual disposable Git repositories with distinct committed, staged, unstaged
  and untracked user bytes. Preparing the inverse preserves the source's bytes
  and the complete observed Git metadata tree, including index, refs and HEAD.
- A/B edits in different hunks and both orders; later user edits remain. Same-hunk
  edits and B modifying A-introduced lines keep current bytes and report conflict.
  Unattributed shell/shared-child effects are retained for review.
- Exact create/delete postimages, occupied deleted paths, directory/type changes,
  binary differences, CRLF, missing final newline and executable bits. No conflict
  markers are written to either source or conflicted candidate files.
- Sensitive paths, newly added deny rules, ignored-fixture directories, symlinks,
  hard links and oversized files remain explicit exclusions. No traversal into
  linked external data, copying of `.git`, hooks/filters, source hard links or
  privileged permission bits occurs in the fixture preparation.
- A deterministic external write at the old check/rename race point and an
  independent shell process writing during preparation. The source retains the
  writer's result and the candidate is stale. Replacing the source root with
  identical bytes is detected using device/inode identity as well as its path.
- Capture byte/entry limits, copy budget rejection before destination allocation,
  non-quiescent group refusal, and injected failure cleanup of only the temporary
  candidate. Source observation errors fail the preparation rather than imply an
  empty or successful snapshot.

The existing host-command process-group cleanup test and nine background-task
lifecycle tests also pass (35 tests total for this round). Focused Clippy with
warnings denied, Rust formatting, plan formatting and diff whitespace checks
pass. These results cover the test-only experiment and the stated existing
lifecycle contracts, not a complete checkpoint product.

**Capacity experiment:** three 4 KiB files need a 12 KiB independent recovery
copy. Across baseline/A/current/candidate there are 12 KiB of unique content in
this fixture: prospective blob deduplication does not remove the additional
12 KiB copy cost. These are logical content sizes, not filesystem allocation,
compression, journal or metadata estimates. The helper implements no durable
blob store. Its 1 MiB/file, 4 MiB/capture and 1,000-entry bounds are test limits,
not the product defaults below; physical space reservation/ENOSPC still needs
implementation and acceptance.

**Limits:** the helper only walks test-owned trees with explicit fixture
exclusions; it does not implement production Git-ignore resolution, a hostile
filesystem descriptor walker, mount/nested-repository detection or a coherent
multi-file snapshot. The fixture supplies verified attribution and group
quiescence; no live node currently produces that evidence. The standalone
`git merge-file` experiment uses `base=after, ours=current, theirs=before`; a clean
text merge is not semantic dependency analysis. Rename attribution, persistent
journals, crash/power-loss recovery, actual Seatbelt/bubblewrap execution for
these candidates, continuation, client UI and Linux runtime acceptance remain
later-phase work. No Nix build is required for this phase at the user's request.

Reproduce from the repository root (requires the existing host Git executable):

```sh
cargo test --locked -p pirc-node --test checkpoint_safety
cargo test --locked -p pirc-node --lib runner::host::tests::an_aborted_command_leaves_nothing_running
cargo test --locked -p pirc-agent --lib features::background::tests
```

Phase 2 can build the trusted capture/journal and operation identity from these
contracts; it must not expose recovery as ready merely because these fixture
experiments pass. Keep memory lifecycle changes until the independent memory
work is published and explicitly integrated.

Required tests include:

- Dirty tracked/staged/untracked user files, exact bytes/CRLF and executable bits.
- User edits before/during/after A; B before/after/interleaved with A; parent and
  children, direct tools, PTC, shell background processes and terminals.
- Overlapping hunks, later dependencies, re-created deleted paths, edited newly
  created files, binary/move/type collisions and excluded/sensitive files.
- Two nodes on one physical root; canonical aliases/nested roots; unsupported
  shared multi-host filesystems refuse exclusive guarantees.
- Source changes after preview, during copy and before continuation. Verify
  original bytes, index and refs remain unchanged by the recovery process,
  including when an external editor writes at the old check/rename race point.
- Repeated/opposite/stale client actions, expired preview, account re-pair and
  cross-owner ids; no arbitrary-path or agent-chosen blob restoration.
- Kill after each durable job transition, full disk, quota, missing/corrupt blob,
  cancellation, cleanup and restart; never expose partially prepared output.
- Session/project deletion, retained recovery references and blob GC. Never
  delete an opened workspace's later edits under an automatic retention policy.
- Same fixtures/results on Web and Android, phone/tablet, both themes, large
  text, keyboard/landscape and stale/offline UI. No embedded WebView.

Implementation stays local until explicitly authorized otherwise. Each phase
gets its own reviewable commit. Remove disposable test/build/copy outputs after
verification, keeping user recovery workspaces, pinned checkpoints, deliverable
APKs and necessary review artifacts.

## Proposed defaults for review

- Opt-in per workspace initially; show coverage before enabling capture.
- All original and later user changes are retained; default result is a new
  workspace. Automatic in-place publication is outside this first release.
- Completed run/turn is the user-facing checkpoint unit; per-tool versions are
  internal evidence. Shared teams are groups unless actor attribution is proven.
- Require isolated execution for independently recoverable parallel agents.
- No Git-history/index rewriting, external API/database/deployment rollback,
  system-wide backup or recovery of pre-feature history. Existing history has
  no retroactively invented checkpoints.
- Retention/quotas above are proposed defaults, with explicit disk reservation
  and visible suspension when protection cannot be maintained.
