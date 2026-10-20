# 08 Node 是能力：宣告、挑手、workspace.read、scratch

[重寫](README.md) · [direction §3.2](../../docs/architecture/direction.md) · [決定](decisions.md) · [existing-plans §2 modes](existing-plans.md)

**目標**：node 註冊時宣告能力，頭腦替任務挑手；頭腦可直接唯讀一個 linked workspace（不叫工人）；沒有合適 workspace 時用 scratch；mode 詞彙縮減到 worker 執行 profile。

**依賴**：00；`workspace.read` 作為頭腦工具依賴 02。可與 03–07 平行。**被依賴**：06（挑手）、09（workspace 來源）。

## 決定（已定）

- 能力 schema：`{os, arch, gpus: [{vendor, model, count, vramMb}], browser, terminals, sandbox: {backend, status, gpu}, workspaces, load: {running, max}}`；閒 = `running < max`（#7）。`sandbox.gpu` 另報，頭腦挑手看它不看 `gpus[]`（existing-plans §4）。
- 能力是事實不是授權（§3.2）。

## 設計

**協定**（`pirc-protocol/link.rs`，`NODE_PROTOCOL_VERSION` 13 → 14）：

- `Registration` 去 `role`，加 `capabilities: Capabilities`（上述 schema）。`load` 之後用既有 activity 訊息更新（`NodeMessage::Activity` 加 `running`）。
- 新 RPC：`GatewayMessage::WorkspaceRead { request_id, workspace_id, op: List{path} | Read{path, range?} | Grep{pattern, path?} | GitLog{n} | GitStatus }` / `NodeMessage::WorkspaceReadResult`。node 側用 `panels/inspect.rs` 的 confined 讀取與沙箱 git；不起 runner、不露 canonical path；bytes 上限（64 KiB/次）。

**Gateway**：

- `nodes.rs`：`NodeRegistry` 存能力；`GET /api/nodes` 回傳。
- `brain/hands.rs`：`pick_node(task_hint, workspace?)`：有指定 workspace → 擁有它的 node（多個選閒的）；`node_hint`（「在 mac 上跑」）→ 名稱/OS 匹配；需要 GPU → `sandbox.gpu` 開的；否則閒的第一個。沒有 → 房間 line「沒有合適的機器」。
- 頭腦工具 `workspace_read {workspace, op, …}`：只對 linked workspaces（10 的面孔地盤；之前是 `project_links` 全部）；結果帶 `tool:workspace:<id>` origin。
- 09 的 workspace 來源輪詢（dotfiles 一日一次）用同一條 RPC。

**Scratch**：`modes/scratch.md` 升格為預設檔（待決，見下）：`workdir: per-session`、`repository: false`、`delegate_target: true`、`project_config: false`。node 預設接受 `directory` + `scratch`。scratch 目錄 `$PIRC_STATE_DIR/scratch/<session>/`，用 00 抽出的 `session_root`；保留期設定（預設 7 天後可清，清之前房間 line）。

**Modes 詞彙縮減**（existing-plans §2 的表）：`mode.rs` 只剩 `id`、`label`、`description`、`workdir`、`features_on/off`、`tools`、`delegate_target`、`project_config`、`workspace_memory`、`repository`、`recap`、`ui.{noun,icon}`、`body`。00 已刪退場欄位；這裡補 `--print-defaults` 與 guide。

**Research profile**（待決）：wake 的唯讀工人需要 node 側真正唯讀（`read-only` approval mode + `policy/session.rs` 的唯讀 policy + 瀏覽器研究模式）。兩種做法：(a) mode 檔 `research.md` 設 `approval: read-only`（翻 2026-10-18「modes set no approval mode」）；(b) `deliver` 的 task policy 帶 `read_only`，mode 不碰。**建議 (b)**：policy 由頭腦交付、node 強制，不給 mode 檔機會放寬。

## 工作項目

- [ ] 協定 14：`Capabilities`、`WorkspaceRead` RPC；gateway/node 一起升版。
- [ ] node：能力偵測（`std::env::consts`、GPU：macOS `system_profiler`/Metal 探測、Linux `/dev/nvidia*`/`/dev/dri`；browser/terminal/sandbox 來自設定與 `Sandbox::status`）；`load` 隨 runner 數更新。
- [ ] node：`WorkspaceRead` handler（`panels/inspect.rs` 重用、owner 檢查、bytes 上限）。
- [ ] gateway：registry、`/api/nodes`、`pick_node`、`workspace_read` 工具。
- [ ] scratch：預設檔、目錄、保留期、00 的 `session_root`。
- [ ] `policy/session.rs`：`read_only` task policy → 唯讀 path policy + 無網路寫；`runner/process.rs` 接收（06 的 `task_context`/`read_only`）。
- [ ] `policy/session.rs`：拿掉 chat 專用假設（從 [00](00-demolition.md) 移來）：`SessionPolicyInput.protected_paths`（原本保護專案 instructions，現在所有 caller 都傳空；連帶 `pirc-node` `sandbox/{mod,common,macos}.rs` 的同名欄位）、`config_dir` 下 `SOUL.md`/`CHAT.md` 的寫入保護（02 把 SOUL/CHAT 移到 gateway 後才拿，在那之前留著無害）、`workspace_root`/`workspace_memory_file` 註解裡的 chat session、以及 `lets_a_chat_session_work_in_its_directory_inside_the_nodes_state`、`never_lets_a_chat_session_touch_its_projects_instructions` 等 chat 測試與 `Layout.chat`。
- [ ] Web 引擎蓋：node 卡片顯示能力與 load。
- [ ] conformance：`node_link` 加能力註冊與 load 更新；`node_workspaces` 加 `WorkspaceRead` 的 confined 讀取與越界拒絕；`modes` 改寫；scratch delegation scenario 沿用。

## 驗證

- conformance `node_link`、`node_workspaces`、`modes`、`agent_sandbox`（read-only policy）。
- 手動：兩台 node（mac + linux），「在 mac 上看一下 pirc 的 README」→ 頭腦用 `workspace_read` 不起 worker；「跑 tests」→ 挑閒的。

## 文件

- `docs/guides/modes.md` 重寫；`docs/deploy/node.md` 加能力與 scratch 設定；`docs/development/gateway-and-node.md` 協定段。

## 實作前待決

- research profile：mode 檔 vs task policy（上，建議 task policy）。**實作前定。**
- `scratch.md` 升格預設檔（翻 2026-10-19 決定 2）。**實作前定。**
- GPU 偵測要多準：第一版只要 vendor + count；model/vram 可空。
