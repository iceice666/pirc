# Topology

## Processes

Three independently compiled executables start their fixed server role with no arguments:

| Executable     | Runs on                              | Listens on                                                  | Does                                                                                                                                |
| -------------- | ------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pirc-gateway` | one always-on host                   | `PIRC_HOST:PIRC_PORT` (default `127.0.0.1:8787`), HTTP + WS | Authenticates browsers and phones, indexes sessions, routes requests, runs **all model requests**, keeps memory, schedules and push |
| `pirc-chat`    | at most one always-on host           | nothing (connects out over one WebSocket)                   | Hosts assistant chats/projects, runs agents and their tools; owns chat transcripts                                                  |
| `pirc-node`    | every machine with coding workspaces | nothing (connects out over one WebSocket)                   | Runs coding agents, side-panel shells, file/Git inspection, uploads and the agents' browser; owns session transcripts               |

Chat and coding executables share the node/agent implementation. Their internal worker commands are not independently deployed services:

| Command                 | Available on             | Purpose                                                                       |
| ----------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `agent`                 | `pirc-chat`, `pirc-node` | Agent loop over JSONL RPC on stdin/stdout, always sandboxed by its node (srt) |
| `ptc-guest`             | `pirc-chat`, `pirc-node` | Runs one `ptc` script in QuickJS for its agent (empty environment, IPC only)  |
| `oauth-worker`          | `pirc-gateway`           | Runs one subscription login flow in a time-limited subprocess                 |
| `version` / `--version` | all three                | Prints the version as an install check                                        |

The Nix gateway package includes the Web UI, but not sandbox/browser runtime. Chat/node packages include srt/playwright-core, but not the Web UI. Keep every role on the same release/protocol version. The executable split is **not privacy isolation**: OS accounts, filesystem permissions and sandboxing define the protection boundaries.

In the deployed topology described here, the gateway never runs agents, shells or tools, and never learns real workspace paths. A node never listens on a port; agents reach their node through a Unix socket in the node's state directory. The [opt-in gateway agent runtime](#opt-in-gateway-agent-runtime-evaluated-not-deployed) below changes the loop's location and is not enabled by any shipped service.

## Who talks to whom

```
browser ──https──▶ reverse proxy ──forward auth──▶ static web bundle
                        │                    └───▶ pirc-gateway  /api/…      (identity header set by the proxy)
phone app ──https──▶    │  Bearer pirc_dev_… ────▶ pirc-gateway  /api/…      (no forward auth, identity header stripped)
                        └─ /node/connect ◀──wss── pirc-node (machine A)      (no forward auth, PIRC_NODE_TOKEN)
                                          ◀──wss── pirc-node (machine B)
                                          ◀──ws─── pirc-chat (always-on host, here loopback)

pirc-node ──stdio JSONL──▶ pirc-node agent ──unix socket──▶ pirc-node ──node link──▶ gateway ──▶ model provider
pirc-chat ──stdio JSONL──▶ pirc-chat agent ──unix socket──▶ pirc-chat ──node link──▶ gateway
```

- Browsers and phones only ever reach the gateway, and only through the proxy.
- Nodes connect **out** to `PIRC_DAEMON_URL`. Off loopback the link must be `wss://`; the proxy passes `/node/connect` through without forward auth.
- Model providers are reached from the gateway only. A provider that listens on a node's `localhost` is unreachable; put it where the gateway can reach it.
- Web search (`EXA_API_KEY`) runs on the gateway; the agents' browser runs on the node.

## Supported layouts

### Single host

Gateway, one node, the proxy and the web bundle on the same machine. The node uses `PIRC_DAEMON_URL=ws://127.0.0.1:8787` (plain `ws://` is accepted on loopback). This is what the [NixOS module](nixos.md) sets up by default.

### Central gateway, several nodes

A small always-on host runs the gateway (and optionally a local node); workstations and laptops run nodes that connect over a VPN or tailnet. Each node has its own token in `PIRC_NODE_TOKENS`. Sessions are permanently assigned to the node that owns their workspace; a node that is offline makes its sessions answer `503` until it returns.

### Routing-only gateway

The gateway host has no workspaces (`services.pirc.localNode.enable = false`, or simply no node there). All work happens on remote nodes. The gateway still needs at least one entry in `PIRC_NODE_TOKENS`.

### The chat node

Run at most one `pirc-chat` process (NixOS: `services.pirc.chat = true` selects it for the local runner). It hosts the assistant's chats (the top-level **Chats** workspace and the projects created from the web) in directories it manages under its state directory, and hosts **nothing else**: `PIRC_WORKSPACES` must be empty there and the web refuses to add directory workspaces to it. Pick an always-on machine, usually the gateway host's local node. Without a chat node, the assistant features (memory, delegation, schedules from chat) are simply absent.

## Where state lives

