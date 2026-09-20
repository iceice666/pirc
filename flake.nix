{
  description = "Pi Remote Client gateway, web UI, and NixOS service";

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
            nodejs_22
            python3
            pkg-config
          ];
          shellHook = ''
            echo "pirc development shell (Node $(node --version))"
          '';
        };

        formatter = pkgs.nixfmt-rfc-style;
      }
    );
}
