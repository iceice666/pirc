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

- [ ] 新 DB 檔與 migration 骨架（`db.rs` 拆成 `db/{mod,rooms,engine}.rs`；worker 的 `sessions`/`commands`/`leases` 等表原樣搬進新檔）。
- [ ] `rooms.rs`：store + 不變量（`#general` 唯一且不可封存；封存不刪訊息；搬家寫兩條 line）。
- [ ] `routes/rooms.rs`；`events.rs` 加 room 事件流；`sockets.rs` 的訂閱。
- [ ] typing 與 pending 累積（純資料；02 加排程）。
- [ ] `push.rs`：room deep link；`features.rs` 的 hint 改成 rooms。
- [ ] Web 最小 UI：房間列表（活動排序、未讀點、等你回話標記）、訊息列（頭像 / 名字 / 時間 / 內容，無 bubble）、composer（送出即顯示；`Cmd+Enter` 立即送出 flag 先傳到 API，02 才有意義）。放在 `App.svelte` 的新頂層，Work tab 退到 `/engine` 路由。
- [ ] conformance：`rooms.rs` scenario（建房、送訊、未讀、封存、搬家、cursor replay、typing 不入 DB）。
- [ ] `fixtures/timeline/`：加 room 事件的 golden case（舊 session case 保留給引擎蓋）。

## 驗證

- `cargo test -p pirc-gateway rooms`、conformance `rooms`、web tests。
- 手動：兩個瀏覽器分頁同時看一個房間，A 送三則短訊，B 立刻看到三列；未讀數正確；封存後列表隱藏但 URL 仍可讀。

## 文件

- `docs/development/gateway-and-node.md` 的 API 段加 rooms；`docs/deploy/backup-and-recovery.md` 加新 DB 檔。

## 實作前待決

- 房間附件存 gateway 還是只存 metadata 轉給 node？建議 gateway（它沒有 node 可依賴），但要設大小上限與保留期。
- `room_pending` 入表還是記憶體：入表才能跨 gateway 重啟不丟訊息；建議入表。
