# 06 工人：頭腦叫工人、討論串、回報

[重寫](README.md) · [direction §2.7 / §4](../../docs/architecture/direction.md) · [決定](decisions.md) · [existing-plans §1](existing-plans.md)

**目標**：頭腦可以自己叫工人（今天的 coding session + delegation 機制），不出卡片；交辦訊息下掛一個討論串，工人的進度、team 內的對話、紅線問題都在討論串；結果回到房間由面孔說。工人沒有人的記憶，只拿頭腦交付的脈絡。

**依賴**：02、03、04；紅線 relay 依賴 07；挑手依賴 08（08 之前只能指定 workspace）。**被依賴**：10、11。

## 決定（已定）

- 叫工人不問（§2.7）；並發上限沿用 4（#10）。
- 工人可再叫 team/subagents，深度 1；只有最上層回報；討論串縮排（#10）。
- 工人拿的脈絡：任務、相關事實、相關 loops、quote 過的你的原話（verified quote 機制沿用 `find_recent_quote`）、repo workspace memory（§2.7）。
- 工人回報進頭腦的記憶帶 `tool:delegation`（§2.7）。

## 設計

**工具（頭腦）**：`call_worker {task, workspace?: "<node>:<ws>" | "scratch", node_hint?, read_only?, context?: {fact_ids, loop_ids, quote_entry_ids}}`、`worker_status {id?}`、`stop_worker {id}`。wake profile（05）只給 `read_only: true` 的變體。

**Gateway `delegations.rs`（改）**：

- `assistant_session_id` → `room_id`、`face_id`、`thread_id`、`anchor_message_id`。
- `create` 直接 `start_task`（沒有 pending 狀態）；超過 4 個 → 排隊（不是卡片），房間 line「排隊中（3 個在跑）」。
- 任務訊息沿用 `deliver`：以助理身分推進 session，`details.userRequests` 只放 verified quotes；`context` 的事實與 loops 以 `## 交辦脈絡` 段附上，標明 origin。
- `report` → 寫 `room_messages`（面孔說）+ 討論串結尾 line；頭腦下一個 turn 收到 `custom` 訊息（沿用 `assistant-delegation-update` 路徑）並可 `remember` 帶 `tool:delegation`。
- node 離線 → retry 語意沿用；房間 line「mac 不在線，等它回來」。

**討論串**（01 建的 `threads` 表）：

- `call_worker` 時寫一則交辦訊息（面孔說「我讓工人去 X」，`kind='text'`）並建 thread，`anchor_message_id` 指向它。
- 工人的事件（`run_started`、tool 摘要、team 的 `agent_spawn`/`agent_send`/`board_post`、`ask_question`、`run_finished`）經 gateway 的 `node_events.rs` 映射成 `thread_messages(thread_id, speaker 'worker:<session>'|'worker:<session>/<child>', kind, body, depth)`；team 子代 `depth=1`。
- 討論串有自己的事件流 `thread_message`；房間只顯示 anchor 的「進行中（3 人）」摘要（`room_message_updated`）與最後結論。
- 你在討論串插話 → 走今天的 `follow_up` 命令到該 session（不需 lease：gateway 以 owner 身分，沿用 relayed-answer 的例外模式）。
- 工人的 `ask_question`（非紅線）→ 討論串 `question` + 房間 line「工人在問：…（去討論串回）」；紅線 → 07 的房間 `question`。

**Worker 側（改）**：

- `runner/process.rs`：啟動參數加 `task_context`（JSON）與 `read_only`；不再注入 chat prompt。
- `features/team/*`：事件輸出加 `thread` 欄位；`broker.rs` 的 board 事件也映射。
- `features/assistant/mod.rs` 剩餘的 `delegate()` 等 → 刪除，worker 沒有 delegate 工具（深度 1 靠 team）。

**Presence**：面孔的「正在做（附一行）」= 它有跑中的 worker；由 `delegations` 狀態推導（10 顯示）。（2026-10-21：`GET /api/workers?status=active&room=` 給得出來，10 接上。）

## 工作項目

