# Gateway and node: API and configuration reference

The native Rust servers live in `crates/`; this document is their client API and configuration reference. Two executables implement the gateway and node roles:

- **`pirc-gateway`** (`crates/pirc-gateway/`) is where pirc lives, and the only thing browsers and phones talk to. It runs the brain (one agent loop that answers in the rooms, with gateway-side tools only) and keeps the rooms and their threads, the faces, the brain's memory, open loops and wakes, and the sources it reads. It is also the engine: it indexes the workers' sessions and their control leases, buffers each session's events and routes every session request to the node that owns it. It never runs sandboxed tools, shells or workspace inspection itself, and never learns real workspace paths.
- **`pirc-node`** (`crates/pirc-node/`) is pirc's hands, one per machine that has workspaces. It declares what the machine can do and connects _out_ to the gateway over one WebSocket. It owns everything local: the `pirc-node agent` subprocesses that run workers (JSONL RPC on stdin/stdout), side-panel shells and Git/file inspection, uploads, and the session JSONL files and SQLite metadata. It does not listen on any port.

A single-machine setup runs the gateway and a coding node on the same host; the node then reaches the gateway at `ws://127.0.0.1:<port>`.

`crates/pirc-protocol/src/lib.rs` describes the gateway↔node link. Both sides announce `NODE_PROTOCOL_VERSION` (15); on a mismatch the gateway closes the link with code 4426, so upgrade the gateway and nodes together. The registration carries the node's workspaces, accepted modes and `capabilities` (`Capabilities` in `link.rs`: OS, architecture, GPUs, browser, terminals, sandbox and its GPU, `maxRunning`); the gateway keeps them with the connection and counts the node's running agents from its `activity` frames (`/api/nodes` lists `capabilities` and `load {running, max}`). The brain's `workspace_read` reaches a node through the ordinary relayed request, `POST /api/workspaces/:id/read` (`panels/read.rs`), which the gateway relays for no browser: list, read (64 KiB a time from an offset), grep, git log and status, confined to the workspace, never its `.git`. A delivery with `approvalMode: "read-only"` marks the node's session read-only for good (`sessions.read_only`): its sandbox then writes only its own state, temp dirs and caches (`SessionPolicyInput::read_only`), and the node refuses it more hosts and commands outside the sandbox.

