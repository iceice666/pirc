# 11 Web：Discord 形狀收尾與引擎蓋

[重寫](README.md) · [direction §4](../../docs/architecture/direction.md) · [盤點 §6.1](inventory.md)

**目標**：01–10 各自帶了最小 UI；這份 plan 把 web 收成 direction §4 的形狀：一個 server、一個房間列表、訊息列、成員列表、討論串、原地更新的進度、房間裡問你、小字 line 與撤銷、引擎蓋頁、通知指向房間；並刪掉所有舊導航。Android 跟著 API（12）。

**依賴**：01–10（可在 06 之後就開始，與 09/10 平行收尾）。**被依賴**：12。

## 設計（對照盤點 §6.1）

**版面**：左：房間列表（活動排序、未讀點、「等你回話」標記、封存折疊）+ 底部「引擎蓋」「設定」；中：房間（訊息列 + composer）；右（或 tab）：成員列表。手機：底部 tab 房間 / 成員 / 引擎蓋 / 設定（`MobileTabs` 改）。

**訊息列**（`Message.svelte` 改）：頭像、名字（面孔色）、時間、內容；連續同 speaker 折疊頭像；`kind='line'` 小字可展開（記下了 / 掛上了 / 叫了工人 / 我晚點回來看），每種有一句話撤銷按鈕（呼叫對應 API）與「引擎蓋」連結；`kind='progress'` 原地更新（沿用 `RunCard`/`TodoDock` 的資料，呈現改成一則訊息）；`kind='question'` 突出顯示 + 「等你回話」。

**討論串**（06 的面板收尾）：anchor 訊息下「進行中（3 人）/ 完成」摘要列，點開側欄：工人列表（名字、狀態點、縮排）、工人事件（`ToolCard` 沿用於 tool 摘要）、插話框；thread 內的 question。

**成員列表 / 面孔頁**（10 的收尾）：presence 點四態；面孔頁即設定；主持人頁含 SOUL/CHAT 編輯（`AssistantPromptEditor` 沿用）、偏好、debounce 秒數。

**引擎蓋**（`/engine`）：今天的 Work 面整個搬進來：sessions by node、`SidePanel` 的 files/git/diff/terminal/browser/memory/context/tasks tabs、`JobsMenu`、node 卡片（能力、load）、wakes 清單、brain turns、記憶瀏覽、loops 清單、sources 狀態。從房間的 line / 討論串可深連結到對應 session。不再有 Chat/Work 切換；`Sidebar.svelte` 的 workspace/session 樹只在這裡。

**設定**（`SettingsDialog` 改）：backends + 來源（09）、裝置、通知（目標改為房間；「這個房間靜音」）、PWA。刪 schedules / projects / memory approvals / assistant-node tabs（00 已刪多數）。

**狀態層**（`app.svelte.ts`、`state.ts`、`api.ts`、`types.ts` 重寫）：room-first；`EventEnvelope` 的 room / thread / face / presence / loop / wake 事件 reducer；worker session 狀態只在引擎蓋載入（`panel-api.ts` 沿用）；`storage.ts` 的 draft / read / 選取改以 room 為 key；`push.ts` 的 deep link → room。

**刪除**：`Sidebar.svelte` 的 Chat 分支、`WorkspacePage.svelte`（拆成引擎蓋的 workspace 詳情 + 面孔頁的地盤）、`chats.ts`、`modes.ts` 的 Chat/Work 推導、`work.ts` 的 pin/settle、`mock.ts` 重寫成 rooms/faces/threads 的 demo 資料。

## 工作項目

- [ ] 狀態層重寫與事件 reducer；`fixtures/timeline/` 的 room/thread golden cases。
- [ ] 版面與房間列表；手機 tabs。
- [ ] 訊息列四種 kind；line 撤銷；progress 原地更新；question。
- [ ] 討論串側欄；成員列表與面孔頁；主持人頁。
- [ ] 引擎蓋頁與深連結；`SidePanel` 升格。
- [ ] 設定整理；通知目標改房間。
- [ ] 刪舊導航與元件；`mock.ts` demo。
- [ ] a11y：房間列表 / 訊息列 / 討論串的鍵盤導航與 live region（沿用 `a11y.ts`）。
- [ ] 測試：元件測試改寫；`App.test.ts` 改成 room-first 流程；`api.test.ts` 事件 normalize。

## 驗證

- `bun run --filter @pirc/web test`、typecheck、build；conformance 的 web 相關 snapshot（`routes`、`events`）。
- 手動：桌面 + 手機寬度各走一遍：送訊、看面孔回、交辦 → 討論串、line 撤銷、question 回答、引擎蓋看 session、通知點進房間。

## 文件

- `apps/web/README.md`；`docs/guides/` 新 guide「房間、面孔、引擎蓋」取代 `session-ui.md`。

## 實作前待決

- 討論串是側欄還是 Discord 式的「開在右邊的第二欄」：手機上只能是全頁；桌面建議側欄（與成員列表共用右欄）。
- 引擎蓋要不要保留 session 的 rename/pin/settle：建議只留 rename（引擎蓋內找 session 用），pin/settle 刪。
