# PTC Milestone 4 evaluation protocol (pre-declared)

Status: **completed evaluation history, including failed rounds and the passing public holdout**. The maintainer accepted the hybrid surface on 2026-10-07; see [cutover and review](ptc-only.md). Acceptance does not regrade failed rounds or complete the partial third round.

Original round 1 declaration: **declared before any PTC data** (2026-10-06); run `ptc-m4-001` completed the same day and **fails the bounds** (results in [ptc-only.md](ptc-only.md) Milestone 4 and [ptc-m4-openai-evaluation.json](ptc-m4-openai-evaluation.json); run artifact SHA-256: trials `3dbcfb63…fe0c`, budget `d7ef882c…e908`, summary `db112e3a…d59d`). It extends the M1 OpenAI protocol ([ptc-m1-openai.md](ptc-m1-openai.md)) to the PTC-only branch binaries. Nothing here regrades M1 rows.

## Comparison

- **Baseline (`main` side):** the accepted M1 OpenAI baseline, not re-run. That is the hash-pinned chain openai-001 → openai-005 and its aggregate report [ptc-m1-openai-baseline.json](ptc-m1-openai-baseline.json) (SHA-256 `a720dc59…e21d`; remote original `38853795…6b37`). It covers 300 measured trials with readiness `missing: []`.
- **PTC side:** one fresh matrix `ptc-m4-001` on Linux x64 builds of `feat/ptc-only`, pinned by hash in `apps/gateway/test/ptc-m1/m4-run.ts`.
  - Same 15 fixtures (`fixtures.ts` hash `39f59e86…d106`, enforced), 10 uncached + 10 warm trials each, plus primes.
  - Same model and protocol: `gpt-6.1-sol`, Responses, Standard tier, main reasoning medium, 16,384 output cap, approved auxiliary off/minimal→low mapping.
  - Same host, srt and cgroup measurement, readiness function (`openAIReadiness`) and authorization function (`authorizationEnforced`).
- **Budget:** the same independent USD 100 OpenAI budget, carried from the chain end (107,003,327 units / 2,153 attempts). The CLI refuses to start if the pinned ledger or report differs, or if any unpinned OpenAI run exists. It uses a new exclusive marker `.ptc-m4-openai-attempted`.
- **Prime policy:** `record`, as for the final M1 runs. A prime's task outcome is recorded, not gating; warm validity needs an identical initial body and an actual cache read.
- **First-triplet gate:** kept. By maintainer decision, the assistant reviews the aggregate evidence and publishes the approval.

## Oracle mapping (maintainer decision 2026-10-06)

`apps/gateway/test/ptc-m1/ptc-surface.ts`, mapping `ptc-nested-operations-v1`:

- A script's **nested operations** (events with `parentToolCallId`) are judged exactly as the M1 oracles judged direct calls. This covers names, arguments, results, errors and allowlists.
- The outer **`ptc` and `ptc_docs` calls are neutral**. They are not calls, not tool errors and not allowlist violations.
  - A script refused before anything ran (e.g. a capability unavailable in the session) produces no call. The model cannot call a hidden tool directly either.
  - Script failures are still counted (`ptc.scriptErrors`), and their cost is in tokens and rounds.
- Operations a script attempted that were refused mid-script (manifest, quota, concurrency, malformed arguments) emit no nested event and are likewise neutral; they are counted from the `ptc` result (`notStartedOperations`).
- **Image delivery** means an image in a result that reaches the model. For PTC, that is the outer `ptc` result carrying an attachment; a nested screenshot result reaches only the script.
- **Team, parent side:**
  - Nested `agent_spawn`, `agent_wait`, `agent_inbox`, `read` and `agent_list` are judged as before. Any other nested operation rejects, as in M1.
  - A nested `agent_inbox` result counts as delivery, as the direct inbox message did.
