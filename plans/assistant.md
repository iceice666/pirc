# Personal assistant: global memory and delegation

Status: v1 shipped 2026-09-29 (`5e1ebb9` USER/MEMORY, `4becbec` delegation, records and search after it). The implementation record is in [assistant history](../docs/history/assistant.md); the roadmap below retains the order and authorization gates agreed with the user on 2026-09-29. Paths are relative to `apps/gateway/src/`.

Decisions taken with the user, which later work must keep:

- Global memory lives on the gateway, not on any node.
- Only USER (profile) changes need the user's approval. The assistant writes MEMORY notes directly; the user can review, revert and forget them.
- Every delegation to another workspace needs the user's confirmation. No allowlist replaces it.
- The assistant lives in chat workspaces (top-level chats and projects, as in the ChatGPT and Claude web apps). The node keeps their directories hidden. Chat sessions keep `bash`.
- Nothing that the node token can reach may act as agent authorization; approvals are decided on the daemon through user-authenticated routes.

Design sources: Hermes (frozen USER/MEMORY snapshot, write approval, search without an LLM), OpenClaw (origin gates on promotion; recalled context is never learned again; sub-agent sessions produce no durable memory), Codex (summary as navigation, sources read on demand, forget is authoritative, secrets redacted). Honcho and Hindsight were rejected: they need their own LLM credentials, extra databases, and ship with auth off.

## Roadmap

Ordered by value against cost. Item 1 is implemented and user-accepted (2026-10-03, Asia/Taipei); items 2–6 retain planned work (per-project instructions in item 5 are implemented); 7 is a decision to take; 8 waits for evidence from use. Each item needs the user's go-ahead before implementation.

## 1. Approve USER proposals in the chat

`memory_propose_user` now creates an Approve / Reject card in its originating chat. Settings → Memory remains another place to decide. User acceptance passed on 2026-10-03 (Asia/Taipei).

- When a proposal is created from a chat, the daemon publishes a `confirm` interaction (Approve / Reject) in that chat, showing the action, the proposed text, the current text for a replace, and the quote. The answer route applies the existing approve/reject on the daemon after the same lease and owner checks.
- The proposal stays in `memory_proposals`, which is the source of truth; the interaction is a view of it, so a node disconnect or gateway restart does not cancel a pending proposal (the lesson from delegations). Answering in Settings resolves the chat interaction and vice versa.
- The assistant is told the result through the next run's context, not through a push: nothing in the proposal flow should start a turn.
- Web: the confirmation renders multi-line text already; add labels. No new routes.

### Source-chat deletion (user-approved extension)

The web chat list and project page offer **Delete chat**. The same confirmation warns that deleting the chat also forgets the USER and MEMORY entries it originally created and deletes its proposals. Settling a chat still only archives it.

- Creation provenance is stored separately from revision sources and backfilled from the original `add` log. Editing another chat's entry or deduplicating an add does not transfer ownership of its origin.
- `DELETE /api/sessions/:id` checks ownership, requires an online chat node, fences new work durably, stops the runner and closes its browser/terminals, then erases the private transcript/OM and chat working directory. Directory-workspace deletion is outside this item.
- The gateway forgets every revision of the source entries, removes their contents and histories, retains content hashes against exact re-adds, and deletes source proposals in the same database transaction as session removal. Other chats' entries are preserved. Pending proposals about forgotten entries are also redacted/resolved.
- Lost acknowledgements can be retried. Deletion intent survives restarts, blocks session writes and late agent events, and a completed DELETE is idempotent. The chat stays listed for retry until cleanup completes.
- Existing copies in other chats' frozen snapshots/transcripts, external files, backups, and the owner-wide upload store are not retroactively scrubbed. This follows the existing forget boundary; the dialog discloses copies in other chats. Exact-content tombstones cannot prevent paraphrased re-learning.

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
- **Per-project instructions.** A project (chat workspace) gets an instructions text, edited from the web on the project, stored by the node in `<stateDir>/chat/<workspaceId>/instructions.md` and rendered into the chat's system prompt. No memory scope changes. Implemented; see `plans/project-isolation.md` (“Per-project instructions”).

## 6. Link projects to workspaces

A project is usually about one or a few repositories. Today its assistant sees every directory workspace and must name one on each `delegate`. A link records which workspaces a project is about. It is a default and an ordering, never a permission: every delegation still needs the user's confirmation, and an unlinked workspace stays reachable.

- **Storage.** On the gateway, `project_links(project_workspace_id, workspace_id, repo, created_at)`, edited from the project's settings in the web (a "Linked workspaces" multi-select next to item 5's instructions). `repo` is item 4's normalized `origin`, so a link also covers other clones of the same repository; ship after item 4, or store the workspace id alone and backfill `repo` later.
- **Context.** `assistant.context` in a project lists linked workspaces first in `## Workspaces`, marked "linked to this project", with node and online state. A linked workspace that is offline or deleted stays listed and is marked so, not dropped silently. Links changed later reach new chats only (the snapshot is frozen).
- **Delegation.** `delegate` without `workspace` uses the only linked workspace; with several linked it asks the assistant to name one. The confirmation shows the target as always.
- **Search.** `memory_search` in a project searches linked workspaces (and their `repo`) first, and all of the user's records when asked or when nothing is found.
- **Not in this item.** Reading a linked repository's files from the project without delegating would need a read-only gateway op (`workspace.read`) routed by the daemon to the target node after an owner check, returning tool data (`tool:*` origin, never a USER source) with no paths leaving the node. Build it only if chats keep delegating just to look at a file. Running a project inside the repository directory is rejected: it would merge chat isolation, the write broker and workspace memory with the assistant's; item 2 brings USER to coding sessions instead.

## 7. Decisions to take

- **Auto mode in delegated sessions.** Today a dangerous command waits for the user in the delegated session and the chat is only told that it waits. Keeping this is the safe default (trust rule 4). An alternative to offer: a checkbox on the delegation confirmation, "treat this task as my request for auto mode", which would let the task text count as a `recentUserRequest` in the target session for that run only. Leaning: keep the default and offer the checkbox, since the user has already read the whole task when approving.
- **Settling delegated sessions.** After a result is delivered the session stays as it is. Either it is settled automatically so lists show it as finished, or it is left for the user to continue. Leaning: leave it, but show the delegation status in the session list.
- **Retention.** `memory_log`, `delegations` and `memory_records` grow without bound. Propose: keep logs for forgotten entries only as tombstones (already), prune `delegations` older than 90 days that are not the target of a `follows`, and keep records as long as the ledger has them.

## 8. Watch, do not build yet

- **Consolidation ("dreaming").** Only needed if `memory_full` becomes frequent at 8,000 characters. Rewriting notes with an LLM must keep origins (trust rule 3: consolidated text may not gain `user` origin it did not have) and should run on the gateway with the observer's model. Wait for evidence from use, and revisit the budget defaults first.
- **Moving chats between projects, project-only memory, shared project files.** Not painful with a handful of chats; project-only memory would add a scope column to `memory_entries` and a second snapshot section.
- **Vector search.** `LIKE` search over a few thousand notes is fine, and FTS5 trigram would not fix short CJK queries. Revisit only when searches miss.
- **A second chat node.** Assumed single; the memory is on the gateway, so a second node would mostly need its own `chats` workspace and a rule for which one New chat uses.
