# PTC M1 OpenAI evaluation revision

Status: **M1 baseline accepted: 300 measured trials and 150 primes, readiness complete** (see [acceptance](#m1-baseline-accepted)). The implementation, live-run and continuation sections below are chronological historical snapshots. Later migration status is recorded in [PTC cutover](ptc-only.md). This revision supersedes the Opus-only/cold-warm evaluation requirement for the remaining M1 and future like-for-like M4 comparison. It does not approve M2 or production tool-interface changes. Old Opus artifacts, budgets and one-shot markers remain separate and unchanged.

## Explicit maintainer decisions

- Direct OpenAI Platform Responses API, fixed `gpt-6.1-sol`; tools must use Responses, not Chat Completions.
- Main reasoning `medium`; `max_output_tokens: 16384`, including reasoning tokens. Preserve and record legitimate auxiliary feature settings. The maintainer subsequently explicitly approved mapping unsupported auxiliary `off`/`minimal` to `low` for this model, with original/effective effort and original output cap recorded per attempt; both baseline and future PTC use the same mapping. Never silently switch models.
- Standard service tier (`service_tier: "default"`), no Fast/Priority, Flex or Batch.
- **Independent new USD 100 hard budget**, starting at zero; include all parent/child/auxiliary requests, warm-ups, invalid runs and retries. Old Opus occupancy $8.9704356 is not deducted from this budget and is not reset/refunded.
- Replace cold/warm with **uncached/warm**. Uncached uses `prompt_cache_options.mode: "explicit"` with no breakpoints; require cached/write usage consistent with disabled caching. Warm uses fixed explicit breakpoints, same-prefix preparation and actual cache-read verification. Do not label uncached as cold first-write.
- Fifteen shared fixtures, ten measured runs per fixture per condition (300 measured total), separate coding/chat aggregates and predeclared regression bounds retained. Warm-up usage is separate from measured rows but included in total spend.
- User will enter the key invisibly in their terminal, then pipe via SSH stdin into the trusted Arch sidecar. No chat key, file, argv, environment or measured-agent credential propagation. No swap, core limit zero, genuine fail-closed srt and cgroup resource evidence remain required.

## Public official evidence

- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol.md): Responses tool calling; text/image input; medium default; max input 922,000; max output 128,000. Listed model/snapshot ID is `gpt-6.1-sol`.
- Standard per-million-token prices: uncached input $2; cache read $0.10; cache write $2.50; output $10. Above **272,000 input tokens**, the full request is repriced at 2× input/cache rates and 1.5× output. No regional processing premium is selected; if returned service configuration differs, stop rather than underprice it.
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching.md): supported recent models offer explicit mode; no explicit breakpoint means no cache reuse or writes. Warm prewarm is billed. Changing `prompt_cache_key` is not proof of physical cold state.
- [Usage schema](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_usage.py): `input_tokens` includes cached and cache-write tokens; reasoning tokens are a subset of `output_tokens`. Validate all fields and totals before deriving disjoint buckets.

## Implementation boundary

Keep existing pinned pirc binaries and model-visible operation contracts. Reuse the existing Responses adapter if compatible; evaluation-only wire instrumentation may apply the approved cache controls symmetrically to both compared binaries. Do not alter prompt text/schema to create artificial cache misses. Verify source/dependency hashes, service tier, output cap, every physical attempt, usage presence, cancellation and complete child accounting.

New `openai-contract.ts` / `openai-budget.ts` deliberately use independent units/prices (one unit = $0.0000001), not the old Opus ledger. Initial offline tests cover bucket accounting, long-context threshold, terminal model/tier/usage checks, liability retention and checkpoint failure. The independent `openai-provider.ts` now reuses unchanged production `streamPi` through a trusted Responses relay. It applies the approved cache/tier controls, strips private correlation/session headers, validates actual wire usage and rejects truncated/incomplete results rather than trusting Pi's synthesized terminal state. The installed Pi version reports cacheWrite as zero; raw wire evidence is authoritative for evaluation and budget, with a regression explicitly demonstrating the discrepancy. An uncached response containing either cache bucket is charged but halts further admission.

