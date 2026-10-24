# Upgrades

## 0.10.0+harmony (the rewrite): pirc lives in the gateway

The rewrite does not upgrade old state: the gateway starts again from nothing,
and leaves the old database where it is. To move from 0.9.x:

1. Upgrade the gateway and every node together. The node protocol is **15**;
   the gateway closes a link of any other version (4426). The node
   database migrates to schema 2002 on first start (an older node refuses it).
2. The gateway starts a new database, `$PIRC_STATE_DIR/pirc.sqlite`
   (decision #14, [direction §6](../architecture/direction.md#6-開放的決定)). An existing `gateway.sqlite` is left
   exactly as it is, never read or changed, and the gateway logs one line saying
   so; back it up or delete it when you choose. A `PIRC_DATABASE_PATH` that
   points at the old file is refused; unset it or point it at a new path.
   Nothing moves over: pair phones again, enable notifications again, and let
   nodes re-register their workspaces. Sessions already on a node stay on its
   disk and are not re-imported. USER and MEMORY of the old assistant, chat
   projects and schedules are not converted; tell pirc again what matters.
3. Remove the chat node. `PIRC_CHAT` is refused, and on NixOS
   `services.pirc.chat` and `chatPackage` are gone. Copy `SOUL.md` and
   `CHAT.md` to the gateway's `PIRC_CONFIG_DIR` (on NixOS,
   `services.pirc.soulPrompt` / `chatPrompt` now link them there). See
   [gateway configuration](gateway.md#the-brain) for `brain.json`,
   `PIRC_WAKES_PER_DAY` and `PIRC_TIMEZONE`.
4. Add `modes/scratch.md` to an existing modes directory
   (`pirc-gateway modes --print-defaults` prints it) and reload, or the scratch
   workspaces stay unavailable. Mode files that name the removed capabilities
   (`assistant`, `delegate`, `schedule_scope`, `project_instructions`,
   `project_files`, `projects`, `delete_sessions`) or tools (`delegate`,
   `delegation_status`, `memory_note`, `memory_search`) no longer load.
5. The web opens on the rooms at `/` (`?room=<id>`); workspaces and sessions
   are under `/engine` (`/engine?session=<id>`, `/engine?open=memory`), so
   reverse proxies need the SPA fallback for `/engine` too
   ([reverse proxy](reverse-proxy.md) already falls back to `index.html` for
   every path). Update the Android app with the gateway: it follows the new
   API and no longer opens session conversations.
6. Add sources (mail, calendars, Moodle) in Settings → Models & sources; their
   credentials go to `$PIRC_STATE_DIR/sources/secrets.json`, which backups
   must include ([backup and recovery](backup-and-recovery.md)).

### If you ran a development build of the rewrite

Each plan of the rewrite migrated `pirc.sqlite` one schema further; an older
gateway refuses a newer schema. A gateway from the end of the rewrite migrates
any of them in order.

The brain answers in the rooms (plans/rewrite/02-brain-host.md): the gateway
now runs an agent loop itself, with the default model and no node. A
`pirc.sqlite` from before it (schema 1) gains the `brain_turns` table on first
start (schema 2); an older gateway refuses schema 2. `SOUL.md` and `CHAT.md`
moved from the chat node to the gateway's `PIRC_CONFIG_DIR`; copy yours there
(or set `services.pirc.soulPrompt` / `chatPrompt` again on NixOS, which now
link them into the gateway's config directory). Messages sent before the
upgrade that no turn took yet are answered after it starts.

The brain remembers (plans/rewrite/03-memory.md). On first start
`pirc.sqlite` migrates to schema 3 in one transaction: USER entries become
preferences, the old assistant's MEMORY notes become your facts (origin
`user` when they came from your words, else `tool:assistant`), only
Forget's tombstones are kept, and the search index is built (also rebuilt
whenever a gateway changes how it indexes). An older gateway refuses schema 3.
`PIRC_MEMORY_NOTE_CHARS` is gone; `PIRC_MEMORY_USER_CHARS` is now the
preference budget. The memory routes moved: `/api/memory/entries/:id/*` is
`/api/memory/preferences/:id/*`, and facts are under `/api/memory/records`.

The brain keeps open loops (plans/rewrite/04-open-loops.md). On first start
`pirc.sqlite` migrates to schema 4: the `open_loops` table, and
`memory_records.open_loop_id` for facts that were demoted loops. An older
gateway refuses schema 4. The routes are `/api/loops` and
`/api/loops/:id`; the rooms' stream gains `loop_changed`.

