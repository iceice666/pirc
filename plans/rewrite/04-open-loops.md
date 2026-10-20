# 04 未了結的事（open loops）

[重寫](README.md) · [direction §2.3](../../docs/architecture/direction.md) · [決定](decisions.md)

**目標**：「我們之間還掛著的事」成為頭腦的第一級物件：它自己掛、自己了結、永遠在 prompt、超過上限降到事實層；時間錨（含週期）是 05 self-wake 的第一種觸發；`tool:*` 來源的事不能單獨授權任何 action。

**依賴**：02、03。**被依賴**：05、06、10。

## 決定（已定）

- 上限 40；無時間錨、最久沒提的先降；有時間錨不降（#2）。
- 週期性 = 一個常駐 loop 帶 recurrence（cron pattern + zone，用 `time/cron.rs`）；每次到點產生一個 wake；了結只有你說不用、或 recurrence 到期（#15）。
- 了結三種方式、沒有第四種（§2.3）；不出卡片。

## Schema

```sql
open_loops(id, room_id NULL, face_id NULL, what, why, origin 'user'|'tool:<src>',
           anchor_json NULL,        -- {at} | {cron, zone, until?, next_at}
           next_check NULL,         -- self-wake 的線索（文字）
           status 'open'|'closed', closed_reason NULL, closed_at NULL,
           created_at, last_touched_at, source_entry_ids_json)
```

`last_touched_at` 在頭腦或你在對話中提到它時更新（頭腦呼叫 `touch`），決定降級順序。

## 設計

**工具（頭腦）**：`open_loop {what, why, room?, anchor?, next_check?}`、`close_loop {id, reason}`、`touch_loop {id}`、`update_loop {id, …}`。origin 由程式碼算（同 03）。每次開/了結，房間出 line「掛上了：…」「了結了：…（原因）」，line 上有「不用記」/「還沒完」。

**Prompt 投影**：section `## 還掛著的事`（`fresh_each_turn`）：每條一行「what · 來處 · 時間錨（下次 X）· next_check」，依時間錨近者優先、再依 `last_touched_at`。超過 40 → 投影前先跑降級（同一 transaction）：降級的 loop `status='closed', closed_reason='demoted'`，寫進 `memory_records` person scope 帶 `was_open_loop` + 原 loop id；房間 line「這件事太久沒動，我把它收進記憶了：…」可一句話撈回（`reopen`）。

**時間錨**：

- 一次性 `{at}`：到點 → 05 wake；wake 結束後若是「事情本身是時間」（頭腦判斷，預設：會議、deadline）→ 自動了結 `closed_reason='elapsed'` 並出 line；否則留著等你。
- 週期 `{cron, zone, until?}`：`next_at` 由 `time/cron.rs` 算；到點 → wake；wake 後 `next_at` 推進；`until` 過了 → 了結 `recurrence_ended`。顯示「下次：週三 18:00」。
- zone 預設 `PIRC_TIMEZONE`（沿用 nix `timeZone`）。

**origin 規則**：`tool:*` 的 loop 可以觸發唯讀 wake、可以提醒；06 的 worker-call 與 07 的紅線在看到「授權依據」時只認 `user` origin 的 loop 或 quote。

**自然語言入口**：「記得提醒我週三開會」「那個不用記了」「還沒完」——由頭腦呼叫工具；沒有獨立指令。

## 工作項目

- [ ] schema + `brain/loops.rs`（store、不變量、降級、recurrence 推進）。
- [ ] 工具與 prompt 文案（`prompts/tools/open_loop.md` 等）。
- [ ] `brain/turn.rs`：投影 section；03 的自動撿取 query 納入 loops 的 `what`。
- [ ] API：`GET /api/loops?status=`、`PATCH /api/loops/:id`（close / reopen / anchor）；事件 `loop_changed`。
- [ ] Web：房間 line；面孔頁 / 引擎蓋的 loops 清單（10 之前掛 Settings）；時間錨顯示「下次」。
- [ ] conformance：`brain_loops.rs`：掛上 → line；40+1 → 最老無錨的降級且可搜到可撈回；週期錨 `next_at` 推進與 `until` 了結；`tool:*` loop 的 origin 保留到降級後。

## 驗證

- `cargo test -p pirc-gateway loops`、conformance `brain_loops`。
- 手動：「每週三 18:00 開會」→ loop 顯示下次時間；「那個不用記了」→ 了結 line。

## 文件

- `docs/architecture/assistant-memory.md`（03 重寫的那份）加 open loops 一節；`docs/guides/` 新 guide「房間、記憶與未了結的事」的 loops 段。

## 實作前待決

- 「事情本身是時間」的判斷交給頭腦還是用 anchor 上的 flag（`auto_close: bool`，開 loop 時由頭腦設）？建議 flag，可預測。
- 週期 loop 的 wake 要不要在到點前提醒（「明天 18:00 開會」）：這是 05 「值得說」的一部分，這裡只存 anchor。
