# PTC Milestone 1 evaluation protocol and evidence

> **Current protocol superseded:** the maintainer approved direct OpenAI `gpt-6.1-sol`, uncached/warm and an independent new USD 100 budget. See [ptc-m1-openai.md](ptc-m1-openai.md). The Opus-only/cold-warm material below is historical evidence, not permission to restart its stopped run or reset its markers. OpenAI implementation is in progress; no OpenAI generation requests have been sent.

Current status: **M1 incomplete; the 300-trial real-model baseline has not run.** A single-bash live preflight succeeded (preflight002, five complete provider attempts); 14 non-team fixtures passed genuine-srt fake-model runner integration. Team attribution, cohort/cache orchestration and final acceptance remain open. Current conservative budget occupancy is **$8.6389902 / 43,194,951 units**, including the old $8.32768 worst-case liability; this is not an invoice. The one-shot retry is consumed. No token-saving or cutover claim follows.

The evidence sections below are chronological snapshots. Earlier statements about unimplemented components, old spend, pending approvals or the deleted OrbStack environment are **historical and superseded** by the preflight002 and runner sections. Use the current status and final remaining-prerequisite list for continuation, not an earlier budget value.

## Frozen comparison protocol

- Baseline binary source: `main@16c80846da64c07114d8cd43bab68748e5474127`, not an unpinned moving main. PTC development branch: `feat/ptc-only`; main is unchanged.
- Model: Claude Opus 5.5 only. Before live execution record exact provider/model ID, transport, thinking, output cap, image capability, endpoint identity (not secrets), both binary hashes and fixture/protocol hashes. No fallback model.
- Ten measured trials **per fixture, per binary, per cache condition**. Cold and warm must be established by provider-supported controls and observed cache usage; a new session/process is not proof. Invalid cache trials are reported separately and do not count as valid trials. Record warm-up cost separately and in the total billed-use ledger.
- Separate coding and chat reports. Weight single bash 5, other tasks 1. Publish unweighted per-category results as well so weighting cannot hide regressions. Compare mean per-trial token and wall values within each category/cache cohort; weighted means apply only to aggregate efficiency. Authorization/cancellation must match every trial, not on average.
- Bounds remain: no category success regression; single bash/read/chat search at most +15% total tokens and +20% wall; batches strictly fewer rounds and tokens; weighted aggregate tokens no greater than baseline. A missing category or metric blocks evaluation.
- Fixture prompts/setup/oracles are shared independently of schemas. Use the established **JSONL agent RPC integration boundary**, explicitly approved by the maintainer despite being an internal CLI subcommand. The harness must not invoke Agent internals or rewrite prompts for direct versus PTC tools.
- Wall measurement starts with task prompt dispatch and ends at `agent_settled`, including fixed interaction delays, excluding process startup; startup is reported separately. Use an event boundary per prompt, not an old settled event. Count every billable attempt and child/auxiliary request, not only final successful history. No model polling while jobs/children run.
- Runtime resources include agent descendants (old Bun worker, jobs and team children); report service/provider overhead separately. On 2026-10-03 the maintainer approved Linux cgroup v2 `cpu.stat` and `memory.peak` instead of peak RSS, with both M1 and M4 binaries measured in the same Linux/cgroup environment. `memory.peak` includes anonymous memory, page cache and charged kernel memory: **never label it RSS**. The collector must establish cgroup membership before spawning descendants and keep the controller/provider outside the measured group. Record startup separately and explicitly identify the resource observation window. Null resource or child usage is **missing**, never zero. JSON schema/context sizes are UTF-8 bytes, not token estimates. Capture each model request's lengths, including failures; use actual provider token usage for acceptance.
- Synthetic external services only: never publish/send/purchase or modify real schedules. Do not read/replay historical sessions. Reports contain aggregate metrics and fixed fixture IDs, no raw scripts, requests, headers, transcripts, arguments or intermediate results.

## Implemented offline preparation

