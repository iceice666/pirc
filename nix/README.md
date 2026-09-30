# Nix integration

The flake exposes:

- `packages.<system>.pirc`: a single Bun-compiled executable (`bin/pirc` with `gateway`, `node`, and `agent` subcommands) plus the static Web bundle (`share/pirc/web`). `bin/pirc` is a wrapper that points the node at two things it runs beside the binary: [srt](./sandbox-runtime.nix), the agent sandbox pinned here because nixpkgs trails upstream (`PIRC_SANDBOX_SRT`), and an on-disk playwright-core (`PIRC_PLAYWRIGHT_CORE`), which reads its own files by computed paths that `bun --compile` cannot bundle. No Bun or `node_modules` is needed at runtime; srt brings its own Node.js.
- `overlays.default`: adds `pkgs.pirc`, built against the consumer's nixpkgs.
- `nixosModules.pirc`: unprivileged systemd services for the gateway and a local node, and an optional nginx/forward-auth virtual host.
- `devShells.<system>.default`: Bun (plus Node 22 for the web app's vitest/svelte-check).

## Local commands

```sh
nix develop
bun install
bun run check

nix build
./result/bin/pirc gateway # browser API and routing (see apps/gateway/.env.example)
./result/bin/pirc node    # agents for this machine (PIRC_NODE_ID, PIRC_NODE_TOKEN, PIRC_DAEMON_URL)
```

A node starts one `pirc agent` subprocess per session by re-executing its own binary; the two talk JSONL RPC over stdin/stdout.

Dependencies are fetched in a fixed-output derivation (`pirc.nodeModules`) that covers every OS/CPU, so one `nodeModulesHash` works for all systems. After changing `bun.lock`, set `nodeModulesHash` to `lib.fakeHash`, run `nix build .#pirc.nodeModules`, and copy the reported hash into [`package.nix`](./package.nix).

## NixOS module

Import `nixosModules.default` from the flake and configure `services.pirc`. A complete starting point is in [`example.nix`](./example.nix).

Minimal service-only example:

```nix
{
  services.pirc = {
    enable = true;
    models = {
      providers.main = {
        api = "openai-completions"; # or "anthropic-messages", "openai-responses"
        baseUrl = "https://api.example.com/v1";
        apiKeyFile = "/run/secrets/pirc-api-key";
        models = [ { id = "model-id"; reasoning = true; contextWindow = 200000; } ];
      };
      defaultModel = { provider = "main"; id = "model-id"; };
    };

    allowedUsers = [ "alice@example.com" ];
    allowedOrigins = [ "https://pirc.example.ts.net" ];
    allowedHosts = [ "pirc.example.ts.net" ];

    workspaces.main = {
      path = "/srv/src/main";
      displayName = "Main";
    };
  };
}
```

This creates two system users and two services:

- `pirc.service`, the gateway, running as `pirc-gateway` (`services.pirc.gatewayUser`), listening on loopback by default with state in `/var/lib/pirc/daemon`;
- `pirc-node.service`, the local node (`services.pirc.localNode`, on by default), which connects to the gateway over loopback, keeps sessions in `/var/lib/pirc/node`, and runs the agent subprocesses and shells for `services.pirc.workspaces`.

The node runs as `pirc` (`services.pirc.user`). The gateway has an account of its own so nothing the node runs can read the gateway's state: provider logins, web-managed keys, push keys and the node token. This covers agents, their shells and side-panel terminals.

- **Token**: the two services share a token that the gateway's start creates (as root) in `/var/lib/pirc/daemon/local-node-token`. The node gets it as a systemd credential (`LoadCredential`). It never enters the Nix store. A token that older versions kept in `/var/lib/pirc/local-node-token` is moved there.
- **Environment files**: `environmentFile` is the gateway's only. Give the node its own with `localNode.environmentFile`, for tokens the agents' tools need.
- **Upgrading**: older versions ran both services as `pirc`. Make files named by `apiKeyFile` readable by `pirc-gateway` (for sops-nix, set the secret's `owner`). The daemon state directory is handed over automatically.

Only the node service gets write access to workspace paths and the tools in `extraPackages`. Ensure the account has the exact filesystem, Git, SSH, and provider access needed by the selected workspaces—no more.

The node ID defaults to `networking.hostName` (`services.pirc.localNode.id`; the old `hostId` option is renamed). Its workspaces appear in the web client as `<id>:<workspace>`.

### Remote nodes

Other machines can run `pirc node` against this gateway. Put their secrets in `environmentFile` as `PIRC_NODE_TOKENS={"m5pro":"…"}` (the local node's token is merged in), and set `nginx.exposeNodeEndpoint = true` so `/node/connect` is proxied over TLS without forward auth. Set `localNode.enable = false` for a routing-only gateway with no local workspaces.

### Agent configuration

`services.pirc.models` holds the file-managed providers and default model. It becomes `/etc/pirc/models.json` for the gateway, which resolves the keys and runs every model request; nodes, local and remote, get only a secret-free catalog and need no provider settings. Changing it reloads the gateway (`SIGHUP`, no restart); running sessions use the new settings on their next request. Subscription logins and web-managed backends are stored in the gateway state directory (`backends/settings.json`, 0600) and survive rebuilds. `services.pirc.agentConfig` (limits, features, hooks) becomes the local node's `config.json` in a store directory that `PIRC_CONFIG_DIR` points to; `providers` or `defaultModel` there fail evaluation with a pointer to `services.pirc.models`. `services.pirc.agentPrompt` becomes the global `AGENTS.md`, and `services.pirc.skills` (name → directory with a `SKILL.md`) is linked into its `skills/` directory; put the programs the skills run in `extraPackages`. Workspaces can still add a `.pirc/` project config (allowed paths, env, hooks, default model). The removed `piPackage`/`piArgs` options now fail evaluation with a migration hint.

### Secrets

`services.pirc.models` lives in the world-readable Nix store, so reference provider keys indirectly with `apiKeyFile`, `apiKeyEnv`, or `apiKeyCommand`. They are resolved by the gateway service (`apiKeyCommand` finds `extraPackages` on its PATH). For `apiKeyEnv`, put the variable in `services.pirc.environmentFile`:

```nix
services.pirc.environmentFile = config.sops.secrets.pirc-env.path;
```

The file uses systemd `KEY=value` syntax. Do not place tokens in `services.pirc.environment`, `workspaces.*.defaults`, or another Nix value because values may be copied to the world-readable Nix store.

### nginx and Authelia

`services.pirc.nginx.enable = true` adds:

- authenticated static Web serving;
- authenticated `/api/` proxying;
- optionally, token-authenticated `/node/connect` for remote nodes (`nginx.exposeNodeEndpoint`);
- WebSocket upgrade support;
- an internal `auth_request` location;
- identity-header replacement using the response from forward auth.

Set `nginx.forwardAuthUri` to the Authelia authorization endpoint used by your deployment. The gateway still independently validates the proxy socket address, authenticated user, exact Host, and exact Origin.

The generated nginx configuration does not create Tailscale certificates. Supply certificate paths, use an existing certificate unit, or put the virtual host behind an already-managed tailnet TLS listener. Never enable Funnel for this service.

## Workspace and hardening notes

- Each agent runs in an OS sandbox (`services.pirc.sandbox.enable`, default on; srt with bubblewrap and a seccomp filter, see "Agent sandbox" in the top-level README). Tune it with `agentConfig.sandbox`. It needs unprivileged user namespaces, which NixOS allows by default. Where they are refused, agents run unconfined and every session shows a warning. Side-panel terminals are not sandboxed.
- `ProtectSystem=strict` is enabled; only the node service can write configured workspace paths, and each service writes only the state directory besides.
- `ProtectHome=true` means workspaces under `/home` are intentionally unavailable. Prefer `/srv`, or explicitly override the systemd hardening in the host configuration after reviewing the risk.
- `MemoryDenyWriteExecute` remains disabled because Bun/JavaScriptCore requires executable JIT memory.
- Side-panel terminals (`services.pirc.terminals`, default on) give the session holder a shell as the `pirc` account in the workspace, run by the node; disable them if that exceeds what the agent can already do.
- Add tools needed by the agent (and its `bash`/PTC tools) through `services.pirc.extraPackages`.
- Grant private repository access through narrowly scoped credentials readable by the `pirc` account.

## Before deployment

1. Replace the example user, hostname, origins, certificate paths, and workspace paths.
2. Configure `services.pirc.models` with your provider(s) and default model, or plan to add backends from the web **Settings** after the first start.
3. Provide provider credentials using an out-of-store secret readable by `pirc-gateway`.
4. Evaluate the target host and inspect the generated nginx/systemd configuration.
5. Test forged identity headers, disallowed Origins/Hosts, service restart, and backup/restore before treating the deployment as production-ready.

The step-by-step guide, including remote nodes, macOS nodes and upgrades, is in [`docs/deploy/`](../docs/deploy/README.md).
