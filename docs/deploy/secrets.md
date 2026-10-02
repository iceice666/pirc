# Secrets

What secrets a pirc deployment holds, where each one lives, and what must never happen to it. The threat model is a single operator on a private network; the goal here is to keep secrets out of world-readable places and away from the agents.

## Inventory

| Secret                                     | Held by          | Where                                                                                           | Who else sees it                                                                                                                                                   |
| ------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node tokens (`PIRC_NODE_TOKENS`)           | gateway          | gateway environment                                                                             | Each node has its own one (`PIRC_NODE_TOKEN`). Never a browser or an agent.                                                                                        |
| Node token (`PIRC_NODE_TOKEN`)             | node             | node environment / systemd credential                                                           | Stripped from agents' and shells' environments; a process running as the node account can still read the file, so keep it out of the sandbox's reads (`denyRead`). |
| Provider API keys                          | gateway          | `models.json` references (`apiKeyEnv`/`apiKeyFile`/`apiKeyCommand`) or `backends/settings.json` | Nobody: nodes get a catalog without keys or endpoints.                                                                                                             |
| Subscription OAuth tokens                  | gateway          | `$PIRC_STATE_DIR/backends/settings.json` (0600)                                                 | Nobody. Refreshed by the gateway.                                                                                                                                  |
| `EXA_API_KEY`                              | gateway          | gateway environment                                                                             | Nobody; searches run on the gateway.                                                                                                                               |
| VAPID private key                          | gateway          | `$PIRC_STATE_DIR/vapid.json` or environment                                                     | Nobody.                                                                                                                                                            |
| Device tokens (`pirc_dev_…`)               | gateway (hash)   | `device_tokens` table, SHA-256 only                                                             | The phone, in its Keystore. Shown once at pairing.                                                                                                                 |
| Forward-auth session cookies               | proxy / Authelia | outside pirc                                                                                    | The browser.                                                                                                                                                       |
| Node ↔ agent inference token              | node             | random per start, passed to agents                                                              | Agents (it only lets them use the gateway's models as their own session).                                                                                          |
| Agent-facing credentials (`GITHUB_TOKEN`…) | node, by choice  | agent config `env`, or node environment named in `PIRC_AGENT_ENV_ALLOW`                         | **Agents.** Scope them narrowly; they are inside the sandbox's reach by design.                                                                                    |

## Generating

```sh
openssl rand -base64 36        # a node token (48 chars, ≥ 32 required)
```

The gateway rejects tokens shorter than 32 characters and duplicated tokens. The NixOS module generates the local node's token itself (`/var/lib/pirc/daemon/local-node-token`, 0600, owned by the gateway account) and merges it into `PIRC_NODE_TOKENS` at start.

## Placement rules

- **Never in the Nix store**: not in `services.pirc.models` as a literal `apiKey`, not in `services.pirc.environment`, not in `agentConfig.env`, not in a workspace's `defaults`. Use `environmentFile` (systemd `KEY=value`), `apiKeyFile`, or `apiKeyCommand`.
- **Never in Git**: `.env`, `DEPLOY.md`-style host notes with tokens, `agent.env`. The repository's `.gitignore` covers `.env*` and `DEPLOY.md`; check yours.
- **Gateway secrets are the gateway account's**: on NixOS the gateway runs as `pirc-gateway` and the node as `pirc`, so an `apiKeyFile` must be readable by `pirc-gateway` (sops-nix: `owner = "pirc-gateway"`), and the node never receives the gateway's `environmentFile`.
- **Node secrets stay out of agents' reads**: the sandbox denies `PIRC_STATE_DIR` and the systemd credentials directory by default; if the node's env file lives elsewhere (macOS: `~/.local/pirc-node/agent.env`), add that directory to `sandbox.filesystem.denyRead`.
- **Logs**: the gateway logs classification only for provider errors, never bodies or tokens. Do not raise the log level of a proxy so that it logs `Authorization` headers.

## Rotation

| Secret       | How                                                                                                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node token   | Change it on both sides, restart the gateway then the node. Sessions survive: they live on the node. A leaked node token allows using the gateway's models and acting as that node's sessions until rotated.      |
| Provider key | `models.json`: edit the referenced file/env and `SIGHUP` the gateway (or restart when using `apiKeyEnv`). Web backends: edit in **Settings → Model backends**; running sessions pick it up on their next request. |
| Subscription | **Log out** then **Log in** again in the web UI. Logging out deletes the saved credentials; it does not revoke them upstream.                                                                                     |
| Device token | Revoke in **Settings → Devices**; open WebSockets close with `4401` at once. Pair again.                                                                                                                          |
| VAPID pair   | Delete `vapid.json` (or change the environment) and restart; every browser and phone must re-enable notifications.                                                                                                |
| Identity     | Removing a user from `PIRC_ALLOWED_USERS` on the gateway **and every node** cuts them off on the next request; also remove them from the proxy's auth.                                                            |
