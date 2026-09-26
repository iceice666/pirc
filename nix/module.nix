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
    mkRemovedOptionModule
    mkRenamedOptionModule
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

  # The gateway only routes; the local node (`pirc node`) runs agents and
  # shells. They share a token generated on first start, never in the store.
  tokenFile = "${cfg.stateDirectory}/local-node-token";
  daemonState = "${cfg.stateDirectory}/daemon";
  nodeState = "${cfg.stateDirectory}/node";

  gatewayEnvironment = {
    PIRC_HOST = cfg.listenAddress;
    PIRC_PORT = toString cfg.port;
    PIRC_STATE_DIR = daemonState;
    PIRC_TRUSTED_PROXIES = csv cfg.trustedProxies;
    PIRC_IDENTITY_HEADER = cfg.identityHeader;
    PIRC_ALLOWED_USERS = csv cfg.allowedUsers;
    PIRC_ALLOWED_ORIGINS = csv cfg.allowedOrigins;
    PIRC_ALLOWED_HOSTS = csv cfg.allowedHosts;
    PIRC_MODELS_FILE = "/etc/pirc/models.json";
  }
  // cfg.environment;

  nodeEnvironment = {
    PIRC_NODE_ID = cfg.localNode.id;
    PIRC_DAEMON_URL = "ws://127.0.0.1:${toString cfg.port}";
    PIRC_STATE_DIR = nodeState;
    PIRC_ALLOWED_USERS = csv cfg.allowedUsers;
    PIRC_WORKSPACES = json workspaceList;
    PIRC_CONFIG_DIR = "${agentConfigDir}";
    PIRC_RUNNER_LIMIT = toString cfg.runnerLimit;
    PIRC_TERMINALS = lib.boolToString cfg.terminals;
  }
  // cfg.environment;

  ensureToken = pkgs.writeShellScript "pirc-local-node-token" ''
    set -eu
    if [ ! -s ${tokenFile} ]; then
      umask 077
      ${pkgs.coreutils}/bin/head -c 48 /dev/urandom | ${pkgs.coreutils}/bin/base64 -w0 | ${pkgs.coreutils}/bin/tr -d '/+=' > ${tokenFile}
    fi
  '';

  # Remote nodes may be added through PIRC_NODE_TOKENS in environmentFile;
  # the local node's token is merged in.
  gatewayStart = pkgs.writeShellScript "pirc-gateway" (
    if cfg.localNode.enable then
      ''
        set -eu
        token=$(cat ${tokenFile})
        remote=''${PIRC_NODE_TOKENS:-}
        [ -n "$remote" ] || remote='{}'
        PIRC_NODE_TOKENS=$(printf '%s' "$remote" \
          | ${pkgs.jq}/bin/jq -c --arg id ${lib.escapeShellArg cfg.localNode.id} --arg token "$token" '. + {($id): $token}')
        export PIRC_NODE_TOKENS
        exec ${cfg.package}/bin/pirc gateway
      ''
    else
      "exec ${cfg.package}/bin/pirc gateway"
  );

  nodeStart = pkgs.writeShellScript "pirc-node" ''
    set -eu
    PIRC_NODE_TOKEN=$(cat ${tokenFile})
    export PIRC_NODE_TOKEN
    exec ${cfg.package}/bin/pirc node
  '';

  hardening = {
    NoNewPrivileges = true;
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectHome = true;
    ProtectSystem = "strict";
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectControlGroups = true;
    RestrictSUIDSGID = true;
    LockPersonality = true;
    # Bun/JavaScriptCore needs executable JIT memory.
    MemoryDenyWriteExecute = false;
    User = cfg.user;
    Group = cfg.group;
    UMask = "0077";
    Restart = "on-failure";
    RestartSec = 3;
    EnvironmentFile = optional (cfg.environmentFile != null) cfg.environmentFile;
  };

  # Providers live on the gateway, which resolves their keys and pushes them
  # to every node. The file sits at a stable /etc path so a change reloads
  # the gateway (SIGHUP) instead of restarting it; new sessions pick it up.
  # API keys must use apiKeyEnv/apiKeyFile/apiKeyCommand, never literal values.
  modelsFile = pkgs.writeText "pirc-models.json" (json cfg.models);

  # Node-local agent config (limits, features, hooks, ...), kept in the store.
  agentConfigDir = pkgs.runCommand "pirc-agent-config" { } (
    ''
      mkdir -p $out
      cp ${pkgs.writeText "pirc-agent-config.json" (json cfg.agentConfig)} $out/config.json
    ''
    + lib.optionalString (cfg.agentPrompt != null) ''
      cp ${pkgs.writeText "AGENTS.md" cfg.agentPrompt} $out/AGENTS.md
    ''
  );

  gatewayUpstream = "http://${cfg.listenAddress}:${toString cfg.port}";
