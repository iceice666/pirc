# Nix integration

The flake exposes:

- `packages.<system>.pirc`: a single Bun-compiled executable (`bin/pirc` with `gateway`, `node`, and `agent` subcommands) plus the static Web bundle (`share/pirc/web`). The executable needs no Node.js, Bun, or `node_modules` at runtime.
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

Pi is no longer required. A node starts one `pirc agent` subprocess per session by re-executing its own binary. It speaks the same JSONL RPC that Pi did.

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
        api = "openai-chat"; # or "anthropic-messages"
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

This creates a dedicated `pirc` system user and two services:

- `pirc.service`, the gateway, listening on loopback by default with state in `/var/lib/pirc/daemon`;
- `pirc-node.service`, the local node (`services.pirc.localNode`, on by default), which connects to the gateway over loopback, keeps sessions in `/var/lib/pirc/node`, and runs the agent subprocesses and shells for `services.pirc.workspaces`.

They share a token generated on first start in `/var/lib/pirc/local-node-token`; it never enters the Nix store. Only the node service gets write access to workspace paths and the tools in `extraPackages`. Ensure the account has the exact filesystem, Git, SSH, and provider access needed by the selected workspaces—no more.

The node ID defaults to `networking.hostName` (`services.pirc.localNode.id`; the old `hostId` option is renamed). Its workspaces appear in the web client as `<id>:<workspace>`.

### Remote nodes

Other machines can run `pirc node` against this gateway. Put their secrets in `environmentFile` as `PIRC_NODE_TOKENS={"m5pro":"…"}` (the local node's token is merged in), and set `nginx.exposeNodeEndpoint = true` so `/node/connect` is proxied over TLS without forward auth. Set `localNode.enable = false` for a routing-only gateway with no local workspaces.

### Agent configuration

`services.pirc.models` holds the providers and default model. It becomes `/etc/pirc/models.json` for the gateway, which resolves the keys and pushes the providers to every node, local and remote, so remote nodes need no provider settings of their own. Changing it reloads the gateway (`SIGHUP`, no restart), and agents started afterwards use the new providers. `services.pirc.agentConfig` (limits, features, hooks) becomes the local node's `config.json` in a store directory that `PIRC_CONFIG_DIR` points to; `providers` or `defaultModel` there fail evaluation with a pointer to `services.pirc.models`. `services.pirc.agentPrompt` becomes the global `AGENTS.md`. Workspaces can still add a `.pirc/` project config (allowed paths, env, hooks, default model). The removed `piPackage`/`piArgs` options now fail evaluation with a migration hint.

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

- Workspace allowlisting is not an OS sandbox.
- `ProtectSystem=strict` is enabled; only the node service can write configured workspace paths, and each service writes only the state directory besides.
- `ProtectHome=true` means workspaces under `/home` are intentionally unavailable. Prefer `/srv`, or explicitly override the systemd hardening in the host configuration after reviewing the risk.
- `MemoryDenyWriteExecute` remains disabled because Bun/JavaScriptCore requires executable JIT memory.
- Side-panel terminals (`services.pirc.terminals`, default on) give the session holder a shell as the `pirc` account in the workspace, run by the node; disable them if that exceeds what the agent can already do.
- Add tools needed by the agent (and its `bash`/PTC tools) through `services.pirc.extraPackages`.
- Grant private repository access through narrowly scoped credentials readable by the `pirc` account.

## Before deployment

1. Replace the example user, hostname, origins, certificate paths, and workspace paths.
2. Configure `agentConfig` with your provider(s) and default model.
3. Provide provider credentials using an out-of-store secret.
4. Evaluate the target host and inspect the generated nginx/systemd configuration.
5. Test forged identity headers, disallowed Origins/Hosts, service restart, and backup/restore before treating the deployment as production-ready.
