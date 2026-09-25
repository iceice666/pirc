# pirc

A private, forward-authenticated web client for persistent coding-agent sessions. It ships as one executable: gateway, node, and a built-in agent (originally a client for [Pi](https://github.com/earendil-works/pi), which it has replaced).

It consists of:

- a **gateway** that browsers talk to: authentication, the session index, and routing;
- one or more **nodes**, one per machine with workspaces, which connect out to the gateway and run one built-in agent subprocess per session (speaking Pi-compatible JSONL RPC), plus side-panel shells;
- a responsive Svelte PWA.

The gateway never runs agents. On a single machine, run the gateway and a node side by side; across devices, each device runs a node that connects to one central gateway over a private VPN. See [`apps/gateway/README.md`](./apps/gateway/README.md) for setup and the current limitations.

## Security model

The gateway is intended to sit behind a trusted reverse proxy using an Authelia-style forward-auth flow.

- The gateway only accepts identity headers from explicitly configured proxy IP addresses.
- Authenticated user identities, `Host`, and `Origin` are checked against exact allowlists.
- There is no trust-all or unauthenticated production default.
- Nodes authenticate to the gateway with per-node secrets and connect outbound only; they listen on no port.
- Workspaces are allowlisted, but this is **not a sandbox**. The agent and its tools retain the operating-system permissions of the node's account.
- The web side panel can browse workspace files, show Git changes and history, and open interactive shells in the workspace. Shells run as the node's account, just like the agent's tools, and require holding session control; set `PIRC_TERMINALS=false` on the node to disable them.
- Keep the gateway on loopback or a private interface reachable only by the trusted proxy. Do not expose it through Tailscale Funnel or the public Internet.

## Requirements

- [Bun](https://bun.sh) 1.2 or newer (development/build only; the compiled `pirc` binary needs no runtime)
- An OpenAI Chat Completions or Anthropic Messages compatible provider, configured in `~/.config/.pirc/config.json` (see [Agent](#agent))
- A trusted forward-auth reverse proxy

## Development

```sh
bun install
cp apps/gateway/.env.example apps/gateway/.env
# Fill every security allowlist. Do not copy development values to production.
# The gateway and node take separate environments; see the file's two sections.
bun run dev        # gateway
bun run dev:node   # node, with PIRC_DAEMON_URL=ws://127.0.0.1:8787
bun run dev:web
```

The node's first workspace can point to this repository. See [`apps/gateway/README.md`](./apps/gateway/README.md) for configuration and API details, and [`apps/web/README.md`](./apps/web/README.md) for the client.

## Single binary

```sh
bun run build            # produces apps/gateway/dist/pirc
./apps/gateway/dist/pirc gateway   # browser API and routing
./apps/gateway/dist/pirc node      # agents and shells for this machine
./apps/gateway/dist/pirc agent --session-dir DIR   # one agent session over JSONL RPC (started by the node)
```

The binary embeds the Bun runtime, SQLite, and the agent, and does not depend on Node.js, Pi, or `node_modules`.

## Agent

The built-in agent (`apps/gateway/src/agent/`) is configured in two layers:

- **Global**: `~/.config/.pirc/config.json` (override the directory with `PIRC_CONFIG_DIR`). It holds providers (`openai-chat` / `anthropic-messages`), models, the default model, limits, features, and hooks. The global system prompt goes in `AGENTS.md` in the same directory. Reference API keys with `apiKeyEnv`, `apiKeyFile`, or `apiKeyCommand`.
- **Project**: `<workspace>/.pirc/config.json` can only add `allowedPaths`, `env`, `hooks`, and a `defaultModel`. `<workspace>/.pirc/AGENTS.md` is appended to the system prompt. The agent's file tools cannot write to `.pirc/`.

Hooks (`sessionStart`, `beforePrompt`, `beforeTool`, `afterTool`, `agentSettled`) are shell commands that receive JSON on stdin. A `beforeTool` hook can reject a tool call (exit 2) or rewrite its arguments.

Built-in tools and features:

- Tools: `read`/`write`/`edit`/`ls`/`find`/`grep`/`bash`.
- PTC code mode (`code`: TS/JS run in a subprocess that can call the other tools).
- `ask_user_question` and `todo`.
- Compaction with prompt-cache warming, and observational memory with `recall`.
- `background_task`.
- Agent teams (`agent_spawn` and friends; children are `pirc agent --headless` subprocesses).
- Session titles: sessions cannot be named when created; each one is named by the model from the first user message that describes work (greetings are skipped). It is a side request with no tools and no thinking, and it retries on later messages if it fails. A name you set by renaming always wins. Configure it in `features.sessionTitle`: `enabled` (default `true`), `model` (`{ "provider", "id" }`; defaults to the session's model, so a small, fast model saves cost), `prompt` (replaces the default system prompt), and `maxAttempts` (default `3`).

The design and milestones are in [`plans/single-binary-agent.md`](./plans/single-binary-agent.md).

## Validation

```sh
bun run check
```

Real-model smoke tests are deliberately separate because they require credentials and incur provider cost. The automated suite drives the real agent against a scripted fake OpenAI/Anthropic SSE server.

## Nix integration

A reusable flake, package, development shell, and NixOS module are available in [`flake.nix`](./flake.nix) and [`nix/`](./nix/README.md):

```sh
nix develop
nix build
```

The NixOS module runs the gateway (`pirc.service`) and, by default, a local node (`pirc-node.service`) under an unprivileged service account, and can generate an nginx virtual host wired to an Authelia-compatible `auth_request` endpoint. The agent configuration (`services.pirc.agentConfig`), secret management, TLS certificate ownership, workspace permissions, and host names remain explicit inputs rather than unsafe defaults.

## Known deployment boundary

The reusable Nix foundation is present, but applying it to a target host, TLS/proxy authorization, backup/restore drills, and physical-phone lock-screen acceptance still require an explicitly authorized M4 deployment.
