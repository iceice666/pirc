# pirc gateway and node

A TypeScript/Fastify service on Bun, together with the built-in coding agent (`src/agent/`). One binary plays two roles:

- **`pirc gateway`** (`src/daemon/`) is the only thing browsers talk to. It authenticates them, indexes sessions and control leases in SQLite, buffers each session's events, and routes every session request to the node that owns it. It never runs agents, shells, or workspace inspection itself, and never learns real workspace paths.
- **`pirc node`** (`src/node/`) runs on each machine that has workspaces. It connects _out_ to the gateway over one WebSocket and owns everything local: the `pirc agent` subprocesses (JSONL RPC on stdin/stdout), side-panel shells and Git/file inspection, uploaded images, and the session JSONL files and SQLite metadata. It does not listen on any port.

A single-machine setup runs both on the same host; the node then reaches the gateway at `ws://127.0.0.1:<port>`.

`src/protocol.ts` describes the gateway↔node link. Both sides announce `NODE_PROTOCOL_VERSION`; on a mismatch the gateway closes the link with code 4426, so upgrade the gateway and nodes together.

## Security model

The gateway must listen only behind a trusted authenticated proxy. It accepts the configured identity header **only** when the TCP peer address exactly matches `PIRC_TRUSTED_PROXIES`, then checks that identity against `PIRC_ALLOWED_USERS`. Host and Origin comparisons are exact allowlist matches; mutating HTTP requests and every WebSocket upgrade require an Origin.

Nodes authenticate to `/node/connect` with a per-node secret (`PIRC_NODE_TOKENS` on the gateway, `PIRC_NODE_TOKEN` on the node). That path must bypass the browser forward-auth, and the proxy must never hand node tokens to browsers. Each node checks the user of every relayed request against its own `PIRC_ALLOWED_USERS`, and sessions are visible only to the user who created them.

Model credentials (API keys, subscription OAuth tokens) stay on the gateway, which runs every model request. A node forwards its agents' requests over its link and receives only streamed results and a secret-free model catalog. Agents reach the node through a Unix socket in the node's state directory (mode 0600, random per-start token), not a TCP port. Backend settings and logins are in `$PIRC_STATE_DIR/backends/settings.json` (0600); this is file-permission protection for a single-user deployment, not isolation from processes running as the same account.

The workspace registry is an execution allowlist, not a sandbox. The agent, its tools, and side-panel shells keep the Unix permissions of the node's account. Do not run a node as root or expose the gateway directly to an untrusted network.

## Setup

```sh
cd apps/gateway
cp .env.example .env # inject with your service manager; .env is not automatically loaded
bun install
bun run build   # dist/pirc single binary
bun test
bun run start       # or: dist/pirc gateway
bun run start:node  # or: dist/pirc node (separate environment, see .env.example)
```

### Gateway

