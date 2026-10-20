# 01 房間：第一級物件、訊息、事件

[重寫](README.md) · [direction §2.2 / §4](../../docs/architecture/direction.md) · [決定](decisions.md)

**目標**：gateway 擁有「房間」這個第一級物件：每房間一條永遠在的 thread、訊息持久化、未讀與「等你回話」、封存、釘選、搬家連結；一條以房間為範圍的事件流；推播指向房間。這份 plan 沒有頭腦——房間裡只有你自己的訊息——但 API、schema、事件、最小 web UI 都要能用。

**依賴**：00。**被依賴**：02 以後全部。

## 決定（已定）

- 新 DB 檔從零（#14）：`$PIRC_STATE_DIR/pirc.sqlite`，schema 版本從 1 起算；舊 `gateway.sqlite` 存在時只記一行 log，不讀不改。
- Typing debounce 在 gateway（#16）：這份 plan 做訊號與累積，開 turn 的邏輯在 02。
- 面孔是展示層（§2.8）：訊息有 `speaker`，這份 plan 只有兩種值：`user` 與 `face:host`。

## Schema（gateway，新檔）

```sql
rooms(id, name, kind 'general'|'topic', created_at, archived_at NULL, last_activity_at,
      source_scope_json NULL, moved_to_room_id NULL, moved_from_room_id NULL)
room_messages(id, room_id, seq, speaker, kind 'text'|'line'|'progress'|'question', body_json,
              thread_id NULL, created_at, edited_at NULL, pinned_at NULL)
room_reads(room_id, user, last_seq, waiting_since NULL)
room_typing(room_id, user, device, last_keystroke_at)        -- 可放記憶體，不一定入表
room_pending(room_id, user, message_ids_json, first_at, last_at) -- debounce 累積，02 消費
threads(id, room_id, anchor_message_id, created_at, closed_at NULL)  -- 06 用，這裡只建表
faces(id, name, bio, tone, avatar, color, created_at)        -- 10 用；這裡只插 host
```

`kind='line'` 是「記下了 / 掛上了 / 叫了工人」那種可展開小字；`progress` 原地更新；`question` 是它在房間裡問你（05/06/07 用）。`#general` 在 DB 初始化時建立，`kind='general'`，不可封存。

## API

- `GET /api/rooms`（依 `last_activity_at` 排序，帶未讀數、`waiting`）；`POST /api/rooms {name}`；`PATCH /api/rooms/:id {name, archived, sourceScope}`；`POST /api/rooms/:id/move {toRoomId}`（原房間留 line「接著在 #X 聊」，新房間開頭 line「從 #Y 接過來」）。
- `GET /api/rooms/:id/messages?before=&limit=`；`POST /api/rooms/:id/messages {text, attachments?}`（立刻持久化、立刻廣播；同時進 `room_pending`）；`POST /api/rooms/:id/messages/:mid/pin`；`POST /api/rooms/:id/read {seq}`。
- `POST /api/rooms/:id/typing`（節流 3 秒一次，client 自己節流）。
- `POST /api/rooms/:id/uploads` — 沿用 session uploads 的 sniff / 大小規則，存 gateway 側（頭腦沒有 node）；給工人時再搬。
- WebSocket `GET /api/events?rooms=1&cursor=`：事件 `room_message`、`room_message_updated`（progress / edited）、`room_read`、`room_changed`、`room_typing`。cursor 語意沿用 `events.rs` 的 bounded replay，但不綁 runner epoch。
- 推播：`push.rs` 的 `PushMessage` 加 `room_id` deep link；「等你回話」推播在 05/06/07 接上。

## 工作項目