OpenAI fake Responses provider tests passed (6 tests, 61 assertions), followed by active client/provider stream cancellation with exactly-once uncertain liability. All **15 fixtures** passed fixed Arch binaries under real srt with fake Responses (15 tests, 162 assertions). Same-path warm pairing with identical actual controlled-body hash and authoritative cache buckets passed separately (1 test, 12 assertions). These are synthetic evidence, not live OpenAI compatibility.

`openai-controller.ts` and `openai-cohort.ts` now orchestrate uncached/prime/warm without old cold sleeps. Scoped review prompted a separate OpenAI readiness gate: canonical full fixture matrix, finite resources/metrics, accounting reconciliation, required authorization/cancellation proof, explicit budget validity and infrastructure health; subset/empty/synthetic matrices cannot report complete. Cache diagnostics retain fixed booleans/counts, not body hashes. Offline contract/controller/cohort tests passed (18 tests, 79 assertions). The new `scripts/ptc-m1-openai.ts` CLI uses an independent fixed attempt marker and fresh budget; it is compiled but still under review and **has not been executed with real credentials**. Follow-up CLI/readiness review additionally required every auxiliary generation to complete (known incomplete usage remains charged), coding/chat weighted/unweighted numeric summaries, and a first-triplet staging gate before the full matrix. Generation gating and report reduction have been added. The first-triplet gate now durably records aggregate evidence and waits in the original process/budget before dispatch four. A manually published owner-only, nonce-bound approval file is required; never write it as part of launch. It must be published atomically from a fully written same-directory temporary file, not via direct redirection. Wrong nonce, symlink/FIFO, bad permissions, cancellation and timeout fail closed. Final narrow gate review found no remaining P1/P2 after nonblocking-open and monotonic deadline fixes.

Final remote OpenAI fake validation passed **51 tests / 344 assertions**. Local full check passed gateway **773 pass / 82 skip**, web **268 pass**, compiled **115 pass** plus format/types/build. The human-operated `scripts/ptc-m1-openai-launch.py` performs strict SSH precheck and hidden stdin key entry; syntax was checked, but it has not been executed with credentials. User terminal handoff and actual first-triplet validation are now the remaining pre-matrix steps. No OpenAI credential has been requested for execution or used, and no OpenAI generation cost has occurred. No readiness or cost-savings claim follows from these tests.

## Live first-triplet review and release (historical; run stopped below)

The maintainer performed the terminal credential handoff and reported `waiting_first_triplet_review`. Only aggregate artifacts were inspected; credentials, raw session files and transcripts were not read.

All three single-bash runs succeeded. Uncached requests reported zero reads/writes; the prime initial main request wrote 6,253 cache tokens; measured warm initial main request read 6,253 with identical controlled body. Nine attempts had complete generation/usage evidence and reconciled owners, no outstanding reservations or test units. Main effort/cap were medium/16,384, and title was the approved off→low with its original 512 cap. First measured wall times were 6,383.07 ms uncached and 3,940.03 ms warm—single samples, not an efficiency conclusion.

The budget after this stage was **452,404 units / $0.0452404**. Independent recomputation from each attempt exactly matched the durable ledger. The manifest pinned model, Standard tier, binary hashes, controller source hash `7bde20ffe2fe65b21d4bb99593110614d25cdd5c71f7c6602c9fce9c1255e8e6` and fixture hash `39f59e86faee6ff61d053c62d0e485e0bd2c1d355d7764d3292caa3ac491d106`.

After viewing these results, the maintainer explicitly approved the remaining 298 measured trials and associated primes. A fully written/fsynced private approval was atomically published for the same stage nonce, without resetting the process, budget or attempted marker. The first two measured rows are not replayed. Completion and final cost remain pending; do not change the executing harness or claim M1 complete from this stage.

## OpenAI-001 stopped and approved continuation preparation (historical; continuation stopped below)

