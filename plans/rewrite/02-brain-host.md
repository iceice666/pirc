# 02 頭腦 host：pirc-agent 住進 gateway

[重寫](README.md) · [direction §2.1 / §5](../../docs/architecture/direction.md) · [決定](decisions.md) · [盤點 §4.1](inventory.md)

**目標**：gateway 進程裡跑一個 `pirc-agent` loop，身份由 gateway 設定的 `SOUL.md`/`CHAT.md` 定義，工具只有 gateway 側的（這份 plan 先只有 `web_search`），在房間裡以主持人面孔回話；全域一次一個 turn，typing debounce 決定何時開 turn。這是最大的技術風險，**先 spike 再做**。

**依賴**：00、01。**被依賴**：03–10。

## 決定（已定）

- 一個頭腦、一條 `LocalSet` thread、全域一次一個 turn；user turn 搶先 wake turn（#13）。
- Debounce 3 秒（偏好可調）；跑 turn 中的訊息合成一次 steer；逃生口跳過 debounce（#16）。
- 身份熱更新：SOUL/CHAT/偏好改了，下一個 turn 生效（§5）。

## Spike（先做，約一天，結果決定後面怎麼寫）

- [x] 在 `pirc-gateway` 開一條 `std::thread` 跑 `tokio::task::LocalSet`，用 `AgentOptions` 建一個 `Agent`：tools = `[]`、features = `[]`、`Ui` = 記錄用 stub、`StreamFn` = 直接呼叫 `pirc-providers::Inference`（不走 node socket）、store = `SessionStore` 指向 `$PIRC_STATE_DIR/brain/`。（2026-10-20）`brain/mod.rs` + `brain/stream.rs`：thread `pirc-brain` 上 current-thread runtime + `LocalSet`，gateway 其他部分用 channel 下命令。HTTP 不在頭腦 thread 跑：`GatewayStream` 把 `Inference::run` spawn 到 gateway 主 runtime（backends 與 HTTP client 在那），delta 經 channel 回來；abort / 逾時就 drop 那個 task（HTTP 請求跟著斷）。每房間一個 `SessionStore`（`brain/rooms/<room>/`）。
- [x] 送一個 prompt、拿到 streaming 回覆、寫進 `room_messages`。（2026-10-20）`cargo test -p pirc-gateway brain` 2 passed：假 `StreamFn` 逐字吐 → 一則 `face:host` 訊息先 `room_message` 再一串 `room_message_updated`，第二個 turn 帶著第一輪對話（存在磁碟）；另一個用本機 `openai-completions` SSE server 走 gateway 自己的 `Inference`，回覆寫進房間、請求帶頭腦身份。
- [x] 確認：`Agent::new` 不帶 `PathGuard`/hooks/PTC 能否建構（盤點說 :673–777 無條件建）；`refresh_models` 的注入點；`channels.rs` thread-local 不干擾。（2026-10-20）見下方「Spike 結果」。
- [x] 記錄要改哪些 `pirc-agent` 介面，寫回這份 plan 再繼續。（2026-10-20）見下方「Spike 結果」，設計節已照改。

### Spike 結果（2026-10-20）

