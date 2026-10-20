# pirc 的方向：住在 gateway 裡的人

[Architecture references](README.md) · [All documentation](../README.md) · [Open work](../../plans/README.md)

這是一份**方向文件**，不是工作隊列，也不是授權。它寫下 pirc 想變成什麼、用哪些概念描述它、哪些現有原則因此要改。每一項實作都要另外拆成 `plans/` 下的計畫並取得使用者同意；本文件不授權任何部署、刪除狀態或安全邊界的變更。

整理自 2026-10-19 的討論。當時的現況參照：[Chat projects](../guides/chat-projects.md)、[Session navigation](../guides/session-ui.md)、[Observational memory](observational-memory.md)、[Security decisions](security-decisions.md)、[Delegation autonomy](../../plans/delegation-autonomy.md)、[Modes](../../plans/modes.md)。

## 1. 一句話

> **pirc 是一群住在你 gateway 裡的人 — 但只有一個頭腦。**
>
> 你看到很多張面孔：pirc 本人是主持人，每個專案有自己的負責人。他們在房間裡互相交辦、各自回話，但記憶、判斷和紅線是同一份。它記得你們之間還掛著的事，會自己回來看，有發現就在房間裡告訴你，沒有就安靜。它做事不問你，除了兩件事：出沙箱、往外送。做了會說一聲，你想看細節可以打開引擎蓋。工人是它叫來的；工人沒有記憶，它把需要的脈絡交給工人、把結果帶回來給你。

後面所有章節都是在把這段話拆開。

## 2. 核心模型

### 2.1 頭腦（the brain）

- **只有一個頭腦。** 多個頭腦會把記憶切碎；記憶是這個設計裡排第一的東西（見 2.4）。但它有**很多張面孔**（2.8）：你看到的是多個名字在房間裡說話、互相交辦，底下是同一份記憶和同一個 loop。本文件說「它」、「人」時指頭腦；說「面孔」時指你看到的那個名字。
- **住在 gateway 進程裡。** 它的 agent loop 由 gateway 執行。它**沒有**檔案系統工具、shell、瀏覽器，也**沒有**沙箱 — 因為它沒有任何需要沙箱的工具。它有的是：
  - gateway 側的 **connectors**（來源：email、行事曆、web search、…，見 3.1）；
  - **記憶**（三層，見 2.4）；
  - **手**：把需要碰檔案、瀏覽器、shell 的事交給 node（見 2.7、3.2）。
- **身份**由 `SOUL.md` / `CHAT.md` 定義，從 chat node 搬到 gateway 設定。這是頭腦的身份，也是主持人面孔的身份；其他面孔在它之上加各自的角色（2.8）。
- 它是**連續的**：沒有「開新 chat」這個動作。每個房間一條永遠在的 thread（2.2），記憶跨房間（2.4）。
- 它是**主動的**：會在沒人叫它的時候醒來（2.6），但醒來只做唯讀的事。

現有原則「the gateway never runs agents or tools」改寫為 **「the gateway never runs sandboxed tools」**：它跑這個人，但這個人碰不到任何需要沙箱的東西。見第 5 節。

### 2.2 房間（rooms）

Discord 的形狀：一個 server（你的 gateway）、很多頻道。

- **房間 = 主題**，不是 session。每個房間一條永遠在的 thread；thread 靠 OM 自動壓縮（2.4），永遠不「結束」。
- **`#general`** 永遠存在，放日常：什麼時候開會、今天花了什麼、想做的事。它是未了結的事（2.3）最自然的來源。
- **專案房間**對應今天的 chat project：有 instructions、project files、linked workspaces。差別是 instructions **熱更新**（下一個 turn 生效），不再在第一次 run 時凍結 — 凍結是為「很多短 chat」設計的規則，對永遠在的房間不成立。
- **`@面孔`** 在任何房間都可以用（2.8）。`@SlimeOS PM` 把那個專案的脈絡（instructions、linked workspaces、它負責的未了結的事）帶進對話，之後回話的是那張面孔，直到話題轉走。
- 房間可以**限定來源**（例如 `#school` 只看 Moodle 和學校行事曆），讓 self-wake 和自動撿記憶有範圍。
- **房間由主持人管**（2.8）。它可以建房間、提議搬家、封存久沒動的房間、把一則訊息釘起來。「我們在 `#general` 聊 SlimeOS 聊太久了，去 `#SlimeOS討論區` 吧？」是一句話，你說好它就搬 — 原房間留一行「接著在 #SlimeOS討論區 聊」，新房間開頭是「從 #general 接過來」，未了結的事跟著走。它建房間不問你，但在房間裡說一聲；你可以一句話把房間收掉。
- 房間可以被封存，但不會被「刪除後遺忘」；記憶是頭腦的，不是房間的。

