# 07 兩條紅線：auto mode 的 outbound 類別與房間 relay

[重寫](README.md) · [direction §2.5](../../docs/architecture/direction.md) · [決定](decisions.md) · [盤點 §4.2 auto mode](inventory.md)

**目標**：worker 做事只有兩件要問——出沙箱、往外送。其餘做了再說；static deny 直接拒不問；要問的問題 relay 進房間，你一句話回。這是 worker 側的 plan，可與 02–06 平行，但 relay 進房間要等 06 的討論串/question 訊息。

**依賴**：00；relay 進房間依賴 01（question 訊息）與 06（thread 對應）。**被依賴**：05（read-only 保證）、06、09。

## 決定（已定）

- outbound 清單（#1）：`git push` 全部、`git send-email`；`gh pr create/merge/comment/review`、`gh issue create/comment/close`、`gh release create`、`gh gist create`、`gh api` 非 GET；`npm`/`cargo`/`pip publish`；`curl`/`wget` 帶 body 或非 GET 到非 localhost。讀不問。allowlist 不分讀寫，接受。
- 新網域（`sandbox_allow_domains`）是往外送（§2.5）。
- 瀏覽器：非 localhost 的 click/type/下載/送表單是 action（#8）；localhost 只含 `localhost`/`127.0.0.1`/`::1`。

## 設計

**`auto_mode/rules.rs`（改）**：分類從 `Read | Write | Unknown | Danger` 改為：

| 類別       | 行為                                                                        | 例                                                |
| ---------- | --------------------------------------------------------------------------- | ------------------------------------------------- |
| `Read`     | 做                                                                          | `git fetch`、`gh pr view`、`curl` GET             |
| `Write`    | 做（沙箱內）                                                                | 寫檔、`git commit`、`cargo add`、`npm install`    |
| `Outbound` | **問**（紅線 2）                                                            | 決定 #1 清單；`sandbox_allow_domains`             |
| `Deny`     | **拒**，不問，回報模型「被拒：原因」                                        | 今天的 deny list + 今天 `Danger` 裡「本機毀滅」類 |
| `Unknown`  | 走 classifier；classifier 只能判成 `Read`/`Write`/`Outbound`，不能降 `Deny` | 今天的 `Unknown`                                  |

`Danger` 類別拆開：本機毀滅（`rm -rf ~`、`chmod 777 ~`、改系統設定、憑證存取）→ `Deny`；`git push --force`、`reset --hard`、`clean -f` → 沙箱內的 `Write`（git 是邊界，做了再說）；publish/deploy → `Outbound`。

**`auto_mode/mod.rs`（改）**：`gate` 只對 `Outbound` 與 `unsandboxed_bash` 發 confirm；`Deny` 回工具錯誤。`ApprovalMode` 保留 `read-only`（wake 的研究 worker）、`auto`（預設）、`full-access`（引擎蓋可設，仍不跳 `Deny`）。per-session picker 退場後，mode 由 gateway 在 `deliver` 時指定（06 的 `read_only`）。

**瀏覽器（`features/browser.rs` + node `browser/manager/ops.rs`）**：node 邊界對每個 op 看實際 target origin：非 localhost 的 `click`/`type`/`press`/`select`/下載/表單送出 → 回 `needs_action` 給 agent 側，agent 側發 confirm（紅線 2）；`read-only` mode 直接拒。navigate/snapshot/screenshot/scroll/wait 不問。`hosts.rs` 的 localhost 判斷抽成共用函式。

**relay 進房間**：worker 的 confirm interaction（只有這兩種）→ gateway `delegations.rs` 把它寫成房間 `kind='question'` 訊息（面孔說「工人想 `git push` 到 origin/main，可以嗎？」）+ push「等你回話」；你的下一句話由頭腦判斷 yes/no 並呼叫 `answer_worker_question {id, yes}` → 沿用 `relayed-answer` 路由。超時（沿用 interaction TTL）→ 工人收到 declined，房間 line。

**security-decisions**：新增「Nothing writes unasked」一節，記 residual risk：prompt injection 可讓工人在沙箱裡改 code、commit、裝套件；接受，因為沙箱與 git 是真正的邊界；outbound 與出沙箱仍要問。

## 工作項目

