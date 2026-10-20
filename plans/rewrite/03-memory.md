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

- [ ] schema：`memory_records` 加欄；`memory_entries` → `preferences`；`memory_tombstones` 去 project scope；`memory_log` 的 actor 加 `face`/`om`。
- [ ] `memory_records.rs`：person scope 的 ingest / search / forget；FTS 索引涵蓋 person 列（與 memory-search phase 1 合流）。
- [ ] `brain/memory.rs`：`remember` / `forget` 工具、origin 計算、line 產生；偏好提議與確認的判斷。
- [ ] `features/memory/agents.rs`：dropper 前 `promote` hook；brain / worker 兩種 host 實作。
- [ ] `brain/turn.rs`：自動撿取 section。
- [ ] API：`GET /api/memory/preferences`、`GET /api/memory/records?scope=&q=`、`DELETE …/:id`、`GET /api/memory/records/:id/history`（沿用 `memory/routes.rs` 的 view/history/restore/forget）。
- [ ] Web：主持人面孔頁的「偏好」區（10 之前先掛在 Settings）；記憶瀏覽頁（引擎蓋）；房間 line 的展開與「不用記」。
- [ ] memory-search phase 0 評估集加 person 語料與「自動撿取」查詢類。
- [ ] conformance：`brain_memory.rs`：記下 → line → 不用記 → tombstone 拒絕同文；tool 結果推導的事實帶 `tool:*`；dropper 掉出的 observation 可被搜到；撿取 section 出現在 context snapshot。

## 驗證

- `cargo test -p pirc-gateway memory`、conformance `brain_memory` + `memory`、評估集 recall@8 不低於 baseline。
- 手動：告訴它「我用 TLP」→ 看到 line；一週後問「我電源管理用什麼」→ 答得出（不靠它主動搜）。

## 文件

- `docs/architecture/assistant-memory.md` 重寫為三層記憶；`observational-memory.md` 加 promotion；`security-decisions.md` 加「記憶寫入不審核」與 residual risk。

## 實作前待決

- 偏好確認的判斷放在頭腦（模型判斷「他說好了」）還是程式碼（下一句話包含肯定詞）？建議頭腦判斷 + quote 必須命中 user 訊息（沿用 `find_quote`）。
- `memory_search` 對 worker 是否保留 repo scope（今天有）：建議保留，person scope 在 gateway 端以 host profile 拒絕。