- [x] `delegations.rs` 改表與狀態機；佇列；`report` → 房間。（2026-10-21）pirc.sqlite schema 6（`migrations/6-workers.sql`）：`assistant_session_id` 改名 `room_id`（舊列原地保留），加 `face_id`、`thread_id`、`anchor_message_id`、`read_only`、`context_json`、`wake_id`、`note`（排隊原因 `busy` / `offline`）。狀態 `queued → running ⇄ waiting_input → completed | failed`：`call` 一律先記 `queued`，`pump` 在 4 個（其中 wake 叫的最多 2 個，接上 05 的「同時 2 個唯讀研究」）以內、node 在線時直接 `start_task`；等的原因在房間各說一次（「… waits its turn (4 running)」、「work is offline; the worker … starts when it is back」），node 回來（`node_online`）或有工人結束就再 pump；跑到一半 node 離線，房間 line「… waits for it to come back」，沿用重讀。`report` → 房間一則 host 的 `text`（`body.worker.report`，≤ 2000 字元，多的在討論串）+ 討論串結尾 line + push（room deep link）；頭腦在那個房間的下一個 user turn 收到 `worker-report` custom 訊息（`notified_status` 記已告知）。舊的 chat relay（`pending_interactions`、`delegations_changed`、session snapshot 的 `delegations`、Needs you 的 relayed approval）與 agent op `delegation.*` 刪除；Stop 沿用 `POST /api/delegations/:id/stop`（queued 的直接結束）。
- [x] `call_worker` / `worker_status` / `stop_worker` 工具與 prompt；context 打包（03/04 的 ids → 文字）。（2026-10-21）`brain/worker_tools.rs`；prompt 段落 `workers`（工作區清單含在線與 roles、還沒結束的工人）。`context: {fact_ids, loop_ids}` 打包成「- [id] (fact, from origin) …」放進任務的 `## Context from the assistant`，原樣存 `context_json`。跟計畫不同：quote 收**原話字串**（不收 `quote_entry_ids`），用 03 的 `quoted`（最近 3 則、說話者辨識）驗證，順便決定工人為誰工作；`node_hint` 等 08；`workspace: "scratch"` 先回錯（08 才有）。wake 叫的強制 `read_only`、不能帶 quote、不能 follow 可寫的工人；`stop_worker` 加進 `NOT_IN_WAKES`。頭腦從工人回報或 `worker_status` 記下的事實 origin 一律 `tool:delegation`（`brain/memory.rs`）。`call_worker` / `stop_worker` 的結果不算來源。
- [x] threads：`thread_messages` 表、`node_events.rs` 映射、事件流、API `GET /api/threads/:id`、插話 `POST /api/threads/:id/messages`。（2026-10-21）`threads.rs`；映射在 `delegations.rs` 的事件訂閱（不在 `node_events.rs`）：`tool_execution_start`（`ptc` 本身略過，它的 operation 一個個來）→ `tool` `{tool, summary}`；助手文字 → `text`；`team_event` → `worker:<session>/<name>`、`depth 1`；開始 / 結束 → `line`。一個討論串最多 2000 則，超過只停記 `tool`。事件走房間的 stream：`thread_message` / `thread_message_updated` `{threadId, message}`。另有 `GET /api/workers`。插話：跑中的 → `follow_up` 命令（跟計畫不同：gateway 像 Stop 一樣在沒人持有時短暫拿 control lease，不是新的免 lease 路由）；排隊中的 → 加進任務；已結束的 → 同 session、同討論串叫一個 follow-up 工人，那句話本身就是使用者的 quote。插話、回答、Stop 只限工人為之工作的人（其 session 是他的），讀是全家的。
- [x] worker 的 `ask_question` → 討論串；team 事件 depth。（2026-10-21）不靠 `interaction_created` 事件本身，而是在重讀 session 時對照它等著的 dialog：新的 → 討論串 `question`（`{interactionId, kind, request, status}`）+ 房間 line「A worker is asking: …（answer in the thread）」+ push；不在了的 → `answered`；工人結束 → `cancelled`。回答 `POST /api/threads/:id/answer` → node 的 `relayed-answer`（放寬成也收 select / input 的答案，confirm 仍只收 yes/no）。在跑的工人 session 自己的 waiting push 不再發（改由房間發）。紅線（07 之前所有 approval）也走這裡。team：agent 每筆 broker 紀錄 emit `team_event`（spawn / message / post / result / question …）。
- [x] `runner/process.rs` 的 `task_context` / `read_only`；`features/assistant` 殘餘刪除。（2026-10-21）跟計畫不同：不加啟動參數，跟著交付走（running session 與 follow-up 也適用）：脈絡在任務訊息與 `details.context`；唯讀是 delivery 的 `approvalMode: "read-only"`，node 在交付前 `set_approval_mode`（只收 `read-only`：gateway 只能收窄）。`features/assistant` 整個刪除，連同 `delegate` / `delegation_status` / `memory_note` / `memory_search` 的工具描述、ptc registry 與 mode 的 `TOOL_NAMES`。
- [x] Web：交辦訊息 + 討論串面板（工人列表、狀態點、縮排、插話框）；房間 anchor 的「進行中（n）」原地更新；Stop。（2026-10-21）`lib/workers.ts`、`components/rooms/ThreadPanel.svelte`（暫時是房間右側第三欄，手機上蓋全頁；側欄或第二欄留給 11 定）：工人列表、狀態點、teammate 縮排、問題的選項 / 輸入 / 是否、插話框、Stop。anchor 顯示狀態（Working (n) / Waiting its turn / Asking you / Done / Failed）+ Thread + Stop；工人的 line 與報告有「Open the thread」。引擎蓋 session 的 origin 改成連回房間。
- [x] conformance：`brain_workers.rs`：叫工人 → anchor + thread；工人事件進 thread；report → 房間 + 頭腦記憶 `tool:delegation`；第 5 個排隊；wake 只能 read_only；team 子代 depth 1；插話到達 session。（2026-10-21）另含：討論串回答問題（relayed-answer）、重複回答 409、Stop、wake 的工具沒有 `stop_worker`、錯誤路徑。`delegations.rs` 改寫成「`delegation.*` op 已不存在、Stop / 討論串路由找不到工人」。

