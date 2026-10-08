# pirc

A private, forward-authenticated web client for persistent coding-agent sessions. It ships as three independently compiled executables: `pirc-gateway`, `pirc-chat`, and `pirc-node`.

It consists of:

- a **gateway** that browsers talk to: authentication, the session index, and routing;
- a **chat node** (`pirc-chat`) for assistant chats and projects;
- one or more **coding nodes** (`pirc-node`), one per machine with workspaces, which connect out to the gateway and run one built-in agent subprocess per session (over a JSONL RPC on stdin/stdout), plus side-panel shells;
- a responsive Svelte PWA;
- a native Android client in progress ([`apps/android`](apps/android/README.md)), which pairs through device tokens.

The gateway never runs agents or tools; it only runs model requests on their behalf (see [Model backends](docs/guides/model-backends.md)). On a single machine, run the gateway and a node side by side; across devices, each device runs a node that connects to one central gateway over a private VPN. See [`apps/gateway/README.md`](apps/gateway/README.md) for setup and the current limitations.

## Security model

### Threat model

pirc is a **single-user, self-hosted tool for a trusted private network**, such as your own VPN or LAN. The operator, gateway, paired nodes, and their operating-system accounts belong to one trust domain. One user may have multiple nodes, devices, and concurrent sessions.

- Model backend settings and credentials are deployment-wide settings for that operator. pirc is not a multi-tenant service: user allowlists and session ownership do not establish isolation between mutually untrusted users, and there is no separate administrator/user role model.
- Compromised gateway or node hosts, malicious processes running as the same OS account, and hostile node operators are outside the protection boundary. Agents always run in an OS sandbox, but it limits what they read, write and reach; it does not make a hostile node or account safe. Storing credentials on the gateway alone does not isolate them from processes that can access the same files or environment (the NixOS module runs the gateway as its own account for that reason).
- Repository content, web pages, model output, provider errors, and browser input remain untrusted data. A trusted network does not make that content authorization to run commands or change settings.
- The security goals are to prevent unintended exposure and unauthorized access, cross-site requests, and accidental credential disclosure. Authentication, request validation, secret-safe handling, and resource/lifecycle limits still matter on a private network. Multi-user deployment or public exposure requires a new threat-model review.

### Deployment safeguards

The gateway is intended to sit behind a trusted reverse proxy using an Authelia-style forward-auth flow. The private-network assumption does not disable the following safeguards:

