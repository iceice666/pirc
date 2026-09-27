# pirc

A private, forward-authenticated web client for persistent coding-agent sessions. It ships as one executable: gateway, node, and its own built-in agent.

It consists of:

- a **gateway** that browsers talk to: authentication, the session index, and routing;
- one or more **nodes**, one per machine with workspaces, which connect out to the gateway and run one built-in agent subprocess per session (over a JSONL RPC on stdin/stdout), plus side-panel shells;
- a responsive Svelte PWA.

The gateway never runs agents or tools; it only runs model requests on their behalf (see [Agent](#agent)). On a single machine, run the gateway and a node side by side; across devices, each device runs a node that connects to one central gateway over a private VPN. See [`apps/gateway/README.md`](./apps/gateway/README.md) for setup and the current limitations.

## Security model

### Threat model

pirc is a **single-user, self-hosted tool for a trusted private network**, such as your own VPN or LAN. The operator, gateway, paired nodes, and their operating-system accounts belong to one trust domain. One user may have multiple nodes, devices, and concurrent sessions.

- Model backend settings and credentials are deployment-wide settings for that operator. pirc is not a multi-tenant service: user allowlists and session ownership do not establish isolation between mutually untrusted users, and there is no separate administrator/user role model.
- Compromised gateway or node hosts, malicious processes running as the same OS account, and hostile node operators are outside the protection boundary. Agents, tools, and subprocesses are **not sandboxes**; storing credentials on the gateway alone does not isolate them from processes that can access the same files or environment.
- Repository content, web pages, model output, provider errors, and browser input remain untrusted data. A trusted network does not make that content authorization to run commands or change settings.
- The security goals are to prevent unintended exposure and unauthorized access, cross-site requests, and accidental credential disclosure. Authentication, request validation, secret-safe handling, and resource/lifecycle limits still matter on a private network. Multi-user deployment or public exposure requires a new threat-model review.

### Deployment safeguards

The gateway is intended to sit behind a trusted reverse proxy using an Authelia-style forward-auth flow. The private-network assumption does not disable the following safeguards:

- The gateway only accepts identity headers from explicitly configured proxy IP addresses.
- Authenticated user identities, `Host`, and `Origin` are checked against exact allowlists.
- There is no trust-all or unauthenticated production default.
- Nodes authenticate to the gateway with per-node secrets and connect outbound only; they listen on no port.
- Workspaces are allowlisted, but this is **not a sandbox**. The agent and its tools retain the operating-system permissions of the node's account.
- The web side panel can browse workspace files, show Git changes and history, and open interactive shells in the workspace. Shells run as the node's account, just like the agent's tools, and require holding session control; set `PIRC_TERMINALS=false` on the node to disable them.
- Keep the gateway on loopback or a private interface reachable only by the trusted proxy. Do not expose it through Tailscale Funnel or the public Internet.

## Requirements

- [Bun](https://bun.sh) 1.2 or newer (development/build only; the compiled `pirc` binary needs no runtime)
- A model backend, configured on the gateway: a subscription login (Claude Pro/Max, GitHub Copilot, ChatGPT/Codex) or an API-key/custom endpoint from the web **Settings**, and/or `models.json` (see [Agent](#agent))
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

The binary embeds the Bun runtime, SQLite, and the agent, and does not depend on Node.js or `node_modules`.

## Agent

The built-in agent (`apps/gateway/src/agent/`) is configured in three layers:

- **Models (gateway)**: model backends and their credentials live only on the gateway, which also **runs every model request**. Agents stay on their nodes and send requests over the node link (via a private, token-protected Unix socket from agent to node); the gateway resolves the backend, calls the model, and streams the reply back. Nodes and agents receive only a secret-free model catalog: no API key, OAuth token, endpoint URL or header. Because credentials are resolved per request, a changed key, a token refresh, a new login or a logout reaches running sessions on their next request; a settings change cancels requests in flight. Backends come from two sources:
  - **Web Settings → Model backends** (`$PIRC_STATE_DIR/backends/settings.json`, mode 0600, written atomically): every subscription login built into the pinned [pi-ai](https://github.com/earendil-works/pi/tree/main/packages/ai) version (`@mariozechner/pi-ai@0.73.1`: **Anthropic Claude Pro/Max**, **GitHub Copilot**, **ChatGPT Plus/Pro (Codex)**), API-key or keyless custom endpoints (`openai-completions`, `openai-responses`, `anthropic-messages`, legacy `openai-chat`), and the default model. See [Subscription logins](#subscription-logins).
  - **`models.json`** (`PIRC_MODELS_FILE`, default `$PIRC_CONFIG_DIR/models.json`, i.e. `~/.config/.pirc/models.json`): `providers` and `defaultModel`, read-only in the web UI. Reference API keys with `apiKeyEnv`, `apiKeyFile`, or `apiKeyCommand` (resolved on the gateway). A file backend wins over a web backend with the same ID; the web default model wins over the file default. Send the gateway `SIGHUP` to reload the file. An invalid file is fatal at startup, and on reload it is logged and ignored.

  Endpoints must be reachable from the gateway (a model server that only listens on a node's `localhost` is not). Nodes have no provider settings of their own; `providers` and `defaultModel` in a node's `config.json` are ignored with a warning.

- **Node**: `~/.config/.pirc/config.json` on each node (override the directory with `PIRC_CONFIG_DIR`) holds limits, features, hooks, `env`, and `allowedPaths`. The global system prompt goes in `AGENTS.md` in the same directory.
- **Project**: `<workspace>/.pirc/config.json` can only add `allowedPaths`, `env`, `hooks`, and a `defaultModel` (which must name one of the gateway's models). `<workspace>/.pirc/AGENTS.md` is appended to the system prompt. The agent's file tools cannot write to `.pirc/`.

Hooks (`sessionStart`, `beforePrompt`, `beforeTool`, `afterTool`, `agentSettled`) are shell commands that receive JSON on stdin. A `beforeTool` hook can reject a tool call (exit 2) or rewrite its arguments.

Built-in tools and features:

- Tools: `read`/`write`/`edit`/`ls`/`find`/`grep`/`bash`.
- PTC code mode (`code`: TS/JS run in a subprocess that can call the other tools).
- `ask_user_question` and `todo`.
- Session goals (`create_goal`/`get_goal`/`update_goal`, `/goal`): one persisted completion objective per session. Once a run stops cleanly, the agent starts a continuation round on its own, and keeps doing so until the model marks the goal `complete` or `blocked`, the round limit is used up, or you pause it. An aborted or failed run pauses the goal. Only a user request may create, edit, pause, or resume a goal. Updates must quote the goal's current revision. `blocked` is rejected until `minBlockedRounds` rounds have passed. After the agent restarts, an active goal waits for `/goal resume`. The web client docks the goal above the composer with pause and resume buttons. Configure it in `features.goal`: `enabled` (default `true`), `minBlockedRounds` (default `3`), and `defaultMaxRounds` (the limit for goals created without one; unlimited by default). Team children never get goals.
- Compaction with prompt-cache warming, and observational memory with `recall`.
- `background_task`: shell jobs with process-group cleanup and one coalesced wakeup per batch of completions. `tty: true` runs a job on a pseudo-terminal so `write` can send it input. `notify_on` (a regular expression, set on start or later with `monitor`) wakes the agent with matching output lines, for dev servers, watchers, or log tails.
- `subagent`: a one-shot delegate with a fresh context. It runs one task and returns only its final report, then exits. It runs in the foreground (the tool call waits) or with `background: true` (the report is delivered once when it finishes). Subagents get no team tools and cannot spawn further agents.
- Agent teams: `agent_spawn` starts persistent collaborators that message each other (`agent_send`/`ask`/`reply`/`wait`), share notes (`board_*`), and coordinate on a shared task board (`task_create`/`list`/`get`/`update`). The board has claims, owners, dependencies, and revision checks, and tasks are released when their owner stops. A teammate reports its last answer to the parent once each time it goes idle. Children are `pirc agent --headless` subprocesses.
- Team completion: after a clean model turn, the parent stays in the same run while workers are active, displaying “Waiting for team” without polling the LLM. Idle persistent teammates do not block completion; parent-directed questions return control to the model. `limits.completionWaitMs` (default 60,000; maximum 86,400,000) bounds each wait: timeout adds an explicit pending-work notice and lets the model report partial progress, without stopping workers. Already-streamed text is not buffered or retracted. Pending team reports enter context together at tool boundaries (bounded batches); a direct `agent_inbox` result suppresses duplicate notifications only for fully returned event IDs. Truncated previews and inbox reads hidden inside `code` do not count as full reads. Stop suspends automatic team wakeups and retains late reports for the next user turn; it does not stop workers (`agent_stop` or `/team stop` does). There is no automatic team recovery after a process restart.
- Kind presets in `features.agentTeam.kinds` (for subagents and teammates) can set `model`, `thinking`, and a `tools` allowlist, for example `{ "explorer": { "tools": ["read", "ls", "find", "grep"] } }`. Teammates always keep their coordination tools. `features.agentTeam.limit` (default 4) caps live teammates and `subagentLimit` (default 4) caps running subagents.
- Session titles: sessions cannot be named when created; each one is named by the model from the first user message that describes work (greetings are skipped). It is a side request with no tools and no thinking, and it retries on later messages if it fails. A name you set by renaming always wins. Configure it in `features.sessionTitle`: `enabled` (default `true`), `model` (`{ "provider", "id" }`; defaults to the session's model, so a small, fast model saves cost), `prompt` (replaces the default system prompt), and `maxAttempts` (default `3`).
- Auto mode: a check that runs before every `bash` command, `background_task` start or `write`, and the same calls made from `code`. First, static rules sort the action into read-only, workspace write, or dangerous. Dangerous actions include deleting a workspace root or anything outside it, `git reset --hard`/`clean -f`/force push, publishing or deploying, touching credentials, changing system or global configuration, and piping a download into a shell. Any action the rules cannot judge goes to a classifier model, which sees the action and the user's last few requests but never tool output. A dangerous action needs your confirmation; headless agents (teammates and subagents) are refused instead. Anything that may write takes the node's write lease first, so another session writing the same worktree makes the call fail with `workspace_busy`. When no classifier model answers, an unclear action counts as a write. Configure it in `features.autoMode`: `enabled` (default `true`; `false` keeps only the write-lease decision), `useModel` (default `true`), `model` and `fallbackModels` (default to `features.observationalMemory`'s, then the session model), and `timeoutMs` (default `30000`). This is not a sandbox: approved or misclassified commands still run with the agent account's permissions.

### Subscription logins

Open **Settings → Model backends** and choose **Log in**. The gateway runs pi-ai's login flow in an isolated, time-limited subprocess and shows its steps in the browser: the authorization link and instructions, device codes, questions (such as a GitHub Enterprise domain), and progress. Nothing needs a CLI on a node.

- **Claude Pro/Max** and **ChatGPT/Codex** use fixed `localhost` redirect URLs. When your browser is not on the gateway machine, the final redirect page fails to load; copy that complete `http://localhost:…` URL from the address bar and paste it into the login card. It must carry the state from this login. Do not expose a callback port.
- **GitHub Copilot** uses a device code. pi-ai's login also **enables the policy for every GitHub Copilot model it knows** on your account, so the UI requires explicit consent first. Some models may still need enabling in Copilot itself.
- Tokens are refreshed on the gateway shortly before they expire, once for concurrent requests. **Log out** deletes the gateway's saved credentials and blocks new requests; it does not revoke the account upstream or recall content already sent.
- pi-ai's model catalog is not proof that your plan includes a model, and a built-in login is not a statement about each service's terms for third-party clients: check them yourself. Real logins and paid calls are not part of the automated tests.

The design and milestones are in [`plans/single-binary-agent.md`](./plans/single-binary-agent.md); the backend-login research is in [`plans/pi-web-backend-auth-research.md`](./plans/pi-web-backend-auth-research.md).

## Validation

```sh
bun run check
```

Real-model smoke tests are deliberately separate because they require credentials and incur provider cost. The automated suite drives the real agent against a scripted fake OpenAI/Anthropic SSE server (end to end through gateway inference), and covers subscription logins, refresh and logout with fake OAuth providers, and the pi-ai adapter with an injected stream.

## Nix integration

A reusable flake, package, development shell, and NixOS module are available in [`flake.nix`](./flake.nix) and [`nix/`](./nix/README.md):

```sh
nix develop
nix build
```

The NixOS module runs the gateway (`pirc.service`) and, by default, a local node (`pirc-node.service`) under an unprivileged service account, and can generate an nginx virtual host wired to an Authelia-compatible `auth_request` endpoint. The agent configuration (`services.pirc.agentConfig`), secret management, TLS certificate ownership, workspace permissions, and host names remain explicit inputs rather than unsafe defaults.

## Known deployment boundary

The reusable Nix foundation is present, but applying it to a target host, TLS/proxy authorization, backup/restore drills, and physical-phone lock-screen acceptance still require an explicitly authorized M4 deployment.

## Acknowledgements

pirc started as a web client for [Pi](https://github.com/earendil-works/pi) and now runs its own agent loop, tools, sessions, and protocol. It still uses Pi's [pi-ai](https://github.com/earendil-works/pi/tree/main/packages/ai) package on the gateway, only for subscription logins, the model catalog, and the model transports behind them. Several built-in features (todo, background tasks, agent teams, observational memory) are ports of Pi extensions, and session titles follow oh-my-pi's title generator.
