# 12 Android：跟著 API 走

[重寫](README.md) · [direction §4](../../docs/architecture/direction.md) · [盤點 §6.2](inventory.md) · [mobile](../mobile.md)

**目標**：Android 客戶端用同樣的形狀：房間列表、訊息列、成員、討論串、引擎蓋；通知指向房間。Renderer（`lib/rendering/`、87K 行）與平台 plumbing 全留；重寫的是 `live/` 裡綁 session 的 ~39K 行與 Kotlin 的 gateway/domain 層。

**依賴**：11（API 與事件詞彙定案後才開始；web 是參考實作）。**被依賴**：無。

## 設計（對照盤點 §6.2）

**留**：`lib/rendering/**`、`live/` 的 document 子集（23 檔）、`*_pane.dart` / `*_state.dart` / `side_panel.dart` / `jobs_menu.dart`（引擎蓋）、provider / pairing / grant、Kotlin `Native*` / canvas / media / push 註冊。

**重寫**：`live/{app,gateway,scoped_gateway,session_sidebar,session_row,conversation_header,mobile_tabs}.dart` → rooms / faces / threads 的 app state 與導航；Kotlin `GatewayBridge` / `GatewayRuntime` 的 domain 部分（傳輸層重用）、`PircApi` / `Models` / `Work` / `SessionGroups` / `core/timeline`。

**改**：`conversation_timeline` / `timeline_models` / `timeline_tools` / `conversation_composer` / `composer_dock` → 訊息列四種 kind、面孔、line 撤銷、question、討論串入口；`memory_settings` / `assistant_settings` / `settings*` → 面孔頁 / 主持人頁 / 來源；`notification_settings` → 房間目標；Kotlin `GatewayNotifications` / `QuickReplyService` / `QuestionNotificationIdentity` / `GatewayOverlayService` → 通知指向房間、快速回覆 = 送房間訊息；`app_document_route.dart` 的路由目標。

**Typing**：composer 按鍵節流送 `POST /api/rooms/:id/typing`；長按送出 = `send_now`。

**Parity**：`fixtures/mobile-parity/` 的 UI fixture 重新擷取（web 11 之後）；renderer fixture 不動；`fixtures/timeline/` 的 room/thread case 在 `core/timeline` 的 Kotlin port 跑。

## 工作項目

- [ ] Kotlin 傳輸層抽離 domain（`GatewayBridge` 拆 transport / domain）；domain 重寫。
- [ ] Dart app state 與導航重寫；房間列表、訊息列、成員、討論串、引擎蓋 tab。
- [ ] 通知與快速回覆改房間；UnifiedPush 註冊不變。
- [ ] 設定頁整理；來源 / 面孔頁。從 [03](03-memory.md) 來的：`live/attention.dart` / `memory_settings.dart` 還讀舊的 `/api/memory`（`user`/`notes`）與 `/api/memory/entries/:id/*`，要改成 `/api/memory/preferences`（偏好：remove / forget / restore / history）與 `/api/memory/records`（事實：瀏覽、搜尋、`DELETE`），房間 line 的 `body.memory` 加「Don't keep」；相關測試與 `tool/parity/capture_web.mjs` 一起改。
- [ ] parity fixtures 重擷取；timeline Kotlin port 跑新 golden cases。從 [00](00-demolition.md) 留下來的：`settings-matrix.json`（`assistant` tab、memory proposals、`/api/assistant/{node,prompts}`、chat node）及讀它的 `tool/parity/capture_{settings,notification}_matrix_{web.mjs,test.dart}`、`compare_settings_matrix.mjs`、`notification-matrix.json`，都 pin 在已不存在的 web revision `bd3d909`，重擷取前要改 pin 並拿掉退場的 tab 與 API；`app-document-routes.json` 等相鄰的 app-document fixture 也 pin 在同一個 revision。
- [ ] 刪 00 沒刪乾淨的舊畫面與測試。
- [ ] `flutter analyze`、unit/widget suite、Kotlin unit tests；integration tests 中綁舊導航的改寫。

## 驗證

- 模擬器：上述 suite 全綠；`fixtures/mobile-parity` 的 UI case 通過。
- 真機（[mobile.md](../mobile.md) 的 acceptance 清單依 existing-plans §5 修訂後）：配對、串流/取消/重連、通知點進房間、快速回覆、討論串插話、引擎蓋 terminal / browser 接管、CJK IME、release build。

## 文件

- `apps/android/README.md`；`plans/mobile.md` 依 existing-plans §5 修訂（renderer 項目留、UI 驗收重列、frozen corpus 重凍）。

## 實作前待決

- 是否用這次機會把 `GatewayBridge.kt`（1,545 行）/ `GatewayRuntime.kt`（1,276 行）拆成更小的檔；建議拆，但限於 transport / domain 兩層，不做更大的重構。
