# Troubleshooting

Symptoms first, then the cause and the command that confirms it. Log locations: gateway and node write JSON lines to stdout/stderr (`journalctl -u pirc -u pirc-node`, or the launchd `agent.log`/`agent.err`).

## Start-up

| Symptom                                                                     | Cause and fix                                                                                                           |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PIRC_TRUSTED_PROXIES / PIRC_ALLOWED_* must explicitly name at least one …` | A required allowlist is empty. There is no permissive default; set it ([Gateway](./gateway.md)).                        |
| `The gateway requires PIRC_NODE_TOKENS to accept at least one node`         | `PIRC_NODE_TOKENS` is missing or `{}`. On NixOS this means the local node is disabled and no remote node is configured. |
| `Node tokens must be unique` / a token shorter than 32 characters           | Regenerate with `openssl rand -base64 36`.                                                                              |
| Gateway rejects `PIRC_WORKSPACES`                                           | Node variables in the gateway's environment. Split the gateway and node environments.                                   |
| `Node transport requires wss:// off loopback`                               | `PIRC_DAEMON_URL` is `ws://` to a remote host. Use `wss://` through the proxy.                                          |
| `PIRC_WORKSPACES must be empty on the chat node`                            | `pirc-chat` with workspaces. Move the repositories to another node.                                                     |
| `PIRC_DEVICE_TOKEN_IDLE_DAYS cannot exceed PIRC_DEVICE_TOKEN_MAX_DAYS`      | Fix the two values.                                                                                                     |
| `PIRC_TIMEZONE: unknown time zone` / `PIRC_VAPID_SUBJECT must be …`         | Use an IANA zone; a `mailto:` or `https:` subject.                                                                      |
| The gateway exits on an invalid `models.json`                               | The file is validated at start (unknown keys, bad `api`, unresolvable key reference). Fix it; a later reload only logs. |
| NixOS: `pirc.service` fails reading `apiKeyFile`                            | The file is owned by `pirc`, not `pirc-gateway`. Set the secret's owner ([NixOS](./nixos.md)).                          |

## Nodes and the link

| Symptom                                                                   | Cause and fix                                                                                                                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node log: `daemon rejected this node protocol version`; close code `4426` | Gateway and node builds differ in `NODE_PROTOCOL_VERSION`. Upgrade both ([Upgrades](./upgrades.md)).                                                        |
| Node closes with `4401 invalid node credentials`                          | `PIRC_NODE_ID`/`PIRC_NODE_TOKEN` do not match an entry in the gateway's `PIRC_NODE_TOKENS`. Compare both sides; watch for trailing whitespace in env files. |
| Node gets an HTTP page / redirect instead of a WebSocket                  | The proxy applies forward auth to `/node/connect`. Add the bypass route ([Reverse proxy](./reverse-proxy.md)).                                              |
| Node connects and drops every ~minute                                     | A proxy read timeout on the WebSocket. Raise it (`proxy_read_timeout 1h` in nginx).                                                                         |
| `GET /api/nodes` lacks a node; sessions answer `503 node_offline`         | The node is down, asleep, or on a stale token. Check its process and log; a laptop asleep is offline by design.                                             |
| Agent says `Gateway inference is unavailable`                             | The node lost its link mid-request. Model calls go through the gateway; they resume once the node reconnects.                                               |
| Workspace add fails: `Workspace must stay within the node home directory` | Web-added paths must resolve inside the node account's home. Use `PIRC_WORKSPACES` (or `services.pirc.workspaces`) for other paths.                         |
| NixOS: workspace under `/home` "does not exist"                           | `ProtectHome=true` hides `/home` from the services. Use `/srv` or override the hardening.                                                                   |

## Authentication

| Symptom                                                            | Cause and fix                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 unauthenticated: Request did not arrive from a trusted proxy` | The gateway saw a peer address not in `PIRC_TRUSTED_PROXIES` (e.g. the proxy connects over IPv6 `::1` and only `127.0.0.1` is listed; or a Docker network address).                                               |
| `401 … Trusted identity header is missing`                         | The proxy passed forward auth but did not set `PIRC_IDENTITY_HEADER`; check the `auth_request_set`/`authResponseHeaders` mapping (Authelia returns `Remote-User`).                                                |
| `403` for a logged-in user                                         | The identity is not in `PIRC_ALLOWED_USERS` (gateway) — or, for a session route, not in that **node's** `PIRC_ALLOWED_USERS`.                                                                                     |
| Browser: WebSocket or `POST` refused, `Origin`/`Host` error        | `PIRC_ALLOWED_ORIGINS`/`PIRC_ALLOWED_HOSTS` do not exactly match what the browser sends (scheme, port). The proxy must pass `Host` and `Origin` through unchanged.                                                |
| Phone gets the login page                                          | The proxy applies forward auth to `Authorization: Bearer pirc_dev_…` requests. Add the device-token router/branch.                                                                                                |
| Phone gets `401` although paired                                   | The token expired (idle/max days), was revoked, or the proxy forwards the identity header along with the bearer (the gateway refuses both together). The app unpairs on `401`; pair again after fixing the proxy. |
| Phone gets `403` on Settings → Model backends                      | Expected: device tokens cannot manage devices or backends.                                                                                                                                                        |

## Agents

| Symptom                                                                           | Cause and fix                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session header shows **Not sandboxed**                                            | srt missing, `PIRC_SANDBOX=off`, or the probe failed (Linux: user namespaces refused; check `kernel.apparmor_restrict_unprivileged_userns`, the unit's hardening). The warning text names the reason ([Sandbox](./sandbox-and-browser.md)). |
| `Sandbox settings ignored: …` warning                                             | The `sandbox` object in `config.json` is invalid (unknown key, bad domain pattern). Defaults are in force until fixed.                                                                                                                      |
| `… is being written by session …; wait until its run finishes` (`workspace_busy`) | Another session holds the write lease on an overlapping workspace. Wait, stop that run, or use another worktree.                                                                                                                            |
| `HTTP 429 … model_cooldown`                                                       | The provider's quota, not pirc. Check with the provider directly; configure `fallbackModels` for background agents.                                                                                                                         |
| No models listed / "no default model"                                             | No backend on the gateway: add one in **Settings → Model backends** or `models.json`. Nodes have no provider settings; `providers` in a node `config.json` is ignored with a warning.                                                       |
| Browser tools missing or `No Chromium found on this node`                         | Install Chromium/Chrome and set `PIRC_BROWSER_EXECUTABLE`; `PIRC_FFMPEG` for recordings.                                                                                                                                                    |
| `web_search` says it is not configured                                            | `EXA_API_KEY` is not in the gateway's environment.                                                                                                                                                                                          |
| A schedule shows a _missed_ run                                                   | The gateway was down or the node offline at fire time. Missed runs wait for **Allow and run now**; nothing runs by itself.                                                                                                                  |
| A `bash` tool hangs then fails at 120 s                                           | `limits.bashTimeoutMs`; use `background_task` for long jobs.                                                                                                                                                                                |

## Web client

| Symptom                                   | Cause and fix                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The page still shows the previous version | The static server sent cacheable headers for `index.html`/`sw.js`, or a waiting service worker. Serve them `no-cache`; reload, or unregister `/sw.js` in DevTools. |
| "reset" / snapshot refetch loops          | The client's cursor is from another runner epoch (a node or gateway restarted). One refetch is normal; loops suggest two gateways behind one proxy.                |
| Notifications never arrive                | Push needs https (or localhost); a LAN distributor on http needs `PIRC_PUSH_ALLOW_HTTP=true`; changing the VAPID key invalidated subscriptions.                    |