1. **建得起來，PathGuard / hooks 不必拿掉。** `Agent::new` 照樣建 `PathGuard` 與 `HookRunner`，但頭腦沒有檔案工具、`HooksConfig` 是空的，兩者都不會被用到；不值得為它們分路。頭腦永遠不設定 hooks（盤點 §4.2）仍成立。
2. **PTC 一定要拿出 `Agent::new`，理由是大小。** gateway release 執行檔：plan 01 後 10.04 MB；接上 spike 15.34 MB（預算 16 MiB = 16.78 MB）；只把 `ptc::model_tools` 的呼叫拿掉 12.69 MB。差的 2.65 MB 幾乎全是 `pirc-ptc` preflight 的 `oxc`（TypeScript 剝型別）。runtime flag 擋不住 LTO，所以 PTC wrapper 改由 worker host 注入（`HostProfile::Worker` 帶 factory），`pirc-agent` 核心不再直接引用。另外：worker 的模型只直接看得到 `ptc`/`ptc_docs` 與 9 個 core capability（`DIRECT_CAPABILITIES`），其他工具都得寫 script 呼叫——頭腦沒有 guest，所以 Brain 必須把工具全列成 direct tools。
3. **`prompt_sections` 永遠加 `cwd` 與 capability index。** 前者會把 `$PIRC_STATE_DIR/brain` 路徑告訴模型；Brain 兩個都不加。
4. **`refresh_models` 只會走 node socket**（`config.models.inference`）。spike 只在建 agent 時讀一次 `app.public_models()`，之後 backends 改了看不到 → 注入 `ModelCatalog`。
5. **`channels.rs` 的 thread-local 不干擾核心**：核心從不呼叫 `node_channels()`；只有 `assistant`、`sandbox`、`team` feature 會，而它們在 gateway 裡會把 JSON 行寫到 **gateway 的 stdout**。所以 Brain 的 feature 組絕不能含這三個；舊 `web_search` feature 走 node 的 gateway channel，Brain 要自己的 `web_search` 工具直接呼叫 gateway 的 `WebSearch`。
6. **`Agent::prompt` 會把 `/xxx` 當 feature 指令**（`try_command`）：房間裡有人打 `/compact` 就會在頭腦上跑 compaction。房間文字一律當話，不解析指令 → Brain 用不經 `try_command` 的入口。
7. **Streaming 寫 DB 的頻率與 `edited_at`。** 每個 delta 一次 `update_message` 會讓訊息看起來「被編輯過」，也太頻繁 → streaming 中的更新要節流（~250 ms），並且不算 edit（訊息 body 帶 `streaming: true`，結束時拿掉，`edited_at` 不動）。
8. **`AgentConfig` 不拆。** worker 專用欄位（`path_policy`、`hooks`、`role_dirs`…）頭腦一律填空值；`mode` 填 `default_work()`，它只影響 feature 預設，而頭腦的 feature 是自己挑的。

**改過的 `pirc-agent` 介面（設計節已更新）**：`AgentOptions.host: HostProfile`（`Worker { model_tools }` / `Brain`）；`stream_override` → `stream`（注入的 `StreamFn`，沒給就照舊用 `RemoteStream`）；`models: Option<Rc<dyn ModelCatalog>>`；`Agent::say`（不經 `try_command` 的 prompt/steer）；`Agent::set_base_prompt`（每 turn 換 SOUL/CHAT 區塊，取代 `fresh_each_turn`）。

## 設計

**`pirc-agent` 側（改）**

- `AgentOptions` 新增 `host: HostProfile`：`Worker { model_tools }` 帶 PTC wrapper 的 factory（`HostProfile::worker()` 填 `ptc::model_tools`，只有 node 的 `run.rs` 與測試呼叫，gateway 連結不到 `oxc`）；`Brain` 不建 PTC wrapper、所有工具都是 direct tools、system prompt 不加 capability index 與 `cwd`。Brain 不載入 builtin fs/shell/browser tools，不讀 cwd 的 AGENTS.md / skills（它的 `AgentConfig` 由 gateway 直接填，不走 `load_agent_config`）。`PathGuard`/`HookRunner` 照建但閒置（spike 結果 1）。
- `stream_override` 改名 `stream`：注入的 `StreamFn`，沒注入才用 `RemoteStream`（worker）；`refresh_models` 先問注入的 `ModelCatalog` trait，沒注入才走 node socket。
- `Agent::say(text, images)`：房間的話，不經 `try_command`；agent 閒著就開 run，正在跑就 steer。
- `Agent::set_base_prompt(sections)`：取代 `config.system_prompt` 的基底區塊；頭腦每個 turn 開始前呼叫（SOUL/CHAT 熱更新）。不另做 `fresh_each_turn`。
- `Ui` 的 brain 實作：dialog 一律回 `None`（頭腦不開 blocking dialog）；`ask_question` → 房間 `kind='question'` 訊息留給 05–07 有工具會問時再做。
- feature 分組：Brain 這份 plan 不帶 feature（`compact` 只是 `/compact` 指令，而房間的話不當指令；自動 compaction 在核心）；`web_search` 是 gateway 自己的工具（`brain/tools.rs`，直接呼叫 `web_search.rs`），不是 `features/web_search.rs`（那個走 node channel，spike 結果 5）。OM（`features/memory`）留給 03 一起開。

**Gateway 側（新）**

