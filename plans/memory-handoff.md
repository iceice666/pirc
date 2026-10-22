# Memory redesign: one handoff, independent long-term memory, original sources

This is the Rust continuation of the approved A–D plan. Upstream `main` replaced the TypeScript runtime before integration; the maintainer explicitly chose to port the redesign to Rust. The old runtime is not restored. This document describes the resulting contracts, dependencies and acceptance criteria. Deployment and activation of existing ledgers remain separate operations; neither is authorized by this document.

## Data flow and ownership

```text
Original append-only session JSONL
  ├─ bounded complete prefix → structured handoff → recent raw tail → main request
  ├─ complete original interaction → independent extractor → repository journal
  └─ public source projection → history_search / history_read

Gateway USER / personal MEMORY → fresh Chat-owned block
Authorized repository journal → fresh Work-owned block
Repository journal → atomic mirror frame + integrity checkpoint → gateway search
```

A handoff is session-local continuation state. Work knowledge crosses authorized main sessions and worktrees of the same repository. Starting another session does not import the previous session's unfinished task, entire handoff, tool state or approvals. Processing another registered source does not require reopening its agent. Complete interactions can be processed independently; a receipt for a later interaction never claims an unfinished earlier interaction was processed.

Chat retains the gateway's per-user personal MEMORY, approved USER entries, capability policy and dedicated cross-session search/recall. Work retains the newer upstream mode behavior that can expose approved USER preferences; it does not receive Chat's personal MEMORY. Work extraction treats injected preferences and replayed history as derived evidence. Current-session history tools cannot accept an owner, workspace, session directory or arbitrary source path. Cross-session evidence goes through the dedicated Work or gateway resolver, with ownership and mode checks.

Mode definitions, tool allowlists, delegation rules and the existing sandbox remain authoritative. Model summaries and legacy OM labels cannot grant permission. The automatic action classifier follows snapshot references back to original human messages rather than accepting generated observation text as approval. Partial originals are explicitly labeled and cannot establish authorization.

## Four phases and dependencies

| Phase | Depends on                                         | Responsibility                                                                                 |
| ----- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A     | Existing Rust store, private persistence and modes | Strict source reading, synchronized recovery, provenance and compatible settings               |
| B     | A                                                  | Independent Work extraction, atomic journal mutations, repository cutover and mirror integrity |
| C     | A                                                  | One structured handoff engine for manual, threshold and overflow compaction                    |
| D     | B and C                                            | Fresh owned prompt blocks, archive-only legacy readers and retirement of the OM pipeline       |

B and C share contracts but neither uses the other's coverage. The implementation order remains A → B → C → D. Fixture tests do not establish full process integration; validation must identify the level actually exercised.

### A — Source and recovery foundation

Files:

- `crates/pirc-agent/src/journal.rs`: descriptor-based OS mutex, pinned mutex/fence identities, bounded strict JSONL parsing and writer-open recovery.
- `crates/pirc-agent/src/session_store.rs`: parent/header validation, compare-and-append, atomic compaction records, recovery/read-back and atomic branch edits.
- `crates/pirc-agent/src/state_io.rs`, `crates/pirc-node/src/persistence.rs`, `crates/pirc-node/src/inference.rs`: node-mediated writes into the agent's read-only private state. Revoke and drain the existing persistence lease before replacing its runner.
- `crates/pirc-agent/src/history.rs`, `crates/pirc-node/src/workspace_memory.rs`, `crates/pirc-node/src/runner/side.rs`: bounded source projections, identity binding and return-time revalidation.
- `crates/pirc-agent/src/features/memory/config.rs`, `crates/pirc-agent/src/config/memory.rs`: fieldwise settings compatibility. An invalid tuning field must not re-enable a valid explicit disable flag.
- `crates/pirc-agent/src/ptc/mod.rs`, `ptc/registry.rs`, `features/memory/serialize.rs`: replay provenance through operations and stores, including restarts; secret redaction, forged-header defenses and omission of private thinking.

Readers do not repair session logs. Writer opening may preserve an interrupted final fragment as evidence, synchronize the evidence, repair the tail and synchronize the file and parent directory. Mid-file corruption, invalid complete records and broken parent chains fail visibly. A valid final record missing its delimiter is finished under writer authority. No append may continue after an unknown persistence result until reopen/reconciliation.

The OS mutex and empty `.writer-lock` directory are different: the mutex is actual mutual exclusion; the directory is a compatibility fence. Never delete or steal an old PID lock because its age looks stale. Busy, interrupted, unsupported and unavailable locking failures have distinct outcomes. macOS and Linux use the same contract. Branch mutation holds the original journal transaction while publishing the replacement; failed temporary branch entries are discarded from memory too.

