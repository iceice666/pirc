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

- [x] schema + `brain/loops.rs`（store、不變量、降級、recurrence 推進）。（2026-10-20）`pirc.sqlite` schema 4（`db/migrations/4-open-loops.sql`）：`open_loops` 加兩欄 **`owner_user`**（turn 的第一位發話者，降級寫進誰的事實）與 **`due_at`**（anchor 下一次到點，計時器只查這欄）；`memory_records.open_loop_id`（降級來的事實）。id 是 `l` + 8 hex。同一件事（忽略大小寫與空白）再開 = touch 原來那條。anchor：`{at, zone, autoClose, passed?}` 或 `{cron, zone, until?, nextAt}`（`time/cron.rs`，zone 預設 `PIRC_TIMEZONE`）；過去的時間、`until` 過了、在 `until` 前不會到、`autoClose` 配 cron 都拒絕。計時器（`wake/timer.rs` 的 `DeadlineTimer`，`main.rs` 不論 `PIRC_BRAIN` 都啟動）：`autoClose` → `elapsed` + line；沒 flag → 標 `passed` 等人；recurrence → 推進（機器睡過頭只補一次）或 `recurrence_ended` + line；失敗退避 60 s。05 的 wake 掛在 `Fired::Passed`/`Advanced`。降級：超過 40 → 無錨、`last_touched_at` 最舊的先降（同一 transaction），寫成 owner 的事實（content 為「what (why)」、origin 照抄、source = loop id + entries、`open_loop_id`）；被 tombstone 擋的文字就只關不寫。`reopen` 把那條事實收回（`person::retire`：刪列、索引、log，**不** tombstone）。
- [x] 工具與 prompt 文案（`prompts/tools/open_loop.md` 等）。（2026-10-20）`brain/loop_tools.rs`：`open_loop {what, why?, anchor?, next_check?, room?}`、`close_loop {id, reason}`、`touch_loop`、`update_loop {id, what?, why?, anchor?|null, next_check?|null}`、`reopen_loop`。**與設計的差異**：工具說明照 03 的做法寫在 Rust 裡（gateway 不用 `pirc-agent/prompts/tools/`）；文案、line、section 都是英文（同 03 的 `## Preferences` / `## You may remember`），section 標題是 `## Open loops` 而非「還掛著的事」。origin 用 03 的 `origin_now`（loop 工具加進 `WRITING_TOOLS`，它們的結果不算來處）。line：開 `Holding on to: …（next …）`、關 `Closed: … (reason)`、降級 `This sat untouched for a while, so I put it in memory: …`、重開 `Open again: …`，`body.loop {id, event}`；touch/update 不出 line。
- [x] `brain/turn.rs`：投影 section；03 的自動撿取 query 納入 loops 的 `what`。（2026-10-20）在 `scheduler.rs` 開 turn 時組（`loops::section`）：先降級、再列出，順序 preferences → `loops` → recalled。section 開頭帶**現在時間**（頭腦本來不知道今天幾號，開時間錨需要）；每條「[id] what (why) · from origin · next/due … · next check …」，有錨的近者先、再依 `last_touched_at`。自動撿取的 query = 這批話 + 所有 open loop 的 `what`。steer 不重算（同 03）。
- [x] API：`GET /api/loops?status=`、`PATCH /api/loops/:id`（close / reopen / anchor）；事件 `loop_changed`。（2026-10-20）`routes/loops.rs`：`?status=open|closed|all&limit=`（closed 預設 50、上限 200），回 `{loops, limit: 40}`；PATCH 收 `{status:"closed", reason?}`（預設「not needed any more」）、`{status:"open"}`、`{anchor}` 三擇一，關/開在 loop 的房間出 line（房間封存了就 #general）。`loop_changed {loop}` 走 rooms 事件流（loop 的房間）。`no-store`、`PARAM_ROUTES` 都加了。
- [x] Web：房間 line；面孔頁 / 引擎蓋的 loops 清單（10 之前掛 Settings）；時間錨顯示「下次」。（2026-10-20）`lib/loops.ts`；房間 line：opened/reopened 有「Don't keep」、closed/demoted 有「Not done yet」（按一次就收起）；Settings → **Open loops**（`LoopsSettings.svelte`）：開著的（下次時間用 anchor 的 zone 顯示、來處、why、next check、Not needed）與最近關的 20 條（原因、Not done yet），`loop_changed` 時重載。Android 留給 [12](12-android.md)（已記在該 plan）。
- [x] conformance：`brain_loops.rs`：掛上 → line；40+1 → 最老無錨的降級且可搜到可撈回；週期錨 `next_at` 推進與 `until` 了結；`tool:*` loop 的 origin 保留到降級後。（2026-10-20）另含 prompt 的 section 與工具清單、使用者從 web 關、最近關的清單、錯誤路徑（未知 id 404、空 body / 未知欄位 400、過去的時間 400、關掉的 loop 改時間 409、壞 status 400）。recurrence 用每秒的 `* * * * * *` 與 3 秒後的 `until` 真的跑計時器。`brain`、`brain_memory` 快照跟著新工具與 section 更新。

## 驗證

- `cargo test -p pirc-gateway loops`、conformance `brain_loops`。
- 手動：「每週三 18:00 開會」→ loop 顯示下次時間；「那個不用記了」→ 了結 line。

**結果（2026-10-20）**：`cargo test -p pirc-gateway` 127 passed（新增 `brain::loops::tests` 4 個：anchor 檢查與文字、開/去重/改/關/重開、到點的 elapsed/passed/推進/until 了結、40+1 降級成可搜的事實帶 `tool:*` origin 與 loop id、重開收回事實；`brain::tests::the_brain_opens_a_loop_and_has_it_in_front_of_it`；schema 1→4 遷移測試）。`cargo clippy --workspace --all-targets`、`cargo fmt --all --check` 乾淨。conformance（`target/release`，`--no-fail-fast`）：全綠，只有 `node_browser` 4 個照舊失敗（這個沙箱的 Chromium）；`brain_loops`+`brain`+`brain_memory`+`rooms`+`memory`+`http` 連跑 8 次都綠。web：vitest 44 files / 317 tests、`svelte-check` 0 錯誤、prettier 乾淨。gateway release 15.32 MiB（預算 16 MiB，03 時 13.33 MiB）：**多出的約 2 MiB 是 `chrono-tz` 的時區轉換表**——`time/cron.rs` 之前沒有呼叫者，被 linker 丟掉，現在 anchor 要算各時區的時間就進來了；剩約 0.68 MiB 餘裕。**手動真模型測試沒做**：沙箱連不到 provider，要使用者自己跑。

與設計的差異（除上面各項）：`room?` 參數只接受存在且未封存的房間，line 出在說話的房間；`CHANGELOG.md` 照 01–03 留給 [13](13-docs.md)。

## 文件

- `docs/architecture/assistant-memory.md`（03 重寫的那份）加 open loops 一節；`docs/guides/` 新 guide「房間、記憶與未了結的事」的 loops 段。

## 實作前待決

- 「事情本身是時間」的判斷交給頭腦還是用 anchor 上的 flag（`auto_close: bool`，開 loop 時由頭腦設）？建議 flag，可預測。→ **已定（2026-10-20，使用者）：anchor 上的 `auto_close` flag。**
- 週期 loop 的 wake 要不要在到點前提醒（「明天 18:00 開會」）：這是 05 「值得說」的一部分，這裡只存 anchor。

**2026-10-20 使用者同意動工。**
