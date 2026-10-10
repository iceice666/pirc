# Backup and recovery

## What to back up

Two kinds of state exist, and they are not interchangeable.

### Gateway (`$PIRC_STATE_DIR` of `pirc-gateway`)

| Path                                | Holds                                                                                                                                                                                                                                                           | Loss means                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway.sqlite` (+ `-wal`, `-shm`) | Session index and ownership, pins/settled flags, leases, command outcomes, device tokens, assistant memory (USER/MEMORY, proposals, tombstones), delegations, schedules and run history, push subscriptions, workspace-memory mirror, chat project capabilities | Sessions vanish from every client until nodes re-register them (see below); memory, schedules, pairings and push subscriptions are gone. |
| `backends/settings.json`            | Web-managed backends and subscription OAuth tokens                                                                                                                                                                                                              | Log in / re-enter keys.                                                                                                                  |
| `vapid.json`                        | Push signing key                                                                                                                                                                                                                                                | Every device must re-enable notifications.                                                                                               |
| `local-node-token` (NixOS)          | The local node's secret                                                                                                                                                                                                                                         | Regenerated on next start; nothing else to do.                                                                                           |

### Node (`$PIRC_STATE_DIR` of each `pirc-node` or `pirc-chat`)

| Path                          | Holds                                                                                     | Loss means                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `sessions/<id>/session.jsonl` | **The conversations.** The node is the source of truth; the gateway holds only the index. | Those sessions cannot be opened or resumed.                                                               |
| `gateway.sqlite`              | The node's session metadata, runs, interactions, uploads, web-added workspaces            | Sessions become unknown to the node even if their JSONL survives.                                         |
| `uploads/`                    | Uploaded files                                                                            | Images in old messages no longer load.                                                                    |
| `workspace-memory/`           | Per-repository memory ledgers                                                             | New sessions lose their cross-session notes (the gateway's mirror keeps searchable copies without paths). |
| `chat/` (chat node)           | Chat workspaces, their sessions' working directories, project `instructions.md`           | Chats lose their files and instructions.                                                                  |
| `browser/`                    | Browser profiles (logins)                                                                 | Log in again in the agent's browser.                                                                      |

Workspaces (repositories) are not pirc state; back them up as you already do. `<workspace>/.pirc/` holds project config, uploads copied for the agent and recordings.

Every node also keeps `environment-journal.sqlite` (environment execution journal and durable workspace quarantines) and `writer-fences.sqlite` (legacy-writer deny fences and writer transfers). The node reloads their quarantines and fences before any runner or lease starts; never delete them to unblock a workspace.

### Opt-in gateway agent runtime

The [opt-in gateway runtime](topology.md#opt-in-gateway-agent-runtime-evaluated-not-deployed) is not deployed. If it is composed, the authority model changes and backups must follow it:

- Fresh sessions' **complete transcripts**, branches, turns, runs, executions, context snapshots, outbox, PTC store and central inner operations live in the gateway's `gateway.sqlite` (`runtime_*` and inner-journal tables). The gateway is then the source of truth for those conversations and retains them long-term; back it up and protect it like node transcripts.
- The gateway-side execution journal (Environment transport receipts, gateway-placed PTC outer records) is a separate SQLite file whose path the host's composer chooses; back it up together with `gateway.sqlite`.
- Node `environment-journal.sqlite` holds accepted/terminal executions, results awaiting gateway ACK and tombstones for IDs the node was asked about but never accepted; `writer-fences.sqlite` holds the fences that keep old writers from running. Back up gateway and node state from the **same quiesced point**, and never restore a node journal without the matching gateway state: a node answers "never accepted" from its journal, so an older journal could make the gateway record work as not started that actually ran.
- Legacy JSONL, branch caches and PTC stores stay on nodes untouched; they are not imported and are not a fallback.
- Restore never replays: interrupted runs and unacknowledged executions reconcile by original execution ID; unknown outcomes stay unknown.
- Client projection/outbox commits and node progress/operation events use WAL `synchronous=NORMAL`: a process crash loses nothing, but power or OS loss can drop a trailing suffix of them. After such a gateway restart, clients should reload from a snapshot (outbox cursor numbers may be reissued); a node may report a lower final event sequence for an execution recovered as unknown. Execution, transcript and result records stay fully synchronous.
- Restoring an older node `writer-fences.sqlite` removes legacy deny fences and re-enables old writers. That is only acceptable as the documented pre-write cutover rollback (see [Upgrades](upgrades.md#gateway-agent-runtime-cutover-not-authorized)), after revoking the fresh generation on both ends and verifying it has no writes. After the first fresh write there is no lossless rollback; never restore a reusable fresh writer generation.

## Taking a backup

SQLite runs in WAL mode; copy it with `sqlite3`'s backup API or after stopping the service, not with a bare `cp` of a live file.

```sh
# gateway host
systemctl stop pirc            # (NixOS) or the equivalent; nodes reconnect afterwards
tar -C /var/lib/pirc -czf pirc-daemon-$(date +%F).tgz daemon
systemctl start pirc

