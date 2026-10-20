# 10 面孔：名字、角色、地盤、誰回話、搬家

[重寫](README.md) · [direction §2.8 / §4](../../docs/architecture/direction.md) · [決定](decisions.md)

**目標**：你看到很多張面孔、底下一個頭腦。主持人永遠存在；每個專案一張預設面孔；`@面孔` 在任何房間可用；誰回話由頭腦依固定規則決定；每則訊息標誰說的；成員列表是設定入口；主持人會提議搬家。

**依賴**：02、03、04、06（面孔的「正在做」）、08（地盤 = linked workspaces）。**被依賴**：11。

## 決定（已定）

- 預設每專案一張；schema 允許多張，第一版無建立 UI（#9）。
- 回話規則：被 `@` 的 > 這個話題上一個開口的 > 專案預設面孔 > 主持人（#9）。
- 搬家：頭腦判斷 + 護欄（同話題 ≥ 15 則且命中另一房間範圍；一天一次）（#11）。
- 面孔是展示層：沒有自己的記憶、loop、紅線（§2.8）。

## Schema（01 建的 `faces` 擴充）

```sql
faces(id, name, bio, tone, avatar, color, role_md,         -- role_md = 今天的 project instructions
      territory_json,   -- {rooms: [...], workspaces: ["node:ws", ...], sources: [...]}
      is_host, created_at, archived_at NULL)
```

`room_messages.speaker` 的值：`user`、`face:<id>`。`open_loops.face_id`、`memory_records.face_id`、`delegations.face_id` 已在前面的 plan 留欄。

## 設計

**主持人**：`is_host` 唯一；`role_md` = CHAT.md 的角色部分（02 的 identity 拆成 SOUL（頭腦）+ host 的 role）；地盤 = `#general` + 沒人負責的一切。

**專案面孔**：建立方式——你說「幫 SlimeOS 開個負責人」或在成員列表「新增」（這是唯一的建立 UI，不是「一專案多張」的 UI）；頭腦建立時帶 `territory.workspaces`（08 的 linked workspaces）、建或指定一個房間。`project_links` 表的 owner 改成 `face_id`。

**路由**（`brain/turn.rs`）：turn 開始前程式碼算「候選面孔」：批次裡的 `@` → 固定；否則房間裡上一個開口的面孔（最近 N 則）；否則房間的預設面孔；否則主持人。候選交給頭腦，頭腦可在 turn 內切換（工具 `speak_as {face}`，一個 turn 多張面孔說話，如主持人交辦 + PM 回報）；每則輸出訊息標 speaker。**面孔不互相對話**：`speak_as` 的文案規則寫進 CHAT.md（只交辦與回報）。

**Prompt**：section `## 你現在是`（`fresh_each_turn`）：候選面孔的名字、自介、口吻、`role_md`、地盤、它負責的 open loops（04 的投影按 face 過濾放前面）。記憶共享不過濾（§2.8）。

**Presence**（02 的 `brain_presence` 擴成 per-face）：`idle` / `thinking`（turn 正在以它為候選）/ `working {line}`（它有跑中的 worker 或研究 wake，06/05 推導）/ `waiting`（它在房間裡問了你、還沒回）。

**Self-wake 戴面孔**（05）：wake 的 room → 房間預設面孔；來源觸發 → 地盤含該來源的面孔；都沒有 → 主持人。

**搬家**：turn 結束後程式碼檢查護欄（同房間最近 15 則同話題——話題由頭腦在 turn 內標記 `topic` 工具或由 OM 的 observation 聚類；命中另一房間的 `territory`/`source_scope`；今天沒提過）→ 下一 turn 給主持人一個提示，它用 `question` 問「去 #X 聊？」；你說好 → `POST /api/rooms/:id/move`（01），loops 的 `room_id` 跟著改。

**成員列表 / 面孔頁**：房間右側列出面孔 + presence；點進去：名字、自介、角色（可編）、地盤（房間 / workspaces / 來源勾選）、它掛著的 loops、最近做了什麼（delegations + wakes）；主持人頁 = SOUL/CHAT + 偏好（03）。改名、改角色、改地盤立即存、下一 turn 生效。

## 工作項目

- [ ] schema 擴充；`project_links` owner → face；host 面孔初始化。
- [ ] `brain/faces.rs`：store、建立/封存、路由候選計算、`speak_as`、presence 推導。
- [ ] prompt section 與 CHAT.md 預設文案（交辦/回報規則、不互聊）。
- [ ] wake 戴面孔（05 的 room/face 選擇）。
- [ ] 搬家護欄與提議流程；`topic` 標記。
- [ ] API：`GET/POST/PATCH /api/faces`、`GET /api/faces/:id/activity`；事件 `face_changed`、`face_presence`。
- [ ] Web：成員列表、面孔頁（含主持人頁吸收 AssistantSettings / MemorySettings 的偏好）、訊息列的頭像/名字/顏色、`@` 補全。
- [ ] conformance：`brain_faces.rs`：`@PM` 由 PM 回；無 `@` 時上一個開口的回；一 turn 兩張面孔各一則；wake 戴對面孔；搬家護欄 14 則不提、15 則提、一天一次。

## 驗證

- conformance `brain_faces`；手動：在 `#general` 問「SlimeOS 的 PR 怎樣」→ 主持人交辦 → PM 回；聊 15 則後主持人提議搬家。

## 文件

- `docs/guides/` 新 guide 的面孔段；`docs/architecture/prompt-context.md` 的面孔 section。

## 實作前待決

- 「話題」怎麼判：頭腦標 `topic` 工具 vs 純 OM 聚類；建議頭腦標（便宜、可控）。
- 面孔封存：專案結束後面孔留在成員列表（灰）還是隱藏；建議灰 + 可隱藏。
