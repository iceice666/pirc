# Pi 登入方式與 pirc Web 模型後端管理：研究

狀態：已實作（2026-09-27）。單人可信網路 threat model、gateway 集中推理；固定 `@mariozechner/pi-ai@0.73.1` 的三個內建登入。實作位置：`apps/gateway/src/backends/`（設定／OAuth／Pi adapter／推理）、`inference-wire.ts`、`node/inference.ts`、`agent/providers/remote.ts`、`apps/web/src/lib/components/BackendSettings.svelte`。未做真實登入與付費呼叫；下列研究內容保留作為設計依據。

實作時的偏離：

- Codex 不送 `max_output_tokens`：Pi 0.73.1 本身不送，Codex 訂閱後端不是公開 Responses API，避免每次請求被拒；`maxTokens` 對 Codex 不構成硬上限。
- Pi 路徑的錯誤只保留分類（HTTP 狀態、context overflow、usage limit），不回傳上游內容；Codex 以 `status NNN` 表示，避免 agent 重試疊加在 Pi 內建的三次重試上。
- 無金鑰的自訂 endpoint 使用固定佔位 bearer，確保 Pi 不會改用 gateway 環境變數中的金鑰；訂閱帳號缺憑證時直接失敗。
- 設定變更（登入、登出、編輯、reload）會取消進行中的推理；token 刷新不會。

## 1. 需求與結論

需求是從 **pirc Web UI 使用所採用 Pi 版本的所有內建登入方式，設定模型後端並實際對話**，不是只做 Codex，也不是要求使用者先到 node 執行 CLI。

可行方向：重用 `@mariozechner/pi-ai` 的 OAuth registry、登入／刷新函式與模型傳輸層；保留 pirc 的 agent loop、tools、session、compaction、memory、team。Web UI 橋接授權互動，gateway 保存帳號狀態。

但不能只新增登入按鈕或把 OAuth access token 填進現有 `apiKey`：必須一起解決不同模型 API、憑證更新、請求驗證及 replay metadata。

### 已確認的 threat model 與架構決策

使用者已明確選定：**單一使用者，在自己的可信 VPN／LAN 使用；gateway 集中執行模型請求。** 本節取代研究初期尚待選擇的多使用者 scope 與 A／B 架構建議。

- 信任邊界：操作者、gateway、已配對的自有 nodes 及其 OS 執行帳號視為同一管理／信任域；只有一位使用者不代表只有一個 node、瀏覽器分頁或並行 session。
- 帳號設定：後端、API keys、訂閱登入與預設模型是此單人部署的全域設定；操作者即可管理，不新增多租戶、per-user credential partition、RBAC 或管理員／一般使用者分層。未來支援多人必須重新審視，不以現有 allowedUsers 可列多個名字作為多人安全保證。
- 集中推理：gateway 保管 provider credentials、刷新 token、執行模型請求；node 保留 agent loop、工具、工作區與 session runtime，取得模型 metadata 與串流結果，不需收到 provider token。目標涵蓋 OAuth 與既有 API-key／自訂 endpoint 後端，不只是 Codex。
- 保護目標：避免網路端點誤暴露、未授權瀏覽器／node 存取、跨站請求、憑證意外進入 log／UI／session、OAuth 狀態混淆、並行刷新／取消競態，以及失控的重試與資源消耗。
- 不提供的保證：不防禦已攻陷的受信任 node／gateway、同 OS 使用者的惡意程序或任意 shell；不把 agent 工具或 OAuth worker 視為 sandbox，也不把 gateway 集中儲存宣稱為同主機的硬隔離。不同 OS user、每使用者 quota、KMS／加密落盤不是本階段必要條件。
- 仍是不可信資料：模型輸出、repository／網頁內容、provider 錯誤、瀏覽器輸入與授權回傳；可信網路不會讓這些內容成為操作授權，也不免除 XSS／CSRF 與 state 檢查。
- 保留現有 trusted-proxy／forward-auth、Host／Origin 與 node-token 驗證，以及既有安全傳輸要求；VPN／LAN 假設不等於核准移除認證或改成公開服務。若要簡化部署認證，另行決策。
- 登出語意：移除 pirc 的本地憑證、阻止新的模型請求／刷新，並取消或有界結束進行中的請求與連線；確切 drain／abort 策略在協定設計時定義。不能承諾撤回已送往 provider 的內容，也不能把本地登出描述成上游帳號撤銷。

