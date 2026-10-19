# Data-driven workspace modes

[Plans](README.md) · [Assistant contracts](../docs/architecture/assistant-memory.md) · [Chat projects guide](../docs/guides/chat-projects.md)

Goal: a workspace's mode (today `chat` or `directory`, shown as Chat / Work) is data, not two hard-coded branches, so the user can define more modes. Code defines a fixed vocabulary of capabilities; a mode file combines them. There are no built-in modes: `chat` and `directory` are two default mode files, edited or removed like any other.

This file is the work queue for the change, not authorization: phases 2 and 3 each need the user's go-ahead.

## Principles

- **Code asks capabilities, never kinds.** No `kind == Chat` outside the code that parses or creates a workspace.
- **A capability only grants.** A missing, unknown or invalid mode is refused (or gets the narrowest mode), never widened to `directory` as the store parsers do today (`pirc-node/src/store/mod.rs` `workspace_kind`, `pirc-gateway/src/db.rs` `WorkspaceKind::from_column`).
- **The gateway owns modes.** Half the capabilities are enforced by the gateway (assistant memory, delegation, schedule scope, capability policy). A node declaring its own modes would grant itself those, so mode definitions live in the gateway's configuration and reach nodes from it, like the model catalog. A repository's `.pirc/` never defines a mode.
- **Safety invariants are checked when a mode is loaded**, not left to each call site (see "Forbidden combinations").

## Capability vocabulary (phase 1)

`crates/pirc-protocol/src/mode.rs` `Mode`. Phase 1 constants (phase 2 default files): `CHAT` / `WORK`.

| Field                  | Replaced                                                                                                                                                                                            | chat        | directory   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------- |
| `id`                   | `PIRC_WORKSPACE_KIND`, `workspaces.kind` text                                                                                                                                                       | `chat`      | `directory` |
| `node_role`            | gateway `nodes.rs` registration check, node `store::check_role`                                                                                                                                     | chat        | node        |
| `workdir`              | node `chat::session_root`                                                                                                                                                                           | per-session | workspace   |
| `prompt`               | agent `config.rs` system prompt (SOUL/CHAT vs base + AGENTS.md)                                                                                                                                     | assistant   | coding      |
| `features_off`         | agent `feature.rs` `off_in_chat` → `off_in_mode` (goal, todo, agentTeam, background)                                                                                                                | 4 off       | none        |
| `assistant`            | gateway memory ops `require_chat` and `assistant.context`, capabilities patch (`db.rs`), agent `assistant` `gateway_of`/`user_gateway_of`, `memory_search` recall via gateway, `/cron` capabilities | full        | user        |
| `delegate`             | gateway `delegations.rs` `require_chat` → `require_delegate`                                                                                                                                        | ✓           | ✗           |
| `delegate_target`      | gateway `delegations.rs` workspace list and link target, `dispatch.rs` `resolve_directory_workspace`                                                                                                | ✗           | ✓           |
| `schedule_scope`       | gateway `schedules/ops.rs` `is_chat` → `schedules_anywhere`                                                                                                                                         | any         | own         |
| `project_instructions` | node `chat::project_instructions_path`, `app.rs` `chat_project`; gateway `/instructions` routes; agent `project_instructions` feature, team's frozen instructions, protected path                   | ✓           | ✗           |
| `project_files`        | node `project_files::files_dir`; gateway `/files` routes; agent `PIRC_PROJECT_FILES`                                                                                                                | ✓           | ✗           |
| `project_config`       | node `directory_workspace`, `set_project_trust`, runner trust; gateway `/project-config`, `/project-trust`                                                                                          | ✗           | ✓           |
| `workspace_memory`     | agent `memory` `workspace_on`, node runner `workspace_ledger`                                                                                                                                       | ✗           | ✓           |
| `repository`           | node `link.rs` origin detection, gateway `project_links.rs` link target                                                                                                                             | ✗           | ✓           |
| `recap`                | agent `recap.rs` `available`                                                                                                                                                                        | ✗           | ✓           |
| `delete_sessions`      | node `app.rs` and gateway `routes.rs` chat deletion                                                                                                                                                 | ✓           | ✗           |
| `projects`             | gateway `project_links::is_project`, node `app.rs` workspace deletion (with the top-level `chats` exception)                                                                                        | ✓           | ✗           |

Not yet capabilities (still keyed on the top-level `chats` workspace id or the node role, not the kind): `ensure_top_level_chats`, the chat node's `SOUL.md`/`CHAT.md` routes, `NodeConfig::chat()`.

### Forbidden combinations

Asserted for the phase 1 constants in `mode.rs` tests; phase 2 makes them load errors:

- `assistant: full` with `workdir: workspace` (assistant memory next to a repository's content).
- `delegate` with `delegate_target` (delegating to itself).
- `workspace_memory` or `project_config` without `repository`.
- `schedule_scope: any` without `delegate`.

Phase 2 adds: `projects` with `workdir: workspace`; `project_files`/`project_instructions` with `repository` (both would be read from the repository, which the user does not control).

## Phase 1 — Capabilities in code

- [x] Done 2026-10-18. `Mode` and the two built-in modes in `pirc-protocol`; every non-test `kind == Chat/Directory` branch in `pirc-agent`, `pirc-node` and `pirc-gateway` asks a capability instead (table above). `WorkspaceKind` stays the stored and wire type, with `.mode()`. No behavior, protocol, schema or text change. Checked: `cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings`, `cargo test --workspace`. Not run: the conformance suite.

## Phase 2 — Modes from configuration

Behavior for existing installs stays identical: on first start the gateway writes the two default mode files, equal to phase 1's `CHAT`/`WORK`, and from then on only the files count.

Implementation started and continued with the user's go-ahead 2026-10-18. The catalog cutover is implemented: gateway startup/SIGHUP load authoritative files, protocol 12 distributes modes, both stores retain typed mode ids without widening, and agents enforce validated `PIRC_MODE` snapshots, feature defaults and tool ceilings. Node acceptance uses `PIRC_MODES`; mode definitions no longer contain `node_role`. Default constructors remain file-source/test fixtures only. `GET /api/modes` is available for inspection; phase-3 clients are unchanged. Working-directory strategy edits cannot reinterpret existing node-managed state as repository content. Syntactically invalid historical stored ids fail closed with a DB error; valid missing ids remain unavailable/read-only.

Cutover validation in `nix develop`: workspace Clippy `-D warnings`, workspace tests (agent 350, gateway 111, node 310 with 2 ignored, configuration 39), gateway/node debug builds, Rustfmt, repository Prettier, Web typecheck/tests (334 tests)/build and version/catalog/browser-assets checks passed. Both Nix cargo dependency derivations build with the refreshed vendor hash. The assertion-based `tests/modes.rs` scenario runs real debug gateway/node/agent on macOS and covers custom-mode prompt sections, restricted tools, a refused gateway capability, invalid-file warnings, removal/read-only history and new-session refusal. Native macOS sandbox tests pass. Linux follow-up 2026-10-19 ran in an isolated NixOS/aarch64 OrbStack copy with release gateway/node builds, Rust 1.98.1, Chromium 153.0.8010.47 and required browser coverage. Full conformance passed **217 tests**, including all six browser scenarios and the custom-mode scenario, with `INSTA_UPDATE=no` after reviewing/recording 12 snapshots (180 additions, 47 deletions). The normal wrapper still correctly skips on macOS; snapshots were generated only on Linux. The run found and fixed disabled-feature management/diagnostic removal, path-only workspace creation compatibility, and three fake-node helpers that had not consumed the new Modes frame. Missing Python in the initial Linux shell was corrected as an environment prerequisite, not recorded as expected output. Additional Linux checks passed: agent 352, config 39, policy 30, protocol 19 and node 314 unit tests (2 node tests remain ignored), plus native sandbox 19, read-only sandbox 3 and real-agent sandbox 2 integration tests. A native-sandbox fixture's host socket paths were shortened to avoid SUN_LEN failures in deep checkout paths. No ignored real-host-root tests, host sysctl changes or deployment actions were run.

A fresh reviewer pass found and prompted fixes for invalid-catalog stale grants, custom-only chat-node initialization, symlinked state-layout checks, independent delegation/memory tools, legacy create-response compatibility and Stop handling. Mode-source symlink targets are protected in agent PathGuard and generated sandbox policy; native execution of the new symlink-specific cases was not separately exercised. Colocated gateway/node config ownership limitations and session-start protection snapshots are documented. Initialization failures remain fail-closed with manual recovery guidance.

- [x] **Owned `Mode`.** Turn `Mode` from `&'static` constants into an owned, serde-parsed struct (`ModeId(String)`, `features_off: Vec<String>`, plus `label`, `description`, `ui` hints). `CHAT`/`WORK` stop being modes the code serves; they remain only as the source of the default files and as test fixtures. Write the validator (field ranges, forbidden combinations, unknown keys rejected, id `[a-z][a-z0-9_-]{0,39}`; no id is reserved).
- [x] **Mode files.** `$PIRC_CONFIG_DIR/modes/<id>.md` on the gateway host: YAML front matter for capabilities, the body as the mode's own prompt section (8,000 characters, like roles). Loaded at start and on `SIGHUP` with the models file; a file that fails validation is skipped with a logged warning naming the file and the rule, and the rest still load. Same parser as roles (`pirc-agent/src/roles.rs`), moved to `pirc-config` or `pirc-protocol` if shared.
- [x] **Default files, no built-ins.** If `$PIRC_CONFIG_DIR/modes/` does not exist, the gateway creates it with `chat.md` and `directory.md` (0600, never overwritten afterwards; a NixOS module may instead provide the directory read-only). An existing directory is authoritative, even when empty: editing `chat.md` changes chat, deleting it makes chat workspaces unavailable (see "Store mode ids"), never silently restores the default. `pirc-gateway modes --print-defaults` prints the defaults for comparison after upgrades.
- [x] **Feature and tool selection.** `features_on` next to `features_off` (a feature in neither follows the node's config; `features_on` turns on one the node's config leaves off by default, an explicit `enabled: false` in the node config still wins; listing a feature in both is a load error), and `tools`: an allowlist of tool names the session gets, like a role's `tools`. A role's `tools` inside such a session is intersected with the mode's, never widened; team coordination tools follow the same rule as for roles. Unknown feature or tool names are load errors.
- [x] **Prompt as sections.** Replace `prompt: Coding | Assistant` with an ordered list of named built-in sections (`base`, `agents:global`, `agents:workspace`, `agents:project`, `soul`, `chat-env`, `chat-md`) plus `body`. The default files reproduce today's prompts byte for byte (test against the current `system_prompt`).
- [x] **Store mode ids.** `workspaces.kind` already holds `chat`/`directory`, which become mode ids, so no data migration. Replace the "unknown → directory" parsers on both stores with a typed `ModeId`; a workspace whose mode is not in the catalog is listed as unavailable (no sessions start; existing ones read-only) instead of widened. Schema bump only if a column or constraint is added.
- [x] **Protocol.** `RegisteredWorkspace.kind: WorkspaceKind` → `mode: String` (keep reading `kind` from the previous version during the check only to refuse it with a clear close reason). The gateway sends the mode catalog to each node after registration and on reload (`GatewayMessage::Modes`); nodes keep no mode definitions of their own. The gateway checks each registered workspace's mode against the catalog and against the node's role. `NODE_PROTOCOL_VERSION` 11 → 12: gateway and nodes deploy together ([Upgrades](../docs/deploy/upgrades.md)).
- [x] **Node role.** Replace `node_role` with `hosts: [chat, node]` or, better, let each node advertise the mode ids it accepts in its config (`PIRC_MODES`), defaulting to today's pin (`chat` on `pirc-node chat`, `directory` otherwise). `check_role` and the gateway's registration check use that list.
- [x] **Agent.** `PIRC_WORKSPACE_KIND` → `PIRC_MODE` carrying the validated mode as JSON (the node got it from the gateway); the agent never reads mode files. `AgentConfig::mode()` returns the owned value.
- [x] **Creating workspaces.** `POST /api/workspaces` takes `mode`; per-session-workdir modes create like chat projects today, workspace-workdir modes take a path like directories. Refuse a mode the target node does not accept.
- [x] **Docs and tests.** Guide and custom-mode end-to-end scenario implemented; macOS debug and Linux release scenarios passed. Full Linux snapshot conformance passed with updates disabled after independent review of the 12 refreshed snapshots. Guide `docs/guides/modes.md` (format, every field, forbidden combinations, examples: a "research" chat-like mode without delegation, a "review" coding mode in read-only approval); `CHANGELOG.md`; conformance scenario: a custom mode end to end (registration, prompt sections, a refused capability at the gateway, an invalid file skipped).

Decided with the user 2026-10-18:

1. No built-in modes: `chat` and `directory` are default files the user may edit or delete (above).
2. Modes set no approval mode; it stays the node's default and the per-session picker.
3. Modes get `features_on` as well as `features_off`, and a `tools` allowlist (above).

## Phase 3 — Clients from the catalog

- [ ] **API.** `GET /api/modes` (id, label, description, icon, group, noun, capabilities the UI needs: `delete_sessions`, `projects`, `project_files`, `project_instructions`, `project_config`). `Workspace` JSON gains `mode`; keep `kind` for one release for older clients.
- [ ] **Web.** Replace `isChatWorkspace` (`apps/web/src/lib/chats.ts`) and `SidebarMode = 'chat' | 'work'` (`app.svelte.ts`) with catalog lookups: sidebar tabs by mode `group` (the default files keep the Chat / Work tabs), "New chat/session" by `noun`, settings panels and the action count (`Sidebar.svelte`, `WorkspacePage.svelte`, `SidePanel.svelte`) by capability, the create-workspace dialog lists modes. Saved `mode` preferences that name an unknown group fall back to the first tab.
- [ ] **Android.** The same in `apps/android/lib/live/` (`work_index.dart` `isChat`, `gateway.dart` mode preference, `session_sidebar.dart`, `mobile_tabs.dart`, `workspace_settings.dart`, `workspace_dialogs.dart`, `app.dart`); parity captures for a third mode.
- [ ] **Settings.** A read-only Modes page listing each mode, its source file and its validation warnings (editing stays in files: they are node-host configuration the agent cannot write).
- [ ] Docs: the modes guide gains screenshots; `docs/guides/chat-projects.md` says projects are one mode's capability.