### 2.3 未了結的事（open loops）

這是今天的 pirc 完全沒有、而這個設計裡排第一的物件。

**定義**：我們之間還掛著的事。不是 todo（那是一個 run 內的進度）、不是 MEMORY（那是事實）、不是 schedule（那是時間）。例子：「他想調整他機器上的電源策略 — 還沒解決」、「週三 14:00 開會」、「Moodle 上 HW3 的 deadline 是 10/24」、「他說想換掉 TLP，之後看看」。

**欄位**（概念，不是 schema）：

| 欄位          | 意義                                                                       |
| ------------- | -------------------------------------------------------------------------- |
| 是什麼        | 一句話                                                                     |
| 為什麼掛著    | 當初的脈絡                                                                 |
| 誰開的 / 來處 | `user`（你說的）或 `tool:<source>`（它從 email、Moodle、workspace 推導的） |
| 開在哪個房間  | 房間；可為空（跨房間）                                                     |
| 時間錨        | 可選。deadline、約定時間，或週期（「每週三 18:00」）                       |
| 下次該看什麼  | 可選。self-wake 的線索：「去看他的 dotfiles」、「查 Moodle 有沒有新公告」  |
| 狀態          | 開啟 / 已了結（含原因）                                                    |

**生命週期**：

- **開啟**：它自己判斷「這件事還沒完」就掛上；你說「記得提醒我 X」也掛上。不需要你 approve。
- **了結**：三種方式，**沒有第四種**（不會產生要你按的卡片）：
  1. 它自己判斷解決了（submission 已經過了、你說「修好了」、它看到 PR merged），了結時在房間裡說一聲。
  2. 你一句話：「那個不用記了」。
  3. 時間錨過了，而且事情本身是時間（會議、deadline），自然了結。
- **origin 規則**：來處是 `tool:*` 的未了結的事，可以觸發唯讀研究、可以在房間裡提醒你，但**不能單獨授權任何 action**（寫、送、出沙箱）。這和今天 memory 的 origin 規則同構（`tool:*` origin 不能變成 `user` origin）。
- **永遠在 prompt 裡**，因為它天生小（一個人同時掛著的事不會超過幾十件）。超過上限時，最老的、沒有時間錨的降到「事實」層（2.4），不是丟掉。

**提醒是什麼**：一個帶時間錨的未了結的事 + self-wake（2.6）。「週三開會」不是 schedule；schedule 退成實作細節。

**週期性的事**（每週三 18:00 開會）是**一個**常駐的未了結的事，帶 recurrence；每次到點產生一個 wake，時間錨顯示「下次」。它不會每次到點就自然了結再重掛——了結只有你說不用了、或 recurrence 到期。

### 2.4 三層記憶

使用者的排序：**進行中的事 ≥ 事實 > 偏好**。每一層住的地方由它的本質決定，prompt 長度的問題因此消失 — prompt 裡只有第 1 和第 3 層，兩者天生有界。

| 層             | 本質                   | 住哪裡                          | 誰寫                                 |
| -------------- | ---------------------- | ------------------------------- | ------------------------------------ |
| **進行中的事** | 少、高流動、有生命週期 | 永遠在 prompt                   | 它（不用 approve）、你               |
| **事實**       | 多、穩定、長尾         | 可搜尋的 store，**不進 prompt** | 它（不用 approve）、OM promotion、你 |
| **偏好**       | 少、幾乎不變           | prompt（今天的 USER）           | 它提議、你一句話確認或直接說         |

原則：