`apps/gateway/test/ptc-m1/fixtures.ts` defines 15 total shared task descriptions, including cancellation and chat permission fixtures; the image-perception revision was explicitly approved and versioned. `ptc-m1-fixtures.test.ts` exercises setup, JSONL transport, disposable workspace cleanup, fake-service responses and basic filesystem/event oracles against source or compiled binaries. Its scripted model is **only a protocol smoke adapter** for the existing direct-tool surface, not the comparative model driver. It deliberately cannot measure fluency, token savings or cache behavior; its canned answers do not establish reasoning success. The same natural-language fixture catalog remains the input for the future real model.

Smoke coverage: one bash/read, multi-file edits, dependent edit, filter input, fake screenshot image in tool output, selected user answer, denied operation, background build/wait, helper/wait, pending schedule proposal, unavailable gateway capability, cancellation, chat search and unavailable default-chat background task. Browser smoke does not yet prove actual image perception/client delivery. Schedule smoke proves proposal semantics at agent RPC, not daemon approval enforcement. Existing integration authorization tests remain necessary.

`metrics.ts` collects numeric-only aggregates and rejects incomplete/synthetic baseline readiness. Provider-authoritative collection is now wired in the test-only runner; complete child attribution and cohort/report acceptance remain outstanding. A type definition or smoke result alone is not readiness evidence.

```sh
bun test apps/gateway/test/ptc-m1-fixtures.test.ts \
  apps/gateway/test/ptc-m1-metrics.test.ts \
  apps/gateway/test/ptc-m1-spike.test.ts

# Same smoke test can target a separately built, pinned unchanged-main binary pair.
PTC_NODE_BINARY=/absolute/baseline/pirc-node \
PTC_CHAT_BINARY=/absolute/baseline/pirc-chat \
bun test apps/gateway/test/ptc-m1-fixtures.test.ts
```

No real-model switch is provided in the smoke harness: it always uses a loopback fake model and minimal environment. Starting an agent directly does **not** install srt, so the smoke harness must not be repurposed for untrusted live scripts. Fake srt is test-only, never security evidence.

## QuickJS-WASM isolation spike

`ptc-m1/spike.ts` is test-only, never imported into production registration. It embeds release-asyncify WASM (`quickjs-emscripten-core` / wasm variant 0.31.0; 0.32.0 rejected after reproducible host-reference finalization errors) with Bun's file loader. A fresh WASM runtime per execution gets a realm-local tools closure and JSON-only bridge; no environment, module loader, filesystem, network, subprocess or host reference. Host promises feed realm promises via bounded job pumping; this allows deliberate parallel calls without Asyncify stack reentry. Constructor-chain tests prove realm-local construction cannot reach host globals; they do not pretend removing Function constructors is a sandbox.

Tests cover TypeScript stripping, large-file reduction, ambient/global/constructor escape probes, failed dynamic import, prototype capability names, pending quota reservation, cancellation plus late replies, wall timeout during suspension and CPU loops, source/output/call/memory limits and overlapping independent executions. M2 still must add AST manifest, real authorization, structured concurrency, bounded console, attachment helper and human-wait accounting.

A 4–8 MiB JSON bridge exposed a WASM-growth cleanup failure with dynamically growing backing memory. Fixed 256 MiB WASM backing avoids growth; the managed QuickJS heap remains capped at 128 MiB. This is a spike allocation choice, not proof total process memory is 128 MiB. Keep the large-file regression. Production memory/concurrency costs require further review.

```sh
bun scripts/ptc-spike.ts
bun build --compile --minify scripts/ptc-spike.ts --outfile dist/ptc-spike
(cd /tmp && /absolute/checkout/dist/ptc-spike)
```

Local synthetic evidence, 2026-10-03, Bun 1.4.2, macOS ARM64, 20 runs of one fake echo call, no model:

| Runtime entry                                  | QuickJS p50 / p90 | Existing Bun worker p50 / p90 |
| ---------------------------------------------- | ----------------- | ----------------------------- |
| source script                                  | 19.69 / 47.71 ms  | 205.63 / 387.15 ms            |
| compiled single-file experiment, unrelated cwd | 11.24 / 16.29 ms  | 85.26 / 109.85 ms             |

