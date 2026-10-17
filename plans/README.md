# Plan: open work in recommended order

[Project](../README.md) · [Documentation](../docs/README.md) · [Completed design history](../docs/history/README.md)

Rewritten 2026-10-15 from the former `assistant.md`, `project-isolation.md`, `backlog.md`, `mobile-audit.md` and `security-audit.md`, which are removed. Their last full text is at commit `7677d24` (`git show 7677d24:plans/<file>.md`); the security audit, with its resolution evidence, is archived at [docs/history/security-audit.md](../docs/history/security-audit.md). Decisions already taken live in the [assistant history](../docs/history/assistant.md) and the [chat projects guide](../docs/guides/chat-projects.md).

This file is the work queue, not authorization. Every phase still needs the user's go-ahead before implementation, and nothing here authorizes deployment, paid evaluation, deleting state or rerunning the `#[ignore]`d real-host-root tests. When an item is done, record its evidence in docs, check it off here, and move on; do not erase open items silently.

**Stale references.** Many original findings cite TypeScript paths (`apps/gateway/src/…`) that no longer exist after the Rust cutover (0.4.0). Before implementing such an item, find the Rust equivalent in `crates/` and confirm the problem still exists. Items already confirmed in Rust are marked _(confirmed in Rust)_.

## Recommended order

| Phase | Theme                                            | Why here                                                                                 |
| ----- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 1     | Review and release the unreleased assistant work | Schema 1003 and several features sit in Unreleased; the release gets riskier as it grows |
| 2     | Android approval acceptance (assistant 3a)       | Active mobile follow-up and physical acceptance (see below)                              |
| 3     | Network taint (assistant 5)                      | Small; improves memory trust; pairs with browser click/type classification               |
| 4     | Decision session                                 | Cheap; unblocks phases 5, 6 and 8                                                        |
| 5     | Security hygiene                                 | Re-audited 2026-10-15; I5 done, M13 gap next                                             |
| 6     | Flutter Android follow-up                        | Active mobile follow-up and physical acceptance (see below)                              |
| 7     | OM model policy (E3), then `secure_delete` (E1)  | Small and independent; E1 must precede hard delete                                       |
| 8     | Project-only memory (B), then hard delete (D)    | Large designs; need phase 4 decisions                                                    |
| —     | Manual validation                                | Needs real hardware or hosts; attach to the release that needs it                        |
| —     | Watch, do not build                              | Waits for evidence from use                                                              |

**Flutter Android update (0.6.1).** The rewrite is integrated under `apps/android`. Active remaining work, validation limits and deferred legacy audit items are maintained in the [mobile plan](mobile.md). The native transport and its contract tests are included in `apps/android/android`; there is no separate legacy UI module.

## Phase 1 — Review and release