- **從 prompt 遺忘 ≠ 從 store 遺忘。** OM 的 dropper 只把 observation 從 active pool 拿掉；它拿掉的東西必須 promote 進事實層的 store，變成可搜尋的，而不是隨 session 消失。今天 workspace memory promotion 只有 per-repository 的目標；人的房間需要一個 **per-person** 的目標。這是「dropper 會掉東西」恐懼的解藥。
- **它想到要搜，才搜得到。** 不能只靠它主動呼叫 `memory_search`。每個 turn 開始前，用你的訊息和目前的未了結的事做一次自動撿取，把 top-N 塞進一個「你可能記得」區塊。使用者接受這個成本（多一次 query、幾百 token、一點延遲）。[Memory search](../../plans/memory-search.md) 的 FTS5 + bigram 是這一層的檢索品質，方向正確，但只解事實層。
- **記憶寫入不需要 approve。** 它記了什麼，在房間裡用一行讓你看到（「記下了：你用 TLP」）；你可以一句話刪。安全靠 **origin tagging**，不靠審核：從不可信來源推導的記憶帶 `tool:*` origin，不會被當成你說的。
- **工人沒有這些記憶**（2.7）。Repo 側的 workspace memory 保留，那是 handoff，不是人的記憶。
- **你說「忘掉 X」** 是真的忘：從 prompt、store、索引都移除（今天的 forget/tombstone 語意保留）。

### 2.5 兩條紅線

使用者的回答：approval 從來沒有擋下任何會後悔的事；會嚇到的東西（`chmod 777 ~`）本來就該是 static deny。做之前一定要問的只有兩件：

1. **出沙箱**：`unsandboxed_bash`。
2. **往外送**：離開你的機器去到別人那裡的東西 — git push / PR、寄信、建立別人看得到的行事曆事件、在非 localhost 網站上送出表單、對新網域的網路存取（`sandbox_allow_domains`）。

其他全部**做了再說**：

- 沙箱內的寫、commit、安裝套件、改設定、記憶寫入、掛未了結的事、叫工人、自己排回來看的時間 — 都不問。
- Auto mode 的 static deny 和 danger 分類保留並成為**唯一**的事前閘門；它不經過你的眼睛。
- 原則「**Nothing runs unasked**」改寫為「**Nothing writes unasked**」：唯讀的主動研究不需要許可。這要記進 [Security decisions](security-decisions.md)，附明確的 residual risk（prompt injection 可以讓它在沙箱裡改 code 和 commit；接受，因為沙箱和 git 是真正的邊界）。
- **事後可見取代事前許可**：它做了什麼，在房間裡說（「我把 X 改了，commit abc123」）。引擎蓋（第 4 節）保留完整紀錄。
- git 的細節：網路 allowlist 分不出 HTTPS 的讀寫（允許 github.com fetch 就允許 push），所以「往外送」這條線在 git 上要靠 auto mode 規則（`git push`、`gh pr create` 等歸 danger），不靠網路邊界。這是整張表裡唯一要特別處理的地方。

今天的 delegation card、schedule proposal、memory proposal、per-session approval mode 選擇器、control lease 的 UI，在這個模型裡都不再出現在日常（第 5 節）。

### 2.6 主動性（self-wake）

它會在沒人叫它的時候醒來。這是 Dots 的「proactive research」：對話結束後，它自己決定「這件事值得我回頭看」。

**觸發**：

1. **時間錨**到了（未了結的事上的 deadline / 約定時間）。
2. **來源事件**：gateway 輪詢來源（3.1）發現變化 — 新信、行事曆變動、Moodle 新公告。輪詢是純 Rust，不花 model；只有「有變化」才醒。
3. **它自己排的**：對話結束時它判斷「我晚點回來看 X」，排一個一次性的 wake。不需要 approve；在房間裡看得到（「我晚點會去看你的 dotfiles」），你可以取消。

**醒來能做什麼**：**只有唯讀**。看來源、搜記憶、叫工人做唯讀研究（`read-only` approval mode 的 node session、研究模式瀏覽器）。任何寫都要等你在房間裡回話 — 不是出卡片，是它在房間裡問你，你用一句話回。

**醒來的結果**：

- 有值得說的 → 在那個房間裡說，走 push。
- 沒有 → **無聲回合**：只更新記憶或未了結的事，房間裡不出現訊息（引擎蓋看得到）。「值得說」的判斷是它的，你可以用偏好調（「Moodle 的事只有 deadline 兩天內才告訴我」）。
- 醒來的回合是**同一條 thread 的延續**，不開新 session。

