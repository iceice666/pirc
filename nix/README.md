# Nix integration

- `packages.<system>.pirc-gateway`: `rustPlatform.buildRustPackage`, native
  `bin/pirc-gateway` plus the static web bundle at `share/pirc/web` (also default).
- `packages.<system>.pirc-node`: native `bin/pirc-node`. No Bun/Node runtime,
  srt or Playwright package. On Linux its wrapper supplies bubblewrap on PATH.
- `overlays.default`: `pkgs.pirc-gateway` and `pkgs.pirc-node`.
- `nixosModules.pirc` / `.default`: gateway and optional local node service.
- `devShells.default`: Rust, clippy/rustfmt, Bun and Node for web development;
  Linux also has bubblewrap and Chromium for native tests.

```sh
nix develop
nix build .#pirc-gateway -o result-gateway
nix build .#pirc-node -o result-node
./result-gateway/bin/pirc-gateway --version
./result-node/bin/pirc-node --help
```

The gateway depends on the web build output, not its Bun build tool. Server
sources are explicitly limited to `Cargo.toml`, `Cargo.lock` and `crates/`; local
credentials/state never enter that build. The web source
is separately allowlisted in `web.nix`.

## Module

See [example.nix](example.nix) and the [NixOS deployment guide](../docs/deploy/nixos.md).
Set `gatewayPackage` and `nodePackage` as needed.
The unit names stay `pirc` and `pirc-node`.

The gateway runs as `pirc-gateway`, separately from the node account (`pirc` by
default). The generated local-node token is passed to the node as a systemd
credential; proxy secrets and provider credentials remain gateway-only. Explicit
identity, Host, Origin and trusted-proxy allowlists are required. nginx can serve
the web output behind forward auth; device tokens and remote-node routing remain
explicit opt-ins. Keep credentials out of Nix expressions/store paths.

`localNode.enable = false` makes a routing-only gateway. There is no chat node:
the brain runs in the gateway, and its prompts come from `soulPrompt` /
`chatPrompt`. The local node uses the explicit workspace allowlist and accepts
the `directory` and `scratch` modes by default. `extraPackages`
provides programs for tools; browser Chromium and ffmpeg packages are configurable.
The native sandbox is mandatory. Linux needs unprivileged user namespaces;
side-panel terminals are not sandboxed. `MemoryDenyWriteExecute` remains off for
Chromium/user tools, not because the servers embed a JIT.

## Cutover and dependency hashes

**The rewrite (0.10.0+harmony) starts a new gateway database** and leaves the
old `gateway.sqlite` in place; see [Upgrades](../docs/deploy/upgrades.md).
**0.4.0 requires fresh state**, including when using Nix generations. Choose a new
`stateDirectory` and retain the old release/state for rollback. Never switch an
old binary onto the new databases. See [Upgrades](../docs/deploy/upgrades.md).

- After `Cargo.lock` changes, refresh `cargoHash` in `package.nix`; build gateway
  and node to verify it.
- After `bun.lock` changes, refresh `nodeModulesHash` in `web.nix`: temporarily
  use `lib.fakeHash`, build `.#pirc-gateway.web.nodeModules`, and record its hash.
- `nix build .#pirc-gateway .#pirc-node` checks packaging and CLI install checks.
  The full network/process/browser suite runs through `bun run check`, outside
  Nix's build sandbox; it is not silently replaced by the install checks.