Set `PIRC_HOST`/`PIRC_PORT`, `PIRC_STATE_DIR`, the browser checks (`PIRC_TRUSTED_PROXIES`, `PIRC_IDENTITY_HEADER`, `PIRC_ALLOWED_USERS`, `PIRC_ALLOWED_ORIGINS`, `PIRC_ALLOWED_HOSTS`), and `PIRC_NODE_TOKENS`: a JSON object mapping each node ID to a **different random secret of at least 32 characters**. Model backends are configured here: in the web **Settings** (API-key/custom endpoints and subscription logins) and in `models.json` (`PIRC_MODELS_FILE`, default `$PIRC_CONFIG_DIR/models.json`); `SIGHUP` reloads the file. The gateway runs all inference, so endpoints must be reachable from it (see the root README's Agent section). Node settings such as `PIRC_WORKSPACES` or `PIRC_NODE_ID` are refused at startup.

### Node

Set `PIRC_NODE_ID`, its matching `PIRC_NODE_TOKEN`, `PIRC_DAEMON_URL`, `PIRC_ALLOWED_USERS`, the machine's own `PIRC_STATE_DIR`, optionally `PIRC_WORKSPACES`, and the node-local agent config (`PIRC_CONFIG_DIR`, default `~/.config/.pirc`; limits, features, hooks, and the system prompt, but no providers).
A node gets the model catalog from the gateway when it registers and sends every model request back over the link, so its agents cannot call a model while it is disconnected (they report `Gateway inference is unavailable`). Provider keys never reach nodes; a leaked node token still allows using the gateway's models. The link must use `wss://` unless the gateway is on loopback; only local development should set `PIRC_ALLOW_INSECURE_NODE_TRANSPORT=true`.

The node runs its own binary with the `agent` subcommand for each session. To use a different agent executable, set `PIRC_AGENT_COMMAND` (and optionally `PIRC_AGENT_ARGS` as a JSON array). `PIRC_TERMINALS=false` disables side-panel shells; the shell comes from `PIRC_TERMINAL_SHELL` or `$SHELL`.

### Workspaces

`PIRC_WORKSPACES` is a JSON array of `{id, path, displayName?, defaults?}` and may be empty. From the web, `POST /api/workspaces` with `{ "nodeId": "m5pro", "path": "~/projects/example", "displayName": "Example" }` adds one to an online node. The directory must already exist inside that node account's home; its resolved real path must stay inside the home (symlink escapes, system paths, and directory creation are refused). The node persists the workspace and advertises it again after reconnecting. The gateway lists it as `<nodeId>:<workspaceId>` and assigns each new session permanently to its node.

### Node failure

A disconnected node makes its sessions answer `503` and stops new commands. A command whose acknowledgement was lost becomes `outcome_unknown` and **is never retried automatically**. Open terminal streams close with `1012`. On reconnect the event epoch increments, so clients fetch a new snapshot.

**Current limitations:** no cross-device session migration, and node secrets and state directories need an external secret manager and backup policy. If the gateway loses a session-create acknowledgement while the node persisted the session, that session is orphaned on the node; inspect the node's database before creating a replacement.

## API

Every session route is answered by the node that owns the session; the gateway checks ownership and the control lease first.

- `GET /api/health`
- `GET /api/workspaces`
- `GET|POST /api/sessions`. Create takes only `{ "workspaceId" }`; sessions cannot be named at creation. A new session starts as `New session` (`nameSource: "auto"`), and the agent's generated title replaces it, reported as a `session_renamed` event.
- `PATCH /api/sessions/:id` takes any of `{ "name", "pinned", "settled" }`. A `name` renames the session and marks the name as user-chosen, so generated titles no longer replace it. `pinned` and `settled` are booleans that organize the sidebar (sessions report them as `pinnedAt` / `settledAt` timestamps, or `null`); only the gateway stores them, and they do not change the session's activity time.
- `GET /api/sessions/:id/snapshot`
- `POST /api/sessions/:id/commands`
- `GET /api/sessions/:id/control`
- `POST /api/sessions/:id/control/{acquire,heartbeat,release}`
- `POST /api/sessions/:id/interactions/:interactionId/answer`
- `POST /api/sessions/:id/uploads` with raw PNG/JPEG/GIF/WebP bytes; stored on the session's node
- `GET /api/models` lists the gateway's models (identical for every session and node; an optional `sessionId` is only checked for access)
- Model backends (single-user, global; responses are `Cache-Control: no-store` and never contain keys, tokens or file endpoints): `GET /api/providers`; `POST /api/providers` with `{id, api, baseUrl, apiKey?, models}`; `PUT|DELETE /api/providers/:id` (`apiKey` omitted keeps the saved key, `""` clears it; deleting `oauth:<provider>` logs out); `PUT /api/providers/default-model` with `{provider, id, thinking?}` or `null`
- Subscription login sessions: `POST /api/provider-auth/sessions` with `{providerId, policyConsent?}`; `GET|DELETE /api/provider-auth/sessions/:id`; `POST /api/provider-auth/sessions/:id/input` with `{promptId, value?}`. A session exposes the authorization link, pending prompts (`prompt`, `manual` callback URL, `select`), progress, status and expiry; it expires after 10 minutes
- WebSocket `GET /api/events?sessionId=...&cursor=<epoch>:<sequence>`
- `GET /api/nodes` lists online nodes; `GET|POST /api/workspaces` lists workspaces or adds one on a node
- Side panel, read-only: `GET /api/sessions/:id/git/{status,diff,log}`, `GET /api/sessions/:id/git/commits/:sha`, `GET /api/sessions/:id/files[/content]?path=...` (confined to the workspace), `GET /api/sessions/:id/panel/state` (memory, background tasks, teammates) and `GET /api/sessions/:id/panel/background/:taskId`. A `panel_changed` event tells clients which sections to refetch.
- Terminals (run on the session's node; the stream is relayed over the node link): `GET|POST /api/sessions/:id/terminals`, `POST /api/sessions/:id/terminals/:terminalId/close`, and WebSocket `GET /api/sessions/:id/terminals/:terminalId/stream`, which replays recent output on connect. Creating, closing, typing and resizing require a live control lease.

Mutations that affect the agent require `{clientId,generation}` from a live control lease. Commands additionally require a client-generated `commandId`. Reusing the ID with the same canonical payload returns the known command; using it with a different payload returns `409`.

### Streaming semantics

Gateway cursors are `<runnerEpoch>:<sequence>`. A cursor outside the bounded in-memory buffer or from another epoch yields `reset`; clients then fetch a snapshot. `message_update` deltas are assembled for the live partial message, while `message_end.message` replaces the partial as authoritative history. A run finishes only on `agent_settled`, not `agent_end`.

### Crash semantics

At startup (of the gateway or a node) unfinished runs become `interrupted`, pending interactions become `stale`, leases are deleted, and commands left `dispatched` become `outcome_unknown`. Such a command is never retried automatically. A runner crash applies the same uncertainty rule to outstanding dispatched commands.

### Stop semantics

`stop` sends `clear_queue` before `abort`; cleared steering/follow-up text is returned in the command result. This does not guarantee termination of arbitrary extension background jobs or team children.

## Data

Each process keeps its own SQLite below its `PIRC_STATE_DIR`. The gateway's holds the session index, leases, and command outcomes; a node's also holds runs, interactions, and uploads, and its state directory contains the agent session JSONL files (the conversation source of truth) and uploaded images.
