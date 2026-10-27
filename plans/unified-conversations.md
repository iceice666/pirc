# Unified conversations, projects and an independent App

[Plans](README.md) · [Workspace modes](modes.md) · [Mobile](mobile.md) · [Assistant contracts](../docs/architecture/assistant-memory.md) · [Checkpoints](checkpoints.md) · [pots](pots/README.md) · [Rust foundations](library-extraction.md) · [Conversation execution contracts](conversation-execution-contracts.md)

Status: adopted architecture baseline, with the next implementation sequence
reviewed against `6d87f97f` on 2026-10-26. The user subsequently activated the
implementation goal for first Send, environment bindings, resource transitions,
canonical tasks/collaboration and bounded pots. UI redesign/navigation reorganization
is deferred; Web/Android changes are limited to necessary functional integration.
Use only focused simple Flutter checks when Flutter changes. Keep work in local
commits; no push, deployment or release is authorized. Undecided numerical settings
still need confirmation. Earlier library and pots checkpoints remain in their plans.
Accepted design choices and still-open details are distinguished below.

## Agreed direction and priority

- Merge the user-facing Chat and Work experience. A conversation can be ordinary
  chat, research or work without asking the user to choose a separate product area.
- Organize conversations in projects; distinguish organization from execution.
- Make the App a complete, independent client of the backend. Normal use must
  not require a desktop Web session to remain open or approve routine actions.
- Give pirc a stable assistant entry point that can discover relevant matters,
  propose work and coordinate agents within the user's granted authority.
  Proactive suggestions are wanted; frequent, repetitive interruptions are not.
- Define the domain relationships and user journeys before designing new screens
  or expanding UI parity. Web and App should implement the same behavior contract.
- Keep Flutter Web as an evaluation option. Replacing the existing Web client,
  rewriting transport and changing the native-content requirement are not decided.

Security and data-loss fixes remain important. Existing mobile compatibility and
physical-device acceptance gaps remain recorded, not silently closed by this
architecture proposal. The initial App scope remains Android; iOS transport is
outside the previously agreed scope.

## Accepted specification-review recommendations (2026-10-24)

The user accepted the recommendations in the preceding review. These are the
planning baseline; do not repeatedly ask for approval of the same choices.
Engineering detail and validation remain work to do, not evidence of implementation.

| Area                         | Adopted direction                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace transitions        | Durable stages and clear applying/ready/blocked status; reject stale effects; preserve context and files; no automatic restoration of revoked access after a failed switch                         |
| Multiple folders             | One main working directory plus named mounts, with explicit permission/grant provenance and real enforcement; removing a UI mount is insufficient                                                  |
| Project configuration        | User-controlled rules; agents may propose changes; ordinary rule updates apply at a safe turn boundary with a recorded revision; access revocation uses the live-transition flow                   |
| Project collaboration        | Separate approved rules, versioned shared notes and attributed board messages; authorized agents may maintain notes with conflict checks; board posts never grant rights                           |
| Project resource inheritance | Project changes use inherited configuration with an affected-conversation preview and enforced revocation, rather than hidden independent copies                                                   |
| Task tracking                | One canonical task record; map goal/todo/team work into objective, milestones and child work; automatic tracking for long/background or multi-agent work, optional for brief work                  |
| Completion and progress      | Required children/background work must finish; explicit user-acceptance requests become Ready for review; use real stages/counts rather than invented percentages                                  |
| Concurrent agents            | Host-managed waits with holder/reason, release wake-ups and rereads; no model polling or forced unlock of active writers; shared non-overlapping work and an isolated-worktree option for overlaps |
| pots control                 | User stop/takeover takes precedence; pots cannot silently restart stopped work; distinguish pausing new coordination from stopping already-running tasks                                           |
| Client consistency           | Backend-authorized commands, idempotent outcome reconciliation, revisions/cursors, separate notification/read/decision states and account-isolated local drafts/cache                              |
| Migration and extraction     | Map existing identities and provenance, verify restart-safe migrations and compatibility; stage product changes and provider extraction separately; preserve loop event/error/cancel behavior      |

