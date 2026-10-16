# Plan: open work in recommended order

[Project](../README.md) · [Documentation](../docs/README.md) · [Completed design history](../docs/history/README.md)

Rewritten 2026-10-15 from the former `assistant.md`, `project-isolation.md`, `backlog.md`, `mobile-audit.md` and `security-audit.md`, which are removed. Their last full text is at commit `7677d24` (`git show 7677d24:plans/<file>.md`); the security audit, with its resolution evidence, is archived at [docs/history/security-audit.md](../docs/history/security-audit.md). Decisions already taken live in the [assistant history](../docs/history/assistant.md) and the [chat projects guide](../docs/guides/chat-projects.md).

This file is the work queue, not authorization. Every phase still needs the user's go-ahead before implementation, and nothing here authorizes deployment, paid evaluation, deleting state or rerunning the `#[ignore]`d real-host-root tests. When an item is done, record its evidence in docs, check it off here, and move on; do not erase open items silently.

**Stale references.** Many original findings cite TypeScript paths (`apps/gateway/src/…`) that no longer exist after the Rust cutover (0.4.0). Before implementing such an item, find the Rust equivalent in `crates/` and confirm the problem still exists. Items already confirmed in Rust are marked _(confirmed in Rust)_.

## Recommended order

| Phase | Theme                                            | Why here                                                                               |
| ----- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 1     | Review and release the unreleased assistant work | Schema 1002 and three features sit in Unreleased; the release gets riskier as it grows |
| 2     | ~~Android approval check (assistant 3a)~~        | Deferred: Android rewrite in progress (see below)                                      |
| 3     | Network taint (assistant 5)                      | Small; improves memory trust; pairs with browser click/type classification             |
| 4     | Decision session                                 | Cheap; unblocks phases 5, 6 and 8                                                      |
| 5     | Security hygiene                                 | Re-audited 2026-10-15; I5 done, M13 gap next                                           |
| 6     | ~~Android parity batch~~                         | Deferred: Android rewrite in progress (see below)                                      |
| 7     | OM model policy (E3), then `secure_delete` (E1)  | Small and independent; E1 must precede hard delete                                     |
| 8     | Project-only memory (B), then hard delete (D)    | Large designs; need phase 4 decisions                                                  |
| —     | Manual validation                                | Needs real hardware or hosts; attach to the release that needs it                      |
| —     | Watch, do not build                              | Waits for evidence from use                                                            |

**Android deferred (2026-10-16).** An Android rewrite is in progress, so phases 2 and 6 and the Android decisions in phase 4 are on hold. Do not implement them against the current client; when the rewrite lands, re-check each item against it and carry over what still applies.

## Phase 1 — Review and release

- [x] Review assistant item 2 (USER in coding sessions), item 4 (repository identity by normalized `origin`, schema 1001) and item 6 (projects linked to workspaces, schema 1002). Reviewed 2026-10-16 by three independent reviewers: no high or medium findings. Low findings fixed: remotes on the node itself (`localhost`, `127.*`, `0.0.0.0`, `file:`) get no repository key; git files are opened with `O_NOCTTY` after a regular-file check; repository keys tag notes and links only for directory workspaces; invalid keys are dropped before being relayed to browsers; a `delegate` to a linked workspace its connected node no longer has answers 404 "removed" instead of 503 "offline"; the USER warning says "unreachable" only when the gateway did not answer; the Forget text says started sessions keep their USER. Accepted and documented: `.git` symlinks and absolute `gitdir:`/`commondir` are followed (only a normalized key leaves the node). Not done (nits): case-insensitive host paths, `BEGIN IMMEDIATE` for concurrent migrations, the registration file reads on the async task, per-link `created_at`, a conformance case for the 3 s `assistant.context` timeout.
- [ ] Run the PTC manual real-runtime checks (below) and any NixOS/Linux validation the release depends on.
- [ ] Release following the [release policy](../docs/development/releasing.md) and [Upgrades](../docs/deploy/upgrades.md) (gateway schema 1002 is refused by 0.4.x; node protocol unchanged at 10).