### B — Independent Work memory

Files:

- `crates/pirc-agent/src/workspace_journal.rs`: v2 control, immutable jobs, epoch/generation/revision, additions, retirements, source tombstones, cutover/clear boundaries and successful extraction receipts.
- `crates/pirc-node/src/workspace_memory.rs`: registry-bound source selection and shared request-local source snapshots. No model-supplied path or ownership claims are trusted.
- `crates/pirc-node/src/runner/side.rs`: bind original caller, runner epoch, mode, owner and repository; serialize the synchronous commit with the existing runner lifecycle mutex; revalidate before delivery.
- `crates/pirc-agent/src/features/workspace_memory.rs`: bounded single-call extraction, legacy model/fallback/cooldown settings, source citation validation, refresh and explicit commands.
- `crates/pirc-node/src/memory_mirror.rs`, `crates/pirc-gateway/src/memory_records.rs`, `agent_ops.rs`, `db.rs`, `schema.sql`: atomic projection plus content checkpoints, gateway readiness and authorized checkpoint lookup. Schema 1006 adds the nullable mirror digest without rewriting legacy records.

Normal work consumes complete original interactions independently of OM and compaction. At most three jobs are processed per sync; a job uses one model call. Oversized interactions stop with a visible budget error and no receipt. The raw evidence bound is 128 KiB per job and the shared source-scan bound is 64 MiB per request. No source is silently truncated to create coverage. Retiring a contradicted note and adding its replacement share one transaction with the receipt. A validated successful empty result is distinct from failure. Duplicate content need not create another note.

Generation/revision and source authority are rechecked inside the journal transaction, immediately before writing. Model work never holds that lock. A changed owner, mode, registry path, source identity or generation prevents the candidate from committing. Source fingerprints and one parsed snapshot are reused for return-time checks. The existing runner mutex prevents a stopped/replaced runner from making a delayed commit.

`clear` records the original captured boundaries and changes generation. The host validates the complete captured source set, unique session identities and original entry cutoffs; an incomplete or changed capture is refused before writing. Continuing an unfinished pre-clear turn cannot relearn its orphan continuation. `forget` preserves source suppression through clear and explicit catchup, including legacy observation/reflection provenance. Suppression follows the original human interaction start even if a later assistant continuation extends its end. Raw session history is retained; forgetting a note is not a promise to erase already delivered text or every semantic paraphrase.

A lost ACK is an unknown outcome. Keep a bounded, ephemeral map of original immutable jobs (maximum 64), withhold the Work prompt block and inspect receipts through the same authority and mirror gate. An absent receipt with unchanged CAS is still pending. A durable matching job proves success; a changed CAS can prove an uncommitted job can no longer succeed. `forbidden` and `not_found` may be return-time errors after commit and are not prewrite proof. Explicit retries reuse original inputs and clear cutoffs; there is no automatic destructive replay loop. In-flight mutations continue to withhold old notes until settled. Return-time source and ownership checks apply to mutation acknowledgements as well as reads, because control metadata also contains source identities.

Repository activation is explicit: stop all older node, standalone and child writers, including other worktrees, then use `/om:workspace cold --writers-stopped`. The permanent empty `<key>.lock` directory preserves the TypeScript cutover marker. A versioned ledger restored to legacy content must not fall through into legacy injection, even before the gateway has acknowledged its new tail. Opening an already-versioned writer handles recovery; it does not activate a legacy ledger. Old PID lock files require operator handling and are never automatically removed.

The mirror carries a complete validated projection and an integrity checkpoint in one gateway transaction. Invalid additions cannot leave a valid retirement applied. Capacity rejection also rolls back the whole versioned frame. Acknowledged prefix hashes fence shrink and equal-length replacement. Legacy checkpoints use an exact projection proof before acquiring a digest. Stale/non-advancing ACKs cannot trigger unbounded immediate retransmission or regress a checkpoint. Incompatible or unavailable authority withholds notes; it never authorizes an unsafe local fallback.

### C — One handoff compactor

Files:

- `crates/pirc-agent/src/handoff.rs`: structured state, deterministic rendering, lineage, source references, human constraint changes and tool group boundaries.
- `crates/pirc-agent/src/handoff_compactor.rs`: fixed ranges, complete source pages, proof validation, bounded attempts and one commit.
- `crates/pirc-agent/src/compaction.rs`, `agent.rs`, `features/compact.rs`: shared effective budgets and a single entry point for manual, threshold and overflow requests.
- `crates/pirc-agent/src/auto_mode/classifier.rs`: original human evidence lookup.
- `crates/pirc-providers/src/models_file.rs`: opaque, secret-free routing fingerprints for the public catalog.

