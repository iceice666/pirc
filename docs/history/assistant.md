# Assistant memory and delegation: implementation history

Historical implementation record from the assistant v1 plan (2026-09-29, with later role updates). Version numbers, startup flags and UI descriptions below are snapshots, not current deployment instructions. See [current guides](../README.md), [active assistant roadmap](../../plans/assistant.md), and [observational-memory architecture](../architecture/observational-memory.md).

- Global memory lives on the gateway, not on any node.
- Only USER (profile) changes need the user's approval. The assistant writes MEMORY notes directly; the user can review, revert and forget them.
- Every delegation to another workspace needs the user's confirmation. No allowlist replaces it.
- The assistant lives in chat workspaces (top-level chats and projects, as in the ChatGPT and Claude web apps). The node keeps their directories hidden. Chat sessions keep `bash`.
- Nothing that the node token can reach may act as agent authorization; approvals are decided on the daemon through user-authenticated routes.

Design sources: Hermes (frozen USER/MEMORY snapshot, write approval, search without an LLM), OpenClaw (origin gates on promotion; recalled context is never learned again; sub-agent sessions produce no durable memory), Codex (summary as navigation, sources read on demand, forget is authoritative, secrets redacted). Honcho and Hindsight were rejected: they need their own LLM credentials, extra databases, and ship with auth off.

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

`agent/features/memory/workspace.ts`. Fixed for v1: a forgotten id no longer recalls (status only, no content); the promoter dedupes against every known id and is told never to re-add forgotten items; observations and items carry their origin roles. Known limits: open-session snapshots and retained source data are not erased by forget, and a paraphrased re-add is not caught. Documented in `docs/architecture/observational-memory.md`.

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

## Skills

Agent Skills (`SKILL.md` directories) load from three sources, lowest precedence first: the node's `~/.agents/skills/` (a personal directory shared with other agent harnesses such as OpenClaw and Hermes), the node's `$PIRC_CONFIG_DIR/skills/`, then `<workspace>/.pirc/skills/`. The first two reach every session on that node, chats included; the last only that project's sessions. Only name, description and path are in the system prompt; the model reads a skill on demand, or the user loads one with `/skill:<name>`. First cases: `moodle-cli` (its npm package ships a `SKILL.md`) and PDF text extraction, forms and OCR on the chat node. Skills are node-local configuration, not memory: the observer sees a loaded skill as `[Skill loaded: name]`, never its text, and the file tools cannot write skill directories. Skills are not synced from the gateway; a skill a chat needs must be installed on the chat node (`services.pirc.skills` plus the programs in `extraPackages`).

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

## Roles and model ownership (shipped 2026-10-01)

Roles replace agent-supplied model/thinking choices for subagents, teammates and delegations. Implemented in `agent/roles.ts`, `agent/agent.ts`, `agent/features/team/`, `daemon/agent-ops.ts` and the delegation dispatch path.

- A role is `<name>.md`: optional YAML front matter (`description`, `model`, `thinking`, `tools`) and an instruction body. The built-in `general` is lowest precedence, followed by `$PIRC_CONFIG_DIR/roles/` and `<workspace>/.pirc/roles/`; later files replace the entire earlier role. Names are lowercase letters, digits, `-` and `_`; descriptions are limited to 500 characters, instructions to 8,000, and model patterns to 20. Workspace `.pirc/` and node role directories are protected from agent writes. Legacy JSON `roles` and `features.agentTeam.kinds` are ignored with a startup warning.
- The `role` parameter selects a named role. A role may set a model pattern/list, thinking level, tool allowlist and instructions; team coordination tools remain available to teammates. A missing/invalid role or a role whose model patterns match no gateway catalog model fails rather than widening access or silently choosing a model.
- `*` matches within provider/model-id parts. Patterns expand in pattern order and then gateway catalog order, deduplicated. The agent starts on the first match and immediately advances on retryable errors (HTTP 408/409/429/5xx, rate limit, overload, timeout/network/drop) before text is emitted. It stays on the selected fallback for the rest of the session; only the last candidate uses normal retries. A model selected outside the role's expanded candidates disables role fallback. Fallback therefore depends on the gateway catalog and does not guarantee that credentials or provider entitlements are available.
- Agents cannot set `model` or `thinking` through `subagent`, `agent_spawn`, `delegate`, or `schedule`; the tool and daemon schemas reject those fields. The user sets them in role files, delegation approval cards, or schedule settings. Delegation confirmation choices are persisted and applied before delivery, including approved follow-ups.
- Delegation role catalogs and descriptions are advertised by each workspace node at registration. They do not refresh during a live connection; reconnect/re-register to publish role-file changes. The daemon rejects a role not in the target workspace's advertised catalog.

## Delegation

`daemon/delegations.ts`; tools in `agent/features/assistant/index.ts`.

1. `delegate({workspace, task, title?, role?})` or `delegate({follows, task})`. `workspace` is a directory workspace's id or an unambiguous name; its node must be online; at most 10 wait per user. Returns `pending_approval` at once. `role` names a markdown role (`roles/<name>.md`, see README) that the target workspace's node advertised when it registered (the catalog is not refreshed while connected); an unknown role is rejected, and a follow-up keeps its session's role, so `role` with `follows` is rejected. The tool lists each workspace's roles and descriptions. **Agents never pass `model` or `thinking`**: `delegate`, `subagent`, `agent_spawn` and `schedule` reject them, and only the user picks models.
2. The daemon records the delegation in its own `delegations` table (not `interactions`, which node disconnects and restarts stale) and shows a `confirm` interaction (Delegate / Don’t) in the chat with workspace, node, title, role and the whole task. The card has model and thinking selectors (between the expiry label and the Don’t button; they stack above only when the width is too small); the user's choice rides on the answer, is validated against the gateway's models, and is stored with the delegation. The existing answer route decides it on the daemon after lease and owner checks. It lapses after `PIRC_DELEGATION_TTL_MS` (default 1 h).
3. On approval the daemon creates a session on the target node (or reuses the followed one), names it after the title, and pushes the task as `assistant-delegation`, "approved by the user". The node sends `set_role`, then the user's model/thinking override, before delivering; follow-ups apply the stored model/thinking too. Browsers reload through `directory_changed`.
4. The daemon follows the session's events; a pending interaction there is `waiting_input` (once per wait); once the run is over, `completed` with the last assistant answer after the task (matched by `details.delegationId`) or `failed`. Results are redacted and capped at 4,000 characters, and reach the chat as `assistant-delegation-update` ("gateway data, not user instructions"); an update that cannot reach the chat's node is retried after `node_reconnected`.
5. Follow-ups need their own approval. The user can take control of a delegated session at any time. `delegation_status({id?, offset?})` shows one or the recent ones; a long result is kept whole and read in 12,000-character chunks from `offset`.

Delegated sessions are normal main sessions with workspace memory; they produce no global memory. Auto mode treats a dangerous command there as needing the user's confirmation, and the chat is told the session is waiting (see roadmap item 7).

```sql
delegations(id TEXT PRIMARY KEY,                -- d + 8 hex
  owner_user TEXT NOT NULL, assistant_session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, title TEXT NOT NULL, task TEXT NOT NULL,
  follows TEXT,
  role TEXT,                                    -- role the new session starts in (migration)
  model_json TEXT, thinking TEXT,               -- the user's choice on the approval card
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