An agent reaches the gateway only through its node (`gateway_request` on the agent's stdout, `agent_request` on the link). The node names the session, so an agent can only act as its own session, and the gateway runs only the allowlisted operations in `crates/pirc-gateway/src/agent_ops.rs`, for sessions of that node whose owner is still in `PIRC_ALLOWED_USERS`. Every request gets one answer: the gateway's, `gateway_offline`, or `gateway_timeout` after 30 s.

The Nix gateway package carries the Web UI; the node package carries native sandbox/CDP drivers, not the Web UI. No JS runtime or srt/Playwright package is shipped. The split does not provide privacy isolation between processes sharing an OS account. See [migration guidance](../deploy/upgrades.md).

## Security model

The gateway must listen only behind a trusted authenticated proxy. It accepts the configured identity header **only** when the TCP peer address exactly matches `PIRC_TRUSTED_PROXIES`, then checks that identity against `PIRC_ALLOWED_USERS`. Host and Origin comparisons are exact allowlist matches; mutating HTTP requests and every WebSocket upgrade with forward auth require an Origin.

Native clients (the Android app) authenticate with a **device token** instead of forward auth. See [Device tokens](#device-tokens).

Nodes authenticate to `/node/connect` with a per-node secret (`PIRC_NODE_TOKENS` on the gateway, `PIRC_NODE_TOKEN` on the node). That path must bypass the browser forward-auth, and the proxy must never hand node tokens to browsers. Each node checks the user of every relayed request against its own `PIRC_ALLOWED_USERS`, and sessions are visible only to the user who created them. Agents and side-panel shells that a node starts do not inherit `PIRC_NODE_TOKEN` (or any `PIRC_*SECRET*` variable). This keeps the token out of their output; it is not isolation, since they still run as the node's account, which can read the token file.

Model credentials (API keys, subscription OAuth tokens) stay on the gateway, which runs every model request. A node forwards its agents' requests over its link and receives only streamed results and a secret-free model catalog. Agents reach the node through a Unix socket in the node's state directory (mode 0600, random per-start token), not a TCP port. Backend settings and logins are in `$PIRC_STATE_DIR/backends/settings.json` (0600); this is file-permission protection for a single-user deployment, not isolation from processes running as the same account.

The workspace registry is an execution allowlist. Agents always run inside the native OS sandbox; a node unable to sandbox starts no agents (see "Agent sandbox" in the top-level README); side-panel shells, which you drive yourself, keep the Unix permissions of the node's account. Do not run a node as root or expose the gateway directly to an untrusted network.

## Setup

Development setup follows; production deployment (service managers, reverse proxy, NixOS, macOS nodes, upgrades, backups) is in [`docs/deploy/`](../deploy/README.md).

```sh
# From the repository root; inject environment from .env.example.
# Rust does not auto-load .env. Each role needs its own environment and fresh state.
bun install --frozen-lockfile
bun run build
bun run check
./target/release/pirc-gateway
./target/release/pirc-node      # separate coding-node environment/state
```

### Gateway

Set `PIRC_HOST`/`PIRC_PORT`, `PIRC_STATE_DIR`, the browser checks (`PIRC_TRUSTED_PROXIES`, `PIRC_IDENTITY_HEADER`, `PIRC_ALLOWED_USERS`, `PIRC_ALLOWED_ORIGINS`, `PIRC_ALLOWED_HOSTS`), and `PIRC_NODE_TOKENS`: a JSON object mapping each node ID to a **different random secret of at least 32 characters**. Model backends are configured here: in the web **Settings** (API-key/custom endpoints and subscription logins) and in `models.json` (`PIRC_MODELS_FILE`, default `$PIRC_CONFIG_DIR/models.json`); `SIGHUP` reloads the file. The gateway runs all inference, so endpoints must be reachable from it (see the root README's Agent section). Node settings such as `PIRC_WORKSPACES` or `PIRC_NODE_ID` are refused at startup. The brain's files (`SOUL.md`, `CHAT.md`, `brain.json`), its wake quota and the sources' credentials are in [gateway configuration](../deploy/gateway.md#the-brain).

### OpenCode Zen and Go

OpenCode serves each wire API under its own base URL. Pick the one for the API your model requires ([model list](https://opencode.ai/v2/docs/console/models/), [Go](https://opencode.ai/v2/docs/console/go/#where-can-i-use-it)):

| API                          | Zen (pay as you go)                       | Go (subscription)                            |
| ---------------------------- | ----------------------------------------- | -------------------------------------------- |
| Chat Completions / Responses | `https://opencode.ai/inference/openai/v1` | `https://opencode.ai/inference/go/openai/v1` |
| Anthropic Messages           | `https://opencode.ai/inference/anthropic` | `https://opencode.ai/inference/go/anthropic` |

The legacy `https://opencode.ai/zen/v1` and `https://opencode.ai/zen/go/v1` base URLs keep working. Requests to `opencode.ai/inference/...` or `opencode.ai/zen/...` automatically include a stable per-conversation `x-opencode-session` and `User-Agent: pirc/<product-version>` across all transports. For a custom proxy URL, enable **OpenCode compatibility** in the backend editor, or set `"opencodeGo": true` on the provider in `models.json` (the key keeps its original name and covers Zen too). Your proxy must preserve these headers. No manual session header or API key replacement is needed. **Fetch models from endpoint** reads the plan's shared list (`/inference/v1/models` or `/inference/go/v1/models`) for any of these base URLs.

### Device tokens

A browser with forward auth pairs a phone in **Settings → Devices → Phones**. The gateway generates `pirc_dev_` plus 32 random bytes in base64url, shows it once as a `pirc://pair?url=<origin>&token=<token>` QR code and link, and stores only its SHA-256 hash. The app sends `Authorization: Bearer pirc_dev_…`.

- The TCP peer must still be a trusted proxy, and `Host` must still be allowed. An `Origin` is optional for bearer requests because nothing is sent ambiently; if one is sent, it must be allowed.
- A device-shaped bearer header never falls back to forward auth. A request carrying both a device token and the identity header is refused, so a misrouted proxy fails closed. Other `Authorization` schemes are ignored and forward auth applies.
- The token owner must still be in `PIRC_ALLOWED_USERS`. Device tokens cannot reach `/api/devices*`, `/api/providers*`, or `/api/provider-auth/*`; otherwise they act as the user, including files and terminals on every node.
- A token dies after `PIRC_DEVICE_TOKEN_IDLE_DAYS` (default 7) without use, `PIRC_DEVICE_TOKEN_MAX_DAYS` (default 30) after pairing whatever its use, or on revocation. Its open WebSockets close with `4401` on revocation, and within a minute of expiry. At most 10 phones can be paired at once.

The proxy must route bearer requests to the gateway **without** forward auth and must strip the identity header from them, just like `/node/connect`. With Traefik, add a router above the forward-auth one:

```yaml
http:
  routers:
    pirc-device:
      rule: Host(`pirc.example`) && PathPrefix(`/api/`) && HeaderRegexp(`Authorization`, `^Bearer pirc_dev_`)
      priority: 100 # above the Authelia router for /api/
      service: pirc-api
      middlewares: [pirc-strip-identity]
  middlewares:
    pirc-strip-identity:
      headers:
        customRequestHeaders:
          X-Pirc-User: '' # your PIRC_IDENTITY_HEADER; an empty value removes it
```

On Traefik v2 the matcher is `HeadersRegexp`. The NixOS module does the equivalent for nginx with `services.pirc.nginx.deviceTokens = true`: its forward-auth subrequest returns success without an identity for device-token requests, so nginx drops the identity header and the gateway checks the token.

### Node

Set `PIRC_NODE_ID`, its matching `PIRC_NODE_TOKEN`, `PIRC_DAEMON_URL`, `PIRC_ALLOWED_USERS`, the machine's own `PIRC_STATE_DIR`, optionally `PIRC_WORKSPACES`, and the node-local agent config (`PIRC_CONFIG_DIR`, default `~/.config/.pirc`; limits, features, hooks, and the system prompt, but no providers).

A node gets the model catalog from the gateway when it registers and sends every model request back over the link, so its agents cannot call a model while it is disconnected (they report `Gateway inference is unavailable`). Provider keys never reach nodes; a leaked node token still allows using the gateway's models. The link must use `wss://` unless the gateway is on loopback; only local development should set `PIRC_ALLOW_INSECURE_NODE_TRANSPORT=true`.

Each node runs its own executable with the internal `agent` subcommand for each session; agents run each `ptc` script in an embedded QuickJS interpreter inside a `ptc-guest` child process of the same executable. OAuth flows run as cancellable tasks inside the gateway; there is no `oauth-worker` subcommand. To use a different agent executable, set `PIRC_AGENT_COMMAND` (and optionally `PIRC_AGENT_ARGS` as a JSON array). `PIRC_TERMINALS=false` disables side-panel shells; the shell comes from `PIRC_TERMINAL_SHELL` or `$SHELL`.

### Workspaces

`PIRC_WORKSPACES` is a JSON array of `{id, path, displayName?, defaults?}` and may be empty. From the web, `POST /api/workspaces` with `{ "nodeId": "m5pro", "path": "~/projects/example", "displayName": "Example" }` adds one to an online node. The directory must already exist inside that node account's home; its resolved real path must stay inside the home (symlink escapes, system paths, and directory creation are refused). The node persists the workspace and advertises it again after reconnecting. The gateway lists it as `<nodeId>:<workspaceId>` and assigns each new session permanently to its node.

### Node failure

A disconnected node makes its sessions answer `503` and stops new commands. A command whose acknowledgement was lost becomes `outcome_unknown` and **is never retried automatically**. Open terminal streams close with `1012`. On reconnect the event epoch increments, so clients fetch a new snapshot.

**Current limitations:** no cross-device session migration, and node secrets and state directories need an external secret manager and backup policy. If the gateway loses a session-create acknowledgement while the node persisted the session, that session is orphaned on the node; inspect the node's database before creating a replacement.

## API

Room, brain, face, source and worker routes are the gateway's own. The engine's session routes are answered by the node that owns the session; the gateway checks ownership and the control lease first.

### Rooms

Rooms (plans/rewrite/01-rooms.md) belong to the household: every allowed user reads and writes every room; reads, unread counts and "waiting for you" are per user. `#general` (id `general`) always exists and cannot be archived. Messages are numbered per room (`seq` from 1); `speaker` is `user` (with `user` naming who) or `face:<id>` (the [face](#faces) that spoke); `kind` is `text`, `line` (a small note such as a move), `progress` or `question`.

- `GET /api/rooms[?archived=1]` lists rooms by latest activity with `readSeq`, `unread` and `waiting`, plus the asking `user`. `POST /api/rooms` with `{name}` (1–80 characters, a leading `#` dropped) creates one. `GET /api/rooms/:id` returns a room (archived ones too) and its pinned messages. `PATCH /api/rooms/:id` takes any of `{name, archived, sourceScope}`; archiving hides a room from the list and deletes nothing, and an archived room takes no messages until it is unarchived (`409`).
- `POST /api/rooms/:id/move` with `{toRoomId}` continues the conversation elsewhere: a line "Continued in #to" in the old room, "Continued from #from" in the new one.
- `GET /api/rooms/:id/messages?before=<seq>&limit=<1-200>` pages backwards (oldest first in each page, `hasMore`). `POST /api/rooms/:id/messages` with `{text, attachments?, immediate?}` stores and broadcasts the message at once and adds it to the sender's pending input, which the brain takes as one turn after the typing debounce (plan 02); `immediate` (Cmd+Enter) skips the debounce. Your own message counts as read.
- `POST /api/rooms/:id/messages/:mid/pin` with `{pinned?}` (default `true`); `POST /api/rooms/:id/read` with `{seq}` (never moves back); `POST /api/rooms/:id/typing`, at most every 3 seconds while typing (a signal lasts 6 seconds and is never stored).
- `POST /api/rooms/:id/uploads?filename=` with raw bytes follows the session upload rules (images sniffed, other files need a name, `PIRC_UPLOAD_MAX_BYTES`) and stores the file on the gateway under `PIRC_UPLOADS_DIR`; an upload goes with one message (`attachments`). `GET /api/rooms/:id/uploads/:uploadId` serves it, images inline and other files as downloads.
- WebSocket `GET /api/events?rooms=1&cursor=<epoch>:<sequence>` follows every room in one sequence: `room_message`, `room_message_updated` (`{message}`), `room_changed` (`{room}`), `room_read` (`{user, readSeq}`, only to that user), `loop_changed` (`{loop}`), `wake_changed` (`{wake}`), `thread_message` and `thread_message_updated` (`{threadId, message}`), `face_changed` (`{face}`, carried by `#general`'s stream), `room_typing` (`{user, device, expiresAt}`), `brain_presence` (`{face, state: "thinking"|"idle"}`) and `face_presence` (`{faceId, state, roomId?, line?}`); the last three have sequence 0 and are never replayed. The socket starts with `{type: "ready", watermark, presence, faces}`, `presence` listing `{face, roomId, state: "thinking", since}` where a face thinks now and `faces` what each face is doing. The epoch is the gateway's start time, so a cursor from before a restart, or older than the bounded replay, is answered with a `reset`: reload what is shown. A socket follows either a session or the rooms, not both.

### Brain

The brain (plans/rewrite/02-brain-host.md) is one `pirc-agent` loop inside the gateway, on its own thread, that answers in the rooms as the host face (`face:host`). It runs one turn at a time for the whole household. A user's messages wait in the room's pending input until their batch is ready: "send now" at once, otherwise the debounce (`brain.json` `debounceSeconds`, default 3) after the last message, and not while that user is still typing. A ready batch starts a turn in its room when the brain is idle; messages that become ready in the same room while it answers are steered into that turn, and other rooms wait for it. The pending input is consumed only once the brain's conversation holds it, so a restart in between hands it over again.

A reply streams into one message per assistant reply (`body.streaming: true` until it ends; streaming does not set `editedAt`). A turn that fails leaves the line "The model is unavailable right now."; one that runs longer than `PIRC_BRAIN_TURN_TIMEOUT_MS` (default 10 minutes) is stopped with a line saying so. The brain's tools run on the gateway (plan 02: `web_search`, when `EXA_API_KEY` is set); it has no shell, files or browser. Each room's conversation is a `pirc-agent` session in `$PIRC_STATE_DIR/brain/rooms/<room>/` (kept when the room is archived).

The brain's memory lives on the gateway, per person (SQLite; [memory](../architecture/memory.md)). **Preferences** say how you want things; they are always in its prompt, and it saves one only on your word. **Facts** it keeps on its own, says so in the room with a line you can undo, and brings back before a turn when they bear on what you said. Review, search and forget them in the web app on the engine's **Memory** page (`/engine?open=memory`; preferences also on pirc's own page), which device tokens can reach too. The preference budget is `PIRC_MEMORY_USER_CHARS` characters (default 2000). Forgetting erases a preference or fact and its history, and refuses the same text afterwards.

The brain can also search what coding sessions noted in every repository (workspace memory). Each node mirrors the ledgers in `PIRC_WORKSPACE_MEMORY_DIR` (default `$PIRC_STATE_DIR/workspace-memory`, which its agents use too) to the gateway every `PIRC_MEMORY_MIRROR_MS` (default 30 s), without paths: an item names the session that wrote it, and only that session's owner can find it. Recalling a note asks its node, which reads the session that wrote it; with the node offline, the answer is the gateway's copy.

- `GET /api/brain/prompts` returns `{prompts: {soul, chat}}`, each `{text, writable, reason?, path, maxChars}`; `PUT /api/brain/prompts/:name` (`soul` or `chat`) with `{text}` writes one (empty text removes the file; `409 read_only` for a store link, symlink or unwritable file). The next turn reads it.
- `GET /api/brain/turns?room=<id>&limit=<1-100>` lists a room's latest turns (`kind` `user` or `wake`), newest first: `{id, roomId, kind, messageIds, startedAt, endedAt, outcome, error, usage}`, `outcome` one of `done`, `failed`, `aborted`, `timeout`, `preempted`, `interrupted` (open at a restart) or `null` while it runs.
- `GET /api/brain/context?room=<id>` returns the context snapshot of the brain's latest model call in the room, or `null`.
- `GET /api/loops?status=open|closed|all&limit=<1-200>` lists the open loops (plans/rewrite/04-open-loops.md) as the prompt orders them, or the latest closed ones: `{loops, limit}`, each `{id, user, roomId, faceId, what, why, origin, anchor, nextCheck, status, closedReason, closedAt, createdAt, lastTouchedAt, sourceEntryIds, dueAt}`. `PATCH /api/loops/:id` with `{status: "closed", reason?}`, `{status: "open"}` or `{anchor}` (`{at, zone?, autoClose?}`, `{cron, zone?, until?}` or `null`) changes one and says so in its room; the rooms' stream carries `loop_changed {loop}`. See [memory](../architecture/memory.md#open-loops).
- `GET /api/wakes?status=pending|ended|all&room=<id>&limit=<1-200>` lists the brain's wakes (plans/rewrite/05-self-wake.md): `{wakes, today: {used, limit}}`, each `{id, kind, trigger, roomId, faceId, user, scheduledAt, startedAt, endedAt, outcome, note, attempt, turnId, createdAt}`, `outcome` one of `spoke`, `silent`, `preempted`, `failed`, `quota`, `cancelled`, or `null` while pending or running. `DELETE /api/wakes/:id` cancels one that has not started (`409 wake_running`). The rooms' stream carries `wake_changed {wake}`. Wakes come behind people's turns, at most `PIRC_WAKES_PER_DAY` a day; see [waking up](../architecture/memory.md#waking-up).

### Faces

The brain speaks through faces (plans/rewrite/10-faces.md, `brain/faces.rs`): the host (`host`, always there, never archived) and a face per project, with the rooms it answers in, the directory workspaces it is about (its `project_links`) and the sources it watches; a room is one active face's at most, and `#general` is the host's. Every message names its face (`speaker` `face:<id>`). Before a turn, code picks who answers: the faces `@`-named in the batch (a whole name, any case, not inside an address), else the face that spoke last among the room's latest 20 messages, else the room's face, else the host. The prompt's `face` section says who the brain is now and lists the other faces; `speak_as` switches within the turn (a reply already written stays the face's that wrote it). What it remembers, opens or hands to a worker carries the face. A wake wears the face that scheduled it (a loop's face, or whoever asked to come back), else for a source wake the face watching the source, else the room's, else the host. A face's presence is `thinking` while a turn speaks as it, `waiting` while a worker of its asks, `working` with workers at it, else `idle`.

The brain tags a turn with `topic {name, workspace?, source?}`; its messages carry `topic`. After the turn, code checks decision #11's guards (`brain/moving.rs`): 15 or more of the room's latest 50 text messages on the topic, another open room covering what it touches (a face's room linked to the workspace or a clone of its repository, or a room that follows the source) where this one does not, and not suggested today (the household's zone). Then the next turn there has a `move` section asking the host to suggest it once; `move_room {to, quote}` moves only on someone's words, and the room's open loops made since the topic began go along. `create_face {name, bio?, tone?, role?, workspaces?, room? | new_room?, quote}` makes one when someone asks. Neither, nor `topic`, is in a wake.

- `GET /api/faces?hidden=1` returns `{faces, presence}`, each face `{id, name, bio, tone, avatar, color, roleMd, territory: {rooms, workspaces, sources}, isHost, createdAt, archivedAt, hiddenAt}`, the host first and archived ones last; hidden ones only with `hidden=1`. `GET /api/faces/:id` returns `{face, presence}`.
- `POST /api/faces` with `{name, bio?, tone?, avatar?, color?, roleMd?, territory?}` (`201 {face}`); names are 1 to 40 characters without `@` or `#`, unique in any case (`409`); a room another face has, or `#general`, is `409`; an unknown workspace or source `400`.
- `PATCH /api/faces/:id` with the same fields (`avatar` and `color` take `null`), `archived` and `hidden` (only an archived face can be hidden; unarchiving shows it again). The host's territory and archive are `409`. Changes apply from the next turn and are sent as `face_changed`.
- `GET /api/faces/:id/activity` returns `{loops, workers, wakes}`: its open loops and its latest 20 workers and wakes.
- `POST /api/rooms/:id/move` takes `{toRoomId, topic?}`; with a topic, the room's open loops made since it began go along (`loops`, their ids, in the reply).

### Sources

Sources (plans/rewrite/09-sources.md, `crates/pirc-gateway/src/sources/`) are read-only connectors the gateway polls: `email` (IMAP over TLS, a small client of its own in `sources/imap.rs`; `EXAMINE`, `BODY.PEEK`, Gmail's `X-GM-RAW`), `calendar` (ICS or CalDAV `REPORT`; `sources/ics.rs` parses and expands recurrences), `moodle` (`webservice/rest/server.php`, only the functions in `moodle::READ_ONLY`) and `workspace` (the node's `workspace.read` `git_log`). A source is `{id, kind, name, user, config, pausedAt, lastPolledAt, lastError, failures, createdAt, updatedAt, rooms, cadenceMs}`; its id is its kind and a slug of its name (`email:gmail-school`); `config` never holds a credential (those are in `$PIRC_STATE_DIR/sources/secrets.json`). The poller (`sources/poller.rs`) reads each unpaused source at its kind's cadence; a poll's new and changed items (`message`, `event`, `assignment`, `notification`, `commit`: headers and times only) go into `source_items` with a full-text index; then `sources/filter.rs` decides in Rust whether to enqueue one `source` wake for the poll: a room follows the source (`sourceScope.sources` holds its id), or a change shares a distinctive term with an open loop. The first poll of a source (and of a new configuration) is a baseline and wakes nobody. Three failures in a row post one line in the room (`body.source {id, event: "unreadable"}`).

The brain's tools (`brain/source_tools.rs`, run on the main runtime by `sources/tools.rs`): `email_list`, `email_search`, `email_read`, `calendar_list`, `calendar_read`, `moodle_deadlines`, `moodle_courses`, `moodle_course`, `moodle_assignment`, `moodle_forum`, `moodle_notifications`, `source_search`, and `room_sources` (not while awake). Tools of kinds no source has are hidden from a turn; a paused source is not readable. Results are fenced (`<<<SOURCE_CONTENT id=…>>>`) and give what the brain keeps from them the origin `tool:<source id>` (`pirc-agent`'s `entry_origin`, by the `source` argument; a source wake's input carries it in its details).

- `GET /api/sources` returns `{sources, kinds, webSearch: {available}}`.
- `POST /api/sources` with `{kind, name, config?, secret?}` tries the source, keeps it and takes its baseline (`201 {source, test}`; `400 source_login_failed` / `invalid_login`, `502 source_unreachable`). `email`: `config {host?, port?, username, mailbox?, tls?}` (Gmail by default), `secret {password}`. `calendar`: `config {mode: "ics"}` with `secret {url}`, or `{mode: "caldav", url, username}` with `secret {password}`. `moodle`: `config {url}` with `secret {username, password}` or `{launch}` (a pasted `moodlemobile://token=…` of a launch started here). `workspace`: `config {workspace}`.
- `PUT /api/sources/:id` with `{name?, config?, secret?}` (a new configuration or credential is tried and starts the source over); `DELETE /api/sources/:id` deletes it, what it saw and its credential.
- `POST /api/sources/:id/test`, `/pause`, `/resume`; `POST /api/sources/:id/poll` reads it now (waits for a poll under way): `{source, baseline, changed, wake, error}` (`409 source_paused`).
- `GET /api/sources/:id/items?q=&limit=<1-100>` lists what its polls saw, the latest first or by search.
- `POST /api/sources/moodle/launch` with `{url}` returns `{site, launchUrl}`; the passport in it is valid for 30 minutes.

Device tokens reach these routes only with the backends' management grant (`Providers`).

### Workers and threads

The brain calls workers (plans/rewrite/06-workers.md, `crates/pirc-gateway/src/delegations.rs`): it hands a task to a new session in one of the household's directory workspaces, on any node, or more work to a worker that ended, without asking anyone. At most 4 run at once (2 of them called by a wake); the others wait `queued`, as do those whose node is offline, and start as soon as they can, each wait said once in the room. The gateway creates and names the session and pushes the task into it as a message from the assistant (`POST /api/sessions/:id/deliver`, a node route only the gateway calls; it needs no control lease and starts the agent if it is not running), never as a person's words, so auto mode there still asks before dangerous commands; only a person's own words the brain quoted (verified in their last messages) count as their request. The task carries the facts and loops the brain handed over, with where each came from (`## Context from the assistant`); a worker a wake called is delivered with `approvalMode: "read-only"`, which the node applies before the task (the gateway can only narrow a session this way). The worker's progress, its team's records (the agent's `team_event`, one level down) and its questions go to a thread under the room message that called it; a question is answered there through the node's gateway-only `POST /api/sessions/:id/interactions/:interactionId/relayed-answer` without a lease (a confirmation takes only yes or no), and words said in the thread reach a running worker as a `follow_up` command (the gateway takes the session's control for it when nobody holds it, as Stop does) or call it again once it ended. How it ended comes back to the room as the host's message (at most 2000 characters; the rest is in the thread and `worker_status`), and the brain hears of it at its next turn there.

A worker (plans/rewrite/06-workers.md) belongs to the room it was called in. Calling one writes the host's message there (its anchor: `body.worker` `{delegationId, threadId, status, title, workspace, workers, readOnly, note}`, updated in place) with a thread under it (`threadId`). A thread's messages are numbered per thread: `speaker` is `worker:<session>` (the worker), `worker:<session>/<name>` (a teammate or subagent it started, `depth: 1`), `user` (with `user`) or `face:<id>`; `kind` is `text`, `line`, `tool` (`{tool, summary}`) or `question` (`{interactionId, kind, request, status: "pending"|"answered"|"cancelled", delegationId}`). Room lines about a worker (`body.worker.event`: `question`, `busy`, `offline`) and its report (`body.worker.report: true`) name its thread.

- `GET /api/workers?status=active|all&room=<id>&limit=<1-200>` lists workers, newest first: `{id, roomId, faceId, threadId, anchorMessageId, title, workspace, workspaceId, status, note, readOnly, follows, for, targetSessionId, createdAt, updatedAt}`; `status` is `queued`, `running`, `waiting_input`, `completed` or `failed`, and `for` is whom it works for (its session is theirs).
- `GET /api/threads/:id?after=<seq>&limit=<1-500>` returns `{thread, messages, workers}`, the thread's workers latest first.
- `POST /api/threads/:id/messages` with `{text}` says it in the thread and hands it to the thread's latest worker: a follow-up of its run while it works, added to its task while it waits, or a new worker in the same session and thread once it ended (`handed.as`: `followUp`, `task` or `followUpWorker`).
- `POST /api/threads/:id/answer` with `{interactionId, answer}` (`{value}`, `{confirmed}` or `{cancelled: true}`) answers a worker's question (`409 stale_interaction` once it no longer waits).
- `POST /api/delegations/:id/stop` stops a worker: a queued one ends before it starts, a running one's run is stopped.

Adding to a thread, answering and Stop are for whom the worker works for (`403` for others); reading is everyone's. A running worker's own questions are pushed from its room. A session's own questions push nothing: the engine shows no conversation to answer them in.

### Engine

The engine is what runs behind the rooms: workspaces and nodes, the workers' sessions, model backends and paired devices. A worker's session is an ordinary agent session on its node; these routes reach it directly.

- `GET /api/health`
- `GET /api/workspaces`
- `GET|POST /api/sessions`. Create takes only `{ "workspaceId" }`; sessions cannot be named at creation. A new session starts as `New session` (`nameSource: "auto"`), and the agent's generated title replaces it, reported as a `session_renamed` event.
- `PATCH /api/sessions/:id` takes any of `{ "name", "pinned", "settled" }`. A `name` renames the session and marks the name as user-chosen, so generated titles no longer replace it. `pinned` and `settled` are booleans that organize the sidebar (sessions report them as `pinnedAt` / `settledAt` timestamps, or `null`); only the gateway stores them, and they do not change the session's activity time.
- `GET /api/sessions/:id/snapshot`
- `POST /api/sessions/:id/commands`
- `GET /api/sessions/:id/control`
- `POST /api/sessions/:id/control/{acquire,heartbeat,release}`
- `POST /api/sessions/:id/interactions/:interactionId/answer`
- `POST /api/sessions/:id/uploads` with raw bytes; PNG/JPEG/GIF/WebP are sniffed and sent to the model as images, anything else needs `?filename=` and is copied into the session's workspace (`.pirc/uploads/`) for the agent's file tools to read; stored on the session's node
- `GET /api/models` lists the gateway's models (identical for every session and node; an optional `sessionId` is only checked for access)
- Model backends (single-user, global; responses are `Cache-Control: no-store` and never contain keys, tokens or file endpoints): `GET /api/providers`; `POST /api/providers` with `{id, api, baseUrl, apiKey?, models}`; `PUT|DELETE /api/providers/:id` (`apiKey` omitted keeps the saved key, `""` clears it; deleting `oauth:<provider>` logs out); `PUT /api/providers/default-model` with `{provider, id, thinking?}` or `null`; setup helpers `GET /api/providers/presets` (pi-ai catalog services and local servers; saving with `preset` keeps catalog request compatibility), `POST /api/providers/discover` (the endpoint's model list) and `POST /api/providers/test` (one tiny request) for an unsaved form, where an omitted `apiKey` reuses the edited web backend's `backendId` key
- Subscription login sessions: `POST /api/provider-auth/sessions` with `{providerId, policyConsent?}`; `GET|DELETE /api/provider-auth/sessions/:id`; `POST /api/provider-auth/sessions/:id/input` with `{promptId, value?}`. A session exposes the authorization link, pending prompts (`prompt`, `manual` callback URL), progress, status and expiry; it expires after 10 minutes
- Paired devices (forward auth only; `Cache-Control: no-store`): `GET /api/devices` lists `{id, name, createdAt, lastUsedAt, expiresAt}`; `POST /api/devices` with `{name}` returns `{device, token}`, the only time the token is shown; `DELETE /api/devices/:id` revokes it
- WebSocket `GET /api/events?sessionId=...&cursor=<epoch>:<sequence>`
- `GET /api/nodes` lists online nodes; `GET|POST /api/workspaces` lists workspaces or adds one on a node
- Side panel, read-only: `GET /api/sessions/:id/git/{status,diff,log}`, `GET /api/sessions/:id/git/commits/:sha`, `GET /api/sessions/:id/files[/content]?path=...` (confined to the workspace), `GET /api/sessions/:id/panel/state` (memory, background tasks, teammates) and `GET /api/sessions/:id/panel/background/:taskId`. A `panel_changed` event tells clients which sections to refetch.
- Terminals (run on the session's node; the stream is relayed over the node link): `GET|POST /api/sessions/:id/terminals`, `POST /api/sessions/:id/terminals/:terminalId/close`, and WebSocket `GET /api/sessions/:id/terminals/:terminalId/stream`, which replays recent output on connect. Creating, closing, typing and resizing require a live control lease.

Mutations that affect the agent require `{clientId,generation}` from a live control lease. Commands additionally require a client-generated `commandId`. Reusing the ID with the same canonical payload returns the known command; using it with a different payload returns `409`.

### Streaming semantics

Session command payloads also accept `edit_message` with `{entryId, message}` and `switch_branch` with `{entryId}`. Both require the current control lease and an idle session. Editing creates a new user-message version, retaining image blocks, then regenerates the response; switching selects that user version's latest continuation without inference. Snapshot history includes stable `entryId` values and user-message `branches: [{entryId, text, selected}]`. Clients refresh the snapshot after a branch command or completed turn to obtain persisted entry identities. The node stops the idle runner before selecting the durable branch and initializes a fresh runner so cached feature state cannot leak from the previous conversation. Tool side effects are not rolled back.

Gateway cursors are `<runnerEpoch>:<sequence>`. A cursor outside the bounded in-memory buffer or from another epoch yields `reset`; clients then fetch a snapshot. `message_update` deltas are assembled for the live partial message, while `message_end.message` replaces the partial as authoritative history. A run finishes only on `agent_settled`, not `agent_end`.

### Crash semantics

At startup (of the gateway or a node) unfinished runs become `interrupted`, pending interactions become `stale`, leases are deleted, and commands left `dispatched` become `outcome_unknown`. Such a command is never retried automatically. A runner crash applies the same uncertainty rule to outstanding dispatched commands.

### Queue semantics

`steer` joins the running run once the current assistant message's whole tool batch has finished, before the next model call; no tool call is skipped. `follow_up` waits until the run would otherwise stop. `send_now` (`{queue: 'steering'|'followUp', index, message}`, `index` counting only the queue's user messages, `message` required to match) moves a queued message to the front and interrupts only the current turn: a streaming reply is aborted (the model is told it was interrupted, with its partial text), a running tool is aborted, and the batch's remaining calls are skipped. The run itself continues, so goals, team waits and background notices are unaffected. A message that is no longer queued is rejected.

### Stop semantics

`stop` sends `clear_queue` before `abort`; cleared steering/follow-up text is returned in the command result. This does not guarantee termination of arbitrary extension background jobs or team children.

## Data

Each process keeps its own SQLite below its `PIRC_STATE_DIR`. The gateway's (`pirc.sqlite`, schema in `crates/pirc-gateway/src/db/schema.sql`) holds the rooms and their messages, reads and pending input, the brain's turns, the sources and what they saw, the session index, leases, and command outcomes; an old `gateway.sqlite` from before the rewrite is left where it is and not read; a node's also holds runs, interactions, and uploads, and its state directory contains the agent session JSONL files (the conversation source of truth) and uploaded files. Non-image uploads are also copied into the workspace at `.pirc/uploads/` so the agent's read/bash tools can reach them (that directory is writable by the uploader but protected from the agent's own writes).
