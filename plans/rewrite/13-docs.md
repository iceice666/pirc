# 13 文件與工作隊列收尾

[重寫](README.md) · [盤點 §7](inventory.md) · [existing-plans](existing-plans.md)

**目標**：每份 plan 各自更新了它碰到的文件；這份 plan 做最後一次整體掃描，讓 `docs/`、`plans/`、`README.md`、`CHANGELOG.md`、`nix/` 說的都是新模型，沒有舊物件殘留；並把 `plans/README.md` 重寫成新的工作隊列。可與 11/12 平行，最後收。

**依賴**：01–12 的文件段落已各自更新。**被依賴**：無。

## 決定（2026-10-22，使用者）

| #   | 問題                                | 決定                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 版本號                              | **0.10.0+harmony**。harmony 是正常的分叉，不跟 main 的版本線。只標在 CHANGELOG 上；manifest 不動（`scripts/version.ts` 只收 `MAJOR.MINOR.PATCH`，而 pubspec 的 `+` 是 versionCode）                                                                                                                                          |
| 2   | 發不發版                            | **不發版**：不 bump、不寫 release commit、不打 tag。CHANGELOG 條目留在 `## [Unreleased]` 下                                                                                                                                                                                                                                  |
| 3   | `origin/main` 分叉後的 36 個 commit | **Cherry-pick** Android renderer 修正（28 個，`1a60d06` … `0ee934e`）、`0ca56a8`（PingFang 測試）和 3 個 release CI 修正（`4bfc083` `7878ad6` `105871d`）。跳過 `4b8d084`（release v0.9.1）、`0b5ddc2` `937f707`（版本註記）、`bd42626`（只搬 CHANGELOG）。版本維持 0.9.0+71。每個 commit 的 CHANGELOG 衝突都收進 Unreleased |
| 4   | 檔名                                | guide 維持 `docs/guides/rooms-and-memory.md`（不另開 `rooms.md`）；reference `docs/architecture/assistant-memory.md` 改名 `memory.md`，所有引用一起改，包括原始碼註解（另開 commit）                                                                                                                                         |
| 5   | `direction.md`                      | 留在原位，加「已實作」註記；指向已刪檔案的 5 條死連結直接拿掉                                                                                                                                                                                                                                                                |
| 6   | `plans/modes.md`                    | 刪掉（已被 08 吸收），在「退場紀錄」留一行                                                                                                                                                                                                                                                                                   |
| 7   | 重寫前的定位 commit                 | `c483379`：拆除開始前最後一個 commit，舊模型的文件與 plan 都還在。另記 main 上的 `v0.9.1`，它是舊模型最後一個發佈版本                                                                                                                                                                                                        |

## 工作項目

### 先做：從 main cherry-pick（決定 3）

- [x] 依決定 3 的清單照順序 cherry-pick；renderer 程式碼在分支上沒動過（`git merge-tree` 只在 `CHANGELOG.md`、`docs/deploy/upgrades.md`、`plans/mobile.md` 衝突）。驗證：`flutter analyze`、`flutter test` 與 plan 12 結束時的基線相同（+4961 ~2 -362）。
      **2026-10-22 完成**：32 個 commit 以 `-x` 撿進來。CHANGELOG 與 `plans/mobile.md` 的衝突取分支版，之後一次補上：CHANGELOG 收進 main 的 Unreleased Fixed 共 24 條，`mobile.md` 用三方合併，renderer 段取 main 版、rooms 段取分支版，並刪掉已退場的 project deletion 驗收。`apps/android/lib/rendering`、`apps/android/assets`、`.github` 與 `origin/main` 逐位元相同。`pubspec.lock` 補上 plan 12 漏改的 `plugin_platform_interface`（dev dependency）。`flutter analyze` 0 issues。`flutter test` +7275 ~11 -437；用 JSON 結果和 `4fce23c` 逐項比對（同樣是 +4961 ~2 -362），沒有任何原本通過的測試變成失敗，另有 9 個原本失敗的現在通過。新增的失敗是 main 帶來的 84 個測試，原因是本機沒有 `node`（`tool/parity/document_vm_host.mjs`）；把 bun 當 `node` 跑這 6 個檔案時 84 個全部通過。多出的 9 個 skip 是 main 的 PingFang/macOS 字型測試。Kotlin 沒動到。

### 重寫