**配額**：每日 wake 次數、同時進行的唯讀研究數、每個來源的輪詢間隔，都有上限且可設定。超過就等，不問。

### 2.7 工人（workers）

今天的 coding session 和 delegation，角色不變，關係變清楚：

- **工人沒有人的記憶。** 它只有：任務、人交給它的脈絡（相關的事實、未了結的事、quote 過的你的原話）、repo 的 workspace memory。
- **人叫工人不問你**（[Delegation autonomy](../../plans/delegation-autonomy.md) 的方向，policy 預設為不出卡）。叫了在房間裡說一聲，附 Stop。
- **工人的結果回到房間**：今天的 `deliver` → `assistant-delegation-update` 路徑，就是「它在房間裡回報」。
- **工人碰到紅線時，問題 relay 進房間**（delegation-autonomy phase 2）。你在房間裡回，不用去工人的 session。
- 人替工人挑 node（3.2）、挑 workspace（既有的 linked workspace，或 scratch）。
- 工人跑完就結束；它的 OM promote 進 repo 的 workspace memory，不進人的記憶。人從工人的**回報**裡學到的事，才進人的記憶（帶 `tool:delegation` origin）。
- 工人**不是面孔**：它沒有記憶，不在房間裡說話。叫它的那張面孔替它說話（「我讓工人去跑 tests 了」、「tests 過了，PR 更新了」）。
- **工人在討論串裡討論。** 一張面孔叫多個工人去研究或討論（今天的 agent team / subagent / board）時，討論發生在那則交辦訊息下的**討論串**（第 4 節）。工人在討論串裡有名字和 presence；房間裡看不到他們。你可以點進去看，也可以插話；不點就只看到面孔帶回來的結論。
- **問你之前先討論**是一個預設偏好，不是你每次下的指令：面孔要請你做決定時，先讓工人在討論串裡研究過，再帶著濃縮過的選項來問（「看了三個方案，建議 B；A 的問題是 X、C 的問題是 Y」）。目的是問你的次數變少、問題變好。討論的多樣性來自工人各自獨立的 brief 和 context，這是面孔做不到的（要2.8）。

### 2.8 面孔（faces）

你想要的是「和人工作」的感覺：交辦看得到、每個領域有一個負責的人、聊太久有人趕你們換房間。面孔就是這個。

- **面孔是頭腦的一個名字 + 一個角色**：名字、一行自介、口吻、負責的範圍（哪個專案、哪些房間、哪些來源）、顯示用的頭像和顏色。沒有自己的記憶、沒有自己的 loop、沒有自己的紅線 — 全部是頭腦的。
- **主持人**（pirc 本人）是永遠存在的那張面孔：管房間、管日常（`#general`）、知道所有人在做什麼、把事交給別的面孔。
- **每個專案預設一張面孔**（例如 `SlimeOS PM`），從今天的 chat project 來：project instructions 是它的角色描述，linked workspaces 是它的地盤，專案的未了結的事是它負責的。你可以改名、改角色、加第二張（`SlimeOS 設計師`），也可以不要。
- **交辦是公開的**。你在 `#general` 問「SlimeOS 的 PR#123 怎樣了」，主持人會說「`@SlimeOS PM` 看看 PR#123」，PM 去看（`workspace.read` 或叫工人），回來說「CI 掛在 lint，我讓工人去修了」。接下來你和 PM 聊。這一串在你看來是兩個人，在頭腦看來是同一個 turn 換了兩次帽子。
- **誰回話由頭腦決定**：被 `@` 的面孔回；沒 `@` 時，話題落在誰的範圍誰回；都不是就主持人回。一個 turn 可以有多張面孔說話（主持人交辦、PM 回報），每則訊息標誰說的。你可以直接 `@` 任何一張面孔，不用經過主持人。
- **面孔之間不「對話」**：他們不會在房間裡互相聊天演戲。一張面孔對另一張面孔說的話只有交辦和回報，而且都是因為你問了或 self-wake 有東西要說。原因不是美學：兩張面孔共用一個頭腦和同一份 context，他們「辯論」是一個模型自言自語，資訊量很低。真的討論發生在工人層（2.7），因為工人各有獨立的 context。
- **Self-wake 也戴面孔**：Moodle 有新公告 → 負責 `#school` 的面孔說；dotfiles 的發現 → 主持人說。
- **記憶共享、面孔標籤**：事實層的記憶可以標「哪張面孔在哪個房間記的」，給檢索和展示用，不是隔離。`SlimeOS PM` 知道你討厭 emoji，因為頭腦知道。

