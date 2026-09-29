# Personal assistant: global memory and delegation

Status: v1 shipped 2026-09-29 (`5e1ebb9` USER/MEMORY, `4becbec` delegation, records and search after it). Part 1 describes what runs today, checked against the code; part 2 is the roadmap in the order agreed with the user on 2026-09-29. Paths are relative to `apps/gateway/src/`.

Decisions taken with the user, which later work must keep:

- Global memory lives on the gateway, not on any node.
- Only USER (profile) changes need the user's approval. The assistant writes MEMORY notes directly; the user can review, revert and forget them.
- Every delegation to another workspace needs the user's confirmation. No allowlist replaces it.
- The assistant lives in chat workspaces (top-level chats and projects, as in the ChatGPT and Claude web apps). The node keeps their directories hidden. Chat sessions keep `bash`.
- Nothing that the node token can reach may act as agent authorization; approvals are decided on the daemon through user-authenticated routes.

Design sources: Hermes (frozen USER/MEMORY snapshot, write approval, search without an LLM), OpenClaw (origin gates on promotion; recalled context is never learned again; sub-agent sessions produce no durable memory), Codex (summary as navigation, sources read on demand, forget is authoritative, secrets redacted). Honcho and Hindsight were rejected: they need their own LLM credentials, extra databases, and ship with auth off.

# Part 1: what exists

## Memory model

| Layer            | Holds                                                | Written by                        | Read by                        | Stored                             |
| ---------------- | ---------------------------------------------------- | --------------------------------- | ------------------------------ | ---------------------------------- |
| Session OM       | observations, reflections                            | observer, reflector, dropper      | the session                    | session file on the node           |
| Workspace memory | repo handoff notes                                   | promoter                          | new main sessions in that repo | node `<stateDir>/workspace-memory` |
| USER             | who the user is, preferences, standing rules         | assistant proposes, user approves | chat sessions                  | gateway SQLite                     |
| MEMORY           | assistant notes: nodes, repos, ongoing work, lessons | assistant, directly               | chat sessions                  | gateway SQLite                     |
| Records          | mirrored workspace items, delegations                | nodes, daemon                     | chat sessions, by search only  | gateway SQLite                     |

Scopes are kept apart: the daemon checks `owner_user` on every call; chat sessions search all of their user's records while coding sessions search none; every record carries its workspace and is shown as "applies to <workspace>", never as a global rule.

## Trust rules

1. **Origin is computed by code, never by the model.** Origins are the roles of the messages behind a memory (`user`, `assistant`, `tool:<name>`, `custom:<type>`); sources are their ids. The model only supplies the user's words (`quote`), which code must find in the human's own `role: 'user'` messages, not in custom, delegated or teammate messages. Mutation tests showed `findQuote` and the `workspace.kind !== 'chat'` check in `daemon/agent-ops.ts` are load-bearing.
2. **USER changes need a human source** and wait for approval with the exact quote.
3. **Replayed content is data.** Recalled memory, snapshots, delegation results and team events never count as sources for USER; the observer renders `recall` results as `[recalled memory omitted: not new evidence]`.
4. **Delegated tasks enter the target session as custom messages** (`role: 'custom'`), so auto mode's `recentUserRequests` (only `role: 'user'`) never takes the assistant's words for the human's request.
5. **Approvals are decided on the daemon**, for USER proposals and delegations alike. A node, or anyone holding a node token, cannot approve.
6. **Node secrets leave the agent environment.** `node/secrets.ts` strips `SECRET_ENV` (`PIRC_NODE_TOKEN(S)`, `PIRC_*SECRET*`) before spawning agents.
7. **Memory text is redacted before storage** (`pirc_dev_…`, `sk-…`, `ghp_…`/`github_pat_…`, `AKIA…`, PEM keys, `Bearer …`), on both node workspace memory and gateway memory.

## Workspace memory (node)

`agent/features/memory/workspace.ts`. Fixed for v1: a forgotten id no longer recalls (status only, no content); the promoter dedupes against every known id and is told never to re-add forgotten items; observations and items carry their origin roles. Known limits: open-session snapshots and retained source data are not erased by forget, and a paraphrased re-add is not caught. Documented in `docs/architecture-observational-memory.md`.

## Gateway channel for agents