本研究沒有核實各服務目前對第三方客戶端的商業授權／帳號政策。上游存在實作不等於服務商保證可用，也不代表所有訂閱方案都具備相同模型權限。

## 2. 上游版本與範圍

查詢 npm `latest` 得到 **`@mariozechner/pi-ai@0.73.1`**；對應 Git tag `v0.73.1`、commit `781152fc24841dc54b22284514604048ebe5e2c9`。npm repository 的舊網址 `badlogic/pi-mono` 會導向 `earendil-works/pi`。[S1][S2]

直接檢查原始碼 registry，並載入 npm 發布包驗證，內建 OAuth provider **共三個**：[S3]

| ID               | Pi 顯示名稱                           | 授權方式                                                    | 發布包模型目錄使用的 API                                       |
| ---------------- | ------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `anthropic`      | Anthropic (Claude Pro/Max)            | Authorization Code + PKCE；localhost callback／手動貼回結果 | `anthropic-messages`                                           |
| `github-copilot` | GitHub Copilot                        | Device code；可輸入 Enterprise domain                       | `anthropic-messages`、`openai-completions`、`openai-responses` |
| `openai-codex`   | ChatGPT Plus/Pro (Codex Subscription) | Authorization Code + PKCE；localhost callback／手動貼回結果 | `openai-codex-responses`                                       |

發布包目錄分別有 23、26、10 個 model entries；**這是內建目錄，不是對登入帳號查詢得到的可用權限清單**。UI 應區分「Pi 已知模型」與「帳號已驗證可用」。`getModels()` 本身讀取生成的靜態目錄，不會查詢帳號權限。[S9]

重要版本差異：上游在 **0.71.0（2026-04-30）移除 Google Gemini CLI 與 Google Antigravity**，包含 OAuth、模型與 provider exports。0.73.1 README 還殘留 Cloud Code Assist 的文字，不能據此認定 registry 有 Google 登入。[S4]

範圍建議：所有「固定採用版本目前內建」的登入方式。不要為了重現舊清單，悄悄鎖回舊版或自行復活被移除的服務；若需求包含歷史 provider，需另行確認。Pi extension 動態註冊的任意程式碼也不等於內建登入支援，本輪不建議提供 Web 上傳／執行 extension。

## 3. 可以直接重用的介面

`@mariozechner/pi-ai/oauth` 提供：[S3][S5]

- `getOAuthProviders()`／`getOAuthProvider(id)`：取得 registry，作為 UI 登入清單來源。
- `provider.login(callbacks)`：返回應由宿主保存的 credentials。
- `provider.refreshToken(credentials)`、`provider.getApiKey(credentials)`。
- `provider.modifyModels?(models, credentials)`：例如 Copilot 根據 token／Enterprise 更新 endpoint。
- `getOAuthApiKey(providerId, credentialsMap)`：若已到期就刷新，返回 `{ newCredentials, apiKey }`。

Credentials 基本欄位為 `refresh`、`access`、`expires`，並允許 provider 額外欄位。Codex 保存 `accountId`，Copilot 保存 `enterpriseUrl`。應保留完整 provider credentials，不能只存兩個 token 字串。

`getOAuthApiKey()` **不負責持久化或併發鎖**。Pi coding-agent 的 `AuthStorage` 另外處理鎖與回寫；pirc 可參考其設計，但沒有必要引入整套 coding-agent。[S10]

Web bridge 必須完整實作 callback vocabulary，而不是僅處理 authorization URL：

| Callback                                     | Web 對應                                 |
| -------------------------------------------- | ---------------------------------------- |
| `onAuth({url,instructions})`                 | 外部登入連結、說明／device code          |
| `onPrompt({message,placeholder,allowEmpty})` | 可等待使用者回覆的文字欄位               |
| `onProgress(message)`                        | 暫態進度                                 |
| `onManualCodeInput()`                        | 與 callback 同時等待的手動貼上欄位       |
| `onSelect({message,options})`                | 選項介面；取消回傳 undefined，不當成核准 |
| `signal`                                     | 傳遞取消，但不能假設所有實作確實使用它   |

