# Nix integration

The flake exposes:

- `packages.<system>.pirc`: compiled Gateway plus static Web bundle.
- `nixosModules.pirc`: an unprivileged systemd service and optional nginx/forward-auth virtual host.
- `devShells.<system>.default`: Node 22 and native build prerequisites.

## Local commands

```sh
nix develop
npm ci
npm run check

nix build
./result/bin/pirc-gateway # requires the PIRC_* environment described below
```

The package does not bundle Pi. This is deliberate: deployment should provide and pin the approved Pi package/version separately through `services.pirc.piPackage`.

## NixOS module

Import `nixosModules.default` from the flake and configure `services.pirc`. A complete starting point is in [`example.nix`](./example.nix).

Minimal service-only example:

```nix
{
  services.pirc = {
    enable = true;
    piPackage = pkgs.your-pinned-pi-package;

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

This creates a dedicated `pirc` system user, listens on loopback by default, stores state in `/var/lib/pirc`, and starts `pirc.service`. Pi subprocesses run with the same unprivileged account. Ensure that account has the exact filesystem, Git, SSH, and provider access needed by the selected workspaces—no more.

### Secrets

Use `services.pirc.environmentFile` for provider credentials:

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
- `MemoryDenyWriteExecute` remains disabled because Node/V8 requires executable JIT memory.
- Add tools needed by Pi through `services.pirc.extraPackages`.
- Grant private repository access through narrowly scoped credentials readable by the `pirc` account.

## Before deployment

1. Replace the example user, hostname, origins, certificate paths, and workspace paths.
2. Pin a Pi package compatible with version `0.85.1` and set `piPackage`.
3. Provide provider credentials using an out-of-store secret.
4. Evaluate the target host and inspect the generated nginx/systemd configuration.
5. Test forged identity headers, disallowed Origins/Hosts, service restart, and backup/restore before treating the deployment as production-ready.