- [x] `rules.rs`：新類別與 git/gh/curl/wget/publish 規則；`Danger` 拆分；測試語料逐條標類別（沿用 `rules/tests.rs` 格式）。（2026-10-21）`Verdict` = `Read | Write | Outbound | Deny | Unknown`（嚴重度 Read < Write < Unknown < Outbound < Deny；`Deny` 一出現就停）。`Danger` 拆成：本機毀滅、工作區外的寫入/刪除、工作區根與 `.git`、agent 設定、憑證、`sudo`、系統服務/排程/設定、全域安裝（`npm -g`、`cargo install`、`go install`）、registry 登入（`npm/cargo/docker login`、`gh auth/secret/...`）、`curl | sh`、raw device、fork bomb、`git config --global` → `Deny`；`reset --hard`、`clean -f`、`checkout -- .`、`restore`、`branch -D`、`stash drop/clear`、`reflog expire`、`filter-branch`、`update-ref -d`、`gc --prune` → `Write`；所有 `git push`（`--dry-run` 是 Read）、`git send-email`、publish（npm/pnpm/yarn/bun、cargo publish/yank/owner、pip/uv publish、twine/gem）、`docker push`、`kubectl`/`helm` 變更、`terraform apply` → `Outbound`。`gh`：`GH_OUTBOUND` 動詞（create/merge/comment/review/close/edit/delete/...）、`release`（download 除外）、`gist` → `Outbound`；`gh api` 新函式 `classify_gh_api`：非 GET/HEAD 或帶 field（沒有 `-X GET`）→ `Outbound`，GraphQL 看 field 是否含 `mutation`，body 來自檔案或展開 → `Unknown`。`curl`/`wget` 帶 body / 非 GET method：URL 全是 localhost（`remote_urls`）→ `Unknown`，否則 `Outbound`。跟計畫不同：`git fetch` 仍是 `Write`（寫 refs，要 lease；照樣直接做）。
- [x] `classifier.rs`：輸出域限制；prompt 文案更新。（2026-10-21）verdict 只有 `read|write|outbound`；舊的 `dangerous` 讀成 `outbound`（問，不拒）；模型說不出 `deny`，`mod.rs` 也把非 read/write 一律當 outbound。prompt 改寫：沙箱內做了再說、git 是邊界、送出去要問。
- [x] `mod.rs`：`gate` 只問兩種；`Deny` 回錯誤；`read-only` mode 對 `Write`/`Outbound` 一律拒。（2026-10-21）`Deny` 在所有 mode 回「Refused: …, the user was not asked」；`auto` 只對 `Outbound` 發 `confirm_again`；`read-only` 對非 Read、`write`/`edit`、`unsandboxed_bash`、`sandbox_allow_domains` 一律拒、不問、不叫 classifier；`full-access` 什麼都不問（`Deny` 照拒）。**Allow again**（使用者 2026-10-21 定：做）：`Ui::confirm_again`（`allowAgain: true` 的 confirm，回答多 `again: true`），記在 `AutoMode.allowed`（kind + cwd + 原文），agent process 活著的期間有效；不支援的 UI 退回一般 confirm。
- [x] `features/sandbox.rs`：`sandbox_allow_domains` 歸 `Outbound`；`unsandboxed_bash` 不變。（2026-10-21）兩者照舊由 node 問（網域本來就是整個 session 有效）；`read-only` 在 gate 直接拒。`unsandboxed_bash` 的 node dialog 加 `allowAgain`，「再允許」記在 runner 的 `approved_exec`（原文 + 同 cwd），`NodeAnswer {confirmed, again}`；node 的 answer 解析保留 `again`（只在 yes 時）。
- [x] 瀏覽器 action 分類（agent + node 兩側）；`hosts.rs` 共用 localhost 判斷。（2026-10-21）共用函式放 `pirc-policy`：`is_localhost`、`url_host`、`url_is_localhost`、`url_origin`（agent 的 curl 規則與 node 都用；`hosts.rs` 的 `local_name_kind` 是瀏覽器 guard 的另一種語意，留著）。node `browser/manager/ops.rs` 的 `needs_action`：`click`/`type`/`select`/`press` 在非 localhost 頁面回 409 `needs_action`（訊息是 origin），除非請求帶 `allowAction` = 同一 origin。agent `features/browser.rs` 收到後：`read-only` 拒、`full-access` 直接重試、`auto` 問 `confirm_again`（「再允許」記 op + origin），同意後帶 `allowAction` 重試。`ToolContext` 加 `approval_mode`。下載與表單送出由 click / type submit / press 涵蓋。
- [x] relay：`delegations.rs` → 房間 question；`answer_worker_question` 工具；TTL。（2026-10-21）工人的 confirm（紅線）除了討論串的 question，另寫房間 `kind='question'` 訊息（`body.question` = interactionId、threadMessageId、request、status、expiresAt）+ push「A worker waits for your answer」；兩邊狀態同步（`settle_room_question`：answered + answer/answeredBy、expired、cancelled）。過了 `expiresAt` 還沒人答就消失 → `expired` + 房間 line「Nobody answered in time, so the worker was told no.」。頭腦工具 `answer_worker_question {id, yes, again?, quote}`：quote 必填，用 03 的 `quoted` 驗證是工人為之工作的人說的，走 `delegations::answer`（relayed-answer，node 仍決定）；不在 wake 裡（`NOT_IN_WAKES`）。prompt 的 `workers` 段落列出「Workers waiting for an answer」。
- [x] 引擎蓋：session 的 approval mode 顯示（唯讀）；`full-access` 的設定入口留在引擎蓋。（2026-10-21）composer 上方在 `read-only` / `full-access` 時顯示說明（只顯示不給選）；設定入口仍是 node config `features.autoMode.mode`。Web：`InteractionCard` 與 `ThreadPanel` 多一顆「Allow again this session」（`allowAgain` 時），房間的 question 訊息有 Yes / Allow again / No 與 Thread，回答後顯示結果（`questionOutcome`）。
- [x] conformance：`agent_auto_mode_*` 改寫；`node_browser` 加非 localhost click 被擋 / localhost 不擋；`brain_workers` 加紅線 relay 一來一回。（2026-10-21）`agent_auto_mode_ptc`：headless 的 push 被拒、`rm -rf ~` 直接拒；approval 加「再允許」後同一指令不再問；`deny_approval` 改名 `deny_with_ui`（有 UI 也直接拒）。classifier 快照只差 system prompt。`brain_workers` 加紅線：房間 question → 頭腦 quote 回答 → relayed-answer `{confirmed, again}` → 房間 question answered；以及逾時 → expired + line。跟計畫不同：`node_browser` 的瀏覽器在這台沙箱起不來（plan 06 起就如此），改以 node 單元測試 `actions_on_another_site_need_the_agents_human` 涵蓋 origin 判斷，conformance 留待有瀏覽器的機器補。