The brain wakes up on its own (plans/rewrite/05-self-wake.md). On first start
`pirc.sqlite` migrates to schema 5: the `wakes` table, and
`open_loops.notice_at` for the day before a deadline. An older gateway refuses
schema 5. `PIRC_WAKES_PER_DAY` (default 24, `0` off) limits it. The routes are
`/api/wakes` and `/api/wakes/:id`; the rooms' stream gains `wake_changed`.

The brain calls workers (plans/rewrite/06-workers.md). On first start
`pirc.sqlite` migrates to schema 6: `delegations.assistant_session_id` becomes
`room_id` (old rows keep their value), delegations gain `face_id`, `thread_id`,
`anchor_message_id`, `read_only`, `context_json`, `wake_id` and `note`, and the
`thread_messages` table holds the threads. An older gateway refuses schema 6.
Upgrade every node with the gateway: a node from before this change refuses a
read-only worker's task (`approvalMode`) and answers only confirmations from a
thread. Agents lose `delegate`, `delegation_status`, `memory_note` and
`memory_search` (a mode file naming them in `tools` no longer loads), and the
`delegation.*` gateway operations are gone. The routes are `/api/workers`,
`/api/threads/:id`, `/api/threads/:id/messages` and `/api/threads/:id/answer`;
the rooms' stream gains `thread_message` and `thread_message_updated`; a
session's snapshot no longer carries `delegations`.

Workers ask before two things only (plans/rewrite/07-red-lines.md): pushing,
publishing or otherwise sending something out, and leaving the sandbox. The
`features.autoMode.deny` list now refuses without asking, as do destroying or
reconfiguring the machine; destructive git inside the workspace runs. A
worker's confirmation is asked in its room too. Upgrade every node with the
gateway.

Nodes say what they can do (plans/rewrite/08-nodes.md): the node protocol
moves to 15 (registration drops `role` and gains `capabilities`); upgrade the
gateway and every node together, an older node is refused. `/api/nodes` lists
`capabilities` and `load` instead of `role`. The node database migrates to
schema 2002 (`sessions.read_only`: a wake's worker is read-only in its sandbox
too, for good); an older node refuses it. Nodes accept `directory` and
`scratch` by default and get a scratch workspace in `$PIRC_STATE_DIR/scratch`
(`PIRC_SCRATCH_RETENTION_DAYS`, `PIRC_MAX_RUNNING`). A new gateway seeds
`modes/scratch.md`; an existing modes directory is never changed, so add it
yourself (`pirc-gateway modes --print-defaults` prints it) and reload, or the
scratch workspaces stay unavailable. The sandbox no longer has protected paths
for chat projects' instructions, nor follows `SOUL.md` / `CHAT.md` links out
of a node's config directory to protect their targets (the brain's prompts live
on the gateway; the config directory itself stays read-only to agents).

The brain reads sources (plans/rewrite/09-sources.md): mailboxes over IMAP,
calendars, Moodle and workspaces, added in Settings → Models & sources. On first
start `pirc.sqlite` migrates to schema 7: the `sources`, `source_items` and
`source_items_fts` tables. An older gateway refuses schema 7. Credentials go to
`$PIRC_STATE_DIR/sources/secrets.json` (0600); back it up with the state
directory. The routes are `/api/sources` and below, reachable by device tokens
only with the backends' management grant. Nothing changes for nodes.

