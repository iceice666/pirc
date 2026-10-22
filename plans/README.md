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

## Active work, in recommended order

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
   `kind`, an Android scratch parity capture and guide screenshots.
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

## Shelved: project-only memory (B)

**Not queued for implementation.** Global memory remains preferred. Reopen only
if a project's notes must be kept out of global memory; project deletion accepts
that other chats may re-learn deleted notes. The restricted profile is shelved
with B. Hard deletion (D) is implemented, not blocked on B.

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
