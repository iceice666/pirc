{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (lib)
    concatStringsSep
    literalExpression
    mkEnableOption
    mkIf
    mkMerge
    mkOption
    optional
    types
    ;

  cfg = config.services.pirc;
  json = builtins.toJSON;
  csv = concatStringsSep ",";

  workspaceType = types.submodule (
    { name, ... }: {
      options = {
        id = mkOption {
          type = types.str;
          default = name;
          description = "Stable workspace identifier.";
        };
        path = mkOption {
          type = types.str;
          description = "Absolute workspace path visible to the pirc service account.";
        };
        displayName = mkOption {
          type = types.str;
          default = name;
          description = "Workspace name shown in the web client.";
        };
        defaults = mkOption {
          type = types.attrsOf types.anything;
          default = { };
          description = "Default model/thinking settings passed to the gateway.";
        };
      };
    }
  );

  workspaceList = lib.mapAttrsToList (_: workspace: {
    inherit (workspace)
      id
      path
      displayName
      defaults
      ;
  }) cfg.workspaces;

  gatewayEnvironment = {
    PIRC_HOST = cfg.listenAddress;
    PIRC_PORT = toString cfg.port;
    PIRC_STATE_DIR = cfg.stateDirectory;
    PIRC_HOST_ID = cfg.hostId;
    PIRC_TRUSTED_PROXIES = csv cfg.trustedProxies;
    PIRC_IDENTITY_HEADER = cfg.identityHeader;
    PIRC_ALLOWED_USERS = csv cfg.allowedUsers;
    PIRC_ALLOWED_ORIGINS = csv cfg.allowedOrigins;
    PIRC_ALLOWED_HOSTS = csv cfg.allowedHosts;
    PIRC_WORKSPACES = json workspaceList;
    PIRC_PI_COMMAND = if cfg.piPackage == null then "pi" else "${cfg.piPackage}/bin/pi";
    PIRC_PI_ARGS = json cfg.piArgs;
    PIRC_RUNNER_LIMIT = toString cfg.runnerLimit;
  }
  // cfg.environment;

  gatewayUpstream = "http://${cfg.listenAddress}:${toString cfg.port}";
in
{
  options.services.pirc = {
    enable = mkEnableOption "Pi Remote Client gateway and web UI";

    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = literalExpression "pkgs.callPackage ./nix/package.nix { }";
      description = "pirc package to run.";
    };

    piPackage = mkOption {
      type = types.nullOr types.package;
      default = null;
      description = "Package providing bin/pi. Set this in production or add pi through extraPackages.";
    };

    extraPackages = mkOption {
      type = types.listOf types.package;
      default = [
        pkgs.git
        pkgs.openssh
      ];
      description = "Programs added to PATH for Pi and its tools.";
    };

    user = mkOption {
      type = types.str;
      default = "pirc";
      description = "Unprivileged account used by the gateway and Pi subprocesses.";
    };

    group = mkOption {
      type = types.str;
      default = "pirc";
      description = "Primary group of the service account.";
    };

    supplementaryGroups = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Additional groups used to grant access to workspace paths or credentials.";
    };

    stateDirectory = mkOption {
      type = types.str;
      default = "/var/lib/pirc";
      description = "Persistent SQLite, upload, and private Pi session storage.";
    };

    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/pirc-env";
      description = "Optional systemd EnvironmentFile for provider credentials. Do not store secrets in the Nix store.";
    };

    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      description = "Additional non-secret PIRC environment variables.";
    };

    hostId = mkOption {
      type = types.str;
      default = config.networking.hostName;
    };
    listenAddress = mkOption {
      type = types.str;
      default = "127.0.0.1";
    };
    port = mkOption {
      type = types.port;
      default = 8787;
    };
    identityHeader = mkOption {
      type = types.str;
      default = "x-pirc-user";
    };
    trustedProxies = mkOption {
      type = types.listOf types.str;
      default = [
        "127.0.0.1"
        "::1"
      ];
    };
    allowedUsers = mkOption {
      type = types.listOf types.str;
      default = [ ];
    };
    allowedOrigins = mkOption {
      type = types.listOf types.str;
      default = [ ];
    };
    allowedHosts = mkOption {
      type = types.listOf types.str;
      default = [ ];
    };
    piArgs = mkOption {
      type = types.listOf types.str;
      default = [ ];
    };
    runnerLimit = mkOption {
      type = types.ints.positive;
      default = 2;
    };
    workspaces = mkOption {
      type = types.attrsOf workspaceType;
      default = { };
      description = "Explicit workspace allowlist.";
    };

    nginx = {
      enable = mkEnableOption "an nginx virtual host for pirc";
      hostName = mkOption {
        type = types.str;
        example = "pirc.example.ts.net";
        description = "Exact public host name. Usually include the same value in allowedHosts.";
      };
      forceSSL = mkOption {
        type = types.bool;
        default = true;
      };
      enableACME = mkOption {
        type = types.bool;
        default = false;
      };
      sslCertificate = mkOption {
        type = types.nullOr types.path;
        default = null;
      };
      sslCertificateKey = mkOption {
        type = types.nullOr types.path;
        default = null;
      };
      forwardAuthUri = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "http://127.0.0.1:9091/api/authz/auth-request";
        description = "Authelia-compatible auth_request endpoint. Required when nginx is enabled.";
      };
      authUserResponseHeader = mkOption {
        type = types.str;
        default = "Remote-User";
        description = "Header returned by forward auth containing the authenticated identity.";
      };
    };
  };

  config = mkIf cfg.enable (mkMerge [
    {
      assertions = [
        {
          assertion = cfg.allowedUsers != [ ];
          message = "services.pirc.allowedUsers must not be empty";
        }
        {
          assertion = cfg.allowedOrigins != [ ];
          message = "services.pirc.allowedOrigins must not be empty";
        }
        {
          assertion = cfg.allowedHosts != [ ];
          message = "services.pirc.allowedHosts must not be empty";
        }
        {
          assertion = cfg.workspaces != { };
          message = "services.pirc.workspaces must not be empty";
        }
        {
          assertion = !cfg.nginx.enable || cfg.nginx.forwardAuthUri != null;
          message = "services.pirc.nginx.forwardAuthUri is required when nginx is enabled";
        }
      ];

      users.groups.${cfg.group} = { };
      users.users.${cfg.user} = {
        isSystemUser = true;
        group = cfg.group;
        extraGroups = cfg.supplementaryGroups;
        home = cfg.stateDirectory;
        createHome = true;
      };

      systemd.services.pirc = {
        description = "Pi Remote Client gateway";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        path = cfg.extraPackages ++ optional (cfg.piPackage != null) cfg.piPackage;
        environment = gatewayEnvironment;
        serviceConfig = {
          Type = "simple";
          User = cfg.user;
          Group = cfg.group;
          WorkingDirectory = cfg.stateDirectory;
          ExecStart = "${cfg.package}/bin/pirc-gateway";
          Restart = "on-failure";
          RestartSec = 3;
          UMask = "0077";
          EnvironmentFile = optional (cfg.environmentFile != null) cfg.environmentFile;
          NoNewPrivileges = true;
          PrivateTmp = true;
          PrivateDevices = true;
          ProtectHome = true;
          ProtectSystem = "strict";
          ReadWritePaths = [ cfg.stateDirectory ] ++ map (workspace: workspace.path) workspaceList;
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectControlGroups = true;
          RestrictSUIDSGID = true;
          LockPersonality = true;
          MemoryDenyWriteExecute = false;
        };
      };
    }

    (mkIf cfg.nginx.enable {
      services.nginx.enable = true;
      services.nginx.virtualHosts.${cfg.nginx.hostName} = {
        inherit (cfg.nginx) forceSSL enableACME;
        sslCertificate = cfg.nginx.sslCertificate;
        sslCertificateKey = cfg.nginx.sslCertificateKey;
        root = "${cfg.package}/share/pirc/web";

        locations."= /_pirc_auth" = {
          proxyPass = cfg.nginx.forwardAuthUri;
          extraConfig = ''
            internal;
            proxy_pass_request_body off;
            proxy_set_header Content-Length "";
            proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
            proxy_set_header X-Original-Method $request_method;
            proxy_set_header Host $http_host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
          '';
        };

        locations."/api/" = {
          proxyPass = gatewayUpstream;
          proxyWebsockets = true;
          extraConfig = ''
            auth_request /_pirc_auth;
            auth_request_set $pirc_user $upstream_http_${
              lib.toLower (builtins.replaceStrings [ "-" ] [ "_" ] cfg.nginx.authUserResponseHeader)
            };
            proxy_set_header ${cfg.identityHeader} $pirc_user;
            proxy_set_header Host $http_host;
            proxy_set_header Origin $http_origin;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          '';
        };

        locations."/" = {
          tryFiles = "$uri $uri/ /index.html";
          extraConfig = ''
            auth_request /_pirc_auth;
          '';
        };
      };
    })
  ]);
}
