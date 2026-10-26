# Upgrades

## Unreleased: Node session creation ledger

Node schema **2004** adds durable, owner-scoped creation identities. Back up Node
state before upgrading; older executables refuse the migrated schema. Existing
sessions and workspace identities, memory, uploads, checkpoint data and pots
records are unchanged. Do not downgrade by changing `user_version`.

This is a local first-send foundation, not a deployment instruction or a complete
client workflow. The new Node-only `POST /api/session-creations` and
`GET /api/session-creations/:id` routes allocate/reconcile a session but do not
send a message or start an agent. Gateway and clients do not use them yet. The
allocation ledger stores only identifiers, a submission hash and creation state;
it survives deletion so old retries cannot recreate a deleted conversation.
`deleting` is distinct from `deleted`; neither allows reallocation.

The Node link envelope remains protocol **15**, with additive HTTP routes. The
existing pots requirement to upgrade compatible Gateway/Nodes together still
applies. Future first-send integration must detect an unsupported route and fail
closed; it must not silently use legacy non-idempotent creation. Existing session
commands and specialized schedule/delegation/checkpoint/pots flows are unchanged.
See the [implementation checkpoint](../../plans/unified-conversations.md#u1-implementation-checkpoint-node-allocation-2026-10-26).

## Unreleased: explicit pots execution

Back up both Gateway and Node state before upgrading. Gateway schema **1011**
fences the extended task lifecycle (the existing pots SQL tables are unchanged);
Node schema **2003** adds durable dispatch identities, immutable instructions and
send/control fences. Older executables refuse the migrated schemas. Node protocol
**15** requires updating Gateway and every Node together; do not mix protocol 14
and 15. Update Web/Android clients to expose explicit instruction-based Start.

This is a local implementation checkpoint, not a deployment instruction. Start
requires an enabled responsibility, resumed coordination, remaining dispatch and
concurrency budgets, current source evidence and a written user instruction. It
uses a new dedicated conversation in the same workspace, never answers the source
interaction, and does not enable autonomous dispatch. Unknown sends are not
automatically retried. See [pots](../guides/pots.md).

## 0.10.0: pots tracking and gateway schema 1010

This release adds an opt-in, progress-only **pirc pots** inbox. Back
up Gateway state before upgrading: schema **1010** adds durable responsibilities,
sourced suggestions and tracking tasks. Older Gateways refuse the newer schema;
installing an older executable does not reverse the migration. Existing sessions,
workspaces, removal markers, memory and schedules are retained. No existing user
is enrolled in observation and no execution grant is created by the migration.

Update the Gateway and client assets together when deploying this checkpoint.
Node schema and node protocol are unchanged. The extracted LLM libraries keep
the existing authenticated Node → Gateway inference route; project agents do not
receive provider credentials. Production agents now drive their existing run
through the generic loop, retaining host-owned policy, storage and notifications. See [pots](../guides/pots.md) for tracking-only controls and the explicit
execution-unavailable boundary. This change does not authorize a deployment.

## TLS trust update: October 2026

The Rust gateway's outbound HTTPS and the node's `wss://` connection use
Rustls with `rustls-platform-verifier`. On macOS, it delegates certificate
trust evaluation to Security.framework and Apple's current trust policy. On
Linux, it discovers the host CA bundle and WebPKI validates certificate paths
against those roots. Keep the operating system's trust data current as well as
the pirc dependencies.

The October 2026 eMudhra incident led to [RUSTSEC-2026-0382](https://rustsec.org/advisories/RUSTSEC-2026-0382.html),
which covers acceptance of paths through distrusted emSign intermediates, and
[RUSTSEC-2026-0383](https://rustsec.org/advisories/RUSTSEC-2026-0383.html),
which covers the bundled roots that allowed such paths. This update locks the
patched releases `rustls-webpki` 0.103.16 and `webpki-root-certs` 1.0.10. See
the [incident report](https://emudhra.we-have-a-problem.com/) for the CA event.
Build from the updated lockfile (`nix build .#pirc-gateway .#pirc-node` from
the pirc checkout, or use your deployment's equivalent builder), then replace
and restart the gateway and every chat and coding node, including remote nodes;
a reload does not replace the running TLS verifier.

On NixOS, the pirc repository's pinned flake inputs control its build and
development environment, while the running host's Linux CA bundle comes from
the host's NixOS generation. Updating the project flake alone does not refresh
that host bundle; update and verify the host's CA package and trust policy
separately. External tools such as `gh`, `git`, `curl` and Python have their
own TLS implementations and CA bundles; update them separately. Variables such
as `SSL_CERT_FILE` only affect clients that honor them; see the [sandbox `gh`
setup](sandbox-and-browser.md#https-with-a-token). The Android app uses its
separate OkHttp and Android trust path; this Rust dependency update does not
change it.

The offline regression test is
`cargo test --locked -p pirc-providers --test tls_distrust`. It explicitly trusts
the legacy fixture roots and requires the twelve public incident chains,
including AAA cross-signs, to fail with `CertDistrusted` at a fixed time within
their validity periods. A valid local test CA must still pass. On Linux this
also exercises the platform verifier; on macOS and Windows it exercises WebPKI
rather than the native OS trust service. This test does not validate the
deployed host's CA updates or any external command-line tool's trust store.

## Work workspace removal: gateway schema 1009

This update adds non-destructive **Remove workspace…** under a Work workspace’s Settings in the web app. Back up gateway state before upgrading: schema **1009** adds durable removal markers, and older gateways refuse the new schema. Deploy the updated gateway, web assets and coding nodes together. The node protocol and node schema are unchanged, but removal requires the new node idle-check endpoint; an older node fails closed without removing the workspace.

Removal retains files and history, pauses schedules and survives node reconnects. Restoring an eligible directory through **Add workspace** requires the updated node’s same-path restoration support. Per-session workspaces and configured paths outside the device home currently have no UI restore; read the confirmation and [workspace removal guide](../guides/session-ui.md#removing-a-work-workspace-web) before removing them.

## 0.9.3: memory, calendar and checkpoints

Upgrade the Gateway and every chat/coding Node together: **node protocol 14**
adds private checkpoint workspace registration. Mixed protocol versions are
refused. Back up both Gateway and Node state directories before upgrading;
these migrations are not reversible by installing an older binary.

The Gateway migrates to **schema 1008**: 1006 records memory digests, 1007 adds
calendar events, grants, proposals and reminders, and 1008 adds private recovery
workspace ownership. Earlier local preview databases that used 1006 for calendar
or 1007 for checkpoints are recognized and brought to the same schema without
removing schedules, events or recovery ownership. Nodes migrate to **schema 2002**
for checkpoint workspace/session adoption. Older binaries refuse the new schemas.

Repository memory now has a versioned journal separate from session handoffs.
Legacy records remain readable; existing ledgers stay read-only until explicit
cold activation with all older writers stopped. Deploying these binaries does
not activate memory automatically. Review [memory activation](../architecture/observational-memory.md)
and the panel's activation status before synchronizing. Isolated recovery
sessions do not inherit the source workspace's memory or enable its writers.

The calendar adds user-owned events, recurrence exceptions, independent Agent
grants, confirmation proposals and reminder delivery attempts. Existing schedules
and runs remain intact; legacy run origins remain unknown. See
[Calendar](../guides/calendar.md) for behavior and limits. Checkpoint recovery
creates a separate workspace and requires review before continuing; it does not
restore files into the original directory or undo external side effects.

The TLS rebuild/restart and host trust-store instructions above also apply to
0.9.3.

## 0.9.0 / 0.9.1: mode tabs by capability, delegation approval, node protocol 13, gateway schema 1005

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
