# 重寫：住在 gateway 裡的人（已完成）

[方向文件](../../docs/architecture/direction.md) · [Open work](../README.md) · [Historical records](../../docs/development/historical-records.md)

依 [direction.md](../../docs/architecture/direction.md) 重寫 pirc 的 14 份 plan，2026-10-20 至 2026-10-22 全部完成。現在的行為以文件為準（[guides](../../docs/guides/README.md)、[memory](../../docs/architecture/memory.md)、[gateway and node](../../docs/development/gateway-and-node.md)、[security decisions](../../docs/architecture/security-decisions.md)）；程式碼與文件裡的「decision #N」是 [direction §6](../../docs/architecture/direction.md#6-開放的決定) 的編號；留下的第二步與手動驗證在 [Open work](../README.md)。舊 `gateway.sqlite` 原地不動（decision #14）。

各 plan 的全文（工作項目、驗證結果、與設計的差異）、盤點（`inventory.md`）、決定（`decisions.md`）與既有 plan 的去向（`existing-plans.md`）已移出工作樹；原始碼註解裡的 `plans/rewrite/NN-*.md` 指的就是它們：

```sh
git ls-tree --name-only 6111f04 plans/rewrite/
git show 6111f04:plans/rewrite/03-memory.md
```

| #   | 檔案               | 做了什麼                                                                          |
| --- | ------------------ | --------------------------------------------------------------------------------- |
| 00  | `00-demolition.md` | 拆掉退場的實作：chat node、chat projects、schedules、記憶提案、Chat/Work 導航     |
| 01  | `01-rooms.md`      | 房間、訊息、討論串、未讀、釘選、搬家；房間事件流；新 DB `pirc.sqlite`             |
| 02  | `02-brain-host.md` | 頭腦：`pirc-agent` 在 gateway 跑，direct tools，一次一個 turn，typing debounce    |
| 03  | `03-memory.md`     | 偏好 / 事實 / 自動撿取，origin tagging，OM promotion；memory-search phase 0–1     |
| 04  | `04-open-loops.md` | open loops：40 上限降級成事實，時間錨含週期與 `autoClose`                         |
| 05  | `05-self-wake.md`  | 三種觸發（時間錨、自排、來源）、每日 24 次、唯讀、無聲回合                        |
| 06  | `06-workers.md`    | 頭腦叫工人不問、討論串、回報進房間、交付事實與 loops                              |
| 07  | `07-red-lines.md`  | auto mode 的 `outbound` 類別、`deny` 直接拒、紅線問題 relay 進房間                |
| 08  | `08-nodes.md`      | node 能力宣告、挑手、`workspace_read`、`scratch.md` 預設 mode、唯讀是 task policy |
| 09  | `09-sources.md`    | 唯讀來源：IMAP、ICS / CalDAV、Moodle web service、workspace commits；Rust 篩 wake |
| 10  | `10-faces.md`      | 主持人與專案面孔、誰回話、presence、成員列表、搬家提議                            |
| 11  | `11-web.md`        | web 收成 room-first 兩頁（房間、引擎蓋），刪舊導航                                |
| 12  | `12-android.md`    | Android 房間層新寫、引擎蓋六頁；session 對話整個移除；renderer 全留               |
| 13  | `13-docs.md`       | 文件掃描、`plans/README.md` 重寫、CHANGELOG 記 0.10.0+harmony（未發版）           |
