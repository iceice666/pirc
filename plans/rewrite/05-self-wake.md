# 05 主動性（self-wake）

[重寫](README.md) · [direction §2.6](../../docs/architecture/direction.md) · [決定](decisions.md)

**目標**：頭腦會在沒人叫它的時候醒來——時間錨到了、來源有變化、它自己排的回頭看——醒來只做唯讀的事，有值得說的在房間裡說，沒有就無聲；有配額。wake 是同一條 thread 的延續，不開新 session。

**依賴**：02、04。來源事件觸發需要 09；在 09 之前只有時間錨與自排兩種觸發。**被依賴**：09、10。

## 決定（已定）

- 配額：每日 24 次、同時 2 個唯讀研究；cadence email 5 分、行事曆 15 分、瀏覽器來源 60 分、workspace 一日一次（#3）。
- 「值得說」：時間錨永遠說（deadline 前一天也說）；來源事件碰到既有 loop 或房間訂閱才說；自排回頭看有發現才說（#4）。
- wake 排在 user turn 後；被 user 搶先的 wake 重排（#13、#16）。
- 「Nothing writes unasked」：wake 期間所有寫入工具（06 叫工人、09 的 action 側）被 host 拒絕，只能更新記憶與 loops（§2.5、§2.6）。

## Schema

```sql
wakes(id, kind 'anchor'|'source'|'self', trigger_json, room_id, face_id NULL,
      scheduled_at, started_at NULL, ended_at NULL,
      outcome 'spoke'|'silent'|'preempted'|'failed'|'quota' NULL, note NULL)
wake_quota(day, count)   -- 或由 wakes 聚合
```

## 設計

**觸發**（`wake/timer.rs`，00 保留的 earliest-deadline 骨架）：

1. `anchor`：掃 `open_loops` 的 `anchor_json.next_at` / `at`，加上「deadline 前一天」的派生時刻（只對 `auto_close` 的 loop）。
2. `source`：09 的 poller 發現變化時 enqueue，帶 `tool:<source>` 與變化摘要。
3. `self`：頭腦在 turn 結束時呼叫 `schedule_wake {at, why, room}`；房間 line「我 X 點會回來看 Y」可取消。一次性。

**排程**：`brain/scheduler.rs`（02）加 wake queue：user turn 優先；同時進行的 wake ≤ 2（研究類）；每日計數 ≥ 24 → `outcome='quota'`，不問、下一天再來。user 訊息到時正在跑的 wake → abort，`outcome='preempted'`，重排到 user turn 之後（最多重排一次，再被搶就 `silent`）。

**wake turn 的輸入**：觸發描述（「loop X 的時間錨到了」「email 有 3 封新信，摘要…」）、該房間最近 N 則、loops 投影、自動撿取（03）。prompt 明說：唯讀、可以不說話。

**wake turn 的輸出**：

- 頭腦呼叫 `speak {text}` → 房間訊息（戴那個房間負責的面孔，10 之前是主持人）+ push。
- 沒呼叫 `speak` → 無聲回合：只有記憶/loops 的變更落地；引擎蓋的 `wakes` 看得到；房間不出現任何東西。
- 頭腦想做寫的事 → 只能 `open_loop` 或 `speak` 來問你；06/09 的 action 工具在 wake profile 裡不存在（不是拒絕，是沒給）。

**唯讀研究**：wake 可呼叫 06 的 `call_worker` 但 host 強制 `read_only: true`（node 側 approval mode `read-only`，07/08 保證），以及 09 的研究模式瀏覽器。

## 工作項目

