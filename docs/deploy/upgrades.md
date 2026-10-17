# Upgrades

## 0.6.0: gateway schema 1004, node schema 2001, node protocol 11

Upgrade the gateway and every node together: the node protocol moves to 11, and
the gateway closes a node on protocol 10 (the node exits asking for the
upgrade). On first start the gateway migrates its database from schema
1000–1003 to 1004 (the `workspace_deletions` table, a `workspace_id` in
`session_deletions`, and a `scope_id` in `memory_tombstones`; existing
tombstones become `global`, so forgotten text stays refused), and each node its
store from 2000 to 2001 (an upload's
`workspace_id`/`session_id`, and `workspace_deletions`). Uploads made before the
upgrade record no workspace: they can still be attached anywhere and are not
deleted with a chat project. From 0.6.0 both migrate under one write lock
in a single transaction, so a failed step leaves the database at its old
schema.

A 0.5.x gateway refuses a database at schema 1004, and a 0.5.x node one at 2001. Back up both state directories before upgrading if you may need to roll
back.

## 0.5.0: gateway schema 1003 (node protocol 10)

An in-place upgrade. On its first start the gateway migrates its database from
schema 1000, 1001 or 1002 to 1003 by itself, one transaction per step: 1001 adds the
`repo` columns of workspaces and mirrored workspace memory, 1002 the
`project_links` table (chat projects linked to workspaces), 1003 the
`operation` of schedule proposals (agents' deletions wait for you), the
`as_user_request` of delegations and an index on `delegations(follows)`. Node state is
unchanged and the node protocol stays 10, so nodes and gateway still
interoperate across the upgrade, but deploy them together as usual: an older
node reports no repositories, an older gateway gives coding sessions no USER
entries, and an older node's agent refuses `delegate` without a workspace before
asking the gateway. Upgrade every node with the gateway: an older node does not
offer the approval-mode switch (the web hides it) and refuses the command.

Node configs using `features.autoMode.enabled` keep working with a warning;
replace it with `features.autoMode.mode` (`enabled: false` now means
`"full-access"`, `true` means `"auto"`). A repository's `.pirc/config.json`
that sets `defaultModel` is ignored until you trust it again in the workspace's
Settings.

On Linux nodes, sessions no longer reach Unix sockets on the host other than
the node's inference socket and the Nix daemon's: add any a session needs (an
`ssh-agent`, a database, a container engine) to
`sandbox.network.allowUnixSockets`. Leftover `<key>.lock` files beside
workspace-memory ledgers can be deleted.

A 0.4.x gateway refuses a database at schema 1001, 1002 or 1003 ("newer than this
gateway"). Back up the gateway's state directory before upgrading if you may
need to roll back; restoring that backup loses what changed since.

## 0.4.0: fresh-start Rust cutover (node protocol 10)

This is a **breaking release**, not an in-place database migration. The server
executables are now native Rust: `pirc-gateway` and `pirc-node`. The chat service
runs **`pirc-node chat`**; there is no `pirc-chat` binary or package. Web and Android
API behaviour remains compatible; shared timeline fixtures are unchanged.

The Rust gateway/node refuse TS-era SQLite schemas. Do **not** copy the old
`gateway.sqlite`, node databases, `sessions/*/session.jsonl`, `backends/settings.json`
or `vapid.json` into the new state directory, even though some filenames and
formats resemble the old ones. Do not point `PIRC_DATABASE_PATH` at an old DB.

### Maintenance-window checklist

1. Build and validate the new release (`bun run check`; Nix: `nix build .#pirc-gateway .#pirc-node`).
2. Stop the gateway and **all** chat/coding nodes. Take a consistent, protected
   backup of each old state directory and keep the old release alongside it.
3. Select new, empty `PIRC_STATE_DIR` directories for the gateway and each node.
   For the NixOS module, set a new `services.pirc.stateDirectory`, for example
   `/var/lib/pirc-rust`. The module does not delete or migrate old state.
4. Preserve only reviewed configuration: identity/Host/Origin allowlists,
   proxy settings, file-managed `models.json`, workspace paths and agent prompts/
   skills. Recreate node credentials or deliberately provision matching tokens
   on both ends. Keep gateway and node accounts separate and secrets out of Nix.
5. Change chat launch commands to `pirc-node chat`; coding remains `pirc-node`.
   Remove `PIRC_CHAT`, `PIRC_PLAYWRIGHT_CORE`, and production `PIRC_SANDBOX_SRT`
   overrides. Install `bwrap` on Linux (`pirc-node`'s Nix wrapper supplies it),
   `git`, and Chromium/Chrome plus optional ffmpeg. No Bun/Node/srt is needed.
6. Nix users: remove `pirc-chat` package references and `services.pirc.chatPackage`;
   use `nodePackage` for both roles. `services.pirc.chat = true` now adds the
   `chat` argument. The unit names remain `pirc` and `pirc-node`.
7. Start the new gateway and all nodes in the same window. Protocol **9 and 10
   cannot mix**: the gateway closes mismatches with **4426**. Deploy the web bundle
   and check every expected node is online in `GET /api/nodes`.
8. Re-pair devices, re-login subscription backends, recreate UI-managed providers,
   enable push again (fresh VAPID keys), and start **new sessions**. Recreate
   schedules, projects, memories and other state deliberately; there is no import.
9. Test a trivial prompt and sandbox/browser operation on each role. Deployment
   and real-provider smoke tests are operator actions, not performed by cutover.

The remaining paid PTC/task-time and provider-login gate was **waived by the user**,
not passed. See [the decision and accepted gaps](../history/rust-rewrite.md#m9-cutover).

### Rollback across the cutover

Stop every new process first. Restore the **entire old release and matching old
state backups together**, including old chat binaries, provider settings and web
assets. Never run the TS binaries against Rust state or restore an old DB into
an active Rust service. Keep the fresh Rust state separately if it is needed for
inspection; there is no downgrade/import of sessions created after cutover.

## Later upgrades within the Rust release line

Keep gateway and nodes on the same release. Changes to
`crates/pirc-protocol/src/lib.rs`'s `NODE_PROTOCOL_VERSION` require a coordinated
restart. Node/agent changes require upgrading each node; gateway/provider changes
require the gateway; web changes require only the static bundle. Read each
release's migration notes before assuming a forward schema migration is supported.

- `models.json`: SIGHUP / `systemctl reload pirc`; invalid content keeps the last
  valid settings. Environment changes require a process restart.
- Agent config/prompts/skills: next agent start.
- Web-managed providers: apply immediately; affected in-flight inference cancels.
- While a node restarts, agents get `PIRC_SHUTDOWN_GRACE_MS`, then are killed;
  interrupted runs need a new prompt.
- Back up state before upgrading. Restore matching state with older binaries;
  SQLite has no automatic down-migration.

Dependency updates: refresh `cargoHash` in `nix/package.nix` after `Cargo.lock`
changes and `nodeModulesHash` in `nix/web.nix` after `bun.lock` changes. Build both
packages to verify fixed-output hashes; never commit a placeholder hash.
