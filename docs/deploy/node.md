# Chat and coding node configuration

`pirc-node` and `pirc-chat` read their configuration from environment variables (`apps/gateway/src/config.ts`, `loadNodeConfig`) plus a per-node agent config directory. Run one node per machine that has workspaces, as an unprivileged account that owns exactly the repositories, credentials and tools the agents should reach. Never run a node as root.

Sandbox and browser settings have their own page: [Sandbox and browser](./sandbox-and-browser.md).

## Identity and link

| Variable                             | Required | Default | Meaning                                                                                                                                               |
| ------------------------------------ | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PIRC_NODE_ID`                       | yes      | —       | `[a-zA-Z0-9_-]{1,100}`; must be a key of the gateway's `PIRC_NODE_TOKENS`. Workspaces show as `<nodeId>:<workspaceId>`.                               |
| `PIRC_NODE_TOKEN`                    | yes      | —       | The matching secret (≥ 32 characters).                                                                                                                |
| `PIRC_DAEMON_URL`                    | yes      | —       | The gateway's origin, e.g. `wss://pirc.example.ts.net`; the node appends `/node/connect`. Plain `ws://` only for `127.0.0.1`, `[::1]` or `localhost`. |
| `PIRC_ALLOW_INSECURE_NODE_TRANSPORT` | no       | `false` | Development only: allow `ws://` off loopback.                                                                                                         |
| `PIRC_ALLOWED_USERS`                 | yes      | —       | Users this node acts for; normally the gateway's list. The node re-checks every relayed request against it.                                           |

## State

| Variable                    | Default                   | Meaning                                                                                                     |
| --------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `PIRC_STATE_DIR`            | `./.state`                | Sessions, uploads, SQLite, browser profiles, workspace memory, chat directories. Set it explicitly.         |
| `PIRC_DATABASE_PATH`        | `$STATE/gateway.sqlite`   | The node's own SQLite (sessions, runs, interactions, uploads, workspaces).                                  |
| `PIRC_SESSIONS_DIR`         | `$STATE/sessions`         | One directory per session holding `session.jsonl` (the conversation source of truth).                       |
| `PIRC_UPLOADS_DIR`          | `$STATE/uploads`          | Uploaded files.                                                                                             |
| `PIRC_WORKSPACE_MEMORY_DIR` | `$STATE/workspace-memory` | Per-repository memory ledgers written by agents; mirrored to the gateway (without paths) for the assistant. |
| `PIRC_MEMORY_MIRROR_MS`     | `30000`                   | How often new workspace memory is mirrored.                                                                 |

The state directory is also the natural `HOME` of the node account (build caches land there). Under the sandbox, agents cannot read it except their own session directory and their workspace's memory ledger.

## Workspaces