- [x] schema + `wake/{mod,timer,quota}.rs`；`schedule_wake` / `cancel_wake` 工具。（2026-10-21）pirc.sqlite schema 5（`migrations/5-wakes.sql`）：`wakes` 比上面多了 `owner_user`（push 給誰）、`attempt`（重排第幾次）、`turn_id`、`created_at`，`outcome` 多一個 `cancelled`；沒有 `wake_quota` 表，配額由 `wakes` 聚合（`wake/quota.rs`）。工具在 `brain/waking.rs`；自排的 wake 同時最多 20 個在等。
- [x] scheduler 的 wake 分支與 preemption；每日配額（zone 用 `PIRC_TIMEZONE`）。（2026-10-21）沒有 ready batch、沒有 turn 在跑時才開 wake；wake 跑的時候有 batch ready → abort、`preempted`、以新列（`attempt: 2`）排到那個 user turn 之後，再被搶就 `silent`（note「people took over again」），已經 `speak` 過的算 `spoke`。配額：`PIRC_WAKES_PER_DAY`（預設 24，0 關閉），`PIRC_TIMEZONE` 當地午夜重置（使用者 2026-10-21 定案：每日、重排 1 次），被搶先的那次不計。重啟時跑到一半的 wake 記 `failed`（`interrupted`）。同時 2 個唯讀研究要等 06 的工人才有意義，現在一次只跑一個 turn。
- [x] wake turn 的 prompt 與 `speak` 工具；無聲回合的落地與引擎蓋可見。（2026-10-21）wake 是房間 conversation 的一個 turn（`brain_turns.kind='wake'`），輸入是觸發描述 + 房間最近 10 則（custom message `wake`）；回覆不寫進房間，只有 `speak` 寫（+ push 到 room deep link）。`speak` 只在 wake 有、user turn 沒有：pirc-agent 新增 `Agent::set_hidden_tools`（feat(agent)）。wake 不發 `brain_presence`，以免無聲回合在房間露出。
- [x] 「值得說」預設寫成 CHAT.md 的預設段落（可被偏好覆蓋），不是硬編碼。（2026-10-21）做成 wake 專屬的 prompt 段落「When to speak after waking」（`waking::WHEN_TO_SPEAK`），放在 room 之後、`CHAT.md` 之前，段落本身寫明 house rules 與偏好在後、衝突時以它們為準；不改寫使用者的 `CHAT.md` 檔。
- [x] 時間錨觸發（含 04 的 recurrence 推進與 `auto_close`）；deadline 前一天的派生。（2026-10-21）`loops::fire` 對 `Passed` / `Advanced` / `Elapsed` / 新的 `Eve` 都 enqueue `anchor` wake（`trigger.moment` = `due` / `next` / `eve`）。有 brain 時 `autoClose` 的時間到了不再當場了結：標 `passed`，wake 結束後（含 quota、failed、取消）才以 `elapsed` 了結；沒有 brain 或配額 0 時照 04 當場了結。前一天：`open_loops.notice_at`（只有 `autoClose` 且距今超過一天的 `at`），reopen 時重算。wake 因 quota / failed 沒開成時，房間仍出一行「Reminder: …」+ push。從 [04](04-open-loops.md) 來的：時間錨已由 gateway 的計時器處理（`brain/loops.rs` `start_timer` → `fire`：`autoClose` 了結為 `elapsed`、無 flag 的標 `passed`、recurrence 推進 `nextAt` 或以 `recurrence_ended` 了結），wake 掛在 `fire` 的 `Fired::Passed` / `Fired::Advanced` 那裡；下一個時刻在 `open_loops.due_at`（不是 `anchor_json.next_at`），anchor 的鍵是 `autoClose` / `nextAt`。
- [x] API：`GET /api/wakes?room=`、`DELETE /api/wakes/:id`；事件 `wake_changed`；push 走 room deep link。（2026-10-21）`routes/wakes.rs`：`?status=pending|ended|all&limit=`，回 `{wakes, today: {used, limit}}`；DELETE 只取消還沒開始的（跑中 409 `wake_running`）；PARAM_ROUTES 與 no_store_route 已加。
- [x] Web：房間 line「我晚點會回來看」+ 取消；引擎蓋的 wakes 頁。（2026-10-21）line `body.wake {id, event}` 的 **Cancel**；wakes 列表跟 04 的 loops 一樣放在 Settings → Wakes（引擎蓋開得到），11 再搬。
- [x] conformance：`brain_wake.rs`（fake LLM、可調時鐘）：錨到點 → wake → `speak`；無聲回合房間無訊息；配額 24 → 第 25 次 `quota`；user 訊息搶先 → `preempted` 重排；wake 期間呼叫寫入工具不存在。（2026-10-21）沒有可調時鐘：用幾秒後的真實時間；配額用 `PIRC_WAKES_PER_DAY=2` 走到第 3 次 `quota`（24 次的情形在 gateway 單元測試 `past_the_days_wakes_a_time_is_still_said`）。寫入工具目前還不存在（06/09 才有），所以快照記的是 wake 與對話的工具清單差異（wake 有 `speak`、對話沒有），`NOT_IN_WAKES` 留給 06/09 填。

## 驗證

- `cargo test -p pirc-gateway wake`、conformance `brain_wake`。
- 手動：「30 分鐘後提醒我喝水」→ 30 分鐘後房間出訊息 + push；「我晚點看你的 dotfiles」→ line 可取消。

### 驗證結果（2026-10-21）

- `cargo test -p pirc-gateway wake`：14 passed（`wake::tests`、`wake::quota::tests`、`brain::tests` 的 wake 情境、loops 的前一天）；`cargo test -p pirc-agent -p pirc-gateway -p pirc-config` 全過（342 / 140 / 39）。
- conformance（release build）：`brain_wake` 通過並記錄快照；`brain`、`brain_loops`、`brain_memory` 快照只多了 `schedule_wake` / `cancel_wake` 與 loop 的 `noticeAt`；其餘全過，只有 `node_browser*` 在這台沙箱裡起不了瀏覽器而失敗（與本 plan 無關，快照未改）。
- web：`bunx vitest run` 45 檔 322 個全過；svelte-check 0 錯；`cargo fmt --check`、`cargo clippy --workspace --all-targets` 乾淨；prettier 乾淨；release gateway 16,216,752 bytes（上限 16,777,216）。
- 手動（真模型「30 分鐘後提醒我喝水」、push 實機）尚未做。

## 文件

- `docs/architecture/security-decisions.md`：「Nothing writes unasked」+ residual risk（wake 讀到 prompt injection 只能影響記憶與 loops，兩者帶 `tool:*`）；`docs/deploy/gateway.md`：配額設定。
- 已寫（2026-10-21）：上面兩份，加上 `docs/architecture/assistant-memory.md`（Waking up）、`prompt-context.md`（wake 段落與工具）、`docs/deploy/upgrades.md`（schema 5）、`docs/development/gateway-and-node.md`（`/api/wakes`、`wake_changed`）、`docs/guides/rooms-and-memory.md`（When pirc speaks up by itself）。

## 實作前待決

- ~~配額用「每日」還是「滾動 24 小時」~~ 已定（2026-10-21）：每日，`PIRC_TIMEZONE` 當地午夜重置。
- ~~被搶先的 wake 重排幾次~~ 已定（2026-10-21）：1 次，再被搶就 `silent`。
