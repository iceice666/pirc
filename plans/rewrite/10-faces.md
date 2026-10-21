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

- [x] schema 擴充；`project_links` owner → face；host 面孔初始化。（2026-10-21）pirc.sqlite schema 8（`migrations/8-faces.sql`）：`faces` 加 `role_md`、`territory_json`（`{rooms, sources}`）、`is_host`（唯一索引，host 由 seed 帶 1）、`archived_at`、`hidden_at`（決定 #18 的「可隱藏」）。跟計畫不同：(1) `territory.workspaces` 不存在 `territory_json`，就是該面孔的 `project_links`（重建成 `face_id` 為 owner；pirc.sqlite 從沒寫過聊天專案的 link，表是空的），沿用 repo clone 涵蓋；(2) 話題另存：`room_messages.topic` 與 `room_topics`（話題碰到的 workspace / source、上次提議時間、待給下一 turn 的 `hint_room_id`）。`db::tests::migrates_a_plan_01_database` 跟著改。
- [x] `brain/faces.rs`：store、建立/封存、路由候選計算、`speak_as`、presence 推導。（2026-10-21）名字 1–40 字、不含 `@`/`#`、不分大小寫唯一；一個房間最多屬於一張活著的面孔，`#general` 是 host 的；host 不能封存、地盤固定；只有封存的面孔能隱藏，取消封存時重新檢查它的房間。路由：批次（去掉名字後）裡 `@` 到的（整個名字、不分大小寫、不在 email 位址裡；中文前後不需空白）> 房間最近 20 則裡最後一個用自己的話（`text`，不算 line）開口、仍活著的面孔 > 房間的面孔 > host。`speak_as` 在 `brain/face_tools.rs`：之後寫的訊息、記的事實、開的 loop、叫的工人都標那張面孔（`RoomMemory::face`）。presence：`brain_presence` 照舊每房間一個，`face` 是真的面孔（切換時舊的 idle、新的 thinking）；另加每面孔的 `face_presence {faceId, state: thinking|waiting|working|idle, roomId?, line?}`，跟計畫不同：`waiting` 由它的工人 `waiting_input` 推導（不看 `room_reads.waiting_since`），`working` 的 line 是工人標題。
- [x] prompt section 與 CHAT.md 預設文案（交辦/回報規則、不互聊）。（2026-10-21）`## You are now`（id `face`，房間之後）：名字、自介、口吻、`role_md`、地盤、為什麼是它、一起被 `@` 的、其他面孔與 id。預設文案不寫進 CHAT.md（使用者的檔案），而是內建的 `## Faces`（`face-rules`，`built-in default`，在 house rules 之前、可被蓋過），含交辦/回報、不互聊、`@` 的自己答、`topic` 的用法。`## Open loops` 對專案面孔把它的 loop 排前面並標 `yours`；`## Workers` 把它的 linked workspaces 排前面並標 `yours`。
- [x] wake 戴面孔（05 的 room/face 選擇）。（2026-10-21）`faces::wake_face`：排程它的面孔（loop 的 `face_id`、叫 `schedule_wake` 的面孔，存在 `wakes.face_id`）> 來源 wake 的地盤含該來源的面孔 > 房間的面孔 > host；`speak` 以它說話。
- [x] 搬家護欄與提議流程；`topic` 標記。（2026-10-21）`brain/moving.rs`：`topic {name, workspace?, source?}` 標這個 turn 的訊息（人說的和它寫的）。turn 結束後檢查：房間最近 50 則 text 裡 ≥ 15 則是這個話題；另一個開著的房間涵蓋它碰到的東西（連到該 workspace 或其 clone 的面孔的房間，或 follow 該 source 的房間）而本房間沒有；同一話題今天（家裡時區）沒提過。跟計畫不同：提示不是 `question` 訊息，而是下一 turn 的 `## Maybe move` section（只給一次），主持人用話問；有人說好才 `move_room {to, quote}`（quote 用 03 的 `quoted` 驗證），這個房間在話題開始後開的 open loops 跟著搬（`loop_changed`）。`POST /api/rooms/:id/move` 也收選填的 `topic`。另加 `create_face`（要 quote，可順便開新房間）。`topic`、`create_face`、`move_room` 不在 wake 裡，結果也不算記憶的來源（`WRITING_TOOLS`）。
- [x] API：`GET/POST/PATCH /api/faces`、`GET /api/faces/:id/activity`；事件 `face_changed`、`face_presence`。（2026-10-21）`routes/faces.rs`：`GET /api/faces?hidden=1` 回 `{faces, presence}`、`GET /api/faces/:id`、`POST`、`PATCH`（`avatar`/`color` 可 `null`，`archived`、`hidden`）、`GET /api/faces/:id/activity`（`{loops, workers, wakes}`）；都 `no-store`、`PARAM_ROUTES` 加了。`face_changed {face}` 走 `#general` 的事件流（面孔不屬於任何房間），`face_presence` 是 ephemeral；房間 socket 的 `ready` 多了 `faces`。訊息多了 `topic`（沒有時不出現）。
- [x] Web：成員列表、面孔頁（含主持人頁吸收 AssistantSettings / MemorySettings 的偏好）、訊息列的頭像/名字/顏色、`@` 補全。（2026-10-21）`lib/faces.ts`；`components/rooms/MembersPanel.svelte`（房間標頭的 Members 按鈕；presence、「this room」、封存的變灰 + Hide / Show hidden、Add 新增後直接開它的頁）、`FacePanel.svelte`（名字、自介、口吻、avatar、顏色、角色、地盤勾選房間/workspaces/sources、Archive、它的 loops、最近的工人與 wake；主持人頁有 SOUL.md / CHAT.md 編輯與 `MemorySettings` 的偏好；AssistantSettings 在 00 已刪）。跟 06 的討論串一樣暫時是房間右側一欄（討論串開著時讓位，手機上蓋全頁），側欄或第二欄留給 11。訊息列用面孔的名字、顏色、avatar，名字可點開面孔頁；標頭顯示這個房間誰回話；composer 打 `@` 出清單（上下鍵、Enter/Tab 選、Esc 關）。
- [x] conformance：`brain_faces.rs`：`@PM` 由 PM 回；無 `@` 時上一個開口的回；一 turn 兩張面孔各一則；wake 戴對面孔；搬家護欄 14 則不提、15 則提、一天一次。（2026-10-21）另含：API 的錯誤路徑（名字撞到、`@`、`#general`、別人的房間、不存在的 workspace、未知欄位、host 不能封存/改地盤、未封存不能隱藏、空 PATCH、404）、自己房間由 PM 回、PM 的 prompt（`You are now`、`Faces`、`Workers` 的 `yours`、工具清單）、`move_room` 搬走 loop、`create_face`（錯的 quote 被拒）、封存後 `@PM` 由 host 回、隱藏與 `?hidden=1`、activity。測試扮演 `work` node。14/15 的精確門檻在 `moving::tests`（conformance 是 14 不提、16 提，因為一個 turn 會多兩則）。FakeLlm 加 `Reply::TextThenTool`（同一則回覆先說話再叫工具）。`brain`、`brain_loops`、`brain_memory`、`brain_wake`、`brain_workers`、`rooms`、`sources` 快照跟著新工具、section 與 `ready.faces` 更新。

