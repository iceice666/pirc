# 重寫盤點：留、改、重寫、刪

[重寫](README.md) · [方向文件](../../docs/architecture/direction.md)

對照 [direction.md](../../docs/architecture/direction.md)，逐檔盤點 2026-10-20 的 codebase。目的是拆 plan 時知道每個東西的去向；本文件不授權任何刪除或實作。

**分類**：

- **留（KEEP）**：原則不變，程式碼不動或只改匯入。
- **改（ADAPT）**：機制保留，形狀 / API 要改；備註寫改什麼。
- **重寫（REWRITE）**：概念還在，但程式碼長在退場的物件（chat / project / session / schedule / proposal）上，重建比改便宜。
- **刪（DELETE）**：概念被 direction 退場；括號是依據的章節。
- **缺（NEW）**：今天沒有、方向需要的東西；標出可當種子的現有程式碼。

「刪」指退場實作，**不是**刪使用者的狀態；遷移（direction §6.14）另開 plan。

## 0. 結論

這不是重寫整個專案，是重寫「產品物件層」。基礎設施（沙箱、瀏覽器引擎、provider、auth、push、node link、OM、worker runner）佔程式碼大宗且 direction §5 說不變；要砍掉重來的是 chat / project / session / schedule / proposal 這層，以及所有圍繞它們的 UI。

| 區域                             | 行數 | 留   | 改    | 重寫  | 刪    |
| -------------------------------- | ---- | ---- | ----- | ----- | ----- |
| `crates/pirc-node`               | 50K  | ~75% | ~23%  | —     | ~2%   |
| `crates/pirc-agent`              | 58K  | ~57% | ~35%  | ~4%   | ~2%   |
| `crates/pirc-gateway`            | 27K  | ~22% | ~45%  | ~29%  | ~4%   |
| `crates/pirc-providers`          | 14K  | 100% | —     | —     | —     |
| protocol / policy / config / ptc | 9K   | 大多 | 少量  | —     | 少量  |
| `apps/web`                       | 25K  | ~25% | ~30%  | ~32%  | ~14%  |
| `apps/android`                   | 165K | ~70% | 見 §6 | 見 §6 | 見 §6 |

兩個最大的技術風險：

1. **`pirc-agent` 的 loop 是 `!Send`**（`Rc`/`RefCell`/`spawn_local`）。gateway 要開專用 `LocalSet` thread 跑頭腦。第一個 plan 應先 spike 這件事。
2. **auto mode 沒有「往外送」類別**：`git push` 是 `Write`、`gh pr create` 是 `Unknown`。第二條紅線（§2.5）要新增分類。

## 1. `crates/pirc-gateway`（27.1K）