Agent → runner → node → daemon, modelled on the write lease. With `PIRC_GATEWAY=1` the agent writes `gateway_request {id, op, args}` on stdout and reads `gateway_response {id, ok, result | error}`; the node forwards `agent_request`/`agent_response` with a 30 s timeout. `NODE_PROTOCOL_VERSION` is 6 (5 added the channel, 6 added mirroring); a node on another version is closed with code 4426, so gateway and nodes deploy together.

- **Ops** (`daemon/agent-ops.ts`): `assistant.context`, `memory.note`, `memory.proposeUser`, `memory.search`, `delegation.create`, `delegation.status`, `recall.remote`. All but `assistant.context` require the session's workspace to be a chat workspace; `resolveRemoteSession` gives the owner, who must still be an allowed user.
- **Limits.** Bad input is answered, never fatal: 64 KiB per `args`, 8 requests in flight per session (`node/runner.ts`), 64 per node link (`node/agent-gateway.ts`), 32 per node on the daemon (`daemon/nodes.ts`). Errors: `gateway_offline`, `gateway_timeout`, `too_many_requests`, `payload_too_large`, `invalid_input`, `not_found`, `unknown_operation`, `forbidden`, `internal_error`.
- **Pushes** (daemon → agent): the node route `POST /api/sessions/:id/deliver`, callable only by the daemon, starts the agent if needed and sends the RPC command `deliver`, which calls `agent.deliver(message, {triggerTurn: true, deliverAs: 'followUp'})`. It takes no control lease, so a push never takes a chat away from the user typing in it. Custom types are limited to `assistant-delegation` and `assistant-delegation-update`.

## Chat workspaces

A workspace has a `kind`: `directory` or `chat` (`workspaces.kind`). A node started with `PIRC_CHAT=1` (NixOS `services.pirc.chat`) is the chat node: it creates the top-level workspace `chats` at start-up and hosts projects created from the web (`POST /api/workspaces {nodeId, kind: 'chat', displayName}`). It hosts chat workspaces only: it refuses directory workspaces from `POST /api/workspaces` and fails at start-up when `PIRC_WORKSPACES` is set, and the web leaves it out of **Add workspace**. One chat node on an always-on machine is assumed; the assistant is offline when it is.

- **Directories** are the node's: `<stateDir>/chat/<workspaceId>/sessions/<sessionId>/` is each chat's working directory, so the write broker never blocks one chat with another, and uploads land in `.pirc/uploads` under it. The user never sees a path.
- **Every session in a chat workspace is an assistant session** with the owner's USER and MEMORY. The base prompt is an assistant's, all tools stay (auto mode gates `bash` as everywhere), workspace memory is off and the gateway's MEMORY replaces it, session OM stays.
- **Web** (`lib/chats.ts`): **New chat** starts a session in `chats`; **New project** creates a chat workspace; the sidebar lists chats and projects first, then directory workspaces by node; chat sessions hide Git and Terminal, and Files shows the chat's own directory.

## Assistant context and snapshot

Before a chat's first run the agent calls `assistant.context` (10 s timeout). Chat sessions get USER, MEMORY, usage against the budgets, the number of proposals waiting and the directory workspaces with their node and online state. The rendered `## Memory` and `## Workspaces` sections are frozen into the session entry `assistant.snapshot` with the revision of every entry shown, for prompt-cache stability; later changes reach new chats only. An unreachable gateway yields a notice ("do not assume you know nothing"), never an empty memory, and the next run tries again. Other sessions get `{enabled: false}` and no memory tools.

Budgets are in characters, because profile text may be Chinese: `PIRC_MEMORY_USER_CHARS` (default 2,000) and `PIRC_MEMORY_NOTE_CHARS` (default 8,000) on the gateway; one entry holds at most 1,000. A write over budget fails with `memory_full` and asks the assistant to make room.

## Global memory store (gateway SQLite)

`daemon/memory.ts`, migration in `database.ts`.