The user subsequently adopted the [review's defaults](unified-architecture-review.md#adopted-defaults-and-deliberately-deferred-decisions):
explicit main-folder selection/scope, read-only new additional mounts, managed
allocation at first accepted send unless Create folder was explicit, durable notes
without age-based expiry, and scoped/bounded pots with quiet nonurgent digests.
The three proposed crate names and optional default-off OAuth are also adopted.
Existing grants and source-aware deletion rules remain intact.

Still unspecified: exact pots budget/concurrency values, quiet hours/digest cadence,
board-retention/editor presets, storage/provenance details and final Rust APIs.
App authentication/topology and Flutter Web remain explicitly deferred. Decision A
and the distinction between leaving a project and blocking a folder stand.
Implementation remains a separate step from documenting/publishing this plan.

## Accepted follow-up behavior and detailed contracts (2026-10-24)

The user accepted all seven follow-up recommendations, detailed items 1–3 first,
then requested the same depth for items 4–7. [Conversation execution contracts](conversation-execution-contracts.md)
now covers all seven with flows, authority/ownership boundaries, exception handling
and future acceptance cases. These are adopted target behaviors; this planning
work does not implement code, migrations or deployed permission changes. The user
subsequently authorized review, integration and publication of the repository commits;
that does not authorize implementing this architecture or publishing a release.

| Item                                 | Accepted direction                                                                                                                                                    | Detail status                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Chat/Work capabilities            | Compose runtime availability, conversation configuration, resource grants, approvals and readiness; no automatic global assistant/admin rights from mounting a folder | Detailed in the capability mapping and old-mode migration contract                                                                                               |
| 2. Messages during multiple tasks    | One foreground response flow; attributed parallel child/background tasks; questions, corrections, independent objectives and explicit controls have distinct routing  | Detailed in the message routing, ordering and cancellation contract                                                                                              |
| 3. Overlapping folder permissions    | Leaving removes project-derived grants and discloses retained independent grants; an explicit conversation-level folder block overrides overlapping grants            | Detailed in the effective-access rules, examples and revocation contract                                                                                         |
| 4. Switching Nodes                   | Switch execution binding without automatic migration of files, processes or browser state; no automatic offline failover                                              | [Switch flow and failure cases](conversation-execution-contracts.md#4-switch-nodes-without-implicit-migration); separate file transfer remains outside switching |
| 5. Archive/delete/leave              | Archive organizes; deletion reconciles affected running work first; leaving changes grants; original folders and memory provenance are protected                      | [Lifecycle ownership, deletion flow and cases](conversation-execution-contracts.md#5-archive-leave-and-delete-with-explicit-ownership)                           |
| 6. Historical content and file links | Preserve saved dialogue under decision A; distinguish conversation-owned attachments from live project file references                                                | [Content kinds, access flow and cases](conversation-execution-contracts.md#6-separate-saved-content-from-live-file-references)                                   |
| 7. pots entry and takeover           | An accepted suggestion links to one canonical task; subsequent discussion stays task-linked; takeover suspends coordination only for the affected task                | [pots workflow, controls and cases](pots/design.md#coordination-contract)                                                                                        |

### 4. Switching Nodes without implicit data transfer

One attempt uses one selected Node for directly mounted resources. Switching
preserves dialogue and results with their source locations; it does not move
uncommitted edits, files, shell processes, development servers, credentials or
browser profiles. Preview what remains on the old Node and what is available on
the new one. File synchronization/copying is a separate explicitly authorized
operation, not a side effect of selecting another server. An unavailable original
Node does not authorize silent failover. Apply the existing live-transition and
partial-effect rules; never replay old writes against the replacement folder.

### 5. Archive, delete and leave have different effects

Archiving changes organization, without automatically stopping work or schedules.
Leaving changes project grants under item 3. Deleting a conversation/project with
affected active work first fences new dispatch, stops affected workers and scoped
descendants, and reconciles their outcomes before reporting deletion complete.
An offline worker leaves that operation pending rather than creating an orphan
that can continue writing.
Show the affected tasks, schedules, notes, attachments and checkpoint records in
the deletion preview; distinguish related references from records actually owned
by the deleted entity. Do not silently delete unrelated work or user-owned folders.

Keep the existing memory-origin deletion/forget rules, including other authors'
contributions. Deletion cannot be bypassed by copying source-derived memory into
shared notes. The [detailed lifecycle contract](conversation-execution-contracts.md#5-archive-leave-and-delete-with-explicit-ownership)
now specifies owned/retained records, schedules, mixed-origin memory, checkpoint
dependencies and interrupted cleanup. Concrete storage/receipt mechanisms and
retention durations remain to specify; no universal erasure claim is implied.

### 6. Retained history is distinct from fresh file access

Keep already-saved dialogue and independently owned conversation attachments under
their existing authority and lifecycle. A project file reference, preview or
download must check current resource rights before fetching fresh bytes. Leaving
a project removes project-derived retrieval; retained independent grants, if any,
are disclosed under item 3. Cached text/thumbnails already obtained are not
retroactively erased by decision A, but caches must not make new fetches using old
authority. Separate stored attachment copies from live references with provenance;
Web and App must use the same checks without an open Web client acting as relay.

### 7. pots suggestions lead to the same task and bounded takeover

Accepting a suggestion creates or links the canonical task once, subject to its
actual execution grant. Further discussion and results stay linked to that task;
do not create a second mirrored work conversation just for pots. Keep the source
conversation and actor visible when the user opens the task from the pots inbox.
Taking over one task suspends conflicting pots coordination for that task and its
scoped dispatch; unrelated responsibilities continue. Provide separate explicit
controls for pausing all new coordination and stopping selected running tasks.
Resuming a taken-over task's coordination remains explicit.

## Confirmed decisions: context and live switching (2026-10-24)

The user selected **A: preserve conversation context**. Leaving a project keeps
existing dialogue/history eligible as model context. It removes project-derived
mounts and authorization for new project access, including configuration, rules,
board and notes. Independently granted folder access is separately disclosed;
it does not preserve project membership. The accepted distinction between leaving
and explicitly blocking a folder is specified in the
[overlap contract](conversation-execution-contracts.md#3-resolve-overlapping-folder-permissions-explicitly).
Do not clear or sanitize the old conversation as a side effect of departure.
Previously read material may still be known; this is accepted, not an isolation
claim about information already obtained. Stop injecting the departed project's
rules as active configuration, even if their text remains in historical messages.

The user also specified the running-workflow behavior:

1. Switching/removing a workspace or mounted folder while an agent is running
   first shows a warning explaining affected resources and in-flight work.
2. Canceling leaves the workspace and execution unchanged. If the user proceeds,
   revoke the removed access and reject subsequent stale/unauthorized operations
   through enforced execution/sandbox boundaries; do not wait for task completion
   or for the agent to approve the change.
3. Deliver a trusted runtime event to the agent explaining that the **user**
   changed/removed the workspace or mounts, what is now available and why an
   affected operation was denied/interrupted. Deliver it at a safe event boundary
   before accepting further effects; model notification alone is not enforcement.
4. Keep the same visible conversation and its context. The agent may continue
   within the remaining grants or ask the user if it needs clarification. The
   application must not force a follow-up question or automatically restore the
   removed mount, expand rights, select another directory or retry an old write
   against the replacement workspace.

### Enforcement implications to design, not existing functionality

The requirement is authoritative revocation, not merely removing a UI item or
returning an error from the next cooperative file tool. Current Linux bubblewrap
mount plans and macOS sandbox-exec profiles are constructed for process launch
(`crates/pirc-node/src/sandbox/{linux,macos}.rs`). No dynamic per-mount revocation
mechanism was established by this review. Updating a policy object cannot be
assumed to revoke a running shell's open descriptors or its background children.

Adopted design contract; implementation still requires technical validation:

- Treat the confirmed request as a versioned access transition. Immediately fence
  new work under the old binding at the controlling service and execution host;
  stale queued commands and approval results cannot recreate the removed access.
- Stop/quiesce affected tool processes and descendants, retire their old sandbox
  authority, and rebuild the execution sandbox where live enforcement is not
  available. Preserve the conversation/model context and explain interrupted
  tool outcomes. A preserved agent identity does not require the same OS process.
- Publish the replacement binding only after its permissions are installed and
  revocation has been acknowledged. Revalidate every subsequent effect against
  the current generation and target; old proposals are not retargeted implicitly.
- Switching must preserve original files and already completed effects. An
  interrupted command may have partially changed files: record that uncertainty
  and expose relevant checkpoints; do not claim rollback or replay it blindly.
- An offline execution host cannot acknowledge immediate revocation. Show the
  transition as pending/blocked, fence Gateway dispatch, and keep reconnecting
  workers from resuming their old authority before reconciliation. Do not claim
  that a remote offline process stopped at the instant the user tapped Confirm.
- Show applying/completed/failed states and retain a durable transition identity
  through retries, crashes and concurrent device changes. Completion requires
  the actual revocation boundary; an agent-facing notice is not completion proof.

The intended UX takes effect on confirmation without asking the agent's consent.
The exact OS enforcement and remote acknowledgement strategy remains engineering
work; there is no zero-latency distributed revocation guarantee in this plan.

## Current behavior: evidence and constraints

These are implementation facts to account for, not the target architecture:

- [Workspace modes](../docs/guides/modes.md) currently place `assistant: full`
  workspaces in Chat and others in Work. Modes also determine prompt, tools,
  working-directory behavior and feature access; the split is more than navigation.
- `crates/pirc-protocol/src/mode.rs` rejects full assistant capability with a
  workspace working directory, and rejects a mode that is both delegator and
  delegation target. Do not remove those checks just to merge the tabs.
- Projects, directory workspaces and their links currently have different
  lifecycle and permission rules. Project links are preferences, not permissions.
- [Assistant contracts](../docs/architecture/assistant-memory.md) separate global
  assistant memory from repository handoffs and protect provenance. Moving a
  conversation must not rewrite memory origins or widen what an agent can read.
- Android's `lib/live/gateway.dart` calls a Kotlin bridge. Native `PircApi.kt`
  directly requests Gateway session snapshots and commands; `EventStream.kt`
  opens authenticated Gateway event streams. An open Web page is not a relay.
- `core/Pairing.kt` consumes a pairing link created through Web. Gateway
  `management.rs` requires a browser identity to approve native management grants.
  These are genuine Web-dependent setup/administration steps today.
- `GatewayRuntime.kt` refreshes snapshots and checks session control leases.
  Another device holding a lease, an unreachable Gateway and an offline Node are
  different conditions; the UI must distinguish them. Reported switching/connection
  problems have not been reproduced as part of this planning pass.
- Gateway `push.rs` supports browser and phone delivery. Transport implementation
  does not establish successful real-device background delivery; existing remote
  push acceptance remains open.

## Domain model: proposed relationships

The 2026-10-24 user clarification replaces the earlier organization-only project
proposal: project membership also supplies mounted resources and configuration;
leaving removes project-derived access. Implementation details remain proposals.

| Concept             | Responsibility                                                                                    | Relationship and lifetime                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Project             | Folder-like organization plus shared mounts, rules/configuration and proposed collaboration board | Contains conversations and one or more resource bindings; need not equal one physical directory                                           |
| Conversation        | Stable dialogue, attributed messages/results and a configured workspace                           | Optionally belongs to one project; has its own bindings plus currently authorized project bindings                                        |
| Workspace binding   | Resolve the selected Node, primary working directory and named read/write mounts                  | Configurable when creating a conversation; can use existing folders or an explicitly created server folder; versioned at transitions      |
| Resource mount      | Describe a directory/configuration resource, its alias, host, permissions and grant source        | May derive from a project or explicit conversation configuration; not just a symlink or display label                                     |
| Task                | Track an objective, dependencies, owner, progress, blocking reason and deliverables               | One immutable request/suggestion origin; optional execution conversation until dispatch; child tasks/attempts and pots share its identity |
| Execution attempt   | Run an agent turn/work against an explicit environment and authority generation                   | One conversation, optionally one task; its resource set cannot silently mutate mid-run                                                    |
| Pending decision    | Durable proposal/confirmation with an authoritative outcome                                       | References task/attempt and revision; shared across devices                                                                               |
| pots responsibility | Track an ongoing user-authorized concern and when to observe or follow up                         | May create suggestions and authorized tasks; bounded by scopes, budget and pause controls                                                 |

```mermaid
flowchart TD
    P[Project] --> C[Conversations]
    P --> M[Shared mounts and rules]
    P --> B[Project board and scoped notes]
    C --> W[Versioned workspace binding]
    M --> W
    C --> T[Tracked tasks]
    T --> R[Execution attempts]
    W --> R
    A[pirc pots] --> T
    A --> D[Suggestions and pending decisions]
```

Boundaries:

1. Project membership supplies defined resource grants, not all host access.
   Conversation-specific mounts and project mounts have separate provenance.
   Resolve overlapping grants using the [effective-access contract](conversation-execution-contracts.md#effective-access-rules);
   defaults and physical alias enforcement still need implementation detail.
   A mount must be enforced for shell/tools/children as well as UI.
2. Creating a new empty folder is permitted only under a configured server root
   and current user authority; validate paths, symlinks, collisions and ownership.
   Do not reuse a pre-existing nonempty path as if it were newly allocated.
3. Initial execution contract: all direct filesystem mounts of one attempt
   resolve on the selected Node. Cross-Node resources need an explicit remote
   access/copy design; a folder on server B is not magically local on server A.
4. Leaving/moving a project is an access transition. Block new affected work,
   reconcile queued actions, quiesce/stop old workers and descendants, revoke old
   project grants, rebuild the execution sandbox while preserving conversation
   context, then resume under a new binding generation. Do not report success
   while old workers retain revoked authority.
   An offline Node or interrupted transition remains pending/blocked until resolved.
5. Changing a mount list does not close existing file descriptors or withdraw
   bytes already read. Decision A preserves existing conversation context and
   history; unmounting does not erase those. Previously copied files/summaries
   remain attributable and are not evidence of successful resource revocation.
   Never copy additional project content to bypass the user's removal.
6. Authority from unrelated mounts or broad host access may overlap the removed
   project path. Leaving removes project-derived authority and discloses explicit
   independent grants; ambient host reads cannot silently restore it. A conversation
   folder block overrides overlapping grants, under the effective-access contract.
7. Keep memory authorship/deletion provenance and original filesystem data.
   Project board/notes reopen scoped collaboration design; automatic migration of
   existing global USER/MEMORY into project-only stores is not authorized.
8. Every task keeps a stable identity across attempts. Existing checkpoint recovery
   still opens an isolated workspace and blank recovery conversation; it does not
   inherit the source memory writer or overwrite later user changes.

### Drafts, tasks and execution states

- **Conversation:** configure workspace/mounts at creation → local draft → first
  accepted message → persisted conversation → archived or explicitly deleted.
  Adopted allocation policy: retain workspace choices in the draft and allocate
  managed storage at first accepted send, unless the user explicitly invokes Create
  folder. Empty drafts still do not litter the session list; never delete a
  user-created folder merely because its draft was abandoned.
- A first-send request has a stable idempotency identity. Retries, uploads and
  interrupted creation must not create duplicate conversations or orphaned
  permanent attachments. An unsent message remains visibly a draft.
- **Task:** proposed → ready → running → waiting for user / resource / dependency
  → awaiting review → completed; canceled and failed remain distinguishable.
  Recommend tracked tasks for complex work; long/background and multi-agent work
  should require them. Create tasks automatically from an authorized request;
  do not require a form or infer execution permission from a task card.
  Plain questions and brief edits can remain ordinary turns. Progress shows
  milestones and blocking reasons; percentages need an actual measurable basis.
  User acceptance, where required, is distinct from an agent saying it is done.
- A tracking-only pots task has an origin/owner but may have no execution
  conversation or attempt yet. Start reuses an explicitly selected conversation
  or creates one once at the first dispatched instruction. Opening/tracking the
  suggestion alone must not add an empty session to the conversation list.
- **Attempt:** queued → starting → running → succeeded / failed / stopped;
  disconnect can leave outcome unknown. Do not treat lost connectivity as success
  or blindly retry a possibly completed side effect.
- **Environment:** available, offline, incompatible or access denied. These do
  not erase the conversation or imply that its task was canceled.

Foreground response ownership, message targeting and overlapping task behavior
are defined in the [message routing contract](conversation-execution-contracts.md#2-route-new-messages-while-tasks-run).
Exact persisted state names and transitions require a later engineering review.

## Primary user journeys

### 1. Create a conversation and workspace

1. Open New conversation. Configure its workspace: use mounted folders, inherit
   project resources, or explicitly create an empty folder in an allowed server
   location. A managed empty default keeps ordinary chatting easy.
2. Show the selected server, primary directory and additional named mounts without
   forcing a Chat/Work choice. A plain chat uses the same workspace abstraction.
3. Keep an unsent conversation as a draft; apply the adopted allocation timing above.
4. On first send, persist idempotently, resolve current grants and launch the
   needed agent context. An unavailable environment leaves the request recoverable.
5. Organizing it into or out of a project applies the explicit resource transition
   below; it does not physically move a repository or reassign old memory origins.

### 2. Discuss, then work in the same conversation

1. Open a project conversation and discuss the change.
2. Ask the agent to implement it. Use the configured workspace and its explicit
   primary target/mount aliases. Project defaults are resolved when configuring
   the binding, not silently re-read to redirect an already-running attempt.
3. If several targets are plausible, ask once with readable device/directory
   choices. Never guess a remote target or silently widen permissions.
4. Show the selected environment and granted operation scope in the conversation.
   Use the established approval policy; no extra dialog is needed merely because
   the UI previously called this Work.
5. Start the task/attempt, keeping progress, questions and results in this dialogue.
   Detailed execution logs are accessible without forcing a navigation change.
6. Show changed files, tests, outstanding issues and any requested acceptance.

The contract guarantees one user-visible dialogue, not a single privileged agent
process. How a chat turn hands context to an execution agent remains a design
checkpoint before implementation; preserve source attribution and tool ownership.

### 3. Work directly, without going through pirc

1. Open a known environment or project and start a conversation there.
2. Send the work request directly; pirc is not a compulsory intermediary.
3. The task can appear in the shared overview without creating a second session.
4. If pirc is allowed to coordinate that task, show its role. Direct user
   instructions supersede conflicting pending assistant instructions.

### 4. Ask pirc to coordinate several tasks

1. Give pirc an objective or accept one of its suggestions.
2. Review scope/targets when existing grants do not already authorize them.
3. Create canonical tasks with dependencies and named execution environments.
4. Run independent tasks concurrently only where authority and isolation permit.
   Reuse existing delegation mechanisms rather than introducing a competing queue.
5. Collect decisions in the pirc inbox. Open any task to communicate directly
   with its agent; responses and status stay attached to that task.
6. Aggregate meaningful results without copying every tool event into pirc's chat.

### 5. Take over, switch devices, and return control

- Opening a conversation is viewing, not automatic takeover. Reading must not
  require the current controller to be online.
- Before a conflicting command, show who/what currently controls the execution
  and offer explicit takeover. Fence stale commands using a backend generation.
- User takeover suspends conflicting pirc dispatch for that task; unrelated pots
  responsibilities continue. It does not silently kill running tools; show whether
  work continues, pauses or is stopping.
- Resuming assistant coordination is explicit. Another browser tab opening must
  not silently reclaim it.
- Every decision has one backend outcome. Duplicate submissions return the
  current handled state. Web and App show where/when it was handled when known.
- Device command control, assistant coordination authority and filesystem writer
  isolation are distinct; one lease must not be assumed to solve all three.

### 6. Switch environments, leave projects or recover work

- Before starting a run, changing workspace selection changes the next run's
  binding. After completion, a new environment starts a new attributed attempt
  in the same visible conversation; old results retain their original location.
- During execution, warn before a workspace/mount removal or switch. On user
  confirmation, enforce revocation, reject stale effects and notify the agent
  under the confirmed live-switching contract above. Preserve conversation context;
  stop/rebuild affected execution where required instead of relabeling a process.
  Starting a separate task elsewhere remains a distinct operation.
- Leaving a project must revoke its mounts, rules, board access and retrieval from
  project notes. Mark the move pending until the old authority is no longer usable;
  do not silently let a detached background child keep working in the project.
- Merely navigating to another page does not change membership or stop work.
- Existing files stay where they are. Decision A retains history from the old
  project as future model context while removing project-derived mounts and new
  retrieval. Historical text does not reauthorize the departed project's resources.
- Checkpoint recovery keeps its independent workspace and blank conversation,
  linked from the source. No implicit original-directory overwrite or source
  memory-writer inheritance is allowed.

## Project collaboration: board, notes and resource waiting

The user's shared-board idea is a collaboration requirement under design.
Existing team `board_*`/`task_*` operations in `features/team/broker.rs` are a
starting point, but that parent-side broker is not automatically a durable board
shared by every independent conversation in a project.

Use three explicit kinds of information:

| Kind                           | Content                                                                     | Authority                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Project rules/configuration    | User-approved instructions and resource settings                            | Versioned, user-controlled; agents propose changes rather than grant themselves rights        |
| Project board and shared notes | Work claims, messages, decisions, stable project facts                      | Scoped and attributed to actor/task/source; revisions, retention and deletion policy required |
| Resource wait state            | Who actually holds a write lease, conflicting path, wait reason and release | Computed by the execution host; board text cannot acquire/release a real lock                 |

Recommended conflict flow: A holds a path → B receives structured owner/path/reason
→ B does independent work or enters a visible waiting state → release wakes B → B
rechecks authority and rereads the current file before attempting its edit.
Do not classify temporary contention as task completion or a generic fatal error.
Avoid model polling loops and unlimited retry spend; cancellation and a bounded
escalation policy remain available. Detect dependency cycles; do not solve them
by expiring a still-active writer's lease or asking an agent to bypass the broker.

The current Node write broker is per Node and holds leases until the run settles
or stops. A second lock table in Gateway would not automatically coordinate shell
processes, user editors or multiple Nodes sharing storage. Keep Node enforcement,
expose useful wait state, and prefer isolated worktrees for overlapping parallel
code changes. Checkpoints provide recovery, not universal writer isolation.

Board content is other-agent data with provenance, not a user's instruction or
approval. It must not automatically become global personal memory. Leaving a
project removes future access, but previously copied text cannot be claimed erased.
Durable project notes have no automatic age-based expiry; explicit removal and
source/project deletion follow the lifecycle contract. Operational board retention
is configured separately; storage and editor presets still require specification.
Post-departure context follows decision A: previously read notes may remain, while
retrieval through the departed project's authority is denied.

## pirc pots: proactive but bounded

Product name supplied by the user: **pirc pots** (personal assistant): one stable
assistant entry point that observes, suggests and, only within explicitly granted
authority, dispatches attributed work. The full adopted design (separate
observe/suggest/execute authorities, “From pots” attribution, notification
categories and quiet operation) has moved to [pots design](pots/design.md). The
delivered subset and remaining work are in [pots](pots/README.md).

## Independent App and shared backend contract

The App is an equal client, not a remote control for an open Web page. Web and
App both connect to Gateway; Node execution and durable coordination continue
independently of client visibility. A web login/identity-provider page opened on
the phone is compatible with this goal; requiring an already logged-in desktop
Web session is not.

### Identity and management

- Design native sign-in/bootstrap, reauthentication, credential renewal, recovery
  and revocation without requiring another device's Web UI. Keep the existing
  pairing path as an optional onboarding method during migration.
- Authorize management by verified identity, scope and required reauthentication,
  not by client platform alone. Do not simply grant all existing device tokens
  provider-credential or device-management privileges.
- The current browser-approved short-lived grant is an existing security decision
  to replace deliberately. Select the authentication mechanism and migration
  policy before implementing; do not infer approval to weaken it from this plan.

### State, commands and connection recovery

- Gateway exposes canonical task/decision state and recoverable account-level
  changes. Nodes remain authorities for execution/files; this plan does not
  require moving all transcripts or files into Gateway storage.
- Use versioned snapshots plus resumable events; detect missing history and
  resync. Session switching cannot depend on a Web client's local state.
- Cache already-read conversations locally by account. Show cached content,
  freshness and reconnect state; retain drafts and navigation during failures.
  Account changes/revocation must not expose another account's cache or drafts.
- Resolve mutations with idempotency keys, current revisions and authorization.
  Reconcile unknown outcomes instead of claiming exactly-once side effects.
- Offline viewing/drafting is allowed for cached data. First-version destructive
  or approval commands are not silently queued for later execution; revalidate
  state and authority when the user submits after reconnecting.
- Distinguish Gateway unreachable, Node offline, expired credentials, unavailable
  environment and control held elsewhere. Provide a relevant next action.

### Durable inbox and notification delivery

- Store the event/decision before notification delivery. A push is a wake-up hint
  and deep link, not the only copy of the assistant's message or an authorization.
- Web closing must not stop dispatch. App suspension must not stop backend work.
  Reopening the App reconciles unread/handled state even if push was lost.
- Retire local prompts/notifications when resolution is received. An offline
  device cannot be guaranteed immediate retraction; tapping a stale notification
  must fetch the current state and refuse duplicate execution.
- Gateway and required Nodes must still be available. A sleeping laptop hosting
  them remains a deployment limitation. Always-on coordination and phone OS push
  behavior need separate deployment/device acceptance.

## Relation to reusable crates and App connection design

See [Library extraction](library-extraction.md) for checked handoff findings and
the combined delivery sequence, and [pots design](pots/design.md) for the dots/Grok
Bot references.
The reusable loop does not own product tasks, mounts, memory or pots authority.
Provider extraction can be behavior-preserving and independent; loop integration
must respect tool-wait, cancellation, event ordering and context transitions.

The user deferred the secure server-to-App connection mechanism. Preserve the
independent-client requirements above while leaving authentication/topology for
separate review. Android already connects to Gateway directly; no new public
Node/agent port, bypass of Gateway authorization, or inbound phone listener is
implied. Model-provider subscription OAuth is separate from pirc App login.

## Flutter Web: evaluation only

A shared Flutter client could reduce duplicate UI and state logic. It is not
required to remove browser dependencies, and it cannot fix backend availability,
permissions or ordering bugs by itself. No Web replacement is approved here.

After the domain/behavior contract is agreed, evaluate a thin vertical slice:

- Login and direct Gateway transport, reconnect and two-device confirmation.
- Long conversation scrolling, selectable text, code highlighting and file views.
- Mobile CJK IME, desktop keyboard shortcuts, terminal resize/input and focus.
- Deep links, browser navigation, accessibility and phone/tablet/desktop layouts.
- Large histories, startup/download cost and sustained rendering responsiveness.
- Platform adapters for storage, notifications, files and native Kotlin services;
  existing method channels cannot simply run in a browser.

Compare keeping the existing Web client against sharing Flutter data/state/UI,
using the same workflows and fixtures. Set acceptance budgets before the spike;
do not invent a migration estimate without measuring these difficult surfaces.

Application UI reuse is separate from rendering agent-generated HTML/JavaScript.
Keep the current native-content requirement and explicit unsupported cases.
Structured result cards/forms may be evaluated later; this plan does not silently
replace arbitrary content with simplified output or authorize WebView fallback.

## Migration and compatibility constraints

- Map existing Chat projects, directory workspaces and sessions to the new
  concepts without resetting IDs, breaking deep links or moving user files.
  Define aliasing if new conversation/task IDs are needed.
- Navigation migration alone preserves old sessions and their authority. An
  explicit project departure or mount revocation is a separate transition that
  may require stopping/rebuilding the old execution; do not confuse the two.
- Preserve memory provenance, deletion/forget semantics, uploads and project
  ownership. Moving a conversation must not reinterpret which prior project or
  conversation created a memory. Define cross-project move/deletion behavior
  before enabling that operation. Project-scoped collaboration is accepted; its
  lifecycle details remain to specify. Existing global memory is not silently
  re-scoped or migrated.
- Preserve pending approvals, schedule/calendar targets, delegation references
  and checkpoint recovery provenance. Migration must not duplicate scheduled
  runs, replay a command or resume a stopped task.
- Plan version negotiation and supported Gateway/Node/client combinations for
  the transition. App updates and browser cached versions will not be simultaneous.
- Define restart-safe migration and a tested compatible fallback before changing
  storage; UI rollback is not permission to downgrade a migrated database.
- Present existing work in unified navigation first; migrate execution semantics
  incrementally. Avoid a simultaneous renderer rewrite, authentication cutover
  and task-storage migration.

## Next implementation sequence (2026-10-26)

Baseline: fetched `origin/main` at `6d87f97f`, product version 0.10.0, including
unreleased changes after that tag. This sequence was initially prepared as planning
only; the later active implementation goal is recorded above. It refines stages
A–C without superseding accepted behavior or treating old acceptance cases as passed.
U3's navigation redesign is now explicitly deferred.

### What the updated code already provides

| Area                      | Evidence in the fetched tree                                                                                                                                                                                             | Consequence for the next slice                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reusable foundations      | Types, transport/OAuth, loop and tool-schema crates exist; production `run_loop.rs` drives the core                                                                                                                      | Extend the existing adapters; do not repeat the extraction or require a second loop rewrite before product work                                   |
| pots                      | Tracking, explicit dispatch, ownership-based Stop, archive and revocation-fence paging exist at `6d87f97f`                                                                                                               | Those are delivered subsets; content observation, autonomous suggestions and full acceptance remain open                                          |
| Draft conversations       | Web `app.svelte.ts` and Android `gateway.dart` create a local draft and persist it during first Send                                                                                                                     | Preserve this UX; harden the split between creation and first-message admission rather than build drafts again                                    |
| Creation versus commands  | Gateway `routes.rs::create_session` accepts only `workspaceId`; Node `app.rs::create_session` allocates a fresh session. Existing session commands already have command IDs, payload hashes and unknown-outcome handling | First creation needs a durable operation identity across both hosts; reuse the command contracts instead of claiming all sends lack deduplication |
| Conversation identity     | Gateway `db.rs::Session` already has a public stable ID, with private Node-session mapping                                                                                                                               | Keep public IDs/deep links; separate future environment binding from identity without renumbering conversations                                   |
| Current workspace removal | `workspace_removal.rs` fences mutations and requires an online, idle Work workspace; Node registration/files are retained                                                                                                | This is not live per-conversation mount revocation or project departure; do not enable switching by reusing its UI alone                          |
| Task identity             | `pots/schema.sql` requires a unique suggestion origin for each pots task                                                                                                                                                 | This cannot represent every direct user task unchanged; map existing tasks before adding a competing universal task table                         |

The creation gap is a code-path finding, not a reproduced device failure in this
review. Both clients currently create the server session, obtain control and then
send. A lost create response or a later admission failure can leave creation and
the first message with different outcomes. Existing command deduplication starts
after there is a session and does not cover that entire sequence.

### Recommended order and bounded deliveries

| Order                                                      | Deliverable                                                                                                                                                      | Visible result and exit gate                                                                                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0. Relevant reliability baseline                          | Reproduce/classify the recorded storage-refusal admission issue and the relevant failed tests; inventory current identities, versions and control boundaries     | Failure stays visible and user text is retained; focused gates establish the actual starting point without relabelling historical failures as passed                              |
| U1. Reliable first Send — recommended first implementation | A durable creation/admission operation spanning Gateway, Node, Web and Android, with queryable outcome and stable retry identity                                 | Open/abandon drafts stays local; one accepted Send creates one conversation and one admitted first message despite lost responses/restarts                                        |
| U2. Environment-binding foundation                         | Map existing workspaces, project membership, mode/capabilities, public session IDs and private Node sessions; define separate binding and membership revisions   | Existing sessions retain their permissions, links and content; clients can show one authoritative current environment without silently moving files or granting rights            |
| U3. Unified navigation and creation                        | One conversation entry point, projects and environment selection using the U1/U2 contracts; retain current styling and renderer                                  | Web and App offer the same create/open/send behavior. Unsupported environment combinations remain explicitly unavailable rather than appearing enabled                            |
| U4. Real resource transitions                              | Stage single-Node idle transitions first, then live revocation/rebuild and interrupted/offline reconciliation; add project mounts/rules with explicit provenance | Context is retained, removed authority is actually withdrawn, and new-generation work starts only after host acknowledgement; cross-Node handoff is a separately tested extension |
| U5. Canonical work and collaboration                       | Map pots tasks, goal/todo/team work, attempts and decisions to one identity; then add shared notes/board and structured resource waits                           | The same task appears from a project, conversation or pots; parallel agents see blockers and cannot overwrite each other's notes or bypass a write lease                          |
| U6. Bounded proactive pots                                 | Add explicit content-read scopes, finite observer budgets, event-driven analysis and then quiet digest/push delivery                                             | Useful sourced suggestions with no automatic execution grant; stale suggestions/notifications reconcile to the same task or handled decision                                      |

G0 is scoped preparation for each affected slice, not an instruction to repeatedly
run every expensive test before any progress. The existing library/workspace and
conformance failures remain release/acceptance debt until reproduced and fixed or
explicitly classified. Do not weaken tests, change golden files merely to pass,
or call sandbox-looking failures pre-existing without evidence.

U2's identity/contract inventory can be done while specifying U1. Its binding
changes must not be smuggled into the first-send patch. U3 is a navigation delivery,
not completion of same-conversation environment switching: the latter depends on
U4. Do not remove the current mode checks for full-assistant/workspace-directory
combinations just to combine the tabs. Users keep the existing execution behavior
until an explicitly supported capability/resource combination is delivered.

### U1: the first implementation proposal

**Scope:** existing workspaces and an explicit first user message, including the
current model/thinking choices and supported attachments. No new mount rights,
project moves, managed-folder allocator, automatic task creation or pots standing
grants. Managed folder allocation later attaches to this operation identity;
creating an empty folder explicitly remains an independent user action.

Before code, name the API and persisted states in a short contract review. The
behavior is constrained as follows:

1. Generate a stable, account-scoped creation-operation key for one draft submission.
   Persist it through reconnects and bind it to the selected workspace and immutable
   submission payload. The same key with a different target/payload conflicts;
   distinct drafts with identical text remain distinct conversations.
2. Validate current workspace/mode/owner access, payload and attachment preparation
   before accepting the submission. Define **accepted** as durable storage of the
   validated first-message intent and its target, not a successful model answer or
   merely an HTTP connection. A failure before that boundary leaves a local draft.
3. Reserve the Gateway operation and stable public conversation ID before requesting
   Node creation. Node records a corresponding durable mapping so a retry cannot allocate another session.
   Publish one conversation when its first-message intent is durably accepted;
   internal preparation rows without an accepted message are not ordinary sessions.
   An accepted message awaiting delivery has a visible pending/failed status.
4. Correlate the initial command and Node admission with that operation. Reuse
   existing command deduplication and control-lease checks; do not bypass ownership
   to make first Send more convenient. Durable acceptance, Node message admission
   and model execution are different acknowledgements. Do not promise a distributed
   SQLite transaction or exactly-once arbitrary tool effects.
5. A lost response becomes a queryable pending/unknown result. Reconcile using the
   same key and recorded Node/message receipt; never allocate a fresh session or
   rerun an ambiguous send automatically. Stop/revocation/deletion fences still
   apply during reconciliation. A duplicate lookup cannot revive deleted work.
6. Keep unsent/rejected content and attachment bytes until their authoritative
   outcome is known. After acceptance, retain a recoverable pending-message record
   rather than presenting the same text as a new unsent message. Navigating away
   or changing accounts cannot append the result to another conversation/account.
7. Stage attachments under their owner/submission identity and promote/reconcile
   them once. Cleanup only positively owned, unaccepted staging data, with an
   explicit retention policy; never delete user folders or accepted attachments.
8. Preserve old-session commands and caller-specific creation flows used by pots,
   schedules, delegation and checkpoint continuation. Inventory them before API
   changes. Negotiate support for the new workflow: an old Node must yield a clear
   unsupported state, not silently fall back to the unsafe split flow. Existing
   clients keep their documented behavior; do not claim the new guarantee for them.

Suggested patch boundaries: U1a contracts plus failure fixtures; U1b Gateway/Node
operation persistence and reconciliation; U1c Web/native Android integration and
cross-client verification. Keep intermediate code gated until the complete flow
has the required backend/client support. The initial proof uses local fake
inference and temporary state, not provider credentials or a user's live database.

| Case                                                                                | Required outcome                                                                                                        |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Abandon a draft or open another                                                     | No remote session or managed-folder allocation; explicit user-created folders remain                                    |
| Submit the same operation concurrently                                              | One public conversation, one Node session and one initial admission; same result returned to authorized callers         |
| Lose the response after either host commits                                         | Same operation can be queried after restart; no second session/message, and no blind replay of an unknown effect        |
| Reuse a key with different text, workspace or attachment manifest                   | Conflict; do not mutate the accepted original request or retarget it                                                    |
| Node offline, mode unavailable, revoked grant or malformed upload before acceptance | Draft remains usable; no visible empty conversation or implicit fallback to another Node                                |
| Session storage refuses an append after acceptance                                  | Show a recoverable failure/pending outcome with retained input; do not claim the message ran or automatically resend it |
| Navigate away, switch account or delete during creation                             | No cross-account result/cache leak, selection jump or resurrection; authorized outcome remains discoverable             |
| Upload fails, reconnects or completes twice                                         | No duplicate attachments; accepted references survive cleanup; abandoned staging stays owner-scoped                     |
| Receive events before the HTTP response or reconnect with an old cursor             | Reconcile to one authoritative conversation and message; no duplicate list row                                          |
| Web is closed while native Android creates and sends                                | The paired App completes the flow directly with Gateway/Node; browser setup/management limitations remain separate      |
| Existing schedules, pots dispatch or checkpoint continuation                        | Their targeting, attribution, at-most-once fences and isolated recovery behavior are unchanged                          |

A storage-failure reopening path needs its own correctness proof. Do not blindly
reopen an uncertain journal or repeat tools as part of retrying message admission.

### U2–U6: decisions to make at their entry, not new blanket approvals

- **U2:** produce a concrete old-to-new identity/migration table. Keep the public
  session ID; distinguish project membership revision, execution-binding generation,
  Node runner epoch and device-control generation. Record write-time membership for
  new memory versions before enabling cross-project moves. Missing historical
  provenance is not inferred from today's project. Old clients cannot bypass a
  new authority fence.
- **U4:** prove removal of access through live processes, open descriptors,
  descendants and overlapping paths on each supported sandbox. Ambient read access
  cannot defeat removal. Offline stays pending; a failed transition never silently
  restores revoked grants. Preserve context decision A and report partial effects.
- **U5:** keep existing immutable pots suggestion origins and task links when mapping
  direct user origins/attempts. Ordinary questions need no task form. Board messages
  are coordination evidence, never grants; note revisions and blocked-writer wakeups
  must be enforced independently of model instructions.
- **U6:** choose finite budget/concurrency values and notification settings before
  enabling observation. Progress-read does not authorize transcript/file reads.
  Start with scoped manual opt-in and sourced suggestions; standing dispatch is
  still a separate later grant. Archive/pagination improvements can ship separately
  without waiting for proactivity or expanding read authority.

Each slice has Gateway/Node, Web and Android acceptance appropriate to its scope,
including restart/concurrency and memory/checkpoint regressions where touched.
Record synthetic, real-process, browser and device evidence separately. No current
P7/N4/L5/C6 acceptance case closes because this sequence was documented. Use
disposable test state, preserve user APKs and delete only run-created build/test
outputs. Nix verification remains waived; physical-device and real-push gaps stay
open until actually exercised.

App authentication/bootstrap/renewal and server-exposure design remain a separate
user discussion, not a prerequisite for fixing ordinary paired-App workflows.
Flutter Web, iOS transport, external crate publication and a new release are not
part of these deliveries. The active goal starts with **U1 and its G0 checks**,
then proceeds through the authorized core stages while deferring U3's navigation
redesign. Keep commits local until publication is requested.

### U1 implementation checkpoint: Node allocation (2026-10-26)

Implemented locally; U1 remains **in progress**. `session_creation.rs` adds the
Node's durable allocation and read-only lookup primitive. Gateway first-message
acceptance, attachments and Web/Android adoption are not connected yet, so the
existing first-send UX has not changed and the end-to-end guarantee is not complete.

- `POST /api/session-creations` accepts `operationId` (1–100 URL-safe ASCII
  characters), `workspaceId` and a lowercase SHA-256 `submissionHash`. Owner comes
  from the authenticated Node request. The hash binds the future immutable
  submission; the allocation primitive does not validate or store message content.
- `GET /api/session-creations/:id` looks up only that owner's operation without
  allocating anything. Both endpoints return `creation` with `operationId`,
  `workspaceId`, `sessionId` and `state`; the hash/owner are not returned.
- States: `reserved` has a durable identity but no published Node session;
  `ready` has an allocated Node session, not an admitted message or running agent;
  `deleting` and `deleted` reflect the existing fences without recreating anything.
- Same owner/key with different workspace/hash conflicts. Independent drafts or
  different owners get independent identities. Independent SQLite connections are
  serialized when reserving and finalizing, and retries survive reopening the DB.
- Filesystem preparation can fail after reservation. Retry uses the same identity;
  a pre-commit crash's empty directory may be reused, but unexpected content and
  symlinks are refused without deletion. Missing storage for an already-ready
  session is never silently recreated.
- Node schema **2004** adds a content-free operation ledger; identity survives
  session/project deletion to fence delayed requests. Existing sessions, memory,
  uploads, checkpoints and pots records are preserved. See [upgrade notes](../docs/deploy/upgrades.md#unreleased-node-session-creation-ledger).
- New routes are additive to protocol 15; legacy creation/command routes are
  unchanged. Future Gateway integration must require this route and fail closed
  on an old Node, never fall back to a non-idempotent creation request.

Verification for this local allocation checkpoint (2026-10-26):
`cargo test --offline --locked -p pirc-node --lib` with filters `session_creation`,
`store::tests`, `checkpoints::` and `pots::tests` passed **44 tests** (14 + 12 + 7 + 11).
The checkpoint subprocess-helper test is ignored by the normal harness; its parent
hard-kill acceptance test passed. This is synthetic/local-process coverage, not a
full Gateway/client/device journey. Strict `cargo clippy --offline --locked -p
pirc-node --lib --tests -- -D warnings` passed. No Flutter files changed, so no
Flutter suite, emulator or browser was run. Full U1 and historical workspace/
conformance gates remain open. Builds use a disposable target removed after checks.

Remaining U1 work: Gateway durable intent and public-ID reservation; initial
command/admission and storage-refusal outcome reconciliation; attachment staging;
account-scoped client submission recovery; mixed-version failure handling; and the
full U1 acceptance table. The Node allocation proof alone closes none of those.

### G0 implementation checkpoint: message admission (2026-10-26)

Implemented locally as a prerequisite for U1. The existing persistence-order
fixture recorded a successful prompt response after a refused journal append.
This checkpoint changes that failure response intentionally; it does not mark
U1's creation/admission/attachment transaction complete.

- For ordinary idle `prompt` input (also idle `steer` / `follow_up`), the Agent RPC
  waits for initial message admission, including feature and `beforePrompt` hook
  work. Synchronous successful admission retains its prior event order. This is
  not an acknowledgement that inference or tools completed.
- A failed start ends before inference, even when an early stale-writer refusal
  has not set the store's write-failed flag. It cannot answer using old history
  after failing to admit the new user message.
- A failed, cancelled or lost admission receipt reports
  `errorCode: admission_outcome_unknown`. Some initial entries may already be on
  disk; Node stores `outcome_unknown`, not a safely retryable rejection. The same
  command ID keeps its existing receipt. No journal reopening, new operation ID
  or automatic replay is added. Proven reconciliation after restart remains U1
  work, not something this in-process receipt alone guarantees.
- Ordinary commands and deliveries remain serialized while admission waits.
  Stop/deletion may overtake only after the input RPC is queued, including a Stop
  already waiting during preparation. This avoids blocking Stop behind hooks
  without letting model/settings changes retarget the pending message.
- Startup cancellation drops hook work. Hook shells now use their own process
  groups and the existing group cleanup guard, so cancellation/timeout cannot
  leave those hook children running. This covers owned hook processes, not
  revocation of all sandbox capabilities or external effects already performed.
- Slash-command acknowledgement and input queued during an active run retain
  their existing semantics; a queued response is not proof of journal admission.
  Public session IDs, database schemas, memory provenance and checkpoint
  ownership are unchanged by this checkpoint.

Validation (2026-10-26), using one disposable target with debug info/incremental
compilation disabled:

- `cargo test --offline --locked -p pirc-agent --lib`: **420 passed**, including
  seven new admission cases. They cover delayed acknowledgement, stale storage,
  failed feature startup, Stop, concurrent prompts, a partially committed first
  message and cleanup of a real hook child process.
- Node library filters `runner::`, `checkpoints::`, `pots::tests`: **28 + 7 + 11
  passed**. The two subprocess helper entries remain ignored by their normal
  harness; their parent tests passed. New Node cases exercise the actual command
  manager, SQLite receipts and RPC channels with a fake agent process, including
  Stop overtaking, settings staying serialized, duplicate requests, and a lost
  answer while the runner is still alive.
- Built the current `pirc-node` binary and ran all **7** `agent_loop_order`
  conformance cases with `PIRC_CONFORMANCE_REQUIRED=1`. These use real local
  Agent processes and fake inference. The persistence fixture changes only the
  refused prompt response to `false (admission_outcome_unknown)`; ordinary
  successful ordering and the other snapshots passed unchanged.
- Strict `cargo clippy --offline --locked -p pirc-agent -p pirc-node --lib --tests
-- -D warnings`, formatting and diff checks passed.

No Web/Flutter source changed and no browser, emulator or device test ran. Code
inspection confirms both clients keep input after HTTP failure; Android also has
an explicit unknown-send guard. Web receipt checking and stable retry identity
still need the U1 client work. This is not new end-to-end App acceptance. Full
workspace/conformance debt,
Gateway creation reconciliation, attachment staging and client recovery remain
open. The run-created build target is removed after validation; existing APKs
and other worktrees' outputs are preserved.

### Remote integration: repository license (2026-10-26)

Rebased the completed local planning, Node allocation and admission checkpoints
onto `origin/main` at `e34586b2`. That remote change adopts AGPL-3.0-only for all
13 Rust workspace crates; it changes no API, protocol or database schema. Native
and standalone Web release staging now copy the project `LICENSE` separately
from dependency notices. Nix source allowlists, installed licenses and package
metadata follow the same license; extraction/publication documents no longer
report the root license as undecided.

After rebase: 420 Agent library tests, 14 Node creation/route tests, 28 runner
checks and 6 release-notice/CI tests passed. One runner test is an intentionally
ignored subprocess helper exercised by its passing parent test. Strict Agent/Node
Clippy, Rust/changed-file formatting and workspace Cargo metadata checks passed.
Nix build/evaluation remains waived, and no APK, device test or Release was run.
The unfinished Gateway preparation remains local and is excluded from this
integration push. Full U1 acceptance and later architecture stages stay open.

The earlier remote Check diagnosis at `e34586b2` identified a `node_link`
conformance snapshot mismatch: the two protocol-refusal reasons still named daemon 14
although the production protocol is 15. The snapshot now records 15, with
independent assertions for the mismatch close code and current protocol number.
A real-process `node_link` run and all seven `agent_loop_order` cases passed
locally after the integration; strict conformance Clippy passed too. This changes
only tests and their expected transcript, not the App/Gateway/Node wire behavior.

### U1 implementation checkpoint: Gateway preparation (2026-10-26)

Local only, following the one-off integration push through `a926ea38`. Gateway
schema **1012** adds owner-scoped preparation records. This is an intermediate
U1 stage; **`canSubmit: false`** remains the explicit capability response, and
neither client uses this path yet.

- `POST /api/conversation-submissions/prepare` binds an operation ID to the
  workspace, first-message text, optional model/thinking and attachment manifest.
  Gateway reserves stable public session, Node creation and command identities
  before any Node request. It creates no ordinary session, command or file.
- `GET /api/conversation-submissions/{id}` recovers the same preparation after
  restart or a lost response. The same owner/key with changed content, workspace,
  settings or attachment manifest conflicts; separate drafts and accounts remain
  independent even with identical text. Private Node/command identities and the
  fingerprint are not returned to clients.
- `DELETE /api/conversation-submissions/{id}` cancels and removes the payload while
  keeping the operation fence. Replaying that identity cannot revive it. Workspace
  deletion/removal and session deletion clear corresponding pending payloads in
  the same SQLite transaction as their fence. This is logical database removal;
  existing WAL/backup limitations remain as documented in backup/recovery.
- New preparations respect current mode/model availability and private checkpoint
  workspace ownership. Outcome lookup/cancellation remains available to its owner
  after configuration changes. Work removal and project deletion cannot silently
  discard another user's pending input. Content access never grants execution.
- Browser authentication and paired-device bearer tokens reach the same
  owner-scoped operation. A local HTTP test prepares/queries using only the paired
  token, without a browser Origin or management grant; revoking it blocks access.
  This is route-level proof, not an end-to-end Android first-send/device pass.

Validation: all **227** Gateway binary unit/HTTP tests passed, including 17 new
preparation cases plus a Work-removal ownership case. Cases use independent SQLite
connections, concurrent reserve/retry/cancel/delete, restart, immutable payloads,
strict upload/text limits, private recovery ownership and 1011→1012 migration.
Historical 1000/1006/1007/1008/1009 fixtures continue testing real old schemas,
without accidentally including the newly added table/triggers. Strict Gateway
Clippy, Rust/changed-doc formatting and diff checks passed.

Remaining U1: validated attachment bytes and idempotent promotion; acceptance with
fresh authority/online checks; Node allocation/admission reconciliation and stable
lease/command authority; Web/Android persistence/recovery; the complete first-send
acceptance table. An attachment manifest is not a verified upload, and a stored
preparation is not an accepted message. No model or tool runs from these routes.
The later attachment checkpoint below records the selected staging retention policy; full client activation remains gated.
No Web/Flutter source, device or emulator work was included. Run-owned outputs are
removed after verification; existing APKs, other worktrees and their artifacts stay.

### U1 implementation checkpoint: durable attachment staging (2026-10-27)

Local only. The user chose **seven days** for unaccepted attachment staging.
Gateway schema **1013** adds file receipts, expiry metadata and durable cleanup
jobs; Node schema 2004 / protocol 15 stay unchanged. The backend capability now
includes `canStageAttachments: true` and `attachmentRetentionDays: 7`, while
**`canSubmit: false` remains in force**. Web/Android still use the old flow.

- `PUT /api/conversation-submissions/{id}/attachments/{attachment}` receives raw
  `application/octet-stream` bytes, even for JSON/HTML content. The immutable
  manifest owns the original name/MIME. Size, SHA-256, ownership, private recovery
  workspace access and current cancellation/removal fences are checked. A wrong
  body never substitutes new contents under an existing operation/attachment ID.
- Files use 0700 directories and 0600 files under the Gateway's private
  `submission-staging/<reserved-public-session-id>/`, using only manifest IDs as
  storage names. Uploaded user filenames never become storage paths. File bytes
  are kept outside the metadata SQLite file so expiry can release their space.
- A partial file is created exclusively, synced and published by an atomic
  no-clobber link; the directory is synced before committing its receipt. After
  a lost response/restart, the same complete file can be revalidated and adopted.
  Existing unexpected content or links are refused and preserved. A discovered
  bad file invalidates its old ready receipt; the local original remains needed.
- The seven-day deadline is committed before filesystem work, covering crash
  orphans without a receipt. It is refreshed by a manifest-valid upload attempt;
  GET/status and prepare retries do not refresh it. Expiry only removes staging:
  the pending text, immutable manifest and operation identity remain available,
  and the owner may restage under the same identity. This introduces no expiry
  rule for accepted conversation attachments or shared project notes.
- Status includes `stagedAttachmentIds`, `attachmentsExpiresAt`,
  `attachmentsExpiredAt` and `cleanupPending`. Cancel/project/session removal
  queues cleanup in the same transaction that removes payload/receipts. The
  Gateway retries jobs at startup and every minute in bounded pages. It removes
  only manifest-owned final/partial files, refuses unknown files/directories or
  symlinks, and persists directory deletion before retiring a job. Failed jobs
  rotate so a blocked first page cannot starve later work.
- A cross-connection cancellation test exposed a real WAL snapshot-upgrade race
  in the shared mutation helper. Outermost `atomic` now reserves the writer with
  `BEGIN IMMEDIATE` before reading, retaining nested savepoints and rollback.
  This changes lock acquisition, not memory provenance or deletion ownership.

Validation: **243 Gateway unit/HTTP tests passed**, including 14 new attachment
cases and two explicit transaction regressions. Evidence covers duplicate uploads
through independent SQLite connections, cancel versus upload, response/receipt
loss, 1012→1013 migration, database reopening/startup cleanup, seven-day boundaries,
orphans, workspace deletion isolation, bad files/links, cleanup pagination and
native-device HTTP transfer of a JSON file without a browser Origin. Strict
Gateway Clippy, Rust/changed-document formatting and diff checks passed. These
are local HTTP/storage tests, not an Android device or complete first-send pass.

Remaining U1: idempotent Node upload promotion, durable acceptance and public
publication with fresh authority checks, Node allocation/admission outcome
reconciliation, stable lease/command authority and Web/Android draft persistence
and recovery. No model/tool executes from preparation/staging, and the complete
U1 acceptance table remains open. Source, tests and plan stay local; run-owned
build artifacts are removed after verification, preserving APKs and other work.

### U1 implementation checkpoint: Node attachment transfer (2026-10-27)

Local only. Node schema **2005** adds durable creation-scoped upload identities;
Gateway stays at schema 1013 and the link stays protocol 15. Gateway still reports
**`canSubmit: false`** and clients keep the existing flow. This checkpoint stores
files; it neither accepts the first message nor grants execution.

- Node-only `GET /api/session-creations/capabilities` advertises allocation and
  attachment transfer support. `PUT /api/session-creations/{operation}/attachments/{attachment}`
  binds owner, creation, immutable submission hash, filename, MIME, byte size and
  SHA-256 to one durable upload ID. `GET` on the same path reconciles it. Future
  Gateway integration must refuse unsupported Nodes rather than fall back to
  non-idempotent allocation or uploads.
- A reserved upload ID and random storage name are committed before filesystem
  work. Private files are synced and published without clobbering. A crash after
  file publication or before receipt commit adopts the same complete file on
  retry. A partial file resumes only when its existing bytes match the expected
  prefix. Wrong content, metadata, symlinks, special files and unexpected partial
  bytes fail closed; missing/corrupt ready files return a storage error rather
  than silently recreating an already acknowledged upload.
- Image/file classification matches the legacy upload route. Transfers allow at
  most 16 attachments and honor configured byte limits. Newly created uploads
  are bound to their source session, preventing another conversation from
  retaining a cache ID whose source deletion would invalidate it. Legacy uploads
  retain their existing workspace scope and response shape.
- Session deletion removes both ready files and reserved crash partials after
  checkpoint retention checks and the committed deletion fence. Payload metadata
  is scrubbed; the minimal upload ID/hash tombstone prevents delayed retries from
  reviving files or the session. Existing user workspace files remain intact.
  Project deletion also checks other owners' reserved creations before a session
  row exists. An already completed transfer can still be queried/reconciled after
  mode removal, without granting a new mutation.
- These Node copies are intended for transfer **after durable Gateway acceptance**
  in the next integration slice, not as an additional draft staging location.
  The user's seven-day expiry applies to unaccepted Gateway staging; no new
  accepted-attachment expiry is introduced here.

Validation: **31 creation/transfer tests** passed, plus focused upload/router,
store, runner, checkpoint and pots regressions. Cases include independent SQLite
connections, concurrent delete/transfer, reserved orphans, injected receipt-write
failure, GIF metadata parity, changed bytes/owner, missing storage, symlink/FIFO
refusal, 2004→2005 preservation and deletion of ready/reserved files. Strict
Node/conformance Clippy and Rust formatting passed. A real Node process was killed
and restarted across the WebSocket link: lookup/retry retained the upload and
conversation IDs, and deletion rejected revival. The legacy `node_panels_uploads`
real-process transcript also passed unchanged. No Web/Flutter source, emulator,
Android device, provider or user browser was exercised.

Remaining U1: Gateway durable acceptance/public publication, immutable transfer
integration, fresh execution authority and lease/command admission reconciliation,
then Web/Android draft persistence/recovery and the full acceptance table. The
transfer API alone does not resolve an uncertain command or guarantee execution.
Run-owned artifacts are removed after verification; this checkpoint stays local.

### G0 verification checkpoint: admission-aware conformance (2026-10-27)

A cache-bypassing GitHub API read corrected an earlier stale status: the remote
[Check run at `a926ea38`](https://github.com/mozufu/pirc/actions/runs/40350193507)
finished **failed**, not still running. Its failures included initial-context
measurement, feature transcripts and Node/browser relay timeouts. These repairs
remain **local**; the remote run has not been rerun or made green by this work.

- A real Node reproduced the relay timeout. The fake Gateway waited only for a
  command response while the Agent awaited its `history.authority` or
  `workspace.mirrorState` pre-admission read. Relay now services those existing
  fixture reads while awaiting the matching response, preserving unrelated
  buffered events, strict frame round trips and the finite timeout. The real
  Node's five `node_link_side` cases pass. Production permission/admission behavior
  is unchanged; no early success is restored to break the wait.
- The context-timeout test previously started its clock after `call` returned,
  which is now after the context hook finishes. It now observes the request
  before awaiting acknowledgement, retaining the 2.5–10 second timeout assertion,
  successful admission check and unavailable/stale-memory assertions.
- **42 feature/order transcripts** now place a successful prompt response after
  deferred initial admission. Structured comparison of old/new JSON confirmed
  that all non-response events, tool results, model requests and response values
  stayed identical; only those successful response positions changed. Hook-order
  assertions independently require the user message end and turn start before
  the ACK, and the ACK before the assistant message. Existing synchronous prompt,
  slash command and delivery behavior remains covered.

Validation: **50 Agent real-process tests** across the 13 affected test targets
passed with snapshot updates disabled, plus the five real Node link cases. Strict
conformance Clippy, Rust formatting and diff checks passed. Browser-feature tests
here use fake browser replies; real Chromium Node/browser scenarios and a fresh
Linux CI run are **not** verified. One unrelated `agent_background_tty` transcript
was excluded from the final macOS pass because BSD `od -c` formats spaces
differently from the Linux baseline (that case passed in the recorded Linux CI).
Its original expected transcript is unchanged. No user Chrome was started or
closed, and no Flutter/device, Nix build, remote push or Release was performed.

The complete U1 flow remains gated; these fixture repairs are not a substitute
for Gateway acceptance and Web/Android recovery integration. Run-owned binaries,
logs and snapshot-comparison backups are removed after the local commit.

### U1 implementation checkpoint: accepted intent and Node materialization (2026-10-27)

Local only. Gateway schema **1014** records durable acceptance separately from
unaccepted preparation. Node schema 2005 and protocol 15 stay unchanged. This
joins the existing Gateway/Node identities and file-transfer paths; **`canSubmit:
false` remains the client activation gate** until command admission/recovery and
Web/Android persistence are connected. The internal capabilities additionally
advertise `canAcceptIntent` and `canMaterialize`.

| State                          | Meaning                                                            | Public conversation / execution                                                                                            |
| ------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `preparing`, `accepted: false` | Unaccepted immutable draft/manifest                                | No ordinary session; no Node mutation                                                                                      |
| `accepted`, `accepted: true`   | Validated intent and one public pending session committed together | Node allocation/delivery may still be pending; no message admission claim                                                  |
| `ready`, `accepted: true`      | The same Node creation and attachment receipts are durably mapped  | Files are ready; the first message has **not** been sent to the Agent                                                      |
| `cancelled`                    | A durable non-reusable cancellation/deletion identity              | `accepted` and `acceptedAt` preserve whether acceptance previously happened; content is scrubbed; retries do not revive it |

- `POST /api/conversation-submissions/{id}/accept` accepts only the prepared,
  immutable payload. It makes a read-only Node capability request first, checks
  current workspace/mode/private recovery ownership, available model and upload
  limits, and revalidates file receipts, bytes, SHA-256 and image MIME before the
  commit. A missing upload, expired staging, unsupported/offline Node or removed
  access leaves the draft unaccepted, with no ordinary session or Node mutation.
- One SQLite write transaction publishes the reserved public session ID and
  acceptance together, retaining the original text/manifest, resolved model and
  thinking choice. Rollback cannot leave an empty published conversation. A
  duplicate acceptance returns its durable outcome without another capability
  call or changing settings, even if later configuration becomes unavailable.
  Native-device revocation/expiry is rechecked after the asynchronous preflight.
- `POST /api/conversation-submissions/{id}/materialize` uses the reserved Node
  creation identity and each immutable attachment ID to allocate/map the same
  Node session and transfer raw bytes through the existing authenticated link.
  Files travel in `bodyBase64` with transport `application/octet-stream`;
  their immutable `mimeType` travels in the URL-encoded query alongside filenames.
  Gateway requires Node's `attachmentMimeInQuery: true` capability, refusing older
  Nodes before acceptance. A real-process test caught the earlier assumption
  that `bodyBase64` bypassed JSON parsing: Node's legacy router still parses an
  `application/json` body. The new raw transport preserves JSON file bytes/MIME
  without changing that legacy parser. Remote receipt identities, workspace,
  state, hash and byte size are checked before committing readiness. Lost responses retain acceptance and
  can reconcile with the same allocation/transfer keys; no new public session is
  created. An invalid or deletion-fenced receipt cannot bind another conversation.
- `GET /api/conversation-submissions/{id}` is still a local outcome read. It does
  not allocate, upload, renew control or run anything. Materialization failures
  return the retained accepted intent with a machine-readable `deliveryError`;
  they do not relabel the text as a new unsent message. Neither new POST route
  acquires a lease, sends an Agent command or calls inference.
- A first-message fence prevents ordinary commands from overtaking an accepted
  pending submission; Stop keeps its existing path. The command-admission slice
  must release that fence only after reconciling its original first-message
  receipt. Legacy sessions and specialized creation flows have no such acceptance
  record and retain their current behavior.
- Acceptance removes the seven-day unaccepted deadline. Accepted source files
  remain until the next admission/cleanup stage or authorized conversation/project
  deletion; they are not silently expired. Private file reads now use existing
  Rustix support through `pirc-config`, with `NOFOLLOW`, `NONBLOCK` and descriptor
  ownership/type/mode checks. No dependency/lockfile/Nix cargo hash changed.
- Cancel-versus-accept is fenced in SQLite across independent connections.
  Session/project deletion clears the accepted payload/settings and queues file
  cleanup with the existing memory/deletion ownership rules. **Removing Work is
  different:** accepted pending history is retained behind the removal fence and
  resumes under the same identity only after explicit restore; unaccepted drafts
  keep their existing cancellation behavior.

Validation: **262 Gateway unit/HTTP tests** passed, including 19 new
acceptance/materialization cases; **32 Node creation/transfer tests** and the
private-file descriptor test passed too. Coverage includes independent-connection
publication/cancellation/expiry races, injected receipt commit failure, malformed
receipts, lost transfer responses, staging expiry/MIME, preflight/allocation-time
device revocation, private recovery ownership, Work remove/restore, 1013→1014
migration, missing raw-MIME capability and bearer acceptance without an Origin.
Strict all-target Clippy passed for Gateway, Node, config and conformance.

The real Gateway/Node process proof passed using only a paired token after setup:
prepare/upload/accept, a Gateway crash/restart, Node materialization, independent
Node and Gateway crashes/restarts, same-operation recovery, a competing ordinary
prompt refused, Chat deletion on both hosts, delayed retries refused revival and
startup staging cleanup. The fake inference server saw **zero requests**. The
previous Node-only crash proof and legacy `node_panels_uploads` process transcript
also passed with the latest binaries; the legacy transcript stayed unchanged.
Rust/changed-document formatting and diff checks passed. These are local HTTP,
storage and process checks, not Flutter UI, Android-device, Chromium, Nix build or
remote-CI verification. Run-owned build/log artifacts are removed after the local
commit; APKs, other agents' work and user data are preserved.

Remaining U1: original command/lease admission and read-only receipt reconciliation;
first-send cancellation/deletion before a Node mapping is known (including cleanup
of an uncertain allocation); Web/Android durable drafts, accepted pending display
and reconnect recovery; the complete multi-client failure table. Do not enable
`canSubmit` or claim the first message executed from an acceptance/ready receipt.
No frontend redesign, remote push, deployment or Release is included.

## U1 implementation checkpoint: first-message dispatch and Stop fence (2026-10-27)

Local only. Gateway schema **1015** and Node schema **2006** add the first-message
command ledger and durable Stop fence; protocol 15 is unchanged. This connects
accepted intent/materialized attachments to Agent admission. **`canSubmit: false`
remains in place** until uncertain-allocation cancellation and client recovery
are complete. Existing Web/Android creation is not switched by these capabilities.

- `POST /api/conversation-submissions/{id}/dispatch` takes a held
  `{clientId, generation}`. Before the first attempt, a SQLite write transaction
  checks current owner/device/workspace/mode/model availability, the original Node
  mapping and control lease, then records the single reserved command ID. The
  Node receives the frozen model/thinking/text/upload IDs together. Duplicates
  reconcile receipts; they neither obtain control nor blindly resend a prompt.
- The Node's `POST /api/session-creations/{id}/admission` commits an immutable
  command/input-hash binding before runner work. Under the existing session
  command gate, it sets model and thinking, then enqueues the first prompt. The
  full hash covers settings and submission identity as well as the prompt. A
  conflicting retry cannot substitute content/model/files or another command.
- `GET /api/conversation-submissions/{id}/receipt` may reconcile Node's
  `GET /api/session-creations/{id}/admission`. Ordinary commands also gain
  `GET /api/sessions/{id}/commands/{commandId}` on both hosts. These paths do not
  claim unowned legacy sessions, start a runner, replay commands, renew a lease
  or need a management grant/browser connection. They verify owner, session,
  command and hashes before recording evidence. Deletion hides command contents;
  deletion tombstones cannot prove a previously hidden command was never admitted.
- `sending`, `admitted`, `admission_failed`, `outcome_unknown`, `stopping` and
  `stopped` extend the earlier preparation states. `messageAdmission` separately
  reports `outcome`, `stopRequested` and `stopConfirmed`. Known admission and its
  complete result survive stale pending/error responses. A lost acknowledgement
  or restart before receipt commit stays uncertain rather than becoming success
  or a retryable failure. `admitted` proves Agent acceptance, not task completion.
- For a materialized conversation, Stop records a persistent fence in the same
  transaction as its command receipt.
  Node enqueue shares the DB lock with that fence: Stop either prevents the
  original prompt enqueue or aborts behind the already-enqueued prompt. It cannot
  miss a delayed original send. With no live runner, the fence itself can confirm
  Stop without starting one. Known admission or confirmed Stop releases the
  ordinary-input gate; an explicitly new user message may proceed, while the
  original first-message identity remains permanently fenced. Stop does not undo
  effects that completed earlier, and confirmed Stop can coexist with an unknown
  original admission outcome.
- After confirmed admission, Gateway queues staging-source cleanup and removes
  its transfer receipts; session-bound Node attachments remain available. The
  user-selected **seven-day expiry applies only to unaccepted staging**. Accepted
  pending input/files have no silent age expiry. Session/project deletion retains
  existing source-aware memory deletion and isolated checkpoint recovery rules.
- New initial commands left `received`/`dispatched` at Node restart become
  `outcome_unknown`; legacy `received` commands retain their existing behavior.
  Migrations preserve old sessions, creation/acceptance IDs, command receipts,
  control, memory and checkpoint data. Older binaries refuse the newer schemas.
  No dependency, Cargo lockfile or Nix cargo hash changes are required.

Validation: **275 Gateway unit/HTTP tests** and **416 Node library tests** passed
(three existing Node tests remain ignored). This includes independent-connection
first-dispatch races, foreign/stale leases, response loss, read-only reconciliation,
wrong settings/command/session evidence, Stop-before-send, Stop during initial
configuration, monotonic accepted results/Stop, deletion fences and migrations
1014→1015 / 2005→2006. Existing memory concurrency/large-history, checkpoint and
pots cases remain passing. Strict all-target Clippy passed for Gateway, Node,
config and conformance.

Real Gateway/Node/Agent checks use a paired token after setup, with no browser
connection or management grant: an attachment and exact first message are admitted
once, then both hosts crash/restart and repeated dispatch/receipt queries leave
exactly one user message and one model request. Gateway staging cleans while the
Node file remains intact. A second process case confirms Stop before dispatch,
restarts, refusal of a delayed original send, and successful explicit new input.
The earlier accepted/materialized attachment restart/deletion process proof also
passes. Legacy `node_session_commands` and `node_panels_uploads` process transcripts
pass unchanged with the updated binaries. These are local storage/HTTP/process checks, not Android-device, Flutter
UI, Chromium, Linux sandbox, Nix build or remote-CI verification. Run-owned
build/log artifacts are removed after this checkpoint's local commit; APKs,
other agents' work and user data are preserved.

Remaining U1: cancellation/deletion before a Node allocation mapping is known,
including cleanup of an uncertain allocation; Web/Android durable draft and
accepted-pending presentation/reconnect recovery; the complete multi-client
failure table. Dispatch is deliberately attempted once: even Node
`not_submitted` after a lost request stays uncertain, since another request may
still be in flight. It needs an explicit proven-safe recovery policy or Stop,
not an automatic replay. Keep the client activation gate closed until these
remaining pieces are implemented and verified. Later environment bindings,
mount revocation, canonical collaboration and bounded pots stages remain open.
No frontend redesign, push, deployment or Release is included.

## U1 implementation checkpoint: uncertain allocation deletion (2026-10-27)

Local only. Gateway schema **1016** queues remote cleanup by immutable creation
identity; Node schema **2007** records cancellation even before allocation exists.
Protocol 15 is unchanged. Gateway requires `canCancelCreation: true` before new
acceptance. **`canSubmit: false` remains** until durable Web/Android adoption and
complete multi-client failure/recovery handling are verified.

- Accepted-first-send conversations now use the ordinary
  `DELETE /api/sessions/{id}` entry point even when the Node session ID was never
  received, or the Node is offline. A fresh Delete still checks the existing
  owner and mode's `delete_sessions` permission. It commits the deletion fence,
  payload/settings scrubbing and an identity-only remote cleanup job together.
  Stop is distinct: this route is an explicit conversation deletion, not a
  replacement for stopping a run while retaining its conversation/history.
- The response is **202** with `deletion.state: deleting` and `cleanupPending:
true` while remote cleanup remains unconfirmed; **204** follows confirmation.
  Owner-scoped preparation reads report `cleanupPending` for local and remote
  cleanup and an optional `cleanupError`. Read queries do not initiate cleanup,
  create a conversation, take a lease or replay a message. Discarding an
  unaccepted draft still has no Node side effect and keeps the seven-day policy.
- Gateway's startup/periodic worker retries up to 32 queued jobs per page with
  four in flight, ordering by last attempt so failed jobs do not hold a fixed
  first page forever. The original owner-authorized deletion survives its device
  token/browser disappearing and is scoped to that one recorded creation.
  Reconnection after Gateway or Node restart does not require a browser login,
  management grant or Web page. No arbitrary Node action is authorized by the job.
- Node `POST /api/session-creations/{id}/cancel` takes the immutable workspace ID
  and submission hash; `GET` at the same path reads its outcome. A cancellation
  that beats allocation commits a permanent owner/operation tombstone without
  creating a session or files. If allocation already exists, it fences its
  session in that same SQLite write transaction. Late allocation, attachment and
  first-admission requests cannot revive it. A changed hash/workspace conflicts;
  another owner's operation and private recovery workspace remain protected.
- Ready sessions use the existing runner/terminal/browser shutdown, checkpoint
  retention check, upload/session cleanup and shared in-flight deletion task.
  The new internal path is restricted to creation-owned data; the legacy public
  delete route keeps its existing mode permission check. Workspace roots and
  user files there are retained. An interrupted reservation can remove only an
  empty allocated directory; unexpected contents/symlinks remain untouched with
  cleanup pending. Unavailable mode/storage/checkpoint cleanup also stays pending;
  the deletion fence persists and cleanup retries without claiming success.
- Gateway validates the cancellation's operation/workspace/hash and, if already
  known, exact Node session ID. It retires the remote job and completes local
  session deletion/source-aware memory forgetting together only after matching
  `complete: true` evidence. A missing mapping never causes a fresh allocation
  merely to discover what to delete. A late allocation response cannot publish
  its mapping after the local deletion fence. Project/session deletion triggers
  also enqueue accepted first-send cleanups, including previously cancelled rows
  migrated from schema 1015. No prompt/file contents are copied to the job table.

Validation: **282 Gateway unit/HTTP tests**, **422 Node library tests** (three
existing ignores) and strict all-target Clippy for Gateway/Node/config/conformance
passed. New cases cover independent-connection allocation/cancel races,
pre-allocation tombstones, crash/reopen recovery, malformed completion evidence,
mode permissions/removal, owner isolation, unexpected reserved contents, late
mapping publication and 1015→1016 / 2006→2007 migrations. Existing memory
concurrency/large-history, checkpoints, pots and legacy Node library cases pass.

Five real Gateway/Node/Agent process cases pass with the new binaries: the two
new cancellation cases accept through a paired token, stop only the fixture
Node, request deletion while it is offline, crash/restart Gateway, observe
honest pending cleanup, then resume the same Node and verify eventual cleanup.
Both a missing Node mapping and already-materialized attachment are covered;
late accept/materialize/dispatch/prepare requests do not revive work, workspace
sentinel data survives and no model request occurs. Earlier first-admission/Stop
and accepted-attachment restart/deletion cases remain passing. Legacy
`node_session_commands` and `node_panels_uploads` process transcripts also pass
unchanged. These are local
HTTP/storage/process results, not Flutter UI, Android-device, Chromium, Linux
sandbox, Nix build or remote-CI verification. Only this run's build/log artifacts
are removed after the local commit; user APKs, other agents' work and data remain.

Remaining U1: persist/account-scope Web and Android drafts/files and operation
identities; wire accepted-pending display, initial control/admission, receipt and
deleting-state recovery; complete the multi-client failure table (including
controls while an accepted conversation still lacks a Node mapping). Keep fresh
mode/owner permissions and the distinction between Stop, draft discard and
conversation deletion when adding those client controls. Later binding/resource
transition/collaboration/pots stages and frontend redesign deferrals are unchanged.
No remote push, deployment or Release is included.

## U1 implementation checkpoint: Web durable drafts and recovery (2026-10-27)

Local only. Web now has the durable client path behind negotiated capabilities;
**Gateway still advertises `canSubmit: false`**. This checkpoint does not activate
it for ordinary users or complete U1. Gateway 1016, Node 2007 and protocol 15 are
unchanged; there are no dependency, lockfile or Nix cargo-hash changes.

- The IndexedDB adapter scopes each draft by Gateway origin and authenticated
  owner, stores original text/model/thinking and Blob bytes, and resolves writes
  only after a strict-durability transaction completes. Revision checks serialize
  competing tabs. Quota/storage refusal prevents network submission; it never
  silently falls back to the legacy create-and-send route. The client reserves
  its local draft identity before the initial storage await. Delayed commits,
  navigation, queued edits and account switches cannot replace a newer selection
  or resurrect a discarded draft. Empty abandoned drafts are removed only if
  still empty and mutable when the transaction runs.
- Explicit Send freezes and persists the operation and attachment hashes before
  any preparation request, then uses the existing prepare/upload/accept/
  materialize/dispatch APIs. All retries keep the original operation, workspace,
  manifest and public session identity. Only durable acceptance publishes a
  session. The composer clears after known admission and opens the actual server
  snapshot; it does not fabricate an accepted transcript locally.
- Necessary recovery controls use existing styles: saved drafts/pending sends,
  collapsed original input, Check result, explicit Continue, Take control, Stop
  and the existing conversation/memory deletion confirmation. Check result and
  reconnect reconciliation only query outcomes; they do not open the normal
  controlled session, acquire/renew a lease, allocate or replay a prompt.
  Admitted results offer explicit Open conversation. Unknown dispatch stays
  query-only. A missing preparation after a lost prepare response permits an
  explicit continuation with that same idempotency key. Known Stop releases the
  pending gate explicitly while retaining the original input for inspection.
- Capabilities now return `ownerUser`, `canFenceAccount` and
  `canFindPendingSession`. Durable requests pin the expected account using
  `x-pirc-account` (encodeURIComponent of the authenticated owner); a changed
  account receives `409 account_changed` before mutation. Preparation also pins
  `expectedOwner` in its body so an older strict backend rejects the new request
  rather than accepting it under changed browser cookies. The optional header
  does not change legacy clients. Cold recovery first requires authenticated
  capabilities; transient offline checks retain already-open local content.
- `GET /api/conversation-submissions/session/{publicSessionId}` finds only the
  authenticated owner's accepted, non-deleted first intent without known
  admission. Another device can inspect/adopt that pending input without local
  attachment bytes or automatically dispatching it. Stop, draft discard and
  accepted conversation deletion retain their separate permission/lifetime rules;
  confirmed deletion scrubs the local text/bytes and retains cleanup status until
  completion. The seven-day deadline still covers only unaccepted Gateway file
  staging, not accepted attachments or private local drafts.

Validation: **478 Web tests across 64 files** (including **25 focused first-send
tests**), typecheck (zero errors/warnings) and production build pass. Gateway
**284 unit/HTTP tests** and strict all-target Clippy pass, including
account-change refusal and owner-scoped pending discovery
without a Node request/lease. Focused client tests cover real App-state send,
storage refusal, competing revisions, delayed writes/navigation, lost replies,
read-only checking, remote pending adoption and account isolation. The dedicated
Headless Shell proof (`node apps/web/tool/check-first-send-storage.mjs`) exercises
the production IndexedDB adapter across page reload and browser close/relaunch,
Blob restoration, aborted-write rollback and two-tab contention. It uses only a
run-owned profile and the repository's isolated test browser, never user Chrome.
This is a real storage-browser proof, not a full browser-to-Gateway/Node/Agent or
Android-device acceptance. The production build reports a non-fatal large-chunk
warning; UI redesign/performance work remains outside this slice.

Remaining U1: native Android private durable storage and controller/recovery
adoption; the full multi-device/restart/permission matrix and a real integrated
client-to-Gateway/Node/Agent proof. Stop before a Node mapping is known is still
unimplemented in the client (Delete is not its substitute). Removed-workspace/
model and cancellation-before-preparation recovery also need full matrix proof;
input stays retained rather than claiming completion. Keep `canSubmit` closed
until those gates pass. Later binding/revocation/tasks/pots stages remain open.
No Flutter code changed or device/emulator/Nix/remote-CI verification ran in this
slice. Source and commit stay local; only run-owned build/log/scratch artifacts
are removed, preserving APKs, test-browser cache and others' work.

## U1 implementation checkpoint: native durable submission engine (2026-10-27)

Local only. Android now has a native storage/transport/submission engine exposed
through the existing Gateway MethodChannel. **The Flutter LiveController and
recovery UI have not adopted it yet**; existing App behavior is unchanged and
Gateway still advertises **`canSubmit: false`**. This is a U1 client foundation,
not completed Android or end-to-end first-send acceptance. Gateway 1016, Node
2007, protocol 15 and all dependency/lockfile/Nix hashes are unchanged.

- `FirstSendDraftStore` uses the App's private `noBackupFilesDir`, scoped by
  Gateway origin and authenticated owner. Original text/model/thinking and file
  metadata commit only after referenced attachment bytes have been synced. SHA-256
  filenames, atomic metadata replacement and directory sync avoid a partially
  published manifest. Thread/process locks and compare-and-swap revisions protect
  concurrent windows; a transform runs under the same file lock. Discard leaves
  an identifier-only tombstone before removing owned blobs, so delayed writes
  cannot recreate it. Unexpected symlinks, corrupt metadata/bytes and storage
  errors fail visibly instead of deleting content or falling back to sending.
- Attachments remain private native files, not a Base64 copy of all draft bytes
  on every keyboard edit. Upload rereads and verifies the stored bytes against
  their size/hash. Existing Android selection limits remain 8 MiB per attachment,
  with at most 16 manifest entries. Orphan bytes without a committed record do
  not appear as conversations. Only positively owned files are removed; there
  is no recursive cleanup of user directories or another account's drafts.
- `NativeFirstSend` binds an authenticated capability response to the current
  pairing stamp/owner and captures the original API connection. Local edits do
  not need network calls or decrypt credentials per keystroke. Pair/unpair and
  late old-account replies invalidate access; same-origin/owner reauthentication
  can recover its original files. The native APIs expose controlled submission
  actions rather than letting Flutter manufacture admission/stop states or
  forget an uncertain send through a generic draft edit.
- Explicit Submit commits frozen input and the prepare-attempt marker before
  HTTP, then uses existing preparation, staged upload, acceptance,
  materialization, control and dispatch identities. The native install's client
  ID is used for the lease. Check is outcome-only: it never creates, takes
  control or sends. A lost prepare response can continue under its original key
  after lookup; unknown dispatch is never replayed. Pending discovery/adoption
  supports another device's accepted intent without requiring its local bytes.
- Stop persists one command ID before requesting control and checks that receipt
  before any retry. Take control is an explicit separate action. Confirmed Stop
  can release the input gate while retaining the original input. Cancellation
  uses local discard before preparation and the existing owner/mode-authorized
  Gateway deletion after acceptance; pending cleanup remains visible. Stop before
  a Node mapping is known is still unavailable and is not replaced by Delete.
- `FirstSendApi` pins `x-pirc-account`, uses the paired authenticated Gateway
  directly, restricts routes and rejects normalized traversal. It sends raw
  attachment octets, disables redirects/connection retries and marks mutation
  bodies one-shot, including against automatic `503 Retry-After: 0` replay.
  Neither a live Web page nor a management grant is required.
- Native recovery checks exposed two Web receipt-merge defects. Same-phase
  admitted receipts now update Stop confirmation, and cancelled receipts can
  advance from cleanup pending to complete. Both clients preserve confirmed Stop
  and completed deletion against late older evidence without reviving input.

Validation: **25 focused native JVM tests** pass (**22 new first-send cases**
and three existing ReadRecovery cases), with no skips. The Android main Kotlin
code and targeted unit classes compile against the actual app configuration.
**27 focused Web first-send tests** and Svelte typecheck (zero errors/warnings)
pass for the receipt corrections. Native cases cover disk reopen/Blob verification, two independent storage connections,
failed metadata validation, orphan files, corrupt/symlink paths, frozen input,
account switching, lost dispatch replies, query-only unknowns, fixed Stop IDs,
delete completion, activation gating and rejection of forged admission/unsafe
forgetting. Transport tests use only a local MockWebServer and synthetic tokens;
no provider or third party receives data. Web first-send regression tests and
Svelte typecheck cover the shared receipt corrections. This is **not** a Flutter
widget, APK/device, process-death, Linux sandbox, Nix or remote-CI pass. A reopened
store/JVM fixture is not proof of an Android process being killed/restarted.

Remaining U1: wire Flutter LiveController draft/file persistence, creation/send,
pending recovery controls and cross-account/navigation/lifecycle guards to this
engine, then run focused Flutter checks and the real client/Gateway/Node/Agent
failure matrix. Keep client activation closed until that work and the unknown
mapping/permission-removal cases pass. Later binding/revocation/tasks/pots work
and UI redesign deferrals are unchanged. Only this run's temporary build/log
artifacts are removed; APKs, SDKs, existing build output and other agents' work
are preserved. No push, deployment or Release is included.

## U1 implementation checkpoint: Flutter controller and recovery wiring (2026-10-27)

Implemented locally. Flutter now adopts the native durable engine for negotiated
first Send; **Gateway still advertises `canSubmit: false`** pending the remaining
failure/integration gates. This supersedes the earlier native checkpoint's
controller/UI adoption limitation, but does not complete U1. Gateway 1016, Node
2007, protocol 15, package versions and dependency/Nix hashes are unchanged.

- `FirstSendState` owns the client wiring within the existing LiveController.
  Create reserves its local operation before awaiting storage; edits, selected
  model/thinking and attachment removal are persisted through native revisions.
  Files are stored locally before submission, with only new bytes crossing the
  channel; subsequent edits carry metadata. Cold-restored accepted intents can
  continue from Gateway-owned files without pretending to have local copies.
  Attachment-only first Send works through the normal button/desktop Enter.
- Actual Send uses native submit rather than legacy session creation, settings
  commands, upload and prompt calls. A storage failure retains the current text
  and cannot expose that old path. The composer clears only after known admission
  and opening the real session; there is no invented local transcript. Frozen or
  in-flight input cannot be edited or retargeted. Before admission, approval-mode
  overrides remain unavailable: this U1 slice uses the workspace's existing
  default rather than implying an unsupported per-message permission change.
- Navigation, account changes and late replies are fenced by owner/pairing,
  selection and operation identity. Local revision watermarks reject stale
  callbacks, including after a dismissal. Page/project/back navigation drains
  writes before leaving; storage failure keeps the newest visible input. Leaving
  during a send does not jump back on admission. Empty mutable drafts are pruned
  only after their queued writes; nonempty input remains recoverable. Explicit
  pair/unpair drains local writes before retiring the binding.
- Existing sidebar styling now contains a collapsed saved-draft/pending-send
  entry. A pending first message replaces the composer with a compact recovery
  card: original text is collapsed and previews are bounded before layout. Check
  is query-only, Open conversation is explicit after a checked outcome, and
  Take control/Stop use their separate native actions. Resume/background handling
  does not watch local draft IDs or send them automatically. Deletion events
  reconcile the original private record without reviving the view.
- Discarding an apparently unaccepted draft cannot silently become accepted
  conversation/memory deletion. The UI refreshes local state before confirmation;
  native cancel additionally requires explicit `deleteAccepted` consent before
  using the accepted-session Delete route. It persists that consent separately
  from `cancelRequested` for a retry, and returns `confirmation_required` if
  acceptance won a race. Declining retains the input; ordinary owner/mode
  permission checks and source-aware memory deletion still happen at Gateway.
- A failed cold capability negotiation blocks new creation instead of guessing
  that the old split flow is safe. Older unsupported bridges and an explicit
  `canSubmit: false` retain their documented legacy behavior. Previously reserved
  operations never fall back. Authenticated native recovery/discovery remains
  available with the new-send gate disabled; new execution remains disabled.
  Already-bound drafts stay editable through a transient network failure. Cold
  restoration still needs authenticated capabilities before exposing private
  data; private bytes remain on disk while offline.
- Refreshing identical native capabilities now reuses the same bound connection,
  so a foreground refresh cannot interrupt an in-flight Send. Changed identity
  or activation still retires that binding. New functional labels and deletion
  warnings are present in English/Traditional Chinese; existing renderer,
  navigation structure and visual design are retained.

Validation: **20 focused Flutter tests** pass (13 controller/boundary cases,
three widget cases including the actual App shell, and four legacy first-send
regressions). Targeted Dart analysis reports **no issues**. **28 native JVM
cases** pass without skips, including concurrent capability refresh during a
held HTTP acceptance, another device adopting staged files without local blobs,
explicit accepted-delete confirmation and the earlier storage/transport cases.
Flutter boundary tests use a fake native port; native filesystem/HTTP tests use
synthetic loopback fixtures. They are separate proofs, not an actual Android
MethodChannel-to-Gateway/Node/Agent process or device pass. No full Flutter suite,
emulator, APK build, Nix or remote CI was run. Only run-created test caches,
isolated native output and logs are removed; APKs/SDKs/preexisting output stay.

Remaining U1: the real client/Gateway/Node/Agent multi-device, restart and
permission failure matrix; actual Android process-death/filesystem validation;
Stop before a Node mapping is known; removed workspace/model cancellation and
usable known-admission-failure recovery. Include preservation of unsaved edits
when another window freezes/accepts the same operation, older-client command
fencing through accepted/materializing states, and Web's cold-negotiation and
rollback recovery alongside Android. Keep activation closed until those gates
pass. Later bindings, mount revocation, canonical collaboration and bounded pots
stages remain open. This checkpoint stays local with no push/deployment/Release.

## U1 implementation checkpoint: Node pre-allocation Stop foundation (2026-10-27)

Implemented locally as the Node half of pending-creation Stop; **U1 and the
public Stop integration remain incomplete**. Node schema **2008** adds an
owner/operation/workspace/manifest-bound execution fence without reserving a
session, creating files, publishing a conversation, starting an Agent or deleting
history. Gateway schema 1016, protocol 15, dependency locks and package versions
are unchanged. Gateway still advertises **`canSubmit: false`**.

- Node-only `POST /api/session-creations/{operation}/stop` records a pre-admission
  Stop from the immutable `workspaceId` and `submissionHash`. GET on the same
  path reads its confirmation, with a nullable Node session ID. Node capabilities
  advertise `canStopBeforeAllocation: true`; this is not a client-facing control
  lease or permission to bypass Gateway authorization.
- Allocation/initialization and initial command intake use the same SQLite write
  transaction boundary as this fence. A delayed or explicitly requested blank
  allocation can still initialize storage, but its original first message remains
  permanently stopped. Stop by itself does not allocate that storage. Explicit
  new commands still require the normal fresh lease and mode authorization.
- If initial command intake already started without a confirmed ordinary Stop,
  this endpoint returns `409 initial_admission_exists`: the caller must use the
  established leased session Stop. It never claims to abort a command that may
  be executing, and neither duplicate requests nor delayed retries abort later
  work. A previously confirmed ordinary Stop can be adopted without re-aborting.
- Owner, recovery-workspace privacy and immutable manifest binding apply. Stop
  works even after the workspace mode is removed, because it grants no new
  execution authority. Stop/Delete retain the same identity in either order;
  cancellation remains the stronger fence and cannot be reversed into creation.
  History, uploads, user files and memory sources are not erased by this API.
- Schema 2007 upgrades to 2008 without changing existing sessions, commands or
  admission records. Old Node binaries refuse schema 2008; back up Node state
  before any future upgrade, and restore the complete matching backup on rollback.

Validation: **440 Node library tests pass**, including **18 new pre-admission
Stop cases**; three existing subprocess-only helpers remain ignored in the
ordinary library invocation. Coverage includes independent SQLite-connection
allocation/intake races, durable reopen, owner/private-checkpoint guards,
Stop/Delete ordering, removed mode, immutable identity and 2007-to-2008 plus
historical schema migrations. **Two required real Node process tests pass**
with a synthetic loopback Gateway: the new case hard-kills/restarts the Node,
reads the original pre-allocation Stop, permits blank allocation, rejects late
initial execution and preserves the allocation/fence after another restart.
The existing durable attachment/crash/delete process regression also passes.
These are Node/link proofs, not a real Gateway/client or Android device pass.
Strict Node/conformance Clippy (`--all-targets -- -D warnings`), targeted Rust
format checks and `git diff --check` pass. Only this run's isolated Rust target
and logs are cleaned; APKs/SDKs, browser caches, user data and other work stay.

Remaining integration: Gateway must durably authorize/queue/reconcile this Stop
before a Node mapping exists, serialize it against dispatch, preserve uncertain
receipts and expose accurate mapping readiness. Web/Android then need explicit
control/Stop and safe blank-conversation continuation without replaying original
input. A real client-to-Gateway-to-Node failure matrix remains required. No
frontend change, Flutter test, APK build, emulator, device, Nix validation,
push, deployment or Release is part of this Node foundation. All later goal
stages and the other U1 gates listed above remain open.

## Design stages and later implementation gates

All unchecked work is future work; no stage grants implementation authority.
The [integrated architecture review](unified-architecture-review.md) separates
corrected contradictions, pending product settings and engineering proof gates;
its review scope is this architecture family, not every historical repository plan.

### A. Relationship and workflow review — current priority

- [x] Record the user's direction and separate present behavior from proposals.
- [x] Draft concept relationships, lifecycle boundaries and primary journeys.
- [x] Define independent-App criteria and keep Flutter Web optional.
- [x] Record the 2026-10-24 user requirements: configured workspaces, project
      mounts/unmounting, shared collaboration, task emphasis and attributed pots.
- [x] Record decision A and warning/confirmed-revocation/agent-notification behavior
      for running workspace changes, 2026-10-24.
- [x] Record the user's acceptance of the specification-review recommendations,
      2026-10-24, as the design baseline rather than unresolved alternatives.
- [x] Record acceptance of the seven follow-up behavior recommendations and detail
      capability composition, message/task routing and overlapping grants in
      [Conversation execution contracts](conversation-execution-contracts.md).
- [x] Extend the detailed contracts to items 4–7: Node switching, lifecycle/deletion,
      historical/live content and pots coordination, including 32 future acceptance
      cases. This records specifications, not passed runtime tests.
- [ ] Validate enforcement for active workers/descriptors and offline hosts;
      specify remaining permission defaults and project-note lifecycle details.
- [ ] Inventory existing API/storage identities against each proposed concept and
      resolve incompatible lifecycle/permission rules before a schema proposal.

### B. Shared contracts and transition design

- [ ] Specify task/attempt/decision transitions, command fencing and event recovery.
- [ ] Specify native identity/bootstrap, renewal and scoped management transitions.
- [ ] Specify safe mount/context handoffs, memory provenance and deletion/move
      behavior, including descendants, offline hosts and interrupted transitions.
- [ ] Specify project board/notes and structured resource waiting, reusing existing
      team/task and Node write-broker behavior without adding competing authority.
- [ ] Define migration/version compatibility, staged rollout and fallback criteria.
- [ ] Sketch Web and App journeys in the existing design language; do not copy
      current Chat/Work navigation simply to preserve screenshot parity.

### C. Implementation proposal, only after approval

- [x] Propose a bounded delivery sequence: reliable first Send, environment-binding
      foundations, unified navigation, real resource transitions and canonical tasks
      (2026-10-26, above). This completes planning of the sequence, not implementation.
- [ ] Propose App setup/synchronization independence as a parallel contract concern,
      with mobile-only acceptance for every delivered flow.
- [ ] Add pots overview, authenticated dispatch attribution and durable decisions
      before expanding proactive discovery. Partly delivered: the overview, durable
      suggestions/tasks and explicit attributed dispatch exist
      ([pots](pots/README.md#delivered)); durable decisions remain.
- [ ] Add scoped observation, quiet suggestions and authorized coordination. Only
      progress-event observation exists; see the [pots queue](pots/README.md#remaining-work-queue).
- [ ] Evaluate Flutter Web separately; retain the current Web until acceptance
      supports an explicit migration decision.

## Acceptance scenarios to design and later verify

No scenario below has been executed by this documentation task.

| Scenario                                       | Required outcome                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Open/abandon several empty drafts              | No phantom sessions; workspace choices retained; explicit user-created folders are not deleted; first-send retries are idempotent |
| Discuss, then implement                        | Same visible conversation; explicit environment and authority; no blanket assistant-memory transfer                               |
| Plain project without a repository             | Managed empty workspace supports ordinary chat; selected folder/config mounts work without requiring a Git repository             |
| Move conversation / change default environment | Display/default changes do not redirect active work; membership change revokes project-derived access through a fenced transition |
| Multiple agents and an external editor         | No hidden overwrite; isolated attempts or explicit conflicts; checkpoints preserve later user changes                             |
| User takes over a pirc-managed task            | Stale assistant commands fenced; running work status shown; no silent reclaim                                                     |
| All desktop Web pages closed                   | Phone can sign in, create/continue work, answer decisions and perform authorized management                                       |
| App suspended / notification missed            | Backend tasks persist; phone reconciles inbox/status when opened; real push tested separately                                     |
| Same confirmation on two devices               | One recorded outcome; duplicate is shown as handled; stale notifications cannot execute it again                                  |
| Network fails during send or approval          | Draft/outcome preserved; reconnect reconciles status without blind replay                                                         |
| Gateway works but Node is offline              | Overview/cached state remains useful; affected execution clearly unavailable                                                      |
| Credential revoked / account switched          | Authority ends and account data is isolated; no stale credential retry loop                                                       |
| Suggestion ignored or snoozed                  | No execution, repeated nagging or automatic widening of observation scope                                                         |
| Upgrade existing data                          | Links, memories, schedules, approvals and recoveries remain attributable; no duplicate work                                       |

Additional acceptance: leaving while a shell/child is active cannot report
unmounted prematurely; an unavailable Node leaves the transition pending; old
project board retrieval is refused after departure; retained dialogue still works
as model context. Canceling the warning changes nothing; confirming rejects old
queued/approved tools, reports interrupted effects and delivers the user-change
event without a mandatory follow-up question. A running child with an open file
must not retain removed authority after transition completion. Duplicate or
concurrent switches are reconciled by revision; reconnection cannot revive the
old binding. Temporary file contention is
visible and release wakes a waiter without replaying a stale edit. A forged
"pots" text label never obtains dispatch authority.

## Specification review: what is not detailed enough (2026-10-24)

The user accepted this review's recommendations on 2026-10-24. The resulting
baseline is recorded above; this is still not a complete implementation
specification. The gaps below now distinguish remaining engineering detail from
specific defaults not previously proposed. Do not reopen accepted choices or ask
the user to design locks or Rust traits. App topology and Flutter Web stay deferred.

### 1. Live transition failure and recovery — foundational

**Missing:** a durable state machine, commit boundary, acknowledgement ownership,
partial effects, offline behavior and the exact process boundary. The agent itself
currently runs inside the sandbox: preserving a conversation does not establish
that the same agent process can survive a mount change. Specify what the Node
supervisor persists before stopping/restarting an agent and its descendants.

Adopted transition model (internal labels, not finalized API enum values):

| State            | Required fact                                                             | Permitted next behavior                                                                     |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Preview          | Current binding/revision and affected tools/resources shown               | Cancel without mutation; confirm against that revision                                      |
| Accepted         | Transition intent durable; old-generation dispatch fenced                 | Notify execution host; duplicate request returns this transition                            |
| Revoking         | Host stops affected effects/children and retires old authority            | Keep UI applying; never claim the old mount is already inaccessible without acknowledgement |
| Preparing        | Revocation acknowledged; replacement policy/environment being prepared    | New workspace effects remain blocked                                                        |
| Ready            | Host acknowledges installed binding; canonical revision committed         | Deliver trusted environment-change event and accept new-generation effects                  |
| Blocked / failed | Last completed stage, affected resources and outcome uncertainty recorded | Retry/reconcile; no silent regrant of the removed resources                                 |

If the new workspace fails after old access was revoked, remain blocked or use
an explicitly selected safe environment. Do not restore old project access as
an automatic rollback. A transition to server B must not expose new execution
as ready while server A's removed authority remains unaccounted for. Unrelated
user programs are not killed to enforce an agent's transition.

**Engineering deliverable:** state diagram and a failure matrix for every stage,
including Gateway/Node restart, two devices switching simultaneously, an in-flight
model reply proposing an old tool call, old terminals, open descriptors and
orphaned background children. Define notice ordering and restart reconstruction.

**Gate:** one command ID yields one transition; each crash point resumes safely;
old approvals/tool calls cannot act after revocation; original changes survive.
Reconfirming context retention or the warning is unnecessary: both are decided.

### 2. Resource identity, mount precedence and default cwd — adopted model, remaining defaults

**Remaining:** physical alias enforcement, resource lifetime and the project-wide
transition implementation. The initial permission policy is now adopted. Overlap behavior
is now adopted in the [effective-access contract](conversation-execution-contracts.md#effective-access-rules),
alongside the overall shape and inherited project configuration.

Adopted shape: one chosen main working directory plus named mounts.
Each mount has a stable resource ID, Node ID, resolved source identity, alias,
read/write mode, grant source (project or explicit conversation grant), revision
and ownership (user folder or pirc-managed allocation). The same underlying
folder must not gain separate write-lock identities merely through two aliases.
Do not claim Node-local path identity solves cross-Node shared filesystems.

The current [sandbox policy](../docs/deploy/sandbox-and-browser.md#what-the-policy-is)
allows broad reads outside private paths. Removing a mount alone cannot meet the
new requirement if the old path remains readable through that policy or a parent
mount. Enforce the adopted deny/grant precedence and validate symlink/parent
aliases. An independent grant must be visible; it must not be invented to defeat
removal. Current policy behavior is not proof of the new contract.

**Adopted defaults:** explicitly select/show the main folder and access scope;
new additional folders default to read-only unless granted writes. Existing grants
survive migration. A separately granted path is retained and disclosed on leaving;
an explicit folder block overrides it. Project changes inherit with an affected-
conversation preview and enforced revocation. Per-host acknowledgement and partial
failure handling across affected conversations remain engineering work.

**Gate:** overlapping read-only/read-write roots, duplicate aliases, removed cwd,
missing paths and unauthorized creation targets have deterministic outcomes.
Empty-draft abandonment never deletes a user-created folder. Managed allocation
occurs at first accepted send unless the user explicitly invokes Create folder;
retries must not duplicate the folder or conversation.

### 3. Project rules, shared notes and retained context — adopted structure, remaining lifecycle

**Remaining detail:** authoritative storage, precise editor scopes, the
revision/conflict protocol, retention/search and delivery of rule revisions at
the adopted safe turn boundary.

Adopt three separate records: approved project rules, revisioned project notes,
and an append-only attributed board (subject to explicit retention/deletion).
Keep Node file enforcement independent from all three. Agents can propose rule
changes; ordinary board posts cannot overwrite rules or grant permissions.
Concurrent note edits require expected revisions and conflict review.

Decision A remains in force: old dialogue stays model context. After departure,
the active prompt states the new environment and effective rules; old quoted
rules are historical material, not current policy. No fresh retrieval may use the
departed project's authority. Independently granted folder reads keep their own
scope; they do not preserve membership or active rule injection. A departure does
not change memory authorship or delete other agents' notes. Global USER/MEMORY and repository handoffs retain their existing provenance.

**Adopted:** authorized project agents may maintain notes directly with provenance
and revision conflicts; project rules remain user-controlled. Ordinary rule edits
apply at the next safe turn boundary with the revision recorded; access
revocations use the confirmed live-transition flow.
**Remaining:** detailed editor scope, retention/search settings, storage/migration
mapping and implementation of the adopted lifecycle/deletion contract. Existing
global memory is not automatically re-scoped.

**Gate:** two agents cannot silently overwrite each other's note; project leave
removes fresh retrieval but retains conversation history; old rules cannot restore
an old grant; deletion previews enumerate the relevant records and exclusions.

### 4. Tasks and existing goal/todo/team tools — engineering mapping plus UX choices

**Missing:** one authoritative task identity, mapping to existing `goal`, `todo`
and team `task_*` tools, automatic-creation criteria, completion and retry semantics.
Without this mapping the redesign would add another task list to an already
redundant experience.

Adopt one durable product task per meaningful objective. A goal describes its
objective; todos/milestones are progress within it; a delegated team task maps to
a child task or an internal step. Choose that mapping explicitly before changing
storage or showing totals. The same job seen in a conversation, project or pots
must keep one identity and one authoritative status.

Define owner, origin request, parent/dependencies, target binding, attempts,
blocking reason, artifacts, acceptance criteria and cancellation intent. An agent
ending a turn is not proof that its background jobs finished. Retry adds an
attempt, preserving the old outcome; it does not manufacture a second objective.
Do not infer execution permission from creating or accepting a task record.

**Adopted:** automatic tracking for background and multi-agent work, optional
tracking for brief edits, and Ready for review when the request explicitly needs
user acceptance. Show stages/known counts instead of invented percentages.
**Remaining:** examples defining the complex-work threshold, the mapping of team
tasks to children versus internal steps, and validated completion conditions for
work that does not require human acceptance.

**Gate:** a parent cannot finish while required child work remains running or
blocked; cancellation does not silently restart it; Web and App show the same
milestones without duplicate goal/todo/task counts.

### 5. Collaboration waits and isolation — engineering detail, limited UX choices

**Missing:** queue/wait identity, release events, fairness, deadlock handling,
crash cleanup and a deliberate same-folder versus isolated-worktree policy.

Specify a host-reported wait with task/attempt, resource, holder, reason and
cancellation token. Release invalidates the wait and prompts rechecking grants
and current file contents; it does not directly execute a previously computed
edit. Scheduling wake-ups should not consume repeated model calls. Avoid lost
wake-ups if release happens while the waiter subscribes.

Detect A-waits-for-B/B-waits-for-A cycles. Stop/escalate or reschedule work safely;
do not unlock an active writer after an arbitrary timer. A crashed holder and
its children must be reconciled before another writer is granted access.
External editors and arbitrary shell writes remain outside complete attribution.

**Adopted:** shared reads and non-overlapping edits, with isolated worktrees
available for overlapping parallel writes. Their results require explicit
integration/review. Define the placement suggestion and conflict presentation;
detailed queue algorithms and lock bookkeeping are engineering decisions.

**Gate:** release races, stopped holders, cycles, external edits and a late waiter
cannot cause silent overwrite, false completion, infinite polling or bypass.

### 6. pots authority, instruction conflicts and attention budget — user policy

**Missing:** a grant matrix, instruction precedence, budget accounting and the
lifetime of recurring responsibilities. The verbs "observe" and "coordinate"
are not sufficient to determine who may start/stop/change a particular task.

Specify per-scope read-progress/read-content, suggest, create-task, dispatch,
follow-up, stop/reprioritize and notify grants. Separate issuing an instruction
from authorizing the target's tool effect. Each dispatch records pots identity,
originating user request or standing grant, target, current grant revision and
idempotency identity. Verify the same grant at delivery and effect boundaries.

Explicit user stop/takeover supersedes queued pots dispatch; pots may
report a resulting conflict but cannot relaunch the task automatically. A comment
from another agent or an external source is not the user's new instruction.
Direct user takeover suspends coordination only for the affected task and its
scoped dispatch. Unrelated responsibilities continue; broader pausing has its own
explicit control. See the accepted follow-up and message routing contract.

**Adopted:** pausing new coordination and stopping running tasks are separate
controls with visible scope. No implicit restart after user stop/takeover.
**Adopted activation policy:** user-selected observation scopes, distinct progress/
content rights, no autonomous dispatch without an explicit request or standing
grant, and finite configured budgets/bounded concurrency. Nonurgent suggestions
use quiet digests/inbox. Actual scope selections, grants, numeric limits, quiet hours
and cadence are configuration work; no specific amounts or times were approved.

**Gate:** repeated events produce one actionable suggestion; dismissed suggestions
stay quiet until materially changed; denied/revoked grants survive retries;
budget exhaustion is reported; agents cannot create a mutual-dispatch loop.

### 7. Shared client commands and synchronization — specify now, topology later

**Missing:** request/result envelopes, cursor scope, revisions, reconnect fallback,
local drafts and canonical versus local UI state. Independent App acceptance
cannot be reduced to having an HTTP connection.

Adopted contract requirements (logical fields, not finalized routes/schema):

| Contract             | Minimum identity/state                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Command              | Owner from authentication; actor; target IDs; idempotency key; expected revision; binding/grant generation where relevant |
| Command outcome      | Accepted/applied/rejected/unknown; operation/transition ID; current revision; structured reason and permitted next action |
| Workspace transition | Previous/desired binding; affected attempts; current stage; host acknowledgement; interrupted effects and error           |
| Event                | Stable event identity; defined stream cursor; aggregate revision; actor/origin; target; occurrence time                   |
| Snapshot             | Canonical revision and resume cursor; capabilities; connection/execution status; outstanding decisions                    |
| Decision             | Question/action identity; source task; revision; pending/resolved/expired; resolver and outcome                           |
| Local draft          | Account and draft identity; selected binding; text and attachment lifecycle; explicit unsent state                        |

Do not accept client-provided actor labels or grants as proof. Define atomic
snapshot-plus-event handoff, missing-cursor fallback, duplicates and out-of-order
updates; a stale event cannot resurrect a removed mount or answered question.
Reading a notification, dismissing it and resolving its action are separate facts.
Offline commands with possible side effects require outcome reconciliation,
not an automatic retry with a new identity.

**Deferred user decision:** native sign-in, server exposure and connection security
mechanism, as explicitly requested. Do not select a new public port while defining
these neutral contracts. Existing desktop-Web approval dependencies remain a
known obstacle until that design is settled.

**Gate:** two devices race a switch/approval, a push is delayed, and a response is
lost after successful application: both clients converge without duplicate work,
wrong-account cache exposure or needing the other Web client online.

### 8. Migration, extraction and delivery boundaries — engineering/review gates

**Missing:** old-to-new identity mapping, schema/version support, cutover behavior,
release scope and a realistic rollback boundary. Current re-export/parity plans
for crates do not cover product-data migration.

Inventory existing Chat projects, directory workspaces, sessions, delegation and
team task IDs, memory ledgers, uploads, approvals, schedules and recoveries. Define
which remain canonical, which gain aliases and which are new records. Moving
navigation must not implicitly relocate files or change a scheduled job's target.
Use actual representative old fixtures, including large histories and pending work.

Use small independently verifiable deliveries: resource/transition contract,
then unified conversation workflow and task tracking, then pots coordination and
bounded proactivity. Provider extraction can proceed as a separately approved
behavior-preserving change; reusable-loop integration has its own API and event
ordering gate in [Library extraction](library-extraction.md).

**Next delivery decision:** first implementation slice. Crate names and packaging
direction are adopted; public API/type details still need engineering review. Flutter Web remains separate evaluation; no framework replacement or
crates.io publication is implied. Rollback must name the supported data version;
switching back the UI is not safe database downgrade proof.

**Gate:** interrupted upgrades resume; stable links and memory provenance survive;
pending work is neither lost nor replayed; old clients are supported explicitly
or refused clearly; no migration silently enables pots monitoring or new grants.

### Remaining follow-up after acceptance

Proceed with specification work against the adopted baseline; a second approval
of the main-directory model, rule/notes/board split, task unification, wait flow
or pots user-precedence rule is not needed.

- **Engineering work:** revocation and restart protocol, identity mapping, team-task
  mapping, schemas/event ordering, conflict fixtures, API/feature proof and migration.
- **Remaining settings:** actual pots scope/grant selections, finite budget and
  concurrency values, notification times and board-retention/editor presets.
  Additional-mount, allocation and durable-note policies are already adopted.
- **Explicitly deferred:** App authentication/topology and Flutter Web selection.
- **Before code changes:** agree on the first implementation slice. Acceptance of
  this planning direction is not a request to implement it; repository publication
  follows the separately authorized commit/rebase/push workflow.

Bring only unresolved behavior or consequential tradeoffs back to the user.
Engineering details should be completed by the implementer within the approved
requirements. Confirmed context retention and live-switch warning behavior stand.