| 檔案（行）                                                            | 分類 | 備註                                                                                                                           |
| --------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| `auth.rs` (565)                                                       | 留   | forward auth / device token；威脅模型不變（§5）                                                                                |
| `backends.rs` (330)                                                   | 留   | model backend CRUD / OAuth routes；頭腦共用                                                                                    |
| `devices.rs` (426)                                                    | 留   | 配對、hash token、撤銷                                                                                                         |
| `management.rs` (1145)                                                | 留   | native management grant；connector 憑證可沿用這個模式（§6.6）                                                                  |
| `web_search.rs` (657)                                                 | 留   | 已是 gateway 側唯讀 connector；直接給頭腦，結果帶 `tool:web_search`                                                            |
| `error.rs` `http.rs` `log.rs` `ws.rs` `util.rs` `slots.rs`            | 留   | 通用基礎                                                                                                                       |
| `memory/schema.rs` (109) `memory/text.rs` (263)                       | 留   | JSON 驗證器與文字 squash/fold/hash，新 store 可用                                                                              |
| `schedules/cron.rs` (1681)                                            | 留   | `Cron`/`Pattern`/`Zone`/DST。**週期性 open loop（每週三 18:00 開會）需要它**；舊錯誤字串相容不必保                             |
| `app.rs` (619) `main.rs` (192)                                        | 改   | 加頭腦 host、connector poller、wake scheduler 的啟停；拿掉「gateway never runs agents」註解                                    |
| `db.rs` (1996)                                                        | 改   | SQLite 安全與 worker 索引留；拿 chat/assistant-node capability 模型；加 room/brain repositories                                |
| `delegations.rs` (2217)                                               | 改   | dispatch / retry / deliver / `answer_relayed` / `report` 留；`assistant_session_id` → room/face/thread；拿 pending-card 狀態   |
| `dispatch.rs` (473)                                                   | 改   | worker 啟動與 redaction 留；wake 不得建 node session（§2.6）                                                                   |
| `events.rs` (402) `sockets.rs` (587)                                  | 改   | bounded replay 留；加 room/thread 事件流，與 worker runner epoch 脫鉤                                                          |
| `features.rs` (215) `hints.rs` (91)                                   | 改   | schedule/proposal hook → room 服務；hint 改成 room/face/open-loop/source                                                       |
| `agent_ops.rs` (148)                                                  | 改   | allowlist 機制留；拆 worker ops 與頭腦直接工具                                                                                 |
| `memory_records.rs` (747+672)                                         | 改   | repo ledger 鏡像/搜尋留；加 person scope；現在是 `LIKE`，接 [memory-search](../memory-search.md) 的 FTS5                       |
| `node_events.rs` (269) `nodes.rs` (1245)                              | 改   | link/auth/inference/stream 留；拿 chat-node singleton；加能力宣告、presence、`workspace.read`                                  |
| `project_links.rs` (421)                                              | 改   | links 留；owner 從 chat workspace 改成 face 地盤（§2.8）                                                                       |
| `push.rs` (1822)                                                      | 改   | 加密/VAPID/訂閱留；`PushMessage` 與 deep link 指向 room，worker 推播去重                                                       |
| `memory/routes.rs` (222)                                              | 改   | view/history/restore/forget 留；拿 approve/reject                                                                              |
| `routes.rs` (1817)                                                    | 重寫 | REST 表是 chats/projects/sessions/leases；重建 rooms/faces/messages/threads。session/panel/git/files/terminal relay 搬到引擎蓋 |
| `memory.rs` (104) `memory/ops.rs` (365) `memory/store.rs` (1333+1060) | 重寫 | 兩種 prompt-budget kind + project cascade → 三層記憶。revision / origin / redaction / tombstone 語意留                         |
| `schedules/mod.rs` (1773+881) `timer.rs` (293) `fields.rs` (127)      | 重寫 | 每 run 開新 session + proposal → 同 thread 的 wake、配額、唯讀。`timer.rs` 的 earliest-deadline 是種子；週期性 wake 走 cron    |
| `schema.sql` (186)                                                    | 重寫 | 見 §5                                                                                                                          |
| `memory/interactions.rs` (232)                                        | 刪   | proposal 卡片（§2.4、§2.5）                                                                                                    |
| `project_deletion.rs` (346)                                           | 刪   | 專案刪除連帶遺忘；房間封存不遺忘（§2.2、§2.4）                                                                                 |
| `schedules/api.rs` (199) `schedules/ops.rs` (251)                     | 刪   | 使用者管理的 schedule 物件與 proposal（§2.3、§5）                                                                              |

## 2. `crates/pirc-protocol`、`pirc-policy`、`pirc-config`、`pirc-ptc`

| 檔案（行）                                                     | 分類 | 備註                                                                                                                    |
| -------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------- |
| `protocol/inference.rs` `models.rs` `repo.rs` `socket_path.rs` | 留   | worker inference wire、secret-free catalog、repo 正規化                                                                 |
| `protocol/lib.rs` (124)                                        | 改   | `valid_agent_op` 拿 schedule/proposal ops；匯出 room/worker/capability 型別                                             |
| `protocol/link.rs` (347)                                       | 改   | 拿 `NodeRole::Chat`；`Registration` 加 OS/arch/GPU/browser/terminal/sandbox/閒忙；加 `workspace.read` RPC               |
| `protocol/mode.rs` (570)                                       | 改   | mode 留作 worker 執行 profile；拿 `default_chat`、Chat/Work UI 語意、assistant 記憶存取、schedule scope；加研究 profile |
| `policy/lib.rs` (615)                                          | 留   | `PathPolicy`/`PathGuard`                                                                                                |
| `policy/session.rs` (1981)                                     | 改   | 拿 chat 假設；研究 worker 要真正唯讀。頭腦不需要 policy                                                                 |
| `config/env_allowlist.rs` `frontmatter*`                       | 留   |                                                                                                                         |
| `config/lib.rs` (611)                                          | 改   | `GatewayConfig` 加頭腦身份、connectors、person memory、wake 配額                                                        |
| `config/node.rs` (754)                                         | 改   | 拿 `role`/`chat()`/`CHAT_WORKSPACE_ID`；加能力、scratch 設定；browser 設定加研究 policy                                 |
| `config/modes.rs` (488) `modes/directory.md`                   | 改   | 拿 chat-role 過渡邏輯；directory mode 拿 `assistant: user` 與 schedule scope                                            |
| `config/modes/chat.md` (29)                                    | 刪   | §2.1、§3.2。不要改名成「頭腦 mode」                                                                                     |
| `pirc-ptc/*` (1961)                                            | 留   | worker 執行機制；**不是**頭腦的 shell/fs 出口                                                                           |