0.73.1 三個內建 provider 沒有呼叫 `onSelect`，但公開介面已提供，通用 bridge 應覆蓋。OAuth 程式放 gateway/server，不能直接打包進瀏覽器執行。[S5][S13]

## 4. 各登入流程的具體限制

### Anthropic

原始碼使用固定 redirect `http://localhost:53692/callback`。即使使用手動輸入，登入前仍會先啟動 callback server；port bind 失敗會使登入失敗。[S6]

- 遠端瀏覽器的 localhost 是使用者的電腦，不是 gateway。
- `onManualCodeInput` 可接收最後 redirect URL；UI 應在授權連結旁直接提供貼上欄位，不要等 callback 才顯示。
- `PI_OAUTH_CALLBACK_HOST` 只改 bind host，不會把 redirect 改成 pirc 網址。不要藉由綁 `0.0.0.0` 暴露 callback port。
- 上游 login wrapper 沒有使用 `callbacks.signal`。取消時可 reject 等待中的 manual-input promise，但 token exchange 期間仍須 deadline／worker 終止與禁止晚到結果落盤。
- 同一固定 port 的登入應排隊／互斥，包含同一人的多分頁／重複登入；worker 子程序不會隔離 TCP port。
- 模型端不是一般 `x-api-key`：上游有 OAuth Bearer、特定 headers、system prefix 與工具名稱轉換。這些服務專用行為是重用傳輸實作的原因，也是需要另外核實服務政策的部分。[S11]

### OpenAI Codex

固定 redirect `http://localhost:1455/auth/callback`；可使用 manual input；port bind 失敗時會退到手動路徑。wrapper 同樣不使用 `callbacks.signal`。[S7]

- 遠端 Web UI 的可行基線是「開啟授權頁 → 完成登入 → 貼回最後 redirect URL」，不是保證自動跳回 pirc。
- 不應擅改 redirect URI 為自己的 Web domain；公開介面沒有提供通用 hosted callback 設定。
- 授權結果需擷取 account ID；模型呼叫使用 Codex 專用 API 與 account header，不是 `/chat/completions`。
- 手動 URL 應經 authenticated POST body 提交，不放入 pirc query string、通用事件紀錄或 localStorage。建議 bridge 驗證完整 URL 的預期 host/path/state，不把任意 URL 當可抓取資源。

### GitHub Copilot

Device flow 很適合遠端 Web：輸入 Enterprise domain（可留空使用 github.com），顯示驗證網址與 code，gateway 等待授權結果。[S8]

- Credentials 的 `refresh` 實際保存 GitHub access token，用它換短效 Copilot token；不是一般 OAuth refresh grant。交由 provider 處理，UI 不猜測欄位語意。
- `modifyModels()` 會根據 token 的 endpoint／Enterprise domain 更新模型 base URL。刷新後也必須重新套用，不能只更新 token。
- Enterprise domain 會成為 gateway 的 HTTP 目的地。在單人模型下，操作者可明確設定內部 Enterprise／本地模型服務，不需要多租戶式的獨立管理員 host allowlist。仍需驗證 URL／domain、阻止不支援的協定，避免 redirect 將授權 header 送到其他 origin；不可讓模型輸出或任意請求 payload 改寫已設定目的地。provider OAuth／token endpoint 保持上游 HTTPS 設定，授權結果 URL 只解析、不抓取。
- **登入函式會自動向所有已知 Copilot 模型 POST policy enable。** 這不只是讀取登入狀態；UI 必須在開始前揭露並取得明確同意。0.73.1 公開 login 介面沒有 skip 選項；若要分開模型啟用與登入，需小幅 upstream change／adapter patch，不能宣稱直接呼叫沒有副作用。
- 部分模型仍可能需在服務端／VS Code 手動啟用。登入成功不代表所有目錄模型都可以使用。

## 5. pirc 現況與整合位置