- **Team, child side:**
  - A `ptc` call counts as the helper's write call when every write in its script source is `tools.write({ path: 'team.txt', content: 'joined' })` with literal arguments, and its result details report every write operation that ran as `completed`. A later failure elsewhere in the same script does not undo the write, as with a direct write result.
  - Computed arguments, including a capability referenced without being called (e.g. aliased), are a variant (`nonLiteral`) and fail, like M1's path and content variants.
- `TEAM_ORACLE_REVISION` stays 2.

## Bounds (from docs/evaluations/ptc/ptc-only.md; refinements decided 2026-10-06)

Judged separately for coding and chat in `apps/gateway/test/ptc-m1/m4-bounds.ts` (`M4_BOUNDS` revision 1):

1. **Readiness:** the PTC matrix is complete under the M1 readiness function.
2. **Authorization:**
   - Covers approval-denial, permission-rejection, chat-permission and schedule.
   - Every PTC trial must be enforced, as every baseline trial was (10/10 per condition).
3. **Cancellation:** every cancel-wait trial is cancelled and successful, as in the baseline.
4. **Success:**
   - Per fixture, pooling uncached and warm (20 trials each side), PTC successes must be at least the baseline's.
   - Per-condition counts are reported, not judged.
5. **Single-call tasks** (single-bash, single-read; chat-web-search for chat):
   - Per condition, mean tokens ≤ 1.15 × baseline and mean wall ≤ 1.2 × baseline.
6. **Batch tasks** (multi-edit, dependent-edit):
   - Per condition, strictly fewer mean model rounds and strictly fewer mean tokens than baseline.
   - output-filter was dropped from the batch set before any data: both surfaces need at least two rounds there.
7. **Total:** per condition, weighted mean tokens (single-bash weight 5) ≤ baseline.

A failed bound blocks the merge; the reason is recorded in docs/evaluations/ptc/ptc-only.md. If coding passes and chat fails, the decision stays open there (abandon both, or a fixed split).

## Run policy

- The synthetic services' in-flight cap is raised from 8 to 32 requests (a script runs up to 8 operations at once); M1 never approached it.
- Like M1, an infrastructure, accounting or budget stop ends `ptc-m4-001`; the marker stays. Any continuation needs a separately recorded amendment, never a silent rerun. Task failures are measured outcomes and do not stop the run.
- The CLI refuses to start unless its `OPENAI_PROTOCOL` equals the baseline report's protocol.
- `metrics.toolErrors` counts every failed tool event on both surfaces; the PTC-specific `scriptErrors` and `operationErrors` are reported separately.

## Artifacts

- `scripts/ptc-m4-openai.ts` (run).
- `scripts/ptc-m4-report.ts` (aggregate report and bound verdicts).

Reports hold aggregates and fixed fixture IDs only.

Each trial also records fixed PTC surface counts: scripts, `ptc_docs` calls and bytes, operations, the number of operations per script, script errors and operation errors. These give the fan-out distribution that the quota decision asked for.

## Round 2: `ptc-m4-002` (pre-declared 2026-10-06, before its data)

`ptc-m4-001` stays recorded as measured and is not regraded. Round 2 evaluates a changed implementation under the same protocol, oracle mapping (`ptc-nested-operations-v1`), bounds (`M4_BOUNDS` revision 1), fixtures, model and baseline.

- **Implementation change (maintainer decision 2026-10-06), still PTC-only:**
  - The system prompt's capability section keeps the category index.
  - It adds complete compact TypeScript signatures (arguments, result fields, first sentence, parameter notes and two caveats: a failing `bash` command throws, and web results are untrusted) for the core capabilities `read`, `write`, `edit`, `ls`, `grep`, `find`, `bash`, `web_search` and `web_fetch`, whichever are available, and says they need no `ptc_docs` lookup.
  - Every other available capability gets a one-line summary and is documented through `ptc_docs` as before.
  - The `ptc` description points to the prompt for the common signatures.
  - This mirrors Anthropic's practice of keeping the most-used tool definitions loaded, with result formats documented, and discovering the rest on demand ([advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)).
  - Direct (non-script) calls are not reintroduced in this round.