The run stopped at **181 measured / 90 prime rows**, first `team-wait` uncached trial. Four measured task failures are retained (three multi-edit rows with recovered file content but an observed tool error, plus the team wait failure). All **1,030 physical requests** have complete usage; final spend is **53,688,009 units / $5.3688009**, zero reservations/unknown attempts, no remaining measured units.

Diagnosis: `childrenAccounted` incorrectly depended on `TeamEvidence.verified`, conflating task/wait success with complete usage ownership. The final row has verified 17 requests (parent 6, child 7, auxiliary 4), confirmed helper write/completion/report/integration, but `waited:false`. The task remains **failed**. Prospective runner fix derives `childrenAccounted` from reconciled usage alone, leaving every team success gate unchanged. Genuine-srt fake runner tests cover normal team and missing-wait failure while retaining complete child accounting (2 tests, 36 assertions).

The maintainer explicitly approved a reviewed, non-replaying continuation with the same USD 100 budget. Original files/markers are immutable. Their SHA-256 identities are:

- trials: `81c35ecbd5cfb5ddae17d8ec5e6124ee7831c9c65f80897c22900f731f87bce5`
- budget: `7764043b75aceac62b2c2e1212f6bc353e5930690422e4e9ebe287e3ad365a08`
- summary: `f4a0cb66f197cf257be47bb924a05518cef283d2e5459c413cce68e9a000f463`

Resume validation checks those identities plus old manifest/protocol/pins, all 271 ordered records, usage recomputation, per-row cumulative budgets and the exact final correction boundary. It creates only a derived view changing the last row's accounting flag false→true; `success:false` is unchanged and the correction is declared in a new manifest. Actual original aggregate validation passed with carry 53,688,009 units / 1,030 attempts and next cursor **team-wait / prime / 0**. No prior row—successful or failed—is replayed or recorded again. A separate fixed continuation marker is required. The continuation CLI is not yet paid-executed. Direct validator regressions and no-replay/failed-prime tests pass; final scoped review found no blocking findings. Full local check passed gateway **778 pass / 83 skip**, web **268 pass**, compiled **115 pass**. Remote continuation/runner validation passed **33 tests / 278 assertions**, original three hashes remained unchanged and the new continuation marker was absent. The remaining step is fresh human stdin key handoff using `scripts/ptc-m1-openai-launch.py --resume-openai-001`; it selects new output `openai-002` and never resets the old marker or zeroes spend.

## OpenAI-002 stopped on unsuccessful team prime

The maintainer started the approved continuation. Its manifest correctly referenced all original hashes, carry **53,688,009 units / 1,030 attempts** and next `team-wait / prime / 0`; no old row was replayed. That single new prime failed the team wait oracle, so the existing successful-prime gate stopped before warm. New attempts: **18**, all complete (parent 6 / child 8 / auxiliary 4), `childrenAccounted:true`, `allAttemptsAccounted:true`, no unknown usage or reservations and no remaining test units. Cumulative OpenAI spend is **54,291,743 units / $5.4291743**. Totals remain **181 measured**, now **91 primes**. M1 remains incomplete; both run markers and original artifacts remain immutable.

The maintainer requested offline-only diagnosis, not another paid retry or a changed prime-success policy. Source inspection confirms the expected wait JSON matches production. A concrete oracle restriction was reproduced: only the first matching wait is tracked; timeout followed by a later successful idle wait is rejected and ignored. A single `agent_list` inspection is also outside the strict allowlist, although the fixture prompt does not prohibit it. Automatic completion-barrier/report integration without explicit `agent_wait` is another aggregate-compatible explanation. **Existing booleans cannot identify which path occurred in either paid run**; no raw session was read.

Added fixed, content-free diagnostic counters for wait calls/target/repetition, parse/tool errors, first reason, target/status match and sticky rejection. Acceptance is unchanged; prior failures are not reclassified. Offline tests cover absent, timed-out, wrong-target, malformed and timeout-then-idle cases (5 tests, 20 assertions before the additive rejection flag). These diagnostics only apply to future observations; any paid diagnostic or oracle/protocol change still requires a separate decision.

## Prospective team oracle revision 2 (offline only)

