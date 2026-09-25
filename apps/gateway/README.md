# pirc gateway

A TypeScript/Fastify gateway running on Bun, together with the built-in coding agent (`src/agent/`). The gateway owns the agent processes it starts (`pirc agent`, which speaks Pi-compatible JSONL RPC), indexes sessions in SQLite, brokers extension UI interactions, and exposes a narrow authenticated REST/WebSocket API.

## Security model

The gateway must listen only behind a trusted authenticated proxy. It accepts the configured identity header **only** when the TCP peer address exactly matches `PIRC_TRUSTED_PROXIES`, then checks that identity against `PIRC_ALLOWED_USERS`. Host and Origin comparisons are exact allowlist matches; mutating HTTP requests and every WebSocket upgrade require an Origin.

The workspace registry is an execution allowlist, not a sandbox. The agent and its tools retain the Unix permissions of the gateway account. Do not run this service as root or expose it directly to an untrusted network.

## Setup

```sh
cd apps/gateway
cp .env.example .env # inject with your service manager; .env is not automatically loaded
bun install
bun run build   # dist/pirc single binary
bun test
bun run start   # or: dist/pirc gateway
```

By default, the gateway runs its own binary with the `agent` subcommand for each session. To use a different agent executable, set `PIRC_AGENT_COMMAND` (and optionally `PIRC_AGENT_ARGS` as a JSON array). The agent reads its providers and models from `PIRC_CONFIG_DIR` (default `~/.config/.pirc`). `PIRC_WORKSPACES` is required in production. A cwd/default workspace is available only after explicitly setting `PIRC_ALLOW_DEFAULT_WORKSPACE=true`.

## Multi-node private VPN deployment

Configure the central daemon with `PIRC_DAEMON_ONLY=true` and `PIRC_NODE_TOKENS`, a JSON object mapping node IDs to **different randomly generated secrets of at least 32 characters**. Daemon-only mode advertises no local workspaces, rejects local session creation (including any legacy daemon-local workspace still stored in SQLite), and requires node tokens; omit `PIRC_WORKSPACES` or set it to `[]`. An existing single-host gateway keeps its local execution behavior when this flag is absent. Keep the daemon behind the existing authenticated reverse proxy; the proxy must pass `/node/connect` WebSocket upgrades without applying the browser identity-header authentication and must not expose the node token to browsers. Only configure local workspaces on a gateway intentionally running in mixed local/remote mode (without `PIRC_DAEMON_ONLY`).

On **each** device set `PIRC_NODE_ID`, its matching `PIRC_NODE_TOKEN`, `PIRC_DAEMON_URL=wss://your-private-vpn-host`, `PIRC_ALLOWED_USERS` and that device's `PIRC_WORKSPACES`, `PIRC_STATE_DIR`, and an agent config (`PIRC_CONFIG_DIR`). Run `pirc node` (the compiled binary) or `bun run start:node` from this package. The node keeps agent processes, SQLite metadata, and JSONL sessions on its own disk and connects outbound to the daemon; it does not listen on a public port. The node connection must be protected with TLS even on a VPN; only local development should set `PIRC_ALLOW_INSECURE_NODE_TRANSPORT=true` for `ws://`.

`GET /api/nodes` lists online devices. To add a workspace on an online node, `POST /api/workspaces` with `{ "nodeId": "m5pro", "path": "~/projects/example", "displayName": "Example" }`. The directory must already exist inside that agent user's home; its resolved real path must remain inside the home (symlink escapes, arbitrary system paths, and directory creation are refused). The node persists the workspace in SQLite and advertises it again after reconnect/restart; the daemon mirrors its metadata and never receives its real path. This does not turn the workspace allowlist into a sandbox. The daemon records remote workspaces as `<nodeId>:<workspaceId>` and assigns each new session permanently to its node; browsers continue to use the same session, control lease, command, snapshot and WebSocket event URLs. A disconnected node causes `503` on remote snapshots and stops new commands; any in-flight command that lost its acknowledgement is `outcome_unknown` and **is not automatically retried**. Node reconnect increments the event epoch, prompting clients to fetch a new snapshot. Only explicitly configured users can initiate node operations, and remote sessions remain visible only to their creator.

**Current limitations:** remote image uploads are rejected (and daemon uploads are disabled when node tokens are configured), there is no cross-device session migration, and agent/node secrets and state directories need an external secret manager and backup policy. If the daemon loses a session-create acknowledgement while the node persists it, the remote session can be orphaned; inspect the node's local database before trying to create a replacement. The workspace allowlist is not a sandbox.

## API

- `GET /api/health`
- `GET /api/workspaces`
- `GET|POST /api/sessions`. Create takes only `{ "workspaceId" }`; sessions cannot be named at creation. A new session starts as `New session` (`nameSource: "auto"`), and the agent's generated title replaces it, reported as a `session_renamed` event.
- `PATCH /api/sessions/:id` renames the session and marks the name as user-chosen, so generated titles no longer replace it.
- `GET /api/sessions/:id/snapshot`
- `POST /api/sessions/:id/commands`
- `GET /api/sessions/:id/control`
- `POST /api/sessions/:id/control/{acquire,heartbeat,release}`
- `POST /api/sessions/:id/interactions/:interactionId/answer`
- `POST /api/uploads` with raw PNG/JPEG/GIF/WebP bytes
- `GET /api/models?sessionId=...`
- WebSocket `GET /api/events?sessionId=...&cursor=<epoch>:<sequence>`

Mutations that affect the agent require `{clientId,generation}` from a live control lease. Commands additionally require a client-generated `commandId`. Reusing the ID with the same canonical payload returns the known command; using it with a different payload returns `409`.

### Streaming semantics

Gateway cursors are `<runnerEpoch>:<sequence>`. A cursor outside the bounded in-memory buffer or from another epoch yields `reset`; clients then fetch a snapshot. `message_update` deltas are assembled for the live partial message, while `message_end.message` replaces the partial as authoritative history. A run finishes only on `agent_settled`, not `agent_end`.

### Crash semantics

At startup unfinished runs become `interrupted`, pending interactions become `stale`, leases are deleted, and commands left `dispatched` become `outcome_unknown`. The gateway never automatically retries such a command. A runner crash applies the same uncertainty rule to outstanding dispatched commands.

### Stop semantics

`stop` sends `clear_queue` before `abort`; cleared steering/follow-up text is returned in the command result. This does not guarantee termination of arbitrary extension background jobs or team children.

## Data

SQLite, private agent session directories, and opaque image objects live below `PIRC_STATE_DIR` by default. Agent session JSONL remains the conversation source of truth; SQLite stores indexes and coordination metadata only.
