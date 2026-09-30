# Deploying pirc

These pages describe how to run pirc outside a development checkout. Each page covers one concern; read them in order the first time, then use them as reference.

| Page                                            | Covers                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Topology](./topology.md)                       | The processes, who talks to whom, what runs where, and which layouts are supported                           |
| [Gateway](./gateway.md)                         | `pirc-gateway`: every environment variable, the state directory, model backends, signals                     |
| [Node](./node.md)                               | `pirc-node` / `pirc-chat`: every environment variable, the agent config directory, workspaces, the chat node |
| [Sandbox and browser](./sandbox-and-browser.md) | The per-agent OS sandbox (srt) and the agents' Chromium, per node                                            |
| [Reverse proxy](./reverse-proxy.md)             | Forward auth, the routes that bypass it, static web serving, nginx and Traefik examples                      |
| [Secrets](./secrets.md)                         | Which secrets exist, where each one lives, how to generate and rotate them                                   |
| [NixOS](./nixos.md)                             | The `services.pirc` module: options, accounts, remote nodes, upgrading                                       |
| [macOS node](./macos-node.md)                   | A launchd node on a Mac, with or without Nix                                                                 |
| [Upgrades](./upgrades.md)                       | Release order, the node protocol version, reloads without restarts, rollback                                 |
| [Backup and recovery](./backup-and-recovery.md) | What to back up per process, restore, crash semantics, manual database surgery                               |
| [Troubleshooting](./troubleshooting.md)         | Symptoms, their causes and the commands that confirm them                                                    |

## Requirements

- The role executables: `pirc-gateway` and one or more `pirc-node` coding nodes, plus an optional `pirc-chat` assistant node. `bun run build` produces all three in `apps/gateway/dist/`; `nix build .#pirc-gateway`, `.#pirc-chat` or `.#pirc-node` builds the corresponding package. Each embeds Bun and SQLite; chat/node packages also ship [srt](./sandbox-and-browser.md) and playwright-core. Chromium/Chrome and optional ffmpeg are separate browser dependencies. Keep every role on the same release/protocol version; see [migration guidance](./upgrades.md#migrating-from-the-single-executable).
- The static web bundle (`apps/web/dist`, or the gateway package's `share/pirc/web`) served by a web server: the gateway does **not** serve it.
- A reverse proxy that performs forward authentication (Authelia or compatible) and terminates TLS.
- A model backend reachable **from the gateway**: a subscription login made in the web UI, or an API-key endpoint from the web UI or `models.json`.
- A private network (VPN, tailnet, LAN). pirc is a single-user tool; see the threat model in the [top-level README](../../README.md#security-model).

## Minimum checklist

Before treating a deployment as done:

1. The gateway listens on loopback (or a private interface) and only the proxy reaches it. `PIRC_TRUSTED_PROXIES` names the proxy's exact peer address.
2. `PIRC_ALLOWED_USERS`, `PIRC_ALLOWED_ORIGINS` and `PIRC_ALLOWED_HOSTS` are exact values, not wildcards.
3. Every node has its own random token of at least 32 characters, and the proxy never applies forward auth to `/node/connect` while also stripping the identity header there.
4. No secret is in a world-readable place (Nix store, a committed file, a process listing). See [Secrets](./secrets.md).
5. A forged identity header from a non-proxy address is refused (`curl` from another host with `x-pirc-user` set → 401/403).
6. `GET /api/nodes` through the proxy lists every node you expect, online.
7. A session in each workspace can run a trivial prompt, and the session header does not show "Not sandboxed" unless you accept that.
8. A backup of both state directories has been restored once on a scratch machine ([Backup and recovery](./backup-and-recovery.md)).
