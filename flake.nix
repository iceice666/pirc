{
  description = "pirc: single-binary gateway, built-in coding agent, web UI, and NixOS service";

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
        pirc = final.callPackage ./nix/package.nix {
          inherit (nixpkgs.legacyPackages.${final.stdenv.hostPlatform.system}) bun;
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
        pirc = pkgs.callPackage ./nix/package.nix { };
      in
      {
        packages = {
          inherit pirc;
          default = pirc;
        };

        checks.package = pirc;

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs_22 # vitest/svelte-check for apps/web
          ];
          shellHook = ''
            echo "pirc development shell (Bun $(bun --version))"
          '';
        };

        formatter = pkgs.nixfmt-rfc-style;
      }
    );
}