- **Diagnostics added (content-free, never part of acceptance):**
  - Started operations per trial by fixed capability bucket (`ptc.operationsByCapability`).
  - Interaction requests by kind, and whether a confirmation or sandbox request named the fixture's exact `git push --force nowhere` (`services.requests`).
  - These explain approval-denial without recording arguments or content.
- **Budget:** continues from the end of `ptc-m4-001` (173,299,750 units / 4,294 attempts), within the same USD 100. The CLI checks the pinned `ptc-m4-001` artifacts and report, and refuses any other M4 artifact. New marker `.ptc-m4-002-openai-attempted`.
- **Gate:** the first triplet is reviewed by the assistant, as before. The full matrix of 300 measured trials and 150 primes runs once. An infrastructure, accounting or budget stop needs a recorded amendment, never a silent rerun.
- **Decision rule:** the round passes only if every bound passes for coding and for chat, judged against the M1 baseline (not against `ptc-m4-001`). Differences from `ptc-m4-001` are reported for information.

### Round 2 amendment: continuing the stopped `ptc-m4-002` (2026-10-06, maintainer decision)

`ptc-m4-002` stopped at row 310 of 450 (`schedule` / uncached / index 3). A parent model request returned HTTP 200 but its stream was cancelled on the client side before completion, so it has no usage. Under the fail-closed rule, the budget kept that attempt's full worst-case reservation (48,557,600 units = USD 4.85576) as an uncertain liability and halted. The stored aggregates do not show why the stream was cancelled; no session content was read. Spend at the stop was USD 22.7317065 (5,698 attempts), plus that liability.

The continuation, `ptc-m4-003`, uses the same pinned binaries and marker `.ptc-m4-003-openai-attempted`. It is decided before any of its data:

- **Artifacts:** `ptc-m4-002`'s trials, budget and summary are hash-pinned, with its controller and binaries. Every row's charged usage is recomputed. Every row before the stop must pass the cohort gates.
- **Uncertain attempt:** charged in full at its reservation (never under-counted). The carry is USD 22.7317065 + USD 4.85576 = **275,874,665 units / 5,698 attempts**.
- **Stopping row:** superseded (charged, not measured) and run again. The 309 rows before it are reused and never dispatched again. A trailing prime would also be superseded; there is none here.
- **No stage gate.** The run proceeds to the end of the matrix. If anything stops it again, it stops: no further continuation without a new recorded decision.
- **Report:** judges the combined matrix (309 reused rows plus the continuation) with the same oracles, readiness function and bounds. It lists the superseded row and the charged liability.

### Round 2 result

The combined matrix (`ptc-m4-002` rows 1–309, `ptc-m4-003` rows 310–450) ran to the end with readiness `missing: ["authorization_unverified"]` and **fails the bounds**. Summary in [ptc-only.md](ptc-only.md) Milestone 4; aggregate report [ptc-m4-round2-evaluation.json](ptc-m4-round2-evaluation.json).

Run artifact SHA-256:

- `ptc-m4-002`: trials `c55448b8…dbeb`, budget `cce88151…4eb0`, summary `cae9acdd…f079`.
- `ptc-m4-003`: trials `4f4ef1da…9224`, budget `4d5b5803…b8d9`, summary `a4435c1f…20d6`.
- Report: remote `5d23abfb…26bf`; the Prettier-formatted repository copy (now in this directory) is `ca541076…fcbd` (same parsed JSON).
- After the run, review hardened the continuation checks: the stopped run's fixtures, oracle mapping and bounds; the full continuation manifest in the report. The hardened scripts validate the same artifacts unchanged. The report was not regenerated, since its file is write-once.

## Round 3: hybrid surface, measured interleaved with `main` (pre-declared 2026-10-06, before its data)

Rounds 1 and 2 stay recorded as measured. Round 3 changes the implementation and the comparison design; fixtures, oracles (`ptc-nested-operations-v1`, with direct calls judged natively), model, protocol, readiness function and `M4_BOUNDS` revision 1 are unchanged.

