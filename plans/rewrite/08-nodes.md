# 08 Node 是能力：宣告、挑手、workspace.read、scratch

[重寫](README.md) · [direction §3.2](../../docs/architecture/direction.md) · [決定](decisions.md) · [existing-plans §2 modes](existing-plans.md)

**目標**：node 註冊時宣告能力，頭腦替任務挑手；頭腦可直接唯讀一個 linked workspace（不叫工人）；沒有合適 workspace 時用 scratch；mode 詞彙縮減到 worker 執行 profile。

**依賴**：00；`workspace.read` 作為頭腦工具依賴 02。可與 03–07 平行。**被依賴**：06（挑手）、09（workspace 來源）。

## 決定（已定）

- 能力 schema：`{os, arch, gpus: [{vendor, model, count, vramMb}], browser, terminals, sandbox: {backend, status, gpu}, workspaces, load: {running, max}}`；閒 = `running < max`（#7）。`sandbox.gpu` 另報，頭腦挑手看它不看 `gpus[]`（existing-plans §4）。
- 能力是事實不是授權（§3.2）。

## 設計

**協定**（`pirc-protocol/link.rs`，`NODE_PROTOCOL_VERSION` 14 → 15；00 已升到 14）：

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

- [x] 協定 14：`Capabilities`、`WorkspaceRead` RPC；gateway/node 一起升版。（2026-10-21）協定 **15**（00 已用掉 14）：`Registration` 去掉 `role`（舊 frame 帶著也照讀），加 `capabilities: Option<Capabilities>` = `{os, arch, gpus: [{vendor, model?, count, vramMb?}], browser, terminals, sandbox: {backend, status, gpu}, maxRunning}`。跟計畫不同：(1) `workspaces` 不重複放進能力，registration 本來就有；(2) `load` 不加協定欄位，gateway 從既有 `activity` frame 數開著的 run（`running`），`max` 是 node 報的 `maxRunning`（`PIRC_MAX_RUNNING`，預設 4，只供挑手、不強制）；(3) `WorkspaceRead` 不新增 frame，走既有的 relayed request（`POST /api/workspaces/:id/read`，gateway 不為瀏覽器轉發這條，等於 gateway 專用）。
- [x] node：能力偵測（`std::env::consts`、GPU：macOS `system_profiler`/Metal 探測、Linux `/dev/nvidia*`/`/dev/dri`；browser/terminal/sandbox 來自設定與 `Sandbox::status`）；`load` 隨 runner 數更新。（2026-10-21）`capabilities.rs`：Linux 讀 `/sys/class/drm/cardN/device/vendor`（nvidia/amd/intel/其他 PCI id），沒有 DRM 的 NVIDIA 數 `/dev/nvidiaN`；macOS 只報 Apple silicon（vendor + count，照決定；不跑 `system_profiler`）。sandbox backend `bubblewrap`/`seatbelt`/`srt`/`none` 與 status 來自 `Sandbox::check`，`gpu` 一律 false（等 sandbox-gpu）。
- [x] node：`WorkspaceRead` handler（`panels/inspect.rs` 重用、owner 檢查、bytes 上限）。（2026-10-21）`panels/read.rs`：`list`（`list_directory`）、`read`（從 `offset` 起，整字元，`nextOffset`）、`grep`（regex、不分大小寫、略過隱藏目錄與 build 輸出、不跟 symlink、最多 200 筆）、`git_log {n≤50}`、`git_status`（唯讀沙箱裡的 git）；路徑經 `resolve_inside`，任何 `.git` 成分一律拒；per-session workspace 400；回答 ≤ 64 KiB（`cap` 從最長的 list 截）。owner：workspace 沒有 owner，依 node 既有的 allowed users 檢查（請求的 user 由 gateway 給）。
- [x] gateway：registry、`/api/nodes`、`pick_node`、`workspace_read` 工具。（2026-10-21）`ConnectedNode` 存 `capabilities`、`running`；`/api/nodes` 回 `capabilities`、`load {running, max}`（不再有 `role`）。`brain/hands.rs`：`choose(reference, Hint{node, gpu})`：指名 id 直接用；同名多個用 hint 挑；沒指名或 `scratch` → 各機器的 scratch workspace 中挑：`node_hint` 比 node id 或 OS（mac/linux…）、要 GPU 看 `sandbox.gpu`，再依「在線且閒 > 在線 > 其他」；都不合 → 錯誤「No machine fits …; say so in the room」（由頭腦在房間說，不另寫 line）。`call_worker` 加 `node_hint`、`gpu`。`workspace_read`（在 `worker_tools.rs`，wake 也可用）：只限 delegate target 且 `workdir: workspace` 的 workspace、node 在線；結果的 origin 是 `tool:workspace:<workspace>`（`entry_origin` 特例）。prompt 的 `workers` 段落列出機器（OS、GPU、跑幾個 / 上限）。跟計畫不同：「只對 linked workspaces」——project links 已隨 chat projects 退場、房間沒有 project，第 10 份前就是所有 repository workspace。
- [x] scratch：預設檔、目錄、保留期、00 的 `session_root`。（2026-10-21）使用者 2026-10-21 定：升格。`pirc-config/src/modes/scratch.md`（= `mode::default_scratch()`：`workdir: per-session`、`repository: false`、`delegate_target: true`、`project_config`/`workspace_memory`/`recap` false）進 `DEFAULT_MODE_FILES`（`--print-defaults` 已有，會印出來）；既有 modes 目錄不自動補（upgrades.md 說明）。node 未設 `PIRC_MODES` 時接受 `directory,scratch`，並自帶 workspace `scratch` 在 `$PIRC_STATE_DIR/scratch`（`workspace_mode` 認得這個位置；session 目錄 `scratch/sessions/<session>/`，即 `session_root`）。保留期 `PIRC_SCRATCH_RETENTION_DAYS`（預設 7，0 保留）：`scratch.rs` 每小時看一次，整個目錄樹最後修改超過期限、且 agent 沒在跑的 session 目錄刪除。跟計畫不同：清之前**沒有**房間 line（node 不知道房間；清的只是做完回報過的暫存）。
- [x] `policy/session.rs`：`read_only` task policy → 唯讀 path policy + 無網路寫；`runner/process.rs` 接收（06 的 `task_context`/`read_only`）。（2026-10-21）使用者 2026-10-21 定：task policy。`SessionPolicyInput.read_only`：只寫自己的 session 目錄、temp、build cache（不寫 workspace、`allowedPaths`、設定的 `allowWrite`、workspace memory ledger）。node：delivery 帶 `approvalMode: "read-only"` 時記 `sessions.read_only = 1`（node schema 2002），之後一律唯讀；已在跑的可寫 runner 先停掉再以唯讀沙箱起。唯讀 session 的 `sandbox_allow_domains`/`unsandboxed_bash` 在 node 直接拒。跟計畫不同：不經 `runner/process.rs` 參數，跟 06 一樣隨 delivery。
- [x] `policy/session.rs`：拿掉 chat 專用假設（從 [00](00-demolition.md) 移來）：`SessionPolicyInput.protected_paths`（原本保護專案 instructions，現在所有 caller 都傳空；連帶 `pirc-node` `sandbox/{mod,common,macos}.rs` 的同名欄位）、`config_dir` 下 `SOUL.md`/`CHAT.md` 的寫入保護（02 把 SOUL/CHAT 移到 gateway 後才拿，在那之前留著無害）、`workspace_root`/`workspace_memory_file` 註解裡的 chat session、以及 `lets_a_chat_session_work_in_its_directory_inside_the_nodes_state`、`never_lets_a_chat_session_touch_its_projects_instructions` 等 chat 測試與 `Layout.chat`。（2026-10-21）`protected_paths` 改成 `read_only`（policy 與 node 的 `PrepareInput`、macos 的 literal roots）；SOUL/CHAT 的 symlink 目標保護與 `prompt_write_paths` 刪除（config 目錄本身仍唯讀）；chat 測試改成 per-session（scratch）版本，`Layout.chat` → `Layout.scratch`；`sandbox_native`/`sandbox_macos` 測試的保護路徑改由 agent config 的 `denyWrite` 提供（同樣的保證）。
- [x] Web 引擎蓋：node 卡片顯示能力與 load。（2026-10-21）Settings → Nodes 每台一行 `describeNode`：「linux x86_64 · 2× nvidia (not in the sandbox) · 1 of 4 running」。
- [x] conformance：`node_link` 加能力註冊與 load 更新；`node_workspaces` 加 `WorkspaceRead` 的 confined 讀取與越界拒絕；`modes` 改寫；scratch delegation scenario 沿用。（2026-10-21）`node_link`：帶能力註冊、`/api/nodes` 的 `capabilities`/`load`、activity 後 `running: 1`。新 `node_workspaces_read`：真 node 註冊（scratch + 能力）、list/read/grep、越界 403、`.git` 403、壞 pattern、未知 op、scratch 不可讀、scratch session 的目錄在 `node-state/scratch/sessions/`。`brain_workers`：沒指名 workspace + `node_hint: linux` → `work:scratch`；`gpu: true` → 「No machine fits」。`modes` 不用改（它設了 `PIRC_MODES`）；其他快照只因協定 15（拿掉 `role`、`/api/nodes` 的 `capabilities`/`load`）、node 預設多 scratch workspace、頭腦多 `workspace_read` 而變。

