# 02 頭腦 host：pirc-agent 住進 gateway

[重寫](README.md) · [direction §2.1 / §5](../../docs/architecture/direction.md) · [決定](decisions.md) · [盤點 §4.1](inventory.md)

**目標**：gateway 進程裡跑一個 `pirc-agent` loop，身份由 gateway 設定的 `SOUL.md`/`CHAT.md` 定義，工具只有 gateway 側的（這份 plan 先只有 `web_search`），在房間裡以主持人面孔回話；全域一次一個 turn，typing debounce 決定何時開 turn。這是最大的技術風險，**先 spike 再做**。

**依賴**：00、01。**被依賴**：03–10。

## 決定（已定）

- 一個頭腦、一條 `LocalSet` thread、全域一次一個 turn；user turn 搶先 wake turn（#13）。
- Debounce 3 秒（偏好可調）；跑 turn 中的訊息合成一次 steer；逃生口跳過 debounce（#16）。
- 身份熱更新：SOUL/CHAT/偏好改了，下一個 turn 生效（§5）。

## Spike（先做，約一天，結果決定後面怎麼寫）

- [ ] 在 `pirc-gateway` 開一條 `std::thread` 跑 `tokio::task::LocalSet`，用 `AgentOptions` 建一個 `Agent`：tools = `[]`、features = `[]`、`Ui` = 記錄用 stub、`StreamFn` = 直接呼叫 `pirc-providers::Inference`（不走 node socket）、store = `SessionStore` 指向 `$PIRC_STATE_DIR/brain/`。
- [ ] 送一個 prompt、拿到 streaming 回覆、寫進 `room_messages`。
- [ ] 確認：`Agent::new` 不帶 `PathGuard`/hooks/PTC 能否建構（盤點說 :673–777 無條件建）；`refresh_models` 的注入點；`channels.rs` thread-local 不干擾。
- [ ] 記錄要改哪些 `pirc-agent` 介面，寫回這份 plan 再繼續。

## 設計

**`pirc-agent` 側（改）**

- `AgentOptions` 新增 `host: HostProfile::{Worker, Brain}`：Brain 不建 `PathGuard`、shell hooks、PTC runtime，不載入 builtin fs/shell/browser tools，不讀 cwd 的 AGENTS.md / skills。
- `StreamFn` 成為唯一 inference 入口；`RemoteStream` 變成 worker 的一個 `StreamFn` 實作；`refresh_models` 改走注入的 `ModelCatalog` trait。
- `Ui` 的 brain 實作：`ask_question` → 房間 `kind='question'` 訊息 + 等待下一個 user turn（不是 blocking dialog）。
- `context.rs`：section 來源可宣告 `fresh_each_turn`；`features/project_instructions.rs` 的凍結模式移除後，這裡是熱更新的機制。
- `features/mod.rs`：`builtin_features(profile)` 分 Worker / Brain 兩組。Brain 這份 plan 只帶 `compact`、`web_search`（直接呼叫 gateway 的 `WebSearch`，不經 node）。OM（`features/memory`）對房間 thread 開啟但 promotion 目標留給 03。

**Gateway 側（新）**

- `brain/mod.rs`：`Brain` 服務。擁有 LocalSet thread、`Agent`、turn queue。
- `brain/scheduler.rs`：**turn queue**。輸入：`room_pending` 的 debounce 到期（最後按鍵或送出 +3 秒且無 typing）、`send_now` flag、（05 的）wake 請求。規則：一次一個 turn；user turn 永遠排 wake 前；正在跑 wake 時 user turn 到 → abort wake（標記 `preempted`，05 決定重排）；正在跑 user turn 時新訊息到 → debounce 後合成一次 steer（沿用 `agent.rs` 的 steer 語意）。單 turn 10 分鐘 timeout → abort + 房間 line。
- `brain/identity.rs`：`$PIRC_CONFIG_DIR/SOUL.md`、`CHAT.md`（從 node 搬來，沿用 `assistant_prompts.rs` 的 inspect/write/writability 規則）；`PUT /api/brain/prompts/:name`；每 turn 重讀（content hash 變了才重建 section）。
- `brain/turn.rs`：組 turn 的輸入：房間最近訊息（整批 pending 作為一個 user message，多則用分隔）、房間 id、speaker 固定 `face:host`（10 改成路由）。輸出：assistant 訊息寫入 `room_messages`（streaming 用 `room_message_updated`）；presence 事件 `brain_presence {room, state: idle|thinking}`（10 擴成面孔 presence）。
- `brain/store.rs`：每房間一個 `SessionStore` 目錄 `$PIRC_STATE_DIR/brain/rooms/<room>/`；OM 壓縮沿用；房間封存不刪。
- 資源：單 turn timeout；connector 讀取 bytes 上限（09 用）；inference 失敗 → 房間 line「模型暫時不可用」，turn 標 failed，pending 不清（下次重試）。

## 工作項目

- [ ] Spike（上）。
- [ ] `pirc-agent`：`HostProfile`、`StreamFn` 唯一化、`ModelCatalog` 注入、brain `Ui`、`fresh_each_turn` sections、feature 分組。worker 路徑行為不變（conformance agent\_\* 全綠）。
- [ ] gateway `brain/*`；`main.rs` 啟停；`app.rs` 掛服務。
- [ ] `room_pending` 消費與 debounce timer；`send_now`。
- [ ] `/api/brain/prompts` 與 nix `soulPrompt`/`chatPrompt` 改指 gateway 的 config dir。
- [ ] 偏好「debounce 秒數」先放 `$PIRC_CONFIG_DIR/brain.json`（03 的偏好層接手）。
- [ ] 引擎蓋：`GET /api/brain/turns?room=` 列最近 turn（開始/結束/中斷原因/token 用量）；`GET /api/brain/context?room=` 沿用 `ContextSnapshot`。
- [ ] Web：面孔 presence 點（idle / 正在想）；question 訊息的樣式；`Cmd+Enter`。
- [ ] conformance：`brain.rs` scenario 用 fake LLM：三則短訊合成一 turn、turn 中送訊合成一次 steer、SOUL 改了下一 turn 生效、10 分鐘 timeout（用可調的測試值）。

## 驗證

- `cargo test -p pirc-agent`（worker 不變）、`-p pirc-gateway brain`、conformance `brain` + 全部 `agent_*`。
- 手動：真模型，在 `#general` 連送三則，等 3 秒，一次回覆；回覆中再送一則，回覆結束前被納入。

## 文件

- `docs/architecture/prompt-context.md` 重寫為 brain + worker 兩種 prompt 組成；`docs/development/gateway-and-node.md` 的「gateway never runs agents」改為「never runs sandboxed tools」；`docs/deploy/gateway.md` 加 SOUL/CHAT 位置與 brain 設定。

## 實作前待決

- 頭腦用 direct tools 還是另設受限 script runtime（decisions.md 待決）。**這份 plan 用 direct tools**；若 spike 顯示 PTC 的 capability metadata 很難繞過，再回來定。
- `#general` 以外的房間在 10 之前都由主持人回；這份 plan 不做路由。
