# Memory, repositories and workers

This reference describes the current Rust contracts. For session compaction and local repository handoffs, see [observational memory](observational-memory.md); for prompt composition, see [prompt context](prompt-context.md). Configuration and user workflows are in [Gateway and node](../development/gateway-and-node.md). The design is [direction §2.3–2.4](direction.md), [plans/rewrite/03-memory.md](../../plans/rewrite/README.md) and [04-open-loops.md](../../plans/rewrite/README.md).

## Three layers

The brain (the agent the gateway runs, [prompt context](prompt-context.md)) has the household's memory. Workers on the nodes have none of it ([direction §2.7](direction.md)); repositories keep their own workspace notes as a handoff between coding sessions.

| Layer                                       | Storage                                                               | Readers and writers                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Open loops (`open_loops`)                   | Gateway SQLite, the household's                                       | In every brain prompt. The brain opens, touches, changes and closes them without approval; the person closes or reopens them                |
| Facts (`memory_records`, `person`)          | Gateway SQLite, per person                                            | The brain writes them without approval (`remember`, observational-memory promotion); it and the person search them; the person forgets them |
| Preferences (`preferences`)                 | Gateway SQLite, per person                                            | In every brain prompt. The brain saves one only with a quote of the person's words; the person removes, restores and forgets them           |
| Repository notes (`memory_records`, `repo`) | Node workspace-memory ledger, mirrored to the gateway                 | Main coding sessions in that repository; the brain searches the mirror                                                                      |
| Session observations/reflections            | The session's ledger (node session, or the brain's room conversation) | The session's memory workers; recall reads retained branch sources                                                                          |

Prompts hold only the bounded layers: preferences (`PIRC_MEMORY_USER_CHARS`, default 2,000 characters per person; one entry at most 1,000) and open loops (at most 40, see below). Facts are many and stay out of the prompt; before each turn the brain's host searches them with what people just said and puts the closest six (300 characters each, with their origin) in a "You may remember" section. A recall that takes over 200 ms is left out and logged.

### Who a memory belongs to and where it came from

Code decides both, never the model's account:

- A fact's **origin** is `user` when only people's messages came since the last one in the room's conversation, else the latest tool result's origin (`tool:<name>`, `tool:bash:network` for a fetch; `origins.rs` `current_origins`). Facts from observational memory are `om:promoted`. Migrated MEMORY notes of the old assistant are `user` when their origins included it, else `tool:assistant`.
- A fact belongs to the turn's first speaker (a promoted observation: the room's latest speaker).
- A **preference** and a **forget** need a `quote`: the person's words in one of the last three messages of the room's conversation, matched as words (width, case, spacing, quote marks ignored). A quote of two characters or more may be part of a line; a shorter one (`ok`, `好`) must be all the person wrote. The line it is in says whose preference it is. So nothing the brain reads (a page, an email) can save a preference or make it forget.
- Each fact or preference the brain writes is said in the room as a line ("Noted: …", "Saved as a preference: …") carrying `{kind, id, origin, user}`; **Don't keep** on it forgets it.

Memory text is redacted before storage, on both the node and gateway. Redaction is best effort, not a guarantee that arbitrary secrets are detected.

### Forgetting

