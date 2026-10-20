# 重寫對既有 plan 的影響

[重寫](README.md) · [盤點](inventory.md) · [決定](decisions.md) · [Open work](../README.md)

2026-10-20 盤點 `plans/` 下每份 plan 與 [plans/README.md](../README.md) 的工作隊列，對照 [direction.md](../../docs/architecture/direction.md) 與 [決定](decisions.md)。四種去向：

- **留**：與重寫無關或正交，照原 plan 走。
- **吸收**：目標還在，但要併進重寫的某個 plan，不再獨立。
- **改**：plan 還在，範圍或前提要改。
- **退場**：目標物件被 direction 退場，plan 整份或該 phase 作廢。

本文件不授權任何變更；`plans/README.md` 本身要重寫（見末節）。

## 1. `delegation-autonomy.md` — 退場（phase 3），phase 0–2 的成果部分吸收

| 項目                                                                                               | 去向 | 說明                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------- |
| Phase 0 `scripts/approval-stats.ts`                                                                | 退場 | 只服務 phase 3 的「先量再決定」；§2.5 已直接決定只問兩條紅線                                                     |
| Phase 1 `delegation_approval` (`always`/`untrusted`/`never`)                                       | 退場 | §2.7「人叫工人不問你」：預設即 `never`，不再是 per-project 設定；`workspace_capabilities` 表隨之重設計           |
| Phase 1 verified quote（`find_recent_quote` → `details.userRequests`）                             | 吸收 | 保留為「工人只拿你的原話當授權」的機制（§2.7 工人的脈絡包含 quote 過的你的原話）；併入 worker-call plan          |
| Phase 1 `origins_json` / `current_origins`                                                         | 吸收 | origin tagging 是新模型的安全主軸（§2.3、§2.4）；併入記憶 / open loop plan                                       |
| Phase 1 running delegations + Open/Stop、4 個並發上限                                              | 吸收 | 變成討論串 + Stop（§4）；上限沿用（決定 #10）                                                                    |
| Phase 2 relayed approvals（`relay.<delegation>.<dialog>`、`relayed-answer` 路由、Needs you、推播） | 吸收 | 機制留（工人紅線 relay 進房間，§2.7）；UI 從卡片 / Needs you 改成房間裡的訊息（§4）                              |
| Phase 3 「Allow this again in this session」                                                       | 可選 | direction 沒提。對 `unsandboxed_bash` 仍可能有用（同一 session 重複出沙箱）；留作 worker plan 的可選項，不是前提 |
| Phase 3 soft / hard danger                                                                         | 退場 | 被「static deny 直接拒 + outbound 類別要問」取代（§2.5、決定 #1）；分類語意不同，不要沿用 soft/hard 名詞         |
| Phase 3 記錄 rules vs model 決策來源                                                               | 留   | 便宜且與模型無關；可併入 auto mode outbound plan                                                                 |
| `security-decisions.md` → Delegation approval 一節                                                 | 改   | 整節要重寫成「Nothing writes unasked」+ 兩條紅線 + residual risk；舊的 `always` 預設與三種 policy 的敘述刪除     |

## 2. `modes.md` — 改（capability 詞彙大幅縮減）

Phase 1–2 已做完、phase 3 大部分已做。Mode 機制本身留（§5 不變項裡的 worker 執行 profile），但詞彙表上一半的 capability 綁在退場的物件上。

