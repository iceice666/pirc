# 單一執行檔 + 自製 agent（取代 Pi）

狀態：M1 已完成；M2–M7 已確認，進行中。

## 目標

- `pirc` 是一個 Bun 編譯出的單一執行檔，部署時不需要 Node、Pi 或 `node_modules`。
  - `pirc gateway`：daemon／單機 gateway（Web 靜態檔仍由 nginx 提供，之後可選擇嵌入）。
  - `pirc node`：遠端 node agent。
  - `pirc agent`（內部用）：單一 session 的 agent 行程，由 runner 以 `process.execPath agent …` 啟動。
- 以自製 agent loop 取代 Pi，針對本專案需求最佳化：
  - Provider：OpenAI Chat Completions 與 Anthropic Messages，共用同一套內部訊息格式。
  - Tool 執行支援本地 code-mode（PTC）：模型寫 TS/JS，在子行程沙箱執行，程式內可以呼叫已註冊的 tool。
  - 第一版內建（不做通用 extension 載入器）：ask-question、todo、background-task、compaction（cache-safe + observational memory）、agent-team。
- 舊 Pi session 不遷移，新格式從頭開始。

## 已驗證的前提（spike）

- `bun build --compile apps/gateway/src/node-agent.ts` 可直接產生可執行檔，fastify、ws、zod 都能正常運作。
- `better-sqlite3` 是 native addon，編譯後的執行檔仍然要從絕對路徑的 `node_modules` 載入 `.node`，**無法單獨部署**，所以要換成 `bun:sqlite`。
- 把 Pi 嵌進去在技術上可行（`PI_PACKAGE_DIR` + sidecar 資源），但 extension 需要 jiti；你選擇自製 agent，所以不採用這條路。

## 架構

```text
pirc (bun --compile)
├─ cli.ts             子命令分派：gateway | node | agent | version
├─ gateway/           既有 app/auth/nodes/events/database（改用 bun:sqlite）
├─ runner.ts          以 `execPath agent` 啟動子行程，協定維持 stdin/stdout JSONL
└─ agent/
   ├─ protocol.ts     RPC 指令與事件型別（沿用 Pi RPC 的子集合，web 端改動最少）
   ├─ messages.ts     內部訊息格式：user / assistant(text|thinking|toolCall) / toolResult / compactionSummary / custom
   ├─ providers/
   │  ├─ openai-chat.ts      SSE 串流 → 內部 delta 事件
   │  └─ anthropic.ts        SSE 串流，支援 thinking / cache_control
   ├─ loop.ts         turn loop：串流 → tool call → 結果回填；steer / follow-up 佇列、abort、重試
   ├─ session-store.ts  JSONL append-only（每個 session 一個檔，放在既有 privateSessionPath）
   ├─ tools/          read / write / edit / bash / grep / find / ls
   ├─ ptc/            code-mode：`execPath agent --ptc-worker` 沙箱子行程，透過 IPC 回呼 tool
   ├─ ui.ts           extension_ui_request（select/confirm/input/editor/notify）
   └─ features/       ask-question, todo, background-task, compaction, observational-memory, agent-team
```

為什麼 agent 仍然是子行程、不直接放進 gateway 的 process：

- 保留現有 runner 的隔離與崩潰恢復語意（epoch、interrupted run、outcome_unknown），gateway 的測試都能沿用。
- 子行程 cwd = workspace，bash tool 和 PTC 的行為比較單純。
- abort 時可以直接 kill 整個 process group。

## RPC 協定（沿用 Pi 子集合）

Web 和 gateway 目前依賴的指令與事件全部保留名稱與形狀，這樣 `apps/web` 幾乎不用改：

- 指令：`prompt`、`steer`、`follow_up`、`abort`、`clear_queue`、`get_state`、`get_messages`、`get_available_models`、`set_model`、`set_thinking_level`、`set_session_name`、`extension_ui_response`（另加 `compact`）。
- 事件：`agent_start`、`message_start/update/end`（`assistantMessageEvent`：`text_*`、`thinking_*`、`toolcall_*`）、`tool_execution_start/update/end`、`queue_update`、`agent_end`、`agent_settled`、`extension_ui_request`、`compaction_start/end`。

## 設定

Pi 的 `~/.pi/agent/*` 不再使用。設定分兩層，後者覆蓋前者：

1. 全域：`~/.config/.pirc/`（可用 `PIRC_CONFIG_DIR` 覆寫）
   - `config.json`：provider、預設模型、feature 設定、全域 hook
   - `AGENTS.md`：全域 system prompt
2. 專案：`<workspace>/.pirc/`
   - `config.json`：只允許 `allowedPaths`、`env`、`hooks`、`defaultModel` 這幾個欄位
   - `AGENTS.md`：附加在全域 prompt 之後（另外也讀 workspace 根目錄的 `AGENTS.md`）