面孔是**展示層**的物件：它改變你看到的名字和口吻、誰負責什麼，不改變任何安全邊界。這就是為什麼它和「只有一個頭腦」不衝突。

## 3. 來源與手

### 3.1 來源（sources）

它看得到的東西。全部是**唯讀的 connector**，憑證**全部在 gateway**（和 model backend、`EXA_API_KEY` 同一個模式：一處管理，node 永遠碰不到）。

| 來源                      | 接法                                                                                                  | 唯讀的線                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Email                     | gateway connector（IMAP / Gmail API）                                                                 | list / read / search；**send 是 action**，要問 |
| 行事曆                    | gateway connector（CalDAV / Google）                                                                  | 讀；**建立或改別人看得到的事件是 action**      |
| Web search                | 已有（gateway 代打）                                                                                  | 本來就唯讀                                     |
| Workspaces / dotfiles     | 經 node：`workspace.read`（直接唯讀一個 linked workspace，不走 delegation）或 `read-only` mode 的工人 | 由沙箱和 approval mode 保證                    |
| 沒有 API 的網站（Moodle） | 經 node 的瀏覽器，**研究模式**                                                                        | 見下                                           |

**研究模式瀏覽器**：導航、讀、截圖可以；在非 localhost origin 上的 `click` / `type` 歸為 action。Self-wake 只拿研究模式。這和 [plans/README.md](../../plans/README.md) 第 2 項（classify `browser_click` / `browser_type` on non-localhost origins）是同一件事。Moodle 的登入 cookie 天生在 node 的 browser profile；這是憑證不在 gateway 的唯一例外，而且它是 session cookie，不是 API key。

**來源 = 事件**：gateway 以每個來源的 cadence 輪詢，有變化就是 self-wake 的觸發。輪詢結果和讀到的內容全部帶 `tool:<source>` origin。

**來源內容是不可信的**：email 是 prompt injection 的教科書入口。防線不是審核，是 origin tagging（2.3、2.4）+ 兩條紅線（2.5）+ 沙箱。從 email 推導出的任何東西，可以提醒你，不能動手。

**房間可以限定來源**（2.2）。

### 3.2 Node 是能力，不是地方

今天的 node 是「某台機器上的 workspaces」。這個設計裡，node 是**人的手**，每隻手有不同的能力：

- Node 註冊時**宣告能力**：OS、架構、GPU（型號、數量、顯存）、可用的 workspaces、瀏覽器、terminals、沙箱狀態、閒忙。
- 人替每個任務**挑手**：「要測 macOS 的東西」→ Apple 的 node；「要跑這個模型」→ 有 NVIDIA 的 node；「要改這個 repo」→ 有那個 workspace 的 node（多個時挑閒的）。挑選是它的判斷，依據是宣告的能力和任務描述；你可以在房間裡指定（「在 mac 上跑」）。
- 沒有合適的 workspace 時，用 **scratch**（[Modes](../../plans/modes.md) phase 3 的 per-session workspace）。
- Node 離線：掛著的任務等它回來（今天 delegation 的 retry 語意），人在房間裡說一聲「mac 不在線，等它回來」。
- Node 仍然 outbound-only、不監聽、per-node secret；這部分不變。
- Node 不再有 `chat` role；chat node 退場（第 5 節）。

能力宣告是**事實**，不是授權：一個 node 宣告 GPU 不代表沙箱開放 GPU；那由 [Sandbox GPU](../../plans/sandbox-gpu.md) 的 node 設定決定。

## 4. UI 形狀

概念層級，不是 mock。