Only a valid snapshot can advance the compaction boundary. A new snapshot extends the previous valid one over one contiguous original range; source/state/summary/boundary/job identity are published in one entry. Invalid latest snapshots fall back to the last valid snapshot and its raw tail. Legacy summaries are inherited and explicitly unverified; the new increment must still be present and validated.

Whole source text is paginated; later pages cannot revoke established constraints before the full later original human message is available. A constraint removal requires the exact later human quote retained in decisions with the same source. Assistant/tool assertions cannot remove a human constraint. Reaffirming a constraint advances its evidence position. Only `stopReason=toolUse` issues calls. Duplicate/open/orphan groups and PTC parentage are checked consistently when compacting and reopening. Private entries are not coverage evidence.

Effective model window, output reserve, prompt/tools and provider projection govern both preflight and the final request. Only the implicit reserve scales down; explicit policy remains explicit. Secret-free route identity includes public opaque routing fingerprints. Compare it before every handoff call, after every await (including failed/invalid/timeout replies) and immediately before commit. Changed routing supersedes old output/errors; cancellation wins. A timeout cancels its child request.

Automatic attempts remain limited to two per unchanged identity with a 60-second cooldown across restart. Manual retry remains available. A job has a 60-second timeout and at most 16 chunks by default. Failure, abort, invalid references, source changes, exhausted chunks or an oversized/non-reducing result leave the boundary unchanged. Live usage calibration binds the observed message, route and prompt basis; a changed prefix can reuse the observed scale, while known model mismatches and newer compaction invalidate stale reported totals after restart.

### D — Refresh and retirement

Files:

- `crates/pirc-agent/src/feature.rs`, `agent.rs`: stable-order replacement of feature-owned prompt sections, dirty invalidation, cancellable refresh and shared preflight admission.
- `crates/pirc-agent/src/features/assistant/mod.rs`, `features/workspace_memory.rs`: fresh Chat/Work blocks at model-turn boundaries; failed, denied, cancelled or superseded replies cannot restore a previous block or relax policy.
- `crates/pirc-agent/src/features/memory/mod.rs`, `ledger.rs`, `workspace.rs`: small legacy readers and ID recall.
- `crates/pirc-node/src/panels/mod.rs`, `apps/web/src/lib/panel-api.ts`, `components/panel/MemoryTab.svelte`: handoff/legacy ancestry and separate refresh/extraction/pending status.
- `nix/package.nix`: installed CLI session creation/reopen smoke checks, isolated from user state.

Remove the active Observer, Reflector, Dropper and promoter modules. Keep old observations, reflections, folded details, IDs and sources readable; do not rewrite everything into a new summary. Frozen prompt entries and `context.json` are diagnostic/archive data, not fresh memory authorities. Missing policy fields or an offline gateway do not relax existing restrictions. Idle extraction remains bound to the run's cancellation signal.

## Compatibility and operation

| Existing data/settings                                  | Result                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Valid session JSONL / unknown entry types               | Preserve identity, ancestry and uninterpreted fields                                                   |
| Legacy OM observation/reflection IDs and folded details | Archive/recall retained; no new OM jobs                                                                |
| Legacy compaction with missing earlier ancestry         | Inherit the summary as unverified; validate the new tail independently                                 |
| Legacy repository notes                                 | Retain IDs, content and provenance; read-only until explicit repository cutover                        |
| Pre-cutover raw backlog                                 | Explicit `catchup`; never claim the cutover boundary was model-processed                               |
| `features.observationalMemory.workspace`                | Legacy fieldwise alias; explicit `workspaceMemory` fields take precedence                              |
| Legacy disable/passive/model/fallback choices           | Preserve their meaning; explicit canonical enable may opt Work back in; forced passive stays effective |
| Positive old Work budgets above 32000                   | Accept configuration; cap the effective transport block at 32000                                       |
| Already accepted mutation with lost response            | Confirm or explicitly retry the same job; never infer failure from timeout alone                       |

The Rust mainline's database transition from TypeScript is a separate upstream migration constraint. This memory port preserves memory files/settings; it does not claim to make the upstream Rust services accept every old TypeScript SQLite database. Never downgrade a binary into an already-activated v2 ledger. Back up and restore the journal and its authoritative mirror checkpoints together. A missing source, damaged middle record or divergent checkpoint requires repair rather than silent coverage advancement.

