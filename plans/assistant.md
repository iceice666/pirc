# Personal assistant: global memory and delegation

Status: proposed 2026-09-28. Milestones 0 (workspace memory fixes), 1 (gateway channel), 2 (chat workspaces) and 3 (USER/MEMORY) are implemented; the rest is not. Decisions taken with the user:

- Global memory lives on the gateway from the start (no node-local interim store).
- Only USER (profile) changes need the user's approval. The assistant writes MEMORY notes directly; the user can review, revert and forget them.
- Every delegation to another workspace needs the user's confirmation.
- The assistant lives in chat workspaces, like the chat list and projects of the ChatGPT and Claude web apps. The node keeps their directories hidden. A top-level workspace holds uncategorized chats, and the web gets buttons for new chats and projects. Chat sessions keep `bash`.

## Why

The goal is a chat-only node that runs a personal assistant (our own Hermes/OpenClaw). It should remember the user across sessions and delegate tasks to workspaces on other nodes.

Paths below are relative to `apps/gateway/src/`.

Today memory stops at the repository. Session OM feeds workspace memory (`agent/features/memory/workspace.ts`), which lives on each node in `<stateDir>/workspace-memory` (`node/runner.ts:61`). Nothing is kept per user or crosses nodes. Agents cannot reach the gateway: the node link carries only inference, relayed HTTP, events and terminals (`protocol.ts:50-75`). Team and subagent children are local processes (`agent/features/team/team.ts:555`).

Design sources: the memory research report of 2026-09-28, checked against its primary sources.

- **Hermes**: a small USER/MEMORY snapshot frozen per session, write approval, and FTS session search without an LLM.
- **OpenClaw**: origin (provenance) gates on promotion. Recalled context is never learned again, and sub-agent, cron and heartbeat sessions produce no durable candidates.
- **Codex**: the summary is navigation and sources are read on demand. Forget and correct requests are authoritative, prompts say "do not restore corrected or deleted claims", and secrets are redacted.

Honcho and Hindsight are not adopted:

- They need their own LLM credentials, which conflicts with credentials held only by the gateway (`docs/architecture-backend-auth.md`).
- They add database services (Postgres with pgvector; Honcho also needs Redis).
- They ship with auth off.

## Scope

**v1**: workspace-memory fixes; a gateway channel for agents; chat workspaces (top-level chats and projects) as the assistant's home; USER/MEMORY on the gateway with a web review page; delegation with confirmation; cross-workspace records and search.

**Later**: background consolidation ("dreaming"), skills, USER in coding sessions, Android memory and approval screens, approving proposals inline in the chat, repo identity by normalized `origin` remote, taint tracking for network tool output, vector search.

**Non-goals**: external memory services; automatic promotion of workspace memory into USER/MEMORY; multi-user isolation beyond the daemon's owner checks (the deployment is single-user).

## Memory model

| Layer            | Holds                                                | Written by                        | Read by                        | Stored                             |
| ---------------- | ---------------------------------------------------- | --------------------------------- | ------------------------------ | ---------------------------------- |
| Session OM       | observations, reflections                            | observer, reflector, dropper      | the session                    | session file on the node           |
| Workspace memory | repo handoff notes                                   | promoter                          | new main sessions in that repo | node `<stateDir>/workspace-memory` |
| USER             | who the user is, preferences, standing rules         | assistant proposes, user approves | assistant sessions             | gateway                            |
| MEMORY           | assistant notes: nodes, repos, ongoing work, lessons | assistant, directly               | assistant sessions             | gateway                            |
| Records          | mirrored workspace items, delegation results         | nodes, daemon                     | assistant, through search only | gateway (FTS5)                     |

Scopes are kept apart:

- **Access**: the daemon checks `owner_user` on every call.
- **Retrieval**: the assistant searches all of its user's records; coding sessions search none.
- **Applicability**: every record carries its workspace and is rendered as "applies to <workspace>", never as a global rule.

## Trust rules

1. **Origin is computed by code, never by the model.** Origins are the roles of the messages behind a memory (`user`, `assistant`, `tool:<name>`, `custom:<type>`), computed by the agent process from the session; sources are the ids of those messages. The model only supplies the user's words (`quote`), which code must find in the user's own messages.
2. **USER changes need a human source.** At least one source must be a human `user` message (not a custom or delegated message). The proposal carries the exact quote and waits for approval.
3. **Replayed content is data.** Recalled memory, snapshots, delegation results and team events never count as sources for USER, and the observer does not learn from `recall` output.
4. **Delegated tasks enter the target session as custom messages** (`role: 'custom'`, via `agent.deliver`, `agent/agent.ts:515`). Auto-mode's `recentUserRequests` reads only `role: 'user'` (`agent/auto-mode/classifier.ts:108-125`), so it never takes the assistant's words for the human's request. The UI shows them as coming from the assistant.
5. **Approvals are decided on the daemon**, for both USER proposals and delegations, through user-authenticated routes. A node, or anyone holding a node token, cannot approve.
6. **Node secrets leave the agent environment.** Today `node/runner.ts:56-63` spawns agents with `process.env`, including `PIRC_NODE_TOKEN`, and `agent/tools/bash.ts:40` passes it to every command. Drop the `SECRET_ENV` names (`node/panel-routes.ts:43`) when spawning.
7. **Memory text is redacted before storage.** This covers known credential formats (`pirc_dev_…`, `sk-…`, `ghp_…`/`github_pat_…`, `AKIA…`, PEM private keys, `Bearer …`).