- `brain/mod.rs`：`Brain` 服務。擁有 LocalSet thread、`Agent`、turn queue。
- `brain/scheduler.rs`：**turn queue**。輸入：`room_pending` 的 debounce 到期（最後按鍵或送出 +3 秒且無 typing）、`send_now` flag、（05 的）wake 請求。規則：一次一個 turn；user turn 永遠排 wake 前；正在跑 wake 時 user turn 到 → abort wake（標記 `preempted`，05 決定重排）；正在跑 user turn 時新訊息到 → debounce 後合成一次 steer（沿用 `agent.rs` 的 steer 語意）。單 turn 10 分鐘 timeout → abort + 房間 line。
- `brain/identity.rs`：`$PIRC_CONFIG_DIR/SOUL.md`、`CHAT.md`（從 node 搬來，沿用 `assistant_prompts.rs` 的 inspect/write/writability 規則；那個檔案在 00 的 `526123f` 刪了，從它的父 commit 取回）；`PUT /api/brain/prompts/:name`；每 turn 重讀（content hash 變了才重建 section）。
- `brain/turn.rs`：組 turn 的輸入：房間最近訊息（整批 pending 作為一個 user message，多則用分隔）、房間 id、speaker 固定 `face:host`（10 改成路由）。輸出：assistant 訊息寫入 `room_messages`（streaming 用 `room_message_updated`，節流約 250 ms，body 帶 `streaming: true` 直到結束，不設 `edited_at`）；presence 事件 `brain_presence {face, state: idle|thinking}`（ephemeral、不 replay；房間 socket 的 `ready` 帶 `presence` 列出正在想的房間；10 擴成面孔 presence）。
- `brain/store.rs`：每房間一個 `SessionStore` 目錄 `$PIRC_STATE_DIR/brain/rooms/<room>/`；OM 壓縮沿用；房間封存不刪。
- 資源：單 turn timeout；connector 讀取 bytes 上限（09 用）；inference 失敗 → 房間 line「模型暫時不可用」，turn 標 failed。pending 的消費點改成「頭腦的對話收下了（agent admit）才從 `room_pending` 拿掉」：重啟落在交出與收下之間就重交；steer 進去但 turn 結束前沒被收下的會由新 turn 重試。失敗的 turn **不**重送同一批（那些話已在對話裡，重送會重複，也會在模型掛掉時無限重試）；下一則話開的 turn 會在對話裡看到它們。（2026-10-20 實作時改，原文是「pending 不清（下次重試）」。）

## 工作項目

- [x] Spike（上）。（2026-10-20）
- [x] `pirc-agent`：`HostProfile`、`StreamFn` 唯一化、`ModelCatalog` 注入、brain `Ui`、`fresh_each_turn` sections、feature 分組。worker 路徑行為不變（conformance agent\_\* 全綠）。（2026-10-20）`host.rs` 的 `HostProfile`/`ModelCatalog`、`AgentOptions.{stream,models,host}`、`Agent::say`/`set_base_prompt`（`agent/brain_tests.rs` 4 個）；brain 的 `Ui` 在 gateway（`brain/ui.rs`，dialog 一律 `None`，warning/error 記成 turn 的 error）。`web_search` 工具改吃 `SearchBackend`：node 的走 gateway channel，頭腦的直接呼叫 gateway 的 `WebSearch`（`brain/tools.rs`，有 `EXA_API_KEY` 才有）。
- [x] gateway `brain/*`；`main.rs` 啟停；`app.rs` 掛服務。（2026-10-20）`brain/{mod,scheduler,turn,identity,store,stream,tools,ui}.rs`；`Brain` 放在 `App::slots`（沒有新欄位），`main.rs` 在 port bind 前啟動、shutdown 時先停頭腦（abort 進行中的 turn，最多等 5 秒）。turn 紀錄是新表 `brain_turns`（schema 2，migration `db/migrations/2-brain-turns.sql`；啟動時沒結束的標 `interrupted`）。開發用 `PIRC_BRAIN=false` 不啟動頭腦（`rooms.rs` conformance 用它，房間 transcript 才不會混進回覆）；`PIRC_BRAIN_TURN_TIMEOUT_MS`（預設 600000）。
- [x] `room_pending` 消費與 debounce timer；`send_now`。（2026-10-20）批次到期 = send-now 立刻；否則最後一則 + debounce，且那個人的 typing 訊號（6 秒）已過期。送訊息與解封房間會 nudge 頭腦；封存房間的 pending 等解封。`take_pending` 換成 `consume_pending`（只拿掉頭腦收下的 id，剩下的保留、清掉 send-now）。消費點見設計節「資源」。
- [x] `/api/brain/prompts` 與 nix `soulPrompt`/`chatPrompt` 改指 gateway 的 config dir。（2026-10-20）`GET /api/brain/prompts`、`PUT /api/brain/prompts/:name`（`soul`/`chat`，規則同舊 `assistant_prompts.rs`）。nix：拿掉 00 加的 `mkRemovedOptionModule`，兩個 option 回來，由 gateway 的 `ExecStartPre` 連到 gateway 的 `PIRC_CONFIG_DIR`（預設 `/var/lib/pirc/daemon/.config/.pirc`）；option 拿掉時只刪指向 store 的 link。**沒有 nix 可以 eval，未驗證。**
- [x] 偏好「debounce 秒數」先放 `$PIRC_CONFIG_DIR/brain.json`（03 的偏好層接手）。（2026-10-20）`{"debounceSeconds": 3}`，0–60，每次排程重讀；壞檔記 log、用預設。
- [x] 引擎蓋：`GET /api/brain/turns?room=` 列最近 turn（開始/結束/中斷原因/token 用量）；`GET /api/brain/context?room=` 沿用 `ContextSnapshot`。（2026-10-20）只有 API；引擎蓋頁面的 UI 是 11 的事。
- [x] Web：面孔 presence 點（idle / 正在想）；question 訊息的樣式；`Cmd+Enter`。（2026-10-20）房間標題列的 pirc presence 點（想的時候閃）、typing 列的「pirc is thinking…」；streaming 中的回覆有游標、`aria-busy`；`question` 有左邊框與「asks you」，不併進同一人的連續訊息。`Cmd+Enter` 是 01 做的。
- [x] conformance：`brain.rs` scenario 用 fake LLM：三則短訊合成一 turn、turn 中送訊合成一次 steer、SOUL 改了下一 turn 生效、10 分鐘 timeout（用可調的測試值）。（2026-10-20）`tests/brain.rs` + `snapshots/brain__brain.snap`（timeout 用 3 秒、debounce 0.5 秒）；fake LLM 多一種 `Reply::Held`（等 semaphore 才回）。`rooms__rooms.snap` 只多了 `ready.presence: []`。