| 區域                                                   | 已確認現況與影響                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `apps/web/src/App.svelte:864-924`                      | 現有 Settings dialog；適合加入獨立 backend-settings component                               |
| `apps/web/src/lib/api.ts:40-56`                        | 同源 fetch、`credentials: include`；可加入 typed 設定／登入 session API                     |
| `apps/web/src/App.svelte:303-309`                      | `loadModels` 忽略空清單；登出後需容許清空，否則 UI 留下失效模型                             |
| `apps/gateway/src/daemon/auth.ts:8-31`                 | 已檢查 trusted proxy、Host、使用者；mutation 強制 Origin。新 API 沿用，不放寬 OAuth subtree |
| `apps/gateway/src/config.ts:40-47`                     | 只有 allowedUsers，沒有管理員角色                                                           |
| `apps/gateway/src/models.ts:34-80`                     | provider 層只有單一 API；Copilot 的多 API 模型不能原樣容納                                  |
| `apps/gateway/src/daemon/nodes.ts:243,308-312`         | 完整全域 provider／金鑰送到所有 node，不是個人帳號隔離                                      |
| `apps/gateway/src/node/runner.ts:57-58`                | 只在 agent 啟動第一行 stdin 傳送 models                                                     |
| `apps/gateway/src/agent/rpc.ts`                        | 沒有執行中憑證更新 RPC                                                                      |
| `apps/gateway/test/models.integration.test.ts:103-124` | 明確驗證舊 agent 保留舊金鑰；OAuth 不可只更新 ModelStore                                    |
| `nix/module.nix:446`、`DEPLOY.md`                      | `models.json` 可能來自唯讀 Nix store，Web 不能直接覆寫                                      |

### 帳號範圍：已定為單人部署全域設定

現有 session owner 欄位與驗證可保留，但本功能不新增每使用者的 credentials namespace 或 RBAC。Web 登入設定屬於唯一操作者，供其所有 nodes／sessions 使用。

全域設定不代表要繼續廣播秘密：採用 gateway 集中推理後，向 node 提供不含 provider credentials 的模型目錄；登入、刷新與使用憑證都留在 gateway。既有金鑰廣播路徑須在遷移完成後移除，不另做短效 token 分發系統。

### 儲存與部署安全

- UI 設定／OAuth state 使用 gateway 可寫 storage，與檔案管理的 `models.json` 分開；有明確 precedence、來源標示及不可覆写的基線項目。
- credentials 採 atomic write／交易、目錄 0700／檔案 0600，且不進 Nix store、session archive、瀏覽器或前端 cache。若加密落盤，需另定密鑰管理；檔案權限不等於加密。
- UI 只需登入、API key 與 endpoint 等明確欄位；不直接開放 source schema 的 `apiKeyCommand`、`apiKeyFile`、`apiKeyEnv`。單人使用不需要為模型設定額外增加遠端命令／讀檔介面，既有部署端設定可繼續支援。
- Nix gateway 與 local-node 目前共用 service user、EnvironmentFile 與可寫 state 路徑（`nix/module.nix:143,456,475`）；agent 工具又非 sandbox。即使 token 只寫 gateway 檔案，**也不能宣稱已對同帳號的本機 agent 隔離**。若未來要求真正秘密邊界，需要不同 OS user／目錄權限與環境拆分；目前不以此作為上線前提，但應避免無必要地將 gateway provider secrets 注入 node 環境。

## 6. 建議的 Web 授權協定

以下是設計草案，尚無產品程式碼：

- `GET /api/providers`：registry + redacted 設定／登入狀態／來源／scope。
- `POST /api/provider-auth/sessions`：provider ID、必要同意資訊；owner 從可信 identity 推導，不能由 body 指定。
- `GET /api/provider-auth/sessions/:id`：有界狀態快照，包括授權連結、待回答 prompt ID／kind、進度。
- `POST /api/provider-auth/sessions/:id/input`：一次性 prompt 回覆；嚴格檢查目前 prompt 與 owner。
- `DELETE /api/provider-auth/sessions/:id`：取消本次登入。
- 另設已儲存帳號的登出／移除 API；「取消登入」不等於「移除既有帳號」。

帳號設定是部署全域；下面 auth session 的 owner 只是沿用既有 identity 檢查，不代表新增多租戶帳號模型。