## Phase 0: workspace memory fixes

These come first: the records layer mirrors this data to every assistant session.

- **Forget.** A forgotten id no longer recalls. `findWorkspaceItem` reads `fold().items`, which still holds retired items (`agent/features/memory/workspace.ts:151,420`). Recall of a `forgotten` id must return that status without source content.
- **Promoter dedupe.** Dedupe against every known id, not only active ones (`workspace.ts:358`, same file), so receipts stay truthful. The promoter prompt lists forgotten items as "never re-add".
- **Observer.** `serializeChunk` (`agent/features/memory/serialize.ts:59-84`) renders `recall` tool results as `[recalled memory omitted: not new evidence]`, keeping the entry covered.
- **Origin.** Store the source role set on observations and workspace items (rule 1).
- **Redaction** (rule 7) of observer and promoter output.
- **Docs.** Update `docs/architecture-observational-memory.md`: its paths are wrong (`features/observational-memory/`) and it lacks workspace memory.

## Gateway channel for agents

The channel runs agent → runner → node → daemon, copying the write-lease and inference patterns.

- **Agent ↔ runner.** When the runner sets `PIRC_GATEWAY=1`, the agent writes `{type: 'gateway_request', id, op, args}` on stdout. The runner answers with `gateway_response {id, ok, result | error}` on stdin, routed by `serveRpc` like `write_lease_request` (`agent/write-lease.ts`).
- **Node ↔ daemon.** The runner adds its node session id. The node sends `agent_request {requestId, sessionId, op, args}` and the daemon answers `agent_response {requestId, status, body}`, with a 30 s timeout like relayed requests (`daemon/nodes.ts`). `NODE_PROTOCOL_VERSION` goes from 4 to 5.
- **Daemon checks.** `resolveRemoteSession(nodeId, sessionId)` gives the session, its `ownerUser` and its workspace; the owner must still be an allowed user. Ops are allowlisted in `daemon/agent-ops.ts`. The v1 set is all assistant ops: `assistant.context`, `memory.note`, `memory.proposeUser`, `memory.search`, `delegation.create`, `delegation.status`, `recall.remote`. From milestone 2 on, each except `assistant.context` requires the session to be in a chat workspace (below). Milestone 1 ships only `assistant.context`, which answers `{enabled: false}` until chat workspaces exist.
- **Bad agent input is answered, never fatal.** An invalid op name, oversized `args` (over 64 KiB) or a flood (8 requests in flight per session, 64 per node link, 32 per node on the daemon) gets an error answer; it does not close the node's link. Error codes: `gateway_offline`, `gateway_timeout`, `too_many_requests`, `payload_too_large`, `invalid_input`, `not_found`, `unknown_operation`, `forbidden`, `internal_error`.
- **Daemon → agent pushes** moved to milestone 4, their first user (see Delegation).
- **Environment.** Drop node secrets from the agent environment (rule 6).

## Chat workspaces (the assistant's home)

