# 00 拆除：清掉退場的實作

[重寫](README.md) · [盤點](inventory.md) · [決定](decisions.md)

**目標**：把 direction 明確退場、而且沒有後續 plan 要當種子的實作刪掉，讓後面每份 plan 在乾淨的地基上蓋。刪完後 workspace 仍要 `cargo clippy -D warnings` 與 `cargo test` 全綠；worker session（引擎蓋）照常可用；**chat / 助理功能在 02 之前不存在**，這是接受的。

**依賴**：無。**被依賴**：全部。

## 原則

- 只刪盤點標「刪」且沒有 plan 註明「種子」的東西。標「重寫」的留到對應 plan 再換掉，避免半套。
- 不碰使用者狀態：舊 `gateway.sqlite` / node DB 原地不動（決定 #14）。新 DB 檔名在 01 決定。
- 每刪一個物件，連帶刪它的 conformance 測試、snapshot、fixture、docs 段落與 CHANGELOG 提及；不留「已移除」殘段。
- 一個 commit 一個物件，方便 revert。

## 工作項目

### Gateway

- [ ] `schedules/{api,ops}.rs`、`schedules/mod.rs` 的 schedule 物件、`timer.rs` 的 session 派發、`fields.rs`；表 `schedules` `schedule_runs` `schedule_proposals`。**保留** `schedules/cron.rs`（搬到 `time/cron.rs`）與 `timer.rs` 的 earliest-deadline 骨架（搬到 `wake/timer.rs` 待 05 用）。
- [ ] `memory/interactions.rs`、`memory_proposals` 表、`memory/routes.rs` 的 approve/reject、`memory/ops.rs` 的 `memory.proposeUser`。
- [ ] `project_deletion.rs`、`workspace_deletions` 表、`session_deletions` 的 project 欄位。
- [ ] `assistant_node` 表、`node_events.rs` 的 chat-node binding、`routes.rs` 的 `/api/assistant/prompts` relay。
- [ ] `routes.rs` 的 chat/project routes：`/instructions`、`/files`、`/capabilities`、project 建立/刪除。**保留** sessions / snapshot / commands / control / panel / git / files / terminals / uploads / delegations stop（引擎蓋）。
- [ ] `db.rs` 的 `Capabilities`、`delegation_approval`；`workspace_capabilities` 表。
- [ ] `delegations.rs` 的 pending-card 狀態機（`always`/`untrusted` 路徑、卡片 interaction）；**保留** `create`/`start_task`/`answer_relayed`/`report`/retry/4 個並發上限。
- [ ] `features.rs` 的 schedule / proposal hook；`hints.rs` 的 schedules hint；`push.rs` 的 schedule / proposal 推播種類。
- [ ] `agent_ops.rs` 與 `pirc-protocol::valid_agent_op`：移除 `schedule.*`、`memory.proposeUser`、`assistant.context` 的 capability 檢查。

### Protocol / config / policy

- [ ] `link.rs::NodeRole::Chat`；`Registration.role` 改成只剩 node。
- [ ] `mode.rs`：移除 `assistant`、`delegate`、`schedule_scope`、`project_instructions`、`project_files`、`projects`、`delete_sessions`、prompt sections `soul`/`chat-env`/`chat-md`、`default_chat`；forbidden combinations 相應縮減（[existing-plans §2](existing-plans.md)）。
- [ ] `pirc-config`：`modes/chat.md`、`NodeConfig.role`/`chat()`/`CHAT_WORKSPACE_ID`、`directory.md` 的 `assistant: user` 與 schedule scope。
- [ ] `policy/session.rs`：chat 專用假設。

### Node

- [ ] `chat.rs`（先把 `session_root` / `js_trim` 抽到 `util.rs`）、`assistant_prompts.rs`、`project_files.rs`、`cli.rs` 的 `chat` 子命令、`store::check_role`、`app.rs` 的 chat/project/instructions/files/SOUL routes、`runner/process.rs` 的 chat prompt / project files / instructions 注入、`panels/mod.rs` 與 `browser/util.rs` 對 `chat::` 的依賴。
- [ ] node 表 `workspace_deletions`。

