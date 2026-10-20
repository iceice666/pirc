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

**Presence**：面孔的「正在做（附一行）」= 它有跑中的 worker；由 `delegations` 狀態推導（10 顯示）。

## 工作項目

- [ ] `delegations.rs` 改表與狀態機；佇列；`report` → 房間。
- [ ] `call_worker` / `worker_status` / `stop_worker` 工具與 prompt；context 打包（03/04 的 ids → 文字）。
- [ ] threads：`thread_messages` 表、`node_events.rs` 映射、事件流、API `GET /api/threads/:id`、插話 `POST /api/threads/:id/messages`。
- [ ] worker 的 `ask_question` → 討論串；team 事件 depth。
- [ ] `runner/process.rs` 的 `task_context` / `read_only`；`features/assistant` 殘餘刪除。
- [ ] Web：交辦訊息 + 討論串面板（工人列表、狀態點、縮排、插話框）；房間 anchor 的「進行中（n）」原地更新；Stop。
- [ ] conformance：`brain_workers.rs`：叫工人 → anchor + thread；工人事件進 thread；report → 房間 + 頭腦記憶 `tool:delegation`；第 5 個排隊；wake 只能 read_only；team 子代 depth 1；插話到達 session。

## 驗證

- conformance `brain_workers` + `delegations`（改寫）+ `agent_team*`。
- 手動：「幫我在 pirc 跑 tests」→ 房間一則交辦 + 討論串有工人 → tests 結果回房間。

## 文件

- `docs/development/gateway-and-node.md` delegation 段重寫；`security-decisions.md` 的 Delegation approval 一節重寫（existing-plans §1）。

## 實作前待決

- 「Allow again in this session」for `unsandboxed_bash`（existing-plans §7.2）：這份 plan 不做；07 看需要。
- 工人回報的長度上限與附件（diff、截圖）怎麼進房間：建議回報 ≤ 2000 字元，附件以 thread 內連結呈現。