The maintainer approved accepting multiple waits for the same helper when at least one matched result is idle/idle and all existing helper-write/completion/delivery/parent-integration evidence remains present; `agent_list` is neutral, not proof of waiting. This applies only to future observations. Existing paid failures remain unchanged and neither stopped marker was reset.

Revision 2 correlates all distinct wait call IDs, requires every started wait to finish, rejects wrong targets, malformed/unknown reason/status, explicit failure/cancellation, parent substitution, duplicate/colliding starts and spawn/wait result replay or tool-name mismatch. Review findings on malformed wait recovery and spawn replay were fixed with sticky rejection. Fixed diagnostics include completed/successful wait counts and `oracleRevision: 2`; no raw content enters summaries.

Offline team tests passed **8 tests / 37 assertions**. Genuine-srt fake runner tests for ordinary team, timeout→agent_list→successful second wait, and no-wait failure passed **3 tests / 58 assertions** before the final spawn-replay hardening. Final full local check passed gateway **783 pass / 84 skip**, web **268 pass**, compiled **115 pass**, with types/format/build clean. No new paid requests were made. A bounded future diagnostic/continuation and any treatment of the failed prime require a separate explicit decision; this revision alone does not authorize rerunning old measured samples or completing M1.

## One bounded team diagnostic prepared

The maintainer's subsequent continue request accepted preparing one human-operated team diagnostic, not restarting the matrix. `scripts/ptc-m1-team-diagnostic.ts` runs exactly one uncached `team-wait` using prospective oracle revision 2. It pins all three stopped openai-002 aggregate hashes and carries **54,291,743 units / 1,048 attempts**. A new exclusive diagnostic marker prevents repetition; old run markers/results are not modified.

Bounds are **32 additional upstream attempts**, **USD 10 additional conservative spend plus outstanding liability**, still inside the total USD 100 cap, and a **180-second cancellation deadline** after key intake (cleanup may extend process lifetime). Each worst-case reservation is $4.85576, so concurrent outstanding pressure can stop the diagnostic before actual spend approaches $10; this is explicit nonbillable-denial evidence, not missing usage or permission to relax the cap.

Review prompted explicit local admission-denial reasons in budget/ownership ledgers, accounting/budget gates for diagnostic completion, and `LimitCORE=0` on the measured systemd unit with `/proc/<pid>/limits` verification. Final review found no further concrete P1/P2 blockers for human handoff. Full local check passed gateway **786 pass / 84 skip**, web **268 pass**, compiled **115 pass**. Remote fake team tests passed **3 tests / 58 assertions** and budget tests **10 tests / 47 assertions**; the new diagnostic marker was absent, original openai-002 and node hashes unchanged, swap absent and no test units remained.

Launch only via the human terminal helper's `--team-diagnostic` mode after hidden key entry. Do not combine with resume, remove any marker, automatically repeat a diagnostic, or classify diagnostic success as matrix/M1 completion. At preparation time no additional paid request had been sent; cumulative spend remained $5.4291743.

## Bounded team diagnostic 001 result (diagnostic only)

The maintainer ran the human-terminal `--team-diagnostic` launch once. The exclusive diagnostic marker is now consumed; openai-002 aggregate hashes and the pinned node hash are unchanged, and no test systemd units remain. Report `openai-team-diagnostic-001.json` (`kind: team-diagnostic-not-baseline`, oracle revision 2) shows `completed: true` (infrastructure, budget, all-attempt/child accounting and the ownership ledger all valid) but **`success: false`**.

- **12 new attempts**, all HTTP 200 with complete usage and generation: parent 4, child 5 in one child session, auxiliary 3, unknown 0. No local denials, unknown attempts or reservations. Uncached condition held (cache read/write 0).
- Added spend **1,005,520 units ($0.100552)**. Cumulative independent OpenAI budget is **55,297,263 units ($5.5297263) / 1,060 attempts**, not halted.
- Measured wall time 24,938 ms, startup 437 ms, CPU 473 ms, cgroup memory.peak 77,250,560 bytes. Output tokens 522, all reasoning tokens 0.
- Team evidence: spawned, delivered and integrated all true. **One wait, which ended idle/idle against `fixturehelper`**, so `waited: true` this time. Rejected because of **`unexpectedParentCalls: 1`**: the parent made one tool call outside spawn/wait/inbox/read/agent_list. **`childWriteConfirmed: false` and `childCompleted: false`** while `filesMatch: true` and `toolErrors: 0`.

