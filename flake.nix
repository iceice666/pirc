{
  description = "pirc: independent gateway, chat, and node binaries with a NixOS service";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    inputs@{
      self,
      nixpkgs,
      flake-utils,
      ...
    }:
    {
      # bun.lock needs a recent Bun; take it from this flake's nixpkgs so a
      # consumer on a stable channel still gets a compatible toolchain.
      overlays.default = final: _prev: {
        pirc-gateway = final.callPackage ./nix/package.nix {
          inherit (nixpkgs.legacyPackages.${final.stdenv.hostPlatform.system}) bun;
          role = "gateway";
        };
        pirc-chat = final.callPackage ./nix/package.nix {
          inherit (nixpkgs.legacyPackages.${final.stdenv.hostPlatform.system}) bun;
          role = "chat";
        };
        pirc-node = final.callPackage ./nix/package.nix {
          inherit (nixpkgs.legacyPackages.${final.stdenv.hostPlatform.system}) bun;
          role = "node";
        };
      };

      nixosModules = {
        pirc = import ./nix/module.nix;
        default = self.nixosModules.pirc;
      };
    }
    // flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        pirc-gateway = pkgs.callPackage ./nix/package.nix { role = "gateway"; };
        pirc-chat = pkgs.callPackage ./nix/package.nix { role = "chat"; };
        pirc-node = pkgs.callPackage ./nix/package.nix { role = "node"; };
      in
      {
        packages = {
          inherit pirc-gateway pirc-chat pirc-node;
          default = pirc-gateway;
        };

        checks = {
          gateway = pirc-gateway;
          chat = pirc-chat;
          node = pirc-node;
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs_22 # vitest/svelte-check for apps/web
            # Rust rewrite (crates/, see plans/rust-rewrite.md)
            cargo
            rustc
            clippy
            rustfmt
          ];
          shellHook = ''
            echo "pirc development shell (Bun $(bun --version))"
          '';
        };

        formatter = pkgs.nixfmt-rfc-style;
      }
    );
}
