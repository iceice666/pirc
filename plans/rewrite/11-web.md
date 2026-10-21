# 11 Web：Discord 形狀收尾與引擎蓋

[重寫](README.md) · [direction §4](../../docs/architecture/direction.md) · [盤點 §6.1](inventory.md)

**目標**：01–10 各自帶了最小 UI；這份 plan 把 web 收成 direction §4 的形狀：一個 server、一個房間列表、訊息列、成員列表、討論串、原地更新的進度、房間裡問你、小字 line 與撤銷、引擎蓋頁、通知指向房間；並刪掉所有舊導航。Android 跟著 API（12）。

**依賴**：01–10（可在 06 之後就開始，與 09/10 平行收尾）。**被依賴**：12。

## 決定（已定，2026-10-21 討論）

- 討論串在桌面是**側欄**，與成員列表共用右欄（討論串優先，開著時成員列表讓位）；手機上討論串是全頁。
- 引擎蓋的 session **只留 rename**；pin/settle 刪。
- `progress` 訊息由 **web 自己推導**（討論串的工人狀態 + session 狀態），gateway 不寫也不更新 progress 訊息；`MessageKind::Progress` 繼續是保留值，等真的有需要才接。
- 「這個房間靜音」存在**本機**（localStorage，跟 layout/draft 一起），不動 gateway；Android 之後各自做。
- 引擎蓋的 session 詳情是**唯讀 transcript**，加「回它所屬的房間」的連結；送訊息只在房間。
- 設定的分頁收成 **Models & sources / Devices / Notifications / About**；loops、wakes、記憶瀏覽移到引擎蓋，偏好留在主持人頁。

## 設計（對照盤點 §6.1）

**版面**：左：房間列表（活動排序、未讀點、「等你回話」標記、封存折疊）+ 底部「引擎蓋」「設定」；中：房間（訊息列 + composer）；右（或 tab）：成員列表。手機：底部 tab 房間 / 成員 / 引擎蓋 / 設定（`MobileTabs` 改）。

**訊息列**（`Message.svelte` 改）：頭像、名字（面孔色）、時間、內容；連續同 speaker 折疊頭像；`kind='line'` 小字可展開（記下了 / 掛上了 / 叫了工人 / 我晚點回來看），每種有一句話撤銷按鈕（呼叫對應 API）與「引擎蓋」連結；`kind='progress'` 由 web 推導後原地更新（討論串的工人狀態 + `RunCard`/`TodoDock` 的資料，呈現成一則訊息；gateway 不寫 progress 訊息）；`kind='question'` 突出顯示 + 「等你回話」。

**討論串**（06 的面板收尾）：anchor 訊息下「進行中（3 人）/ 完成」摘要列，點開側欄：工人列表（名字、狀態點、縮排）、工人事件（`ToolCard` 沿用於 tool 摘要）、插話框；thread 內的 question。

**成員列表 / 面孔頁**（10 的收尾）：presence 點四態；面孔頁即設定；主持人頁含 SOUL/CHAT 編輯（`AssistantPromptEditor` 沿用）、偏好、debounce 秒數。

**引擎蓋**（`/engine`）：今天的 Work 面整個搬進來：sessions by node、`SidePanel` 的 files/git/diff/terminal/browser/memory/context/tasks tabs、`JobsMenu`、node 卡片（能力、load）、wakes 清單、brain turns、記憶瀏覽、loops 清單、sources 狀態。從房間的 line / 討論串可深連結到對應 session（`?session=`）；session 詳情是唯讀 transcript + 「回房間」連結，沒有 composer。session 只留 rename。不再有 Chat/Work 切換；`Sidebar.svelte` 的 workspace/session 樹只在這裡。

**設定**（`SettingsDialog` 改）：四個分頁——Models & sources（backends + 09 的來源）、Devices、Notifications（目標改為房間；「這個房間靜音」存 localStorage）、About（含 PWA）。loops / wakes / 記憶瀏覽搬去引擎蓋，偏好留在主持人頁；schedules / projects / memory approvals / assistant-node tabs 由 00 刪掉。

**狀態層**（`app.svelte.ts`、`state.ts`、`api.ts`、`types.ts` 重寫）：room-first；`EventEnvelope` 的 room / thread / face / presence / loop / wake 事件 reducer；worker session 狀態只在引擎蓋載入（`panel-api.ts` 沿用）；`storage.ts` 的 draft / read / 選取改以 room 為 key；`push.ts` 的 deep link → room。