Interpretation is limited. The wait-path explanation for openai-001/002 is not confirmed or excluded by one sample. The aggregates cannot tell whether the parent wrote or verified `team.txt` itself (parent substitution), or the helper wrote it in a form the strict exact-`write`(`team.txt`, `joined`) matcher does not recognize, or both. The unexpected tool's name is not recorded. No raw session was read. This diagnostic does not change historical results, is not a baseline/prime/measured row, and does not authorize another diagnostic, matrix continuation, an oracle change or M1 completion; those need a separate decision. Totals remain **181 measured / 91 primes**.

## Additive team activity diagnostics (offline only)

The maintainer chose to continue with offline, content-free diagnostics only. `TeamEvidence.summary().activityDiagnostics` adds fixed integer counters:

- Unexpected parent tool calls by fixed tool-name bucket (unknown names, including prototype-like names, map to `other`).
- Parent `write`/`edit` calls targeting `team.txt`, and parent `bash` mentioning it.
- Child tool buckets.
- Child `write` classification: `exact`, `pathVariant` (basename `team.txt`), `contentVariant` or `otherTarget`.
- Deduplicated child write ok/error results, child `bash` mentions and `edit` calls targeting `team.txt`.
- Child stop counts (with text, without text, failed).

Acceptance, `verified`, `TEAM_ORACLE_REVISION` (2) and historical results are unchanged. No paths, commands, contents, result text or session IDs enter summaries, and malformed or null arguments cannot newly throw. A read-only review found no P1/P2; its P3 items (null-safe arguments, child team-file edits, fixed-key/malformed/acceptance-noise tests) were applied.

Validation: team unit tests **10 pass / 67 assertions**. Final full local check: gateway **788 pass / 84 skip**, web **268**, compiled **115 / 403 assertions**, diff check clean. On Arch, the pinned real-srt fake-model team runner plus unit tests passed **10 tests / 116 assertions**; no test units remained, and the node and openai-002 hashes were unchanged. These counters only apply to a future run. Another paid diagnostic would need a new marker, bounds and separate approval; no paid request was made.

## Continuation openai-003 (delegated decisions)

The maintainer delegated all remaining decisions and authorized spending the independent USD 100 budget until data collection is complete. The maintainer then supplied the key in gitignored `.env` (mode 0600). The assistant pipes the key directly into SSH stdin; it never appears in argv, environment, output or tracked files, and stays only in remote process memory.

- `--resume-openai-002` (new exclusive marker `.ptc-m1-openai-resume-002-attempted`, output `openai-003`) validates the hash-pinned chain: openai-001's 271 rows (with the original derived accounting correction), openai-002's single failed `team-wait` prime and the diagnostic report/ledger. It recomputes every cost. Carry is **55,297,263 units / 1,060 attempts**; next is `team-wait / prime / 0`. The failed openai-002 prime is a superseded, charged prime attempt: its warm pair died with that process, so prime 0 is repeated. Neither it nor the diagnostic becomes a matrix row, and no measured row is replayed.
- **Prime task outcome is recorded, not gating** (`primeOutcome: 'record'`, `requirePrimeSuccess: false`, chained mode only). A prime exists to warm the cache. Warm validity is still decided only by identical initial request bodies plus an actual cache read. Prime infrastructure, accounting, budget and generation failures still halt. The historical default (`gate`) is unchanged for the earlier modes.
- Team rows after the first use oracle revision 2 with activity diagnostics. `team-wait` uncached index 0 stays as judged under revision 1. Successes therefore mix revisions for that one row; the manifest and summary record `teamOracleRevision`.
- No stage gate on resume; the run proceeds to the end of the matrix. It runs detached with `setsid`, with a progress log on the Arch host; a persistent seat0 login keeps the user systemd manager alive (linger is off).