- [x] Review assistant item 2 (USER in coding sessions), item 4 (repository identity by normalized `origin`, schema 1001) and item 6 (projects linked to workspaces, schema 1002). Reviewed 2026-10-16 by three independent reviewers: no high or medium findings. Low findings fixed: remotes on the node itself (`localhost`, `127.*`, `0.0.0.0`, `file:`) get no repository key; git files are opened with `O_NOCTTY` after a regular-file check; repository keys tag notes and links only for directory workspaces; invalid keys are dropped before being relayed to browsers; a `delegate` to a linked workspace its connected node no longer has answers 404 "removed" instead of 503 "offline"; the USER warning says "unreachable" only when the gateway did not answer; the Forget text says started sessions keep their USER. Accepted and documented: `.git` symlinks and absolute `gitdir:`/`commondir` are followed (only a normalized key leaves the node). Nits, done 2026-10-17 (released in 0.6.0): gateway and node open their databases with a 5 s busy timeout and create or migrate the schema in one `BEGIN IMMEDIATE` transaction that reads `user_version` under the lock and rolls back on failure (`pirc-gateway/src/db.rs`, `pirc-node/src/store/mod.rs`, tests `concurrent_opens_create_the_schema_once`); the node reads workspace roles and repository keys for registration and workspace creation on a blocking thread (`pirc-node/src/link.rs` `workspace_details`); conformance scenario `agent_assistant_coding_session_context_timeout` (a held `assistant.context`: no USER, one warning, retried next turn, model request 2.5–10 s after). Already fine: per-link `created_at` (`project_links.rs` `set_links` upserts, test keeps the old time). Accepted 2026-10-17: repository keys keep the path's case (`github.com/Owner/Repo` ≠ `github.com/owner/repo`); folding it would need a data migration, and clones of one repository usually share a spelling.
- [x] PTC real-runtime checks and NixOS validation, done 2026-10-16. PTC on macOS with OpenAI (Responses and Chat Completions): recorded in the [PTC evaluation](../docs/evaluations/ptc/ptc-only.md) (Android and Anthropic not checked). NixOS on an OrbStack LXC container and a QEMU NixOS 25.11 VM (kernel 6.12) with the real module: found and fixed three bugs present since 0.4.0 (`7527432`): `ProtectKernelTunables` on the node stopped bubblewrap's `/proc`, so no agent started on a real host; the `bash` tool ran `/bin/bash`, which NixOS lacks; every `nixos-rebuild switch` reset `/var/lib/pirc` to 0700 and the gateway could not restart. After the fix: sandbox ready with the shipped module, `bash` and `unsandboxed_bash` work, 0711 kept across switches. Also passed: bubblewrap under the unit hardening (no capabilities, `NoNewPrivileges`, read-only system, hidden state, proxy-only network), the gateway under its system-call filter with a real `apiKeyCommand`, the daemon-directory handover and `apiKeyFile` ownership, nixpkgs Chromium navigate/screenshot through the node, host Unix sockets hidden except the inference socket, the Nix daemon and `allowUnixSockets`. LXC hosts need `BindPaths=/dev/.lxc/proc` (documented in `docs/deploy/nixos.md`). Also fixed: unread sessions overlapping in the web sidebar (`02a0a7d`). Left (low), done 2026-10-17 (released in 0.6.0): node startup recovery says "node restarted" (runs and commands; the gateway's own recovery keeps "gateway restarted"); a models reload failure logs its cause (the same text startup stops with); a failed or timed-out inference is logged as a warning with node, provider/model and the fixed classification the node gets (HTTP status when known, never an upstream body; `pirc-gateway/src/nodes.rs`); `docs/deploy/sandbox-and-browser.md` says Chromium runs outside the agent sandbox with `--no-sandbox`.
- [x] Released v0.5.0 on 2026-10-16 following the [release policy](../docs/development/releasing.md) and [Upgrades](../docs/deploy/upgrades.md) (gateway schema 1003 is refused by 0.4.x; node protocol unchanged at 10).

Project-isolation E2 (OM config diagnostics) needs no action: it was ported to Rust (`crates/pirc-agent/src/config/memory.rs`) and shipped in 0.4.x.

## Phase 2 — Android approvals (assistant 3a)

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

