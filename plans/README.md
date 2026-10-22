# Open work

[Project](../README.md) · [Documentation](../docs/README.md) · [Historical records](../docs/development/historical-records.md) · [Rewrite](rewrite/README.md)

This is a work queue, not authorization. Each implementation needs the user's
go-ahead; nothing here authorizes deployment, paid evaluation, deleting state or
rerunning the `#[ignore]`d real-host-root tests.

## The rewrite

[The rewrite](rewrite/README.md) turned pirc into an assistant that lives in the
gateway ([direction](../docs/architecture/direction.md)). Plans 00–13 are done
(2026-10-20 to 2026-10-22); [its README](rewrite/README.md) keeps one line per
plan and how to read the full plan files (items, verification, differences from
the design, where each item of the previous queue went) from git. The current
behavior is in the [guides](../docs/guides/README.md) and the
[memory reference](../docs/architecture/memory.md).

Second steps the rewrite left for later, each needing its own go-ahead:

- **Research-mode browser** for the brain (plan 09, decision #8): a gateway → node
  browser context not bound to a session, with the browser action rule of plan 07.
  Node protocol 16. It brings the one planned exception to "credentials only in
  the gateway" (cookies in a node's browser profile); its security note goes into
  [security decisions](../docs/architecture/security-decisions.md) with it.
- **Gmail through its API** with a read-only OAuth scope and the user's own client,
  replacing app passwords. Open question from 09: whether the school's Google
  Workspace allows app passwords at all; if not, the school mailbox waits for this.
- **Repository-note search for workers.** Node sessions' `memory.search` and
  `recall.remote` stay refused (`crates/pirc-gateway/src/memory/ops.rs`) because no
  worker tool hands them out; searching repository notes is theirs to have
  (decided 2026-10-20). Decide the tool before building it.
- **Room attachment retention.** Room uploads stay in the gateway's state with
  no automatic cleanup, archived rooms included (plan 01 left the period open).
- **Engine Modes page** (low priority): a read-only list of modes, their source
  files and validation warnings, which are only logged today. Then retire the
  `kind` the gateway still derives in workspace JSON, once no client reads it.

## Orthogonal work

1. **Android decisions and follow-up.** The [mobile plan](mobile.md) holds native
   content compatibility, physical acceptance of the rooms and room-flow
   integration tests against an isolated gateway. Decide token rotation before the
   30-day limit versus monthly re-pairing (including A7's near-expiry warning),
   sideload-only versus F-Droid/Play distribution and the production identity, and
   whether the native Context inspector (an engine view) comes later or never.
2. **Workspace-memory search, phase 2.** [Memory search](memory-search.md): phases
   0–1 (evaluation set, FTS5 + BM25 with CJK pairs) landed with the rewrite's plan
   03 and now serve the brain's facts and automatic recall. Phase 2, optional hybrid
   semantic search configured on the backend settings page (decision #6), needs
   the go-ahead and a choice of embeddings endpoint, because it sends note text
   there.
3. **GPU access in the sandbox.** [Sandbox GPU](sandbox-gpu.md), phase by phase
   with the user's go-ahead. A node's declared `gpus` are hardware facts; the brain
   should choose a GPU machine by whether its sandbox reaches the GPU
   (`capabilities.sandbox.gpu`, false until this lands).
4. **Rust post-cutover verification.** See manual validation below.

## Manual validation

Attach these to the release that needs them; they are not new feature tasks.
Synthetic, fake-model and emulator coverage does not close real-model,
real-account or physical-device gaps.

- **The rewrite, with a real model** (each plan's "手動" check, not run):
  - 00: gateway + one node; a directory workspace, a session, `bash`, a terminal,
    the Git panel.
  - 02: three short messages in `#general` answered once after the pause; one sent
    during the reply is taken into it.
  - 03: "I use TLP" shows a line; a week later "what do I use for power
    management?" is answered without asking it to search.
  - 04: "team meeting every Wednesday at 18:00" shows the next time; "that one is
    not needed" closes it.
  - 05: "remind me to drink water in 30 minutes" speaks in the room with a push;
    "I'll look at your dotfiles later" can be cancelled.
  - 06: "run the tests in pirc" calls a worker with a thread, and the result comes
    back to the room.
  - 07: a worker's `git push` asks in the room and pushes after "yes"; `rm -rf ~`
    is refused without a question.
  - 08: with a mac and a Linux node, "look at pirc's README on the mac" uses
    `workspace_read`; "run the tests" picks the idle machine.
  - 09: real Gmail (personal and school), a calendar and Moodle: a mail to yourself
    reaches `source_items` within 5 minutes; a related loop speaks, else silence;
    pause stops reading.
  - 10: asking the host about a project hands it to its face; 15 messages on a
    topic lead to one move suggestion.
  - 11: desktop and phone widths: send, a face answers, a worker's thread, undoing
    a line, answering a question, a session in the engine, a notification opening
    its room.
- **Push:** installed-PWA push on a real iPhone (Add to Home Screen) opening the
  room.
- **Browser:** real Android takeover (tap mapping, IME, drag scrolling) and WebM
  playback.
- **Sandbox (NixOS/Linux):** a full agent session, browser included, on a
  non-container x86_64 host at native speed; boot-time tmpfiles behavior on a
  real host. Earlier module/LXC/QEMU validation is complete. The `node_browser`
  conformance suite cannot start Chromium inside the agent sandbox used for the
  rewrite; it was not run there.
- **Mobile:** the physical acceptance and integration tests in [mobile](mobile.md).
- **PTC:** Anthropic direct calls with `null`/extra arguments; a real model reading
  the newer agent-data fences. macOS OpenAI Responses/Chat Completions runtime
  checks were completed, but reviewed behavior changes were not re-measured.
- **Rust post-cutover:** investigate if the one-off, unreproduced
  `node_link_side_runs` CI timeout recurs. TLS, a real identity provider, phone
  pairing, push and terminals are not covered by the macOS end-to-end checks.
  The macOS v0.4.1/v0.5.0 archives are unsigned and not notarized.

## Accepted limitations — not new work

- **Security:** single-user gateway model, S10 (host atomic replacement detaches a
  protected Linux mount) and S18 (browser WebSocket/non-HTTP egress and DNS
  rebinding) stay accepted; the browser action rule is an action classification,
  not a network boundary. A new domain for a worker's sandbox is sending something
  out and is asked each session; lasting allows belong in
  `sandbox.network.allowedDomains`. Linux socket hiding covers sockets bound at
  plan time, not sockets bound later or in another network namespace. Workers
  without approval, the two red lines, memory without review, read-only wakes and
  untrusted sources carry the residual risks in
  [Security decisions](../docs/architecture/security-decisions.md); do not reopen
  them without a new decision.
- **Repository identity:** normalized repository keys preserve path case, so
  `github.com/Owner/Repo` and `github.com/owner/repo` differ. `.git` symlinks and
  absolute `gitdir:` / `commondir` are followed; only the normalized key leaves
  the node.
- **Browser:** teammates/subagents have no browser; the screenshot action log is
  memory-only and lost on node restart.
- **PTC (accepted P3):** bash writes through a symlink created in the same command
  can skip the write lease. Plain bash output remains unlabelled (network fetcher
  or URL commands and `agent_inbox`, `board_read` are tagged). Guests inherit
  agent sandbox rights. The approval convention does not enumerate host-gated
  operations. Operations ignoring abort may outlive the five-second grace; an
  agent crash mid-script is reported to the model as “interrupted”. Queued
  operations count toward progress and eight long waits can fill all slots.
- **Rust post-cutover, waived not passed:** full PTC/task-time comparison with the
  TypeScript baseline, real-provider smoke tests and polyglot evaluation.
  Reopening needs an agreed protocol, budget and credentials (historical tooling
  at `2d480d3`). Never delete old state without approval: the rewrite's gateway
  leaves the old `gateway.sqlite` in place ([upgrades](../docs/deploy/upgrades.md)).

## Watch, do not build yet

- **Consolidation (“dreaming”):** only if the active observation pool still fills
  often after facts are promoted out of it; revisit budgets first. Keep origins:
  consolidated text must not gain `user` origin.
- **Vector index (sqlite-vec / ANN):** brute-force cosine is planned in
  [memory search](memory-search.md) phase 2; revisit an index only at the
  thresholds listed there.

## Retired

Plans and queue items the direction made obsolete, with where to read them:

- **Delegation autonomy, phase 3** (session allows, soft/hard danger): workers run
  without approval and ask only at the two red lines. Phases 0–2 live on in the
  workers and their security note. `git show 64ce7b9^:plans/delegation-autonomy.md`.
- **Project-only memory (B):** memory belongs to the brain, not a room, and face
  tags are for retrieval and display, not isolation (direction §2.2, §2.8).
  `git show c483379:plans/README.md` (Shelved section).
- **A second chat node:** there is no chat node. Same file, Watch section.
- **Chat/Work tabs and the rest of modes phase 3** (tab by `assistant`, Android
  scratch parity capture, guide screenshots): the apps are room-first and workers live in the engine. Modes
  phases 1–3 are in `git show 89ddeea:plans/modes.md`; the mode files themselves
  are in the [modes guide](../docs/guides/modes.md).
- **Moving chats between projects** and **`workspace.read`** left the Watch list
  because the rewrite built them: a face's room moves (plan 10) and the brain's
  `workspace_read` (plan 08).

The queue before the rewrite, including its manual validation, can be read with
`git show c483379:plans/README.md`.