## 驗證

- `cargo test -p pirc-agent auto_mode`、conformance `agent_auto_mode_*`、`node_browser`、`brain_workers`。
- 手動：工人 `git push` → 房間出問題 → 回「可以」→ push 成功；`rm -rf ~` → 工人收到拒絕、房間無問題。

### 驗證結果（2026-10-21）

- `cargo test -p pirc-agent -p pirc-gateway -p pirc-config -p pirc-protocol -p pirc-policy` 全過（340 / 144 / 39 / 34 / 31）；`cargo test -p pirc-node` 302 過、2 個 `sandbox::linux::plan` host unix socket 測試照舊在這台沙箱失敗（與本 plan 無關）。
- conformance（release build）：全部通過，除了 `node_browser*`（沙箱裡沒有瀏覽器，快照未動）。改了快照的：`agent_auto_mode_classifier*`（prompt）、`agent_auto_mode_ptc*`、`agent_tools__agent_auto_mode`、`brain*`（工具多 `answer_worker_question`）、`brain_workers`（紅線一來一回）、`node_link_side_sandbox`（exec dialog 多 `allowAgain`）。
- web：`bunx vitest run` 全過（`workers.test.ts` 加房間紅線問題）；svelte-check 0 錯；prettier、`cargo fmt`、`cargo clippy --workspace --all-targets` 乾淨；release gateway 16,535,216 bytes（上限 16,777,216）。
- 手動（真模型：工人 `git push` → 房間問 → 回「可以」→ push 成功；`rm -rf ~` → 拒、房間沒問題）尚未做。

## 文件

- `docs/guides/tools.md` auto mode 段重寫；`security-decisions.md`（上）。
- 已寫（2026-10-21）：`tools.md` 的 Auto mode / Approval modes 重寫，加「Red lines in a room」「Browser actions」；`security-decisions.md` 新增「Two red lines」一節（residual risk、allow again、房間的問題、瀏覽器），Workers 一節的 danger 字眼改掉、拿掉「Not built: allow again」；`docs/deploy/node.md` 的 `deny` 說明（拒，不問）。

## 實作前待決

- ~~「Allow again in this session」for `unsandboxed_bash` 與 `Outbound`（existing-plans §7.2）~~ 使用者 2026-10-21 定：做，exact text + 同 cwd，session 內有效，不含 `Deny`。
- ~~`gh api` GraphQL 的 mutation 偵測~~ 照建議：body 含 `mutation` 即 `Outbound`；body 讀不到（`--input`、`@file`、展開）就 `Unknown`。
