# 03 三層記憶：偏好、事實、自動撿取

[重寫](README.md) · [direction §2.4](../../docs/architecture/direction.md) · [決定](decisions.md) · [memory-search](../memory-search.md)

**目標**：頭腦有三層記憶——偏好（小、進 prompt）、事實（多、可搜尋、不進 prompt）、進行中的事（04）。寫入不審核、靠 origin tagging；記了什麼在房間裡用一行小字讓你看到、一句話可刪；OM 的 dropper 掉出 active pool 前先 promote 進事實層；每個 turn 開始前自動撿取「你可能記得」。

**依賴**：02。平行：[memory-search](../memory-search.md) phase 0–1（FTS5）是這份 plan 的檢索底層，先做或同做。**被依賴**：04、05、06、09、10。

## 決定（已定）

- 事實層放同一張 `memory_records` 加 `scope`（`repo:<key>` / `person`），`room_id`、`face_id` 為標籤（#5）。
- 記憶寫入不 approve；origin 由程式碼算，不由模型自述（§2.4、沿用 `assistant-memory.md` 的原則）。
- 「忘掉 X」是真忘：prompt、store、索引、OM ledger 都移除；tombstone 拒絕同文再學（§5 不變項）。

## 設計

**偏好層**：沿用 `memory_entries` 的 USER kind 概念，但改名 `preferences`：小（預設 2000 字元）、進 prompt、由頭腦**提議**（房間 line「要我記住你用 TLP 嗎？」）你一句話確認或你直接說。沒有 proposal 表：提議就是一則 `question` 訊息，你的下一句話由頭腦判斷是否確認；確認後寫入帶 `origin: user` + quote entry id。

**事實層**：`memory_records` 加欄 `scope`、`room_id`、`face_id`、`origin`（`user` / `tool:<source>` / `tool:delegation` / `om:promoted`）、`source_entry_ids`。person 列不綁 `node_id`/`ledger_key`（改成 nullable 或 sentinel）。寫入路徑：

1. 頭腦工具 `remember {text, origin_hint?}`：origin 由程式碼決定——turn 內只有 user 訊息 → `user`；turn 內讀過 connector/worker 結果 → `tool:<最近的來源>`（沿用 `current_origins` 的邏輯，從 `features/assistant` 搬出）。寫完房間出 line「記下了：…」，line 上有「不用記」。
2. OM promotion：`features/memory/agents.rs` 的 dropper 在移除 observation 前，呼叫 host 的 `promote(observation)`；brain host 寫進 person scope 帶 `origin: om:promoted`；worker host 沿用 workspace ledger。
3. 04 的 open loop 降級（`was_open_loop`）。

**自動撿取**：`brain/turn.rs` 在組 prompt 前，用「這批 user 訊息 + 目前 open loops 的『是什麼』」當 query，跑 FTS5（memory-search phase 1）取 top-N（預設 6、每條 ≤ 300 字元、含 origin 標示），放進 section `## 你可能記得`（`fresh_each_turn`）。延遲預算 200 ms；超時就不放。

**工具（頭腦）**：`remember`、`memory_search`（沿用，加 scope 參數）、`forget`、`recall`（沿用 remote recall 給 repo scope）。worker **沒有** person scope 的任何工具（§2.7）。

**撤銷**：line 上的「不用記」= `DELETE /api/memory/records/:id` → tombstone + FTS optimize + OM ledger 的對應 observation 標 forgotten。

## 工作項目