## 驗證

- conformance `node_link`、`node_workspaces`、`modes`、`agent_sandbox`（read-only policy）。
- 手動：兩台 node（mac + linux），「在 mac 上看一下 pirc 的 README」→ 頭腦用 `workspace_read` 不起 worker；「跑 tests」→ 挑閒的。

### 驗證結果（2026-10-21）

- `cargo test -p pirc-agent -p pirc-gateway -p pirc-config -p pirc-protocol -p pirc-policy` 全過（340 / 144 / 39 / 34 / 29）；`cargo test -p pirc-node` lib 306 過，只有照舊的 2 個 `sandbox::linux::plan` host socket 測試在這台沙箱失敗；node 整合測試除 `browser_*`（這裡沒有瀏覽器）全過，`sandbox_native`（bwrap 在）與改過的 `sandbox_linux_agent` 也過。
- conformance（release build）全部通過，除 `node_browser*`（沒有瀏覽器，快照未動）。
- web：`bunx vitest run` 46 檔 328 個全過；svelte-check 0 錯；prettier、`cargo fmt --check`、`cargo clippy --workspace --all-targets` 乾淨；release gateway 16,655,824 bytes（上限 16,777,216，剩約 120 KB）。
- 手動（兩台 node：「在 mac 上看一下 pirc 的 README」用 `workspace_read`、「跑 tests」挑閒的）尚未做；這台只有一個 Linux node。

## 文件

- `docs/guides/modes.md` 重寫；`docs/deploy/node.md` 加能力與 scratch 設定；`docs/development/gateway-and-node.md` 協定段。
- 已寫（2026-10-21）：上面三份（modes.md：協定 15、scratch 是預設檔、mode 不管授權、research profile 是 task policy）；`docs/deploy/upgrades.md`（協定 15、node schema 2002、scratch.md 要自己加）；`docs/guides/rooms-and-memory.md`（紅線在房間、scratch、頭腦自己讀 repository）；`docs/architecture/prompt-context.md`（新工具、`workers` 段落的機器與待答問題）。

## 實作前待決

- ~~research profile：mode 檔 vs task policy~~ 使用者 2026-10-21 定：task policy（b）。
- ~~`scratch.md` 升格預設檔~~ 使用者 2026-10-21 定：升格（翻 2026-10-19 決定 2）。
- ~~GPU 偵測要多準~~ 使用者 2026-10-21 定：第一版只要 vendor + count。
