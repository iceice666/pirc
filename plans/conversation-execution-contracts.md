# Unified conversation execution contracts

[Plans](README.md) · [Unified conversations](unified-conversations.md) · [pots and Rust foundations](pots-and-library-extraction.md)

Status: planning specification, 2026-10-24. The user accepted the seven follow-up
recommendations and requested detail for items 1–3: capability composition,
message/task routing and overlapping folder permissions. This document records
target behavior and future acceptance cases; it does not implement or verify it.
Keep all work local. App authentication/topology, Flutter Web selection and the
first code implementation remain separate decisions.

The main plan owns domain lifetimes, retained context (decision A), revocation,
checkpoints and migration. This document refines those contracts. Names below
are logical concepts, not finalized API fields, database schemas or Rust types.

## 1. Compose capabilities without a Chat/Work switch

### Sources of effective capability

A unified conversation has a stable identity and a versioned execution binding.
Its visible location in the interface is never an authorization input. Separate:

- **Availability:** the selected runtime supports the tool/feature and conversation
  configuration enables it. Enabling a feature does not grant access to resources.
- **Authority:** the authenticated actor has a current grant for this operation,
  target and scope, within deployment policy and any explicit prohibitions.
- **Approval:** the existing operation approval policy permits this particular
  effect, or its matching pending decision has been resolved affirmatively.
- **Readiness:** the Node and required resources are available, the binding is
  current, and any required write lease or task dependency has been resolved.

An effect needs all applicable conditions. Show unavailable, unauthorized,
awaiting approval and waiting for a resource as distinct states. A hidden tool
name, a prompt instruction or an assistant's assertion is never enforcement.
Validate at dispatch and again at the effect boundary; do not use a stale model
request or old approval to recover removed authority.

### Capability mapping

| Capability                                        | Enabling context and authority                                                        | Effect boundary                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Ordinary dialogue                                 | Current conversation access and configured model/runtime                              | No implicit grant to project files, other histories or administration                                                       |
| Read/list/search files                            | Available file tools plus effective read access to a resolved resource                | Node enforces on tools, shells and descendants; report the actual target                                                    |
| Edit/create files                                 | Effective write access and applicable operation approval                              | Node enforcement and writer coordination; read-only mounts do not become writable by asking the model                       |
| Commands and background work                      | Command capability, explicit workspace binding and relevant filesystem/network policy | Starting a shell does not grant broader child-process authority; background work has a tracked task                         |
| Project rules/notes/board                         | Current project membership and the relevant read/edit grant                           | Rules are user-controlled; notes are revisioned; board posts are attributed data                                            |
| Personal memory/history                           | Separately authorized memory/history scope and existing provenance rules              | Mounting a repository does not grant account-wide history or make project notes global memory                               |
| Browser, network, Sources, calendar and schedules | Their configured capability and operation-specific resource grants                    | Folder access does not grant browser cookies, external account access, wider schedule targets or permission to send/publish |
| Delegate/coordinate agents                        | Explicit dispatch scope, target capability and task lineage                           | Child authority is bounded by authorized delegation; seeing progress does not authorize sending instructions                |
| Provider/device/account management                | Verified management identity and scope                                                | Available only through the management boundary; never derived from a workspace mount or project rule                        |

A project may supply defaults and already-authorized project grants. An ordinary
rule or shared note cannot create a grant. Joining a project goes through the
membership/resource transition; copying its name or rules into a conversation
is not joining it. A conversation-specific grant retains its own provenance.

Approval presets remain independent from capability/resource grants. A setting
that reduces confirmation prompts does not cancel a resource prohibition. Any
execution path that cannot enforce the resulting policy is unavailable under
that binding, even if a tool exists with an unrestricted execution option.
Do not silently weaken the policy to accommodate that tool.

### Discuss-to-work flow

1. The user starts a conversation with its selected workspace or managed empty
   workspace. Conversation creation follows the existing draft/first-send plan.