| Variable          | Default | Meaning                                                                                                                                                        |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PIRC_WORKSPACES` | `[]`    | JSON array of `{ "id"?, "path", "displayName"?, "defaults"? }`. `path` may start with `~/`. IDs default to `workspace-<n>`, names to the directory's basename. |

An empty list is fine: the web's **Add workspace** (`POST /api/workspaces` with `{ nodeId, path, displayName }`) adds one to an online node. The node persists it in its database and advertises it again after every reconnect. Web-added paths must already exist and resolve (symlinks followed) **inside the node account's home**; `PIRC_WORKSPACES` has no such restriction, so use it for `/srv`-style paths.

Workspaces are an execution allowlist: sessions only ever run in a listed directory. Several sessions may share a workspace; concurrent writes are serialized by the node's write broker (a second session gets `workspace_busy` until the first run ends).

## The chat node

Run `pirc-chat` for assistant chats/projects, or `pirc-node` for coding workspaces. Both use the same node/agent implementation; their role is fixed by the executable, not an environment switch. `pirc-chat` requires an empty `PIRC_WORKSPACES` and refuses web-added directory workspaces. Run at most one chat node, on an always-on host. On NixOS, `services.pirc.chat = true` selects `pirc-chat` for the local runner.

The chat node keeps every chat workspace under `$STATE/chat/<workspaceId>/` (the top-level `chats`, and each project), including each project's `instructions.md`. See [`docs/chat-projects.md`](../chat-projects.md).

## Agent process

Both node executables support the internal `agent` and `ptc-worker` commands and re-execute themselves for those workers. These are not separately deployed executables. Keep the gateway and both node roles on the same release/protocol version ([Upgrades](./upgrades.md)).

| Variable                                          | Default           | Meaning                                                                                               |
| ------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| `PIRC_AGENT_COMMAND`                              | this binary       | Executable started per session. Only set it to run a different build of the agent.                    |
| `PIRC_AGENT_ARGS`                                 | `["agent"]`       | JSON array placed before the agent flags.                                                             |
| `PIRC_CONFIG_DIR`                                 | `~/.config/.pirc` | The agent config directory (below).                                                                   |
| `PIRC_TERMINALS`                                  | `true`            | Side-panel shells (run as the node account in the workspace, outside the sandbox).                    |
| `PIRC_TERMINAL_SHELL`                             | `$SHELL`          | Shell for those terminals.                                                                            |
| `PIRC_AGENT_ENV_ALLOW`                            | —                 | Comma-separated variables of the node's environment passed on to agents anyway (e.g. `GITHUB_TOKEN`). |
| `PIRC_LEASE_TTL_MS`                               | `30000`           | Control-lease heartbeat timeout.                                                                      |
| `PIRC_INTERACTION_TTL_MS`                         | `3600000`         | How long an unanswered question stays pending.                                                        |
| `PIRC_RPC_MAX_LINE_BYTES`                         | `1048576`         | Node ↔ agent JSONL line limit.                                                                       |
| `PIRC_SHUTDOWN_GRACE_MS`                          | `5000`            | Time agents get to exit on `SIGTERM` before being killed.                                             |
| `PIRC_EVENT_BUFFER_SIZE`, `PIRC_UPLOAD_MAX_BYTES` | as gateway        | Keep them equal to the gateway's.                                                                     |

Everything the node starts (agents and their tools, approved host commands, side-panel terminals and git, Chromium, ffmpeg) gets an **allowlisted** environment (`apps/gateway/src/node/secrets.ts`): `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`/`LC_*`, `TERM`/`COLORTERM`/`TERM_PROGRAM*`, `TZ`, `TMPDIR`, `PWD`, `EDITOR`/`VISUAL`/`PAGER`, `XDG_*`, Nix and CA-certificate variables, `LOCALE_ARCHIVE`, display variables, a few toolchain directories (`CARGO_HOME`, `GOPATH`, `JAVA_HOME`, …) and non-secret `PIRC_*`. Everything else is dropped, including `PIRC_NODE_TOKEN` and every `PIRC_*TOKEN*`/`*SECRET*`/`*KEY*`/`*PASSWORD*`, `EXA_API_KEY`, provider keys (`ANTHROPIC_API_KEY`, …), `AWS_*`, `GH_TOKEN`/`GITHUB_TOKEN`, `SSH_AUTH_SOCK`, `GIT_*` and `*_PROXY` (inside srt the sandbox sets its own proxy). Side-panel terminals additionally keep `SSH_AUTH_SOCK`, since only the human types there; their login shell re-reads the user's profile.

To give agents a credential on purpose (a `GITHUB_TOKEN` for the agent's own `gh`), either put it in the agent config's `env`, or keep it in the node's environment and name it in `PIRC_AGENT_ENV_ALLOW=GITHUB_TOKEN`. pirc's own secrets cannot be passed this way.

## The agent config directory

`$PIRC_CONFIG_DIR` holds node-wide agent settings. Nothing in it is synced from the gateway; copy it to each node.

```
~/.config/.pirc/
├── config.json     limits, features, hooks, env, allowedPaths, sandbox
├── AGENTS.md       global coding rules (optional; not read by chats)
├── SOUL.md         global chat persona (optional; never read by coding sessions)
├── CHAT.md         global chat rules (optional; replaces AGENTS.md for chats)
├── roles/          roles: <name>.md, front matter + instructions (optional)
└── skills/         Agent Skills: <name>/SKILL.md (optional)
```

A role (`roles/<name>.md`) is what subagents, teammates and delegations start in; agents pick a role, never a model. Built-in `general` is followed by node-wide `$PIRC_CONFIG_DIR/roles/`, then workspace `.pirc/roles/`; a later file replaces the entire earlier role with the same filename. Every front matter key is optional:

```markdown
---
description: Read-only code investigation
model: [anthropic/claude-haiku-*, '*/gpt-5-mini']
thinking: low
tools: [read, ls, find, grep]
---