```jsonc
{
  "providers": {
    "cliproxyapi": { "api": "openai-chat", "baseUrl": "…/v1", "apiKeyCommand": ["cat", "/run/secrets/…"], "models": [ … ] },
    "cliproxyapi-claude": { "api": "anthropic-messages", "baseUrl": "…", "apiKeyFile": "…", "models": [ … ] }
  },
  "defaultModel": { "provider": "cliproxyapi", "id": "gpt-6-astra", "thinking": "medium" },
  "allowedPaths": ["~/.nix"],
  "env": { "NIX_CONFIG": "…" },
  "hooks": { … },
  "observationalMemory": { … }
}
```

API key 支援 `apiKeyEnv`、`apiKeyFile` 和 `apiKeyCommand`，方便配合 sops-nix。

## 工作目錄限制與專案 hook

- **限制範圍**：檔案工具（read/write/edit/ls/grep/find）與 PTC 的檔案 API 只能存取 workspace 和 `allowedPaths`（依 realpath 判斷，防止 symlink 跳出）。bash 與 PTC 以 workspace 為 cwd 執行，並有逾時與輸出上限。**bash 本身不是沙箱**，這點與 Pi 相同。
- **自我提權防護**：agent 的檔案工具不能寫入 `<workspace>/.pirc/`，避免模型自己改 `allowedPaths` 或 hook。設定只在 agent 行程啟動時讀取。
- **Hook**：設定的是 shell 指令，從 stdin 收到 JSON，格式參考 Claude Code hooks：

  | Hook           | 時機                                                      | 效果                                                                         |
  | -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
  | `sessionStart` | agent 行程啟動                                            | stdout 附加到 system prompt                                                  |
  | `beforeTool`   | 每次 tool 執行前，可用 `matcher`（tool 名稱的 regex）篩選 | exit 2 = 拒絕，stderr 作為原因回給模型；stdout 若是 `{"args": …}` 則改寫參數 |
  | `afterTool`    | tool 執行後                                               | stdout 附加到 tool 結果                                                      |
  | `beforePrompt` | 使用者 prompt 送出前                                      | stdout 以隱藏 context 訊息注入                                               |
  | `agentSettled` | 一輪完全結束                                              | 只通知，不影響流程（例如格式化、跑 nix fmt）                                 |

  每個 hook 有 `timeoutMs`（預設 10 秒），失敗時送 `notify` 警告但不中斷流程（`beforeTool` 例外：逾時視為拒絕）。

## 里程碑

每一步結束時 `bun run check`（format + typecheck + test + build）都要能通過。

1. ✅ **M1 Bun 化**：npm → bun workspace；`better-sqlite3` → `bun:sqlite`；vitest 改在 Bun 上執行（或換成 `bun test`）；`cli.ts` 子命令；`bun build --compile` 產生 `dist/pirc`；web 靜態檔以 `import … with { type: 'file' }` 嵌入。此時 runner 暫時仍呼叫外部 `pi`。
2. ✅ **M2 Agent 核心**：`src/agent/`（messages、config、providers/openai-chat + anthropic、agent loop、session-store、sandbox、hooks、tools、rpc）；`pirc agent` 子命令；gateway 預設以 `execPath agent` 啟動 session（`PIRC_AGENT_COMMAND`／`PIRC_AGENT_ARGS` 可覆寫）。測試以 `test/fixtures/fake-llm.ts`（本地 SSE mock）跑真的 agent 行程，並加上 gateway → agent 的端對端測試。
   - 已知缺口：`nix/module.nix` 仍設定 `PIRC_PI_COMMAND`／`PIRC_PI_ARGS`，現在已被忽略，M7 移除。舊的 `fake-pi.mjs` 仍用於 node／remote 測試（只測 gateway 轉送，不依賴 agent 行為）。
3. ✅ **M3 互動與佇列**：steer／follow-up／abort／clear_queue；對話框支援 abort（agent 送出 `method:'cancel'`，gateway 把 interaction 標成 cancelled）；ask-question（多選、描述、自訂文字、headless 回傳 `unavailable`）；todo（custom entry 持久化、snapshot 注入、`agent_end` 提醒一次、`/todo` 指令、`get_commands`）；web 端新增 `WidgetPanel` 顯示 `setWidget`／`setStatus`。
4. ✅ **M4 PTC**：`code` tool 把模型寫的 TypeScript 函式本體交給 `pirc ptc-worker` 子行程（Bun IPC 回呼 tool，cwd＝workspace，獨立 process group、逾時、輸出上限、最多 500 次 tool 呼叫）；巢狀呼叫一律走 `agent.invokeTool`，所以路徑限制與 `beforeTool`／`afterTool` hook 照樣生效；`code` 不能遞迴呼叫自己。
5. ✅ **M5 Compaction 與記憶**：
   - 門檻觸發（`contextWindow - reserveTokens`）、context overflow 自動 compaction 後重試一次、`/compact`／RPC `compact`。
   - 預設 summarizer 沿用主對話前綴（system prompt、tools、history），所以會命中 prompt cache。
   - cache-safe-compaction 的暖快取（只在 `openai-chat` 且 `supportsLongCacheRetention` 時啟用）。
   - observational-memory 完整移植（`features.observationalMemory`）：
     - observer／reflector／dropper 背景 worker、V3 ledger、full-fold 前綴穩定、`recall` tool、`/om:status`、`/om:view`；
     - 限流冷卻與 fallback model；
     - prompt 逐字沿用。
   - 規格見 `plans/observational-memory-spec.md`。