| Data                                                                       | Process   | Location                                                                    |
| -------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------- |
| Session index, control leases, command outcomes, device tokens             | gateway   | `$PIRC_STATE_DIR/gateway.sqlite`                                            |
| Assistant memory, delegations, schedules, push subscriptions, project caps | gateway   | same database                                                               |
| Web-managed model backends and subscription logins                         | gateway   | `$PIRC_STATE_DIR/backends/settings.json` (0600)                             |
| VAPID key pair for push (unless given by environment)                      | gateway   | `$PIRC_STATE_DIR/vapid.json`                                                |
| Session transcripts (the conversation source of truth), runs, interactions | node      | `$PIRC_STATE_DIR/sessions/<id>/`, `gateway.sqlite`                          |
| Uploads                                                                    | node      | `$PIRC_STATE_DIR/uploads/`, and `<workspace>/.pirc/uploads/` for non-images |
| Workspace memory ledgers (mirrored to the gateway without paths)           | node      | `$PIRC_STATE_DIR/workspace-memory/`                                         |
| Chat workspaces and per-project instructions                               | chat node | `$PIRC_STATE_DIR/chat/<workspaceId>/`                                       |
| Browser profiles (logins)                                                  | node      | `$PIRC_STATE_DIR/browser/`                                                  |
| Agent config, global `AGENTS.md`, skills                                   | node      | `$PIRC_CONFIG_DIR` (default `~/.config/.pirc`)                              |
| Node ↔ agent inference socket (random per start)                          | node      | `$PIRC_STATE_DIR/i-*/socket` (0600)                                         |

Both state directories are created with mode `0700`. See [Backup and recovery](backup-and-recovery.md) for what to copy.

## Opt-in gateway agent runtime (evaluated, not deployed)

The [gateway agent runtime plan](../../plans/gateway-agent-runtime.md) implements a fresh-session runtime (M2–M4) that moves the agent loop, context and authoritative transcripts to the gateway while nodes keep every workspace capability. It is a library composition (`createGatewayRuntimeHost`, `registerGatewayRuntimeRoutes`); no daemon route, NixOS option or environment variable enables it. The [M5 evaluation](../evaluations/gateway-runtime/m5-evaluation.md) found that model deltas reach clients without the node detour, but task-time gates fail; cutover needs a separate human decision and authorization.

```
browser/phone ──▶ gateway: runtime host (loop, context, transcripts, model calls, central tools)
                     ├── constrained phase worker per run   (libexec/pirc/pirc-runtime-worker)
                     ├── native PTC guest, gateway-only scripts (libexec/pirc/pirc-ptc-worker)
                     ├──▶ model provider
                     └── Environment protocol over the existing /node/connect link
                           └──▶ node: sandboxed environment executor (srt), hooks, approvals,
                                      environment-only and mixed PTC scripts, artifacts
```

- Model streams go provider → gateway → client; nodes receive tool intents, never inference context.
- Environment frames use the authenticated node WebSocket and its shared framing; there is no new port. Each tool call is a journaled `execution.start`/`status`/`ack` exchange; a node offline leaves history readable but starts no environment-dependent work.
- The phase worker holds no credentials, workspace, database or network: Linux uses bubblewrap + seccomp (needs `bwrap` and `ldd` in the trusted environment), macOS arm64 a native finite driver with adjacent assets. Unsupported platforms refuse to start; there is no unsandboxed fallback.
- New sessions start fresh. Legacy JSONL, branches, context snapshots and PTC stores are retained, never imported and never used as fallback.

Additional state when composed:

| Data                                                                                                                 | Process | Location                                                              |
| -------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------- |
| Fresh transcripts, branches, turns, runs, executions, context snapshots, outbox, PTC store, central inner operations | gateway | `runtime_*` and inner-journal tables in the shared `gateway.sqlite`   |
| Gateway-side Environment transport receipts and gateway-placed PTC outer records                                     | gateway | a separate execution-journal file chosen by whoever composes the host |
| Execution journal, results awaiting ACK, workspace quarantines, inner PTC operations                                 | node    | `$PIRC_STATE_DIR/environment-journal.sqlite`                          |
| Legacy-writer deny fences, writer transfers, revoked gateway generations                                             | node    | `$PIRC_STATE_DIR/writer-fences.sqlite`                                |

The gateway then keeps **complete private transcripts long-term** with no automatic deletion; node-owned artifacts stay on the node and show as unavailable while it is offline.

## Ports and addresses to decide up front

- The gateway's listen address and port (`PIRC_HOST`, `PIRC_PORT`).
- The proxy's peer address as the gateway sees it (`PIRC_TRUSTED_PROXIES`): `127.0.0.1` and `::1` when co-located, else the proxy's private IP. Exact match, no CIDR.
- The public host name(s) and origin(s) browsers use (`PIRC_ALLOWED_HOSTS`, `PIRC_ALLOWED_ORIGINS`).
- The `wss://` URL nodes use to reach `/node/connect` (usually the same host name).
