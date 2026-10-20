# 13 文件與工作隊列收尾

[重寫](README.md) · [盤點 §7](inventory.md) · [existing-plans](existing-plans.md)

**目標**：每份 plan 各自更新了它碰到的文件；這份 plan 做最後一次整體掃描，讓 `docs/`、`plans/`、`README.md`、`CHANGELOG.md`、`nix/` 說的都是新模型，沒有舊物件殘留；並把 `plans/README.md` 重寫成新的工作隊列。可與 11/12 平行，最後收。

**依賴**：01–12 的文件段落已各自更新。**被依賴**：無。

## 工作項目

### 重寫

- [ ] `docs/development/gateway-and-node.md`：三個角色改成「gateway（頭腦 + 房間 + 來源 + 引擎蓋 API）」與「node（手）」；API 段以 rooms / faces / threads / loops / wakes / sources / engine 為主；worker session 路由歸引擎蓋。
- [ ] `docs/architecture/assistant-memory.md` → 改名 `memory.md`：三層記憶、open loops、origin 規則、promotion、「忘掉」語意。
- [ ] `docs/architecture/prompt-context.md`：brain prompt（SOUL / host role / 偏好 / 還掛著的事 / 你可能記得 / 你現在是）與 worker prompt（AGENTS.md / 交辦脈絡）兩套；`fresh_each_turn` 與 snapshot。
- [ ] `docs/architecture/security-decisions.md`：新增「Nothing writes unasked」、兩條紅線、記憶不審核、來源不可信、研究模式瀏覽器（含 cookie 例外與 S18 補述）；刪 Delegation approval 舊節；保留 S10 / S18 / 其他 accepted limits（依 existing-plans §6 修訂）。
- [ ] `docs/guides/`：新 `rooms.md`（房間、面孔、未了結的事、記憶、來源、引擎蓋）取代已刪的 chat-projects / schedules / session-ui；`agent.md` `tools.md` `modes.md` `browser.md` 依 07 / 08 / 09 改；`README.md` 表重排。
- [ ] `docs/deploy/`：`gateway.md`（SOUL/CHAT、brain 設定、配額、來源憑證、新 DB 檔）、`node.md`（能力、scratch、無 chat 角色）、`topology.md`（一個 gateway + 多個 node，沒有 chat node）、`backup-and-recovery.md`（新 DB 檔與 `brain/` 目錄）、`upgrades.md`（「重寫版不升級舊狀態；舊 DB 原地保留」）、`nixos.md`。
- [ ] `docs/architecture/README.md`、`docs/README.md`：連結表更新；`direction.md` 留作方向文件，加一行「已實作，見 guides」。
- [ ] `README.md`（根）：一句話從「persistent coding-agent sessions」改成 direction §1；安全模型段改寫；development 段的命令更新（無 `dev:chat`）。
- [ ] `nix/README.md`、`nix/module.nix` 的 option 描述。
- [ ] `CHANGELOG.md`：rewrite 版本的完整條目；版本號依 `scripts/version.ts`（建議 1.0.0，不相容）。

### `plans/README.md` 重寫（existing-plans §8 的結構）

- [ ] 「重寫」段：指向 `plans/rewrite/`，列已完成與剩餘的 plan。
- [ ] 「正交的既有工作」：sandbox-gpu、mobile（修訂版）、Android decisions、Rust post-cutover 驗證、memory-search phase 2。
- [ ] 「Accepted limitations」：依 existing-plans §6 修訂。
- [ ] 「Watch」：consolidation（新觸發條件）、vector index。
- [ ] 「退場紀錄」：delegation-autonomy phase 3、project-only memory、second chat node、Chat/Work tabs，各一行原因 + git 位置。
- [ ] 刪 `plans/delegation-autonomy.md`（00 已刪）；`plans/modes.md` 依 existing-plans §2 修訂或併入 08 後刪除；`plans/memory-search.md` 依 §3 修訂。
- [ ] `docs/development/historical-records.md`：加重寫前最後一個 commit 的定位（舊模型的文件與 plan 從這裡找）。

### 掃描

- [ ] `grep -rni 'chat node\|chat project\|schedule\|proposal\|Needs you\|control lease\|pin\b' docs README.md nix apps/*/README.md` 逐條確認是新語意或刪除。
- [ ] 所有 `docs/` 內部連結可達（寫個一次性 script 或手動）。
- [ ] `bun run format:check`。

## 驗證

- 連結掃描無死鏈；`grep` 無舊物件殘留；`bun run check` 全綠。

## 實作前待決

- 版本號：1.0.0 還是 0.10.0；建議 1.0.0（不相容 + 產品形狀換了）。
- `direction.md` 完成後留原位還是搬到 historical：建議留原位，加「已實作」註記。