Project-isolation E2 (OM config diagnostics) needs no action: it was ported to Rust (`crates/pirc-agent/src/config/memory.rs`) and shipped in 0.4.x.

## Phase 2 — Android approvals (assistant 3a) — deferred (Android rewrite)

- [ ] A USER proposal is a `confirm` interaction, which Android already shows in a session. Verify the multi-line body renders and the labels are used. Give delegation confirmations the same check.

## Phase 3 — Network taint (assistant 5)

- [x] Done 2026-10-15: `bash` results (direct and inside `ptc`) whose command names a network fetcher or URL have origin `tool:bash:network`; MEMORY notes with a network origin and no `user` origin are rendered "(from fetched content)" in the snapshot with a claims-not-facts line; `ptc` results with such a `bash` are fenced as untrusted. Record: [assistant history](../docs/history/assistant.md#assistant-context-and-snapshot).
- [ ] Optional, same area: classify `browser_click`/`browser_type` on non-localhost origins (browser follow-up proposal); complete observational-memory provenance tagging of page results.

## Phase 4 — Decisions to take with the user

**Decision session 2026-10-16.** The assistant and security decisions below were taken with the user; implementation is listed in phase 5 under "Apply phase 4 decisions". Android and project-isolation decisions are still open.

**Deployment model: pirc has a single user.** Every allowed user of a gateway is treated as the same person; per-user ownership, quotas and limits are not built.

Assistant (leanings recorded 2026-09-29, accepted 2026-10-16):

- [x] **Auto mode in delegated sessions.** Decided: keep the default (a dangerous command waits for the user in the delegated session) and offer a checkbox on the delegation confirmation, "treat this task as my request for auto mode", counting the task as a `recentUserRequest` for that run only.
- [x] **Settling delegated sessions** after the result is delivered. Decided: leave them, and show delegation status in the session list.
- [x] **Retention.** `memory_log`, `delegations` and `memory_records` grow without bound. Decided: keep forgotten entries only as tombstones (already), prune `delegations` older than 90 days that are not the target of a `follows`, keep records as long as the ledger has them.

Android (deferred with the rewrite):

- [ ] Token rotation before the 30-day limit versus monthly re-pairing (related: A7, warn near the limit).
- [ ] Sideload-only distribution versus F-Droid/Play; release signing.
- [ ] Native Android Context inspector: later or never.

Security findings that each need a decision. All were re-checked against the Rust code on 2026-10-15 and are still open; evidence is in the [re-audit](../docs/history/security-audit.md#re-audit-against-the-rust-code-2026-10-15).

- [x] **L5** workspaces have no owner (`schema.sql` has no owner column): capabilities, instructions and the new project links routes, and schedule creation, check only the workspace kind. Decided: single-user model; document it, no owner column.
- [x] **L12** an untrusted project `.pirc/config.json` still sets `defaultModel` (`pirc-agent/src/config.rs`): the H3 trust gate covers hooks/env/allowedPaths only. Decided: bring `defaultModel` under the trust gate (ignored until the project is trusted) and name the model in the warning.
- [x] **L14** with auto mode `enabled:false`, every non-read verdict including **danger** becomes `write` and runs without approval (deny-list still holds). Decided: replace `enabled` with three approval modes, see "Approval modes" below.
- [x] **L11** before-prompt hook stdout and gateway `deliver` content become `Custom` messages sent as plain user text (`pirc-providers/src/pi.rs`); session-start hook stdout goes into the **system prompt**. Decided: label them like team events ("data, not user instructions"); take session-start hook output out of the system prompt or fence it in a labelled block.
- [x] **L13** skill descriptions from the repository enter the system prompt introduced as "installed by the user". Decided: introduce repository skills separately, labelled as from the repository and untrusted.
- [x] **L10** `schedule pause/resume/delete` run without approval. Decided: pause/resume stay as they are; **delete** goes through a proposal the user approves.
- [x] **L6** push: no private-address filtering after resolution, no per-user subscription cap, no throttle on `/api/push/test`. Decided: accepted; only the single user can register endpoints.
- [x] **L3** build caches are writable by default and get no write lease; documented in `docs/deploy/sandbox-and-browser.md`. Decided: keep documented.
- [x] **I4** every chat agent's `assistant.context` lists all directory workspaces (no owner filter). Decided: accepted under the single-user model (same as L5).
- [x] **I9** provider backend URLs accept `http://` (`pirc-providers/src/backends/schema.rs`). Decided: keep (LAN/tailnet backends; only the user configures them).
- [x] **I1** panel terminals are unsandboxed login shells, on by default (`PIRC_TERMINALS`). Decided: keep the default.
- [x] **I8** tracked examples use `homolab`, `m5pro`, `mac`. Decided: they are real host names but generic enough to reveal nothing useful; keep them.

**Approval modes (L14, decided 2026-10-16).** Modelled on Codex:

- `read-only`: only `read` verdicts run; `write` and `danger` need the user's approval; headless teammates/subagents are refused.
- `auto` (default): today's behaviour (rules, then the classifier; `danger` needs approval). `useModel` applies only here; unclear stays `write`.
- `full-access`: no classification gate; a warning when switching to it and a persistent indicator while active.
- In every mode the user's deny-list still means "ask me", the write lease is still taken, and the OS sandbox is unchanged (it stays a node setting, independent of the mode).
- The node config sets the default; the web UI can switch a single session. Delegated sessions start in the default mode, never inheriting a chat's `full-access` (the delegation checkbox above still applies); teammates and subagents follow their parent session.
- Migration: `enabled:false` maps to `full-access` (so it now shows the warning), `enabled:true` to `auto`.

Project isolation (needed before phase 8):

- [ ] B: require fresh sessions on every scope-generation change (recommended) or allow a weaker continuation; explicit copy between scopes and its review; on disable, keep a dormant scope or require deletion/export.
- [ ] D: shared artifact ownership; old-node upgrade requirements; lost-node policy; whether metadata tombstones may persist; retention/backup/provider guarantee wording; restricted-profile sandbox strength.

## Phase 5 — Security hygiene

Re-audited against Rust on 2026-10-15; see the [re-audit](../docs/history/security-audit.md#re-audit-against-the-rust-code-2026-10-15). Ordered by value.

- [x] **I5** done 2026-10-15: `apiKeyCommand` runs without pirc's own secrets (node tokens, VAPID private key, proxy secret, Exa key; other variables stay for the key tool), and the `uname` fallback with an empty environment. TS had the same gap (`Bun.spawnSync` inherited everything), so it was not a port regression.
- [x] **M13 gap** done 2026-10-15: node→browser stream messages are capped at 4 MiB (`pirc-gateway/src/sockets.rs` `relay_verdict`; the 64 KiB/1 MiB caps were browser→node only). An oversized message closes a terminal socket with `1009` and is dropped from the live view, so one message overshoots the backlog by at most 4 MiB, not 16 MiB.
- [x] **Recording read follows symlinks** done 2026-10-15: `read_recording_chunk` (`pirc-node/src/panels/inspect.rs`) resolves the path with `resolve_inside`, like other panel reads (an escape is a 404), and takes size and bytes from one open file.
- [x] **I2** done 2026-10-15: node-side writes into `.pirc/uploads` (`runner/mod.rs`) and `.pirc/recordings` (`browser/manager/ops.rs`, `browser/recording.rs`) go through `pirc-node/src/private_dir.rs`: each directory below the session root is opened with `O_NOFOLLOW`, files are created with `O_EXCL|O_NOFOLLOW`, and ffmpeg writes WebM to the node's descriptor (`/dev/fd/3`) instead of a path.
- [x] **L7** done 2026-10-15 (per node): `MAX_PENDING_REQUESTS` and `MAX_TERMINAL_STREAMS` count only the target node (`pirc-gateway/src/nodes.rs` `requests_on`/`streams_on`). Not per user: node requests carry no user at the registry, and the single-user model (L5) makes a per-user split unnecessary.
- [x] **L8** done 2026-10-15 (limits; no rate limiter): JSON bodies are capped at 4 MiB (`pirc-gateway/src/http.rs` `JSON_BODY_MAX_BYTES`; uploads keep `upload_max_bytes`), and command payloads keep only the node's keys with bounded values before they are stored and forwarded (`routes.rs` `command_payload`). A request rate limiter is not needed under the single-user model (decided 2026-10-16).
- [x] **I3** done 2026-10-15: mirrored memory records have a per-node quota of 200,000 rows (tombstones included) and 64 MiB of note text (`memory_records.rs` `Quota`; rows past it are not kept, and a warning is logged), and event replay is bounded by 8 MiB per session as well as by count (`events.rs` `REPLAY_MAX_BYTES`).
- [x] **L15** done 2026-10-15: no source maps in the web build; dev/preview bind localhost; `check.yml`/`android.yml` actions pinned by commit SHA (tag in a comment); NixOS units gain `CapabilityBoundingSet=`, `RestrictRealtime=`, `RestrictAddressFamilies=` (both), and `SystemCallFilter=@system-service`, `SystemCallArchitectures=native`, `ProtectProc=invisible`, `RestrictNamespaces=` (gateway only; the node keeps namespaces and mount calls for bubblewrap). Checked: the gateway under those filters in a user `systemd-run`, bubblewrap under the node's address-family and realtime limits, module evaluation. Not checked: a real NixOS host (see manual validation).
- [ ] Apply phase 4 decisions (2026-10-16):
  - [ ] Approval modes `read-only`/`auto`/`full-access` (L14), with config migration, per-session switch and web warning.
  - [ ] L12 `defaultModel` under the trust gate.
  - [ ] L11 label hook/`deliver` content; session-start hook output out of the system prompt or fenced.
  - [ ] L13 label repository skills as untrusted.
  - [ ] L10 schedule delete through a proposal.
  - [ ] Document the single-user model (L5, I4) in the deploy docs; record the accepted items (L3, L6, L8 rate limiter, I1, I8, I9) in the [re-audit](../docs/history/security-audit.md#re-audit-against-the-rust-code-2026-10-15).
  - [ ] Assistant: auto-mode checkbox on the delegation confirmation; delegation status in the session list; prune `delegations` after 90 days unless followed.
- [ ] Sandbox limitations to revisit (all confirmed): Linux allows every Unix socket not on the known-host-socket list (`sandbox/linux.rs`; move inference off Unix sockets or bind-mount narrowly); the whole workspace-memory directory is a writable root, so an agent can append to other repositories' ledgers (`pirc-policy/src/session.rs`); domain approvals are session-only.
- [ ] Accepted PTC limitation, partly addressed by phase 3: a `bash` operation that names a network fetcher or URL now fences the `ptc` result as untrusted; other `bash` output, `memory_search`, `delegation_status` and `agent_inbox` results are still not marked untrusted (`ptc/registry.rs`).

Verified fixed in Rust (no action): L1 shared sensitive-path list, L2 `.git/hooks`/`.git/config` protection, L4 workspace registration refusal, L9 database mode 0600, I6 mermaid through DOMPurify, I7 `result` ignored, M14 optional proxy secret.

Accepted, not to be reopened without a new decision: S10 (host atomic replacement detaches a protected Linux mount) and S18 (browser WebSocket/non-HTTP egress, DNS rebinding); see the [archived audit](../docs/history/security-audit.md).

## Phase 6 — Android parity — deferred (Android rewrite)

Full tables with web/Android file references and fix hints: `git show 7677d24:plans/mobile-audit.md`. Effort: S under an hour, M half a day, L a day or more.

**6a. Settings and memory (assistant 3 + S10)**

- [ ] **S10** settings screen: gateway host, client id, nodes online and workspace counts, settled toggle (fixes **S7** persistence), Unpair, "Backends: set on the web" hint (covers deferred **D1**). M
- [ ] **Memory screen** in settings: `GET /api/memory` with approve/reject/forget/restore, the web's forget disclosure, `memory=1` subscription for `memory_changed`, pending count on the settings entry.
- [ ] **Chats in the sidebar:** `chats` and projects first, New chat; chat sessions hide Git and Terminal.

**6b. High-value gaps**

- [ ] **D2** notifications for run finished / `waiting_input` (minimum: local notification while the stream is alive; full: push channel). L
- [ ] **S2** session list search and node filter. S–M
- [ ] **O-S2** share-sheet entry (`ACTION_SEND` text/images → session picker). M
- [ ] **C9** tool card detail (failed auto-expand, duration, `bash`/`write`/`edit` rendering, Error label). M

**6c. Small chat fixes (S each)**

- [ ] C7 editor `language` label · C10 live thinking as Markdown · C11 notice `Source: detail` split and collapse · C12 `custom` entries open · C13 message timestamps
- [ ] O-C1 dock queue above the composer · O-C2 separate model/level targets · O-C4 single-select submits on tap · O-C5 scrollable long `select` · O-C6 reset "Copied", copy via long-press · O-C8 icon top-bar actions

**6d. Small shell and panel fixes (S each)**

- [ ] S6 add-workspace node preselect and zero-node state · S13 short relative time · O-S3 collapsible groups · O-S4 remember last workspace · O-S5 actionable empty state · O-S6 validate pasted pairing link live · O-S7 pin glyph
- [ ] F2 symlink icon (both clients) · F4 open file from diff · F7 "No commits yet" and status chip · F8 Tasks details (agentRunning, newest-first, duration, watch count, event time) · F9 scroll task output to tail · F10 memory phase labels and unavailable/disabled split · F12 reflection sources/ids and 3-line clamp
- [ ] AF3 confirm before stopping a task · AF6 stop terminal polling when empty · O-F1 reveal file in folder · O-F3 Paste/`^C`/copy in terminal key row (S–M) · O-F6 git status colours · O-F7 breadcrumb scrolls to current · O-F8 lazy task output

**6e. Larger items**

- [ ] C14 Markdown math and mermaid (L) · O-F2 keep terminals alive while switching (L) · O-F4 file navigation in multi-file diffs (M) · D3 cached offline session list (M)
- [ ] Polish: motion, copy menus, large-font and small-screen passes; release signing.
- [ ] Optional: A7 warn near the 30-day token limit · A14 `setUnlockedDeviceRequired(true)` · L7 Android lint strictness, baseline profile, `androidTest` (skipped on purpose) · web i18n (skipped on purpose).
- [ ] Port Android-only ideas to web where useful: AC2 attachment limits, AS3 workspace name from path, AS4 online-first sort, AF1 wrap toggle.

## Phase 7 — Small storage and config items

- [x] **E3** done 2026-10-15: `missingModelPolicy: 'fallback' | 'error'` (default `fallback`) in `features.observationalMemory`. In `error` mode every configured choice is checked before each memory run (`pirc-agent/src/features/memory/worker.rs` `pick_model`, `PickError::Missing`), before the session model is considered; the run is skipped with an error notification and a persistent `Last model error` in `/om:status` and the panel. A missing preferred model is no longer reported as rate limited. Checked per run rather than at agent start, since the gateway's catalog is what decides. Conformance tests `agent_memory_missing_model_falls_back` (unchanged behavior) and `agent_memory_missing_model_is_an_error` (no memory inference).
- [x] **E1** done 2026-10-15: `PRAGMA secure_delete = ON` on the gateway's (`pirc-gateway/src/db.rs`) and the node's (`pirc-node/src/store/mod.rs`) database connections; tests `deleted_content_is_zeroed` show deleted text gone from the file (and present without the pragma). Measured with SQLite 3.51 on a gateway-like mix (3,000 transactions of note upserts, log inserts, command insert/update and periodic deletes, WAL): OFF 2.86 s / 67.3 MiB WAL, ON 2.84 s / 67.9 MiB (+0.9%), FAST 2.96 s / 67.3 MiB. Documented in `docs/deploy/backup-and-recovery.md`; old WAL frames, backups and files are not sanitized.

## Phase 8 — Project-only memory and hard delete

Full designs (change points, invariants, migration and protocol): `git show 7677d24:plans/project-isolation.md`, sections B and D. Paths there are TS and must be remapped to `crates/pirc-gateway`/`crates/pirc-agent`.

- [ ] **B. Project-only USER/MEMORY, opt-in.** Off by default and for existing projects; global memory stays the preferred mode. Add `scope_id` (default `global`) to entries/log/proposals and a composite tombstone key; scope every store entry point by a trusted `{owner, scope}` derived from the session, never from agent arguments; scope search, recall and mirrored records; version snapshots by scope generation; proposals bind scope and generation. Not retroactive: old sessions keep their frozen snapshots. Isolates projects from each other, not data from the gateway/node operators, providers or backups.
- [ ] **D. Hard-delete project.** Durable deletion jobs with per-node fences and idempotent, generation-bound node cleanup; refuse all reads/writes for the identity during deletion; offline nodes stay pending, lost nodes end as "cannot verify"; upload provenance table before promising upload deletion; minimal identity tombstone against resurrection. Reuse the shipped source-chat deletion machinery. Depends on E1; the restricted-project profile also needs B plus upload/browser capability gates.

## Manual validation (needs real hardware or hosts)

Attach each to the release that depends on it; none is a feature task.

- **Browser:** real Linux node with nixpkgs Chromium/CDP and full Nix build; real Android takeover (tap mapping, IME, drag scrolling) and WebM playback.
- **Schedules:** installed-PWA push on a real iPhone (Add to Home Screen). Deploy gateway and nodes together for the changed deliver body.
- **Sandbox (NixOS/Linux):** bubblewrap under unit hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateDevices`, and since L15 the empty `CapabilityBoundingSet` and `RestrictAddressFamilies`); the gateway under its system-call filter with a real `apiKeyCommand`; tmpfiles handover of an existing `/var/lib/pirc/daemon`; `apiKeyFile` ownership after the move to `pirc-gateway`; bundled srt finding `apply-seccomp`; CI job `sandbox-podman`.
- **Mobile:** iOS/Android soft keyboard and safe areas, CJK IME in the Android composer, terminal https asset origin, release build on a real phone.
- **PTC before release:** node/agent crash during a spinning script (orphaned guest exits; also a team child crashing mid-script); decline node sandbox approvals in web and Android and see the host-written `[declined]` section; relay script screenshots through a real node; direct calls with optional `null` and extra arguments on real Anthropic and OpenAI-compatible providers; web/Android rendering of `[declined]`, `[hooks]` and bounded arguments.
- **Rust post-cutover:** the `node_link_side_runs` CI timeout (once, not reproduced); TLS, a real identity provider, phone pairing, push and terminals are not covered by the macOS end-to-end checks; v0.4.1 is unsigned and not notarized.

## Accepted limitations (record only)

- **Browser:** teammates/subagents have no browser; the screenshot action log is memory-only and lost on node restart.
- **PTC (accepted P3):** bash writes via a symlink created in the same command can skip the write lease; `bash curl`, `agent_inbox`, `delegation_status`, `memory_search` output lacks untrusted tagging; guests inherit agent sandbox rights; the approval convention does not enumerate host-gated operations; operations ignoring abort may outlive the five-second grace; after an agent crash mid-script the model sees "interrupted"; queued operations count toward progress and eight long waits can fill all slots. Reviewed fixes changed behavior after the evaluated builds and were not re-measured.
- **Rust post-cutover, waived not passed:** full PTC/task-time comparison with the TS baseline, real-provider smoke tests, polyglot evaluation. Reopening needs an agreed protocol, budget and credentials (historical tooling at `2d480d3`). Protocol 10 is incompatible with TS nodes/gateways; never delete old state without approval.

## Watch, do not build yet

- **Consolidation ("dreaming"):** only if `memory_full` becomes frequent at 8,000 characters; must keep origins (consolidated text may not gain `user` origin). Revisit budgets first.
- **Moving chats between projects, shared project files:** not painful with a handful of chats.
- **Vector search:** `LIKE` over a few thousand notes is fine; revisit only when searches miss.
- **A second chat node:** would need its own `chats` workspace and a rule for New chat.
- **`workspace.read`** (reading a linked repository from a project without delegating): only if chats keep delegating just to look at a file.