- The gateway only accepts identity headers from explicitly configured proxy IP addresses.
- Authenticated user identities, `Host`, and `Origin` are checked against exact allowlists.
- There is no trust-all or unauthenticated production default.
- Nodes authenticate to the gateway with per-node secrets and connect outbound only; they listen on no port.
- Phones running the native app authenticate with device tokens paired from the web **Settings → Devices**. A device token still needs the trusted proxy and an allowed `Host`, cannot manage devices or model backends, and dies after 7 days without use, 30 days after pairing, or on revocation. Otherwise, it acts as you, including shells on your nodes; revoke a lost phone at once. The proxy must pass these requests past forward auth and strip the identity header (see [`apps/gateway/README.md`](apps/gateway/README.md#device-tokens)).
- Workspaces are allowlisted. Each agent runs in an OS sandbox (srt, sandbox-runtime, built into the chat/node executables); see [Agent sandbox](docs/guides/agent.md#agent-sandbox). A node where the sandbox cannot work starts no agents.
- The web side panel can browse workspace files, show Git changes and history, and open interactive shells in the workspace. Shells run as the node's account, just like the agent's tools, and require holding session control; set `PIRC_TERMINALS=false` on the node to disable them.
- The agent's browser (see [Browser](docs/guides/browser.md)) loads pages with the node account's network access and keeps each workspace's logins in a persistent profile. Taking it over from the side panel requires holding session control; set `PIRC_BROWSER=false` on the node to disable it.
- Keep the gateway on loopback or a private interface reachable only by the trusted proxy. Do not expose it through Tailscale Funnel or the public Internet.

## Requirements

- [Bun](https://bun.sh) 1.2 or newer (development/build only; the compiled executables embed their runtime)
- A model backend, configured on the gateway: a subscription login (Claude Pro/Max, GitHub Copilot, ChatGPT/Codex) or an API-key/custom endpoint from the web **Settings**, and/or `models.json` (see [Model backends](docs/guides/model-backends.md))
- A trusted forward-auth reverse proxy

## Development

```sh
bun install
cp apps/gateway/.env.example apps/gateway/.env
# Fill every security allowlist. Do not copy development values to production.
# Gateway, chat and coding nodes take separate environments; see the example.
bun run dev        # gateway
bun run dev:chat   # optional chat node, with its own node ID/token/state directory
bun run dev:node   # coding node, with PIRC_DAEMON_URL=ws://127.0.0.1:8787
bun run dev:web
```

The node's first workspace can point to this repository. See [`apps/gateway/README.md`](apps/gateway/README.md) for configuration and API details, and [`apps/web/README.md`](apps/web/README.md) for the client.

## Role-specific executables

```sh
bun run build            # web bundle plus all three independent executables
./apps/gateway/dist/pirc-gateway  # browser API and routing
./apps/gateway/dist/pirc-chat     # assistant chats and projects
./apps/gateway/dist/pirc-node     # coding agents and shells for this machine
```

To compile only one role, run `bun run build:gateway`, `bun run build:chat` or `bun run build:node` from `apps/gateway/` (from the repository root, prefix with `bun run --filter @pirc/gateway`). Build the Web UI separately with `bun run --filter @pirc/web build` when needed.

Each executable embeds Bun and SQLite. Chat and coding nodes share the same node/agent implementation, but their executable fixes the role; no environment variable switches between them. Both support the internal `agent` and `ptc-guest` commands; only the gateway supports `oauth-worker`. These worker commands are started by the runtime, not separate services.

The Nix gateway package includes the static Web UI but no sandbox/browser runtime. The chat/node packages include srt and on-disk playwright-core but no Web UI; browser execution still needs Chromium/Chrome and optional ffmpeg. The compiled executables need no separate Bun installation. Keep all three roles on the same release/protocol version. The executable split is a packaging boundary, **not privacy isolation**: host accounts, filesystem permissions and the agent sandbox remain the security boundaries. See [migration guidance](docs/deploy/upgrades.md#migrating-from-the-single-executable).

## Documentation

Start with the [documentation index](docs/README.md). Current usage guides and architecture references are separate from [implementation plans](plans/README.md) and historical designs.

- [Agent configuration and sandbox](docs/guides/agent.md), [tools and workflows](docs/guides/tools.md)
- [Model backends and subscription logins](docs/guides/model-backends.md)
- [Browser](docs/guides/browser.md), [schedules and notifications](docs/guides/schedules.md), [chat projects](docs/guides/chat-projects.md)
- [Architecture references](docs/architecture/README.md), [deployment guides](docs/deploy/README.md)

## Validation

```sh
bun run check
```

Real-model smoke tests are deliberately separate because they require credentials and incur provider cost. The automated suite drives the real agent against a scripted fake OpenAI/Anthropic SSE server (end to end through gateway inference), and covers subscription logins, refresh and logout with fake OAuth providers, and the pi-ai adapter with an injected stream.

## Releases

See [CHANGELOG.md](CHANGELOG.md) for user-facing changes and migrations, and [release policy](docs/development/releasing.md) for version bumps, validation and publishing. `bun run version:check` verifies synchronized product versions and is part of `bun run check`.

## Nix integration

A reusable flake, package, development shell, and NixOS module are available in [`flake.nix`](flake.nix) and [`nix/`](nix/README.md):

```sh
nix develop
nix build .#pirc-gateway
nix build .#pirc-chat
nix build .#pirc-node
```

The NixOS module runs the gateway (`pirc.service`, as `pirc-gateway`) and, by default, a local node (`pirc-node.service`, as `pirc`) under two unprivileged service accounts, and can generate an nginx virtual host wired to an Authelia-compatible `auth_request` endpoint. The model providers (`services.pirc.models`), agent configuration (`services.pirc.agentConfig`), secret management, TLS certificate ownership, workspace permissions, and host names remain explicit inputs rather than unsafe defaults.

## Deployment

Step-by-step deployment guides (topology, gateway and node configuration, reverse proxy, NixOS module, macOS launchd nodes, secrets, upgrades, backups and troubleshooting) are in [`docs/deploy/`](docs/deploy/README.md). Applying them to a host, proxy authorization, and backup/restore drills remain the operator's responsibility: nothing in the repository ships a trust-all default.

## Acknowledgements

pirc started as a web client for [Pi](https://github.com/earendil-works/pi) and now runs its own agent loop, tools, sessions, and protocol. It still uses Pi's [pi-ai](https://github.com/earendil-works/pi/tree/main/packages/ai) package on the gateway, only for subscription logins, the model catalog, and the model transports behind them. Several built-in features (todo, background tasks, agent teams, observational memory) are ports of Pi extensions, and session titles follow oh-my-pi's title generator.
