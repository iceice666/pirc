# Upgrades

## What has to move together

Build and deploy `pirc-gateway`, `pirc-chat` and `pirc-node` from the same release/protocol version. Chat and coding nodes share the implementation and protocol; the table identifies which artifacts need rebuilding, not permission to mix arbitrary releases.

| Change touches                                            | Who must be upgraded                                                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_PROTOCOL_VERSION` in `apps/gateway/src/protocol.ts` | **The gateway and every chat/coding node, in one window.** A mismatched node is closed with code `4426` and logs `daemon rejected this node protocol version`; its sessions are offline until it is upgraded. |
| `src/node/`, `src/agent/`                                 | Every chat/coding node. Run state, snapshots and the agent itself are computed on nodes; upgrading only the gateway changes nothing there.                                                                    |
| `src/daemon/`, `src/backends/`                            | The gateway only.                                                                                                                                                                                             |
| `apps/web/`                                               | The static bundle only. Browsers pick it up on reload; a waiting service worker shows an update prompt.                                                                                                       |
| `apps/android/`                                           | The phone. The API is versioned by behaviour, not a header; keep the app and gateway from the same era.                                                                                                       |
| `bun.lock`                                                | `nodeModulesHash` in `nix/package.nix` ([NixOS](nixos.md#updating-nodemoduleshash)).                                                                                                                          |

The gateway's SQLite schema migrates forward automatically at start (`PRAGMA user_version`); nodes do the same for their own database. There are no down-migrations: restoring an older binary over a newer database is not supported (see rollback).

## Migrating from the single executable

The old `pirc gateway` / `pirc node` dispatcher and `PIRC_CHAT` role switch are removed; there is no compatibility `pirc` executable.

1. Back up the gateway and each node's state ([Backup and recovery](backup-and-recovery.md)). Build the three role executables from the same release.
2. Remove hand-installed legacy `pirc` executables (the Bun role builds remove only their old `dist/pirc` and `dist/pirc.map` artifacts). Replace gateway launch commands with `pirc-gateway`, coding-node commands with `pirc-node`, and former chat-node commands with `pirc-chat`. Do not append `gateway` or `node`; no arguments starts the fixed server role.
3. Delete `PIRC_CHAT` from environment files and service definitions. Keep existing node IDs, matching tokens and state/config directories when replacing each process; `pirc-chat` still requires empty `PIRC_WORKSPACES`. If a host runs chat and coding nodes together, give them distinct IDs, tokens and state directories.
4. Update Nix references: `pkgs.pirc` / `packages.<system>.pirc` become the appropriate `pirc-gateway`, `pirc-chat` or `pirc-node` package. Replace `services.pirc.package` overrides with `gatewayPackage`, `chatPackage` and/or `nodePackage`. `services.pirc.chat` remains a declarative choice of local executable; systemd names remain `pirc` and `pirc-node`.
5. Update custom `PIRC_AGENT_COMMAND` paths to a chat/node executable (its internal `agent` command remains available). Install the Web UI from the gateway package, and sandbox/browser runtime from the chat/node packages. Upgrade/restart all roles in the same maintenance window and confirm every expected node is online.

This is a packaging/entrypoint migration, not session migration or a new privacy boundary. Chat and coding roles still share their runtime implementation. Separate executables do not protect processes sharing an OS account from one another; retain account separation, filesystem permissions and sandboxing.

## Order

1. Build and validate: `bun run check` (format, typecheck, tests, build) on the release commit; `nix build .#pirc-gateway`, `nix build .#pirc-chat` and `nix build .#pirc-node` for the roles you deploy.
2. Upgrade the gateway host (gateway, web bundle, its local node). With the NixOS module that is one `nixos-rebuild switch`; the services restart, `models.json` reloads.
3. Upgrade every remote node and restart it (`launchctl kickstart -k …`, `systemctl restart pirc-node`, …).
4. Check `GET /api/nodes` shows every node online and each node's log has no `4426`.
5. Open one session per node kind and run a trivial prompt.

While the gateway restarts, nodes reconnect on their own (they retry the link); open runs continue on their nodes, and the gateway increments the event epoch so clients refetch snapshots. While a node restarts, its running agents are given `PIRC_SHUTDOWN_GRACE_MS` and then killed: those runs become `interrupted` and need a new prompt to continue.

## Changes that need no restart

