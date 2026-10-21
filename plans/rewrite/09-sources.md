# 09 來源（connectors）：email、行事曆、Moodle、輪詢

[重寫](README.md) · [direction §3.1](../../docs/architecture/direction.md) · [決定](decisions.md)

**目標**：頭腦看得到的東西全部是唯讀 connector，憑證全在 gateway；gateway 以每來源的 cadence 輪詢（純 Rust，不花 model），由 Rust 先篩，值得看才觸發 wake；所有內容帶 `tool:<source>` origin；房間可限定來源。Moodle 走它的 web service API（和官方 Moodle App 同一條登入路），不經瀏覽器。研究模式瀏覽器是第二步。

**依賴**：02（工具）、05（wake 觸發）、08（workspace 來源）。第二步的研究模式瀏覽器另依賴 07（瀏覽器 action 分類）。**被依賴**：10（房間來源範圍的展示）。

## 決定（已定）

- 憑證 UI 與 model backend 同頁、同 management grant；per-source 暫停（#6）。
- cadence：email 5 分、行事曆 15 分、Moodle 60 分、workspace 一日一次（#3）。
- 研究模式邊界（#8）：localhost 不含私網；click/type/下載/送表單是 action。
- 寫入側（寄信、建事件、交作業、發文）不在範圍（§7）。
- **第一版範圍**（2026-10-21，[決定 #17](decisions.md)）：
  - Email：IMAP + app password，第一版要接**個人 Gmail 與學校 Gmail（Workspace）**兩個帳號；同一 kind 可以有多個來源。Gmail API + 使用者自己的 OAuth client（`gmail.readonly`）是第二步。
  - 行事曆：ICS 訂閱網址（Google 私密 iCal 網址、Moodle 匯出）+ CalDAV（密碼）。Google 的 CalDAV 只收 OAuth，所以 Google 行事曆第一版走 ICS。
  - Moodle：自寫的 web service 來源（不整合 moodle-mcp，見下）。
  - 研究模式瀏覽器移到第二步；第一版不碰 node、不升協定。
- **Wake 由 Rust 先篩**（2026-10-21，#17）：一次 poll 最多一個 wake；只有房間訂閱該來源、或變化以 FTS 命中某個 open loop 的文字才 enqueue；其餘只寫進 `source_items`（可搜、帶 origin），不開 wake、不花配額。摘要純 Rust（寄件人 / 主旨 / 時間），不花 model。

### 為什麼 Moodle 不整合 moodle-mcp

參考的是 [G36maid/moodle-mcp](https://github.com/G36maid/moodle-mcp)（Rust、MIT、0.2.1，2026-10-19）。不整合的理由：pirc 沒有 MCP client，當 MCP 用等於為一個來源加一整套機制、gateway 還要跑沒有沙箱的外部程式；當 library 用會帶進 `rmcp`、`inquire`、`anydoc`、`tracing-subscriber` 與寫入工具（`submit_assignment`、發文、`send_message`、`call_ws_function`），API 也還在變。Moodle web service 只有一個 endpoint，自寫成本低，唯讀由白名單保證。照抄的是它的登入方式（`login/token.php`，`service=moodle_mobile_app`）與函式選擇；SSO 不用每校一個 driver，改用通用的 `launch.php` 貼回網址。

## 設計

**框架**（`sources/mod.rs`）：

```rust
trait Source {
    fn id(&self) -> &str;              // "email:gmail-personal"、"moodle:school"
    fn kind(&self) -> SourceKind;      // Email | Calendar | Moodle | WebSearch | Workspace
    async fn poll(&self, cursor: Option<Cursor>) -> Result<Poll { changes: Vec<Change>, cursor }>;
    fn tools(&self) -> Vec<Box<dyn Tool>>; // 頭腦的唯讀工具
}
```

`sources` 表：`id, kind, config_json (無憑證), paused_at, cursor_json, last_polled_at, last_error`。憑證在 `$PIRC_STATE_DIR/sources/secrets.json`（0600，沿用 backends 的檔案模式與 management grant）。ICS 網址本身就是祕密，也放這裡。

`source_items` 表（新）：`id, source_id, external_id, kind ('message'|'event'|'assignment'|'notification'), title, who, at, summary, url, created_at`，接 FTS；origin 一律 `tool:<source-id>`。poll 的每個變化都寫進來（同 `external_id` 更新不重複），頭腦之後用各來源的 search 工具找得到。

**Poller**（`sources/poller.rs`）：每來源一個 timer，`paused_at` 跳過；`poll` 的變化先寫 `source_items`，再由 Rust 篩：房間 `source_scope` 含此來源，或變化的 title/who 以 FTS 命中 open loop 文字 → `wake::enqueue(kind='source', trigger={source, items:[…摘要]})`（05），一次 poll 合成一個 wake；沒命中的不 enqueue。錯誤 → `last_error`，連續 3 次 → 房間 line「X 來源讀不到」一次，不重複；token 失效（Moodle `invalidtoken`、IMAP 認證失敗）的 line 寫「要重新登入」。

**各來源**：

| 來源       | 實作                                                                                                                                                                                                                    | 工具（頭腦）                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Email      | IMAP（`async-imap` + rustls）+ app password；`EXAMINE` 唯讀開、`BODY.PEEK` 讀（不改已讀）；cursor = `UIDVALIDITY` + 最後 UID。Gmail 預設 `imap.gmail.com`，用 `X-GM-RAW`（Gmail 搜尋語法）、`X-GM-THRID`、`X-GM-LABELS` | `email_list`、`email_read`、`email_search`                                                                         |
| 行事曆     | ICS：`GET` + ETag，ical 解析，比對視窗內事件的增改刪；CalDAV：`reqwest` REPORT + 同一個解析                                                                                                                             | `calendar_list {range}`、`calendar_read`                                                                           |
| Moodle     | `POST /webservice/rest/server.php`（`wstoken`、`wsfunction`、`moodlewsrestformat=json`）；**唯讀函式白名單**，沒有萬用 escape hatch；輪詢 = action events 與通知的差異                                                  | `moodle_courses`、`moodle_deadlines`、`moodle_assignment`、`moodle_course`、`moodle_forum`、`moodle_notifications` |
| Web search | 既有 `web_search.rs` 包成 Source（不輪詢）                                                                                                                                                                              | `web_search`（02 已有）                                                                                            |
| Workspace  | 08 的 `WorkspaceRead`，輪詢 = `git log -1` 的 hash 比對                                                                                                                                                                 | `workspace_read`（08 已有）                                                                                        |

**Moodle 白名單**（第一版）：`core_webservice_get_site_info`、`core_enrol_get_users_courses`、`core_calendar_get_action_events_by_timesort`、`mod_assign_get_assignments`、`core_course_get_contents`、`mod_forum_get_forum_discussions`、`message_popup_get_popup_notifications`。檔案下載與 `pluginfile.php` 第一版不做。

**Moodle 登入**：

1. 帳密：`POST /login/token.php`（`username`、`password`、`service=moodle_mobile_app`），與官方 App 相同。只存回來的 token，**不存密碼**。
2. SSO（帳密那條回 `invalidlogin` 時）：設定頁給一個 `admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=<隨機>&urlscheme=moodlemobile` 連結，使用者在自己的瀏覽器登入後，把被導到的 `moodlemobile://token=…` 網址貼回；gateway 解 base64、以 `md5(wwwroot + passport)` 驗簽、取 token。沿用 Anthropic OAuth「貼回 callback URL」的 UI。
3. 兩條都存 token；`core_webservice_get_site_info` 當「測試」。

**Origin 與房間範圍**：所有工具結果、`source_items` 與 poll 摘要帶 `tool:<source-id>`；03 的 `remember` 與 04 的 `open_loop` 由此推導 origin。`rooms.source_scope_json` 列出房間訂閱的來源；Rust 篩選與 wake 的「值得說」（05）看這個；頭腦在房間裡呼叫來源工具不受限（只是預設不主動說）。

**憑證 UI**：Settings 的 backends 頁加「來源」區：新增（kind、名稱；Email：伺服器、帳號、app password，Gmail 有預設值與「去哪裡建 app password」的連結；行事曆：ICS 網址或 CalDAV 伺服器/帳號/密碼；Moodle：網址 + 帳密，或 SSO 貼回網址）、測試、暫停、刪除；device token 不可達（同 providers）。

## 工作項目

- [ ] `sources/{mod,poller,store,secrets,items}.rs`；`source_items` + FTS（gateway migration）；API `GET/POST/PUT/DELETE /api/sources`、`POST /api/sources/:id/{test,pause,resume}`。
- [ ] Rust 篩選：房間訂閱 / open loop FTS 命中 → 一次 poll 一個 wake；其餘只記。
- [ ] Email（IMAP + app password，Gmail 擴充）；工具與 prompt 文案；body HTML → 純文字與截斷（02 的 bytes 上限）。
- [ ] 行事曆（ICS + CalDAV）；工具。
- [ ] Moodle（token 兩條登入路、白名單、輪詢）；工具。
- [ ] Web search、workspace 包成 Source。
- [ ] 房間 `sourceScope` 的 API（01 已有欄位）與頭腦工具 `room_sources`。
- [ ] Web：Settings 來源區（含 Moodle SSO 貼回）；房間設定的來源勾選。
- [ ] conformance：`sources.rs`（fake IMAP / ICS / Moodle server）：輪詢 → 命中 loop 才 wake、沒命中只進 `source_items`；暫停不輪詢；origin 標記；白名單外的 Moodle 函式不會被呼叫；憑證與 token 不出現在任何 API 回應。
- [ ] 量 gateway 大小（`bun run size:check`，budget 32 MiB）。

### 第二步（不在第一版）

- Gmail API + 使用者自己的 Desktop OAuth client，scope `gmail.readonly`（最小權限，取代 app password）；處理 Testing 狀態 refresh token 7 天過期。
- 研究模式瀏覽器：gateway → node 的 `BrowserResearch` RPC（協定 16）；gateway 挑有 browser 能力的 node（08），以 `research: true` 開不綁 session 的 context（`browser/manager`）；07 的分類在 node 強制；cookie 在 node 的 profile（§3.1 的唯一例外，記進 security-decisions）；輪詢 = 頭腦自排的 wake（60 分）用 `browser_snapshot` 比對；conformance `node_browser` 加研究模式 context 的 click 被擋。只給真的沒有 API 的網站。

## 驗證

- conformance `sources`、`brain_wake`（來源觸發）。
- 手動：接真 Gmail（個人與學校），寄一封信給自己 → 5 分內進 `source_items`；有相關 loop 時 `#general` 出現摘要，否則無聲；暫停後不再。接真 Moodle，`moodle_deadlines` 列出這週的作業。

## 文件

- `docs/deploy/gateway.md` 來源設定與憑證位置；`security-decisions.md`：來源內容不可信、origin 是防線、app password 是整個信箱的權限（程式只讀，憑證在 gateway）、Moodle token 只呼叫白名單；`docs/guides/` 新 guide 的來源段。

## 實作前待決

- ~~第一版做哪些來源~~ 已定（2026-10-21）：Gmail IMAP + app password、ICS + CalDAV、Moodle web service；研究瀏覽器與 Gmail OAuth 第二步。
- ~~輪詢結果的摘要由誰產生~~ 已定（2026-10-21）：純 Rust；wake 由 Rust 先篩。
- 學校 Gmail（Workspace）能不能建 app password：管理員可能關掉。不能的話，學校信箱要等第二步的 Gmail OAuth（管理員也可能擋未驗證的 app），或第一版就把 OAuth 拉進來。
- Moodle：學校登入頁寫「與 SSO 相同的帳密」，官方 App 可登入。帳密那條（`token.php`）若回 `invalidlogin` 就走 SSO 貼回；兩條都做，不需先定。