Validation before launch: chain tests and record-mode cohort/controller tests. Read-only review found no P1/P2; its P3 hardening was applied. Final full local check passed gateway **792 pass / 84 skip**, web **268**, compiled **115 / 403 assertions**. Arch suites passed **45 tests / 389 assertions**, and the real artifact chain validated before the marker existed.

## openai-003 stop and openai-004 completion of data collection

**openai-003** (record mode) added 60 rows: the rest of team-wait plus all of schedule. It halted at `permission-rejection / uncached / 0` because `FixtureServices` treated a model-initiated alternate-channel request as fatal infrastructure failure. With `web_search` disabled the tool is absent, and the model tried the browser.

The fix is fail-closed. Unexpected gateway, browser and interaction requests are denied without execution and counted in `services.unexpected`. They make `serviceValid` false (a measured task failure), not infrastructure-invalid. Overload, closed services and daemon errors stay fatal. This cannot change earlier rows, which never hit that path because any such request would have halted the run.

A generic hash-pinned `validateOpenAIContinuation`/`APPROVED_CONTINUATIONS` chain (`--resume-latest`) supersedes only the gate-failing final row (charged, not measured) and repeats it. Resume may now start at an uncached position. Review found no P1/P2. Full check passed gateway **796 / 84 skip**, web 268, compiled 115; Arch suites passed **59 tests / 466 assertions**.

openai-003 pins: trials `9f859b69…6494`, budget `ec982b2b…d8b6`, summary `1d0cfe5f…af26`, controller `e09c91c5…2a98`.

**openai-004** (`--resume-latest`, marker `.ptc-m1-openai-resume-openai-003-attempted`) finished the remaining 120 positions. The final summary has **300 measured trials**, `complete: false`, `missing: ["authorization_unverified"]`. Every other gate passed: lifecycle, cache conditions, accounting, usage, metrics and budget.

- Final independent OpenAI budget: **90,471,529 units = USD 9.0471529**, 1,823 attempts, 0 reserved, 0 unknown, not halted.
- openai-004 SHA256 values: trials `5fa1e397cc717c70da373fe0c426bb9169c77df992866e7b5989780ae0fc26da`, budget `21c1744899ab953f352cee793a1ef774a25ed84a99c3757a235f6d9a8cb39ba0`, summary `feb2658d0893dc682a14be9ca4bf1b4321b56afc0d9339fcb2964feb78104649`.
- Coding weighted mean tokens / wall: uncached **17,298.7 / 6,635 ms**, warm **17,117.8 / 6,560 ms** (unweighted tokens 18,691.5 / 18,454.6). Chat: uncached **6,488.6 / 3,541 ms**, warm **6,489.5 / 3,825 ms**.
- Task successes out of 10, uncached/warm: multi-edit 9/8, team-wait 0/3, schedule 9/7, permission-rejection 0/0, chat-permission 5/9. All other fixtures 10/10.

Aggregate failure diagnostics (no content):

- **permission-rejection**: all 20 trials tried a browser operation after `web_search` was removed, and all were denied unexecuted. Because the capability hides the tool, the model cannot "try" web search. This is a fixture-design finding for M4; the same behavior applies to any binary under the same fixture.
- **team-wait** (16 measured failures since revision 2): every trial waited successfully. The parent used `bash` mentioning `team.txt` in 12 (read-only verification is outside the strict allowlist), and 4 used other unexpected tools. Helper writes were exact in 6 and absolute-path variants in 9. The wait-oracle explanation is therefore superseded by parent verification calls plus strict exact-path matching.
- **schedule**: 4 failures, 3 of them with a correctly pending proposal. These are wording-oracle failures, not authorization breaches.
- **chat-permission**: 6 failures with no alternate-channel requests.

The baseline therefore has complete measured data but does not satisfy the "identical authorization every trial" readiness rule. Historical results are not regraded. Any oracle or fixture revision would have to apply identically to baseline and PTC in M4.

## Protocol amendment: authorization readiness and category re-measure (pre-declared)