- [ ] B: require fresh sessions on every scope-generation change (recommended) or allow a weaker continuation; explicit copy between scopes and its review; on disable, keep a dormant scope or require deletion/export. **Shelved 2026-10-17:** no current need; start B only if a project's notes must be kept out of global memory (D below accepts that they may be re-learned).
- [x] D, decided with the user 2026-10-17 (see phase 8 D for the resulting scope):
  - **Shared artifacts:** none exist and none are supported. Node uploads (`pirc-node/src/store/schema.sql` `uploads`) carry only `owner_user`; new uploads record their workspace and session, and older uploads of unknown origin are kept and listed as not deleted.
  - **Old or offline nodes:** not supported. Deletion is refused unless every node holding the project's data is online and new enough; no pending state, retries or "cannot verify" state.
  - **Tombstone:** keep a minimal content-free identity tombstone for the project id, so late in-flight messages and restored node backups cannot recreate it. Project ids are random (`workspace_<uuid>`), so recreating a project with the same name is a new project and inherits nothing.
  - **Guarantee wording:** no defensive prose; the confirmation lists what is deleted and what is not (backups, logs, provider copies, content already written to other repositories or commits, workspace memory written by delegated sessions in linked repositories, information other chats read and rewrote in their own notes).
  - **Restricted profile:** shelved with B.
  - **Notes:** deleting a project deletes the notes it contributed, classified per entry from `memory_log` revision sources against the project's sessions: all revisions from the project → forget (as chat deletion does today, `MemoryStore::forget_session`); project revisions only at the end → roll back to the last revision before them and erase their content from the log; project revisions followed by other sessions' revisions, or created by the project and edited elsewhere → listed on the confirmation with their current text for the user to forget, keep or edit, decided before deletion starts. Notes other chats derived only by reading are not traced (listed as not deleted).
  - **Note tombstones:** gain a `scope` column (the same column B would need): `global` for manual Forget and single-chat deletion (unchanged), the project id for project deletion, so identical text written later by another chat or a new project is accepted. Accepted: deleted project notes may be re-learned by other chats.

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
- [x] Apply phase 4 decisions, done 2026-10-16 (gateway schema 1003). Evidence in the [re-audit](../docs/history/security-audit.md#re-audit-against-the-rust-code-2026-10-15) and the [assistant history](../docs/history/assistant.md#delegation):
  - [x] Approval modes (L14): `features.autoMode.mode` `read-only`/`auto`/`full-access` (`auto_mode/mod.rs` `ApprovalMode`); `enabled:false` maps to `full-access`, `true` to `auto`, with a config warning. Read-only asks for every non-read verdict and for `write`/`edit` and asks no classifier; full access skips the gate; deny-list and lease hold in every mode. Per-session `set_approval_mode` (recorded as `agent.approvalMode`, passed to teammates/subagents at spawn and on change), web picker with a full-access confirmation and a persistent note above the composer.
  - [x] L12: `defaultModel` is trust-gated; the warning names the model; Settings shows it. Hashes of configs without a model unchanged.
  - [x] L11: hook stdout fenced in `<hook_output>` and labelled (session-start output stays in the system prompt, fenced); gateway deliveries start with a "Gateway message (pirc data, not typed by the user)" line.
  - [x] L13: repository skills listed apart as untrusted (`<repository_skills>`); `/skill` marks them.
  - [x] L10: agent and `/cron` schedule deletes are proposals the user approves; a scheduled run cannot ask.
  - [x] Single-user model documented (`docs/deploy/README.md` "One user", `gateway.md`); L3, L5, L6, L8 rate limiter, I1, I4, I8, I9 recorded as accepted in the re-audit.
  - [x] Assistant: "treat this task as my request for auto mode" checkbox (`asUserRequest`, counted by the classifier for the run the task starts only); delegation status in the session list ("Done"/"Failed"); finished delegations older than 90 days pruned hourly unless followed.
  - Checked: unit tests, the web's typecheck/tests/build, and the conformance suite on a NixOS (aarch64) VM with the snapshots re-recorded there (new scenario `agent_approval_modes`); `node_panels_access`/`node_panels_git` differ there only by the VM's newer git usage text and were not re-recorded. Not checked: the web changes in a browser, and the approval-mode switch through a real gateway and node.
- [x] **Linux Unix sockets** done 2026-10-16: every socket bound on the host at plan time (`/proc/net/unix`) is hidden from a session except the inference socket, `allowUnixSockets` and the nix daemon's (open by default, decided with the user: auto mode guards what it is asked to fetch); `allowUnixSockets` also re-opens a `LINUX_HOST_SOCKETS` entry; the read-only sandbox allows none (`sandbox/linux/plan.rs` `host_unix_sockets`). Left: sockets bound after the plan or in another network namespace.
- [x] **Workspace-memory directory** done 2026-10-16: the node keys the session's ledger from the repository's files (no git on the host), creates it and passes the key to the agent; the policy opens only that file (`workspace_memory_file`), and the ledger lock is a `flock` on it instead of a `<key>.lock` file.
- [x] Domain approvals are session-only (`runner/side.rs`). Decided 2026-10-17: keep session-only (repeated prompts are rare); a lasting allow stays `sandbox.network.allowedDomains` in the node config. Revisit if the same domains keep being asked for.
- [x] PTC untrusted tagging, done 2026-10-17 (released in 0.6.0; decided with the user: option B). `memory_search`, `delegation_status`, `agent_inbox` and `board_read` are `agent_data` capabilities (`ptc/registry.rs`, contract `agentData: true`, a note in their signatures): a script that called one has its result fenced as "data written by other sessions or agents (from …)", next to web content when both (`ptc/mod.rs` `render`), and the store keeps that taint like web content's. Plain `bash` output stays unlabelled, like `read`: it is the workspace's own (accepted). Tests in `ptc/tests.rs`. Direct calls of these tools are unchanged. Checked: the workspace's fmt/clippy/tests on macOS and the whole conformance suite on the OrbStack NixOS (aarch64) container, with `git` and `python3` on `PATH`: seven `agent_assistant_ptc`/`agent_team*` snapshots re-recorded there, differing only by the new fence (the conformance normalizer now numbers fence nonces, `pirc-conformance/src/normalize.rs`); `node_panels_access`/`node_panels_git` differ by git's usage text as before. Not checked: a real model reading the fenced results.

Verified fixed in Rust (no action): L1 shared sensitive-path list, L2 `.git/hooks`/`.git/config` protection, L4 workspace registration refusal, L9 database mode 0600, I6 mermaid through DOMPurify, I7 `result` ignored, M14 optional proxy secret.

Accepted, not to be reopened without a new decision: S10 (host atomic replacement detaches a protected Linux mount) and S18 (browser WebSocket/non-HTTP egress, DNS rebinding); see the [archived audit](../docs/history/security-audit.md).

## Phase 6 — Flutter Android follow-up

The active checklist is [Mobile app follow-up work](mobile.md). The Flutter client
now includes the settings, memory, sidebar, notifications, sharing, tool details
and work panels from the former 6a–6d batches. Physical-device acceptance and
fine-grained presentation checks remain open there; this does not mark every old
pixel-level finding as verified. The original item IDs and file references remain
available at `git show 7677d24:plans/mobile-audit.md`.

## Phase 7 — Small storage and config items

- [x] **E3** done 2026-10-15: `missingModelPolicy: 'fallback' | 'error'` (default `fallback`) in `features.observationalMemory`. In `error` mode every configured choice is checked before each memory run (`pirc-agent/src/features/memory/worker.rs` `pick_model`, `PickError::Missing`), before the session model is considered; the run is skipped with an error notification and a persistent `Last model error` in `/om:status` and the panel. A missing preferred model is no longer reported as rate limited. Checked per run rather than at agent start, since the gateway's catalog is what decides. Conformance tests `agent_memory_missing_model_falls_back` (unchanged behavior) and `agent_memory_missing_model_is_an_error` (no memory inference).
- [x] **E1** done 2026-10-15: `PRAGMA secure_delete = ON` on the gateway's (`pirc-gateway/src/db.rs`) and the node's (`pirc-node/src/store/mod.rs`) database connections; tests `deleted_content_is_zeroed` show deleted text gone from the file (and present without the pragma). Measured with SQLite 3.51 on a gateway-like mix (3,000 transactions of note upserts, log inserts, command insert/update and periodic deletes, WAL): OFF 2.86 s / 67.3 MiB WAL, ON 2.84 s / 67.9 MiB (+0.9%), FAST 2.96 s / 67.3 MiB. Documented in `docs/deploy/backup-and-recovery.md`; old WAL frames, backups and files are not sanitized.

## Phase 8 — Project-only memory and hard delete

Full designs (change points, invariants, migration and protocol): `git show 7677d24:plans/project-isolation.md`, sections B and D. Paths there are TS and must be remapped to `crates/pirc-gateway`/`crates/pirc-agent`.

- [ ] **B. Project-only USER/MEMORY, opt-in.** Off by default and for existing projects; global memory stays the preferred mode. Add `scope_id` (default `global`) to entries/log/proposals and a composite tombstone key; scope every store entry point by a trusted `{owner, scope}` derived from the session, never from agent arguments; scope search, recall and mirrored records; version snapshots by scope generation; proposals bind scope and generation. Not retroactive: old sessions keep their frozen snapshots. Isolates projects from each other, not data from the gateway/node operators, providers or backups.
- [x] **D. Hard-delete project**, done 2026-10-17 (released in 0.6.0; gateway schema 1004, node schema 2001, node protocol 11). Project page → Settings → Delete project…, `GET`/`POST /api/workspaces/:id/deletion` (`pirc-gateway/src/project_deletion.rs`): one transaction fences the project and its chats (`workspace_deletions`, `session_deletions`) and handles memory, the chat node deletes its chats, uploads, browser profile and directory (`DELETE /api/workspaces/:id`, `pirc-node/src/app.rs` `delete_workspace`), a last transaction sweeps memory again and deletes the gateway's rows; the fence rows stay, so registration (`sync_remote_workspaces`) cannot bring the project back. An unfinished deletion stays listed (`deleting: true`) with Finish deleting… on its page. Memory by the session of each logged version (`memory/store.rs` `project_plan`/`delete_project`), counting chats deleted from the project before (`session_deletions.workspace_id`): all from the project → forget; the project's only after every other → roll back and erase them from the log (forget if the earlier text was forgotten since); mixed → the user's forget/keep/edit, checked on the entry's revision (409 reloads). Tombstones are scoped (`memory_tombstones.scope_id`): project deletion's refuse nothing. Uploads record their workspace and session and are usable only there; older uploads are kept. Memory writes recheck the chat's fence under the writing lock. Docs: [chat projects guide](../docs/guides/chat-projects.md#deleting-a-project), [upgrades](../docs/deploy/upgrades.md). Checked: unit tests (gateway memory classification, fences, migrations of both stores), web tests and typecheck, the new conformance scenario `project_deletion` (assertions, real gateway and chat node) on macOS and on the NixOS (aarch64) VM, and the whole conformance suite on that VM: only `node_link` changed (protocol 11, re-recorded), `node_panels_access`/`node_panels_git` differ by the VM's git usage text as before, and `agent_auto_mode` needs `python3` on the VM. Reviewed by an independent reviewer; fixed: unfinished deletions were unreachable from the web, decisions were dropped on resume, chats deleted earlier counted as other chats, a CSS regression, roll back over a global tombstone, a node without the project blocked deletion, the node's path check ran after deleting, unvalidated storage names, an upload racing the fence. Not checked: the dialog in a real browser, a deletion interrupted by a real node disconnect. Left: entries forgotten or rolled back are handled as they are at confirmation (only entries needing a decision are compared); a rollback may leave memory over budget; chat deletions before schema 1004 did not record their project.

## Manual validation (needs real hardware or hosts)

Attach each to the release that depends on it; none is a feature task.

- **Browser:** real Android takeover (tap mapping, IME, drag scrolling) and WebM playback.
- **Schedules:** installed-PWA push on a real iPhone (Add to Home Screen). Deploy gateway and nodes together for the changed deliver body.
- **Sandbox (NixOS/Linux):** done for 0.5.0 (see phase 1). Left: a full agent session (browser included) on a non-container x86_64 host at native speed; the boot-time tmpfiles path on a real host. The srt `apply-seccomp` item is obsolete: no srt ships since the Rust cutover.
- **Mobile:** iOS/Android soft keyboard and safe areas, CJK IME in the Android composer, terminal https asset origin, release build on a real phone.
- **PTC:** done for 0.5.0 on macOS with OpenAI (see phase 1). Left: Anthropic direct calls with `null`/extra arguments; declining approvals and rendering on the new Android client.
- **Rust post-cutover:** the `node_link_side_runs` CI timeout (once, not reproduced); TLS, a real identity provider, phone pairing, push and terminals are not covered by the macOS end-to-end checks; the macOS archives (v0.4.1, v0.5.0) are unsigned and not notarized.

## Accepted limitations (record only)

- **Browser:** teammates/subagents have no browser; the screenshot action log is memory-only and lost on node restart.
- **PTC (accepted P3):** bash writes via a symlink created in the same command can skip the write lease; plain `bash` output is not tagged untrusted inside `ptc` (a fetcher or URL in the command is, and so are `agent_inbox`, `delegation_status`, `memory_search`, `board_read` since 2026-10-17); guests inherit agent sandbox rights; the approval convention does not enumerate host-gated operations; operations ignoring abort may outlive the five-second grace; after an agent crash mid-script the model sees "interrupted"; queued operations count toward progress and eight long waits can fill all slots. Reviewed fixes changed behavior after the evaluated builds and were not re-measured.
- **Rust post-cutover, waived not passed:** full PTC/task-time comparison with the TS baseline, real-provider smoke tests, polyglot evaluation. Reopening needs an agreed protocol, budget and credentials (historical tooling at `2d480d3`). Protocol 10 is incompatible with TS nodes/gateways; never delete old state without approval.

## Watch, do not build yet

- **Consolidation ("dreaming"):** only if `memory_full` becomes frequent at 8,000 characters; must keep origins (consolidated text may not gain `user` origin). Revisit budgets first.
- **Moving chats between projects, shared project files:** not painful with a handful of chats.
- **Vector search:** `LIKE` over a few thousand notes is fine; revisit only when searches miss.
- **A second chat node:** would need its own `chats` workspace and a rule for New chat.
- **`workspace.read`** (reading a linked repository from a project without delegating): only if chats keep delegating just to look at a file.