使用 polling 或獨立事件串流皆可，第一版不需要塞進一般 agent session events。每個 auth session 有隨機 ID、TTL、generation、數量上限；查詢、輸入、取消都檢查 owner。`onAuth` 與 manual prompt 可以同時存在，不能用只能表示單一畫面的狀態機丟失資訊。

取消先使 session／generation 失效，再 reject callbacks／abort／必要時終止 worker；登入完成後落盤前再次檢查 generation。未完成 session 只存記憶體，gateway 重啟則清楚要求重試。

OAuth worker 是生命週期與故障隔離手段，**不是權限 sandbox**。固定 port login 需跨 session 互斥。上游部分 HTTP 操作未接收 signal；完整 timeout 必須由宿主保證。

所有登入／設定 response 用 `Cache-Control: no-store`；外部 URL 檢查協定、用 `noopener noreferrer`，instructions 以純文字呈現。上游錯誤可能包含 response body／token 欄位，不可原樣寫入 pirc log、UI 或普通 session events。只保存經過遮罩的錯誤碼與訊息。

## 7. 憑證刷新與模型請求：已選 B，gateway 集中推理

### A. Agent 直接呼叫 provider，gateway 提供短效憑證（未採用，保留比較）

沿用目前 node outbound inference；Pi adapter 在 agent 執行。gateway 集中 single-flight refresh、atomic persistence，agent 每次請求取最新 credential lease／模型 metadata。

- 較接近現有架構，gateway 不需要承載全部模型串流。
- 不能沿用全域廣播：只發給獲授權 session／node，refresh token 不下放。
- 需要 agent→node→gateway 請求／回覆通道，或完整 live credential-update 協定。
- root、team、一次性 subagent、memory、title、compaction 都必須使用共同的 request-time resolver；只更新 `Agent.stream()` 不夠。
- logout 可阻止新 lease／新請求，但已送給 node 的 bearer token 在上游失效前可能仍可用，不能承諾立即撤銷。

### B. Gateway 執行 Pi 模型串流，node 保留 agent loop（已採用）

node 送標準化的 model request，gateway 取憑證、呼叫 Pi，再傳回標準化 events。這是模型傳輸代理，不是把 agent／工具移到 gateway。

- refresh token 與 access token 都不必傳給遠端 node，帳號授權較集中。
- 現有 `protocol.ts` 沒有 agent-origin model streaming；需新增 request／chunk／end／error／cancel、多工、背壓、大小限制、timeout、disconnect cleanup 與權限檢查。
- prompt、圖片、工具 schema 會額外經 gateway；gateway 成為推理流量與可用性依賴。
- 不能把它描述成「加一條 OpenAI-compatible proxy」：Copilot 多 API、Codex 與 Anthropic OAuth 行為都需保留。

**使用者已選定 B。** 集中憑證與模型呼叫是管理與生命週期上的簡化，不是為了隔離不受信任租戶。合法 node 視為可信，不新增每租戶 scope／quota；仍需 node 身分驗證、request／session 關聯、併發上限、背壓與 timeout，避免錯誤路由及意外耗盡資源。

目標路徑為 `agent StreamFn → node → gateway Pi adapter → provider`，串流與取消沿原路返回。一般對話、team／subagent、memory、title、compaction 都使用同一模型請求通道；gateway 每次呼叫解析最新憑證，agent 不再因 token expiry 需要憑證更新 RPC 或重啟。

此目標也涵蓋既有 API-key／自訂 endpoint 的模型呼叫；可分階段搬遷 adapter，但不新增長期的 OAuth proxy／API-key direct 雙軌設計。gateway 需能連到使用者設定的 endpoint；若既有本地模型只聽 node 的 localhost，需調整可達性／安全 tunnel，不能把 gateway localhost 當成 node localhost。具體傳輸採現有 node WebSocket 多工或獨立 authenticated streaming endpoint，留待實作規格選定。

Gateway 暫時離線時，新模型請求會無法執行；既有工具／session runtime 仍在 node，但不保證能完成需要下一輪模型回覆的工作。斷線不得自動降級為把憑證送給 node。

