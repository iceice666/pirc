# Gateway configuration

`pirc-gateway` reads its configuration from environment variables only (`crates/pirc-config/src/`, `loadDaemonConfig`). There is no config file besides `models.json`. `.env` files are **not** loaded automatically; inject the environment through your service manager (systemd `EnvironmentFile`, launchd `EnvironmentVariables`, OpenRC `export`).

The gateway refuses to start when a required value is missing or when it sees a node-only variable (`PIRC_WORKSPACES`, `PIRC_NODE_ID`).

## Listening and state

| Variable             | Required | Default              | Meaning                                                                            |
| -------------------- | -------- | -------------------- | ---------------------------------------------------------------------------------- |
| `PIRC_HOST`          | no       | `127.0.0.1`          | Listen address. Keep it on loopback or a private interface only the proxy reaches. |
| `PIRC_PORT`          | no       | `8787`               | Listen port.                                                                       |
| `PIRC_STATE_DIR`     | no       | `./.state`           | State directory (created `0700`). Set it explicitly in production.                 |
| `PIRC_DATABASE_PATH` | no       | `$STATE/pirc.sqlite` | SQLite file. A file that is not pirc's (an old `gateway.sqlite`) is refused.       |
| `PIRC_UPLOADS_DIR`   | no       | `$STATE/uploads`     | Files attached to room messages. Session uploads are stored on their nodes.        |

## Browser authentication

The gateway trusts an identity header only when the TCP peer is a listed proxy. Every value is an exact match; there are no wildcards or CIDR ranges.

| Variable               | Required | Default       | Meaning                                                                                                            |
| ---------------------- | -------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PIRC_TRUSTED_PROXIES` | yes      | —             | Comma-separated peer addresses allowed to set the identity header, e.g. `127.0.0.1,::1`.                           |
| `PIRC_IDENTITY_HEADER` | no       | `x-pirc-user` | Header the proxy fills with the authenticated user (compared case-insensitively).                                  |
| `PIRC_ALLOWED_USERS`   | yes      | —             | Comma-separated identities allowed in, all of them [one person](README.md#one-user). Nodes check it again.         |
| `PIRC_ALLOWED_ORIGINS` | yes      | —             | Exact `Origin` values, e.g. `https://pirc.example.ts.net`. Required on mutating requests and WebSocket upgrades.   |
| `PIRC_ALLOWED_HOSTS`   | yes      | —             | Exact `Host` values (include the port if browsers send one).                                                       |
| `PIRC_PROXY_SECRET`    | no       | —             | Shared secret (≥ 32 characters) the proxy must send as `x-pirc-proxy-secret`; see below. Keep it in a secret file. |

### Proxy shared secret