| Change                                                                  | How it is applied                                                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `models.json` (file providers, default model)                           | `kill -HUP <gateway pid>` / `systemctl reload pirc`. Invalid file → logged, previous stays in force.  |
| Web-managed backends, logins, logouts                                   | Immediately; in-flight requests are cancelled, running sessions use the new settings next request.    |
| Provider key referenced by `apiKeyFile`/`apiKeyCommand`                 | `SIGHUP` (references are resolved when the file is loaded). `apiKeyEnv` needs a restart.              |
| Workspaces added from the web                                           | Immediately, persisted on the node.                                                                   |
| Chat project capabilities and instructions                              | Capabilities immediately (re-checked at each run); instructions for new chats only.                   |
| Agent config (`config.json`, `AGENTS.md`, `SOUL.md`, `CHAT.md`, skills) | Next agent start (a new session, or a session whose agent was restarted). Running agents keep theirs. |
| `PIRC_ALLOWED_USERS` and every other env var                            | Restart of that process.                                                                              |

## Rollback

- **Binary**: keep the previous binary (Nix generations do this; for hand-copied builds keep `pirc-gateway.prev`, `pirc-chat.prev` and/or `pirc-node.prev`). Roll the gateway and the nodes back together if the protocol version changed.
- **Database**: a rolled-back binary may refuse or misread a database migrated by the newer one. Restore the state directory from the backup taken before the upgrade ([Backup and recovery](backup-and-recovery.md)); sessions created in between are lost from the index (their transcripts stay on the node's disk).
- **Web bundle**: redeploy the previous `dist`; ask browsers to reload (or clear the service worker at `/sw.js` in DevTools if a stale shell persists).

## Release procedure for a Nix-based fleet

```sh
cd pirc && bun run check && git push origin main            # 1. release commit
cd ../infra && nix flake update pirc && git commit -am 'bump pirc' # 2. pin
# 3. switch the gateway host, then each node host (deploy-rs, nixos-rebuild, darwin-rebuild, …)
# 4. nodes without Nix: copy the compiled binary (docs/deploy/macos-node.md)
```

## Chat prompt migration (node protocol 8)

Upgrade the gateway and all nodes together. Chats no longer load any `AGENTS.md`: move chat-relevant rules into the chat node's `$PIRC_CONFIG_DIR/CHAT.md`, and put persona text in global `SOUL.md`. Coding prompts are unchanged. For Nix use `services.pirc.chatPrompt` and `services.pirc.soulPrompt`; the web editor reports these store-managed files as read-only. The first chat node registration is now persistently bound; replacing that node requires releasing the binding in Settings → Assistant after stopping the old node.

## Chat memory approvals and deletion (node protocol 9)

Upgrade the gateway and all nodes together: the node transport now accepts DELETE requests for chat cleanup. Version 8 nodes are refused at registration rather than disconnecting midway through deletion. The database migration adds immutable memory creation provenance (backfilled from the first add log) and durable deletion intent. Back up both gateway and node state before upgrading as usual.

If a deletion was interrupted, keep the same node state and reconnect it, then retry Delete from the chat list. Do not remove deletion-intent rows manually: they fence late writes and make a lost acknowledgement safe to retry.

## Programmatic tool calling (the `code` tool removed)

Upgrade the gateway (it ships the web bundle) and every chat and coding node from the same release, then reload web clients and update the Android app so operations nest under their scripts in the timeline (older clients show them as separate tool calls). The node protocol is unchanged.

- The `code` tool and `features.code` are gone. `ptc` scripts replace them: they run in an isolated QuickJS interpreter, not with Bun's full access, and call other tools only as `tools.<name>(args)`. Scripts that used Bun, Node or `fetch` APIs no longer work; the operations they need are tools (`bash`, `web_fetch`, …). `features.code.enabled` has no effect; chats always have `ptc` scripts, over the same tools they already had.
- Hook matchers that name `code` apply to `ptc`; the session shows a warning the first time each one matches. Rename them to `ptc`. `ptc` keeps the `code` argument, so hooks reading `args.code` still work. Hooks run for each operation inside a script, named after that operation.
- Role `tools:` lists name tools as before. `code`, `ptc` and `ptc_docs` in a list are ignored with a warning (the script tools come with any tool); unknown names warn instead of being dropped silently.
- Auto mode no longer judges a script's text (the old `code` script rules are removed): only your `deny` list applies to it, and each operation is judged like the same direct call.
- Existing sessions resume with the new tools; their old `code` and tool-call history still loads and replays.