2. A question can be answered without a new mode or a new work session. Relevant
   rules are selected by current binding and scope; historical rules stay history.
3. When the user requests work, resolve the target and effective capabilities.
   If the chosen folder, grants and approval already suffice, continue directly.
4. If the target is ambiguous, ask about the target only. If a grant is missing,
   present the specific resource/action change; do not propose general full access
   as the automatic remedy. A failed request remains visible and recoverable.
5. Record substantial/background work as a task and bind each attempt to the
   current environment. The host may use a separate worker process while keeping
   the same visible dialogue, task identity and source attribution.
6. A capability/mount revocation follows the live transition protocol. A pending
   operation becomes denied/interrupted with its reason; it is not retried against
   a replacement folder. Already completed effects remain recorded.

Both clients show the selected Node, main folder, additional mounts and effective
access. Explanations should identify the missing prerequisite, such as a read-only
folder or an offline Node. Do not make users select Chat/Work to repair it.

### Existing-mode migration requirements

Inventory every field and consumer of `crates/pirc-protocol/src/mode.rs` before
changing behavior. Preserve existing custom mode IDs/configurations through an
explicit compatibility mapping; unknown fields or unsupported combinations do
not fall back to broader access.

| Existing concern                             | Target mapping and required review                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `workdir`, repository and project resources  | Versioned main directory/mounts plus explicit project grants and provenance                    |
| `prompt`, `body`, project instructions       | Ordered, attributed active rules; old conversation text is not current policy                  |
| `features_on/off`, `tools`                   | Availability filters plus enforcement on every underlying operation, including PTC wrappers    |
| `assistant`, memory, recap/history           | Enumerated read/write scopes; never blanket-upgrade every old session to full assistant access |
| `delegate`, `delegate_target`, team tools    | Allowed actor/target relationships, bounded delegation and loop prevention                     |
| `schedule_scope`, project/session management | Explicit target/resource scopes; no expansion from `own` to `any` on migration                 |
| `ui` and Chat/Work placement                 | Presentation only; remove navigation coupling after preserving capability checks               |

The current full-assistant/workdir and delegator/target validation restrictions
cannot simply be deleted. Replacement checks and conformance fixtures must prove
how each old restricted combination remains bounded. A reusable agent loop does
not own these checks; it receives host-approved model/tool progression.

### Acceptance cases to implement later

- Ordinary chat becomes authorized repository work in the same conversation
  without a new mode prompt, lost context or duplicated work session.
- A read-only folder can be inspected; a write request gets a scoped explanation
  and cannot succeed via a shell/PTC wrapper or child agent instead.
- Project notes cannot turn on account-wide history, management or external-send
  privileges. A capable tool with a missing grant remains denied.
- A pending approval followed by mount revocation cannot execute the old action;
  both clients show the new reason and preserve any partial result.
- Old custom modes preserve their operation scopes; unsupported combinations are
  reported clearly, and existing memory/checkpoint provenance remains intact.

## 2. Route new messages while tasks run

### One foreground response flow, multiple attributed tasks

Each conversation has one active foreground response owner at a time. This is a
logical coordinator, not a requirement to keep one OS process alive. Independent
child/background tasks may run concurrently, each with its own context, attempt
and authorized workspace. They cannot append competing unlabelled assistant
streams to the main dialogue.

The backend records a foreground ownership generation and orders accepted input.
This is separate from device control leases, pots coordination authority and file
write leases. A second device does not create a second foreground owner by opening
or sending to the same conversation; existing command-control rules still apply.

A message records its authenticated author, command identity, conversation,
selected task if any, and the state/revision the user was viewing. Routing records
whether it is a question, task direction, separate objective or explicit control,
and its accepted target. A client-provided actor label cannot impersonate pots or
the user. Text from tools, files or another agent cannot become a user command.

### Routing table