- [x] schema：`memory_records` 加欄；`memory_entries` → `preferences`；`memory_tombstones` 去 project scope；`memory_log` 的 actor 加 `face`/`om`。（2026-10-20）`pirc.sqlite` schema 3（`db/migrations/3-memory.sql`）：`memory_records` 加 `scope`（`repo`/`person`，CHECK）、`room_id`、`face_id`、`origin`、`source_entry_ids_json`、`created_at`；`preferences` 表（USER 列搬過來，`created_in_room`）；舊 MEMORY notes 變成 person 事實（origin `user` 或 `tool:assistant`），`memory_entries` 拿掉；tombstones 只留 `global` 的、去 `scope_id`；FTS5 表與 `search_index_meta`。**與決定 #5 的差異**：`scope` 存 `repo`/`person`，repo 的 key 沿用既有 `repo` 欄，不寫成 `repo:<key>`（沒有 repo 的 workspace 會變成 `repo:`）。person 列是偽 ledger（`node_id=''`、`ledger_key='person'`），不改 PK。actor：`user:<email>`、`face:host`、`om`。
- [x] `memory_records.rs`：person scope 的 ingest / search / forget；FTS 索引涵蓋 person 列（與 memory-search phase 1 合流）。（2026-10-20）`memory_records/person.rs`（remember 去重、拒絕 tombstone、forget 清內容/索引/log 並 optimize）、`memory_records/index.rs`（FTS 維護與啟動時重建）、`search_facts` / `recent` / `Scopes`；memory-search phase 0–1 見該 plan。
- [x] `brain/memory.rs`：`remember` / `forget` 工具、origin 計算、line 產生；偏好提議與確認的判斷。（2026-10-20）工具：`remember`、`memory_search`（`person` 預設 / `repo` / `all`）、`recall_note`（repo note 的 remote recall；叫 `recall` 會跟 OM 的 `recall` 撞名）、`save_preference`、`forget`。origin：`current_origins`/`find_quote` 從 `features/assistant` 搬到 `pirc-agent/src/origins.rs`；turn 內最新的工具結果決定 `tool:<name>`，否則 `user`。提議沒有工具：頭腦在回覆裡問，使用者答了之後 `save_preference` 帶 quote；quote 必須在最近三則 user 訊息裡（≥2 字可為片段，更短須是那人整句，例如「好」），同時決定是誰的偏好。**加嚴**：`forget` 也要 quote，所以讀到的內容沒辦法讓頭腦忘東西。line：`kind: line`、`body.memory {kind, id, origin, user}`（`memory/lines.rs`）；忘掉時 line 改寫成「Forgotten.」。事實的主人：turn 的第一位發話者。Brain host 的 direct tool 執行路徑（`agent.rs`）改成看 `available_tools`，feature 的工具才叫得到。
- [x] `features/memory/agents.rs`：dropper 前 `promote` hook；brain / worker 兩種 host 實作。（2026-10-20）hook 放在 `features/memory/mod.rs`（dropper 寫 `om.observations.dropped` 的地方）：`Promoter` trait + `feature_with`；失敗就不 drop、下次再試。brain 的 `BrainPromoter` 寫 person 事實（`om:promoted`、observation id + source entry ids、actor `om`、不出 line）；worker 沒有 promoter（照舊 workspace ledger）。頭腦的 room agent 現在帶 OM（mode 關掉 `repository`/`workspace_memory`，不寫 workspace ledger）。
- [x] `brain/turn.rs`：自動撿取 section。（2026-10-20）在 `scheduler.rs` 開 turn 時組進 base prompt（`memory::sections`）：`memory:preferences`（這個 turn 的人的偏好，永遠在）與 `memory:recalled`「You may remember」（用去掉名字的訊息查 person 事實，top 6、每條 ≤300 字、帶 origin；超過 200 ms 就不放並記 log）。放在 prompt 最後，persona/規則維持穩定前綴。open loops 的部分等 04。steer 進來的訊息不重新撿取。
- [x] API：`GET /api/memory/preferences`、`GET /api/memory/records?scope=&q=`、`DELETE …/:id`、`GET /api/memory/records/:id/history`（沿用 `memory/routes.rs` 的 view/history/restore/forget）。（2026-10-20）另有 `GET /api/memory`（同 preferences）、`POST /api/memory/preferences/:id/{remove,forget,restore}`、`GET /api/memory/records/:id`；全部 `no-store`、414 長參數規則照舊。node session 的 `memory.search`/`recall.remote` 仍拒絕（等 06 給工人工具，person scope 永不經這條路），`assistant.context`/`memory.note` 移除。
- [x] Web：主持人面孔頁的「偏好」區（10 之前先掛在 Settings）；記憶瀏覽頁（引擎蓋）；房間 line 的展開與「不用記」。（2026-10-20）`/engine` 的 Settings → Memory 同時是偏好區（History / Remove / Restore / Forget）與事實瀏覽（搜尋、Yours/Repositories/Both、person 事實可 Forget）；房間 line 點開顯示來處，「Don't keep」呼叫對應的 forget。Android 的 memory 設定仍讀舊格式，等 [12](12-android.md)。
- [x] memory-search phase 0 評估集加 person 語料與「自動撿取」查詢類。（2026-10-20）`ps01`–`ps15`、`recall` 類 7 個整句查詢。
- [x] conformance：`brain_memory.rs`：記下 → line → 不用記 → tombstone 拒絕同文；tool 結果推導的事實帶 `tool:*`；dropper 掉出的 observation 可被搜到；撿取 section 出現在 context snapshot。（2026-10-20）另含偏好的 quote 拒絕/接受、remove、錯誤路徑；`memory.rs`、`http.rs`、`brain.rs` 快照跟著新路由與工具更新。**dropper 那一項不在 conformance**：OM 的門檻在 conformance 叢集裡調不動、背景 worker 的模型呼叫順序也不固定，改由 gateway 單元測試 `brain::memory::tests::dropped_observations_become_searchable_facts` 直接驗 `BrainPromoter`。

