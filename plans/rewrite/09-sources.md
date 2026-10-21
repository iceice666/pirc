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

- [x] `sources/{mod,poller,store,secrets,items}.rs`；`source_items` + FTS（gateway migration）；API `GET/POST/PUT/DELETE /api/sources`、`POST /api/sources/:id/{test,pause,resume}`。（2026-10-21）`crates/pirc-gateway/src/sources.rs` + `sources/{store,secrets,poller,filter,tools,net}.rs`；items 在 `store.rs`（沒有另開 `items.rs`）。pirc.sqlite schema 7（`migrations/7-sources.sql`：`sources` 多了 `failures`、`noted_at`；`source_items` + `source_items_fts`，索引重建時一起重建）。憑證 `$PIRC_STATE_DIR/sources/secrets.json`（目錄 0700、檔案 0600、rename 寫入）。API 另加 `POST /api/sources/:id/poll`（立刻讀，等進行中的那次）、`GET /api/sources/:id/items?q=&limit=`、`POST /api/sources/moodle/launch`；device token 擋在 `auth::device_denied`，management grant 走 `Providers`（#6）。新增 / 改設定時先試、再**當場**取 baseline（計畫是下一次 poll 才取）：避免 poller 與 API 撞在一起，也讓來源一加就有東西。poller 是一個每 ≤60 秒看一次的迴圈（不是每來源一個 timer）；連 3 次失敗後間隔加倍。
- [x] Rust 篩選：房間訂閱 / open loop FTS 命中 → 一次 poll 一個 wake；其餘只記。（2026-10-21）`sources/filter.rs`：「命中」是共用一個特徵詞（含數字的詞如 `hw3`、三字母以上的非常見詞、CJK 雙字，切法同搜尋索引），loop 超過兩個詞時要兩個；房間訂閱優先（wake 在該房間），否則 loop 的房間。wake trigger `{sourceId, name, sourceKind, reason, loopIds, items(≤10), more}`；baseline 不 wake。
- [x] Email（IMAP + app password，Gmail 擴充）；工具與 prompt 文案；body HTML → 純文字與截斷（02 的 bytes 上限）。（2026-10-21）偏離：沒用 `async-imap`，`sources/imap.rs` 是自寫的小 client（LOGIN / EXAMINE / UID SEARCH / FETCH BODY.PEEK / LOGOUT，literal 收發、TLS 用 platform verifier，明文只限 loopback），gateway 少一串依賴；MIME 用 `mail-parser`（`full_encoding`，Big5 等）。Gmail 用 `X-GM-RAW`、`X-GM-THRID`（item 的 url 指向 Gmail 討論串）。工具 `email_list`、`email_search`、`email_read`（本文 20k 字、讀 512 KiB）。
- [x] 行事曆（ICS + CalDAV）；工具。（2026-10-21）`sources/ics.rs` 自寫 parser 與重複展開（DAILY–YEARLY、INTERVAL、COUNT、UNTIL、BYDAY 含序數、BYMONTHDAY、BYMONTH、EXDATE、RECURRENCE-ID 覆寫；其他部分只給第一次並註明），時區用 chrono-tz（TZID 取 IANA 名，其他與浮動時間用家裡的時區）。一個事件一個 item（不是每次發生），被刪的事件 summary 前加 `Removed:`。CalDAV 要填 calendar collection 的網址（沒做 discovery）。工具 `calendar_list`（預設 7 天、最多 92 天、不給 source 就全部）、`calendar_read`。
- [x] Moodle（token 兩條登入路、白名單、輪詢）；工具。（2026-10-21）`sources/moodle.rs`：`call()` 拒絕 `READ_ONLY` 以外的函式；帳密只換 token 不存；launch 驗簽 `md5(siteurl + passport)`（passport 30 分鐘）。輪詢 = action events（60 天）差異 + 比上次新的通知。工具 `moodle_deadlines`、`moodle_courses`、`moodle_course`、`moodle_assignment`、`moodle_forum`、`moodle_notifications`。
- [x] Web search、workspace 包成 Source。（2026-10-21）偏離：workspace 來源要自己加（`kind: workspace`，`config {workspace}`），不是每個 workspace 自動都是；一天一次用 08 的 `git_log` 比對 head。web search 不是一列 source：`GET /api/sources` 回 `webSearch.available`，工具仍是 02 的 `web_search`。另加 `source_search`（搜 `source_items`）。
- [x] 房間 `sourceScope` 的 API（01 已有欄位）與頭腦工具 `room_sources`。（2026-10-21）格式 `{sources: [id…]}`（其他鍵保留）；`room_sources {follow?, unfollow?}` 改了就在房間出一行，wake 時不在工具清單（`NOT_IN_WAKES`）。沒有該類來源的工具整組藏起來（`sources::tools::unused`）；prompt 有 `sources` 節（沒來源時沒有）。
- [x] Web：Settings 來源區（含 Moodle SSO 貼回）；房間設定的來源勾選。（2026-10-21）`SourceSettings.svelte` 在 Settings 的「Models & sources」頁（原 Models）：新增（試過才存）、Read now、Test、Pause / Resume、Sign in again、Remove（再按一次確認）、What it saw。房間頂列的 feed 圖示（`RoomSources.svelte`）勾選要訂閱的來源。wake 列表的來源 wake 寫出來源名。
- [x] conformance：`sources.rs`（fake IMAP / ICS / Moodle server）：輪詢 → 命中 loop 才 wake、沒命中只進 `source_items`；暫停不輪詢；origin 標記；白名單外的 Moodle 函式不會被呼叫；憑證與 token 不出現在任何 API 回應。（2026-10-21）另驗：錯的密碼 400；房間訂閱的行事曆有變化 → wake（無聲）；連 3 次失敗房間出一行；Moodle 帳密錯 400 `invalid_login`；不是這裡開始的 app login 被拒；頭腦讀 Moodle；fake IMAP 只收到 LOGIN / EXAMINE / FETCH / UID FETCH / LOGOUT；四個 secret 也不在任何一次 model request 裡。
- [x] 量 gateway 大小（`bun run size:check`，budget 32 MiB）。（2026-10-21）release gateway 15.88 → 17.22 MiB（budget 32 MiB）；node 不變。

