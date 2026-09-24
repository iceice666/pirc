# Pi Remote Client

A private, forward-authenticated web client for persistent [Pi](https://github.com/earendil-works/pi) RPC sessions.

This repository implements an M0–M3 MVP with a Node.js gateway, Pi RPC subprocesses and a responsive Svelte PWA. An optional multi-node mode now connects Pi-equipped devices to one central daemon over private VPN, with local Pi execution and centrally routed sessions. See the [multi-node setup](./apps/gateway/README.md#multi-node-private-vpn-deployment) and its current limitations.

## Security model

The gateway is intended to sit behind a trusted reverse proxy using an Authelia-style forward-auth flow.

- The gateway only accepts identity headers from explicitly configured proxy IP addresses.
- Authenticated user identities, `Host`, and `Origin` are checked against exact allowlists.
- There is no trust-all or unauthenticated production default.
- Workspaces are allowlisted, but this is **not a sandbox**. Pi and its tools retain the operating-system permissions of the gateway account.
- Keep the gateway on loopback or a private interface reachable only by the trusted proxy. Do not expose it through Tailscale Funnel or the public Internet.

## Requirements

- Node.js 22.19 or newer
- Pi `0.85.1` available as `pi` (or configured with `PIRC_PI_BINARY`)
- A trusted forward-auth reverse proxy

## Development

```sh
npm install
cp apps/gateway/.env.example apps/gateway/.env
# Fill every security allowlist. Do not copy development values to production.
npm run dev
npm run dev:web
```

The first configured workspace can point to this repository. See [`apps/gateway/README.md`](./apps/gateway/README.md) for configuration and API details, and [`apps/web/README.md`](./apps/web/README.md) for the client.

## Validation

```sh
npm run check
```

Real-model smoke tests are deliberately separate because they require credentials and incur provider cost. The automated integration suite uses a fake Pi RPC subprocess.

## Nix integration

A reusable flake, package, development shell, and NixOS module are available in [`flake.nix`](./flake.nix) and [`nix/`](./nix/README.md):

```sh
nix develop
nix build
```

The NixOS module creates an unprivileged service account and can generate an nginx virtual host wired to an Authelia-compatible `auth_request` endpoint. Deployment-specific Pi packaging, secret management, TLS certificate ownership, workspace permissions, and host names remain explicit inputs rather than unsafe defaults.

## Known deployment boundary

The reusable Nix foundation is present, but applying it to a target host, TLS/proxy authorization, backup/restore drills, and physical-phone lock-screen acceptance still require an explicitly authorized M4 deployment.
