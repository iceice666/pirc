# 重寫：住在 gateway 裡的人

[方向文件](../../docs/architecture/direction.md) · [Open work](../README.md) · [All documentation](../../docs/README.md)

這個資料夾放依 [direction.md](../../docs/architecture/direction.md) 重寫 pirc 的所有工作文件。方向文件本身不授權任何實作；**每份 plan 都要另外取得使用者同意才能動工**。不考慮向後相容，但「never delete old state without approval」仍然成立——退場的是實作，不是使用者的狀態（舊 DB 原地不動，[決定 #14](decisions.md)）。

## 底稿

| 文件                                  | 內容                                                         |
| ------------------------------------- | ------------------------------------------------------------ |
| [盤點](inventory.md)                  | 現有程式碼逐檔分類：留 / 改 / 重寫 / 刪，加上缺口與待決事項  |
| [決定](decisions.md)                  | direction §6 各項開放決定的結果（2026-10-20）                |
| [既有 plan 的影響](existing-plans.md) | `plans/` 下每份 plan 與工作隊列的去向：留 / 吸收 / 改 / 退場 |

## Plans（依建議順序）

| #   | Plan                           | 一句話                                                                                    | 依賴                                          |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| 00  | [拆除](00-demolition.md)       | 刪掉退場的實作，地基清乾淨；worker 照常                                                   | —                                             |
| 01  | [房間](01-rooms.md)            | rooms / messages / threads 表、API、事件流、新 DB 檔、最小 UI                             | 00                                            |
| 02  | [頭腦 host](02-brain-host.md)  | **先 spike**：pirc-agent 在 gateway 的 LocalSet 跑；turn 排程；debounce；SOUL/CHAT 熱更新 | 01                                            |
| 03  | [三層記憶](03-memory.md)       | 偏好 / 事實（person scope）/ 自動撿取；origin tagging；OM promotion                       | 02；平行 [memory-search](../memory-search.md) |
| 04  | [未了結的事](04-open-loops.md) | open loops 表與工具、40 上限降級、時間錨含週期                                            | 02、03                                        |
| 05  | [Self-wake](05-self-wake.md)   | 三種觸發、配額、唯讀、無聲回合、值得說                                                    | 02、04（來源觸發等 09）                       |
| 06  | [工人](06-workers.md)          | 頭腦叫工人不問、討論串、回報、脈絡交付                                                    | 02–04；relay 等 07；挑手等 08                 |
| 07  | [兩條紅線](07-red-lines.md)    | auto mode 的 outbound 類別、Deny 直接拒、瀏覽器 action、relay 進房間                      | 00（可早做）                                  |
| 08  | [Node 是能力](08-nodes.md)     | 能力宣告、挑手、`workspace.read`、scratch 預設、mode 詞彙縮減                             | 00（可早做）                                  |
| 09  | [來源](09-sources.md)          | connector 框架、email / 行事曆 / Moodle、輪詢 → Rust 篩 → wake、憑證 UI                   | 02、05、08（第二步的研究瀏覽器等 07）         |
| 10  | [面孔](10-faces.md)            | 主持人與專案面孔、誰回話、presence、成員列表、搬家                                        | 02–04、06、08                                 |
| 11  | [Web](11-web.md)               | Discord 形狀收尾、引擎蓋頁、刪舊導航                                                      | 01–10（06 後可開始）                          |
| 12  | [Android](12-android.md)       | 跟著 API 走；renderer 全留                                                                | 11                                            |
| 13  | [文件](13-docs.md)             | 整體掃描、`plans/README.md` 重寫、CHANGELOG、版本號                                       | 01–12                                         |

```
00 ─┬─ 01 ─ 02 ─┬─ 03 ─ 04 ─ 05 ─┐
    │           │                ├─ 09 ─┐
    ├─ 07 ──────┼─ 06 ───────────┤      ├─ 10 ─ 11 ─ 12 ─ 13
    └─ 08 ──────┘                └──────┘
```

07 與 08 不碰頭腦，可以在 01–05 進行時平行做。

## 實作前待決（掛在各 plan 的「實作前待決」節，動工前定）

| Plan | 問題                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| 02   | ~~頭腦用 direct tools 還是受限 script runtime~~ 已定（2026-10-20 spike）：direct tools                         |
| 03   | 偏好確認由頭腦判斷還是程式碼判斷                                                                               |
| 04   | ~~「事情本身是時間」用 `auto_close` flag 還是頭腦判斷~~ 已定（2026-10-20）：anchor 上的 flag                   |
| 07   | ~~「Allow again in this session」for `unsandboxed_bash` / `Outbound`~~ 已定（2026-10-21）：做                  |
| 08   | ~~research profile；`scratch.md` 升格~~ 已定（2026-10-21）：task policy；升格                                  |
| 09   | ~~第一版來源範圍~~ 已定（2026-10-21）：Gmail IMAP、ICS + CalDAV、Moodle API；學校 Gmail 的 app password 待確認 |
| 10   | ~~「話題」怎麼判；面孔封存~~ 已定（2026-10-21）：頭腦用 `topic` 工具標；封存的面孔變灰、可隱藏                 |
| 11   | ~~討論串是側欄還是第二欄；引擎蓋留不留 session rename~~ 已定（2026-10-21）：桌面共用右欄；只留 rename          |
| 13   | ~~版本號 1.0.0 vs 0.10.0~~ 已定（2026-10-22）：0.10.0+harmony，不發版；另定 cherry-pick、檔名等，見 13         |

## 每份 plan 的格式

目標 · 依賴 / 被依賴 · 決定（已定，引用 decisions.md）· 設計 · 工作項目（checkbox）· 驗證 · 文件 · 實作前待決。工作項目完成後打勾並記日期；驗證結果寫在 plan 內，不另開 diary。