# online alternative for the database alone
sqlite3 /var/lib/pirc/daemon/gateway.sqlite ".backup '/backup/gateway-$(date +%F).sqlite'"

# a node
launchctl bootout gui/$(id -u)/dev.pirc.node-agent      # macOS
tar -C ~/.local/pirc-node -czf pirc-node-$(date +%F).tgz state
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.pirc.node-agent.plist
```

Backups contain conversations, memory and OAuth tokens: encrypt them and keep them off any world-readable share. Note that both databases keep tombstones and WAL pages of deleted rows; a backup is not a redaction boundary.

## Restoring

1. Stop the process.
2. Replace the state directory (or the database file plus its `-wal`/`-shm`, if any) with the backup, keeping the service account as owner (`chown -R pirc-gateway: /var/lib/pirc/daemon`, `chown -R pirc: /var/lib/pirc/node`) and mode `0700`.
3. Start the process. At startup, unfinished runs become `interrupted`, pending questions `stale`, leases are dropped, and dispatched-but-unacknowledged commands become `outcome_unknown`. Nothing is retried automatically.

### Gateway restored from an older backup

Nodes re-register their workspaces on reconnect. Sessions the gateway does not know about stay on the node's disk; they are not re-imported automatically. Inspect the node's `sessions` table to find them and decide whether to keep or archive them.

### Node restored from an older backup

The gateway may list sessions that the node no longer has; opening them fails with a not-found error from the node. Delete them from the gateway (below) or leave them.

### Moving a node to another machine

Copy the node's state directory and `PIRC_CONFIG_DIR`, keep the same `PIRC_NODE_ID` and token, and make sure workspace paths resolve to the same real paths (web-added workspaces are stored by canonical path). A different `PIRC_NODE_ID` makes every session a stranger to the gateway: workspace IDs are `<nodeId>:<workspaceId>`.

## Manual database surgery (last resort)

Stop the process and take a backup first. The gateway and each node have their own database; a session exists in both and both must be fixed.

- Gateway tables of interest: `workspaces`, `sessions`, `runs`, `commands`, `interactions`, `leases`, `uploads`, `device_tokens`, `memory_*`, `delegations`, `schedules`, `schedule_runs`, `push_subscriptions`, `workspace_capabilities` (`apps/gateway/src/database.ts` is authoritative).
- Foreign keys are on. Delete a session's `leases`, `interactions`, `commands`, `runs` before the `sessions` row.
- Gateway workspace IDs are `<nodeId>:<workspaceId>`; node ones are the bare `<workspaceId>`.
- Deleting a `device_tokens` row revokes that phone.
- The node's `sessions.private_session_path` names the transcript directory; rename rather than delete it until you are sure.
- Restore ownership and mode afterwards (`chown`, `0600`) and start the service.

```sh
sqlite3 /var/lib/pirc/daemon/gateway.sqlite    # or: nix shell nixpkgs#sqlite -c sqlite3 …
```

## Retention limits to know

- Schedule run history keeps the newest 50 runs per schedule (open and missed runs are never pruned).
- Forgetting an assistant memory entry deletes it and its history but keeps a hash tombstone so the same text is not re-added; the chats it came from stay on the chat node.
- There is no built-in session deletion or expiry; the state directories grow with use.