The brain speaks through faces (plans/rewrite/10-faces.md). On first start
`pirc.sqlite` migrates to schema 8: `faces` gains a role, a territory, the
host flag and archive/hide times; `project_links` is made again owned by faces
(nothing in `pirc.sqlite` ever wrote a chat project's link, so it was empty);
`room_messages` gains `topic`, and `room_topics` is new. An older gateway
refuses schema 8. The routes are `/api/faces` and below; `POST
/api/rooms/:id/move` takes an optional `topic`; the rooms' stream gains
`face_changed` and `face_presence`, and its `ready` frame `faces`. Nothing
changes for nodes.

The brain tells a room how its workers ended in its own words, in a turn of its
own when nobody speaks there first (plans/rewrite/06-workers.md). On first start
`pirc.sqlite` migrates to schema 10: `delegations.reported_at` is new (workers
that ended before are counted as told, since their room was shown their report),
and `brain_turns.kind` also takes `report`. An older gateway refuses schema 10.
Nothing changes for nodes.

A workspace is its face's to work in: the brain calls a worker in a face's
workspace (or a clone of its repository), or reads it, only as that face; as
another face the tool refuses and names whom to `speak_as`, so the hand-over
happens in the room. A workspace no face looks after is offered one once, in a
line in `#general`, when its node brings it. On first start `pirc.sqlite`
migrates to schema 11: the `face_offers` table. An older gateway refuses
schema 11. Nothing changes for nodes.

## 0.9.0: mode tabs by capability, delegation approval, node protocol 13, gateway schema 1005

Upgrade the gateway and every node together: the node protocol moves to 13
because the mode catalog the gateway sends no longer has `ui.group`. Protocol 12
nodes are refused by the new gateway and protocol 13 nodes by an older one.

On first start the gateway migrates its database from schema 1000–1004 to 1005:
`delegations` gains `dispatch`, `origins_json`, `quote` and `quote_entry_ids`,
and delegations that already started are marked `dispatch='approved'`. A 0.8.x
gateway refuses a database at schema 1005: back up its state directory if you may
need to roll back. Node schemas are unchanged; nodes gain the gateway-only
`relayed-answer` route that relayed delegation approvals need. Every chat
workspace keeps `delegation_approval: always` (the approval card) until you
change it.

**Breaking: remove `group:` from every mode file before upgrading.** Clients now
place a mode's workspaces by its `assistant` capability (`full`: Chat, `user`:
Work), so `ui.group` was removed. Mode files reject unknown fields: a file that
still contains `group:` is skipped with a warning naming it, and its workspaces
become unavailable (history readable, no new work) until you delete the line
and reload the gateway (SIGHUP). This includes the default `chat.md` and
`directory.md` the gateway created earlier and read-only directories provided
by Nix. Compare with `pirc-gateway modes --print-defaults`.

`GET /api/nodes` lists each node's accepted mode ids (`modes`). Web and Android
clients ask capabilities instead of the legacy `kind`, which stays in workspace
JSON for one more release.

## 0.8.0: gateway-owned workspace modes, node protocol 12

Upgrade the gateway and every node together. Protocol 11 nodes are refused by
the new gateway and protocol 12 nodes by an older gateway; the close reason
explicitly asks for a coordinated upgrade. Database schemas remain gateway
1004 / node 2001: the existing `workspaces.kind` text column now stores mode
ids without a data migration.

On first start the gateway creates `$PIRC_CONFIG_DIR/modes/chat.md` and
`directory.md` **only if the modes directory does not exist**. Existing
installs keep the same default behavior. If you provision a read-only config
directory (for example with Nix), provide the modes directory and both default
files yourself, or make its parent writable for initial creation. An existing
empty directory deliberately disables all modes; invalid files are skipped,
not replaced with defaults. Use `pirc-gateway modes --print-defaults` to inspect
the shipped files before upgrading.

Nodes default to accepting `chat` on `pirc-node chat`, `directory` otherwise.
Custom modes require `PIRC_MODES` on each intended node and a gateway mode file.
Nodes receive definitions only from the gateway; agents receive validated
`PIRC_MODE` JSON. Retired `PIRC_WORKSPACE_KIND` is refused by agents. SIGHUP
reloads modes as well as models; changed/removed modes stop affected agents,
close their terminals and cancel inference. Missing modes keep existing
session history readable but refuse new work. Changing workdir strategy does
not migrate data; incompatible existing layouts are refused.

Back up configuration as well as state before upgrading. Older executables
cannot understand custom mode ids safely: restore reviewed default mode ids
and matching configuration/state before downgrading. Do not run old binaries
against a store containing custom ids; old parsers silently treated unknown
ids as directory workspaces. No deployment or data rewrite is automatic.

See [Workspace modes](../guides/modes.md) for format, permissions and examples.

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
not passed. See [the cutover decision and validation scope](../development/historical-records.md#rust-cutover-and-validation-scope).

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
  valid settings. Modes reload independently: invalid mode files are omitted,
  a directory-level failure keeps the previous catalog. Environment changes
  require a process restart.
- Agent config/prompts/skills: next agent start.
- Web-managed providers: apply immediately; affected in-flight inference cancels.
- While a node restarts, agents get `PIRC_SHUTDOWN_GRACE_MS`, then are killed;
  interrupted runs need a new prompt.
- Back up state before upgrading. Restore matching state with older binaries;
  SQLite has no automatic down-migration.

Dependency updates: refresh `cargoHash` in `nix/package.nix` after `Cargo.lock`
changes and `nodeModulesHash` in `nix/web.nix` after `bun.lock` changes. Build both
packages to verify fixed-output hashes; never commit a placeholder hash.