**刪除**：`Sidebar.svelte` 的 Chat 分支、`WorkspacePage.svelte`（拆成引擎蓋的 workspace 詳情 + 面孔頁的地盤）、`chats.ts`、`modes.ts` 的 Chat/Work 推導、`work.ts` 的 pin/settle、`mock.ts` 重寫成 rooms/faces/threads 的 demo 資料。

## 工作項目

- [x] 狀態層重寫與事件 reducer；`fixtures/timeline/` 的 room/thread golden cases。（2026-10-21）跟計畫不同：不是重寫 `app.svelte.ts`，而是讓兩邊分家。房間的事件改成純函式 `lib/room-events.ts`（`reduceRoomEvent(view, event) → {patch, effects}`，effects 是 `mark_read` / `refresh_room` / `refresh_list` / `refresh_thread_workers`），`RoomsState` 只保存結果並執行 effects。`app.svelte.ts` 改名 `engine.svelte.ts`（`engine` 單例，只給引擎蓋用）；`MemorySettings` 改收 `revision` prop，房間頁因此不再載入引擎的狀態，`boundaries.test.ts` 走靜態 import 守住兩個方向。草稿以房間為 key（`relay.room-draft.<room>`，切房間、重載都在）。`fixtures/timeline/rooms` 的投影加了 thinking、face presence、faces、開著的討論串、loop/wake 版本與 effects，新案例 `faces-and-a-thread.json`；fixture 測試直接跑 reducer。驗證：web `vitest` 50 檔 348 個、`svelte-check` 0/0、build。
- [x] 版面與房間列表；手機 tabs。（2026-10-21）房間列表照活動排序、未讀點、「輪到你」；封存的房間收在列表下的「Archived」摺疊（`GET /api/rooms?archived=1`，點開才載入）。`MobileTabs` 改成兩頁共用、tab 由頁面給：房間頁是 Rooms（徽章＝等你回的房間數）/ Members / Engine（連結）/ Settings，引擎蓋是 Rooms（連結）/ Engine（徽章＝等你的 session）/ Settings；手機上側欄、成員、討論串都停在 tabs 上方。驗證：`rooms.svelte.test.ts`、`Engine.test.ts` 的 tabs 案例；web `vitest` 50 檔 351 個、`svelte-check` 0/0、build。
- [x] 訊息列四種 kind；line 撤銷；progress 原地更新；question。（2026-10-21）照決定，「正在做」由 web 自己推：reducer 從 `thread_message(_updated)` 記下每個討論串工人最後做的事（`threadActivity`，不管討論串開沒開），工作中的錨點訊息原地顯示那一行；gateway 不寫 progress（Android 照做同一推導）。`kind='progress'` 若出現就畫成原地更新的 line（`role=status`）。line 撤銷沿用 plans 03–05 的 Don't keep / loop / Cancel，另加「Details」連到引擎蓋對應分頁。還在等的問題（最新一則）釘在 composer 上方、「Show」捲過去。fixture 加 `threadActivity`。驗證：web `vitest` 50 檔 353 個、`svelte-check` 0/0、build。
- [x] 討論串側欄；成員列表與面孔頁；主持人頁。（2026-10-21）照決定：桌面上討論串和成員列表/面孔頁共用右欄、討論串優先，手機全頁（plans 06、10 已做好的元件）；這裡補了討論串標頭到工人 session 的引擎蓋深連結（`/engine?session=`）。主持人頁就是 host 的面孔頁，偏好在上面（`MemorySettings`）。驗證：同上。
- [x] 引擎蓋頁與深連結；`SidePanel` 升格。（2026-10-21）`/engine` 預設開首頁 `EngineOverview`：Nodes（能力、GPU、load、workspaces）、Brain（每房間 turns：原因、結果、耗時、tokens，`lib/brain.ts`）、Open loops、Wakes、Memory、Sources（健康、最後讀取、哪些房間跟），每頁 `?open=<tab>` 可深連；側欄頂的「Overview」回首頁。通知的 `{memory}` 目標改開 `?open=memory`。session 照決定唯讀：沒有 composer，底部「回房間」（工人的 session 連回它的房間）；session 只剩 rename（pin/settle、新 session、刪除都拿掉）。`SidePanel`（files/git/diff/terminal/browser/memory/context/tasks）留在 session 旁。`WorkspacePage` 搬成 `engine/WorkspaceDetail.svelte`。Loops/Wakes 設定元件改收 `revision`/`roomNames` prop，引擎蓋因此不載入房間狀態。驗證：`EngineOverview.test.ts`、`Engine.test.ts`、`boundaries.test.ts`；web `vitest` 51 檔 358 個、`svelte-check` 0/0、build。
- [x] 設定整理；通知目標改房間。（2026-10-21）照決定只剩四個 tab：Models & sources / Devices / Notifications / About，兩頁共用同一個對話框（房間列表底部與手機 tab 開啟）；loops、wakes、記憶搬到引擎蓋，偏好在主持人頁，Devices 的節點清單改指向引擎蓋。「這個房間靜音」照決定只存在這台裝置：localStorage `relay.muted-rooms`，複製一份到 service worker 讀得到的 cache（`lib/mute.ts`），`sw.js` 收到房間通知時，靜音或正在看那個房間就不顯示；房間標頭有鈴鐺，Settings → Notifications 可解除。驗證：`service-worker-push.test.ts` 新案例、`rooms.svelte.test.ts`；web `vitest` 51 檔 360 個、`svelte-check` 0/0、build。
- [x] 刪舊導航與元件；`mock.ts` demo。（2026-10-21）刪了 session 的 `Composer`/`ComposerSelect`、`GoalDock`/`TodoDock`/`DockSection`、`goal.ts`/`todo.ts`、`NewSessionDialog`、pin/settle（側欄、workspace 詳情、`work.ts` 的 `pinnedFirst`、Settings 的「Show done」），`engine.svelte.ts` 的 draft/upload/model/指令/分支編輯，`api.ts` 的 `command`/`createSession`/`deleteSession`/`upload`/`models` 與對應型別、session 草稿。（Chat 分支、`chats.ts`、`modes.ts` 的 Chat/Work 推導在先前的計畫已不存在。）`mock.ts` 加了房間、面孔、一則工人討論串的 demo：dev build 連不到 gateway 時 `RoomsState` 用它（不開 socket、送出只留在本機），production build 不含它；引擎的 demo session 留著（測試也用）。驗證：web `vitest` 47 檔 328 個、`svelte-check` 0/0、build，`dist` 不含 mock chunk。
- [x] a11y：房間列表 / 訊息列 / 討論串的鍵盤導航與 live region（沿用 `a11y.ts`）。（2026-10-21）房間列表用 `rovingFocus`（上下鍵、單一 tab stop：開著的房間）；訊息與討論串是 `role=log`、`aria-live=off` 的 tab stop，新的 `listFocus` 讓上下鍵/Home/End 一則一則讀（從列表本身進去由最新一則開始）；別人寫完的訊息由獨立的 live region 唸一次（串流中不唸、自己的不唸）；Alt+↑/↓ 換房間，Escape 關討論串/右欄/手機列表；討論串狀態是 `role=status`。驗證：`rooms.svelte.test.ts` 鍵盤與 live region 案例。
- [x] 測試：元件測試改寫；`App.test.ts` 改成 room-first 流程；`api.test.ts` 事件 normalize。（2026-10-21）新 `App.test.ts`：`/` 開 #general、`?room=` 開指定房間、`/engine?open=` 開引擎蓋分頁，都不載入另一邊的狀態；房間串流的過濾、ready/reset/壞 frame、cursor 在新 `rooms-stream.test.ts`（`api.test.ts` 留 session 事件，刪掉 `command` 的案例）；Sidebar/WorkspaceDetail/Engine/memory/loops/wakes 測試跟著改。總驗證：web `vitest` 49 檔 336 個、`svelte-check` 0/0、build（不含 mock）；`size:check` gateway 17.57 MiB / node 19.02 MiB；conformance 66 個 suite 中 65 個過，只有 `node_browser` 的 4 個因 sandbox 開不了 Chromium 失敗（同 plan 10）。`format:check` 只抱怨既有的 `crates/pirc-config/src/modes/scratch.md`（10f5322，非本計畫）。沒有真模型，手動情境未跑。

## 驗證

- `bun run --filter @pirc/web test`、typecheck、build；conformance 的 web 相關 snapshot（`routes`、`events`）。
- 手動：桌面 + 手機寬度各走一遍：送訊、看面孔回、交辦 → 討論串、line 撤銷、question 回答、引擎蓋看 session、通知點進房間。

## 文件

- `apps/web/README.md`；`docs/guides/` 新 guide「房間、面孔、引擎蓋」取代 `session-ui.md`。

## 實作前待決

- ~~討論串是側欄還是 Discord 式的「開在右邊的第二欄」~~ 已定（2026-10-21）：桌面側欄，與成員列表共用右欄（討論串優先，開著時成員列表讓位）；手機上討論串是全頁。
- ~~引擎蓋要不要保留 session 的 rename/pin/settle~~ 已定（2026-10-21）：只留 rename（引擎蓋內找 session 用），pin/settle 刪。