Do not edit files. Cite file:line evidence and mark anything unverified.
```

`model` takes one `provider/model-id` or a list of up to 20 patterns, in order of preference; `*` matches within a provider or model id (`*/gpt-5`, `openai/*`). Each pattern expands in gateway catalog order, with duplicates removed. The agent starts on the first match. On a retryable failure before any text is emitted (for example a rate limit, overload, HTTP 408/409/5xx, timeout or dropped connection), it moves immediately to the next match and stays there for the session; the final candidate uses normal in-place retries. If you choose a model outside the role's expanded list, role fallback is disabled. A role with no matching models cannot be started.

`config.json` (every key optional):

```json
{
  "limits": {
    "bashTimeoutMs": 120000,
    "ptcTimeoutMs": 120000,
    "toolOutputBytes": 51200,
    "maxTurns": 200,
    "completionWaitMs": 60000
  },
  "features": {
    "observationalMemory": { "model": { "provider": "openai", "id": "gpt-5-mini" } },
    "sessionTitle": { "model": { "provider": "openai", "id": "gpt-5-mini" } },
    "autoMode": {
      "enabled": true,
      "useModel": true,
      "deny": ["^just switch\\b", "/nixos-rebuild/i"]
    },
    "agentTeam": { "limit": 4, "subagentLimit": 4 },
    "browser": { "enabled": true },
    "webSearch": { "enabled": true },
    "schedules": { "enabled": true },
    "skills": { "enabled": true },
    "goal": { "enabled": true, "minBlockedRounds": 3 }
  },
  "hooks": {
    "beforeTool": [
      { "command": "/usr/local/bin/pirc-guard", "matcher": "bash", "timeoutMs": 10000 }
    ]
  },
  "env": { "GIT_AUTHOR_NAME": "pirc agent" },
  "allowedPaths": ["~/shared-notes"],
  "sandbox": { "network": { "allowedDomains": ["api.example.com"] } }
}
```

- `providers` and `defaultModel` do **not** belong here any more; they are ignored with a warning (models live on the [gateway](./gateway.md#model-backends)). Legacy `roles` and `features.agentTeam.kinds` JSON settings are also ignored with a startup warning; move them to `$PIRC_CONFIG_DIR/roles/<name>.md`.
- `features.*` is documented in the [top-level README](../../README.md#agent); `features.observationalMemory` in [`docs/architecture-observational-memory.md`](../architecture-observational-memory.md). Each feature object is validated as a whole: an invalid value resets that feature to its defaults.
- Hooks (`sessionStart`, `beforePrompt`, `beforeTool`, `afterTool`, `agentSettled`) receive JSON on stdin; a `beforeTool` hook exits `2` to block a call. They run inside the sandbox.
- `features.autoMode.deny`: regular expressions (or `/re/flags`) for commands you never want run without asking. A match makes the action dangerous: the agent must ask you, and teammates and subagents are refused. It is checked before anything else, also when auto mode is off, against the raw command, each unquoted command, the package.json scripts, Makefile/justfile recipes and shell scripts a command runs, tty input to background tasks and `code` scripts. An invalid pattern is matched as literal text and the session shows a warning.
- `allowedPaths` widens the file tools' write roots and the sandbox's writable paths (node config only; a project's `allowedPaths` never widens the sandbox).
- Skills: `$PIRC_CONFIG_DIR/skills/<name>/SKILL.md` reaches every session on the node; `~/.agents/skills/` of the node account is read too (lowest precedence); `<workspace>/.pirc/skills/` is per project. Programs a skill runs must be on the node's `PATH`.

Workspaces may add `<workspace>/.pirc/config.json` with only `allowedPaths`, `env`, `hooks` and `defaultModel`, plus `<workspace>/.pirc/AGENTS.md` and role files in `<workspace>/.pirc/roles/` (a workspace role may replace a node role of the same name; role lists say so). A repository's `hooks`, `env` and `allowedPaths` are **ignored until you trust them** in the workspace's Settings page, which shows exactly what they contain; trust is tied to their content, so any later change to them is ignored again until you trust it anew, and sessions say when they were ignored. Teammates and subagents read the project config from the workspace root only, and their working directory must stay inside the workspace or its allowed paths. Agents cannot write any `.pirc/` directory in the workspace.

## Signals and lifecycle

- `SIGTERM`: closes the link, gives agents `PIRC_SHUTDOWN_GRACE_MS` to exit, then exits. Runs in progress become `interrupted` on the next start.
- On reconnect after a gateway restart, the node re-registers its workspaces, and the gateway bumps the event epoch so clients refetch snapshots.
- A node whose protocol version differs from the gateway's is closed with code `4426` and logs `daemon rejected this node protocol version`; see [Upgrades](./upgrades.md).

## Minimal environment file

```sh
PIRC_NODE_ID=workstation
PIRC_NODE_TOKEN=…            # ≥ 32 random characters, matching the gateway's PIRC_NODE_TOKENS
PIRC_DAEMON_URL=wss://pirc.example.ts.net
PIRC_ALLOWED_USERS=alice@example.com
PIRC_STATE_DIR=/var/lib/pirc-node
PIRC_CONFIG_DIR=/etc/pirc/agent
PIRC_WORKSPACES=[]
```

Keep the file readable by the node account only (`0600`), and list its directory in `sandbox.filesystem.denyRead` when it sits outside `PIRC_STATE_DIR` ([Sandbox and browser](./sandbox-and-browser.md)).

Chat nodes read global `SOUL.md` (persona) then the fixed environment description and `CHAT.md` (rules), never `AGENTS.md`. Coding nodes never read SOUL/CHAT. Each chat file is capped at 8000 characters. Settings → Assistant edits these same node-local files when writable; symlinks and Nix store files are read-only. Empty Soul falls back to the built-in identity. Changes apply at the next agent start. The gateway persistently binds one chat node ID; stop the old node and release its binding in Settings → Assistant before replacing it.