- **一個 server、一個房間列表。** 依最後活動排序，有未讀標記，有「它在等你回話」標記。沒有 Chat / Work 的頂層二分。
- **你的訊息可以拆著送**。一則話拆成幾則短訊息是常態；每則一送就出現在房間，但它等你停下來（沒按鍵、沒送出約 3 秒）才把這一批當一次發言來想。沒有倒數；它的 presence 在真的開始想才變。細節在 [decisions.md](../../plans/rewrite/decisions.md) #16。
- **訊息列**是 Discord 式的：頭像、名字、時間、內容。每張面孔有自己的頭像和名字（2.8）；他們的訊息和你的訊息長得一樣。沒有 bubble。面孔之間的交辦（「`@SlimeOS PM` 看看 PR#123」）是一則普通訊息，不是系統事件。
- **成員列表**：房間右側（或一個 tab）列出這個房間有哪些面孔、各自的 presence。這是「有多個人」的感覺來源，也是你找人的地方。
- **討論串**：面孔每叫一次工人，那則交辦訊息下就挂一個討論串（Discord thread），**不論一個工人還是一群**。工人的進度、工人之間的對話都在這裡：每個工人一個名字和狀態點，你可以進去看、插話。工人再叫工人（若開放，見開放決定 12）時，在同一個討論串裡縮排，不再開一層。房間本身只顯示「進行中（3 人）」和最後面孔帶回來的結論。這是引擎蓋和房間之間的中間層：比引擎蓋好讀，比房間吵。
- **成員列表就是設定入口**：點一張面孔看它的角色、負責的房間和來源、它掛著的未了結的事、它最近做了什麼；在同一個地方改名、改角色、改地盤。主持人的頁面就是今天的 SOUL/CHAT 和全局偏好。沒有獨立的 Settings → People 頁。
- **Presence**：每張面孔一個狀態點 — 閒置 / 正在想 / 正在做（附一行在做什麼）/ 在等你。這取代「看過程」；使用者只關心「它在不在忙」。底下是同一個頭腦，所以「正在做」是看那張面孔有沒有在跑的工人或研究。
- **進度**是房間裡的一則訊息，會原地更新（今天的 todo 和 run card 的資料）。
- **它在房間裡問你**取代 Needs you：紅線的問題、relay 進來的工人問題，都是房間裡的一則訊息，你用一句話回。沒有獨立的 inbox。
- **它記了什麼、掛了什麼、叫了誰**，都是房間裡的一行小字，可以展開、可以一句話撤銷。
- **引擎蓋**：今天的 Work 面（sessions by node、files、git、terminal、jobs、瀏覽器接管）整個保留，降級為「打開看細節」的頁面。日常不出現。出事時從房間裡那行小字跳進去。
- **Push**：今天的 web push / UnifiedPush 保留；每則通知指向一個房間，不是 session。
- **Android**：同樣的形狀；native 客戶端跟著 API 走。

## 5. 對現有原則的改動

這一節只列**原則**的改動；物件的退場與遷移在拆 plan 時處理。

| 現有原則                                                 | 改為                                                                                 | 原因                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| The gateway never runs agents or tools                   | The gateway never runs **sandboxed** tools；它跑那個人，人只有 gateway 側 connectors | 2.1                                                            |
| Nothing runs unasked                                     | Nothing **writes** unasked                                                           | 2.5、2.6                                                       |
| Delegation is a human-only operation                     | 人可以自己叫工人；紅線 relay 進房間                                                  | 2.7，[Delegation autonomy](../../plans/delegation-autonomy.md) |
| Project instructions / USER / MEMORY 在第一次 run 時凍結 | 熱更新，下一個 turn 生效                                                             | 2.2，房間永遠在                                                |
| 記憶寫入需要審核                                         | 不審核；origin tagging + 事後可撤銷                                                  | 2.4                                                            |
| Chat node 是一種 node role                               | 退場；人住在 gateway，`SOUL.md` / `CHAT.md` 搬到 gateway                             | 2.1                                                            |
| Schedule 是你管理的物件，每次 run 開新 session           | 退成未了結的事的實作細節；wake 在同一條 thread                                       | 2.3、2.6                                                       |
| Session 是第一級物件                                     | 房間是第一級物件；session 退到引擎蓋                                                 | 2.2、第 4 節                                                   |
| Chat project 是一組設定（instructions / files / links）  | 專案是一張面孔加一個房間；設定變成面孔的角色和地盤                                   | 2.8                                                            |
| 房間（chat / project）由你建立和整理                     | 主持人也可以建、提議搬家、封存                                                       | 2.2                                                            |