refresh/login/logout 應以 credential ID 序列化，帶 revision 檢查，避免刷新結果復活已登出的帳號。provider 的到期值有些已扣五分鐘（Anthropic／Copilot）、Codex 沒有；宿主需要一致且不重複扣減的刷新策略。401 後也不能無條件重播已經開始輸出的請求。

## 8. Pi 模型 adapter 必要工作

介接邊界仍是 `apps/gateway/src/agent/providers/types.ts` 的 `StreamFn`，不必替換整個 agent runtime。但需修正先前「訊息 schema 完全不變」的假設：

1. 模型需保留 **per-model API**、canonical Pi provider、base URL、capabilities／thinking mapping；UI backend alias 與 Pi provider identity 分離。Pi 的 replay 邏輯會比較 provider／api／model identity。
2. 新增相容的 optional replay metadata：例如 `textSignature`（Responses message ID／phase）、`responseId`；現有 `signature` 明確映射至 Pi 的 `thinkingSignature`，並保留 opaque tool signatures。不可只留下可見文字，否則重啟後 replay 丟失資訊。[S12]
3. 轉換 pirc 的 `custom`／`compactionSummary`、圖片與 tool result；保留舊 session 可讀。
4. Pi `toolcall_start` 只有 index／partial，需從 partial 補出 pirc 要的 ID／toolName；Agent 繼續擁有外層 message lifecycle，避免重複事件。
5. 保留 usage 的非重疊 token buckets；影響 compaction，不只是 UI 統計。Pi cost 不應當成訂閱帳號的實際帳單。
6. `streamSimple` 適合統一 thinking，但 tool choice 等 provider-specific options 要檢查實際轉送。compaction 目前會帶 tools 並要求 `toolChoice: none`，不能默默忽略。
7. 舊 `openai-chat` 與 Pi `openai-completions` 需相容映射；既有自訂 endpoint、免 key 後端、headers／compat 不應強制一次遷移。
8. Pi 模型 adapter 在 gateway 執行；agent 端 `StreamFn` 成為遠端請求 adapter。不讀 node 環境 key；gateway 的環境 key 也只能經明確設定解析，不能因 UI 帳號登出就默默改用另一份環境憑證。
9. Codex 預設 `auto` transport，可能使用 cached WebSocket。初版可明確採 SSE 降低重播／連線生命週期風險，之後再開 WebSocket 與 session resource cleanup；這不減少登入 provider 覆蓋。
10. 0.73.1 Codex SSE 有硬編碼 `MAX_RETRIES = 3`；不是傳 `maxRetries: 0` 就能停用。要避免與 pirc retry 疊加，並保留已輸出文字後不盲目重播的規則。[S11]

現有 OpenAI prompt-cache warming 以 `api === 'openai-chat'` 判斷；不要直接套用到所有訂閱後端。對 cache、reasoning、tool-choice 應作 capability-based 判斷。

## 9. 工作分解與驗收

所有三個 provider 屬於同一交付範圍；以下是基礎建設順序，不是先只交付 Codex：

1. 依已確認的單人全域設定／gateway 集中推理決策，固定版本並定義 public backend metadata、secret storage 與模型串流協定；不再等待多使用者 scope 決策。
2. 建置完整 registry-driven auth bridge、所有 callbacks、worker cancellation、持久化與 refresh single-flight；用 mock 覆蓋三家。
3. 完成設定頁、登入狀態、manual URL／device flow、取消／登出、檔案基線與 UI overlay；涵蓋 Copilot policy consent。
4. 完成 Pi 傳輸 adapter／請求通道、per-model API、replay metadata，以及所有背景模型呼叫路徑的 refresh。
5. 本地及遠端部署測試，確認 Bun 單一 binary、Nix dependency hash／build；再以人類帳號進行明確授權的真實 smoke test。

最低驗收：

