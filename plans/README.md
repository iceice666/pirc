# Open work

[Project](../README.md) · [Documentation](../docs/README.md) · [Historical records](../docs/development/historical-records.md)

This is a work queue, not authorization. Each implementation needs the user's
go-ahead; nothing here authorizes deployment, paid evaluation, deleting state or
rerunning the `#[ignore]`d real-host-root tests. Preserve unresolved items when
updating this queue. Completed implementation and validation diaries are available
through the historical-records locator, not maintained as active plans.

Current behavior and decisions live in [Assistant memory](../docs/architecture/assistant-memory.md),
[Security decisions](../docs/architecture/security-decisions.md) and
[Chat projects](../docs/guides/chat-projects.md). Historical TypeScript paths must
be remapped to `crates/` and findings reconfirmed before implementation. Completed
security fixes, OM model policy/diagnostics, secure deletion and project hard
deletion are not open work.

## Current priority: unified conversation architecture

[Unified conversations, projects and an independent App](unified-conversations.md)
records the 2026-10-23 planning direction: merge the user-facing Chat/Work flow,
distinguish projects, conversations, tasks and execution environments, and make
the App independently usable. pirc may discover and suggest relevant work quietly;
execution remains governed by user-granted authority. Flutter Web is evaluation
only. Domain relationships and workflows come before new interface implementation.
The 2026-10-24 clarification adds configurable conversation workspaces, shared
project mounts/rules, project departure revocation, collaboration boards and
attributed **pirc pots** coordination. The user subsequently authorized phased code
implementation, not deployment or crate publication. Two plans carry that work:

- **[pots](pots/README.md)** (own folder: README, [design](pots/design.md),
  [acceptance](pots/acceptance.md)). Delivered: progress-only tracking
  (shipped in v0.10.0), explicit controlled dispatch (`d4f1efbd`, unreleased,
  Gateway schema 1011 / Node protocol 15), and ownership-based Stop, archive and
  revocation-fence paging (`6d87f97f`, unreleased). Open: device and full-conformance
  acceptance, remaining inbox lifecycle, content observation, proactive analysis,
  digests/push and standing grants.
- **[Reusable Rust foundations](library-extraction.md)**. Delivered: pure types,
  transport/OAuth extraction, the native runtime contract, and a loop core that
  the production agent run drives through a thin adapter. Open: the adapter
  follow-ups, API stabilization and a clean full workspace/conformance gate.

