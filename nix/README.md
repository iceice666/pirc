# Nix integration

The flake exposes:

- `packages.<system>.pirc`: a single Bun-compiled executable (`bin/pirc` with `gateway`, `node`, and `agent` subcommands) plus the static Web bundle (`share/pirc/web`). The executable needs no Node.js, Bun, or `node_modules` at runtime.
- `overlays.default`: adds `pkgs.pirc`, built against the consumer's nixpkgs.
- `nixosModules.pirc`: an unprivileged systemd service and optional nginx/forward-auth virtual host.
- `devShells.<system>.default`: Bun (plus Node 22 for the web app's vitest/svelte-check).

## Local commands

```sh
nix develop
bun install
bun run check

nix build
./result/bin/pirc gateway # requires the PIRC_* environment described below
./result/bin/pirc node    # outbound node agent (PIRC_NODE_ID, PIRC_NODE_TOKEN, PIRC_DAEMON_URL)
```

Pi is no longer required. The gateway starts one `pirc agent` subprocess per session by re-executing its own binary. It speaks the same JSONL RPC that Pi did.

Dependencies are fetched in a fixed-output derivation (`pirc.nodeModules`) that covers every OS/CPU, so one `nodeModulesHash` works for all systems. After changing `bun.lock`, set `nodeModulesHash` to `lib.fakeHash`, run `nix build .#pirc.nodeModules`, and copy the reported hash into [`package.nix`](./package.nix).

## NixOS module

Import `nixosModules.default` from the flake and configure `services.pirc`. A complete starting point is in [`example.nix`](./example.nix).

Minimal service-only example:

```nix
{
  services.pirc = {
    enable = true;
    agentConfig = {
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

This creates a dedicated `pirc` system user, listens on loopback by default, stores state in `/var/lib/pirc`, and starts `pirc.service`. Agent subprocesses run with the same unprivileged account. Ensure that account has the exact filesystem, Git, SSH, and provider access needed by the selected workspaces—no more.

### Agent configuration

`services.pirc.agentConfig` becomes `config.json` in a store directory that `PIRC_CONFIG_DIR` points to. `services.pirc.agentPrompt` becomes the global `AGENTS.md`. Workspaces can still add a `.pirc/` project config (allowed paths, env, hooks, default model). The removed `piPackage`/`piArgs` options now fail evaluation with a migration hint.

### Secrets

The agent config lives in the world-readable Nix store, so reference provider keys indirectly with `apiKeyFile`, `apiKeyEnv`, or `apiKeyCommand`. For `apiKeyEnv`, put the variable in `services.pirc.environmentFile`:

```nix
services.pirc.environmentFile = config.sops.secrets.pirc-env.path;
```

The file uses systemd `KEY=value` syntax. Do not place tokens in `services.pirc.environment`, `workspaces.*.defaults`, or another Nix value because values may be copied to the world-readable Nix store.

### nginx and Authelia

`services.pirc.nginx.enable = true` adds:

- authenticated static Web serving;
- authenticated `/api/` proxying;
- WebSocket upgrade support;
- an internal `auth_request` location;
- identity-header replacement using the response from forward auth.

Set `nginx.forwardAuthUri` to the Authelia authorization endpoint used by your deployment. The gateway still independently validates the proxy socket address, authenticated user, exact Host, and exact Origin.

The generated nginx configuration does not create Tailscale certificates. Supply certificate paths, use an existing certificate unit, or put the virtual host behind an already-managed tailnet TLS listener. Never enable Funnel for this service.

## Workspace and hardening notes

- Workspace allowlisting is not an OS sandbox.
- `ProtectSystem=strict` is enabled; configured workspace paths and the state directory are writable.
- `ProtectHome=true` means workspaces under `/home` are intentionally unavailable. Prefer `/srv`, or explicitly override the systemd hardening in the host configuration after reviewing the risk.
- `MemoryDenyWriteExecute` remains disabled because Bun/JavaScriptCore requires executable JIT memory.
- Add tools needed by the agent (and its `bash`/PTC tools) through `services.pirc.extraPackages`.
- Grant private repository access through narrowly scoped credentials readable by the `pirc` account.

## Before deployment

1. Replace the example user, hostname, origins, certificate paths, and workspace paths.
2. Configure `agentConfig` with your provider(s) and default model.
3. Provide provider credentials using an out-of-store secret.
4. Evaluate the target host and inspect the generated nginx/systemd configuration.
5. Test forged identity headers, disallowed Origins/Hosts, service restart, and backup/restore before treating the deployment as production-ready.