Both completed an 8 MiB synthetic read/reduction at 128 MiB managed heap. Reported process max RSS was 180,992 / 180,224 KiB respectively, including the benchmark host but **not a whole-process-tree resource baseline**. Timing is noisy and includes runtime initialization; comparison uses the unchanged legacy worker implementation in the experiment, not a deployed end-to-end baseline. It must not be represented as model latency or token savings. The compiled experiment establishes embedded-WASM feasibility on this platform, not production node/chat integration on all platforms.

## Authorized live preflight (2026-10-03; not baseline evidence)

- Maintainer authorized completing M1 only, with a USD 100 **official-price equivalent** total cap, not a claim about the proxy's actual invoice. Exact model: `claude-opus-5-5`; Anthropic Messages; adaptive thinking at medium effort; output cap 16,384. No fallback model. Model-list lookup succeeded. Endpoint and credentials stay out of tracked artifacts.
- Official standard prices: input $4, output $20, 5m cache write $5, 1h write $8, cache read $0.20 per million tokens ([source](https://platform.claude.com/docs/en/models/opus-5-5/overview)). The ledger conservatively charges all cache writes at $8. Reserve before dispatch, include all auxiliary/retry/warm-up/invalid attempts, and halt with outstanding liability retained on incomplete usage.
- Two small synthetic **non-streaming transport probes**, not agent trials, returned the exact model ID, expected output and complete usage. Probe 1: input 2, output 17, cache write 2,516, cache read 0. Probe 2: input 2, output 17, cache write 0, cache read 2,516. Conservative total: **$0.0213272** (106,636 ledger units of $0.0000002), deducted from the same $100 cap. This proves observed cache reuse for that synthetic prefix, not baseline cache readiness, streaming completeness or model task success.
- Maintainer approved waiting for the native 5m ephemeral TTL and verifying cold initial usage, without salting or rewriting fixture prompts/schemas. Warm prefixes must be primed and verified; priming is billed. Cache contamination or unavailable usage invalidates a trial.
- Genuine embedded-srt confinement passed on macOS outside the invoking sandbox with a fake model; this is confinement evidence only. Docker cgroup v2 was available, but default seccomp blocked bubblewrap namespaces; an approved narrow profile progressed to a `/proc` mount denial. No privileged/unconfined/weaker-sandbox fallback was used. Docker testing stopped in favor of a newly approved isolated Debian 13 ARM64 OrbStack machine (no host sharing/integration or SSH-agent forwarding; isolated from host/other-machine IPs). Its unprivileged user/PID/network namespace probe passed. The pinned Linux node binary passed the full confinement test (1 test, 14 assertions) after the **test harness only** was corrected to use production's secret-free Unix inference socket instead of unreachable host loopback HTTP, and to accept Linux masking/read-only error messages. Both node/chat binaries built with Bun 1.4.2; SHA-256: node `c7600b2b0f805c702f272731db2d5c1ebd31c7ea8578abd3a33deab299357006`, chat `adf105fd9e9b0c341434ba9e5a76811b512a253e9da559296c3efa3cc4b2c60d`. A disposable systemd user unit exposed `cpu.stat` and `memory.peak`; complete descendant accounting, measured-window collection, chat confinement and the live launcher remain unverified.
- Test-only `live-budget.ts` now connects to `live-provider.ts`: a credential-free Unix inference catalog routes through the unchanged native Anthropic adapter and a trusted authenticated wire relay. The relay records only numeric usage/size/timing, reserves worst-case liability before requests, rejects redirects/model substitutions, and stops on missing usage. Scoped fresh review found cumulative-usage, duplicate-uncertainty, invalid-EOF and early-stream-cleanup defects; fixes and regression tests landed in the working tree. Additional cleanup/failure injection and a final review remain required.
- `live-driver.ts` launches unchanged Linux node/chat under genuine embedded srt in a dedicated non-delegated systemd user cgroup. Both JSONL smoke tests passed (2 tests, 18 assertions) with a synthetic provider, startup handshake, post-dispatch settled timing, unit identity checks and bounded unit/cgroup cleanup. These are **not live model trials or task-success evidence**. The full descendant, failure-path and chat-confinement proofs remain open.
- Protocol v2 uses `cgroupMemoryPeakBytes`, never `maxRssBytes`. CPU samples bracket prompt dispatch and observed settled; memory peak covers unit creation through the post-settled sample (including startup). The result records start lead and end lag rather than pretending resource sampling is atomic with JSONL receipt. Provider/controller stay outside the measured unit. No writable cgroup delegation is given to the agent merely to reset peak memory.
- No further paid requests were made during this implementation pass; spend remains **$0.0213272 equivalent**. The CLI/cohort runner, safe credential handoff to the isolated machine, fixture oracles and full report pipeline are not yet implemented. Main turns default to medium; unchanged auxiliary features may choose their own thinking levels and must be recorded rather than silently rewritten.

## Continuation evidence and environment change

- A separate Linux cgroup proof passed (1 test, 8 assertions): detached child, nested short-lived CPU work, touched 64 MiB allocation, controller exclusion, expected-unit binding and empty group after stop. This improves resource evidence, but does not replace live worker/team fixtures or full chat confinement.
- Maintainer approved revising the shared `browser-image` prompt to read a unique code from the screenshot and include the image. `image.ts` supplies a deterministic pixel-only synthetic code; smoke and live fixtures must use the same asset and revised prompt. This approval does not itself prove perception or delivery.
- A single-bash preflight CLI and durable numeric reservation checkpoints are being implemented. Fresh review identified cancellation, pinning, short-write durability, fatal-event handling and final-oracle issues; fixes are in progress and paid execution remains gated. The CLI's existing ARM64 binary pin is **not portable to a rebuilt host** and must be re-established from the frozen source/environment before use.
- The isolated OrbStack environment exposed disk-backed swap; even its root could not disable swap. **No key was injected and no paid Linux request was sent.** The maintainer then requested migration to a separate Arch Linux host over ordinary SSH/Tailscale and cleanup of the old environment. The dedicated machine and this task's probe/Bun Docker images were deleted; existing machines/images were untouched. Do not recreate the old environment from this runbook.
- Remote preparation is authorized only for prerequisite inspection, a dedicated test directory, fixed-commit source archives and test files. System package installation/global settings still require approval. SSH host-key verification has not yet completed; the maintainer chose to verify/accept it manually. Do not disable strict host-key checking or transfer credentials before confirmation.
- Last complete repository check (before this continuation's added preflight/image/cgroup files) passed outside the invoking sandbox: gateway 685 pass/49 skip, web 268 pass, compiled 115 pass; versions, formatting, types and builds passed. Latest new files still require a fresh full check. Spend remains **$0.0213272 equivalent**.

## Replacement Arch host verification

SSH/Tailscale authentication was completed by the maintainer. The replacement Arch x86_64 host has no active swap; process-local `ulimit -c 0` is required because the host default allows cores. Bun 1.4.2 SHA-256: `a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c`. Source archive SHA-256: `bdc1d1eed276c9b586e143f08fdc29fb3c9920564c332989ded84e30482b4c72` from the frozen baseline commit. Fresh compiled hashes:

- node: `164769ca8c6645747eed2c6c47a2e2561a53936a9cf30427069a0ff8fb7f1d80`
- chat: `be2eb5fbf1908dd1ddaa74be79cdb503e7dafcf73413a0d1fb2a87618fea8aaf`

On this host, driver/provider/budget/artifact/cgroup fake-model tests passed (18 tests, 110 assertions), followed by pinned-node full srt confinement (1 test, 14 assertions). No credentials were sent during those tests. The preflight CLI now pins this node hash and checks `/proc/swaps` and zero core limits before reading stdin. These checks are not proof of full live readiness; preflight review and interruption tests remain open.

Protocol v3 records the approved shared image-perception prompt revision. Disposable-daemon tests now exercise actual production operation/session/capability authorization and a pending schedule proposal without listening on HTTP or approving any schedule (2 tests, 14 assertions). These do not claim HTTP/WebSocket authentication coverage. Initial content-reducing fixture oracles have four tests but still need review and integration.

## Paid single-bash preflight 001 — failed closed

The authorized pinned Arch node completed the main task (one bash invocation/result, two main model rounds, 4,759.14 ms wall). However, four total provider attempts were observed and the fourth had incomplete wire usage. The aggregate-only artifact is [ptc-m1-preflight-001.json](ptc-m1-preflight-001.json). **This is not a valid baseline trial.** No raw session or provider payload was inspected or retained in the report. The measured systemd unit was confirmed absent afterward.

Confirmed cumulative equivalent spend is now **$0.1431552** (715,776 units), including earlier transport probes. One unresolved request retains **$8.32768** (41,638,400 units) worst-case liability. Total budget occupancy is **$8.4708352**, not $0.1431552 alone. Live execution is halted pending reconciliation and closure-lifecycle investigation; the preflight CLI explicitly refuses another paid run so a fresh `--prior-units` cannot accidentally reset liability.

The numeric report alone does not establish why usage was incomplete. Immediate agent shutdown can cancel auxiliary work: memory shutdown aborts its lifetime before awaiting consolidation, and title shutdown aborts in-flight title generation. This is a hypothesis requiring offline delayed-auxiliary tests, not grounds to label the missing request free or to fabricate its usage. A future driver must keep wall timing at settled while separately draining/recording auxiliary work before shutdown. No further paid retry is authorized by a successful main-task result.

## Drain and admission repair (offline)

Maintainer reports the backend invoice was approximately **$0.117**, distinct from the official-price-equivalent ledger and from its reserved worst-case liability. Maintainer explicitly approved carrying the full unresolved $8.32768 forward without refund and, **after fixes/review pass**, one additional single-bash preflight beginning at **$8.4708352 / 42,354,176 units** conservative occupancy. The old trial remains invalid; this approval does not manufacture missing usage or authorize an unlimited retry loop. The CLI remains halted until the repair is verified.

`ProviderActivity` now observes bounded quiet intervals without polling a model, while the original settled wall result remains frozen. A test-only authenticated Unix admission proxy covers request-body receipt, not just provider dispatch. Quiet is an observation, not a guarantee of no future auxiliary work. Full shutdown still requires accounting every later request.

Fresh review found that the measured Linux agent could otherwise reach/substitute the sibling private inference socket. The driver now requires the provider state root and denies read/write to it, exposing only the admission socket directory through the existing sandbox exception. Genuine node/chat srt tests passed with attempted private sentinel read and private-socket rename (2 tests, 28 assertions). Admission disconnect/shutdown/oversize/timeout/upstream-refusal cases and provider failure tests passed (10 tests, 42 assertions). Follow-up review and streaming-close coverage remain before paid retry. New attempt reports include only fixed completion/evidence classifications, never raw errors or response content.

## Paid single-bash preflight 002 — complete preflight, not baseline

After the approved conservative carry-forward and repair verification, the one permitted retry passed. [Aggregate artifact](ptc-m1-preflight-002.json): one bash invocation/result, two main rounds, **4,533.49 ms** prompt-to-settled wall, plus **3,210.33 ms** separate provider quiet observation. All **five** provider attempts, including auxiliary work, have complete wire usage; no reservation remains for this retry. The measured unit was absent after cleanup. A fixed exclusive attempted marker prevents rerunning this CLI with new report paths.

This retry added **$0.168155 equivalent**. Conservative budget occupancy is now **$8.6389902 / 43,194,951 units**, which still includes the prior unresolved **$8.32768** charged at its worst case, **not an actual provider invoice**. The original invalid trial remains invalid. No cold/warm matrix, other fixture success, or M1 completion follows from one successful preflight.

## Fixture runner integration (offline, no new paid requests)

`fixture-runner.ts` now integrates the Linux JSONL driver, protected disposable daemon, bounded synthetic services, content-reducing outcome checks, provider quiescence and provider-authoritative usage. Ten categories passed real-srt **fake-model** integration on the Arch host (10 tests, 50 assertions): single read/bash, approval denial, coding/chat permission, question, cancellation, schedule, image transport and chat search. Fake image answers do not prove perception. A later exact-path run added multi-edit, dependent edit, filtering and background build/wait: **14 non-team categories now pass** (14 tests, 70 assertions). Team still requires runner integration and helper-attribution coverage.

Scoped review found false-positive permission/denial/schedule oracles and unprotected daemon state. Daemon state now lives inside the provider-private denied root; permission attempts require an unavailable-tool error and no retry, denial is bound to the intended command and forbids subsequent tool calls, and schedule proof checks synthetic CI plus pending—not active—wording. Parent tool names/file existence cannot prove helper success, so **team success deliberately fails closed** until child identity/completion/attribution evidence is wired. Additional adversarial tests and review remain.

Cache evidence helpers require elapsed TTL plus real cache creation/read fields, but the cohort scheduler, exact initial-main request attribution/shared-prefix priming and full report matrix are not wired. `cacheVerified` and `childrenAccounted` remain false in runner output. Thus none of these smoke results can pass full baseline readiness. Spend/occupancy remains unchanged from preflight002.

## Resumed team/accounting work

The maintainer explicitly accepted **trusted pinned-binary functional cross-evidence**, not adversarial OS-level writer provenance, for the team fixture. The test observer correlates the structured helper task envelope, same-session exact write and successful tool-result return, normal helper final, matching spawn/wait, parent report or complete inbox delivery, parent integration, and final file bytes. Failed/timed-out helpers, parent substitution and incomplete evidence remain failures. No session files are read.

The runner now exposes its `get_state` session identity to an in-memory request ledger. A request-scoped opaque correlation header binds physical relay attempts to parent/child/auxiliary logical requests; it is stripped before upstream dispatch and raw IDs never enter reports. Unknown owners, missing attempts, incomplete usage and undrained logical requests fail reconciliation. Team evidence is rechecked after shutdown, not only before cleanup. Scoped team review fixes include accepting ordinary normal completion text and complete inbox-only delivery, and rejecting late helper errors.

All **15 fixtures** passed genuine-srt fake-model runner integration on the Arch host (15 tests, 75 assertions before additional accounting assertions). This supersedes the earlier 14-case/team-fail-closed snapshot; it remains synthetic evidence, not live category success. Request-ledger review and expanded owner/reconciliation assertions are still in progress. `cacheVerified` remains false; `childrenAccounted` can become true only with successful final reconciliation and team evidence. No paid requests were made; occupancy remains $8.6389902.

## Cache cohort definition and controller preparation

The maintainer clarified cold acceptance: **wait 310 seconds before trial admission**, retain normal concurrent auxiliary behavior, then require actual initial-parent `cache_read=0` and positive cache creation. An intervening different-prefix title request does not automatically invalidate the trial; a real cache hit still does. No artificial wait is inserted inside prompt-to-settled timing.

For warm pairs, the maintainer approved reusing a controller-created absolute path after complete process teardown and clean recreation of all workspace/config/session state. Actual initial outbound full-body SHA-256 equality is required in memory, plus cache-read evidence. No transcript reuse, path normalization, prompt rewriting or persisted body hashes. `DisposablePair` rejects overlapping/third acquisitions; unverified process termination invalidates the pair and prevents deletion/reuse. The same-path genuine-srt fake-model test passed (1 test, 5 assertions).

`InitialRequest` selects the first exact parent request at admission and never substitutes a later retry. `cohort.ts` schedules ten cold and ten warm measured trials per fixture with separately recorded full warm-ups, retains returned invalid records before halting, and stops on missing usage. `cache-controller.ts` now connects these primitives but **has not yet completed review/integration tests or a paid run**; no cohort CLI has run. All 15 fixture tests with expanded accounting assertions passed (15 tests, 106 assertions). Concurrent parent/child/auxiliary and throwing-observer provider tests passed (6 tests, 62 assertions); observer exceptions invalidate accounting without refunding usage. Occupancy remains unchanged.

## Baseline CLI preparation (not executed)

`scripts/ptc-m1-baseline.ts` now composes the cache controller/cohort scheduler with fixed Arch binary pins, current carry-forward occupancy, no-swap/core-zero checks, stdin-only key intake, durable per-request budget snapshots and per-run aggregate records. Its exclusive attempt marker is anchored in the approved home-relative evaluation directory independently of binary/output paths; do not reset it after partial execution. It has **not been run with a live provider**.

Review fixes distinguish infrastructure/lifecycle invalidity from legitimate model task failure, retain charged results even when warm-pair cleanup fails, halt after invalid lifecycle, and require a healthy final budget with no outstanding reservation. The manifest now fingerprints all controller-side production sources, harness, lockfile/package manifests/patches and CLI, plus a normalized non-secret endpoint fingerprint; resource-window labels and numeric sample lead/lag are preserved. Narrow controller/cohort/provenance tests and typecheck pass. Most recent full check before the latest manifest/lifecycle fixes passed (gateway 734 pass, web 268 pass, compiled 115 pass); a final rerun is still required.

Final local verification after the lifecycle/manifest fixes passed: gateway **738 pass / 66 skip**, web **268 pass**, compiled **115 pass**, with formatting/types/builds clean. The final narrow CLI/control-path review found no remaining concrete P1/P2 findings. These do not certify paid-run behavior or remote authentication.

Remote offline revalidation was interrupted by a renewed Tailscale SSH check. A verification URL was handed to the maintainer; no new paid requests were made and the current budget remains unchanged. Do not infer authentication approval or successful file transfer from the interrupted command.

## Baseline-001 launched (completion pending)

After the maintainer confirmed renewed Tailscale verification, both pinned hashes, no swap, absence of the baseline attempt marker and presence of the consumed preflight marker were rechecked. Latest remote fake-model validation passed **85 tests / 468 assertions**. The authorized detached baseline-001 process was then launched on the Arch host with stdin-only credentials and core limit zero; initial process, marker and durable budget ledger were verified. At that observation, no provider attempts had yet been admitted and conservative occupancy was **43,194,951 units / $8.6389902**.

The matrix has 150 cold waits of 310 seconds (over 12.9 hours before model execution overhead), plus separately charged priming. Completion is **not** established by process launch. Do not modify the executing remote harness, reset the marker, start a duplicate run, or infer success from silence. Inspect only this run's numeric aggregate progress/ledger/summary; missing usage, invalid cache/lifecycle or budget exhaustion must halt without automatic retry. Reports and raw temporary session state must not be conflated.

## Baseline-001 stopped: cold cache not verified

The process exited after the second single-bash cold attempt still reported **13,577 cache-read tokens** despite the wait. Two measured trials are valid; one warm-up and one cache-invalid cold attempt are retained. All **20 requests** have complete usage; no test units remain. Conservative occupancy is now **$8.9704356 / 44,852,178 units**. This is not a complete matrix; do not reset its marker or retry automatically.

The maintainer requested investigation of CLIProxyAPI's mechanism. [Public-source findings](ptc-m1-proxy-cache-findings.md) identify a conditional upgrade of unspecified cache TTL to 1h for proxy-owned Claude Code CLI fingerprint paths. This is consistent with the stop but deployment version/profile/routing are not confirmed. No new generation calls or configuration changes were made during research.

## Explicit remaining live-baseline prerequisites

1. Integrate the already-tested in-memory credential handoff, pinned Arch binaries and durable budget ledger into a separate cohort CLI. Start at the **current** occupancy, not the consumed one-shot retry's prior value. Never remove/reset its attempted marker.
2. Finish team identity/completion/attribution and all-child usage proof. Existing detached/short-lived cgroup and node/chat private-state tests passed; do not mistake those for every team lifecycle/authorization path. Preserve mandatory srt.
3. Wire cold TTL scheduling, exact initial-main request attribution, identical-prefix warm priming, startup/post-settled billing and complete aggregate reports. Preserve shared prompts and existing auxiliary behavior; no provider-surface mode switch.
4. Finish adversarial oracle tests and follow-up review, especially helper success, image delivery/perception, post-denial actions and daemon-state isolation. Existing 14 fake-model runner cases and disposable daemon dispatch authorization tests do not replace real-model category validation or HTTP/WS owner checks.
5. Record 10 cold + 10 warm trials per fixture, all required metrics, aggregate-only artifact and baseline hashes. Mark Milestone 1 done only then. M4 later repeats on the completed PTC binary and decides cutover.