| Capability / 項目                                                          | 去向 | 說明                                                                                                                                                                       |
| -------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workdir`（per-session / workspace）                                       | 留   | scratch 與 repo worker 的差別（§3.2）                                                                                                                                      |
| `features_on` / `features_off` / `tools`                                   | 留   | worker tool ceiling                                                                                                                                                        |
| `delegate_target` `project_config` `workspace_memory` `repository` `recap` | 留   | 全是 worker / repo 側                                                                                                                                                      |
| `ui.noun` / `ui.icon`                                                      | 改   | 引擎蓋裡顯示用；沒有 Chat/Work tab 之後 `noun` 的用處變小                                                                                                                  |
| `assistant`（full / user）                                                 | 退場 | 頭腦在 gateway；worker 不拿 USER（§2.7 工人沒有人的記憶）。這同時拿掉「directory session 讀 USER」的路徑                                                                   |
| `delegate`                                                                 | 退場 | 只有頭腦叫工人；worker 之間走 team（決定 #10）                                                                                                                             |
| `schedule_scope`                                                           | 退場 | §2.3                                                                                                                                                                       |
| `project_instructions` `project_files` `projects` `delete_sessions`        | 退場 | chat project 退場；面孔的角色與地盤是 gateway 物件（§2.8）                                                                                                                 |
| `prompt` sections `soul` `chat-env` `chat-md`                              | 退場 | SOUL/CHAT 搬到 gateway 的頭腦設定（§2.1）；`base` `agents:*` `body` 留                                                                                                     |
| 預設檔 `chat.md`                                                           | 退場 | 盤點已列刪；**`scratch.md` 從 guide 範例升格成預設檔**（頭腦挑手時沒有合適 workspace 就用 scratch，§3.2）                                                                  |
| 預設檔 `directory.md`                                                      | 改   | 拿 `assistant: user`、schedule scope                                                                                                                                       |
| Forbidden combinations                                                     | 改   | 含 `assistant` / `delegate` / `schedule_scope` / `projects` / `project_*` 的規則全部移除；剩 `workspace_memory`/`project_config` 需 `repository`                           |
| **新**：research / read-only profile                                       | 吸收 | self-wake 叫的工人要真正唯讀（§2.6、§3.1）。**待決**：這是 mode 檔（與 2026-10-18 決定 2「modes set no approval mode」衝突）還是頭腦交付的 task policy（scout 建議後者）？ |
| Phase 3 決定 1「tab 由 `assistant` 推導」、`ui.group` 移除                 | 退場 | §4 沒有 Chat/Work 頂層二分；worker 一律在引擎蓋                                                                                                                            |
| Phase 3 剩餘：Settings Modes page                                          | 改   | 降為引擎蓋的一頁，低優先                                                                                                                                                   |
| Phase 3 剩餘：retire `kind`                                                | 吸收 | 隨 routes/types 重寫自然發生；不需要「多留一版」（不相容）                                                                                                                 |
| Phase 3 剩餘：Android scratch parity、guide 截圖                           | 退場 | 跟 UI 重做；舊截圖無意義                                                                                                                                                   |
| `docs/guides/modes.md`                                                     | 改   | 隨詞彙表縮減                                                                                                                                                               |

## 3. `memory-search.md` — 留並擴大（變成事實層的檢索）

這份 plan 方向正確（direction §2.4 點名），而且重寫讓它更重要：事實層「不進 prompt、靠搜尋」，加上每 turn 自動撿取，檢索品質直接決定「它想到要搜才搜得到」的解法。

| 項目                                            | 去向 | 說明                                                                                                                            |
| ----------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| 拒絕 Postgres / sqlite-vec / trigram / 內建模型 | 留   | 不變                                                                                                                            |
| Phase 0 評估集                                  | 改   | 加 **person 事實** 語料與兩類新查詢：(a) 以使用者訊息 + 目前 open loops 當 query 的「自動撿取」類；(b) 面孔 / 房間標籤過濾      |
| Phase 1 FTS5 + CJK bigram                       | 改   | 索引表要涵蓋 `scope = person` 的列（決定 #5：同一張 `memory_records` 加 `scope`）；`UNINDEXED` 欄多 `scope` `room_id` `face_id` |
| Phase 1 write sites 清單                        | 改   | 刪 `project_deletion.rs`；加：person 事實寫入、OM dropper promotion、open loop 降級（`was_open_loop`）、「忘掉 X」跨層刪除      |
| Phase 1 forgetting / secure delete              | 留   | 「忘掉」tombstone 語意是 §5 不變項；sentinel test 延伸到 person 列                                                              |
| Phase 1 查詢（BM25、合併 delegations）          | 改   | 多一個消費者：每 turn 自動撿取（top-N、延遲預算幾百 ms）；搜尋 API 要回 provenance（`tool:*` / `user`）給「你可能記得」區塊標示 |
| Phase 2 embeddings                              | 留   | 仍為可選；決定 #6 的「憑證與 backend 同頁」順便回答了「`models.json` 還是環境變數」：**走 backend 設定頁**                      |
| Schema migration 編號（1005 / 1006）            | 改   | 遷移完全從零（決定 #14）：新 DB 從新 schema 開始，不再是 migration 1005                                                         |
| `docs/architecture/assistant-memory.md` 的更新  | 改   | 那份文件本身要重寫（盤點 §7）                                                                                                   |

## 4. `sandbox-gpu.md` — 留（與 node 能力宣告正交但要對齊）

| 項目                                             | 去向 | 說明                                                                                                                                       |
| ------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 1 macOS、Phase 2 Linux、Phase 3 docs       | 留   | 純 node 沙箱設定，與重寫無關；仍需逐 phase 同意                                                                                            |
| 「Decisions needed」1、2                         | 留   | 仍待決                                                                                                                                     |
| 與 node 能力宣告（決定 #7）的關係                | 改   | 能力宣告的 `gpus[]` 是硬體事實；**另外要宣告 `sandbox.gpu.enabled`**，頭腦挑手時看後者。direction §3.2 已說「宣告 GPU 不代表沙箱開放 GPU」 |
| 「Why」裡的第 2 點：model host 網域每 session 問 | 改   | 新網域是「往外送」紅線（§2.5），仍會問；長期放 `allowedDomains` 的建議不變                                                                 |
| Agent prompt 提示「GPU 不在沙箱裡」              | 留   | worker 側                                                                                                                                  |

## 5. `mobile.md` — 改（UI 項目重做，renderer 項目全留）

| 項目                                                                                                             | 去向 | 說明                                                   |
| ---------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------ |
| Dynamic content compatibility（renderer）                                                                        | 留   | `lib/rendering/` 是產品核心（盤點 §6.2），與重寫無關   |
| Physical phone acceptance：pairing、streaming、panels、management consent、鍵盤、安全區、terminal、release build | 留   | 底層不變；但要等新 UI 再跑                             |
| Physical acceptance：multi-line USER / delegation confirmation bodies                                            | 退場 | proposal 與 delegation card 退場                       |
| Physical acceptance：PTC approval、browser takeover、WebM                                                        | 留   | 引擎蓋功能                                             |
| Project deletion interruption acceptance                                                                         | 退場 | 專案刪除退場                                           |
| Remote background push                                                                                           | 改   | 留，但通知目標變 room                                  |
| Distribution decisions（簽章、F-Droid/Play、token rotation、Context inspector）                                  | 留   | 與重寫正交；Context inspector 屬引擎蓋                 |
| 「frozen visual corpus `bd3d909`」                                                                               | 退場 | 對照用的 web 畫面會整個換；新 corpus 等 web 重做後再凍 |
| Deferred presentation / 計算樣式 / 互動內容邊界                                                                  | 留   | 全是 renderer                                          |
| Validation boundaries                                                                                            | 留   |                                                        |

## 6. `plans/README.md` 工作隊列

### Active work

| #   | 項目                                                                                          | 去向 | 說明                                                            |
| --- | --------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------- |
| 1   | Android approval acceptance（assistant 3a）                                                   | 退場 | USER proposal 與 delegation confirmation 都退場                 |
| 2   | Network provenance：`browser_click`/`browser_type` 非 localhost 分類 + 頁面結果 OM provenance | 吸收 | 就是研究模式瀏覽器（§3.1、決定 #8）；併入 browser/research plan |
| 3   | Android decisions（token rotation、distribution、Context inspector）                          | 留   | 正交                                                            |
| 4   | Modes phase 3 剩餘                                                                            | 改   | 見 §2                                                           |
| 5   | Memory search                                                                                 | 改   | 見 §3                                                           |
| 6   | Sandbox GPU                                                                                   | 留   | 見 §4                                                           |
| 7   | Delegation autonomy phase 3                                                                   | 退場 | 見 §1                                                           |

### Shelved: project-only memory (B)

**從 shelved 改成明確拒絕**。direction §2.2「記憶是頭腦的，不是房間的」、§2.8「面孔標籤是給檢索和展示用，不是隔離」直接否定了這個設計；而且它依賴的 scope generation / frozen snapshot 也隨「熱更新」退場。保留一行紀錄原因即可。

### Manual validation

| 項目                                     | 去向 | 說明                                                                |
| ---------------------------------------- | ---- | ------------------------------------------------------------------- |
| Web approvals：approval-mode picker      | 退場 | §2.5                                                                |
| Project deletion                         | 退場 |                                                                     |
| Browser：真機接管、WebM                  | 留   |                                                                     |
| Schedules：iPhone PWA push、deliver body | 改   | 變成「room push 在 iPhone PWA」；deliver body 隨 worker-call 重設計 |
| Sandbox（NixOS/Linux）                   | 留   |                                                                     |
| Mobile                                   | 改   | 等新 UI                                                             |
| PTC                                      | 留   | worker 側                                                           |
| Rust post-cutover                        | 留   |                                                                     |

### Accepted limitations

全部仍成立，除了：

- 「Project deletion」一段 → 退場。
- 「session-only domain approvals」→ 語意改成「新網域是往外送紅線」，結論一樣（長期放 `allowedDomains`）。
- 「Security」的 S10 / S18 → 不變；但 S18 對研究模式瀏覽器要補一句：研究模式是 action 分類，不是網路邊界。

### Watch, do not build yet

| 項目                          | 去向 | 說明                                                                                            |
| ----------------------------- | ---- | ----------------------------------------------------------------------------------------------- |
| Consolidation（dreaming）     | 改   | 觸發條件從「`memory_full` 頻繁」改成「事實層 promotion 後 active pool 仍常滿」；origin 規則不變 |
| Moving chats between projects | 吸收 | 變成主持人搬家（§2.2、決定 #11），**從 watch 進入範圍**                                         |
| Vector index                  | 留   |                                                                                                 |
| A second chat node            | 退場 | 沒有 chat node                                                                                  |
| `workspace.read`              | 吸收 | §3.1 點名，**從 watch 進入範圍**；種子是 `panels/inspect.rs`                                    |

## 7. 新冒出來的待決（拆 plan 前）

1. **research profile 是 mode 檔還是 task policy**（§2）。影響 modes plan 與 self-wake plan 的邊界。
2. **「Allow again in this session」for `unsandboxed_bash`** 要不要留作可選（§1）。
3. **`scratch.md` 升格為預設檔**（§2）——direction §3.2 隱含，但 modes plan 2026-10-19 決定 2 說它只是 guide 範例；要翻案。

## 8. `plans/README.md` 怎麼處理

整份重寫（盤點 §7 已列）。建議結構：

1. **重寫**：指向 `plans/rewrite/`，列出拆出來的 plan 與順序。
2. **正交的既有工作**：sandbox-gpu、mobile 的 renderer 與 distribution、Android decisions、Rust post-cutover 驗證。
3. **Accepted limitations**：保留，依上面修訂。
4. **Watch**：剩 consolidation、vector index。
5. **退場紀錄**：一段列出被 direction 作廢的 plan 與原因（delegation-autonomy phase 3、project-only memory、second chat node），指向 git 歷史。

`delegation-autonomy.md` 整份可在 README 重寫時移除（phase 0–2 的現況描述已在 security-decisions 與 guide，而那兩份也要重寫）。