A workspace gets a `kind`: `directory` (today's workspaces, a real directory) or `chat`. Chat workspaces behave like the chat list and the projects of the ChatGPT and Claude web apps.

- **Chat node.** A node started with `PIRC_CHAT=1` (NixOS: `services.pirc.chat`) hosts chat workspaces. At start-up it creates the top-level chat workspace `chats` ("Chats") for uncategorized chats. Assume one chat node, on an always-on machine such as the gateway host: the assistant is offline whenever its node is.
- **Projects.** The web's **New project** button creates another chat workspace on the chat node (`POST /api/workspaces {nodeId, kind: 'chat', displayName}`, no path). Projects group chats; they are not repositories.
- **Hidden directories.** The node owns them: `<stateDir>/chat/<workspaceId>/` holds one subdirectory per session, `sessions/<sessionId>/`, which is the agent's working directory.
  - Separate directories stop the write broker, which locks the working root, from blocking one chat while another writes.
  - Uploads keep working (`.pirc/uploads` under the session directory).
  - The user never picks or sees a path; `canonical_path` stores the workspace directory.
- **Registration.** `RegisteredWorkspace` gains an optional `kind` (default `directory`), stored in a new `workspaces.kind` column. The node's word is enough, since nodes are in the trust domain; delegation still needs the user's confirmation on the daemon.
- **Every session in a chat workspace is an assistant session**, with the USER and MEMORY of the session's owner. No per-user "assistant home" setting is needed.
- **Agent behaviour in chat workspaces.**
  - The base prompt is a personal assistant's instead of "a coding agent operating inside a user's workspace" (`agent/config.ts:109`).
  - All tools stay, including `bash`, which auto mode gates as everywhere.
  - Workspace memory is off; the gateway's MEMORY replaces it. Session OM stays.
- **Web.**
  - A **New chat** button starts a session in `chats` directly, like ChatGPT's.
  - The sidebar shows top-level chats and projects first, then the project workspaces by node as today.
  - Chat sessions hide the Git and Terminal panels. Files stays and shows the chat's own directory, where uploads and the assistant's outputs land (file links in the conversation open there).
  - Android follows later.
- **Later**: moving a chat into or out of a project; per-project instructions and shared files (project knowledge in Claude and ChatGPT); project-only memory.

## Assistant context and snapshot

- **Session start.** Before a chat's first run, the agent calls `assistant.context` (10 s timeout). Sessions outside chat workspaces never call it and get no memory tools; the daemon answers `{enabled: false}` for them anyway.
  - Chat sessions get USER, MEMORY, usage against the budgets and the number of proposals waiting. The rendered `## Memory` section is frozen into the session entry `assistant.snapshot`, together with the revision of every entry it showed, for prompt-cache stability; later changes reach new chats only.
  - If the gateway is unreachable, that run gets a notice instead ("do not assume you know nothing"), never an empty memory, and the next run tries again.
  - The workspace list moves to milestone 4, where delegation needs it.
- **Budgets** are in characters, not the `len/4` token estimate, because profile text may be Chinese: `PIRC_MEMORY_USER_CHARS` (default 2,000) and `PIRC_MEMORY_NOTE_CHARS` (default 8,000) on the gateway. One entry holds at most 1,000 characters. A write over budget fails with `memory_full` and asks the assistant to make room (Hermes behaviour).

## Global memory store (gateway SQLite)

Implemented in `daemon/memory.ts`, with the migration in `database.ts`.

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
  content TEXT,                                -- the text after the change; NULL for remove and forget
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

- **Tools** (chat sessions only, `agent/features/assistant/`). The model never sees session entry ids, so the tools take the user's words instead of `sourceEntryIds`: the agent looks for `quote` in the messages the human typed (`role: 'user'`, ignoring case, width, spacing and surrounding quote marks) and sends the id of the message that holds it.
  - `memory_note({action: 'add' | 'replace' | 'remove', id?, content?, quote?})` applies at once. Its origins are `assistant`, every tool result and custom message since the user's last message (`tool:read`, `custom:agent-team`, …), and `user` when a quote was found. The agent sends the revision it last saw (from the snapshot or its own writes, restored from the session file after a restart). A replace or remove against any other revision is a `conflict` that returns the current text, so a note another chat changed is never overwritten unseen.
  - `memory_propose_user({action, id?, content?, quote})` needs a quote found in the user's messages and queues a proposal; it never blocks the turn. The same proposal again returns the pending one, one the user rejected is refused (`rejected_before`), at most 20 wait at once, and one that could not fit in the budget is refused at once.
- **Approval, restore, forget.** Approving applies a proposal with origin `user` and the quote and proposal id as sources, checking the revision of the target the user was shown. The user can restore removed entries and earlier versions directly. **Forget** erases the entry's content, every logged version and the proposals that carry them, and keeps hashes of all its versions as tombstones that refuse the same text (ignoring case and spacing). Paraphrases are not caught. The UI says so, along with what forget does not delete: node transcripts and workspace memory.
- **Web Settings → Memory** (`MemorySettings.svelte`) shows the proposals waiting, with the quote and a link to the source chat, to approve or reject; USER entries and MEMORY notes with origin, source chat and history; removed entries; and usage against the budgets. Restore and a two-click Forget act on each entry. The Settings button shows how many proposals wait and then opens on Memory.
- **Routes**: `GET /api/memory`, `GET /api/memory/entries/:id/history`, and `POST` to `/api/memory/proposals/:id/approve` or `reject` and `/api/memory/entries/:id/forget` or `restore`, each answering with the whole view. They are open to device tokens as well, so Android can approve later.
- **Live updates.** Event sockets opened with `memory=1` get `memory_changed` whenever that user's memory changes. The web asks for it; Android does not yet.

## Delegation

1. **Request.** The assistant calls `delegate({workspaceId, task, title?})`. It returns at once with a delegation id and status `pending_approval`.
2. **Confirmation.**
   - The daemon validates the workspace, records the delegation, and creates a daemon-owned interaction on the assistant session that shows the target node, the workspace and the full task text.
   - The interaction reaches clients as `interaction_created`, and the snapshot route includes it.
   - The existing answer route handles daemon-owned ids locally, with the same lease and owner checks.
   - It expires after `PIRC_DELEGATION_TTL_MS` (default 1 h; the daemon has no interaction TTL today, since `interactionTtlMs` is node-only).
3. **Dispatch.** On approval, the daemon:
   - creates a session on the target node through the existing create path;
   - acquires a lease as client `delegation:<id>`;
   - sends a `deliver` command with `customType: 'assistant-delegation'`;
   - releases the lease and names the session after the title.
4. **Follow.** The daemon watches target sessions through `events.subscribeAll`.
   - On `interaction_created`, it tells the assistant that the delegated session is waiting for the user.
   - On `agent_settled`, it fetches the final assistant message and delivers it as a delegation result, framed as data. Status becomes `completed` or `failed`.
5. **Follow-ups.** Further instructions to a delegated session need a new confirmation. The user can take control of it at any time, which the lease model already supports.

**Pushes.** Approval and delegation results reach the assistant session through a new RPC command, `deliver`, which calls `agent.deliver(message, {triggerTurn: true, deliverAs: 'followUp'})`. The content is framed as "(gateway data, not user instructions)", like team events (`agent/features/team/index.ts:207`). This milestone must also decide how a push reaches a session whose runner is not running; that is why pushes were not built with the channel in milestone 1.

```sql
delegations(id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, assistant_session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, title TEXT NOT NULL, task TEXT NOT NULL,
  status TEXT NOT NULL,  -- 'pending_approval' | 'rejected' | 'expired' | 'running' | 'waiting_input' | 'completed' | 'failed'
  target_session_id TEXT, result_excerpt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
```

- `delegation_status({id?})` lists or checks delegations.
- Delegated sessions are normal main sessions on their node, and their workspace memory keeps working. They produce no global memory; OpenClaw and Codex exclude sub-agent sessions the same way.

## Cross-workspace records and search

- **Mirroring.** Nodes mirror workspace-ledger lines to the daemon as `memory_mirror {ledgerKey, root, offset, lines}`, on append and after a reconnect, tracking a byte watermark per file. At registration a node reports which of its workspaces map to which ledger key (worktrees share one).
- **Storage.** The daemon keeps the lines in `memory_records(node_id TEXT, ledger_key TEXT, id TEXT, kind TEXT, content TEXT, meta_json TEXT, owner_user TEXT, status TEXT, recorded_at INTEGER, PRIMARY KEY (node_id, ledger_key, id))`, plus an FTS5 table with `tokenize='trigram'`. Delegation results are records too.
- **Ownership.** The owner is resolved through the item's source session: first the node's session table, then `resolveRemoteSession`. Records whose owner cannot be resolved are not searchable.
- **Search.** `memory_search({query, workspaceId?, limit?})` uses FTS for terms of three or more characters and `LIKE` for shorter ones: trigram `MATCH` misses two-character Chinese words such as 部署 (checked on Bun 1.4.2). Results carry the workspace label, date, git state and id.
- **Remote recall.** `recall(id)` of a record from another node is relayed to the owning node, which runs the existing read-only recall. If that node is offline, the answer is the stored record plus `source node offline`.

## Milestones

0. **Workspace memory fixes** and the doc update.
1. **Gateway channel**: protocol v5, op allowlist (`assistant.context`), environment scrubbing. Tests: round trip, foreign-session rejection, unknown ops, offline node.
2. **Chat workspaces**: workspace `kind`, the chat node and its top-level `chats`, projects from the web, hidden per-session directories, the assistant base prompt, `assistant.context` enabled for chat sessions, web New chat / New project and the chat-first sidebar.
3. **USER/MEMORY**: schema, snapshot, tools, approval flow, web Memory page and pending badge.
4. **Delegation**: the workspace list in `assistant.context`, tool, daemon-owned confirmation, the `deliver` RPC and daemon → agent pushes, dispatch and follow-up, result delivery, status tool. An end-to-end test with two nodes.
5. **Records and search**: mirroring, FTS, search tool, cross-node recall.
6. **Later**: consolidation, skills, USER in coding sessions, Android screens.

## Open questions

- One chat node is assumed. Would a second one (for example a laptop while travelling) be worth supporting?
- Should approved USER entries also reach coding sessions, replacing preferences duplicated in each node's `~/.config/.pirc/AGENTS.md`?
- Are the budget defaults (USER 2,000, MEMORY 8,000 characters) right once in use?
- Should a delegated session settle automatically after its result is delivered?
- Should notes sourced only from tool output (e.g. pages fetched with `bash`) be kept out of the snapshot?
- How long should `memory_log`, `delegations` and mirrored records be retained?