## 3. `crates/pirc-node`（49.9K）

| 檔案（行）                                                                                                                                                                                        | 分類 | 備註                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox/**` (~13.5K)                                                                                                                                                                             | 留   | 全部。能力宣告只回報沙箱狀態，不改邊界                                                                                                       |
| `browser/engine/**` (~8.3K) `browser/assets/*`                                                                                                                                                    | 留   | CDP / page / input / locator / screenshot / screencast                                                                                       |
| `browser/manager/{input,view,seam}.rs` `recording.rs`                                                                                                                                             | 留   | 人的接管、viewer、錄影（研究模式能否下載 / 錄影是 §6.8）                                                                                     |
| `terminals*` `streams.rs` `write_broker.rs` `inference*` `events.rs` `router.rs` `error.rs` `models.rs` `node.rs` `private_dir.rs` `repo.rs` `branch_cache.rs` `runner/{framing,host,reducer}.rs` | 留   | 引擎蓋基礎；`runner/host.rs` 是 `unsandboxed_bash` 紅線路徑                                                                                  |
| `memory_mirror.rs` (360+283)                                                                                                                                                                      | 留   | **不是 chat 專用**：鏡像 repo 的 workspace memory ledger（§2.4、§2.7）                                                                       |
| `panels/inspect.rs` (892+809)                                                                                                                                                                     | 留   | realpath-confined 檔案讀 + 沙箱 git；**`workspace.read` 的最佳種子**                                                                         |
| `recap.rs` (532+426)                                                                                                                                                                              | 改   | 只對 directory workspace 跑；留作 repo 證據，不是人的記憶；delegation 排除規則隨新 worker 生命週期重看                                       |
| `app.rs` (1997)                                                                                                                                                                                   | 改   | worker session/command/upload/control/`deliver`/`relayed_answer` 留；拿 chat project/instructions/files/SOUL routes；加 `workspace.read`     |
| `agent_gateway.rs` (282)                                                                                                                                                                          | 改   | 請求關聯與 timeout 留；縮 worker 可用 ops                                                                                                    |
| `cli.rs` (119) `lib.rs` `main.rs` `services.rs`                                                                                                                                                   | 改   | 拿 `chat` 子命令與 chat 啟動假設；加能力盤點                                                                                                 |
| `link.rs` (896)                                                                                                                                                                                   | 改   | outbound WS / reconnect / backpressure 留；`registration` 加能力與閒忙                                                                       |
| `runner/mod.rs` (1178) `runner/process.rs` (1070) `runner/side.rs` (998)                                                                                                                          | 改   | 拿 chat prompt / project files / instruction 注入；加 scratch、頭腦交付的 task context、唯讀研究 policy；紅線問題 relay 進房間               |
| `panels/mod.rs` (678)                                                                                                                                                                             | 改   | 拿 `chat::session_root` 依賴                                                                                                                 |
| `browser/mod.rs` `manager/mod.rs` `manager/ops.rs` `hosts.rs` `util.rs`                                                                                                                           | 改   | **研究模式在 node 邊界強制**：非 localhost 的 click/type 與等價輸入路徑歸 action；`hosts.rs` 的 localhost/私網判斷可共用；拿 `chat::js_trim` |
| `store/mod.rs` (2305) `store/schema.sql`                                                                                                                                                          | 改   | 拿 `check_role` 與 chat 語意；表見 §5                                                                                                        |
| `chat.rs` (253)                                                                                                                                                                                   | 刪   | §2.1、§3.2。先抽出通用的 `session_root`/`js_trim`，scratch 不能依賴 chat                                                                     |
| `assistant_prompts.rs` (206)                                                                                                                                                                      | 刪   | SOUL/CHAT 搬到 gateway（§2.1、§5）                                                                                                           |
| `project_files.rs` (351)                                                                                                                                                                          | 刪   | chat project 儲存；room/face 檔案是新的 gateway 物件（§2.2、§2.8）                                                                           |

## 4. `crates/pirc-agent`（58.3K）與 `pirc-providers`（14K）

### 4.1 頭腦能不能在 gateway in-process 跑？

可以，但不是呼叫 `run_agent`：

- `agent.rs:48` `AgentOptions` 已可注入 tools / features / `Ui` / event emitter / store / `StreamFn`；`Agent::new` (:666) 接任意 tool 向量。
- loop 用 `Rc`/`RefCell`/`spawn_local` (:1867)：gateway 需要專用 `LocalSet` thread。
- `run.rs:239–360` 是 stdin/stdout adapter，頭腦繞過。
- `Agent::refresh_models` (:2213) 仍走 remote 機制，要給注入點；`stream_override` 欄位名該改。
- `Agent::new` (:673–777) 無條件建 `PathGuard`、shell hooks、PTC wrapper：頭腦要能不帶這些。
- `channels.rs:565+` 有 thread-local process channel；舊 gateway-channel feature 不能原樣在 gateway 內開。
- PTC guest 跑在 agent 沙箱裡；頭腦沒沙箱，所以頭腦只用 direct tools，或另設受限 runtime（§6.13）。

### 4.2 逐模組

| 模組（行）                                                                                                                         | 分類 | 備註                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.rs` `rpc*` `remote*` `channels*` `session_store.rs` `compaction.rs` `messages*` `signal.rs` `redact.rs` `skills*` `stream.rs` | 留   | worker 執行與傳輸；`session_store` 可當 room thread 的內部儲存                                                                                                                                                  |
| `tools/**` (~4.5K)                                                                                                                 | 留   | worker 的 bash/files/glob；頭腦另供自己的工具與描述                                                                                                                                                             |
| `ptc/**` (~5K)                                                                                                                     | 留   | worker 專用；`ptc/{mod,registry}.rs` 若頭腦要共用 capability metadata 則小改                                                                                                                                    |
| `hooks.rs` (552)                                                                                                                   | 留   | worker shell hooks；**頭腦永不設定**                                                                                                                                                                            |
| `features/{background,todo,goal,title,recap,compact,skills,role}`                                                                  | 留   | 全是 worker 側；direction 沒退場。`title` 對永遠在的房間要關掉；`goal`/`todo` 不是 open loop                                                                                                                    |
| `features/memory/{ledger,workspace,config,worker,panel,prompts,time}.rs`                                                           | 留   | OM 核心與 repo handoff                                                                                                                                                                                          |
| `features/sandbox.rs` (370)                                                                                                        | 留   | `unsandboxed_bash`、`sandbox_allow_domains` 就是兩條紅線的現有路徑                                                                                                                                              |
| `features/team/{channel,child}.rs`                                                                                                 | 留   |                                                                                                                                                                                                                 |
| `agent.rs` (3772) `lib.rs` `host.rs` `feature.rs` `context.rs` `ui.rs`                                                             | 改   | 見 4.1；`context.rs` 加偏好 / open loops / 自動撿取 / 面孔區塊與新鮮度；`feature.rs` 加 turn 級動態 context                                                                                                     |
| `config.rs` + `config/*` (2.7K)                                                                                                    | 改   | 拆 worker 檔案/trust 載入與頭腦身份設定；拿 chat-node SOUL/CHAT 分支                                                                                                                                            |
| `roles.rs` (751)                                                                                                                   | 改   | worker `AgentRole` 留；**面孔不是這個**                                                                                                                                                                         |
| `auto_mode/mod.rs` (810+1016)                                                                                                      | 改   | static deny 從「會問」改「直接拒」；只有兩條紅線 relay 進房間                                                                                                                                                   |
| `auto_mode/rules.rs` (3730+1053)                                                                                                   | 改   | **新增 outbound 類別**。現況：`git push` → `Write` (:1859)、force/delete → `Danger`；`gh pr create` → `Unknown` (:2628)；`gh api` 非 GET → `Danger`；`curl -d`/`wget --post` → `Unknown`；套件發布多為 `Danger` |
| `auto_mode/classifier.rs` (498+464)                                                                                                | 改   | 不能讓模型降級 outbound/deny                                                                                                                                                                                    |
| `features/memory/mod.rs` (1502) `agents.rs` (552) `serialize.rs` (348)                                                             | 改   | dropper 掉出 active pool 前先 promote 進 per-person store（§2.4）；origin 加 connector/room/worker                                                                                                              |
| `features/team/mod.rs` (1452+935) `broker.rs` (2715)                                                                               | 改   | 機制留；進度/訊息輸出成討論串事件，不是房間參與者（§2.7、§4）                                                                                                                                                   |
| `features/ask_question.rs` (755)                                                                                                   | 改   | worker 問題與紅線 relay 進房間；頭腦直接在房間問                                                                                                                                                                |
| `features/browser.rs` (989)                                                                                                        | 改   | 研究模式分類（§3.1）                                                                                                                                                                                            |
| `features/web_search.rs` (379)                                                                                                     | 改   | 頭腦直接呼叫 connector，不走 node proxy                                                                                                                                                                         |
| `features/mod.rs` (172)                                                                                                            | 改   | 單一 builtin list → 明確的 worker / 頭腦兩組                                                                                                                                                                    |
| `capabilities.rs` (84)                                                                                                             | 重寫 | chat 專案 capability switch → host/tool profile                                                                                                                                                                 |
| `features/assistant/mod.rs` (1746+420)                                                                                             | 重寫 | `delegate()`/status/search/remote recall 的服務留但改走 gateway 內部；`find_quote`/`find_recent_quote`/`current_origins` 是好種子；也凍結 USER 給 coding session，要改成明確 handoff                            |
| `features/project_instructions.rs` (176)                                                                                           | 重寫 | 凍結 → 下一 turn 熱更新（§2.2、§5）                                                                                                                                                                             |
| assistant 的 `Kind::Propose`、`memory_propose_user`、`propose()`、`frozen_snapshot`、`user_section`、`memory_section`              | 刪   | proposal 卡與凍結快照（§2.4、§5）                                                                                                                                                                               |
| `features/schedules.rs` (836)                                                                                                      | 刪   | schedule tool 與 `/cron`（§2.3、§2.6）。**週期性**需求由 open loop 的時間錨承接                                                                                                                                 |
| `pirc-providers/**` (14K)                                                                                                          | 留   | 全部；頭腦的 inference adapter 放在 hosting 邊界                                                                                                                                                                |

## 5. SQLite 表

**Gateway `schema.sql`**

| 表                                                                        | 分類 | 備註                                                                                                           |
| ------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------- |
| `commands` `leases` `device_tokens` `push_subscriptions` `memory_mirrors` | 留   |                                                                                                                |
| `workspaces` `sessions`                                                   | 改   | 降到引擎蓋；拿 chat/project surrogate；room 的未讀/活動另存                                                    |
| `session_deletions`                                                       | 改   | 拿 chat-memory cascade                                                                                         |
| `memory_entries` `memory_log` `memory_tombstones`                         | 改   | 種子給偏好/事實層；拿「全部進 prompt」的要求；origin 加 room/face/source                                       |
| `memory_records`                                                          | 改   | repo 事實留；person 事實不綁 `node_id`/`ledger_key`                                                            |
| `delegations`                                                             | 改   | 來源改 room/face/thread；拿 pending-card 欄位                                                                  |
| `project_links`                                                           | 改   | `project_workspace_id` → face                                                                                  |
| `workspace_capabilities`                                                  | 改   | 重新設計成 room 的 source policy，不是 node 能力                                                               |
| `schedules` `schedule_runs` `schedule_proposals`                          | 刪   | §2.3、§2.6、§5                                                                                                 |
| `memory_proposals`                                                        | 刪   | §2.4                                                                                                           |
| `workspace_deletions`                                                     | 刪   | §2.2                                                                                                           |
| `assistant_node`                                                          | 刪   | §2.1                                                                                                           |
| **新增**                                                                  | 缺   | rooms、room_messages、threads、open_loops（含週期時間錨）、faces、wakes、connector cursors、person facts scope |

**Node `store/schema.sql`**：`runs` `commands` `leases` `workspace_trust` 留；`workspaces` `sessions` `interactions` `uploads` `session_deletions` 改（拿 chat 語意；interaction 分紅線與普通問題）；`workspace_deletions` 刪。

## 6. Clients

### 6.1 `apps/web/src`（24.5K）

| 檔案（行）                                                                                                                                                                                                                                                       | 分類 | 備註                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------- |
| `panel/{Files,Git,Diff,Terminal*,Browser,Memory,Context,Tasks}` (~3.2K)                                                                                                                                                                                          | 留   | 引擎蓋                                                        |
| `BackendSettings` `ProviderEditor` `ProviderLogin` `PairedDevices` `Markdown` `DockSection` `dialogs/{Modal,NativeManagementConsent,NewWorkspaceDialog}`                                                                                                         | 留   |                                                               |
| `lib/{a11y,http,errors,id,markdown,file-links,time,motion,viewport,devices,native-management,pwa,loader,watch,todo,goal,panel-api,panel-state}`                                                                                                                  | 留   |                                                               |
| `Message.svelte` (805)                                                                                                                                                                                                                                           | 改   | Discord 列：頭像/名字/時間；訊息契約加 face                   |
| `Composer*` (840)                                                                                                                                                                                                                                                | 改   | `@面孔`、一句話回答；拿 control/approval 依賴                 |
| `ToolCard` `RunCard` `TodoDock` `GoalDock` `JobsMenu` `MobileTabs`                                                                                                                                                                                               | 改   | 引擎蓋/討論串裡用；房間裡是可展開小字與原地更新的進度訊息     |
| `panel/SidePanel` (420) `dialogs/SettingsDialog` (345)                                                                                                                                                                                                           | 改   | 升格成引擎蓋頁；設定拿 schedules / proposals / assistant-node |
| `AssistantSettings` `AssistantPromptEditor` `NotificationSettings`                                                                                                                                                                                               | 改   | SOUL/CHAT 進主持人的面孔頁；通知指向 room                     |
| `lib/{pi-messages,memory,assistant-prompts,push,storage}.ts`                                                                                                                                                                                                     | 改   |                                                               |
| `App.svelte` (1223) `Sidebar.svelte` (1423) `WorkspacePage.svelte` (868)                                                                                                                                                                                         | 重寫 | 以 session 為第一級物件                                       |
| `lib/{app.svelte,state,api,types,work,capabilities,chats,modes,mock}.ts` (~4.2K)                                                                                                                                                                                 | 重寫 |                                                               |
| `MemorySettings.svelte` (400)                                                                                                                                                                                                                                    | 重寫 | 拿 proposal；forget/history 進新的記憶 / 面孔頁               |
| `ScheduleSettings` `SchedulesPage` `InteractionCard` `ApprovalModeControl` `DelegationStrip` `Project{Settings,Instructions,Files,Links,Trust}` `dialogs/{NewSession,NewProject,DeleteChat,DeleteProject}` `lib/{control,schedules,project-deletion}.ts` (~3.5K) | 刪   | §2.5、§4、§5                                                  |

API 面（`api.ts`）：providers / provider-auth / devices 留；`/api/nodes` 加能力；`/api/sessions*`、control lease、`PATCH` rename/pin/settle、`/api/events?sessionId=` 的事件詞彙都是舊模型，room/face/thread/presence 的 API 要新建；`/api/delegations/:id/stop`、uploads、interactions answer 改形狀。

### 6.2 `apps/android`（Dart 140K + Kotlin 25K + 測試 171K）

| 範圍（行）                                                                                                                                                                                                | 分類 | 備註                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/rendering/` (155 檔, 87K)                                                                                                                                                                            | 留   | **產品核心**：native markdown / math / HTML-CSS / canvas / Mermaid。`document_navigation.dart` 在正式路徑建 `NativeHtmlDocument`，不是工具 |
| `lib/live/` document 子集 (23 檔, 12.7K)                                                                                                                                                                  | 留   | `app_document_route.dart` 的 session/schedule/memory 目標要改                                                                              |
| `live/*_pane.dart` `*_state.dart` `side_panel` `jobs_menu`                                                                                                                                                | 留   | 引擎蓋                                                                                                                                     |
| `live/{backend_settings,provider_editor,provider_login}` 與配對/grant                                                                                                                                     | 留   |                                                                                                                                            |
| Kotlin `NativeDocument*` `NativeCanvas*` image/media/scan/picker/permission `MainActivity` `push/`                                                                                                        | 留   | 平台 plumbing                                                                                                                              |
| `live/{conversation_timeline,timeline_models,timeline_tools,conversation_composer,composer_dock}` (3.1K)                                                                                                  | 改   | Discord 列、面孔、房間問題、進度、討論串入口                                                                                               |
| `live/{memory_settings,assistant_settings,settings,settings_dialog,notification_settings}` (3.4K)                                                                                                         | 改   |                                                                                                                                            |
| Kotlin `GatewayNotifications` `QuickReplyService` `QuestionNotificationIdentity` `GatewayOverlayService`                                                                                                  | 改   | 路由到 room；拿卡片假設                                                                                                                    |
| `live/{app,gateway,scoped_gateway,session_sidebar,session_row,conversation_header,mobile_tabs}` (6.3K)                                                                                                    | 重寫 |                                                                                                                                            |
| `live/{workspace_page,workspace_settings,workspace_project_files,workspace_project_links}` (2.7K)                                                                                                         | 重寫 | 專案設定 → 面孔頁                                                                                                                          |
| Kotlin `GatewayBridge` (1545) `GatewayRuntime` (1276) `PircApi` `Models` `Work` `SessionGroups` `core/timeline`                                                                                           | 重寫 | 傳輸可重用，domain 重寫                                                                                                                    |
| `live/{schedules_page,schedules_state,attention,attention_card,interaction,interaction_card,approval_mode_control,delegations_strip,project_deletion_dialog}` (~5.5K)；Kotlin `Schedules.kt` `Control.kt` | 刪   | §2.3、§2.5、§4                                                                                                                             |

曝險：Dart 約 25–30%（非 document 的 `live/` 約 39K）、Kotlin 約 1/3–2/5。測試：rendering/platform 測試留；navigation/approval/schedule 契約測試重寫；加 room/face/thread parity。

## 7. 其他

| 項目                                                                                                                                                                                                                              | 分類    | 備註                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `crates/pirc-conformance/src/*`（harness）                                                                                                                                                                                        | 留      |                                                                                                                               |
| conformance tests：`node_chat.rs` (1068) `schedules.rs` (1094) `project_deletion.rs` (395) `agent_assistant*.rs` (853)、`memory.rs` 的 proposal 部分、`delegations.rs` 的卡片部分、`agent_gateway_tools*` 的 schedule/propose ops | 刪/重寫 | 跟著物件退場；其餘 ~80 個 test 檔與 217 份 snapshot 留                                                                        |
| `fixtures/timeline/*.json`                                                                                                                                                                                                        | 重寫    | snapshot/events 契約改變                                                                                                      |
| `fixtures/mobile-parity/*`                                                                                                                                                                                                        | 留      | 大多是 rendering；`assistant-settings` `attention` `conversation-interaction-screen` 等跟著 UI 重做                           |
| `scripts/approval-stats.ts` + test                                                                                                                                                                                                | 刪      | 只服務 delegation-autonomy phase 3，被 §2.5 取代                                                                              |
| `scripts/{version,conformance,model-catalog,browser-assets,binary-size,package-release,release-*}`                                                                                                                                | 留      |                                                                                                                               |
| `nix/module.nix`                                                                                                                                                                                                                  | 改      | 拿 `services.pirc.chat`、chat assertion、`chatPackage` 殘留；`soulPrompt`/`chatPrompt` 改成 gateway 設定；`timeZone` 留給頭腦 |
| `docs/architecture/direction.md`                                                                                                                                                                                                  | 留      |                                                                                                                               |
| `docs/architecture/{security-decisions,observational-memory,backend-auth,native-management,ptc}.md`                                                                                                                               | 改      | security：Nothing writes unasked + residual risk；OM：加 per-person promotion                                                 |
| `docs/deploy/*`                                                                                                                                                                                                                   | 改      | 拿 chat node；加 connector 憑證、wake 配額設定                                                                                |
| `docs/guides/{agent,tools,browser,modes,model-backends}.md`                                                                                                                                                                       | 改      |                                                                                                                               |
| `docs/development/gateway-and-node.md`、`docs/architecture/{assistant-memory,prompt-context}.md`                                                                                                                                  | 重寫    | 全是舊模型契約                                                                                                                |
| `docs/guides/{chat-projects,schedules,session-ui}.md`                                                                                                                                                                             | 刪      | 由新 guide（rooms / faces / open loops）取代                                                                                  |
| `plans/README.md`                                                                                                                                                                                                                 | 重寫    | 工作隊列要重排                                                                                                                |
| `plans/delegation-autonomy.md`                                                                                                                                                                                                    | 刪      | phase 0–2 已做；phase 3 被 §2.5 取代                                                                                          |
| `plans/modes.md`                                                                                                                                                                                                                  | 改      | Chat/Work tabs 部分被 §4 取代；scratch workspace 部分保留（§3.2）                                                             |
| `plans/mobile.md`                                                                                                                                                                                                                 | 重寫    | 驗收項目跟著 UI 重做                                                                                                          |
| `plans/{memory-search,sandbox-gpu}.md`                                                                                                                                                                                            | 留      | 事實層檢索與 GPU 能力正好接上                                                                                                 |

## 8. 缺口（NEW）

| 需要                                 | 種子 / 缺什麼                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway 頭腦 host                    | `AgentOptions`、`StreamFn`、`Ui`、callback events；缺 LocalSet thread、頭腦 tool profile、直接 inference/catalog adapter、資源限制（§6.13） |
| Rooms / 永久 thread store            | `SessionStore`、`EventHub`；缺 `#general`、訊息持久化、封存、未讀/等你回話、釘選、搬家連結                                                  |
| 身份 / 角色 / context 熱組裝         | assistant prompt routes 現在 relay 到 chat node；gateway 要自己擁有 SOUL/CHAT/偏好，room/face instructions 下一 turn 生效                   |
| Open loops                           | 無對應；`todo` 是 run 進度、`goal` 是 worker 續跑、schedule 退場。要 store、tool、prompt 投影、溢出降級、**週期時間錨（用 cron.rs）**       |
| Per-person 事實 store + OM promotion | `memory_entries`、`memory_records`、workspace promoter；缺 person scope、dropper 落地、room/face 標籤                                       |
| 每 turn 自動撿取「你可能記得」       | `memory_records::search_in` 是 `LIKE` 的顯式工具；缺用訊息 + open loops 查詢、排序、top-N 注入                                              |
| Connector 框架                       | `web_search.rs`、management grant；缺 email/calendar、source scope、polling cursor、origin-tagged 變化事件                                  |
| Self-wake scheduler                  | `schedules/timer.rs`；缺時間錨/來源事件/一次性三種觸發、同 thread turn、每日/並發/cadence 配額、無聲回合稽核                                |
| Faces / presence                     | project instructions/links、`LiveActivity`；缺 face id、頭像/顏色、`@` 解析、每則訊息的 speaker                                             |
| Node 能力登記 + 挑手                 | `Registration`、`NodeRegistry`；缺硬體/browser/sandbox/閒忙宣告與任務導向挑選                                                               |
| `workspace.read`                     | `panels/inspect.rs` + `router.rs` owner check；缺頭腦側的 connector 契約、不起 runner、不露 canonical path                                  |
| 討論串模型                           | delegation status、panel team 資料；缺每次交辦一個 thread id、工人名字/presence、插話、巢狀縮排                                             |
| 紅線 relay / 事後可見                | `answer_relayed`、`deliver`、push；缺房間內的紅線問題、面孔署名的結果訊息、Stop、一句話撤銷                                                 |
| 研究模式邊界                         | worker sandbox/mode；缺 browser 非 localhost action 分類與 self-wake 全程唯讀                                                               |
| Auto mode outbound 類別              | `rules.rs` 的 git/gh/curl/wget/套件發布規則是種子；缺統一的「往外送」分類（§6.1）                                                           |

## 9. 已決與待決

direction §6 的 14 項與週期性 open loop 都已於 2026-10-20 決定，見 [decisions.md](decisions.md)。對盤點直接有影響的：

- 週期性 open loop 用常駐 loop + recurrence → `schedules/cron.rs` 留。
- person 事實層放同一張 `memory_records` 加 `scope` → `memory_records.rs` 是改不是重寫。
- 遷移完全從零 → 不需要 migration plan；舊 DB 原地不動。

仍待決：頭腦用 direct tools 還是受限 script runtime；`title.rs` 對房間關閉的方式。