## Acceptance gates

| Gate | Required evidence                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1   | Reader never edits; interrupted tail recovery preserves evidence and survives reopen                                                             |
| A2   | Old PID locks are not stolen; replaced mutex/fence identities, sync failures, unsupported locks and hardlinks fail safely                        |
| A3   | Current-session history has complete bounded pages; private thinking/state are absent; foreign paths/owners are rejected                         |
| A4   | Replay provenance survives PTC operations, stores and restart; invalid config fields cannot re-enable disabled memory                            |
| B1   | Work B can process A's authorized raw interaction without starting A; Chat and foreign/deleted sources are denied                                |
| B2   | Empty results, additions, replacements and their receipts are atomic; failures never manufacture success receipts                                |
| B3   | Concurrent generation/authority changes reject commit; runner replacement fences delayed writes                                                  |
| B4   | Clear/forget survive unknown ACKs, explicit retries, restart, catchup and legacy sources without resurrecting revoked notes                      |
| B5   | Cold cutover preserves legacy data and markers; stale/rollback mirrors and malformed/quota-rejected frames cannot revoke only half a replacement |
| B6   | View cursors bind ordered rendered inventory and authority; empty receipts alone do not invalidate a page                                        |
| C1   | Manual/threshold/overflow share one writer; raw sources survive successful compaction and process restart                                        |
| C2   | Multi-page ranges and tool groups have no silent gaps or truncation; future/foreign/private references are rejected                              |
| C3   | Human constraints require complete later original evidence; reaffirmation and quote retention survive page boundaries                            |
| C4   | Invalid output, abort, timeout, source change, no reduction or chunk/budget exhaustion leave coverage unchanged                                  |
| C5   | Route changes win over stale errors/JSON/timeouts; automatic restart cannot reset retry limits; final main request is budget checked             |
| D1   | Fresh owned blocks preserve feature order; revoked/failed/late replies cannot restore stale memory or policy                                     |
| D2   | Chat personal memory and Work repository knowledge remain separate; Work crosses authorized sessions, handoffs do not                            |
| D3   | macOS/Linux unit and real-process tests, front-end checks/build and installed-package session checks identify their actual scope                 |

Model-generated summaries and extraction still require separate quality evaluation. Structural validation proves provenance, boundaries and bounded execution; it cannot prove that a model preserved every important meaning. Oversized Work interactions and unavailable/changed sources remain visible operational limits, never silently counted as processed.

## Validation record

Validated on 2026-10-22 against Rust mainline `59ba8f36e4e5c437686373c52b4aa6bbe9d84da1`:

- macOS workspace tests excluding conformance: 1,109 passed, 3 explicitly ignored. The last Work and journal changes additionally passed 7 and 9 focused regression tests. Real macOS sandbox, persistence and browser integration tests passed.
- Linux workspace tests excluding conformance passed (1,148 tests, 6 explicitly ignored). Final Linux library/binary validation passed 1,018 tests, with 2 explicitly ignored; this includes the final continuation/forget, descriptor exclusion and source-boundary regressions.
- Linux real-process conformance ran against freshly built node/gateway executables with `PIRC_CONFORMANCE_REQUIRED=1` and `INSTA_UPDATE=no`; every scenario passed. Structured handoff, Work extraction and PTC history replay tests assert boundaries and permissions directly. Encoded source IDs/timestamps are normalized structurally; timer-based PTC progress is excluded only from two feature authority transcripts, with all operation events/final results retained and dedicated PTC coverage unchanged.
- `cargo fmt --all --check` and workspace/all-target Clippy with `-D warnings` passed. Front-end typecheck reported zero errors/warnings; all 372 web tests and 18 script tests passed; the production web build passed. Prettier, version, catalog and browser asset checks passed.
- Nix 2.35.3 built the Linux node package and passed the installed wrapper's offline session create/reopen checks, stable header and compatibility-fence checks. The pinned Nix formatter was applied. Linux host tests requiring unavailable bubblewrap/Chromium or an unprivileged host report their scope separately; a container run is not evidence for those host sandbox cases.

Initial disk-full failures were rerun after clearing task-owned build caches. A wall-clock glob performance test was rerun successfully without competing release compilation; no production glob behavior or timing threshold was changed. Final validation results above come from the Rust port, not the historical TypeScript run. Test-only fixtures use isolated temporary state. No existing user ledger has been activated and no deployment has been performed.