## 驗證

- conformance `brain_workers` + `delegations`（改寫）+ `agent_team*`。
- 手動：「幫我在 pirc 跑 tests」→ 房間一則交辦 + 討論串有工人 → tests 結果回房間。

### 驗證結果（2026-10-21）

- `cargo test -p pirc-agent -p pirc-gateway -p pirc-config -p pirc-protocol` 全過（338 / 144 / 39 / 34）；`cargo test -p pirc-node` 302 過、2 個 `sandbox::linux::plan` 的 host unix socket 測試在這台沙箱裡失敗（讀 `/proc/net/unix`，本 plan 沒碰 sandbox）。
- conformance（release build）：`brain_workers` 通過並記錄快照（連跑 5 次穩定）；`delegations` 改寫；`brain*` 快照只多了三個工人工具與 `workers` 段落；`agent_team_ptc` 快照多了 `team_event` 事件（其餘只是 uuid 編號位移）；`routes` / `session` 的 session snapshot 少了 `delegations`；其餘全過，只有 `node_browser*` 在沙箱裡起不了瀏覽器（快照未改）。
- web：`bunx vitest run` 46 檔 326 個全過（新 `workers.test.ts`）；svelte-check 0 錯；prettier 乾淨；`cargo fmt --check`、`cargo clippy --workspace --all-targets` 乾淨；release gateway 16,474,544 bytes（上限 16,777,216）。
- 手動（真模型「幫我在 pirc 跑 tests」、push 實機）尚未做。

## 文件

- `docs/development/gateway-and-node.md` delegation 段重寫；`security-decisions.md` 的 Delegation approval 一節重寫（existing-plans §1）。
- 已寫（2026-10-21）：上面兩份（security-decisions 改名「Workers without approval」，含 relayed-answer 放寬與 wake 的唯讀工人），加上 `docs/architecture/assistant-memory.md`（Workers）、`prompt-context.md`（`workers` 段落與工具）、`docs/deploy/upgrades.md`（schema 6、node 要一起升級）、`docs/guides/rooms-and-memory.md`（Workers）、`docs/guides/tools.md` 與 `docs/deploy/node.md` 的 delegation 字眼。

## 實作前待決

- 「Allow again in this session」for `unsandboxed_bash`（existing-plans §7.2）：這份 plan 不做；07 看需要。
- ~~工人回報的長度上限與附件（diff、截圖）怎麼進房間~~ 採建議（2026-10-21）：房間的回報 ≤ 2000 字元，多的在討論串（工人的文字 ≤ 8000）與 `worker_status`；附件（diff、截圖）還沒有，等工人有東西可附時以討論串內連結呈現。