```sql
memory_entries(id TEXT PRIMARY KEY,            -- u… (USER) or n… (MEMORY) + 8 hex
  owner_user TEXT NOT NULL, kind TEXT NOT NULL, -- 'user' | 'note'
  content TEXT NOT NULL,                       -- '' once forgotten
  status TEXT NOT NULL,                        -- 'active' | 'removed' | 'forgotten'
  revision INTEGER NOT NULL, origins_json TEXT NOT NULL, sources_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
memory_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_user TEXT NOT NULL,
  entry_id TEXT NOT NULL, revision INTEGER NOT NULL,
  op TEXT NOT NULL,                            -- add | replace | remove | restore | forget
  content TEXT,                                -- text after the change; NULL for remove and forget
  origins_json TEXT NOT NULL, sources_json TEXT NOT NULL,
  actor TEXT NOT NULL,                         -- 'user:<name>' | 'session:<gateway session id>'
  at INTEGER NOT NULL)
memory_proposals(id TEXT PRIMARY KEY, owner_user TEXT NOT NULL,
  action TEXT NOT NULL,                        -- 'add' | 'replace' | 'remove'
  target_id TEXT, target_revision INTEGER, content TEXT, content_hash TEXT,
  quote TEXT NOT NULL, sources_json TEXT NOT NULL, session_id TEXT NOT NULL,
  status TEXT NOT NULL,                        -- 'pending' | 'approved' | 'rejected'
  created_at INTEGER NOT NULL, decided_at INTEGER)
memory_tombstones(owner_user TEXT NOT NULL, content_hash TEXT NOT NULL,
  forgotten_at INTEGER NOT NULL, PRIMARY KEY (owner_user, content_hash))
```

- **Tools** (`agent/features/assistant/index.ts`, chat sessions only). `memory_note({action: 'add' | 'replace' | 'remove', id?, content?, quote?})` applies at once; origins are `assistant`, every tool result and custom message since the user's last message, and `user` when the quote was found. The agent sends the revision it last saw; any other revision is a `conflict` returning the current text, so a note another chat changed is never overwritten unseen. `memory_propose_user({action, id?, content?, quote})` needs a quote in the user's messages and queues a proposal without blocking the turn; a duplicate returns the pending one, a rejected one is refused (`rejected_before`), at most 20 wait, and one over budget is refused at once.
- **Approval, restore, forget.** Approval applies with origin `user`, checking the revision the user was shown. Removed entries and earlier versions can be restored. **Forget** erases the entry's content, every logged version and the proposals carrying them, and keeps hashes of all versions as tombstones refusing the same text (case and spacing ignored). Paraphrases are not caught; the UI says so and lists what forget does not delete (node transcripts, workspace memory).
- **Web Settings → Memory** (`lib/memory.ts`, `MemorySettings.svelte`): proposals with quote and source chat, entries with origin and history, removed entries, usage, restore and two-click forget. The Settings button carries the pending count and opens on Memory.
- **Routes** (`daemon/memory-routes.ts`): `GET /api/memory`, `GET /api/memory/entries/:id/history`, `POST /api/memory/proposals/:id/{approve,reject}`, `POST /api/memory/entries/:id/{forget,restore}`; open to device tokens. Event sockets opened with `memory=1` receive `memory_changed`.

## Delegation

`daemon/delegations.ts`; tools in `agent/features/assistant/index.ts`.

1. `delegate({workspace, task, title?})` or `delegate({follows, task})`. `workspace` is a directory workspace's id or an unambiguous name; its node must be online; at most 10 wait per user. Returns `pending_approval` at once.
2. The daemon records the delegation in its own `delegations` table (not `interactions`, which node disconnects and restarts stale) and shows a `confirm` interaction (Delegate / Don’t) in the chat with workspace, node, title and the whole task. The existing answer route decides it on the daemon after lease and owner checks. It lapses after `PIRC_DELEGATION_TTL_MS` (default 1 h).
3. On approval the daemon creates a session on the target node (or reuses the followed one), names it after the title, and pushes the task as `assistant-delegation`, "approved by the user". Browsers reload through `directory_changed`.
4. The daemon follows the session's events; a pending interaction there is `waiting_input` (once per wait); once the run is over, `completed` with the last assistant answer after the task (matched by `details.delegationId`) or `failed`. Results are redacted and capped at 4,000 characters, and reach the chat as `assistant-delegation-update` ("gateway data, not user instructions"); an update that cannot reach the chat's node is retried after `node_reconnected`.
5. Follow-ups need their own approval. The user can take control of a delegated session at any time. `delegation_status({id?})` shows one or the recent ones.

