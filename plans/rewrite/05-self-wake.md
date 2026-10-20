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

- [ ] schema + `wake/{mod,timer,quota}.rs`；`schedule_wake` / `cancel_wake` 工具。
- [ ] scheduler 的 wake 分支與 preemption；每日配額（zone 用 `PIRC_TIMEZONE`）。
- [ ] wake turn 的 prompt 與 `speak` 工具；無聲回合的落地與引擎蓋可見。
- [ ] 「值得說」預設寫成 CHAT.md 的預設段落（可被偏好覆蓋），不是硬編碼。
- [ ] 時間錨觸發（含 04 的 recurrence 推進與 `auto_close`）；deadline 前一天的派生。
- [ ] API：`GET /api/wakes?room=`、`DELETE /api/wakes/:id`；事件 `wake_changed`；push 走 room deep link。
- [ ] Web：房間 line「我晚點會回來看」+ 取消；引擎蓋的 wakes 頁。
- [ ] conformance：`brain_wake.rs`（fake LLM、可調時鐘）：錨到點 → wake → `speak`；無聲回合房間無訊息；配額 24 → 第 25 次 `quota`；user 訊息搶先 → `preempted` 重排；wake 期間呼叫寫入工具不存在。

## 驗證

- `cargo test -p pirc-gateway wake`、conformance `brain_wake`。
- 手動：「30 分鐘後提醒我喝水」→ 30 分鐘後房間出訊息 + push；「我晚點看你的 dotfiles」→ line 可取消。

## 文件

- `docs/architecture/security-decisions.md`：「Nothing writes unasked」+ residual risk（wake 讀到 prompt injection 只能影響記憶與 loops，兩者帶 `tool:*`）；`docs/deploy/gateway.md`：配額設定。

## 實作前待決

- 配額用「每日」還是「滾動 24 小時」：建議每日（zone 當地午夜重置），好解釋。
- 被搶先的 wake 重排幾次：建議 1 次。