## 驗證

- `cargo test -p pirc-gateway memory`、conformance `brain_memory` + `memory`、評估集 recall@8 不低於 baseline。
- 手動：告訴它「我用 TLP」→ 看到 line；一週後問「我電源管理用什麼」→ 答得出（不靠它主動搜）。

**結果（2026-10-20）**：`cargo test -p pirc-gateway` 122 passed（新增：person 事實、偏好 store、FTS 切詞與查詢、索引重建、schema 1→3 遷移含資料搬移、忘掉的事實的 token 在 checkpoint 後不在檔案裡（拿掉 optimize 時這個測試會失敗）、brain 的 remember→line→下一個 turn 撿取、偏好與 forget 要 quote、`BrainPromoter`、quote 判斷誰說的）；`-p pirc-agent` 341 + 34、`-p pirc-config` 39 passed；`cargo clippy --workspace --all-targets`、`cargo fmt --check` 乾淨。評估集（`search_evaluation`）每一類都不低於 `LIKE` baseline，`zh` 0.89→1.00、`recall` 0.36→0.64（表在 [memory-search](../memory-search.md)）。conformance（`target/release`，`--no-fail-fast`）：`brain_memory`、`memory`、`http`、`brain`、`rooms` 與其餘全綠，只有 `node_browser` 4 個照舊失敗（這個沙箱的 Chromium，02 時就是）；`brain_memory`+`memory`+`http`+`brain`+`rooms` 連跑 5 次都綠。web：vitest 43 files / 311 tests、`svelte-check` 0 錯誤、prettier 乾淨。gateway release 執行檔 13.97 MB（預算 16 MiB）。`cargo test -p pirc-node` 有 2 個 `sandbox::linux::plan` 的 Unix socket 測試在這個沙箱失敗（讀主機的 `/proc/net/unix`）；這份 plan 沒動 `pirc-node`，但磁碟不夠沒能在 HEAD 上重跑確認。**手動真模型測試沒做**：沙箱連不到 provider，要使用者自己跑（含「一週後」那一步）。

與設計的差異：撤銷時「OM ledger 的對應 observation 標 forgotten」沒做——被 promote 的 observation 本來就已經被 dropper 拿出 pool（不在 prompt 裡），tombstone 擋住同文再被 promote；頭腦房間對話檔（`brain/rooms/<room>/`）裡說過那句話的 turn 不改，和 node transcript 一樣（[security-decisions](../../docs/architecture/security-decisions.md#memory-writes-without-approval) 記為 residual risk）。`CHANGELOG.md` 照 01/02 的做法留給 [13](13-docs.md)。

## 文件

- `docs/architecture/assistant-memory.md` 重寫為三層記憶；`observational-memory.md` 加 promotion；`security-decisions.md` 加「記憶寫入不審核」與 residual risk。

## 實作前待決

- 偏好確認的判斷放在頭腦（模型判斷「他說好了」）還是程式碼（下一句話包含肯定詞）？建議頭腦判斷 + quote 必須命中 user 訊息（沿用 `find_quote`）。→ **已定（2026-10-20，使用者）：頭腦判斷 + quote 必須命中 user 訊息。**
- `memory_search` 對 worker 是否保留 repo scope（今天有）：建議保留，person scope 在 gateway 端以 host profile 拒絕。→ **已定（2026-10-20，使用者）：保留 repo scope；person scope 以 host profile 拒絕。**

**2026-10-20 使用者同意動工**，連同 [memory-search](../memory-search.md) phase 0–1（評估集、FTS5 + CJK bigram）作為檢索底層。