6. ✅ **M6 背景工作與 agent-team**：
   - background-task：`background_task` tool 與 `/bg`；process group 管理；完成時合併成一次喚醒，已 `wait` 過的 task 不重複喚醒。
   - agent-team：子 agent = `pirc agent --headless` 子行程；broker 是 stdin/stdout 上的反向 RPC（`team_call`／`team_result`／`team_cancel`），不開 HTTP port。
   - kinds 預設只有 `general`，其餘由 `features.agentTeam.kinds` 設定。
   - 不移植 TUI transcript viewer。
7. ✅ **M7 發佈**：
   - `nix/package.nix`：固定輸出的 `nodeModules`（`--os='*' --cpu='*'`，所有平台共用一個 hash），`bun build --compile` 產生 `bin/pirc` 與 `share/pirc/web`；沙盒內以 bun 充當 `node`。
   - NixOS module：
     - 移除 `piPackage`／`piArgs`（改為 `mkRemovedOptionModule`，會提示遷移方式）；
     - 新增 `agentConfig`／`agentPrompt`，產生 `PIRC_CONFIG_DIR`；
     - `ExecStart = pirc gateway`。
   - README、`.env.example`、`nix/README.md` 更新。

M1 的已知缺口：`nix/package.nix` 仍然是 `buildNpmPackage`，需要 `package-lock.json`，所以 `nix build` 目前會失敗，要等 M7 改成 Bun 建置時一併修好。

## Extension 移植摘要

原始碼在 `~/.pi/agent/extensions/`（symlink 指向 nix store）。

| Extension             | 規模      | 移植難度 | 需要 agent 核心提供的能力                                                                                                                                               |
| --------------------- | --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ask-question          | ~350 LOC  | 低       | `extension_ui_request` 的 select/input；全域問題佇列（一次只顯示一題）；在 team worker 裡回傳 `unavailable`                                                             |
| todo                  | ~530 LOC  | 低       | session 的自訂 entry（不進 LLM context）；隱藏的 context 訊息；`agent_end` 時用 follow-up 提醒                                                                          |
| background-task       | ~550 LOC  | 低至中   | process group 管理；閒置時以 steer 喚醒 agent；`agent_settled` 事件                                                                                                     |
| cache-safe-compaction | ~130 LOC  | 很低     | 能產生位元組完全相同的 request 前綴；provider 支援 `cacheRetention: long`                                                                                               |
| observational-memory  | ~5000 LOC | 高       | 有穩定 entry id 的 session 樹；每則 assistant 訊息記錄 usage；可自訂 compaction summary 的 hook；和主 turn 並行的背景 sub-agent loop；fallback model 與 rate-limit 冷卻 |
| agent-team            | ~1300 LOC | 中至高   | 無介面（headless）的 RPC 模式 + steer + `agent_settled`；broker；`to:"user"` 的問題轉到 ask-question                                                                    |

設計上的結論：

- **Session store 從一開始就用樹狀 entry**（`{id, parentId, type, …}`），並區分 `message`、`custom`（不進 context）、`custom_message`（進 context）、`compaction`。observational memory 和 todo 都依賴這個。
- **內部 hook 介面**只做實際用得到的幾個：`beforeAgentStart`（system prompt／隱藏訊息）、`turnEnd`、`agentEnd`、`agentSettled`、`beforeCompact`（可回傳自訂 summary）、`sessionShutdown`。feature 以 TypeScript 模組編譯進執行檔，不做動態載入。
- **agent-team 的子 agent** = `execPath agent` 子行程，和 gateway runner 共用同一套 RPC；broker 改成走 stdin/stdout 的反向 RPC，不另開 localhost HTTP port。
- **TUI 專屬 UI**（questionnaire widget、`/bg` panel、`/team attach` transcript）不移植；web 端已經有 InteractionCard，其餘之後再視需要補 web 元件。
- **observational memory 的 prompt** 從 `agents/*/prompts.ts` 原樣複製。

## 已確認的決策

1. M2–M7 的切法與順序：照原計畫。
2. 設定與 system prompt 放在 `~/.config/.pirc/`。
3. PTC 只限制工作目錄、逾時與輸出大小；另加上面的專案 hook 與 `allowedPaths`。