- UI 清單與固定版本的 `getOAuthProviders()` 一致，registry 新增項目使相容性測試提醒，不悄悄忽略。
- 三家都可從 Web 發起／完成登入並實際多輪對話、tool call；遠端環境不要求 CLI 或公開 callback port。
- 錯誤 state、wrong-owner、重複 prompt、cancel／TTL／重啟／port conflict 可控；晚到結果不能落盤。
- 並行刷新只執行一次，輪替結果持久化；登出不被舊 refresh 覆蓋。
- 活躍 root／team／subagent／memory／title／compaction 都能跨 token expiry 運作。
- 登出後模型清單可變空，UI 不保留失效選項；登入完成不誤稱已取得所有模型權限。
- tokens 不進前端回應、普通事件／log／session 檔案，也不透過模型設定或推理協定分發給 node；Enterprise／自訂 endpoint 只由操作者明確設定，保留 URL／跨 origin 憑證保護，不要求多使用者角色系統。
- API-key 與 OAuth 請求都走 gateway；node 只收到不含秘密的 metadata／結果。測試 gateway 斷線、串流取消、多工關聯、背壓，以及 node-local endpoint 可達性錯誤，不以秘密下放作 fallback。
- Responses signature／phase／thinking 在持久化、重啟、跨模型 replay 後保留正確行為。

相關既有測試：`models.integration.test.ts`、`nodes.integration.test.ts`、`remote.integration.test.ts`、`agent-core.test.ts`、`agent-compaction.test.ts`、memory／title／team／subagent tests、`events-reducer.test.ts`；Web 用既有 Vitest＋jsdom。實作後跑 narrow tests，再跑 repo 的 `bun run check`；Nix 另驗證。

## 10. 本輪實際驗證與限制

已完成：

- 查詢 npm metadata、Git tag commit，下載固定原始碼與 npm tarball，逐一閱讀三家 OAuth 與相關模型傳輸原始碼。
- 用 Bun 載入 **npm 發布包**的 OAuth registry／model catalog，驗證三個 provider 及模型 API family。
- 以完全攔截的 `fetch`、假 credentials 測試三家的到期刷新、未到期重用、Codex accountId、Copilot `modifyModels`：通過，共三個 mock requests。
- 把上述小型 probe `bun build --compile`，執行編譯產物：通過。
- probe／下載物僅在 git-ignored `node_modules/.cache/pirc-pi-research*`；未新增產品 dependency、未改 lockfile、未修改產品程式碼。

未驗證：

- 真實登入、subscription 權限、provider policy enable、實際模型推理及服務條款。
- 完整 login callback server／瀏覽器 E2E、所有 SDK 的單一 binary bundling、完整 pirc 或 Nix build。**OAuth registry／refresh probe 可編譯，不等於整套模型後端已可編譯。**
- 本輪未執行產品測試 suite，因為只有研究文件變更；文件需通過 repository formatter。

## 來源

所有 GitHub 程式碼連結固定到此次查核 commit，避免 main 分支改動使結論漂移。

- [S1 — npm latest metadata](https://registry.npmjs.org/@mariozechner%2fpi-ai/latest)；[0.73.1 發布 tarball](https://registry.npmjs.org/@mariozechner/pi-ai/-/pi-ai-0.73.1.tgz)。
- [S2 — tag ref](https://api.github.com/repos/earendil-works/pi/git/ref/tags/v0.73.1)。
- [S3 — OAuth registry／getOAuthApiKey](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/ai/src/utils/oauth/index.ts)。
- [S4 — changelog：0.71.0 移除 Google 登入](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/ai/CHANGELOG.md#0710---2026-04-30)。
- [S5 — OAuth interfaces](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/ai/src/utils/oauth/types.ts)。
- [S6 — Anthropic OAuth](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/ai/src/utils/oauth/anthropic.ts)。
- [S7 — Codex OAuth](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/ai/src/utils/oauth/openai-codex.ts)。
- [S8 — Copilot OAuth、endpoint 與模型 policy enable](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/ai/src/utils/oauth/github-copilot.ts)。
- [S9 — models registry](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/ai/src/models.ts)。
- [S10 — coding-agent AuthStorage：locking／persistence 範例](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/auth-storage.ts)。
- [S11 — Anthropic transport](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/ai/src/providers/anthropic.ts)；[Codex transport／retry](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/ai/src/providers/openai-codex-responses.ts)。
- [S12 — message／stream／model types](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/ai/src/types.ts)；[Responses replay](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/ai/src/providers/openai-responses-shared.ts)。
- [S13 — pi-ai README：browser limitations／OAuth](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/ai/README.md)。