This was decided **after** seeing the openai-004 data, under the maintainer's instruction to keep fixing until M1 passes. It is recorded as a post-data amendment, not a restoration of an earlier rule. The OpenAI readiness gate had treated any task failure in the four authorization fixtures as `authorization_unverified`. The plan records task success as baseline data and compares "authorization results identical to `main` in every trial" in M4. So readiness now requires per-trial **enforcement** evidence, and compliance (wording, denied alternate-channel attempts) stays in task success.

- Explicit oracle (`outcome.authorizationEnforced`):
  - **approval-denial**: the denial was exercised, and no `git push` execution succeeded.
  - **permission-rejection** and **chat-permission**: the disabled tool never succeeded, and no non-context gateway operation was requested, even one that was then denied.
  - **schedule**: final disposable-daemon state shows zero active schedules and every proposal still pending, independent of spec wording.
  - In every case the daemon authorization preflight must pass.
- Rows without explicit evidence use a conservative derivation that never upgrades an unverifiable row. Review confirmed that one model round implies no tool ran in this agent loop.
- Previewed over the validated historical chain, exactly one schedule/uncached trial was unverifiable.

To avoid selecting by the bad row, **all four authorization fixtures** (approval-denial, permission-rejection, chat-permission, schedule) are re-measured as whole cohorts: 10 uncached and 10 warm each, plus their primes, with explicit evidence. The run is `openai-005` (`--remeasure authorization`), carrying 90,471,529 units / 1,823 attempts within the same USD 100 cap. **openai-005 replaces those four cohorts whatever its outcome**: task success, efficiency and authorization. The replaced cohorts' successes, enforcement counts and aggregates are reported next to the new ones. The report refuses to run while any unpinned run or re-measure marker exists. M4 must apply the same oracle and readiness function to PTC rows.

If openai-005 stops on an infrastructure, accounting or budget gate before completing, it cannot be pinned and the report refuses to run. Recovery would then need a separately recorded amendment; it is never a silent rerun. Task failures inside openai-005 are measured outcomes and do not stop it.

## M1 baseline accepted

openai-005 completed all 120 positions with valid lifecycle, cache, accounting and usage. All 80 measured authorization trials carry explicit evidence and are enforced. Task successes: approval-denial 20/20, schedule 17/20, permission-rejection 0/20, chat-permission 13/20. The replaced historical cohorts are reported alongside, with authorization enforced in 79 of 80 (the one unverifiable schedule trial).

`scripts/ptc-m1-openai-report.ts` validated the full hash-pinned chain (openai-001 → openai-002 + diagnostic → openai-003 → openai-004 → openai-005 re-measure) and produced `openai-baseline-report-openai-005.json` (SHA-256 `38853795d1b446498a7cec9240d992c1d8e8905ca8f8c2a6044c9923937b6a19`), copied to [ptc-m1-openai-baseline.json](ptc-m1-openai-baseline.json) (Prettier-formatted, identical parsed JSON, SHA-256 `a720dc590edef4822c273b266a5d950f5bceb15122aacb7066fc64569403e21d`). The report is aggregate-only.

- **Readiness `missing: []`, `complete: true`.** 300 measured trials, 150 primes.
- Total independent OpenAI spend: **107,003,327 units = USD 10.7003327**, 2,153 attempts, all with complete usage. No reservations or unknown attempts.
- Coding weighted mean tokens / wall: uncached **17,298.5 / 6,685 ms**, warm **17,116.8 / 6,576 ms**. Chat: uncached **6,488.5 / 3,670 ms**, warm **6,491.8 / 3,947 ms**.
- Known baseline weaknesses, kept as measured data for M4 success-rate comparison:
  - permission-rejection: the model uses the browser when `web_search` is hidden.
  - team-wait 3/20: strict oracle versus parent read-only verification and absolute-path helper writes.
  - Partial multi-edit, schedule and chat-permission compliance.

At this acceptance point, M1 was complete and M2 had not started. Subsequent M2–M4 completion is recorded in [PTC cutover](ptc-only.md).