- [x] 新 DB 檔與 migration 骨架（`db.rs` 拆成 `db/{mod,rooms,engine}.rs`；worker 的 `sessions`/`commands`/`leases` 等表原樣搬進新檔）。（2026-10-20）新檔以 `PRAGMA application_id`（"pirc"）辨認，沒有它的非空檔一律拒絕（舊 gateway 的 1000–1005 與 TS 的 1–19 都會撞到從 1 起算的版本號）；`session_deletions` 與它的 409 fence 不進新檔（新檔不可能有未完成的舊刪除）；`schema-1000.sql` 與 1001–1005 migration 刪除。
- [x] `rooms.rs`：store + 不變量（`#general` 唯一且不可封存；封存不刪訊息；搬家寫兩條 line）。（2026-10-20）store 在 `db/rooms.rs`，事件與 typing 在 `rooms.rs`。房間屬於整個 household（所有 allowed users 共用），讀取 / 未讀 / 等你回話分人；`#general` 的唯一與不可封存另有 partial unique index 與 CHECK 擋在 SQL 層；封存的房間仍可讀，但不收新訊息（409）直到解封；`user` 訊息另存 `user` 欄記誰送的（schema 多一欄）；自己送的訊息算已讀，且會清掉自己在該房間的 `waiting_since`。
- [x] `routes/rooms.rs`；`events.rs` 加 room 事件流；`sockets.rs` 的訂閱。（2026-10-20）另加 `GET /api/rooms/:id`（含釘選，封存的房間靠它從 URL 讀）與 `GET /api/rooms/:id/uploads/:uid`（圖片 inline，其餘一律 `attachment` + `nosniff` + sandbox CSP）。房間事件流的 cursor 是 `epoch:sequence`，epoch 是 gateway 這次啟動的時間（重啟後舊 cursor 一律 reset）；一個 socket 只跟一條流（`sessionId` 與 `rooms=1` 擇一）；開頭送 `ready {watermark}`；`room_read` 只送給本人；`room_typing` 的 sequence 為 0、不 replay。附件存在 `PIRC_UPLOADS_DIR`（`room-*.bin`，0600），一個 upload 只能跟一則訊息。
- [x] typing 與 pending 累積（純資料；02 加排程）。（2026-10-20）typing 只在記憶體（每房間 / 使用者 / 裝置最後一次按鍵，6 秒過期）；`room_pending` 入表，send-now（`immediate`）一旦出現就整批跳過 debounce；`list_pending` / `take_pending` 留給 02。
- [x] `push.rs`：room deep link；`features.rs` 的 hint 改成 rooms。（2026-10-20）`PushMessage` 的 target 多 `{roomId}`（`push::room_message`，tag `room:<id>`，05–07 才有呼叫者）；web 的 `sw.js` 把 room 開在 `/?room=`、session 與 memory 改開在 `/engine`，已開著的視窗在另一頁時用 `client.navigate` 換頁。hint：房間的列表變化由 room 事件流本身（`room_changed`）帶，不另設 `rooms_changed` hint；`directory=1` / `memory=1` / `sessions=1` 也能掛在 `rooms=1` 的 socket 上。
- [x] Web 最小 UI：房間列表（活動排序、未讀點、等你回話標記）、訊息列（頭像 / 名字 / 時間 / 內容，無 bubble）、composer（送出即顯示；`Cmd+Enter` 立即送出 flag 先傳到 API，02 才有意義）。放在 `App.svelte` 的新頂層，Work tab 退到 `/engine` 路由。（2026-10-20）舊 `App.svelte` 原樣改名 `Engine.svelte`；新的 `App.svelte` 依路徑選 `Rooms` 或 `Engine`。另有建房、封存 / 解封、「Continue in…」搬家、釘選、附件、typing 顯示；Enter 送出、Shift+Enter 換行、IME 選字的 Enter 不送出；連續快送不等前一則（手動測試抓到「送出中第二則被吞」後修掉並加測試）。
- [x] conformance：`rooms.rs` scenario（建房、送訊、未讀、封存、搬家、cursor replay、typing 不入 DB）。（2026-10-20）`tests/rooms.rs` + `snapshots/rooms__rooms.snap`；兩個使用者、上傳與釘選也在裡面，「typing 不入 DB」以「不被 replay」驗證，DB 層另有 unit test。
- [x] `fixtures/timeline/`：加 room 事件的 golden case（舊 session case 保留給引擎蓋）。（2026-10-20）`fixtures/timeline/rooms/two-users-and-a-move.json`，web 端 `rooms-fixtures.test.ts`；Android 等 12 再接。

## 驗證

- `cargo test -p pirc-gateway rooms`、conformance `rooms`、web tests。
- 手動：兩個瀏覽器分頁同時看一個房間，A 送三則短訊，B 立刻看到三列；未讀數正確；封存後列表隱藏但 URL 仍可讀。

結果（2026-10-20，Linux sandbox）：

- `cargo test -p pirc-gateway` 98 passed（`rooms` 篩選 12 個）、`cargo test -p pirc-config` 39 passed；`cargo clippy -p pirc-gateway -p pirc-config -p pirc-conformance --all-targets -D warnings`、`cargo fmt --all --check` 乾淨。
- conformance（debug 執行檔，`PIRC_CONFORMANCE_REQUIRED=1`）：全部 58 個 test binary 通過，含新的 `rooms`；其他快照沒有變動。
- web：vitest 43 files / 306 tests 通過，`svelte-check` 0 錯、`vite build` 成功，prettier 乾淨，`bun test scripts/test` 8 passed。
- 手動（gateway + 兩個 vite dev server 各帶一個使用者的 forward-auth header，headless Chromium 兩個分頁）：A 在 `#general` 連送三則，B 約 0.1 秒內看到三列且順序正確；B 在別的房間時 `#general` 顯示 1 未讀，切回去後清掉；B 看到 A 正在打字；A 封存房間後 B 的列表移除它、用 `?room=` URL 仍可讀且沒有 composer；`/engine` 照常載入；state 目錄裡放一個假的 `gateway.sqlite`，gateway 只記一行 log，檔案內容不變。手機寬度（390px）版面正常。沒做：真瀏覽器的推播點擊、Android。

## 文件

- `docs/development/gateway-and-node.md` 的 API 段加 rooms；`docs/deploy/backup-and-recovery.md` 加新 DB 檔。

## 實作前待決（2026-10-20 使用者已定）

- 房間附件：**存 gateway**，沿用 session uploads 的 sniff / 大小上限，放在 gateway state 下；保留期先不自動清（之後再定），封存不刪檔。
- `room_pending`：**入表**，gateway 重啟不丟尚未交給頭腦的訊息。
- `PIRC_DATABASE_PATH`：**保留覆寫**，gateway 預設改成 `$PIRC_STATE_DIR/pirc.sqlite`；node 的 DB 預設檔名這份 plan 不動。
- Plan 00 的手動驗證與 Kotlin 編譯仍掛著，不擋 01 開工。
