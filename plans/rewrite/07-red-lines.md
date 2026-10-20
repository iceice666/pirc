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

- [ ] `rules.rs`：新類別與 git/gh/curl/wget/publish 規則；`Danger` 拆分；測試語料逐條標類別（沿用 `rules/tests.rs` 格式）。
- [ ] `classifier.rs`：輸出域限制；prompt 文案更新。
- [ ] `mod.rs`：`gate` 只問兩種；`Deny` 回錯誤；`read-only` mode 對 `Write`/`Outbound` 一律拒。
- [ ] `features/sandbox.rs`：`sandbox_allow_domains` 歸 `Outbound`；`unsandboxed_bash` 不變。
- [ ] 瀏覽器 action 分類（agent + node 兩側）；`hosts.rs` 共用 localhost 判斷。
- [ ] relay：`delegations.rs` → 房間 question；`answer_worker_question` 工具；TTL。
- [ ] 引擎蓋：session 的 approval mode 顯示（唯讀）；`full-access` 的設定入口留在引擎蓋。
- [ ] conformance：`agent_auto_mode_*` 改寫；`node_browser` 加非 localhost click 被擋 / localhost 不擋；`brain_workers` 加紅線 relay 一來一回。

## 驗證

- `cargo test -p pirc-agent auto_mode`、conformance `agent_auto_mode_*`、`node_browser`、`brain_workers`。
- 手動：工人 `git push` → 房間出問題 → 回「可以」→ push 成功；`rm -rf ~` → 工人收到拒絕、房間無問題。

## 文件

- `docs/guides/tools.md` auto mode 段重寫；`security-decisions.md`（上）。

## 實作前待決

- 「Allow again in this session」for `unsandboxed_bash` 與 `Outbound`（existing-plans §7.2）：建議做，exact text + 同 cwd，session 內有效，不含 `Deny`——因為 push 常常一個 session 做好幾次。**實作前定**。
- `gh api` GraphQL 的 mutation 偵測：body 含 `mutation` 關鍵字即 `Outbound`；不確定就 `Unknown` 給 classifier。