| Input and context                                     | Target and behavior                                                                                                                  | What remains unchanged                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| No work active; ordinary question                     | Foreground answer; no task required solely for answering                                                                             | Existing task history and workspace grants                                            |
| Running task; “explain that error”                    | Foreground side question associated with the relevant task; keep its work state visible                                              | Does not automatically cancel tools, create a new objective or mark the task complete |
| Running task; clarification/correction                | Same task with an attributed directive revision; reconcile affected pending/in-flight work before continuing it                      | Task identity, completed effects and unrelated tasks                                  |
| Clearly independent new objective                     | Create/queue a separate task when tracking is appropriate; show its target and queued/running state                                  | Does not silently replace or cancel the earlier objective                             |
| Message from a task detail or explicit task selection | Route to that task through the foreground coordinator; any background reply is task-attributed                                       | Does not create a duplicate task or pots conversation                                 |
| Explicit Stop control for a task                      | Host fences new affected work and requests cancellation of that task and its scoped descendants without waiting for a model response | Unrelated tasks; completed effects are not rolled back                                |
| Explicit pause/resume control                         | Record its scope and reconcile the task state before acting                                                                          | Pause coordination alone does not mean processes stopped                              |
| User reply to an approval/question                    | Resolve only the identified pending decision with its revision and current authority                                                 | A general chat message cannot approve every pending action                            |
| Ambiguous target with several tasks                   | Ask a short target question before applying the ambiguous directive                                                                  | No guessed cancellation, retargeted write or duplicate dispatch                       |

A new objective may execute concurrently only if granted resources, dependencies,
isolation and concurrency policy allow it. Otherwise show it queued with a reason.
One foreground response flow does not mean every background task is serialized.

Natural-language corrections come from the real user but still need interpretation.
Record when the target and directive were accepted; fence obsolete work at that
boundary. Explicit Stop and resource-revocation controls have a direct host path.
Do not promise that ambiguous text or an external command already in progress was
interrupted the instant a message arrived. Show received, queued, applied or
stopping/interrupted status as appropriate, including possible partial effects.

### Scheduling, context and result delivery

- A side question can interrupt the foreground explanation at a safe boundary.
  Model requests may need cancellation/restart with partial output retained; never
  run competing foreground context writers merely to answer sooner. If a tool
  cannot yield yet, show the question as received/waiting. Do not kill an unrelated
  command just to answer a question.
- A correction supersedes conflicting queued directives for that task. Tag pending
  model/tool work with the directive and binding revision so obsolete work cannot
  commit a new effect after the correction has been applied. Already-running
  non-atomic commands require stop/reconciliation; no rollback is implied.
- A stop moves through a visible stopping state until affected workers/descendants
  are reconciled. Offline workers leave an unresolved stop; do not show completed
  cancellation based only on losing the connection. Restart needs a fresh explicit
  resume/start instruction and current grants.
- Context handoffs carry the request, task/attempt, current rules, binding and a
  defined history watermark. Child agents receive only authorized relevant context;
  launching a child is not permission to copy every other conversation into it.
- Child outputs are correlated to their task/attempt/call and reconciled once.
  Late output after stop may be retained as an attributed outcome or partial result;
  it cannot revive the task, change its target or silently overwrite a newer result.
- Deliver one compact activity line/result summary per task update as appropriate.
  Thinking/scripts/tool details stay collapsed by default. Questions, decisions
  and error summaries remain visible; selecting a task opens its own details.
- pots dispatch keeps its backend actor/grant identity. User takeover suspends
  conflicting pots dispatch for the affected task, including queued instructions;
  unrelated responsibilities continue. Resuming coordination is explicit.

On reconnect, replay accepted input and outcomes by stable identity and order,
not by sending the same user request as a new message. A lost acknowledgement
requires outcome reconciliation. Concurrent control changes use revisions and
return the authoritative result; timestamps alone do not decide authority.

### Acceptance cases to implement later

