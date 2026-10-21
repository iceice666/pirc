# 12 Android：跟著 API 走

[重寫](README.md) · [direction §4](../../docs/architecture/direction.md) · [盤點 §6.2](inventory.md) · [mobile](../mobile.md)

**目標**：Android 客戶端用同樣的形狀：房間列表、訊息列、成員、討論串、引擎蓋；通知指向房間。Renderer（`lib/rendering/`、87K 行）與平台 plumbing 全留；重寫的是 `live/` 裡綁 session 的 ~39K 行與 Kotlin 的 gateway/domain 層。

Android 目前沒有房間程式碼（`lib/` 與 Kotlin 都沒有 `/api/rooms`、`/api/faces` 的呼叫，95 個 `live/*.dart` 一個都沒有），所以房間這一層是**新寫**，不是改寫。

**依賴**：11（API 與事件詞彙定案後才開始；web 是參考實作）。11 完成於 `557c7ba`（2026-10-21），依賴已解除。**被依賴**：無。

## 決定（已定，2026-10-21）

| #   | 決定                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **靜音在裝置端**：Android 用 SharedPreferences 存房間清單（等價於 web 的 `relay.muted-rooms`），不開 gateway 端點；推播進來時先看本機靜音與是否正在看那個房間，是就不顯示。                                                   |
| 2   | **拆 transport / domain**：`GatewayBridge.kt`（1,402 行）與 `GatewayRuntime.kt`（1,260 行）拆成兩層，只拆這一層，不做更大的重構；傳輸留，domain 重寫。                                                                        |
| 3   | **引擎蓋照 web 六頁**：Nodes（能力、GPU、load、workspaces）、Brain turns、Loops、Wakes、Memory、Sources，加等價的深連（web 的 `?open=`）。                                                                                    |
| 4   | **timeline Kotlin port 改房間推導**：照 web 的 `room-events.ts`；舊 session timeline port 退場，手機不再把 session 顯示成對話，引擎蓋的 session 只留 panes。                                                                  |
| 5   | **parity fixture 不重擷取**：退場畫面的 fixture 與 settings / notification 兩套 matrix 工具刪掉；renderer 類原位不動（舊 `webRevision` pin 當 provenance）；房間與討論串的正確性靠 `fixtures/timeline/rooms` 的 golden case。 |
| 6   | **驗證分工**：實作者跑 `flutter analyze` 與 unit/widget suite（`nix develop` 的 flutter344）；integration、模擬器與真機驗收由使用者跑。                                                                                       |

## 設計（對照盤點 §6.2）

**留**：`lib/rendering/**`、`live/` 的 document 子集（23 檔）、`*_pane.dart` / `*_state.dart` / `side_panel.dart` / `jobs_menu.dart`（session 側欄）、provider / pairing / grant、Kotlin `Native*` / canvas / media / push 註冊。

**重寫**：`live/{app,gateway,scoped_gateway,session_sidebar,session_row,conversation_header,mobile_tabs}.dart` → rooms / faces / threads 的 app state 與導航；Kotlin `GatewayBridge` / `GatewayRuntime` 依決定 2 拆兩層後重寫 domain 部分（傳輸層重用），`PircApi` / `Models` / `Work` / `SessionGroups` / `core/timeline`（依決定 4 換成房間推導）。

**改**：`conversation_timeline` / `timeline_models` / `timeline_tools` / `conversation_composer` / `composer_dock` → 訊息列四種 kind、面孔、line 撤銷、question、討論串入口、房間附件上傳；`memory_settings` / `assistant_settings` / `settings*` → 面孔頁 / 主持人頁 / 來源；`notification_settings` → 房間目標與本機靜音；Kotlin `GatewayNotifications` / `QuickReplyService` / `QuestionNotificationIdentity` / `GatewayOverlayService` → 通知指向房間、快速回覆 = 送房間訊息；`app_document_route.dart` 的路由目標。

**Typing**：composer 按鍵節流送 `POST /api/rooms/:id/typing`（web 是 3 秒一次，gateway 的訊號活 6 秒）；長按送出 = `send_now`，跳過 debounce（決定 #16）。

**推導**：gateway 不寫 `progress`；「正在做」由 client 從 `thread_message(_updated)` 自己算（web 的 `threadActivity`，不管討論串開沒開），工作中的錨點訊息原地顯示那一行。房間列表的未讀與「輪到你」也照 web 的規則推。

**通知**：gateway 已經送 `room_message` 帶 `target {roomId}` 與 tag `room:<id>`（`crates/pirc-gateway/src/push.rs`），client 只解析；快速回覆送成房間的 user 訊息，走 3 秒 debounce。

**Parity**：依決定 5，`fixtures/mobile-parity/` 不再重擷取——退場畫面的 fixture 與 matrix 工具刪掉，renderer 類不動，`fixtures/timeline/rooms` 的 `faces-and-a-thread.json`、`two-users-and-a-move.json` 在 Kotlin port 跑。