- [x] `docs/development/gateway-and-node.md`：三個角色改成「gateway（頭腦 + 房間 + 來源 + 引擎蓋 API）」與「node（手）」；API 段以 rooms / faces / threads / loops / wakes / sources / engine 為主；worker session 路由歸引擎蓋。（2026-10-22）開頭兩個角色重寫；記憶、工人、workspace memory 三段從 Node 設定搬到 API 的 Brain / Workers；Engine 段加開頭說明；`face:host for now` 改掉。
- [x] `docs/architecture/assistant-memory.md` → 改名 `memory.md`：三層記憶、open loops、origin 規則、promotion、「忘掉」語意。（2026-10-22）`git mv`；過時段落對照程式碼改正：wake 拿掉的工具照 `waking.rs` `NOT_IN_WAKES`、agent ops 只剩 `memory.search` / `recall.remote` / `web.search` 且前兩個仍拒絕、scratch 目標、引擎蓋 session 唯讀。所有連結與原始碼註解一起改（註解另一個 commit）；`plans/rewrite/` 內提到舊檔名的歷史敘述不改。
- [x] `docs/architecture/prompt-context.md`：brain prompt（SOUL / host role / 偏好 / 還掛著的事 / 你可能記得 / 你現在是）與 worker prompt（AGENTS.md / 交辦脈絡）兩套；`fresh_each_turn` 與 snapshot。（2026-10-22）brain 段已在（02–10 各自補的）；補 `Agent::set_base_prompt` 取代 `fresh_each_turn`、worker 的交辦脈絡（`## Context from the assistant`）。
- [x] `docs/architecture/security-decisions.md`：新增「Nothing writes unasked」、兩條紅線、記憶不審核、來源不可信、研究模式瀏覽器（含 cookie 例外與 S18 補述）；刪 Delegation approval 舊節；保留 S10 / S18 / 其他 accepted limits（依 existing-plans §6 修訂）。（2026-10-22）各節 03–09 已補；這裡補 S18 的「動作分類不是網路邊界」、所有權一句、`later an email`。研究模式瀏覽器尚未實作，維持「Not yet」並列入 `plans/README.md` 的第二步。
- [x] `docs/guides/`：`rooms-and-memory.md`（已存在，維持現名，決定 4）涵蓋房間、面孔、未了結的事、記憶、來源、引擎蓋，取代已刪的 chat-projects / schedules / session-ui；`agent.md` `tools.md` `modes.md` `browser.md` 依 07 / 08 / 09 改；`README.md` 表重排。（2026-10-22）`tools.md` 拿掉 composer 的 goal dock 與模式顯示、紅線連到 security-decisions；`browser.md` 改成原生 CDP、瀏覽器動作會問、側欄改引擎蓋；`modes.md` 去掉 `plans/modes.md` 連結與 Work 分頁；`README.md` 一段改寫；`agent.md` 看過不用改。
- [x] `docs/deploy/`：`gateway.md`（SOUL/CHAT、brain 設定、配額、來源憑證、新 DB 檔）、`node.md`（能力、scratch、無 chat 角色）、`topology.md`（一個 gateway + 多個 node，沒有 chat node）、`backup-and-recovery.md`（新 DB 檔與 `brain/` 目錄）、`upgrades.md`（「重寫版不升級舊狀態；舊 DB 原地保留」）、`nixos.md`。（2026-10-22）`gateway.md` 補 `PIRC_TIMEZONE`、room uploads、SIGHUP 也重載 modes；`topology.md` 角色表、沒有 chat node、brain/rooms 與 scratch 列；`backup-and-recovery.md` 重寫版一句、scratch 列；`upgrades.md` 頂端改成從 0.9.x 升級的六步，開發版的 schema 2→8 段落留在其下；`node.md` 一詞；`nixos.md` 看過不用改。
- [x] `docs/architecture/README.md`、`docs/README.md`：連結表更新；`direction.md` 留作方向文件，加一行「已實作，見 guides」，指向已刪檔案的死連結拿掉（決定 5）。（2026-10-22）
- [x] `README.md`（根）：一句話從「persistent coding-agent sessions」改成 direction §1；安全模型段改寫；development 段的命令更新（無 `dev:chat`）。（2026-10-22）開頭依 direction §1、Features 改成房間 / 記憶 / wake / 工人 / 引擎蓋、威脅模型加「不問就做」的保障、Upgrading 改成協定 15 與新 DB。原本就沒有 `dev:chat`。
- [x] `nix/README.md`、`nix/module.nix` 的 option 描述。（2026-10-22）`timeZone` 描述；本機沒有 nix，沒有 eval。
- [x] `CHANGELOG.md`：rewrite 的完整條目，放在 Unreleased 下並標註 0.10.0+harmony；不 bump 版本、不發版（決定 1、2）。（2026-10-22）Changed / Added / Removed 全寫；00 的 Removed 條目改掉「unavailable until the rewrite brings them back」與已經回來的 `soulPrompt` / `chatPrompt`。