另外（計畫沒寫、做了）：來源內容一律圍起來當不可信內容（`<<<SOURCE_CONTENT id=…>>>`，同 web results 的作法），工具結果、`source_search` 與 wake 收到的變化清單都是；source wake 的輸入以 `details.origin` 帶 `tool:<source>`（`pirc-agent` `entry_origin` 認這個與工具的 `source` 參數）。

### 第二步（不在第一版）

- Gmail API + 使用者自己的 Desktop OAuth client，scope `gmail.readonly`（最小權限，取代 app password）；處理 Testing 狀態 refresh token 7 天過期。
- 研究模式瀏覽器：gateway → node 的 `BrowserResearch` RPC（協定 16）；gateway 挑有 browser 能力的 node（08），以 `research: true` 開不綁 session 的 context（`browser/manager`）；07 的分類在 node 強制；cookie 在 node 的 profile（§3.1 的唯一例外，記進 security-decisions）；輪詢 = 頭腦自排的 wake（60 分）用 `browser_snapshot` 比對；conformance `node_browser` 加研究模式 context 的 click 被擋。只給真的沒有 API 的網站。

## 驗證

- conformance `sources`、`brain_wake`（來源觸發）。
- 手動（待做，要真帳號）：接真 Gmail（個人與學校），寄一封信給自己 → 5 分內進 `source_items`；有相關 loop 時 `#general` 出現摘要，否則無聲；暫停後不再。接真 Moodle，`moodle_deadlines` 列出這週的作業。

**結果（2026-10-21）**：`cargo test -p pirc-gateway` 167 passed（新增 `sources::*` 23 個：IMAP parser 與對 loopback 假 server 的整段 session、ICS 解析與重複規則、CalDAV 回應、Moodle 網址 / launch 驗簽 / 白名單、篩選、store、secrets 權限、圍欄；`auth`、`management` 的來源路由）；`-p pirc-agent` 341 + 34（新增 `source_reads_name_their_source`）、`-p pirc-config` 39；`cargo clippy --workspace --all-targets` 無警告；web `vitest` 334 passed（新增 `sources.test.ts`、`SourceSettings.test.ts`）、`svelte-check` 0；`bun run --filter @pirc/web build` + release build 後完整 conformance 全過（新快照 `sources`，既有快照沒變）。手動接真 Gmail / Moodle 還沒做。

## 文件

（2026-10-21）`docs/deploy/gateway.md`（Sources 節）、`secrets.md`、`backup-and-recovery.md`、`topology.md`、`upgrades.md`（schema 7）、`docs/architecture/security-decisions.md`（Sources are read-only and untrusted）、`prompt-context.md`、`docs/development/gateway-and-node.md`（Sources API）、`docs/guides/rooms-and-memory.md`（Sources 節，guide 改名含 sources）。

- `docs/deploy/gateway.md` 來源設定與憑證位置；`security-decisions.md`：來源內容不可信、origin 是防線、app password 是整個信箱的權限（程式只讀，憑證在 gateway）、Moodle token 只呼叫白名單；`docs/guides/` 新 guide 的來源段。

## 實作前待決

- ~~第一版做哪些來源~~ 已定（2026-10-21）：Gmail IMAP + app password、ICS + CalDAV、Moodle web service；研究瀏覽器與 Gmail OAuth 第二步。
- ~~輪詢結果的摘要由誰產生~~ 已定（2026-10-21）：純 Rust；wake 由 Rust 先篩。
- 學校 Gmail（Workspace）能不能建 app password：管理員可能關掉。不能的話，學校信箱要等第二步的 Gmail OAuth（管理員也可能擋未驗證的 app），或第一版就把 OAuth 拉進來。
- Moodle：學校登入頁寫「與 SSO 相同的帳密」，官方 App 可登入。帳密那條（`token.php`）若回 `invalidlogin` 就走 SSO 貼回；兩條都做，不需先定。