### Agent

- [ ] `features/schedules.rs`（含 `/cron`）、`prompts/tools/memory_propose_user.md`。
- [ ] `features/assistant/mod.rs`：刪 `Kind::Propose`、`memory_propose_user`、`propose()`、`frozen_snapshot`、`user_section`、`memory_section`、`assistant.context` 等待；**保留** `delegate()`、`delegation_status`、`memory_note`、`memory_search`、`recall`、`find_quote`/`find_recent_quote`/`current_origins`（06 的種子），即使暫時沒有 caller。
- [ ] `features/project_instructions.rs`、`capabilities.rs`、`config.rs` 的 SOUL/CHAT 載入分支、`features/mod.rs` 的 chat-only feature 列表。
- [ ] `roles.rs` / `feature.rs` 的 `off_in_mode` 對退場 capability 的引用。

### Clients

- [ ] Web：`ScheduleSettings` `SchedulesPage` `InteractionCard` 的 proposal/delegation-card 分支 `ApprovalModeControl` `DelegationStrip` `Project*` `NewSessionDialog` `NewProjectDialog` `DeleteChatDialog` `DeleteProjectDialog` `lib/{control,schedules,project-deletion}.ts`、`MemorySettings` 的 proposal 區、`SettingsDialog` 的對應 tab、`Sidebar` 的 Chat tab。Work tab 暫留（引擎蓋的前身）。
- [ ] Android：`live/{schedules_page,schedules_state,attention,attention_card,approval_mode_control,delegations_strip,project_deletion_dialog,workspace_project_files,workspace_project_links}.dart`、`interaction*.dart` 的 proposal 分支、Kotlin `Schedules.kt` `Control.kt`、對應 fixtures 與測試。
- [ ] `fixtures/mobile-parity/{assistant-settings,attention,...}.json` 中退場畫面的 fixture。

### 測試、腳本、文件

- [ ] conformance：`node_chat.rs`、`schedules.rs`、`project_deletion.rs`、`agent_assistant*.rs` 的 proposal/frozen 部分、`memory.rs` 的 proposal 部分、`delegations.rs` 的卡片部分、`agent_gateway_tools*` 的 schedule/propose ops；對應 snapshots。
- [ ] `scripts/approval-stats.ts` + test；`package.json` 的 `dev:chat`。
- [ ] `nix/module.nix`：`services.pirc.chat`、chat assertion、`chatPackage` 殘留；`soulPrompt`/`chatPrompt` 暫時移除（02 以 gateway 設定重新加回）。
- [ ] docs：刪 `guides/{chat-projects,schedules,session-ui}.md`；`plans/delegation-autonomy.md`；`plans/README.md` 先改成指向 `plans/rewrite/`（完整重寫在 13）。其餘文件裡對退場物件的段落刪除，不改寫（改寫在各 plan）。
- [ ] `CHANGELOG.md`：一條「rewrite 開始；chat node、schedules、memory proposals、chat projects 移除」。

## 驗證

- `bun run check`（含 clippy `-D warnings`、workspace tests、web typecheck/tests/build、conformance）。
- 手動：gateway + 一個 coding node 啟動；建 directory workspace、開 session、跑 bash、terminal、git panel、delegation stop 路由仍可達（即使無人建立 delegation）。
- `grep -rn 'chat_node\|NodeRole::Chat\|schedule_proposal\|memory_proposal\|project_files\|delegation_approval' crates apps` 為空。

## 實作前待決

- `delegations` 表的 `assistant_session_id` 欄位：這份 plan 先留（06 改成 room/face/thread）。
- Web 的 Work tab 在 01–02 之間是唯一 UI；是否值得先把它改名成「引擎蓋」？建議不改名，等 11。