### `plans/README.md` 重寫（existing-plans §8 的結構）

- [x] 「重寫」段：指向 `plans/rewrite/`，列已完成與剩餘的 plan。（2026-10-22）加上重寫留下的第二步：研究瀏覽器、Gmail API、worker 的 repo notes 搜尋、引擎蓋 Modes 頁與 `kind`。
- [x] 「正交的既有工作」：sandbox-gpu、mobile（修訂版）、Android decisions、Rust post-cutover 驗證、memory-search phase 2。（2026-10-22）
- [x] 「Accepted limitations」：依 existing-plans §6 修訂。（2026-10-22）
- [x] 「Watch」：consolidation（新觸發條件）、vector index。（2026-10-22）
- [x] 「退場紀錄」：delegation-autonomy phase 3、project-only memory、second chat node、Chat/Work tabs，各一行原因 + git 位置。（2026-10-22）另記 moving chats 與 `workspace.read` 已做而離開 Watch。Manual validation 收進 00–11 各 plan 未做的「手動」項。
- [x] 刪 `plans/delegation-autonomy.md`（00 已刪）；刪 `plans/modes.md`（決定 6）；`plans/memory-search.md` 依 §3 修訂。（2026-10-22）`memory-search.md`：目標改成頭腦的檢索、embedding 設定位置依決定 #6。
- [x] `docs/development/historical-records.md`：加重寫前最後一個 commit 的定位 `c483379`（舊模型的文件與 plan 從這裡找），並記 `v0.9.1`（決定 7）。（2026-10-22）新增「Before the rewrite」段。

### 掃描

- [x] `grep -rni 'chat node\|chat project\|schedule\|proposal\|Needs you\|control lease\|pin\b' docs README.md nix apps/*/README.md` 逐條確認是新語意或刪除。（2026-10-22）剩下的都是新語意（引擎蓋 session 的 control lease、置頂訊息、wake 的 scheduled）或 `upgrades.md` 舊版本段落與退場說明。
- [x] 所有 `docs/` 內部連結可達（寫個一次性 script 或手動）。（2026-10-22）一次性 bun script 掃 `docs/`、`plans/`、根 README、CHANGELOG、`nix/README.md`、兩個 app README 的相對連結：0 條死連結。
- [x] `bun run format:check`。（2026-10-22）對 `git ls-files` 全部通過；修了 plan 08 留下的 `crates/pirc-config/src/modes/scratch.md`（front matter 後少一行空行，body 本來就 trim，`pirc-config` 39 個測試通過）。`bun run format:check` 本身在這個沙箱讀不到根目錄的 `.zshrc` / `.zprofile` placeholder（不在 git 裡）。

## 驗證

- 連結掃描無死鏈；`grep` 無舊物件殘留；`bun run check` 全綠。

**結果（2026-10-22）**：`bun run check` 的每一步分開跑（`format:check` 換成 `git ls-files`，原因見上）。version、catalog、browser-assets、prettier、typecheck、test（scripts + web）、build 都通過。`check:rust`：fmt、clippy 乾淨；`cargo test --workspace` 只有 `pirc-node` 的 `sandbox::linux::plan::tests::host_unix_sockets_are_the_listed_sockets_but_the_allowed` 與 `host_rules_hide_bound_sockets_but_the_allowed` 失敗，在 `4fce23c`（本 plan 之前）同樣失敗，是這個沙箱看不到自己綁的 Unix socket。conformance（release build，`--no-fail-fast`）：191 passed，4 failed，全在 `node_browser`：這個沙箱裡 Chromium 起不來，plan 10 已記錄。Android 在 cherry-pick 項目的驗證裡。

## 實作前待決

都已定，見上方「決定」。