## 工作項目

- [ ] Kotlin 傳輸層抽離 domain（`GatewayBridge.kt` 拆 transport / domain，決定 2）；domain 重寫成 rooms / faces / threads；`core/timeline` 換成房間推導，舊 session port 刪（決定 4）。
- [ ] Dart app state 與導航重寫；房間列表（未讀點、「輪到你」、Archived 用 `GET /api/rooms?archived=1` 點開才載入）、訊息列、成員、討論串、引擎蓋 tab；草稿以房間為 key（跟 web `relay.room-draft.<room>` 同語意）；`POST /api/rooms/:id/read` 與 `room_read`；面孔 presence 與 thinking（ephemeral `seq 0`、ready payload 的 `brain_presence`）。
- [ ] 訊息列：四種 kind（`text` / `line` / `progress` / `question`）；「正在做」照上面的推導；line 撤銷（Don't keep / loop / Cancel）與「Details」連到引擎蓋對應分頁；還在等的問題釘在 composer 上方；討論串入口與工人進度；附件上傳 `POST /api/rooms/:id/uploads` 與下載。
- [ ] 通知與快速回覆改房間；UnifiedPush 註冊不變。
- [ ] 引擎蓋六頁與深連（決定 3）：Nodes、Brain turns（`GET /api/brain/turns`）、Loops（`GET /api/loops`、`PATCH /api/loops/:id`）、Wakes（`GET /api/wakes`、`DELETE /api/wakes/:id`）、Memory（`GET /api/memory/preferences`、`GET /api/memory/records` 加 `DELETE`）、Sources（`/api/sources` 與 per-source 暫停）。
- [ ] 設定頁整理；面孔頁 / 主持人頁。從 [03](03-memory.md) 來的：舊的 `/api/memory`（`user` / `notes`）與 `/api/memory/entries/:id/*` 要改成 `/api/memory/preferences`（偏好：remove / forget / restore / history）與 `/api/memory/records`（事實：瀏覽、搜尋、`DELETE`），房間 line 的 `body.memory` 加「Don't keep」。真正打舊端點的是 `live/attention.dart`（`/api/memory`、`/api/memory/entries/{id}/forget|restore|history`）；`memory_settings.dart` 只讀 state（`a.memory['user'/'notes']`）。從 [04](04-open-loops.md) 來的：open loops 清單與房間 line 的 `body.loop {id, event}`（opened/reopened → 「Don't keep」、closed/demoted → 「Not done yet」），rooms 事件流的 `loop_changed`。
- [ ] parity：依決定 5 不重擷取。刪 `fixtures/mobile-parity/{settings-matrix,notification-matrix}.json` 與 `apps/android/tool/parity/` 下的兩套 matrix 工具（`capture_settings_matrix_test.dart`、`capture_settings_matrix_web.mjs`、`compare_settings_matrix.mjs`、`capture_notification_matrix_test.dart`、`capture_notification_matrix_web.mjs`、`compare_notification_matrix.mjs`），`capture_web.mjs` 裡跟著退場畫面走的部分一起收；`fixtures/timeline/rooms` 的 golden case 在 Kotlin port 跑。
- [ ] 刪 00 沒刪乾淨的舊畫面與測試：`lib/live/{attention,interaction,interaction_card}.dart`、Kotlin `core/Control.kt`，測試 `attention_test.dart`、`attention_history_resume_test.dart`、`interaction_parity_test.dart`、`interaction_remote_resolution_test.dart`；`workspace_*` 隨面孔頁重寫再收。
- [ ] `flutter analyze`、unit/widget suite、Kotlin unit tests；integration tests 中綁舊導航的改寫（決定 6：由使用者跑）。

## 驗證

- 實作者（決定 6）：`nix develop` 的 Flutter 跑 `flutter analyze`、unit/widget suite 與 Kotlin unit tests 全綠；`fixtures/timeline/rooms` 的 room/thread golden case 在 Kotlin port 通過。結果寫回本 plan。
- 使用者：模擬器與真機（[mobile.md](../mobile.md) 的 acceptance 清單依 existing-plans §5 修訂後）——配對、串流/取消/重連、通知點進房間、快速回覆（3 秒 debounce 後才開 turn）、本機靜音、討論串插話、引擎蓋六頁、terminal / browser 接管、CJK IME、release build。

## 文件

- `apps/android/README.md`（房間、引擎蓋六頁、本機靜音、驗證分工）；`plans/mobile.md` 依 existing-plans §5 修訂（renderer 項目留、UI 驗收重列、frozen corpus 由決定 5 取代）。

## 實作前待決

無（2026-10-21 六條已定，見上）。動工仍需另外取得使用者同意。