## 驗證

- conformance `brain_faces`；手動：在 `#general` 問「SlimeOS 的 PR 怎樣」→ 主持人交辦 → PM 回；聊 15 則後主持人提議搬家。
- （2026-10-21）`cargo test -p pirc-gateway` 173 個通過（含 `faces::tests`、`moving::tests`、遷移測試）；clippy 乾淨；`bun run --filter @pirc/web build` + release build 後 conformance 66 個 suite 中只有 `node_browser` 的 4 個失敗：這個沙箱裡 Chromium 起不來（`launchPersistentContext: Target page, context or browser has been closed`），pirc-node 這次沒動；web `vitest` 49 檔 343 個、`svelte-check` 0/0；`size:check` gateway 17.57 MiB。手動情境沒有跑（沒有真的模型）。

## 文件

- `docs/guides/` 新 guide 的面孔段；`docs/architecture/prompt-context.md` 的面孔 section。（2026-10-21）`docs/guides/rooms-and-memory.md` 的 Faces 段；`prompt-context.md` 的 `face`、`face-rules`、`move` 與工具；`docs/development/gateway-and-node.md` 的 Faces 與路由、事件；`assistant-memory.md` 的 Project links 改成面孔的；`docs/deploy/upgrades.md` 的 schema 8。

## 實作前待決

- ~~「話題」怎麼判：頭腦標 `topic` 工具 vs 純 OM 聚類~~ 已定（2026-10-21）：頭腦用 `topic` 工具標（便宜、可控）。
- ~~面孔封存：專案結束後面孔留在成員列表（灰）還是隱藏~~ 已定（2026-10-21）：變灰留在列表，使用者可以隱藏。
