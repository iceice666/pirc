# 09 來源（connectors）：email、行事曆、研究模式瀏覽器、輪詢

[重寫](README.md) · [direction §3.1](../../docs/architecture/direction.md) · [決定](decisions.md)

**目標**：頭腦看得到的東西全部是唯讀 connector，憑證全在 gateway；gateway 以每來源的 cadence 輪詢（純 Rust，不花 model），有變化才觸發 wake；所有內容帶 `tool:<source>` origin；房間可限定來源。沒有 API 的網站（Moodle）經 node 的研究模式瀏覽器。

**依賴**：02（工具）、05（wake 觸發）、07（瀏覽器 action 分類）、08（workspace 來源）。**被依賴**：10（房間來源範圍的展示）。

## 決定（已定）

- 憑證 UI 與 model backend 同頁、同 management grant；per-source 暫停（#6）。
- cadence：email 5 分、行事曆 15 分、瀏覽器來源 60 分、workspace 一日一次（#3）。
- 研究模式邊界（#8）：localhost 不含私網；click/type/下載/送表單是 action。
- 寫入側（寄信、建事件）不在範圍（§7）。

## 設計

**框架**（`sources/mod.rs`）：

```rust
trait Source {
    fn id(&self) -> &str;              // "email:gmail-personal"
    fn kind(&self) -> SourceKind;      // Email | Calendar | WebSearch | Workspace | Browser
    async fn poll(&self, cursor: Option<Cursor>) -> Result<Poll { changes: Vec<Change>, cursor }>;
    fn tools(&self) -> Vec<Box<dyn Tool>>; // 頭腦的唯讀工具
}
```

`sources` 表：`id, kind, config_json (無憑證), paused_at, cursor_json, last_polled_at, last_error`。憑證在 `$PIRC_STATE_DIR/sources/secrets.json`（0600，沿用 backends 的檔案模式與 management grant）。

**Poller**（`sources/poller.rs`）：每來源一個 timer，`paused_at` 跳過；`poll` 有變化 → `wake::enqueue(kind='source', trigger={source, summary})`（05）；錯誤 → `last_error`，連續 3 次 → 房間 line「X 來源讀不到」一次，不重複。

**各來源**：

| 來源       | 實作                                                                                    | 工具（頭腦）                                       |
| ---------- | --------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Email      | IMAP（`async-imap` + rustls）；Gmail 走 IMAP + OAuth（沿用 `backends/oauth`）           | `email_list`、`email_read`、`email_search`         |
| 行事曆     | CalDAV（`reqwest` + ical 解析）；Google 走 CalDAV + OAuth                               | `calendar_list {range}`、`calendar_read`           |
| Web search | 既有 `web_search.rs` 包成 Source（不輪詢）                                              | `web_search`（02 已有）                            |
| Workspace  | 08 的 `WorkspaceRead`，輪詢 = `git log -1` 的 hash 比對                                 | `workspace_read`（08 已有）                        |
| 瀏覽器     | node 的 browser 以研究模式開；輪詢 = 頭腦自排的 wake（60 分）用 `browser_snapshot` 比對 | `browser_navigate/snapshot/screenshot`（研究模式） |

**研究模式瀏覽器**：頭腦呼叫時由 gateway 挑有 browser 能力的 node（08），以 `research: true` 開一個不綁 session 的 browser context（`browser/manager`）；07 的 action 分類在 node 強制；cookie 在 node 的 profile（§3.1 的唯一例外，記進 security-decisions）。self-wake 只拿研究模式；user turn 時也只拿研究模式——要 click/type 是 06 叫工人（它有 confirm 路徑）。

**Origin 與房間範圍**：所有工具結果與 poll 摘要帶 `tool:<source-id>`；03 的 `remember` 與 04 的 `open_loop` 由此推導 origin。`rooms.source_scope_json` 列出房間訂閱的來源；wake 的「值得說」（05）看這個；頭腦在房間裡呼叫來源工具不受限（只是預設不主動說）。

**憑證 UI**：Settings 的 backends 頁加「來源」區：新增（kind、名稱、伺服器、帳號、密碼/OAuth）、測試、暫停、刪除；device token 不可達（同 providers）。

## 工作項目

- [ ] `sources/{mod,poller,store,secrets}.rs`；API `GET/POST/PUT/DELETE /api/sources`、`POST /api/sources/:id/{test,pause,resume}`。
- [ ] Email（IMAP + OAuth）；行事曆（CalDAV + OAuth）；各自的工具與 prompt 文案；body 截斷上限（02 的 bytes 上限）。
- [ ] Web search、workspace 包成 Source。
- [ ] 研究模式瀏覽器：gateway → node 的 `BrowserResearch` RPC（協定 14 的一部分，與 08 合併升版）；不綁 session 的 context；07 的分類。
- [ ] 房間 `sourceScope` 的 API（01 已有欄位）與頭腦工具 `room_sources`。
- [ ] Web：Settings 來源區；房間設定的來源勾選。
- [ ] conformance：`sources.rs`（fake IMAP/CalDAV server）：輪詢 → wake；暫停不輪詢；origin 標記；憑證不出現在任何 API 回應；`node_browser` 加研究模式 context 的 click 被擋。

## 驗證

- conformance `sources`、`brain_wake`（來源觸發）、`node_browser`。
- 手動：接真 IMAP，寄一封信給自己 → 5 分內 `#general` 出現摘要（若有相關 loop）或無聲；暫停後不再。

## 文件

- `docs/deploy/gateway.md` 來源設定與憑證位置；`security-decisions.md`：來源內容不可信、origin 是防線、瀏覽器 cookie 例外；`docs/guides/` 新 guide 的來源段。

## 實作前待決

- 第一版做哪些來源：建議 email（IMAP）+ 行事曆（CalDAV）+ 研究瀏覽器；Gmail/Google OAuth 第二步。
- 輪詢結果的摘要由誰產生：純 Rust（寄件人 / 主旨 / 時間）即可，不花 model。