## 驗證

- `cargo test -p pirc-agent`（worker 不變）、`-p pirc-gateway brain`、conformance `brain` + 全部 `agent_*`。
- 手動：真模型，在 `#general` 連送三則，等 3 秒，一次回覆；回覆中再送一則，回覆結束前被納入。

**結果（2026-10-20）**：`cargo test -p pirc-agent` 341 + 34 passed；`-p pirc-gateway` 114 passed（`brain` 15 個：streaming、三則一 turn、typing 擋住、steer、失敗不重試、timeout、SOUL 下一 turn 生效、走 gateway 自己的 `Inference` 打本機 SSE server，另有 scheduler / identity / store / compose 單元測試）；`-p pirc-config` 39 passed；`cargo clippy --workspace --all-targets`、`cargo fmt --check` 乾淨。conformance（`target/release`，`--no-fail-fast`）：`brain`、`rooms` 與全部 `agent_*` 綠；只有 `node_browser` 4 個失敗，是這個沙箱裡 Chromium 起不來（`launchPersistentContext: Target page, context or browser has been closed`），跟這份 plan 無關。`brain`+`rooms` 連跑 5 次都綠。web：vitest 43 files / 308 tests、`svelte-check` 0 錯誤。gateway release 執行檔 13.06 MB（預算 16 MiB）。**手動真模型測試沒做**：這個沙箱連不到 provider，要使用者自己跑。

## 文件

- `docs/architecture/prompt-context.md` 重寫為 brain + worker 兩種 prompt 組成；`docs/development/gateway-and-node.md` 的「gateway never runs agents」改為「never runs sandboxed tools」；`docs/deploy/gateway.md` 加 SOUL/CHAT 位置與 brain 設定。

## 實作前待決

- 頭腦用 direct tools 還是另設受限 script runtime（decisions.md 待決）。**這份 plan 用 direct tools**；若 spike 顯示 PTC 的 capability metadata 很難繞過，再回來定。→ spike 後（2026-10-20）：不難繞過（`HostProfile::Brain` 直接列工具），而 PTC 連進 gateway 要多 2.65 MB，所以維持 direct tools；要不要另設受限 runtime 等哪個 plan 真的需要 script 再說。
- `#general` 以外的房間在 10 之前都由主持人回；這份 plan 不做路由。