Delegated sessions are normal main sessions with workspace memory; they produce no global memory. Auto mode treats a dangerous command there as needing the user's confirmation, and the chat is told the session is waiting (see roadmap item 6).

```sql
delegations(id TEXT PRIMARY KEY,                -- d + 8 hex
  owner_user TEXT NOT NULL, assistant_session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, title TEXT NOT NULL, task TEXT NOT NULL,
  follows TEXT,
  status TEXT NOT NULL,  -- 'pending_approval' | 'rejected' | 'expired' | 'running' | 'waiting_input' | 'completed' | 'failed'
  target_session_id TEXT, result TEXT, notified_status TEXT,
  expires_at INTEGER NOT NULL, dispatched_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
```

## Cross-workspace records and search

`node/memory-mirror.ts`, `daemon/memory-records.ts`.

- **Mirroring.** Each node reads the ledgers in `PIRC_WORKSPACE_MEMORY_DIR` every `PIRC_MEMORY_MIRROR_MS` (default 30 s). The gateway sends its byte offset per ledger at registration (`registered.mirrors`); the node sends `memory_mirror {ledgerKey, offset, end, reset?, lines}` (256 KiB max), waits for `memory_mirror_ack {ledgerKey, watermark}`, resends after 60 s, and restarts a ledger that shrank. Chunks not starting at the stored offset are ignored and the ack says where to resume; bad lines are skipped.
- **No paths leave the node.** Items name the node session that wrote them, and git state drops the worktree.
- **Storage** applies lines like `foldWorkspace` (first record wins; `superseded`, `forgotten` erases and keeps the id, `cleared`). Owner and workspace come from `resolveRemoteSession`; items whose session the gateway does not know have no owner and are never found. Forgetting a note on the node removes it from search.
- **Search.** `memory_search({query, workspace?, limit?})` finds notes (current and superseded) and delegations holding any of up to 8 query words (`LIKE`), ranked by matched words, then current before superseded, then newest. No FTS5: the corpus is small and a trigram index misses two-character Chinese words such as 部署.
- **Remote recall.** `recall(id)` in a chat for an unknown id goes `recall.remote` → the holding node's `POST /api/workspace-memory/recall` (gateway-only), which runs the read-only recall if the user owns the writing session. With the node offline the gateway's copy is returned, marked as such.

```sql
memory_mirrors(node_id, ledger_key, watermark, updated_at, PRIMARY KEY (node_id, ledger_key))
memory_records(node_id, ledger_key, id, content, relevance, recorded_at, git_json, source_ids_json,
  origins_json, node_session_id, session_id, workspace_id, owner_user,
  status,                                      -- 'active' | 'superseded' | 'forgotten'
  PRIMARY KEY (node_id, ledger_key, id))
```

# Part 2: roadmap

Ordered by value against cost. Items 1–5 are planned; 6 is a decision to take; 7 waits for evidence from use. Each item needs the user's go-ahead before implementation.

## 1. Approve USER proposals in the chat

Today `memory_propose_user` returns `pending` and the user must open Settings → Memory. The proposal should appear in the chat where it was made, as delegation confirmations do.

- When a proposal is created from a chat, the daemon publishes a `confirm` interaction (Approve / Reject) in that chat, showing the action, the proposed text, the current text for a replace, and the quote. The answer route applies the existing approve/reject on the daemon after the same lease and owner checks.
- The proposal stays in `memory_proposals`, which is the source of truth; the interaction is a view of it, so a node disconnect or gateway restart does not cancel a pending proposal (the lesson from delegations). Answering in Settings resolves the chat interaction and vice versa.
- The assistant is told the result through the next run's context, not through a push: nothing in the proposal flow should start a turn.
- Web: the confirmation renders multi-line text already; add labels. No new routes.

## 2. USER in coding sessions

Open question answered: approved USER entries should reach coding sessions and replace the preferences duplicated in each node's `~/.config/.pirc/AGENTS.md`.

- `assistant.context` for a directory-workspace session returns `{enabled: true, user, memory: null, workspaces: null}`; the agent renders `## User` only, frozen in the snapshot like a chat's. No memory tools are added: coding sessions read USER and never write it, and `memory.note`/`memory.proposeUser` keep rejecting them.
- Delegated sessions get the same USER; the task stays a custom message, so nothing there can become a proposal source.
- Settings → Memory says that USER entries apply to every session on every node, so the user knows the blast radius of an approval.
- Gateway unreachable: the coding session runs without USER and says so once; it must never block a coding session.
- Migration for the user: a note in the README on moving personal preferences from `AGENTS.md` into USER, keeping repository rules in `AGENTS.md`.

