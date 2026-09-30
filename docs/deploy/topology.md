# Topology

## Processes

One executable, `pirc`, plays every role through its subcommand:

| Subcommand     | Runs on                       | Listens on                                                  | Does                                                                                                                                                      |
| -------------- | ----------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway`      | one always-on host            | `PIRC_HOST:PIRC_PORT` (default `127.0.0.1:8787`), HTTP + WS | Authenticates browsers and phones, indexes sessions, routes every session request to its node, runs **all model requests**, keeps memory, schedules, push |
| `node`         | every machine with workspaces | nothing (connects out to the gateway over one WebSocket)    | Runs one `pirc agent` per session, side-panel shells, file/Git inspection, uploads, the agents' browser; owns session transcripts                         |
| `agent`        | started by the node           | nothing (JSONL RPC on stdin/stdout with the node)           | The agent loop, its tools, teammates and subagents; sandboxed by the node when srt is available                                                           |
| `ptc-worker`   | started by the agent          | nothing                                                     | Runs the `code` tool's scripts                                                                                                                            |
| `oauth-worker` | started by the gateway        | nothing                                                     | Runs one subscription login flow in an isolated, time-limited subprocess                                                                                  |
| `version`      | anywhere                      | —                                                           | Prints the version; used as an install check                                                                                                              |

The gateway never runs agents, shells or tools, and never learns real workspace paths. A node never listens on a port; agents reach their node through a Unix socket in the node's state directory.

## Who talks to whom

```
browser ──https──▶ reverse proxy ──forward auth──▶ static web bundle
                        │                    └───▶ pirc gateway  /api/…      (identity header set by the proxy)
phone app ──https──▶    │  Bearer pirc_dev_… ────▶ pirc gateway  /api/…      (no forward auth, identity header stripped)
                        └─ /node/connect ◀──wss── pirc node (machine A)      (no forward auth, PIRC_NODE_TOKEN)
                                          ◀──wss── pirc node (machine B)
                                          ◀──ws─── pirc node (same host as the gateway, loopback)

pirc node ──stdio JSONL──▶ pirc agent ──unix socket──▶ pirc node ──node link──▶ gateway ──▶ model provider
```

- Browsers and phones only ever reach the gateway, and only through the proxy.
- Nodes connect **out** to `PIRC_DAEMON_URL`. Off loopback the link must be `wss://`; the proxy passes `/node/connect` through without forward auth.
- Model providers are reached from the gateway only. A provider that listens on a node's `localhost` is unreachable; put it where the gateway can reach it.
- Web search (`EXA_API_KEY`) runs on the gateway; the agents' browser runs on the node.

## Supported layouts

### Single host

Gateway, one node, the proxy and the web bundle on the same machine. The node uses `PIRC_DAEMON_URL=ws://127.0.0.1:8787` (plain `ws://` is accepted on loopback). This is what the [NixOS module](./nixos.md) sets up by default.

### Central gateway, several nodes

A small always-on host runs the gateway (and optionally a local node); workstations and laptops run nodes that connect over a VPN or tailnet. Each node has its own token in `PIRC_NODE_TOKENS`. Sessions are permanently assigned to the node that owns their workspace; a node that is offline makes its sessions answer `503` until it returns.

### Routing-only gateway

The gateway host has no workspaces (`services.pirc.localNode.enable = false`, or simply no node there). All work happens on remote nodes. The gateway still needs at least one entry in `PIRC_NODE_TOKENS`.

### The chat node

At most one node may set `PIRC_CHAT=1`. It hosts the assistant's chats (the top-level **Chats** workspace and the projects created from the web) in directories it manages under its state directory, and hosts **nothing else**: `PIRC_WORKSPACES` must be empty there and the web refuses to add directory workspaces to it. Pick an always-on machine, usually the gateway host's local node. Without a chat node, the assistant features (memory, delegation, schedules from chat) are simply absent.

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

Both state directories are created with mode `0700`. See [Backup and recovery](./backup-and-recovery.md) for what to copy.

## Ports and addresses to decide up front

- The gateway's listen address and port (`PIRC_HOST`, `PIRC_PORT`).
- The proxy's peer address as the gateway sees it (`PIRC_TRUSTED_PROXIES`): `127.0.0.1` and `::1` when co-located, else the proxy's private IP. Exact match, no CIDR.
- The public host name(s) and origin(s) browsers use (`PIRC_ALLOWED_HOSTS`, `PIRC_ALLOWED_ORIGINS`).
- The `wss://` URL nodes use to reach `/node/connect` (usually the same host name).