The peer-address check alone cannot tell the proxy from any other process on the same host: with `PIRC_TRUSTED_PROXIES=127.0.0.1`, anything that can connect to the gateway port from loopback (an agent's shell on a co-located node, a stray script) could set `Host` and `x-pirc-user` and act as any allowed user. Set `PIRC_PROXY_SECRET` and have the proxy add `x-pirc-proxy-secret: <secret>` to every `/api/` request (overwriting whatever a client sent). Requests from a trusted address without the matching header are then refused as if they came from an untrusted address. The comparison is constant-time. Without the variable the gateway logs a startup warning and keeps the address-only check.

The NixOS module generates the secret and wires nginx automatically (`services.pirc.nginx.proxySecret`, on by default). For other proxies see [Reverse proxy](reverse-proxy.md#proxy-shared-secret). Independently of the secret, do not run a node on the gateway host unless its agents are network-sandboxed: they could otherwise reach the gateway port directly.

Phones use device tokens instead of forward auth; the proxy must route those requests past forward auth and strip the identity header (see [Reverse proxy](reverse-proxy.md#device-tokens)).

| Variable                      | Default | Meaning                                                                                  |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `PIRC_DEVICE_TOKEN_IDLE_DAYS` | `7`     | A device token dies after this many days without use.                                    |
| `PIRC_DEVICE_TOKEN_MAX_DAYS`  | `30`    | A device token dies this many days after pairing regardless of use. Must be ≥ idle days. |

## Nodes

| Variable           | Required | Meaning                                                                                                                                                |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PIRC_NODE_TOKENS` | yes      | JSON object `{ "<nodeId>": "<secret>" }`. Each secret is at least 32 characters and unique. Node IDs match `[a-zA-Z0-9_-]{1,100}`. At least one entry. |

Generate secrets with `openssl rand -base64 36`. The NixOS module generates the local node's token itself and merges yours in ([NixOS](nixos.md#remote-nodes)).

## Model backends

The gateway runs every model request; nodes never see keys or endpoints. Backends come from two places, both on the gateway:

1. **Web Settings → Model backends**: subscription logins (Claude Pro/Max, GitHub Copilot, ChatGPT/Codex) and API-key or keyless custom endpoints. Stored in `$PIRC_STATE_DIR/backends/settings.json` (0600), no restart needed.
2. **`models.json`** (`PIRC_MODELS_FILE`, default `$PIRC_CONFIG_DIR/models.json`, i.e. `~/.config/.pirc/models.json`): file-managed providers, read-only in the web UI.

```json
{
  "providers": {
    "openai": {
      "api": "openai-completions",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "models": [
        { "id": "gpt-5", "reasoning": true, "contextWindow": 400000, "input": ["text", "image"] }
      ]
    },
    "anthropic": {
      "api": "anthropic-messages",
      "baseUrl": "https://api.anthropic.com",
      "apiKeyFile": "/run/secrets/anthropic-key",
      "models": [{ "id": "claude-sonnet-4-5", "reasoning": true, "contextWindow": 200000 }]
    }
  },
  "defaultModel": { "provider": "openai", "id": "gpt-5", "thinking": "medium" }
}
```

- `api` is one of `openai-completions`, `openai-responses`, `anthropic-messages`, `openai-codex-responses`, or the legacy alias `openai-chat`.
- Reference keys with `apiKeyEnv` (a variable in the gateway's environment), `apiKeyFile` (readable by the gateway's account) or `apiKeyCommand` (an argv array run on the gateway, with the gateway's environment minus pirc's own secrets: `PIRC_*` tokens, keys and secrets and `EXA_API_KEY` are removed). A literal `apiKey` works but puts the secret in the file.
- Optional per provider: `headers`, `compat`, `piProvider`; per model: `name`, `maxTokens` (default 32000), `reasoning`, `input`, `thinkingLevelMap`, `compat`. Unknown top-level keys are rejected.
- A file provider wins over a web backend with the same ID; a web-set default model wins over the file's.
- The file is validated at startup (invalid → the gateway does not start) and reloaded on `SIGHUP` (invalid → logged and ignored, the previous file stays in force). Running sessions use the new settings on their next request.

## The brain

The gateway runs the brain, the agent that answers in the rooms ([reference](../development/gateway-and-node.md#brain)). It needs a model (the default model of the backends above) and no node. Its files live in the gateway's `PIRC_CONFIG_DIR` (default `~/.config/.pirc` of the gateway's account) and are read again before every turn:

| File         | Meaning                                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOUL.md`    | Its persona, replacing the built-in identity. At most 8000 characters. Editable in the web UI unless it is a Nix store link, a symlink or read-only. |
| `CHAT.md`    | House rules for talking in the rooms, after the persona. Same limits.                                                                                |
| `brain.json` | Settings: `{"debounceSeconds": 3}`, how long it waits after someone's last message or keystroke (0 to 60).                                           |

| Variable                     | Default  | Meaning                                                                                                                               |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `PIRC_BRAIN_TURN_TIMEOUT_MS` | `600000` | A turn running longer is stopped, with a line in its room.                                                                            |
| `PIRC_BRAIN`                 | `true`   | `false` starts no brain (development only: rooms become plain chat, nothing answers in them).                                         |
| `PIRC_WAKES_PER_DAY`         | `24`     | Times the brain may wake up on its own per day, from midnight in `PIRC_TIMEZONE`. `0` turns waking up off.                            |
| `PIRC_TIMEZONE`              | system   | IANA time zone of the household: the wakes' day, loop times without a zone, one move suggestion a day. Else `$TZ`, else the system's. |

Each room's conversation with the brain is kept in `$PIRC_STATE_DIR/brain/rooms/<room>/`; back it up with the rest of the state directory.

## Sources

Sources are what the brain reads beyond the rooms ([guide](../guides/rooms-and-memory.md#sources), plans/rewrite/09-sources.md): a mailbox over IMAP, a calendar (an ICS address or CalDAV), a Moodle site through its web service API, a workspace's commits. They are added in **Web Settings → Models & sources**, on the same page and with the same device-management grant as the model backends; device tokens without that grant cannot reach `/api/sources`. No environment variable is needed.

- **Credentials** (passwords, app passwords, ICS addresses, Moodle tokens) are kept in `$PIRC_STATE_DIR/sources/secrets.json` (directory 0700, file 0600, written whole through a rename). They are never returned by the API or shown to the brain, and nodes never get them. A Moodle password is used once to get a token and not kept.
- **Gmail** works over IMAP with an app password (2-Step Verification on, [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)); a Google Workspace account whose admin turned app passwords off cannot be added yet (Gmail's API with your own OAuth client is a later step). Google Calendar works through its secret iCal address. Mailboxes are opened read-only and nothing is marked read.
- **Moodle**: the user name and password the Moodle app takes, or, for a school that signs in on another page, the app login: Settings gives a link to the site's `admin/tool/mobile/launch.php`, and you paste back the `moodlemobile://token=…` address it ends at. The site must allow the Moodle app (if the official app signs in, this does). Only seven read-only web service functions are ever called.
- **Polling**: email every 5 minutes, calendars every 15, Moodle every hour, workspaces once a day; a source that failed three times in a row is read half as often and said once in the room. Adding or changing a source tries it and takes a baseline, which wakes nobody; after that, the brain wakes only when a room follows the source or something new touches an open loop (within `PIRC_WAKES_PER_DAY`). What the polls saw (headers, never message bodies) is kept in `pirc.sqlite` (`source_items`) and deleted with its source.
- **Network**: the gateway connects to the servers you give it: IMAP over TLS (port 993; plain text only to this machine), https only (plain http only to this machine).

`PIRC_CONFIG_DIR` also holds gateway-owned [workspace modes](../guides/modes.md)
in `modes/<id>.md`. The gateway seeds a missing directory with the
default files, loads valid files at startup and on SIGHUP, and distributes the
catalog to nodes. Existing directories are authoritative, even when empty;
invalid files are warned about and omitted rather than restored. For a
read-only provisioned config, supply the modes directory and its files before
startup. `pirc-gateway modes --print-defaults` prints the shipped files without
starting the daemon.

## Memory, web search and notifications

| Variable                                          | Default              | Meaning                                                                                                                                                  |
| ------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PIRC_MEMORY_USER_CHARS`                          | `2000`               | Character budget of the brain's preferences per person (always in its prompt). Facts have no budget.                                                     |
| `EXA_API_KEY`                                     | unset                | Enables `web_search` for the agents and the brain (runs on the gateway). Without it the agents' tool reports it is off and the brain has none.           |
| `PIRC_VAPID_PUBLIC_KEY`, `PIRC_VAPID_PRIVATE_KEY` | generated            | Web Push signing pair. Set both or neither; without them a pair is created once in `$STATE/vapid.json`. Changing it invalidates every push subscription. |
| `PIRC_VAPID_SUBJECT`                              | first allowed origin | `mailto:` or `https:` contact push services see.                                                                                                         |
| `PIRC_PUSH_ALLOW_HTTP`                            | `false`              | Accept plain-http push endpoints (an ntfy/UnifiedPush distributor on the LAN).                                                                           |

## Limits

| Variable                     | Default    | Meaning                                                                                                                      |
| ---------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `PIRC_EVENT_BUFFER_SIZE`     | `1000`     | Events kept in memory per session for cursor replay, at most 8 MiB of them; older cursors get `reset`.                       |
| `PIRC_WS_MAX_BUFFERED_BYTES` | `1048576`  | Per-WebSocket backpressure limit before a slow client is dropped.                                                            |
| `PIRC_UPLOAD_MAX_BYTES`      | `10485760` | Upload limit; cannot exceed 11 MiB (the node link's frame limit). JSON request bodies are limited to 4 MiB whatever this is. |

## Signals and lifecycle

- `SIGHUP`: reload `models.json` and the mode files.
- `SIGTERM`: graceful shutdown. On the next start, unfinished runs become `interrupted`, pending interactions `stale`, leases are dropped and commands whose acknowledgement was lost become `outcome_unknown` (never retried automatically).
- Logs use the native gateway’s text format. They contain request metadata, never provider bodies or tokens.

## Health check

Every `/api/` route, `/api/health` included, needs the proxy identity or a device token. From the gateway host you can impersonate the proxy for a check:

```sh
curl -s -H 'Host: pirc.example.ts.net' -H 'x-pirc-user: alice@example.com' http://127.0.0.1:8787/api/health
# {"ok":true,"version":2,"nodes":1}
curl -s -H 'Host: pirc.example.ts.net' -H 'x-pirc-user: alice@example.com' http://127.0.0.1:8787/api/nodes
```

This works only because `127.0.0.1` is in `PIRC_TRUSTED_PROXIES` (with `PIRC_PROXY_SECRET` set, add `-H "x-pirc-proxy-secret: $(cat <secret-file>)"`); it is the reason the gateway must not be reachable from anywhere else. Through the proxy, the same requests must return `401`/`403` when you add an `x-pirc-user` header yourself: the proxy must overwrite it.