in
{
  imports = [
    (mkRemovedOptionModule [
      "services"
      "pirc"
      "piPackage"
    ] "pirc now runs its built-in agent (`pirc agent`); configure it with services.pirc.agentConfig.")
    (mkRemovedOptionModule [
      "services"
      "pirc"
      "piArgs"
    ] "pirc now runs its built-in agent (`pirc agent`); configure it with services.pirc.agentConfig.")
    (mkRenamedOptionModule [ "services" "pirc" "hostId" ] [ "services" "pirc" "localNode" "id" ])
  ];

  options.services.pirc = {
    enable = mkEnableOption "pirc gateway, built-in agent and web UI";

    localNode = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Run a `pirc node` on this host (service `pirc-node`) so its
          workspaces can host sessions. The gateway itself never runs agents;
          disable this for a routing-only gateway that serves remote nodes.
        '';
      };
      id = mkOption {
        type = types.strMatching "[a-zA-Z0-9_-]{1,100}";
        default = config.networking.hostName;
        defaultText = literalExpression "config.networking.hostName";
        description = "Node ID of the local node; workspaces appear as `<id>:<workspace>`.";
      };
    };

    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = literalExpression "pkgs.callPackage ./nix/package.nix { }";
      description = "pirc package to run.";
    };

    models = mkOption {
      type = types.attrsOf types.anything;
      default = { };
      example = literalExpression ''
        {
          providers.openai = {
            api = "openai-chat";
            baseUrl = "https://api.openai.com/v1";
            apiKeyFile = "/run/secrets/openai-key";
            models = [ { id = "gpt-5"; reasoning = true; contextWindow = 400000; } ];
          };
          defaultModel = { provider = "openai"; id = "gpt-5"; };
        }
      '';
      description = ''
        Model providers and the default model, held by the gateway
        (`models.json`) and pushed to every node, local and remote. The
        gateway resolves keys: reference them with apiKeyEnv (set in
        environmentFile), apiKeyFile or apiKeyCommand, which run as the
        gateway's account; literal apiKey values would land in the Nix store.
        Changes reload the gateway and apply to agents started afterwards.
      '';
    };

    agentConfig = mkOption {
      type = types.attrsOf types.anything;
      default = { };
      example = literalExpression ''
        {
          limits.maxTurns = 300;
          features.sessionTitle.enabled = true;
        }
      '';
      description = ''
        Local node's agent configuration (the contents of config.json in
        PIRC_CONFIG_DIR): limits, features, hooks, env and allowed paths.
        Providers and the default model belong in services.pirc.models.
      '';
    };

    agentPrompt = mkOption {
      type = types.nullOr types.lines;
      default = null;
      description = "Optional global AGENTS.md appended to the built-in agent's system prompt.";
    };

    extraPackages = mkOption {
      type = types.listOf types.package;
      default = [
        pkgs.git
        pkgs.openssh
      ];
      description = "Programs added to PATH for the agent and its tools.";
    };

    user = mkOption {
      type = types.str;
      default = "pirc";
      description = "Unprivileged account used by the gateway and agent subprocesses.";
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
      description = "Persistent SQLite, upload, and private agent session storage.";
    };

    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/pirc-env";
      description = ''
        Optional systemd EnvironmentFile for provider credentials, and for
        `PIRC_NODE_TOKENS` (JSON `{nodeId: token}`) when remote nodes connect
        to this gateway. Do not store secrets in the Nix store.
      '';
    };

    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      description = "Additional non-secret PIRC environment variables.";
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
    runnerLimit = mkOption {
      type = types.ints.positive;
      default = 2;
    };
    terminals = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Allow interactive shells in the web side panel. Shells run in the
        session's workspace as the pirc account, like the agent's own tools,
        and require holding session control.
      '';
    };
    workspaces = mkOption {
      type = types.attrsOf workspaceType;
      default = { };
      description = "Explicit workspace allowlist of the local node. More can be added from the web.";
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
      exposeNodeEndpoint = mkOption {
        type = types.bool;
        default = false;
        description = ''
          Proxy `/node/connect` so remote `pirc node`s can reach this gateway
          over TLS. It bypasses forward auth: nodes authenticate with their
          PIRC_NODE_TOKENS secret instead.
        '';
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
          assertion = cfg.localNode.enable || cfg.workspaces == { };
          message = "services.pirc.workspaces belong to the local node; enable services.pirc.localNode";
        }
        {
          assertion = !(cfg.agentConfig ? providers) && !(cfg.agentConfig ? defaultModel);
          message = "services.pirc.agentConfig.providers/defaultModel moved to services.pirc.models (the gateway pushes them to every node)";
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

      systemd.tmpfiles.settings.pirc = {
        ${cfg.stateDirectory}.d = {
          user = cfg.user;
          group = cfg.group;
          mode = "0700";
        };
      };

      environment.etc."pirc/models.json".source = modelsFile;

      systemd.services.pirc = {
        description = "pirc gateway";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        environment = gatewayEnvironment;
        # apiKeyCommand runs on the gateway.
        path = cfg.extraPackages;
        reloadTriggers = [ modelsFile ];
        serviceConfig = hardening // {
          Type = "simple";
          WorkingDirectory = cfg.stateDirectory;
          ExecStartPre = optional cfg.localNode.enable ensureToken;
          ExecStart = gatewayStart;
          ExecReload = "${pkgs.coreutils}/bin/kill -HUP $MAINPID";
          ReadWritePaths = [ cfg.stateDirectory ];
        };
      };
    }

    (mkIf cfg.localNode.enable {
      systemd.services.pirc-node = {
        description = "pirc node (agents and shells for this host)";
        wantedBy = [ "multi-user.target" ];
        after = [ "pirc.service" ];
        requires = [ "pirc.service" ];
        path = [ pkgs.bash ] ++ cfg.extraPackages;
        environment = nodeEnvironment;
        serviceConfig = hardening // {
          Type = "simple";
          WorkingDirectory = cfg.stateDirectory;
          ExecStart = nodeStart;
          ReadWritePaths = [ cfg.stateDirectory ] ++ map (workspace: workspace.path) workspaceList;
        };
      };
    })

    (mkIf cfg.nginx.enable {
      services.nginx.enable = true;
      services.nginx.virtualHosts.${cfg.nginx.hostName} = {
        inherit (cfg.nginx) forceSSL enableACME;
        sslCertificate = mkIf (cfg.nginx.sslCertificate != null) cfg.nginx.sslCertificate;
        sslCertificateKey = mkIf (cfg.nginx.sslCertificateKey != null) cfg.nginx.sslCertificateKey;
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

        locations."= /node/connect" = mkIf cfg.nginx.exposeNodeEndpoint {
          proxyPass = gatewayUpstream;
          proxyWebsockets = true;
          extraConfig = ''
            proxy_set_header ${cfg.identityHeader} "";
            proxy_read_timeout 1h;
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