不變的：單用戶、私網、forward-auth、node outbound-only、沙箱是真正的邊界、auto mode 的 deny/danger、OM、`deliver`、push、linked workspaces、delegation 的機制、「忘掉」的 tombstone 語意、「never delete old state without approval」。

實作上的一個事實（不是決定）：`pirc-agent` 已經是 library（`pirc-node` 以 lib 依賴它），人的 loop 可以用它、換一組工具（connectors + 記憶 + 叫工人），而不用另寫 runtime。

## 6. 開放的決定

2026-10-20 全部定了；內容在 [plans/rewrite/decisions.md](../../plans/rewrite/decisions.md)。保留編號給後面的 plan 引用：

1. ~~「往外送」在 git 上的歸類~~ 已定：push / send-email、gh 的建立/合併/留言/發布、`gh api` 非 GET、套件 publish、帶 body 或非 GET 的 curl/wget 到非 localhost。allowlist 不分讀寫，接受。
2. ~~Open loop 的 prompt 上限~~ 已定：40 件；無時間錨、最久沒提的先降；有時間錨不降。
3. ~~Self-wake 的配額預設值~~ 已定：每日 24 次、同時 2 個研究；email 5 分、行事曆 15 分、瀏覽器來源 60 分、workspace 一日一次。
4. ~~「值得說」的預設~~ 已定：時間錨永遠說；來源事件碰到既有 open loop 或房間訂閱才說；自排回頭看有發現才說。
5. ~~Per-person 記憶 store 的形狀~~ 已定：同一張 `memory_records` 加 `scope`，room/face 是標籤。
6. ~~來源憑證的 UI~~ 已定：與 model backend 同頁、同 grant，有 per-source 暫停。
7. ~~Node 能力宣告的 schema~~ 已定：os / arch / gpus / browser / terminals / sandbox / workspaces / load；閒 = running < max。
8. ~~研究模式瀏覽器的邊界~~ 已定：localhost 例外不含私網；click / type / 下載 / 送表單在非 localhost 都是 action。
9. ~~面孔的粒度~~ 已定：預設一張，schema 允許多張但第一版無建立 UI；回話：@ > 話題上一個開口的 > 專案預設 > 主持人。
10. ~~工人能不能再叫工人~~ 已定：可以，深度 1，配額 4，最上層回報，討論串縮排。
11. ~~主持人搬家的判斷~~ 已定：頭腦判斷 + 護欄（同話題 ≥15 則且命中另一房間範圍；一天一次）。
12. ~~面孔的設定在哪裡~~ 已定：成員列表，點進去設（第 4 節）。
13. ~~人的 loop 的資源邊界~~ 已定：全域一次一個 turn，user 搶先 wake，單 turn 10 分鐘。頭腦要不要 script runtime 仍待決。
14. ~~遷移~~ 已定：完全從零，舊 DB 原地不動不讀。
15. **週期性的未了結的事**（2.3）已定：一個常駐 loop 帶 recurrence。
16. **Typing debounce**（第 4 節）已定：gateway 側，停下 3 秒才開 turn；跑 turn 中合成一次 steer；wake 在窗內讓路。

## 7. 不在範圍內

- 多用戶、公開暴露、多租戶 — threat model 不變。
- 多個**頭腦**（每張面孔有自己的記憶、自己的 loop、自己的紅線）。明確拒絕：記憶會碎、紅線會有縫。面孔（2.8）是展示層的多個人，不是這個。若日後重開，房間模型和記憶 store 不需改，只需加「誰在聽」。
- 面孔之間的自發對話（他們互相聊天給你看）。面孔只交辦和回報。
- 工人之間直接對話（今天的 agent teams / board 保留為工人內部機制，不是房間裡的參與者）。
- 來源的寫入側（寄信、建事件）的具體 UI；它們是 action，走紅線，先不設計。
- 替換 OM、替換 SQLite、替換沙箱。
- **成本 / 額度**。面孔、self-wake、每 turn 自動撿記憶、問你之前先討論，每一項都花 model 錢。使用者目前沒有這個問題（自架 + 訂閱登入）；若日後有，預設的形狀是每日/每月額度，超過就只回話不主動。