Forgetting a fact or preference (the person's **Forget** or **Don't keep**, or the brain's `forget` on their word) erases its text and logged versions, takes it out of the search index (merging the index segments, so `secure_delete` zeroes the pages) and rewrites the room lines that said it to "Forgotten.". Hashes of every version stay as tombstones that refuse the same text, as a fact or a preference, from then on. It does not erase the brain's room conversation on disk (the turn that said it), node transcripts or workspace memory, and cannot recognize paraphrases. A repository note is forgotten on its node (`/memory forget`), which the mirror follows.

Remove (preferences only) is reversible: the preference leaves the prompt and comes back with Restore.

### Open loops

An open loop is something still open between the brain and the people: "wants to tune the laptop's power policy", "team meeting every Wednesday at 18:00", "HW3 is due on 10/24". It is not a todo (a run's progress), a fact or a schedule. The brain opens one when something stays unresolved or someone asks to be reminded (`open_loop`), marks it mentioned (`touch_loop`), changes it (`update_loop`), closes it with a reason once it is resolved or someone says it no longer matters (`close_loop`), and opens a closed one again (`reopen_loop`). No approval: opening, closing and reopening are said in the room as lines carrying `{id, event}`, with **Don't keep** (closes it, "not needed any more") on an opening and **Not done yet** (reopens it) on a closing. Each loop records what, why, its room and face, an optional "next check" clue for a [wake](#waking-up), its owner (the turn's first speaker) and its origin, which code computes exactly as for facts (`user`, or `tool:<name>` when a tool result came since the person spoke).

All open loops of the household are in every brain prompt (`loops`, after the preferences), those whose time comes soonest first, then the most recently mentioned, with the time now so the brain can anchor new ones. Recall searches with what was said plus what the open loops are about. Past 40 open, the ones **without** a time anchor that were mentioned least recently are demoted before the prompt is built: closed as `demoted` and written as a fact of their owner's with the loop's origin, its source entries and `openLoopId`, said in the loop's room ("This sat untouched for a while, so I put it in memory: …"). Anchored loops are never demoted. Reopening a demoted loop takes that fact back (no tombstone).

A **time anchor** is one time `{at, zone, autoClose}` or a recurrence `{cron, zone, until?}` (`crates/pirc-gateway/src/time/cron.rs`; `zone` defaults to `PIRC_TIMEZONE`). A gateway timer fires them whether or not the brain runs: a time without `autoClose` is marked `passed` and waits for the people; a recurrence moves to its next time (`nextAt`, once from now after a suspended machine) and closes as `recurrence_ended` after `until`. Each time that comes wakes the brain in the loop's room ([waking up](#waking-up)); so does the day before an `autoClose` time (`noticeAt`, when that is more than a day away). A time with `autoClose` (the time is the thing itself: a meeting, a deadline) is marked `passed` and closes as `elapsed`, with a line, once its wake is over; without a brain, or with `PIRC_WAKES_PER_DAY=0`, it closes when it comes. The only ways a loop closes are the brain's judgement, the person's word, and its time.

A `tool:*` loop may lead to a read-only wake or a reminder, but never authorizes an action on its own: what acts for a person (a worker's request, a preference, a move, a new face) needs that person's quoted words.

### Waking up

The brain wakes without anyone asking (plans/rewrite/05-self-wake.md, `crates/pirc-gateway/src/wake.rs`): an open loop's time came (`anchor`, with `moment` `due`, `eve` for the day before an `autoClose` time, or `next` for a recurrence), it asked to come back (`self`: `schedule_wake {at, zone?, why, room?}`, one time, said in the room as "I'll come back … to look at: …" with **Cancel**; `cancel_wake {id}`), or a [source](../guides/rooms-and-memory.md#sources) changed (`source`). A wake is a turn of the room's conversation (`brain_turns.kind = 'wake'`), not a new session. Its input says what woke it and shows the room's latest ten messages; its prompt adds "Waking up" and the default "When to speak after waking" (decision #4: a loop's time always, the day before a deadline too; a source change only when it touches a loop or something the room follows; its own look only when it found something), after the room and before `CHAT.md`, so house rules and preferences override it.

A wake's replies are shown to nobody: it says something in the room only with `speak {text}`, a host message that also pushes to the person the wake is for (the loop's owner, or who was talking when it asked to come back), opening the room. Without `speak` it is silent: only memory and loop changes land, and the engine lists it. A conversation turn has no `speak`.

Wakes queue in the `wakes` table behind people: one starts only when no batch is ready and no turn runs. A batch that becomes ready while a wake runs stops it (`preempted`); it is put back once behind that turn (`attempt: 2`), and taken over again it ends `silent`; one that already spoke is `spoke`. At most `PIRC_WAKES_PER_DAY` (default 24) start per calendar day in `PIRC_TIMEZONE` (reset at local midnight; a preempted one does not count); past that, a due wake ends `quota` without starting. A loop's time whose wake ended `quota` or `failed` is still said ("Reminder: …"). A wake running at a restart ends `failed` (`interrupted`).

"Nothing writes unasked": a wake only reads and remembers. Tools that act for people (`stop_worker`, `move_room`, `create_face`, `topic`, `room_sources`) are not in a wake's tool list at all, and a worker's question cannot be answered from one; a worker a wake calls works read-only (see [Workers](#workers)).

`GET /api/wakes?status=pending|ended|all&room=&limit=` lists pending and running wakes (the next first) and/or ended ones (the latest first, `limit` 1–200, default 50), with `today: {used, limit}`. `DELETE /api/wakes/:id` cancels one that has not started (`409 wake_running` while it runs; an ended one is returned as it is); cancelling an anchor wake of an `autoClose` loop closes the loop. Every change is sent on the rooms' stream as `wake_changed {wake}`. Replies are `no-store`.

### Routes

`GET /api/loops?status=open|closed|all&limit=` lists open loops (all, in prompt order) or the latest closed ones (`limit` 1–200, default 50), with the limit 40. `PATCH /api/loops/:id` takes `{status: "closed", reason?}` (default reason "not needed any more"), `{status: "open"}` or `{anchor: {...} | null}` (an open loop's; `409 loop_closed` otherwise); a changed time is checked like the brain's (`400` "That time has passed"). Every change is sent on the rooms' stream as `loop_changed {loop}`. Replies are `no-store`.

`GET /api/memory` and `/api/memory/preferences` (the preferences page: active, removed, usage, room names), `GET …/preferences/:id/history`, `POST …/preferences/:id/{remove,forget,restore}`; `GET /api/memory/records?scope=person|repo|all&q=&limit=` (newest first, or search), `GET /api/memory/records/:id` and `…/history` (household facts), `DELETE /api/memory/records/:id` (forget a household fact). Replies are `no-store`; device tokens may use them.

## Agent gateway channel

Agent requests travel as JSONL `gateway_request`/`gateway_response` through the runner, then `agent_request`/`agent_response` over the authenticated node link. The node applies a 30-second timeout; arguments are capped at 64 KiB, with at most 8 requests per session, 64 pending on a node's forwarding channel and 32 per node at the gateway. Invalid input is a request error, not a fatal agent/link error. `memory.search`, `recall.remote` and `web.search` are the only operations (`agent_ops.rs`), not arbitrary gateway HTTP access. Node sessions never reach the household's facts or preferences; `memory.search` and `recall.remote` (repository notes only) are refused too, because no worker has a memory search tool (`memory/ops.rs`). Protocol mismatches close the node link with 4426; deploy compatible gateway/node builds together.

### Fetched-content provenance

A bash command naming a network fetcher or a URL is tagged `tool:bash:network`; PTC bash operations propagate that capability/taint. This is a coarse heuristic: scripts or build commands may fetch without naming a fetcher, and names may appear without a fetch. It is not complete data-flow tracking.

## Repository identity, mirroring and search

Two identities serve different purposes:

- The node's **workspace-memory ledger key** identifies a local repository root, shared by its worktrees. The node discovers it from repository files without running host git, validates worktree back-references, rejects unsafe file links and opens only the session's own ledger in its sandbox. See [workspace memory](observational-memory.md#workspace-memory).
- The gateway's **repository key** groups clones for search: the `origin` remote normalized to `host/path` by `pirc_protocol::normalize_origin`. Credentials, scheme, port, query and trailing `.git` are removed; local paths, file URLs, local-machine remotes and invalid keys yield no identity. It is metadata, not authorization.

For the latter, `pirc-node/src/repo.rs` reads only the workspace's own `.git` and its `gitdir:`/`commondir` config, never a parent repository, and never executes git on the host. Includes and `insteadOf` rewrites are ignored. Files must be regular, size-bounded and opened without taking a controlling terminal. A remote change is published on re-registration. Accepted limit: symlinked `.git` or absolute git-directory references may identify another readable repository; only the normalized key leaves the node, and it joins only the same user's records.

Nodes mirror ledger chunks with byte offsets and acknowledgements; reconnect resumes from the gateway watermark, shrunk ledgers reset, and malformed lines are skipped. Paths/worktrees are not included in mirrored git metadata. Ownership comes from the writing session known to the gateway; unknown-owner records are not searchable. Forget/clear records remove searchable content. Per-node storage is capped at 200,000 rows and 64 MiB of text.

### Search

One FTS5 index (`memory_records_fts`, `delegations_fts`; [memory search](../../plans/memory-search.md) phase 1) covers facts, repository notes and delegations. `memory/text.rs` `index_terms` folds text (NFKC, lowercase) and turns every run of Han, kana or Hangul into overlapping pairs plus its last character (`資料庫` → `資料 料庫 庫`); other text goes to the `porter unicode61` tokenizer as it is. A query becomes quoted phrases joined with `OR` (a Latin run is one phrase, so `search_in` is `search` then `in`; each pair of a spaceless run is its own phrase; a lone CJK character is a prefix), so FTS5 syntax in a query is never interpreted. Hits rank by how many of the query's phrases they hold, then BM25 (scaled per table so notes and delegations compare), a superseded note counting half, then active before superseded and newest. When the index finds nothing, the query's words of three characters or more (or with non-ASCII) are matched as substrings, for part of a hash or an identifier. The index is kept in the same transaction as every write and rebuilt at startup when `search_index_meta.version` differs from the gateway's `SEARCH_INDEX_VERSION`. An evaluation set (`memory_records/eval/`) measures recall@8 and MRR per query class.

Search keeps `owner_user` and status filters. The brain's `memory_search` covers the turn's people, `person` scope by default, `repo` or `all` on request; repository hits keep their “applies to workspace” labels rather than becoming global rules. A workspace filter (node sessions) also includes clones with the same repository key. `recall_note` (the brain) and `recall.remote` read a repository note's sources from its holding node after an ownership check; when that node is offline, they return the gateway copy explicitly labelled as such.

## Project links

A face's territory (plans/rewrite/10-faces.md) links it to directory workspaces (`project_links`, owned by the face since the chat projects were removed): people set them on the face's page (`PATCH /api/faces/:id` `territory.workspaces`, at most 50), the brain when it makes a face someone asked for. Links preserve their repository identity, cover other clones and may outlive a removed workspace.

Links are defaults and ordering, **not permissions**:

- A worker always names its workspace; the `workers` section lists the face's linked workspaces first, marked `yours` (another clone: `a clone of yours`).
- A topic about a linked workspace belongs in the face's rooms: the guards for suggesting a move look there.
- Search without a workspace tries the live linked workspaces/repositories first, then everything if empty. `everywhere: true` skips that preference; results say which scope was searched.
- Unlinked workspaces remain reachable.

## Node-local skills

Skills are configuration, not memory. `SKILL.md` directories load from `~/.agents/skills/`, then `$PIRC_CONFIG_DIR/skills/`, then `<workspace>/.pirc/skills/`, with later sources taking precedence. Repository skills belong to that workspace and are labelled untrusted repository content. Only their names, descriptions and paths are listed initially; the model reads a skill on demand or the user loads `/skill:<name>`. Loaded skill text is not new observer evidence. Skill directories are protected from agent writes and are not synced from the gateway.

## Roles and workers

The agent selects a named role, not a model or thinking level. Role files come from built-in `general`, node configuration, then workspace configuration; later files replace earlier roles wholesale, with source/override information exposed to the user. Invalid roles or model patterns with no catalog match fail rather than silently widening access. Model-pattern fallback is restricted to the expanded candidates and does not guarantee provider credentials or entitlement. See the [configuration reference](../development/gateway-and-node.md) and `crates/pirc-agent/src/roles.rs`.

### Workers

The brain calls workers ([plans/rewrite/06-workers.md](../../plans/rewrite/README.md)): `call_worker({task, workspace?, title?, read_only?, follows?, role?, quote?, attachments?, context?: {fact_ids, loop_ids}})`, `worker_status({id?, offset?})` and `stop_worker({id})`, gateway tools in `crates/pirc-gateway/src/brain/worker_tools.rs`. Its prompt lists the workspaces workers can go to (online or not, with their roles) and the workers not done yet. A worker starts at once, without anyone's approval; at most 4 run (2 of them called by a wake) and the rest wait their turn, as do those whose node is offline. The target is a directory workspace, or `scratch` (also when none is named): a fresh directory on a node that fits (`node_hint`, `gpu`; [nodes](../guides/modes.md)). A follow-up (`follows`) goes to a worker that ended, keeps its session and role, and cannot select another.

A worker gets no memory of the people. It is given the task; the facts and loops the brain names by id, packed as text with where each came from (`## Context from the assistant`); and, when a person asked for it, their own words: `quote` must be verbatim in one of their last three messages (checked like a preference's quote), which also says whom the worker works for, and reaches the worker's run as `details.userRequests` so its classifier reads those words (never the task) as their request. Otherwise it works for the turn's first speaker. Agent schemas reject model and thinking overrides; the role's model or the workspace default runs it. The gateway creates or reuses the session, applies the role (and `read-only` for a wake's worker), then delivers a custom `assistant-delegation` message without the user's control lease. Files people sent with the request go with the task: the files attached to the turn's messages travel without being named, `attachments` adds files from earlier messages by the upload ids the brain saw in the room, and each is copied into the worker's node session (and then into its workspace under `.pirc/uploads`, where the delivered task points). Only files attached to a message of that room are ever handed over; images stay in the room and are not passed on. Dangerous commands still wait for a person; those questions are shown in the worker's thread and answered there without a lease ([security decisions](security-decisions.md#workers-without-approval)).

Every worker is visible: the room gets the host's message about it (its anchor, whose status updates in place) with a thread under it, where its tool calls, its team's records (teammates and subagents, one level down) and its questions show; people can say more to it there. When it ends the room gets its report (up to 2,000 characters) or why it failed, with a push. The brain hears of it at its next turn in that room as a `worker-report` custom message after what people said, with up to 4,000 characters of the result; `worker_status` reads the stored result in 12,000-character chunks (stored results are capped and redacted). Results are gateway data, never instructions: a fact the brain keeps from a report or `worker_status` has origin `tool:delegation`. People talk to a worker in its thread; the engine shows its session read-only. Ended sessions are left in place. Workers may produce workspace memory, never the household's.

Finished worker records older than 90 days are pruned hourly unless a later worker follows them. This does not imply deletion of their node sessions, mirrored workspace records or forgotten-memory tombstones.

## Implementation and provenance

Primary contracts live in `crates/pirc-agent/src/origins.rs`, `features/memory/serialize.rs`, `crates/pirc-gateway/src/brain/memory.rs`, `crates/pirc-gateway/src/memory/`, `memory_records.rs` (and `memory_records/{index,person}.rs`), `delegations.rs`, `threads.rs`, `brain/worker_tools.rs`, `project_links.rs`, `crates/pirc-node/src/{repo,memory_mirror}.rs` and `crates/pirc-protocol/src/repo.rs`. Protocol versions and limits are defined in current Rust code; the old assistant plan's startup flags and protocol numbers are not current contracts.

The original design/decision record is retrievable without a working-tree archive:

```sh
git show af7074fc51742e79c8f0c76a9aaf64f80b414f7e:docs/history/assistant.md
```