## 3. Android memory and approvals

The routes are open to device tokens; Android lacks the screens.

- **Approvals first.** Once item 1 ships, a proposal is a `confirm` interaction, which Android already shows in a session. Verify the multi-line body renders and the labels are used. Delegation confirmations get the same check.
- **Memory screen.** A settings page backed by `GET /api/memory` and the approve/reject/forget/restore routes, with the same forget disclosure as the web. Subscribe with `memory=1` for `memory_changed` and show the pending count on the settings entry.
- **Chats in the sidebar.** The Android workspace list should show `chats` and projects first and offer New chat, mirroring the web; chat sessions hide Git and Terminal.

## 4. Repository identity by normalized `origin`

Records identify a workspace by gateway workspace id, so two clones of one repository (two nodes, or a clone next to a worktree) are different workspaces and `memory_search({workspace})` misses across them.

- Nodes send with each mirrored item a `repo` key: the `origin` remote URL normalized (scheme and host case, `ssh://git@`/`git@…:`/`https://` unified, `.git` and trailing slash dropped, user info and query removed). No path and no credential ever leaves the node; the normalization must strip `https://user:token@…`.
- `memory_records.repo` is added; search by workspace also matches records with the same `repo`, labelled with the workspace that wrote them. `assistant.context` lists the repo next to each workspace so the assistant can tell clones apart.
- Workspaces without a remote keep the current behaviour.

## 5. Network taint and per-project instructions

Two smaller items that can ship together or apart.

- **Taint (coarse).** Origins stop at `tool:bash`, which cannot tell `ls` from `curl`. The agent marks a bash result whose command contains a network fetch (`curl`, `wget`, `fetch`, `http(s)://`, `gh api`, …) as `tool:bash:network`, and the same for `code` calls that run such commands. Notes whose only origins are network-tainted are still stored but rendered in the snapshot with a "from fetched content" label, and the snapshot prompt tells the assistant to treat them as claims, not facts. Full data-flow tracking is out of scope.
- **Per-project instructions.** A project (chat workspace) gets an instructions text, edited from the web on the project, stored by the node in `<stateDir>/chat/<workspaceId>/instructions.md` and rendered into the chat's system prompt. No memory scope changes.

## 6. Decisions to take

- **Auto mode in delegated sessions.** Today a dangerous command waits for the user in the delegated session and the chat is only told that it waits. Keeping this is the safe default (trust rule 4). An alternative to offer: a checkbox on the delegation confirmation, "treat this task as my request for auto mode", which would let the task text count as a `recentUserRequest` in the target session for that run only. Leaning: keep the default and offer the checkbox, since the user has already read the whole task when approving.
- **Settling delegated sessions.** After a result is delivered the session stays as it is. Either it is settled automatically so lists show it as finished, or it is left for the user to continue. Leaning: leave it, but show the delegation status in the session list.
- **Retention.** `memory_log`, `delegations` and `memory_records` grow without bound. Propose: keep logs for forgotten entries only as tombstones (already), prune `delegations` older than 90 days that are not the target of a `follows`, and keep records as long as the ledger has them.

## 7. Watch, do not build yet

- **Consolidation ("dreaming").** Only needed if `memory_full` becomes frequent at 8,000 characters. Rewriting notes with an LLM must keep origins (trust rule 3: consolidated text may not gain `user` origin it did not have) and should run on the gateway with the observer's model. Wait for evidence from use, and revisit the budget defaults first.
- **Skills.** Undefined next to MEMORY notes, `AGENTS.md` and delegation. Needs a concrete case that none of them covers.
- **Moving chats between projects, project-only memory, shared project files.** Not painful with a handful of chats; project-only memory would add a scope column to `memory_entries` and a second snapshot section.
- **Vector search.** `LIKE` search over a few thousand notes is fine, and FTS5 trigram would not fix short CJK queries. Revisit only when searches miss.
- **A second chat node.** Assumed single; the memory is on the gateway, so a second node would mostly need its own `chats` workspace and a rule for which one New chat uses.
