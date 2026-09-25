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

            # Built-in agent configuration (config.json). Keep keys out of the
            # store: reference them with apiKeyFile/apiKeyEnv/apiKeyCommand.
            agentConfig = {
              providers.openai = {
                api = "openai-chat";
                baseUrl = "https://api.openai.com/v1";
                apiKeyFile = "/run/secrets/openai-key";
                models = [
                  {
                    id = "gpt-5";
                    reasoning = true;
                    contextWindow = 400000;
                  }
                ];
              };
              defaultModel = {
                provider = "openai";
                id = "gpt-5";
              };
            };

            allowedUsers = [ "alice@example.com" ];
            allowedOrigins = [ "https://pirc.example.ts.net" ];
            allowedHosts = [ "pirc.example.ts.net" ];

            workspaces.pirc = {
              path = "/srv/src/pirc";
              displayName = "pirc";
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
