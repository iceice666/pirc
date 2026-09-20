# Import this flake's NixOS module, then adapt the values to the target host.
{
  inputs.pirc.url = "github:YOUR-ORG/pirc";

  outputs = { nixpkgs, pirc, ... }: {
    nixosConfigurations.homolab = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        pirc.nixosModules.default
        ({ pkgs, ... }: {
          services.pirc = {
            enable = true;

            # Replace this with the package that provides your pinned Pi 0.85.1.
            # piPackage = pkgs.pi-coding-agent;

            allowedUsers = [ "alice@example.com" ];
            allowedOrigins = [ "https://pirc.example.ts.net" ];
            allowedHosts = [ "pirc.example.ts.net" ];

            workspaces.pirc = {
              path = "/srv/src/pirc";
              displayName = "Pi Remote Client";
            };

            # Provider/API credentials belong outside the Nix store, for example
            # in an sops-nix or agenix managed file containing KEY=value lines.
            environmentFile = "/run/secrets/pirc-env";

            nginx = {
              enable = true;
              hostName = "pirc.example.ts.net";
              forwardAuthUri = "http://127.0.0.1:9091/api/authz/auth-request";

              # For tailnet certificates managed outside ACME:
              sslCertificate = "/var/lib/tailscale-certs/pirc.example.ts.net.crt";
              sslCertificateKey = "/var/lib/tailscale-certs/pirc.example.ts.net.key";
            };
          };
        })
      ];
    };
  };
}