- **Implementation (maintainer decision 2026-10-06; no longer PTC-only):**
  - Core capabilities (`read`, `write`, `edit`, `ls`, `grep`, `find`, `bash`, `web_search`, `web_fetch`, when available) are direct model tools as well as script capabilities. A direct call runs the same policy chain as a `ptc` operation; typed data stays on the host. Every other capability is reachable only from `ptc`, and a direct call to one is refused with a pointer to `ptc`.
  - The prompt routes single operations and anything that may need approval to direct calls, and several combinable operations to `ptc`. Dialogs a direct call opens carry its call id, like a script operation's.
  - It states the approval convention: the host asks as the operation runs, so request approval by running it, never separately (for example with `ask_user_question`).
  - Core signatures stay for scripts. Other capabilities are listed by name only (no summaries), documented by `ptc_docs`.
  - This follows OpenAI's routing guidance for Programmatic Tool Calling (direct calls for single actions and approval-sensitive writes; `allowed_callers` direct + programmatic), Codex's default code mode alongside direct tools, and Anthropic's `allowed_callers` and always-loaded core tools.
- **Comparison design (maintainer decision 2026-10-06):**
  - The pinned M1 `main` binaries (node `164769ca…1d80`, chat `be2eb5fb…aaf`) and the new branch binaries run in the same session, interleaved.
  - For each fixture and index, both arms run their own uncached, prime and warm trials. `main` goes first on even indices and the branch on odd ones.
  - 600 measured trials and 300 primes, one shared budget, one first-stage review (both arms of the first index).
  - Rows are judged by the same gates per arm.
- **Decision rule:**
  - The primary verdict judges the branch arm against the **concurrent `main` arm** with `evaluateM4`, coding and chat separately. The `main` arm must itself be ready under `openAIReadiness`, with every authorization trial enforced and every cancel-wait trial cancelled (the parity the bounds compare against). If it is not, the round is reported but unjudged; a weak `main` arm never fails the branch.
  - The verdict against the M1 baseline is reported as secondary.
  - The round passes only if the primary verdict passes and the run completes cleanly.
- **Continuation:** a stop on an infrastructure, accounting or budget gate is continued under the round 2 amendment rule:
  - rows before the stop are reused;
  - attempts without usage are charged at their full reservation;
  - the stopping row, and a trailing prime that lost its pair, are superseded and repeated.

  The assistant may continue at most twice without a new decision, by pinning the stopped run first.

- **Budget:** continues from the end of round 2 (292,259,993 units / 6,169 attempts) within the same USD 100. Expected cost USD 15–20.
- **Diagnostics added (content-free):** direct calls by capability bucket, and wall time split into main-model request time and the rest.

### Round 3 amendment: more continuations (2026-10-06, maintainer decision)

Both stops so far happened on the `main` arm's team-wait, at index 3:

- `ptc-m4-r3-001` stopped on row 562 of 900, the uncached trial.
- Its continuation `ptc-m4-r3-002` stopped on its second row, the prime trial.

Each time, an auxiliary request (reasoning off, output cap 512) was cancelled mid-stream while the trial's agents were closing. It had no usage, so its full reservation was kept and the budget halted. Provider latency was higher than on earlier days: auxiliary requests took 5–8 s against about 2 s before.

The continuation limit rises from two to **six**; the rule itself is unchanged. Every uncertain attempt is still charged at its full reservation, and the harness and measurement stay as they are for both arms.

### Round 3 amendment: read abandoned responses for their usage (2026-10-06, maintainer decision)

The second continuation, `ptc-m4-r3-003`, stopped the same way, on main / team-wait / warm / 3. The cause is now understood. The harness already waits until no request is in flight before it closes the agent. The `main` binary's team shutdown then issues one more auxiliary request itself, and the exiting process cancels it about 0.9 s later. This happens on almost every remaining `main` team-wait trial, so continuing under the old relay would stop again and again.