Existing security/data-loss issues and acceptance gaps below remain
valid; this does not mark mobile parity complete. The user subsequently accepted
[the specification-review recommendations](unified-conversations.md#accepted-specification-review-recommendations-2026-10-24)
as the planning baseline. Accepted choices are no longer repeated as approval
questions; engineering contracts, unspecified settings and explicitly deferred
App connection/Flutter Web decisions remain open. The original planning task was
not implementation approval; the later authorization is limited to staged code
work and does not clear the remaining acceptance gates.

[Conversation execution contracts](conversation-execution-contracts.md) details all
seven accepted follow-up areas: capability composition, foreground/background task
routing, overlapping permissions, Node switching, archive/delete/leave, saved
content versus live file links, and pots coordination/takeover. Each includes
flows, exceptions and future acceptance cases; items 4–7 add 32 such cases while
preserving current memory-deletion and checkpoint ownership rules. The
[main plan](unified-conversations.md#accepted-follow-up-behavior-and-detailed-contracts-2026-10-24)
indexes the specifications. They are planning contracts, not completed implementation
or evidence of passing runtime tests.

[Integrated architecture review](unified-architecture-review.md) records the
cross-plan contradictions corrected before publication, remaining product choices,
and engineering proof gates. The user then adopted the [recommended defaults](unified-architecture-review.md#adopted-defaults-and-deliberately-deferred-decisions):
read-only additional mounts, first-send allocation unless explicitly created,
durable notes without age expiry, scoped/bounded pots, and the three crate names
with optional default-off OAuth. Exact amounts/times and board-retention/editor
presets remain configuration work; App sign-in and Flutter Web stay deferred.
The architecture documents can be published as a planning baseline; this is not
approval to implement every unchecked stage.

## Recommended next implementation slice (2026-10-26)

After rebasing to `6d87f97f`, the user requested a plan, then activated a local
implementation goal. The
[next implementation sequence](unified-conversations.md#next-implementation-sequence-2026-10-26)
recommends **reliable first Send** across Gateway, Node, Web and Android: a durable,
queryable creation/admission identity, preserving local drafts and existing
command deduplication. Current creation and first-message admission are separate,
so the whole flow still needs failure/restart proof. The
[Node allocation checkpoint](unified-conversations.md#u1-implementation-checkpoint-node-allocation-2026-10-26)
is implemented locally; later acceptance/attachment/admission slices are tracked
below, while client adoption remains open.
The [message-admission checkpoint](unified-conversations.md#g0-implementation-checkpoint-message-admission-2026-10-26)
also fixes false success after a refused initial append, stops failed starts before
inference, preserves uncertain outcomes and keeps Stop available during admission.
It does not yet provide durable Gateway/client recovery.
The [Gateway preparation checkpoint](unified-conversations.md#u1-implementation-checkpoint-gateway-preparation-2026-10-26)
introduced owner-scoped immutable intents, stable identity reservation,
restart lookup and transactional cancellation/deletion fences. Preparation alone
neither accepted a message nor created a public conversation.
The [attachment staging checkpoint](unified-conversations.md#u1-implementation-checkpoint-durable-attachment-staging-2026-10-27)
adds verified private files, durable cleanup and the user-selected seven-day
unaccepted staging policy introduced with Gateway schema 1013. The
[Node attachment-transfer checkpoint](unified-conversations.md#u1-implementation-checkpoint-node-attachment-transfer-2026-10-27)
adds schema 2005 with stable upload identities, crash reconciliation and deletion
fences, verified through a real Node restart. These file checkpoints alone do
not constitute message acceptance or execution.
The [Gateway intent-acceptance checkpoint](unified-conversations.md#u1-implementation-checkpoint-accepted-intent-and-node-materialization-2026-10-27)
adds schema 1014: atomic pending-session publication, validated attachment
acceptance and reconciliation through the Node allocation/transfer identities.
`ready` means files prepared, not Agent admission; `canSubmit` remains false.
262 Gateway tests, 32 Node creation/transfer tests and the paired-token two-host
restart/deletion proof passed. The JSON parser/transport mismatch found by the
process test is fixed through raw octets plus negotiated manifest MIME. First
command/lease recovery was the next slice, with Web/Android adoption still open.
The [first-message dispatch checkpoint](unified-conversations.md#u1-implementation-checkpoint-first-message-dispatch-and-stop-fence-2026-10-27)
adds Gateway 1015 / Node 2006, one immutable first command, held-lease admission,
read-only receipt reconciliation and a durable Stop fence. Uncertain outcomes
are never replayed automatically; accepted staging sources clean after admission.
`canSubmit` stays false pending uncertain-allocation cancellation and client recovery.
275 Gateway tests, 416 Node library tests (three existing ignores), strict Clippy
and paired-token first-admission/restart/Stop process cases passed locally.
The [uncertain-allocation deletion checkpoint](unified-conversations.md#u1-implementation-checkpoint-uncertain-allocation-deletion-2026-10-27)
adds Gateway 1016 / Node 2007: owner-authorized durable deletion before the Node
mapping is known, honest pending status while offline, and operation-scoped
cancellation/cleanup on reconnect. 282 Gateway tests, 422 Node library tests,
strict Clippy and five process cases passed locally. Client adoption and the full
failure table remain open; `canSubmit` stays false.
The [Web durable-draft checkpoint](unified-conversations.md#u1-implementation-checkpoint-web-durable-drafts-and-recovery-2026-10-27)
adds account-scoped IndexedDB text/Blob persistence, revision guards, immutable
first-send integration and explicit pending recovery controls. Gateway pins the
expected account and exposes owner-scoped pending discovery by public session ID.
Storage refusal and delayed initial writes cannot fall back to legacy sending or
replace a newer selection. Web tests/typecheck/build, 284 Gateway tests, strict
Gateway Clippy and an isolated real IndexedDB browser proof pass. Android
adoption and the full client/process failure table remain open; `canSubmit` stays
false. No schema/dependency change or Flutter modification is included.
The [native durable-engine checkpoint](unified-conversations.md#u1-implementation-checkpoint-native-durable-submission-engine-2026-10-27)
adds private native draft/attachment storage, revision/tombstone guards, paired
account fencing and a persistent submit/check/Stop/cancel engine. Focused native
filesystem/HTTP tests and Web receipt regressions pass; controller/UI adoption
was the next slice, while real end-to-end acceptance remains open. Existing App behavior and
`canSubmit: false` are unchanged. No schema/dependency or Flutter code change is
included; run-owned build output is kept separate from existing APKs/artifacts.
The [Flutter recovery-wiring checkpoint](unified-conversations.md#u1-implementation-checkpoint-flutter-controller-and-recovery-wiring-2026-10-27)
connects real create/edit/send/navigation and necessary recovery controls to that
native engine. Twenty focused Flutter tests, clean targeted analysis and 28 native
JVM tests pass locally. A stale Discard cannot delete an accepted conversation
without separate consent; unknown capability negotiation cannot enable legacy
creation. Existing pending records remain readable with the send gate off.
Full process/device failure acceptance is still open and `canSubmit` remains false;
no UI redesign, version/dependency change or publication is included.
The [admission-aware conformance checkpoint](unified-conversations.md#g0-verification-checkpoint-admission-aware-conformance-2026-10-27)
records local fixture/transcript repairs and 50 Agent plus five Node process
passes; the remote Check is still failed, and full Chromium/Linux verification
has not been rerun.
The user explicitly requested a one-off push through `a926ea38` for the completed
checkpoints, license packaging and protocol snapshot repair. Subsequent implementation
checkpoints remain local under the active goal's default publication boundary.

Then establish environment bindings, implement actual resource transitions, map
canonical tasks/collaboration, and extend bounded proactive pots. The user deferred
UI redesign and navigation reorganization; retain only necessary functional changes.
Existing library and pots work is reused. Storage-refusal acknowledgement is fixed
locally; durable recovery and remaining verification debt stay open. App
authentication and Flutter Web stay deferred.
See the linked sequence for patch boundaries, failure cases and acceptance. This
implementation goal stays local and does not authorize deployment or a release.
Run only focused simple Flutter checks when changing Flutter, as requested.

## Existing work and acceptance backlog

1. **Android approval acceptance (assistant 3a).** Verify multi-line USER proposal
   `confirm` bodies and their labels on Android; give delegation confirmations the
   same check. See [mobile acceptance](mobile.md).
2. **Optional network provenance follow-up (assistant 5).** Classify
   `browser_click` / `browser_type` on non-localhost origins and complete
   observational-memory provenance tagging of page results. Bash network taint
   and PTC agent-data tagging are already implemented.
3. **Android decisions and follow-up.** Use the [mobile plan](mobile.md) for native
   content compatibility and acceptance. Decide token rotation before the 30-day
   limit versus monthly re-pairing (including A7's near-expiry warning),
   sideload-only versus F-Droid/Play distribution and production signing, and
   whether the native Context inspector is later or never.
4. **Data-driven workspace modes.** [Modes](modes.md) phase 3, re-scoped
   2026-10-19: fixed Chat/Work tabs (tab from the `assistant` capability, Work
   grouped by node), panels by capability, modes chosen only when creating a
   workspace. Removes `ui.group` as a breaking change (protocol 13; existing
   mode files must drop `group:`). Adds a scratch-mode guide example and a
   delegation-into-per-session-workspace scenario. Phase 2 (configuration,
   protocol 12, mode-id stores and agent enforcement) is implemented; full Linux
   conformance passed 217 tests with reviewed snapshots on 2026-10-19. Phase 3
   was implemented 2026-10-19; remaining: the Settings Modes page, retiring
   `kind`, an Android scratch parity capture and guide screenshots. Treat those
   as existing behavior/backlog; assess further fixed-tab UI expansion against
   the adopted unified-conversation contracts before implementation.
5. **Workspace-memory search quality.** [Memory search](memory-search.md):
   an evaluation set, then FTS5 + BM25 with CJK bigrams replacing `LIKE`, then
   optional hybrid semantic search through a gateway-side embeddings endpoint
   (brute-force cosine in Rust, no SQLite extension). Stays on SQLite; Postgres
   and sqlite-vec are rejected there. Each phase needs the user's go-ahead;
   phase 2 also needs the embeddings source decided.
6. **GPU access in the agent sandbox.** [Sandbox GPU](sandbox-gpu.md): an opt-in
   node setting adds two measured Seatbelt rules for Metal on macOS and exact
   NVIDIA/render-node binds on Linux (unverified on hardware), plus a NixOS module
   option replacing the node's `PrivateDevices`. Security-boundary change: each
   phase needs the user's go-ahead and a recorded decision.
7. **Delegation auto mode precision.** [Delegation autonomy](delegation-autonomy.md)
   phases 0–2 (dispatch policy, verified quotes, relayed approvals) were
   implemented 2026-10-19 with the user's decisions recorded in Security
   decisions. Remaining: phase 3 (session allows, soft/hard danger), only after
   reassessing with `scripts/approval-stats.ts`; plus real-device checks of
   relayed approvals and Stop.
8. **Calendar for schedules and personal events.** [Calendar](calendar.md):
   approved month/week/day/list views for Web and native Flutter Android,
   personal events, recurrence/exceptions, reminders and separately authorized
   agent proposals. Implementation is authorized locally; see the plan for
   verification and remaining device acceptance. Remote publication requires a
   later explicit request.
9. **Agent checkpoints and safe recovery.** [Checkpoints](checkpoints.md):
   phases 1–5 implemented and verified locally, including Node capture/journaling,
   independent recovery workspaces, owner-scoped Gateway operations and Web/native
   Android review/continuation. The published memory update is integrated;
   recovery keeps its own blank conversation and cannot write to source memory.
   Original directories and later user changes remain untouched. Coverage is
   observational; Linux runtime, real-device acceptance and reviewed disposal
   remain follow-ups. Publication still requires an explicit request.

## Project-only memory (B): collaboration design reopened, migration still shelved

On 2026-10-24 the user proposed project-scoped boards/shared notes and withdrawal
of project-specific content on departure. This reopens the collaboration/context
boundary for [architecture discussion](unified-conversations.md), not automatic
implementation of the old B design. Existing global USER/MEMORY remains as-is;
full re-scoping, the old restricted profile and migration remain undecided.
Hard deletion (D) is implemented, not blocked on this discussion. Unmounting alone
does not erase old conversation content, copies or previously learned notes.

If reopened, retain the design constraints:

- Opt-in, off by default and for existing projects. Add `scope_id` (default
  `global`) to entries/log/proposals and a composite tombstone key. Scope every
  store entry point by trusted `{owner, scope}` from the session, never agent
  arguments; include search, recall and mirrored records.
- Version snapshots by scope generation and bind proposals to scope and
  generation. Not retroactive: old sessions keep their frozen snapshots.
- Decide fresh sessions for every scope-generation change (recommended) versus
  weaker continuation, explicit cross-scope copying and its review, and dormant
  scope versus deletion/export when disabling.
- This isolates projects from each other, not from gateway/node operators,
  providers or backups.

The full deferred design is `git show 7677d24:plans/project-isolation.md`, section
B (TypeScript paths need remapping). Later decisions and the pre-cleanup plans
are at `af7074fc51742e79c8f0c76a9aaf64f80b414f7e`; see
[Historical records](../docs/development/historical-records.md).

## Manual validation

Attach these to the release that needs them; they are not new feature tasks.
Synthetic/emulator coverage does not close physical-device or real-account gaps.

- **Web approvals:** browser acceptance of the approval-mode picker and warning,
  and switching modes through a real gateway and node.
- **Project deletion:** dialog in a real browser and recovery after a real node
  disconnect. Android controlled-failure tests do not establish real network
  interruption recovery.
- **Browser:** real Android takeover (tap mapping, IME, drag scrolling) and WebM
  playback.
- **Schedules:** installed-PWA push on a real iPhone (Add to Home Screen). Deploy
  gateway and nodes together for the changed deliver body.
- **Sandbox (NixOS/Linux):** a full agent session, browser included, on a
  non-container x86_64 host at native speed; boot-time tmpfiles behavior on a
  real host. Earlier module/LXC/QEMU validation is complete; srt `apply-seccomp`
  is obsolete because srt no longer ships.
- **Mobile:** iOS/Android soft keyboard and safe areas, CJK IME in the Android
  composer, terminal HTTPS asset origin and a release build on a real phone;
  detailed account, device, provider and push gaps are in [mobile](mobile.md).
- **PTC:** Anthropic direct calls with `null`/extra arguments; declining approvals
  and rendering on the new Android client; a real model reading the newer
  agent-data fences. macOS OpenAI Responses/Chat Completions runtime checks were
  completed, but reviewed behavior changes were not re-measured.
- **Rust post-cutover:** investigate if the one-off, unreproduced
  `node_link_side_runs` CI timeout recurs. TLS, a real identity provider, phone
  pairing, push and terminals are not covered by the macOS end-to-end checks.
  The macOS v0.4.1/v0.5.0 archives are unsigned and not notarized.

## Accepted limitations — not new work

- **Security:** single-user gateway model, session-only domain approvals, S10
  (host atomic replacement detaches a protected Linux mount) and S18 (browser
  WebSocket/non-HTTP egress and DNS rebinding) stay accepted. Linux socket hiding
  covers sockets bound at plan time, not sockets bound later or in another
  network namespace. Other accepted security choices are in
  [Security decisions](../docs/architecture/security-decisions.md); do not
  reopen them without a new decision. Lasting domain allows belong in
  `sandbox.network.allowedDomains`; revisit session-only prompts only if repeated
  prompts become common.
- **Repository identity:** normalized repository keys preserve path case, so
  `github.com/Owner/Repo` and `github.com/owner/repo` differ. `.git` symlinks and
  absolute `gitdir:` / `commondir` are followed; only the normalized key leaves
  the node.
- **Project deletion:** automatic forget/rollback entries are handled as they
  stand at confirmation; only entries needing a user decision are revision
  compared. Rollback may leave memory over budget. Chat deletions before schema
  1004 did not record their project. Other exclusions and scoped tombstones are
  documented in [Deleting a project](../docs/guides/chat-projects.md#deleting-a-project).
- **Browser:** teammates/subagents have no browser; the screenshot action log is
  memory-only and lost on node restart.
- **PTC (accepted P3):** bash writes through a symlink created in the same command
  can skip the write lease. Plain bash output remains unlabelled (network fetcher
  or URL commands and `agent_inbox`, `delegation_status`, `memory_search`,
  `board_read` are tagged). Guests inherit agent sandbox rights. The approval
  convention does not enumerate host-gated operations. Operations ignoring abort
  may outlive the five-second grace; an agent crash mid-script is reported to the
  model as “interrupted”. Queued operations count toward progress and eight long
  waits can fill all slots.
- **Rust post-cutover, waived not passed:** full PTC/task-time comparison with the
  TypeScript baseline, real-provider smoke tests and polyglot evaluation.
  Reopening needs an agreed protocol, budget and credentials (historical tooling
  at `2d480d3`). Rust protocol 10 is incompatible with TypeScript nodes/gateways;
  current upgrades must follow [Upgrades](../docs/deploy/upgrades.md). Never
  delete old state without approval.

## Watch, do not build yet

- **Consolidation (“dreaming”):** only if `memory_full` becomes frequent at 8,000
  characters; revisit budgets first. Keep origins: consolidated text must not
  gain `user` origin.
- **Moving chats between projects and shared project files:** revisit remaining
  workflow friction only when painful with more than a handful of chats; shared
  project files themselves are already implemented.
- **Vector index (sqlite-vec / ANN):** brute-force cosine is planned in
  [memory search](memory-search.md) phase 2; revisit an index only at the
  thresholds listed there.
- **A second chat node:** needs its own `chats` workspace and a New chat rule.
- **`workspace.read`:** reading a linked repository without delegating, only if
  chats keep delegating just to look at a file.

## Memory integration

The authorized [memory handoff redesign](memory-handoff.md) has been ported to the Rust mainline. Its final validation record and separate repository activation constraints are maintained there; this does not authorize deployment or existing-ledger activation.
