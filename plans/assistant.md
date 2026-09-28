# Personal assistant: global memory and delegation

Status: proposed 2026-09-28. Milestone 0 (workspace memory fixes) is implemented; the rest is not. Decisions taken with the user:

- Global memory lives on the gateway from the start (no node-local interim store).
- Only USER (profile) changes need the user's approval. The assistant writes MEMORY notes directly; the user can review, revert and forget them.
- Every delegation to another workspace needs the user's confirmation.

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

**v1**: workspace-memory fixes; a gateway channel for agents; an assistant home workspace per user; USER/MEMORY on the gateway with a web review page; delegation with confirmation; cross-workspace records and search.

**Later**: background consolidation ("dreaming"), skills, USER in coding sessions, Android memory and approval screens, repo identity by normalized `origin` remote, taint tracking for network tool output, vector search.

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

1. **Origin is computed by code, never by the model.** Sources are session entry ids. The agent process resolves them to roles (`user`, `assistant`, `toolResult:<tool>`, `custom:<type>`) and stores that set.
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
- **Daemon checks.** `resolveRemoteSession(nodeId, sessionId)` gives the session, its `ownerUser` and its workspace. Ops are allowlisted, and v1 has only assistant ops: `assistant.context`, `memory.note`, `memory.proposeUser`, `memory.search`, `delegation.create`, `delegation.status`, `recall.remote`. Each requires the session's workspace to be its owner's assistant home.
- **Daemon → agent pushes.**
  - The daemon sends `agent_event {sessionId, event}`.
  - The runner forwards it as a new RPC command, `deliver`, which calls `agent.deliver(message, {triggerTurn: true, deliverAs: 'followUp'})`.
  - The content is framed as "(gateway data, not user instructions)", like team events (`agent/features/team/index.ts:207`).
- **Environment.** Drop node secrets from the agent environment (rule 6).

## Assistant home and snapshot

- **Home workspace.** Web **Settings → Assistant** picks one per user: `assistant_homes(owner_user TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, updated_at INTEGER NOT NULL)`.
- **Chat-only node.** It registers one workspace (e.g. `~/assistant`). Its `AGENTS.md` sets the persona; the base prompt still says "coding agent" (`agent/config.ts:109`).
- **Session start.** A fresh session calls `assistant.context`.
  - Non-home sessions get `{enabled: false}` and no assistant tools.
  - Home sessions get USER, MEMORY and the workspace list. The rendered text is frozen into a session entry, like `om.workspace.snapshot`, for prompt-cache stability; later changes reach new sessions only.
  - If the gateway is unreachable, the session gets a notice, never an empty memory presented as "nothing known".
- **Budgets** are in characters, not the `len/4` token estimate, because profile text may be Chinese. Defaults: USER 2,000, MEMORY 8,000, both configurable. A write over budget fails and asks the assistant to consolidate (Hermes behaviour).

## Global memory store (gateway SQLite)

```sql
memory_entries(id TEXT PRIMARY KEY, owner_user TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- 'user' | 'note'
  content TEXT NOT NULL, origin_json TEXT NOT NULL, sources_json TEXT NOT NULL,
  status TEXT NOT NULL,                  -- 'active' | 'forgotten'
  revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
memory_log(seq INTEGER PRIMARY KEY, owner_user TEXT NOT NULL, entry_id TEXT NOT NULL,
  op TEXT NOT NULL, before_json TEXT, after_json TEXT,
  actor TEXT NOT NULL,                   -- 'user:<name>' | 'session:<id>'
  at INTEGER NOT NULL)
memory_proposals(id TEXT PRIMARY KEY, owner_user TEXT NOT NULL,
  action TEXT NOT NULL,                  -- 'add' | 'replace' | 'remove'
  target_id TEXT, content TEXT, quote TEXT NOT NULL, sources_json TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,                  -- 'pending' | 'approved' | 'rejected' | 'expired'
  created_at INTEGER NOT NULL, decided_at INTEGER)
```

- **Tools** (assistant sessions only):
  - `memory_note({action: 'add' | 'replace' | 'remove', id?, content?, sourceEntryIds})` applies at once, with a revision check.
  - `memory_propose_user({action, id?, content?, sourceEntryIds})` queues a proposal and returns `pending`; it never blocks the turn.
- **Forget** deletes the content from the entry and its log rows. It keeps a content hash as a tombstone that rejects identical re-adds. Paraphrases are not caught. The UI says so, along with what forget does not delete: node transcripts and workspace memory.
- **Web Settings → Memory** shows:
  - USER entries;
  - pending proposals with the quote and a link to the source session, to approve or reject;
  - MEMORY notes with origin, sources and history, to revert or forget;
  - usage against the budgets.

  Routes live under `/api/memory*` and are open to device tokens as well, so Android can approve later.

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
1. **Gateway channel**: protocol v5, op allowlist, the `deliver` RPC, environment scrubbing. Tests: round trip, foreign-session rejection, unknown ops, offline node.
2. **Assistant home and USER/MEMORY**: schema, snapshot, tools, approval flow, web Settings → Assistant and Memory.
3. **Delegation**: tool, daemon-owned confirmation, dispatch and follow-up, result delivery, status tool. An end-to-end test with two nodes.
4. **Records and search**: mirroring, FTS, search tool, cross-node recall.
5. **Later**: consolidation, skills, USER in coding sessions, Android screens.

## Open questions

- Should approved USER entries also reach coding sessions, replacing preferences duplicated in each node's `~/.config/.pirc/AGENTS.md`?
- Are the budget defaults (USER 2,000, MEMORY 8,000 characters) right once in use?
- Should a delegated session settle automatically after its result is delivered?
- Should notes sourced only from tool output (e.g. pages fetched with `bash`) be kept out of the snapshot?
- How long should `memory_log`, `delegations` and mirrored records be retained?