1. While task A edits files, the user asks about an error. The answer is associated
   with A; its progress remains visible and no duplicate task/session is created.
2. While A runs, the user starts independent task B. Both remain separately
   identifiable; B runs only if permitted, otherwise its waiting reason is shown.
3. A correction arrives during a model stream or tool call. Obsolete queued effects
   are rejected after application; partial completed effects are reported, not hidden.
4. Stop A while B runs. A's descendants are reconciled; B continues unless it has
   an explicit dependency. pots and late child results cannot restart A.
5. Two devices submit a message/control at once, or resend after a lost response.
   There is one accepted command outcome and one foreground owner; both converge.
6. A child responds after ownership changes. Its output stays attributed, cannot
   become the user's new instruction, and cannot append a competing answer stream.
7. A reply to an expired approval cannot authorize an unrelated or changed action.

## 3. Resolve overlapping folder permissions explicitly

### Resource and grant identity

A mount is a presentation/binding of a resource; a grant is a scoped permission
with an issuer and provenance. Keep separate identities for Node, resolved folder,
mount alias, project membership, explicit conversation grant and binding revision.
Two aliases for the same folder do not create independent lock identities.
All directly mounted filesystem resources of an attempt must resolve on its Node;
remote copying/access remains a separate design, not an alias trick.

A project-derived grant ends with that membership. A deliberately created
conversation-specific grant is independent and appears separately in the UI.
Default broad host readability is not an independent user grant that can silently
keep a removed project path readable. Hard deployment restrictions remain in force.

### Two distinct user operations

| Operation                                   | Grant/policy change                                                                          | Required preview and outcome                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Leave project / remove its mounted resource | Remove the applicable project-derived grants and active configuration                        | List independently authorized overlapping paths and their remaining read/write access; stop fresh access where no independent grant remains |
| Block this conversation from a folder       | Add a read/write prohibition for that resource subtree to the conversation's execution scope | List affected mounts/tasks and running workers; overlapping parent/child grants cannot bypass it                                            |

A resource block applies to this conversation's affected tasks, attempts and
scoped descendants, including dispatched work elsewhere that carries that scope.
It is not a global block on every unrelated conversation using the same folder.
Project-wide settings changes separately preview all affected member conversations
and reconcile them per host. Do not let delegation shed the blocking scope.

Leaving retains conversation history under decision A and does not delete files.
If an independent grant remains, display the exception before confirmation and
in the resulting effective-access summary. Never report “no access to /repo” if
/repo/docs is still independently granted. Offer the separate block operation
when the user's intent is to remove all access to that subtree.

### Effective-access rules

Evaluate the requested operation against the resolved target and current scope:

1. Apply deployment restrictions and existing protected-state boundaries.
2. A current explicit conversation/resource prohibition takes precedence over
   overlapping grants for that scope. Old approvals and permissive confirmation
   presets do not override it.
3. Among remaining explicit grants, require one covering that operation and target.
   A read-only grant grants reads; it is not itself a deny of writes authorized by
   a separate visible read/write grant. Display effective access and its sources,
   rather than labelling such a folder only “read-only”.
4. On removing a project grant, exclude the revoked resource subtree from ambient
   host reads, reopening only operations covered by independently retained grants.
   Without such a grant it becomes inaccessible, even under a parent mount or the
   current broad-read sandbox baseline. This is a required new enforcement rule.
5. Then apply the operation approval policy, task/binding revision and readiness
   checks described in section 1. A resource grant alone does not authorize every
   effect or remove a writer conflict.

Examples for one conversation on Node N:

| Existing access                                               | User action                            | Effective result after confirmed enforcement                                                |
| ------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Project `/repo` read/write only                               | Leave project                          | No new access to `/repo`; retained dialogue is unchanged                                    |
| Project `/repo` read/write + explicit `/repo/docs` read-only  | Leave project                          | `/repo/docs` read-only remains, disclosed; other `/repo` paths are unavailable              |
| Project `/repo` read/write + explicit `/repo/docs` read/write | Leave project                          | `/repo/docs` read/write remains, disclosed; no claim that all project data is inaccessible  |
| Project `/repo` read/write + explicit parent `/` read grant   | Leave project                          | Remaining independently granted reads are disclosed; project-derived writes end             |
| Any of those overlapping grants                               | Block `/repo` for this conversation    | No reads/writes under `/repo`, including `/repo/docs`, through those grants                 |
| Explicit `/repo` read/write                                   | Add a read-only alias for `/repo/docs` | Effective writes remain via the parent; show this instead of promising a read-only boundary |
| Explicit `/repo` read/write                                   | Block `/repo/docs`                     | `/repo/docs` denied; other authorized `/repo` paths remain available                        |
| A blocked path + stale approval or child dispatch             | Retry old operation                    | Denied; no new authority or implicit removal of the block                                   |

Removing a block is an explicit user access change against the current revision,
with a preview of grants that would become effective again. A new mount does not
silently remove a block. A changed path/Node or unclear resource identity requires
revalidation; do not treat a display alias as proof that a prohibition no longer
applies. Exact initial read/write defaults for newly added mounts remain open.

### Enforcement and transition requirements

- Resolve and validate path components, containment and aliases at the trusted
  boundary. String-prefix checks or one-time symlink canonicalization are not
  sufficient. Define behavior for root renames, symlink replacement, bind mounts,
  hard-link aliases and path creation/removal races before claiming coverage.
- Enforce the result for file tools, PTC, shells, terminals, background descendants
  and host-mediated file preview/download. Current policy helpers are not proof
  that the intended precedence is already enforced on Linux and macOS.
- Reuse the durable preview → accepted → revoking → preparing → ready flow.
  Stop/retire old workers that retain forbidden access; recheck queued calls,
  approvals and delegated grants. Offline or unsupported hosts remain blocked or
  pending. No “removed” success while old authority is still live.
- If an unrestricted execution path, unsupported alias arrangement or shared-host
  configuration cannot enforce the block, report incompatibility and do not start
  affected work through that path. Do not silently fall back to unenforced access.
- Previous copies, already-read bytes and retained dialogue are governed by decision
  A; this is not retroactive erasure. Deliberately reading/copying new data to evade
  a removal is prohibited. Physical enforcement and alias limitations need explicit
  platform proof, not a promise of revoking all historical copies.

### Acceptance cases to implement later

Run every access-table case through direct file tools, shells and relevant child
processes; a cooperative tool-only test is insufficient. Also cover:

- Leaving with/without a separate grant, explicit block, explicit unblock and a
  permission preview that stays consistent with actual access on Web and App.
- Duplicate aliases, symlinks/renames and supported alternate filesystem paths;
  unsupported arrangements must fail visibly instead of claiming enforcement.
- An open descriptor or background child during revocation; stale approval and
  model result; repeated command; concurrent device changes; host restart/offline.
- A project-wide change affecting multiple conversations, with unrelated explicit
  grants disclosed and failures per host visible; no premature global completion.
- Preserved history/files/checkpoints, and no fresh note/rule retrieval through
  departed project authority. Independent file grants do not preserve project
  membership, active rule injection or board authority.

## Remaining specification work

The user-visible behavior above is adopted. Remaining engineering work includes
persistent schemas, API/error shapes, atomic ordering and crash recovery, trusted
intent/control boundaries, per-tool capability inventory, platform enforcement
proofs and old-mode migration fixtures. Exact mount defaults and previously
unspecified budgets/retention values still require a concrete proposal.

Items 4–7 of the follow-up review are recorded in the main plan: cross-Node
switching, lifecycle/deletion, historical content versus file references, and pots
entry/takeover scope. They have accepted direction but are not expanded into full
contracts here. No runtime tests or builds were run for this planning document.
