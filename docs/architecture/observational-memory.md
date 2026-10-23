# Session handoffs and independent memory

The session uses one structured handoff plus recent raw history. Repository knowledge is extracted independently from complete original interactions. Chat personal memory and Work repository knowledge refresh as separate feature-owned blocks at model-turn boundaries. Original public source text remains available through current-session history tools and authorized dedicated cross-session resolvers.

The [four-phase implementation and acceptance contract](../../plans/memory-handoff.md) records file ownership, data flow, budgets, coverage, failure recovery, compatibility and controlled activation. The [legacy OM format](legacy-observational-memory.md) remains readable as an archive; Observer, Reflector, Dropper and promotion workers no longer run.

Work knowledge crosses authorized sessions/worktrees of the same repository; a session handoff remains local. The newer mode system may expose approved USER preferences to Work, while personal Chat MEMORY remains separate. Memory text never grants fresh permission.

Existing repository ledgers remain read-only until an explicit cold cutover with all older writers stopped. Cutover boundaries are not processing receipts. Activation and deployment require a separate operational decision. Neither was performed by the implementation work.

## Activation status and large histories

The Web and Android memory panels expose repository write activation separately
from session handoff state. Before cutover, existing notes remain readable but
`/om:workspace sync` and `catchup` report that writing is not activated; zero
processed interactions is not a successful activation. Stop all old node,
standalone and child writers before explicitly running
`/om:workspace cold --writers-stopped`. A busy peer or runner manager refuses
cutover without waiting on another runner's lifecycle lock. Retry after those
writers have stopped. This does not automatically activate any deployed ledger.

Routine context requests no longer capture all history boundaries. Only an
explicit clear preparation requests `includeBoundaries`; cold cutover captures
its boundaries on the host. Control metadata reads authorized session headers,
while notes, extraction and mutations still validate the full relevant branches.
Parsed source branches use a bounded request-local cache: exceeding 64 MiB across
multiple source files evicts parsed branches instead of disabling repository
memory. Source fingerprints survive eviction, so changed/deleted/reassigned
sources still invalidate delivery or commit. The existing per-file 64 MiB journal
limit and per-interaction extraction budget remain in effect.

Recovery workspaces continue to reject repository-memory access. These changes
do not import original repository memory into a checkpoint continuation or grant
access across owners, modes, or deleted sessions.