From the continuation `ptc-m4-r3-004` on, for both arms, the trusted relay handles a client that goes away mid-stream differently:

- It no longer cancels the upstream request. It reads the response to the end, for at most 60 s, and records the attempt with its real usage, marked `clientCancelled`.
- Closing the provider first lets in-flight attempts finish being read, under the same bound.
- If a response does not end in time, the attempt stays uncertain, is charged at its full reservation, and halts the run, as before.

The three uncertain attempts already charged (`ptc-m4-r3-001`, `-002`, `-003`) stay charged at their reservations, and every recorded row is reused unchanged. Rows before this amendment were measured under the old relay. The only difference this could make is how much of an abandoned request is billed, which is outside what the bounds measure.

### Round 3 end (2026-10-07, maintainer decision)

The third continuation, `ptc-m4-r3-004`, stopped on main / team-wait / uncached / 4. The abandoned auxiliary response was read to its end, but the upstream stream ended without usage; it was charged at its reservation like the others.

With three of six continuations used (four runs) and the cause unresolved, the maintainer ended round 3 here without a verdict. The partial report validates the whole stop chain and reports only what was measured. Results are summarized in [ptc-only.md](ptc-only.md) Milestone 4; the aggregate report is [ptc-m4-round3-partial.json](ptc-m4-round3-partial.json) (remote `22cf7d55…4ce0`, Prettier copy `b1fd100b…09bc`).

Run artifact SHA-256, trials / budget / summary:

| Run    | Trials          | Budget          | Summary         |
| ------ | --------------- | --------------- | --------------- |
| r3-001 | `cf6ce8d5…0c5d` | `fc0a8b4b…cf6e` | `3e5a43db…370a` |
| r3-002 | `7c73e3cb…3ffd` | `1d0694d1…9eb4` | `f4a73073…88b7` |
| r3-003 | `bf9bad76…77ea` | `6cb87dd8…5925` | `6ad7fc71…86a8` |
| r3-004 | `3becb979…702f` | `bde3f544…7928` | `901192ce…1d68` |

### Round 3 stops: offline diagnosis (2026-10-07, no spend)

The four stopping attempts are auxiliary requests with requested reasoning `off` and output cap 512. Of the auxiliary features, only the session-title generator (`features/title.ts`, `MAX_TOKENS = 512`, thinking off) sends exactly that request. On `shutdown()` it aborts any title request still in flight. That code is identical on both arms (the branch has not changed `title.ts` since `main@16c80846`). A trial that ends while its title request is still running therefore leaves an abandoned request on either arm. The `main` arm's team-wait trials just happened to end in that window.

This is an inference from fixed aggregate fields; no content was read. Before resuming, a new pre-declared decision could:

- disable title generation for both arms in the disposable fixture config (it is not part of any fixture's task); or
- wait for the title request before closing the agent.

## Round 4, the final round: Pi-codemode-informed changes (pre-declared 2026-10-07, before its data)

The maintainer ruled that this is the last round that borrows from other harnesses. Round 3 stays partial; it is not completed with its own binaries.

**Implementation (maintainer decision 2026-10-07).** The round 3 hybrid surface and routing are kept, plus three ideas from Pi 1.0's codemode ([docs](https://pi.dev/docs/latest/codemode), [Armin Ronacher](https://lucumr.pocoo.org/2026/10/6/codemode/)):

- **Signatures within a budget.** The system prompt lists the TypeScript signature of every available capability that fits in about 3,000 tokens (12,000 characters), as Pi's codemode inline budget does. Core capabilities come first, then the others shortest first. Only what does not fit is named for `ptc_docs`.
- **Non-zero `bash` exits resolve.** In scripts, a `bash` command that ran to a non-zero exit resolves with its typed result instead of throwing; timeouts and aborts still throw. As in Pi, where `bash` resolves to `{ output, exit_code, … }`. The nested operation event still reports the error, so oracles are unaffected.
- **`store(key, value)` / `load(key)`.** Scripts keep small JSON values across `ptc` calls: at most 262,144 characters per value and 1,048,576 in total, checked in the script and again on the host. Values persist as session entries only when a script completes, as in Pi. A store written by scripts that read web content stays tainted: every later script's output is fenced as untrusted until the store is emptied.

**Comparison design.** As in round 3:

- The interleaved paired matrix against the same pinned M1 `main` binaries.
- The primary verdict judges the branch against the concurrent `main` arm, which must be ready and have authorization/cancellation parity, otherwise the round is unjudged.
- The verdict against M1 is secondary.
- The round passes only with a clean, complete run.

**Changes from round 3:**

- **Session titles are off for both arms** (`features.sessionTitle.enabled: false` in the disposable fixture config). Title generation is part of no fixture, and its abandoned requests caused all four round 3 stops.
- **The independent OpenAI budget limit rises to USD 150** (maintainer decision 2026-10-07). The protocol is otherwise unchanged and still equals the M1 baseline's.
- **The budget continues from the validated round 3 stop chain:** 587,296,559 units / 8,545 attempts, including round 3's four charged reservations.
- **Continuations** follow the round 2 amendment rule, at most six, each pinned first.

**Run names:** `ptc-m4-r4-001` and so on; scripts `scripts/ptc-m4-r4.ts` and `scripts/ptc-m4-r4-report.ts`.

### Round 4 result

`ptc-m4-r4-001` ran all 900 rows in one process, with no stops. Readiness is complete for both arms, and the run summary is complete.

The round **fails** against the concurrent `main` arm and against M1, for coding (dependent-edit rounds; output-filter and schedule success) and for chat (chat-web-search tokens, chat-permission success, weighted total tokens). Summary in [ptc-only.md](ptc-only.md) Milestone 4; aggregate report [ptc-m4-round4-evaluation.json](ptc-m4-round4-evaluation.json).

Hashes (SHA-256):

- Run artifacts: trials `e2199118…d249`, budget `b2af1787…5bd5`, summary `8c4c7ca5…f4c3`.
- Report: remote `7fce5b2e…d9bf`; the Prettier repository copy (now in this directory) is `2fada345…84a7`.

This was declared the final round.

## Round 5, the final optimization round (pre-declared 2026-10-07, before its data)

The maintainer asked for one more round to see how far the hybrid surface can go. Fixtures, oracles, bounds, model, protocol and the comparison design are unchanged from round 4: the interleaved paired matrix against the pinned M1 `main`, titles off for both arms, primary verdict against the concurrent `main`.

**Implementation changes (maintainer decision 2026-10-07)**, aimed at round 4's failures:

- **Compact signatures.**
  - Core capabilities keep their full signatures.
  - Every other capability gets a one-line call signature: its arguments and the first sentence of its description, with no result fields or parameter notes. Its typed result fields remain in `ptc_docs`.
  - The budget falls from 12,000 to 10,000 characters, and every capability of the evaluated sessions fits. In round 4, schedule, background_task and the team capabilities overflowed and cost a lookup round.
- **Complete list.** The prompt states that the listed capabilities are all that exist in the session, so nothing else should be looked for. This targets round 4's chat-permission lookups.
- **Routing.** The routing line now tells the model to use one script when later operations follow from earlier results in a way code can work out. It gives a generic example: run the tests, then read each file the output reports as failing. This targets dependent-edit, which stayed on the direct route step by step. An earlier draft used an example with the same shape as that fixture (read a file, take a name from it, act on that name); review replaced it before any data, to avoid tuning to a fixture.

**Budget.** It continues from the end of round 4, 763,944,992 units / 11,232 attempts, within the USD 150 limit.

**Runs.** The run is `ptc-m4-r5-001`, with scripts `scripts/ptc-m4-r5.ts` and `scripts/ptc-m4-r5-report.ts`. Continuations follow the round 2 amendment rule.

### Round 5 result

The combined matrix (`ptc-m4-r5-001` rows 1–582, `-002` none kept, `-003` the rest) ran to the end, with readiness complete for both arms.

- **Stops:**
  - The first, a gate stop, came from an unattributable helper.
  - The second came from a response without usage, charged USD 4.86.
- **Verdict: fails**, both against the concurrent `main` (primary) and against M1 (secondary). Against M1, coding also fails output-filter success (19 against 20), and chat fails chat-permission (2 against 13) and weighted tokens (+4% / +12%).
  - **Coding:** dependent-edit has 5.0 rounds against 4.9. Every other coding bound passes against the concurrent `main`.
  - **Chat:** chat-permission success is 2/20 against 12/20, and weighted tokens are +7% / +15%.
- **Summary:** [ptc-only.md](ptc-only.md) Milestone 4. Aggregate report: [ptc-m4-round5-evaluation.json](ptc-m4-round5-evaluation.json).
- **Hashes (SHA-256):**
  - `ptc-m4-r5-003` artifacts: trials `88d8b4e5…c3c8`, budget `e9b92984…ad2e`, summary `7c59ff1c…a6db`.
  - Report: remote `f25acfed…f66f`; the Prettier repository copy (now in this directory) is `110a81bd…829c`.

## Public benchmark: dependent multi-step edits (pre-declared 2026-10-07, before its data)

The maintainer leans towards accepting the hybrid surface (direct core tools plus `ptc`). The formal decision waits for this supplementary evaluation. It targets the remaining weakness, dependent multi-step work (dependent-edit kept equal rounds in rounds 3–5), on a public test set instead of our own fixtures.

**Dataset.**

- The Python exercises of the [Aider polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark) (Exercism), pinned to commit `7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f`, with every used file hash-pinned (`apps/gateway/test/ptc-m1/polyglot-manifest.json`).
- The workspace holds the solution stub and the tests, never `.meta` (the example solution).
- The prompt is the exercise's instructions, followed by Aider's benchmark wording (modify the supplied files, keep names, standard library only) and one sentence saying where the tests are and how to run them (`python3 -m unittest -q <test modules>`; review corrected a bare `python3 -m unittest -q`, which runs no tests here, before any data).
- **Success means the pristine tests pass.** The harness copies only the supplied solution file (a regular file, never a link) next to the pristine tests in a fresh directory. It runs them by module name with the work directory last on Python's path, in a bubblewrap sandbox: read-only system, no network or environment, a resource-limited scope (1 GB, 128 tasks), 120 s limit.
  - A pass needs exactly the pinned number of tests (from the example solutions) to run without failures.
  - Model-written code never runs outside a sandbox.
  - A sandbox that cannot run Python is an infrastructure error.
  - Before any spend, every example solution must pass and every stub must fail.
  - Solutions that mention test-process internals (`unittest`, `sys.exit`, …) are counted for review.
- **A trial that reaches the 900 s deadline is aborted and counted as a failed attempt**, not an infrastructure stop.

**Split (fixed before any tuning).** An exercise belongs to the development set when `sha256("pirc-m4-polyglot:" + name)[0] < 128`:

- Development set (15): beer-song, food-chain, grade-school, hangman, paasio, pig-latin, poker, proverb, react, rest-api, sgf-parsing, variable-length-quantity, wordy, zebra-puzzle, zipper.
- Holdout set (19): affine-cipher, book-store, bottle-song, bowling, connect, dominoes, dot-dsl, forth, go-counting, grep, list-ops, phone-number, pov, robot-name, scale-generator, simple-linked-list, transpose, tree-building, two-bucket.

**Procedure.**

- **Tuning.** Up to three development runs, all before the holdout run (`ptc-m4-poly-NNN --dev`): the branch build only, one uncached trial per development exercise. Between them the implementation may change to improve dependent multi-step behaviour. Changes must be generic: no exercise-specific text, and nothing from holdout exercises. Development results are reported but never judged.
- **Judgement.** One holdout run (`--holdout`): the pinned M1 `main` and the pinned final branch build, interleaved per exercise and trial with alternating order. Two uncached trials per exercise per arm (38 per arm). The assistant reviews the first stage. If an infrastructure, accounting or budget gate stops it, it is rerun in full under a new name, at most twice; stopped rows are charged and reported, never reused.
- Session titles are off for both arms; trial deadline 900 s.

**Bounds (holdout, branch against the concurrent `main`).** All must hold:

1. Readiness is complete for both arms.
2. Tests-pass count (the oracle above, regardless of the final stop reason): the branch's is at least `main`'s.
3. Mean tokens per trial: the branch's is no more than `main`'s.
4. Mean model rounds per trial: the branch's is strictly fewer (the batch criterion, applied to dependent multi-step work).

Mean wall time is reported.

**Budget.** It continues from the end of round 5 (966,430,967 units / 13,770 attempts) within the USD 150 limit. An uncertain reservation left at a stop counts as spent.

### Public benchmark results

**The holdout run passes every declared bound.** Aggregate reports: [holdout](ptc-m4-polyglot-holdout.json), [development 1](ptc-m4-polyglot-dev1.json) and [development 2](ptc-m4-polyglot-dev2.json).

**Development runs** (branch only, 15 exercises, one trial each; for tuning, not judged):

| Run               | Build                                          | Tests pass | Mean rounds | Mean tokens | Mean wall |
| ----------------- | ---------------------------------------------- | ---------- | ----------- | ----------- | --------- |
| `ptc-m4-poly-001` | round 5 source, rebuilt (node `42567491…3eee`) | 15/15      | 4.2         | 46,623      | 21.7 s    |
| `ptc-m4-poly-002` | after one generic change                       | 15/15      | 3.0         | 41,397      | 17.9 s    |

- In run 1 the usual sequence was: one script reading the stub and the tests, a direct write or edit, a direct test run, then the answer.
- The change added one routing sentence: writing or editing a file and then checking it (tests, build, linter) is a dependent sequence, so do both in one script and return the check's output.
- Tuning stopped after run 2 (two of the three allowed development runs).

**Holdout run** `ptc-m4-poly-003`: 19 exercises, 2 trials per arm, interleaved. The run completed and readiness is complete for both arms.

| Bound                       | `main` (M1) | Branch        | Result       |
| --------------------------- | ----------- | ------------- | ------------ |
| Tests-pass count            | 38/38       | 38/38         | pass (equal) |
| Mean tokens per trial       | 52,001      | 35,218 (−32%) | pass         |
| Mean model rounds per trial | 5.55        | 3.16 (−43%)   | pass (fewer) |
| Mean wall time (reported)   | 24.8 s      | 17.8 s (−28%) | —            |

- No trial hit the deadline, and no solution was flagged as suspicious.
- The branch had fewer rounds in all 19 exercises.
- It used more tokens in one exercise only: pov, 68,018 against 44,605.

**Caveats:**

- Both arms solved every holdout exercise, so the success bound cannot separate them on this set.
- Tuning was limited to one sentence developed on the development set. The holdout exercises were never seen during tuning.
- Review after the run found an oracle gap: a solution printing the runner's result line itself could have faked a pass. Solutions are not kept, so this cannot be ruled out after the fact. No solution was flagged, and both arms are equally exposed. The oracle now also requires a successful runner exit status and exactly one result line, and flags such text; these fixes apply only to future runs.

**Spend and run artifacts.** USD 10.00 in total: development 1.51 and 1.36, holdout 7.14. The independent budget stands at USD 106.65 of 150.

Run artifact SHA-256, trials / budget / summary:

| Run      | Trials          | Budget          | Summary         |
| -------- | --------------- | --------------- | --------------- |
| poly-001 | `6ac104cd…688b` | `ed27ac91…bd85` | `69a8693c…441e` |
| poly-002 | `16f27ad3…cc91` | `afecb153…63fd` | `749703c2…ec5e` |
| poly-003 | `15556e4a…2274` | `201aac87…9612` | `88ba56d0…5373` |
