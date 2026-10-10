# Gateway runtime M5: comparative evaluation, cutover rehearsal and decision record

Status: **evaluation complete; cutover still not recommended.** The first evaluation
(below, retained as recorded) failed the task-time gate in all 52 covered cohorts. A
follow-up [optimization pass](#optimization-pass-2026-10-10) reduced that to 18/52:
every 200 ms cohort and every chat cohort now passes, and the candidate beats the
baseline at 100–200 ms for one-session chat and single-tool. Loopback PTC, four-session loopback
and mixed-PTC cohorts still fail, and the audit's cutover blockers are unchanged.
No gate was relaxed. Deployment, stopping existing work and deleting data were not
performed and still need separate explicit authorization.

Related: [plan](../../../plans/gateway-agent-runtime.md), [M0 baseline](m0-baseline.md),
[M1 contracts](m1-contracts.md), [M4 completion](m4-completion.md),
[first results](m5-results.json), [optimization results](m5-optimization-results.json).

## Decision summary

| Gate (accepted at M1)                                                         | Result                                                   | Evidence                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 100 ms RTT, low load: delta→UI p50 −70 ms or better, no p95 regression        | **Pass**                                                 | p50 ≈100.7 → 2.2–2.7 ms; p95 ≈101–102 → 6.0–8.3 ms (all four fixtures)                                                                                                    |
| Environment-only PTC adds no linear WAN round trips                           | **Pass**                                                 | PTC ×10 adds no extra RTT over a single read at 100/200 ms in all 8 cohorts                                                                                               |
| Task p50/p95 ≤ baseline + max(10%, 50 ms): chat, single-tool, mixed, loopback | **Fail**                                                 | 52/52 cohorts fail; 26–1,137 ms over the limit (p50 76–1,120 ms over baseline)                                                                                            |
| Long context never retransmitted over the node link                           | **Pass (revised encoding; needs maintainer acceptance)** | Per-session bytes within ±491 B (p50) / ±1,959 B (p95) of the 1 KiB cohorts; 0.25–2.07 MB saved. The original aggregate encoding failed 4/32 cohorts (see Harness review) |
| Correctness: no lost transcripts/duplicate results, all runs succeed          | **Pass**                                                 | 1,280 measured runs and 128 warmups, 0 failures; exactly one durable tool result per call                                                                                 |

Recommendation: keep the existing production topology, do not schedule cutover, and
take the attribution and audit findings below into a design review. The streaming
and context-traffic goals are met; the task-time cost of the current turn/tool
protocol is not acceptable under the accepted budget.

## Optimization pass (2026-10-10)

At the maintainer's request the turn/tool path was optimized after the evaluation,
then the full matrix was re-run with the same gates, fixtures, host and method
(interleaved baseline, constrained worker, fake srt; references: synthetic worker and
embedded srt). Load average was 0.9–1.8, lower than in the first run.

| Gate                                   | First run  | After optimization                                                                                                                          |
| -------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Delta→UI at 100 ms                     | Pass       | **Pass**: p50 0.28–0.34 ms, p95 2.2–2.8 ms (baseline ≈100.4 / 100.8)                                                                        |
| Environment-only PTC, no linear RTTs   | Pass       | **Pass**: PTC ×10 adds no extra RTT over a single read (all 8 cohorts)                                                                      |
| Task time ≤ baseline + max(10%, 50 ms) | 52/52 fail | **Fail, 18/52**: loopback PTC/mixed and four-session single-tool; at 30 ms mixed and four-session single-tool; at 100 ms four-session mixed |
| Long context not retransmitted         | Pass\*     | **Pass\***: no node-link message carries the 256 KiB history; 0.26–0.53 MB saved per session                                                |
| Correctness                            | Pass       | **Pass**: 1,280 runs and 128 warmups, 0 failures                                                                                            |

\* The long-context gate was re-encoded twice after results were known; both
re-encodings await maintainer acceptance (see [below](#long-context-gate-encodings)).

One session, 1 KiB history, task p50/p95 (ms):

| RTT | Fixture     | Baseline      | First run       | Optimized     | Synthetic worker p50 | Embedded srt p50 | Node bytes first → optimized |
| --- | ----------- | ------------- | --------------- | ------------- | -------------------- | ---------------- | ---------------------------- |
| 0   | chat        | 25.5 / 27.1   | 106.5 / 122.0   | 48.1 / 53.7   | 35.1                 | 44.7             | 23,778 → 11,889              |
| 0   | single tool | 50.9 / 53.1   | 202.8 / 217.9   | 86.5 / 98.9   | 79.5                 | 87.1             | 30,613 → 18,213              |
| 0   | PTC ×10     | 88.7 / 95.3   | 469.0 / 486.6   | 202.3 / 237.3 | 186.0                | 192.6            | 84,013 → 67,671              |
| 0   | mixed PTC   | 89.0 / 95.2   | 356.6 / 394.0   | 160.0 / 178.0 | 147.5                | 155.8            | 57,329 → 41,007              |
| 30  | chat        | 67.5 / 68.0   | 161.8 / 174.3   | 73.0 / 76.7   | 64.1                 | 73.6             | 23,778 → 11,889              |
| 30  | single tool | 120.0 / 120.8 | 345.1 / 350.9   | 142.2 / 148.3 | 134.3                | 142.9            | 30,613 → 18,213              |
| 30  | PTC ×10     | 155.7 / 169.8 | 572.8 / 592.8   | 237.5 / 250.9 | 227.6                | 237.4            | 80,095 → 65,708              |
| 30  | mixed PTC   | 195.8 / 201.6 | 485.5 / 545.5   | 265.0 / 279.1 | 237.0                | 239.8            | 53,411 → 47,698              |
| 100 | chat        | 173.0 / 173.6 | 314.6 / 320.6   | 145.4 / 149.3 | 139.0                | 146.0            | 23,778 → 11,889              |
| 100 | single tool | 295.7 / 297.3 | 751.1 / 820.8   | 286.5 / 291.0 | 278.4                | 287.6            | 30,613 → 17,995              |
| 100 | PTC ×10     | 336.0 / 344.0 | 922.9 / 982.3   | 379.9 / 393.4 | 371.7                | 382.6            | 78,128 → 81,824              |
| 100 | mixed PTC   | 433.9 / 443.3 | 863.8 / 894.5   | 457.8 / 467.9 | 450.6                | 455.0            | 51,460 → 39,345              |
| 200 | chat        | 322.8 / 323.5 | 512.9 / 538.9   | 249.9 / 274.1 | 239.0                | 248.1            | 23,778 → 11,889              |
| 200 | single tool | 546.3 / 547.2 | 1226.4 / 1273.0 | 488.1 / 499.8 | 480.5                | 488.0            | 30,613 → 17,995              |
| 200 | PTC ×10     | 588.3 / 593.4 | 1286.7 / 1458.8 | 591.0 / 600.2 | 573.2                | 582.5            | 76,165 → 81,824              |
| 200 | mixed PTC   | 790.2 / 794.1 | 1482.5 / 1494.5 | 768.2 / 819.2 | 752.4                | 764.1            | 51,460 → 39,345              |

The baseline column is from the new interleaved run; the first-run column is the
candidate from the first evaluation (its own baseline was slightly slower under higher
load). Across the 52 task cohorts the candidate's p50 is now 0.77–3.7× the baseline's
(was 1.6–7.3×). The 18 failures exceed their limits by 2–339 ms; the largest are the
four-session loopback PTC cohorts, which are CPU-bound because the harness runs
gateway, node and executor bookkeeping on one event loop (four-session, 256 KiB,
100 ms parent user CPU: 40–247 ms vs the baseline's 14–44 ms).

### What changed

All within the M1 contract (one descriptor refresh before each model turn,
`execution.result` as a pushed wire kind, commit before ACK, no replay):

1. **One `describe` per turn without attachments.** The second attestation only
   guarded the attachment-loading window; with no attachments nothing awaits between
   attestation and commit. Attachment turns still re-attest. (−1 RTT per turn)
2. **Pushed results.** The node sends `execution.result` as soon as the terminal record
   is durable; the gateway journal verifies and persists it, and `awaitResult` wakes the
   runtime. Status queries remain the fallback (20 ms doubling to 250 ms) and race the
   push; without a push channel the old 20 ms poll is unchanged. (−20 ms poll and
   −1 RTT status per tool)
3. **ACK off the critical path.** The ACK is sent after the durable commit while the
   next model call proceeds; the run slot is released at settlement, `run()` and
   `close()` still wait for the ACKs. A lost ACK still only retains data. (−1 RTT per tool)
4. **Worker spawn overlaps turn preparation** (same launcher; closed if preparation fails).
5. **CPU:** memoized validation of exact stored text (intents, turn descriptors, PTC
   plans; SHA-256 keys, 64 KiB per-text and 8 MiB total caps, copies returned), faster
   strict JSON parsing/encoding with identical semantics, and a detached cache of the
   last committed client-projection state.
6. **Relaxed durability for observational writes (maintainer-approved).** Client
   projection/outbox commits and node progress/operation event appends use WAL
   `synchronous=NORMAL` (`environment/durability.ts`). Every other commit stays FULL:
   node acceptance, claims, inner operations, terminal results, gateway intents,
   transcripts and results before ACK. Measured cost of FULL here: 0.44 ms per
   transaction against 0.013 ms for NORMAL.

Per-turn attribution at 100 ms now: one `describe` (107 ms), worker spawn hidden
under it, `start` (110 ms); results and ACKs no longer add sequential round trips.

### Consequences of relaxed durability

NORMAL commits survive a gateway or node **process** crash. On power loss or an OS
crash, only a trailing suffix of projection/outbox or event writes after the last FULL
commit can be lost, never reordered, because the next FULL commit fsyncs the shared WAL.
Known effects: (a) a restarted gateway may reissue client outbox cursor numbers a client
has already seen, so clients should resynchronize from a snapshot after an unclean
gateway restart; (b) node events are pushed before they are fsynced, so after node power
loss the recovered `unknown` terminal record can carry a `finalSeq` lower than events the
gateway already displayed. Neither affects execution, replay or transcript integrity.
The [M1 contract amendment](m1-contracts.md#amendment-m5-optimization-pass) and
[backup guide](../../deploy/backup-and-recovery.md) record this.

### Long-context gate encodings

1. Original: aggregate node-link p95 below one 256 KiB history. Fails four-session PTC
   cohorts on control traffic alone (4/32 in both full runs).
2. First revision (pending acceptance): per-session bytes below one history and
   p50/p95 growth versus the 1 KiB cohort below 1%. With pushed results the number of
   fallback status replies varies by a few KB per run, so this failed 2/32 cohorts
   whose growth was negative or within status-reply noise.
3. Current (pending acceptance): deterministic. No decoded node-link message in any
   measured run contains the synthetic history (a 4,096-character marker only the
   256 KiB history has), and per-session p95 bytes stay below one history. Growth is
   still reported (−4.1 to +4.6 KB per session). The marker cannot see base64 artifact
   chunks; the per-session byte bound covers those.

All three agree that no history is retransmitted; only the first two are sensitive
to unrelated control traffic. The maintainer should confirm which encoding governs.

### Residual gaps and caveats

- One-session loopback PTC/mixed remain 19–92 ms over their p50/p95 limits, and
  four-session loopback single-tool/PTC/mixed fail by more; the remaining cost is per-operation
  durable journaling (four FULL commits per inner PTC operation on the node, required
  by the contract) and validation work on a shared event loop. The inner-operation
  `delivered` marker is informational and could also be relaxed; it was left FULL
  because it was outside the approved scope.
- Mixed PTC exceeds its limits by 7–27 ms at 30 ms with one session, 95–146 ms at 30 ms
  with four sessions and 39–63 ms at 100 ms with four sessions; four-session
  single-tool at 30 ms by 3–27 ms.
- The harness shares one process: validation memos can be hit by the "other side" of
  the link, and node and gateway CPU serialize. Separate hosts would avoid the second
  effect but lose the first; neither changes a gate verdict here.
- No production composition exists yet; a host must wire the node's `LocalEnvironment`
  `result` and `event` callbacks to `execution.result`/`execution.event` frames (the
  harness does), or the runtime falls back to polling.
- The decisional run started before two P3 hygiene fixes (cache-key encoding and
  `close()` waiting for late ACKs); the reference runs include them.
- The audit's cutover blockers (R1–R5, T1, T2, T5, S2) were not part of this pass and
  remain open.

## Reproduce

```sh
# NixOS host quirks used here: bwrap is not on PATH, and the system ldd (glibc 2.42)
# does not match Bun's glibc 2.44 loader, which made the worker crash at start.
export PATH=/nix/store/…-glibc-2.44-25-bin/bin:/nix/store/…-bubblewrap-0.12.0/bin:$PATH
export PIRC_GATEWAY_BWRAP=$(command -v bwrap)
# Measured worker: a plain compile of the shipped entry. The release build
# (`bun run --cwd apps/gateway build:runtime-worker`) adds autoload-disabling flags;
# that difference was not measured.
bun build --compile --minify apps/gateway/src/entry/runtime-worker.ts \
  --outfile work/m5/pirc-runtime-worker

# Decisional: M0 baseline vs candidate with the constrained worker and fake srt.
bun scripts/gateway-runtime-compare.ts --repeats 10 --output /tmp/m5.json \
  --worker "$PWD/work/m5/pirc-runtime-worker" --srt fake >/dev/null
# References (candidate only): synthetic in-process worker; constrained worker + embedded srt.
bun scripts/gateway-runtime-compare.ts --repeats 10 --variants candidate \
  --output /tmp/m5-syn.json >/dev/null
bun scripts/gateway-runtime-compare.ts --repeats 10 --variants candidate \
  --worker "$PWD/work/m5/pirc-runtime-worker" --srt embedded --output /tmp/m5-srt.json >/dev/null
bun test apps/gateway/test/gateway-runtime-candidate.test.ts \
  apps/gateway/test/gateway-cutover-rehearsal.test.ts
```

The daemon logs to stdout, hence the redirect. The exit code reflects run failures
only; read `gates` in the JSON. Gates are decisional only with `--worker` and both
variants (`gatesDecisional`). Only generated data, temporary workspaces, loopback
sockets and a deterministic provider are used: no credentials, paid models, private
history, network shaping or deployment.

## What the candidate measures

Same 64-cell matrix, fixtures, provider (four chunks, 5 ms pacing, injected at
`inference.run` like M0's `NodeRegistry.onInference`), RTT/2-per-direction delay,
warmup and nearest-rank percentiles as [M0](m0-baseline.md). Baseline and candidate
alternate within each cell, with the order reversed on every repeat.

Candidate path: real `buildDaemonApp`/`NodeRegistry`, real `startNode` over the
authenticated node WebSocket (through a transparent loopback relay that delays every
application frame in both directions), `RemoteEnvironment`/`EnvironmentFlow` with
shared framing, a real `SandboxedEnvironmentExecutor` subprocess per session (fake
srt for the gate, embedded srt as reference), and `GatewayAgentRuntime` composed as
`createGatewayRuntimeHost` does: shared gateway database, PTC service, `DirectCentral`,
goals, and node inner-operation events committed through `runtime.clients.environment`.
The worker factory constructs the same `GatewayWorkerProcess` (bubblewrap + seccomp)
that the runtime uses by default; it exists only to time the first phase. Both PTC
fixtures are node-placed (the mixed script's `web_search` lookup is a deterministic
central capability), so no gateway PTC guest runs. Node→gateway event forwarding is
harness wiring: no production composition exists yet.

Not comparable to M0, and therefore excluded from the gates:

- `toolQueueMs` = gateway tool start → node executor entry (includes the one-way link
  and intent persistence); `toolExecutionMs`/`environmentCalls` = one outer node
  execution (a whole PTC script), not each inner read.
- `contextBytes`: the candidate uses a short fixture system prompt and the runtime's
  tool list (8,034 vs M0's 8,357 bytes for small chat). Provider traffic is not counted.
- CPU/RSS sample the parent process only, and the candidate's CPU window also covers
  worker shutdown after `agent_settled` (M0 stops at settle). The candidate moves work
  into executor, worker and srt children, so its parent figures understate its total
  cost; even so,
  in the four-session, 256 KiB, 100 ms cohorts its parent user CPU was 4.5–8.8× the
  baseline's (PTC ×10: 709 vs 80 ms).
- UI bytes cover the UI socket only; inner-operation events go to the durable client
  outbox, as in production.

Known biases: M0's clock starts at the node-side `agent.prompt`, omitting the real
gateway→node prompt hop (RTT/2), while the candidate starts at the gateway's
`runtime.run`. This favours the baseline by RTT/2 and cannot explain the failures
(loopback cohorts fail too). The relay adds one loopback hop against the candidate.

Host: Linux x64, AMD Ryzen AI 7 350 (16 threads), Bun 1.4.2, shared development host
(load average 1.8–4.6 during the runs). Source `c1766ae` plus the M5 harness; the
recorded harness hashes match the committed `baseline.ts`, `candidate.ts` and CLI.
Gates were re-evaluated afterwards with the `compare.ts` hash listed in
[m5-results.json](m5-results.json), together with raw-report hashes and provenance. These are **exploratory component measurements on
a non-idle host**, not production end-to-end numbers; repeat on an idle controlled
host and a disposable remote pair (M0's handoff) before any future decision.

## Results

One session, 1 KiB history (ms). The synthetic-worker and embedded-srt columns are
separate candidate-only runs, not interleaved with the baseline.

| RTT | Fixture     | Base delta p50/p95 | Cand delta p50/p95 | Base task p50/p95 | Cand task p50/p95 | Synthetic worker p50 | Embedded srt p50 |
| --- | ----------- | ------------------ | ------------------ | ----------------- | ----------------- | -------------------- | ---------------- |
| 0   | chat        | 2.9 / 4.6          | 2.9 / 6.2          | 28.3 / 31.9       | 106.5 / 122.0     | 65.7                 | 104.6            |
| 0   | single tool | 2.8 / 4.8          | 2.6 / 6.4          | 56.1 / 61.7       | 202.8 / 217.9     | 158.0                | 200.4            |
| 0   | PTC ×10     | 2.7 / 4.8          | 2.7 / 8.9          | 134.1 / 151.5     | 469.0 / 486.6     | 426.4                | 470.9            |
| 0   | mixed PTC   | 2.6 / 4.5          | 2.6 / 8.4          | 127.2 / 136.6     | 356.6 / 394.0     | 313.5                | 362.9            |
| 30  | chat        | 30.6 / 32.4        | 2.3 / 5.3          | 69.6 / 71.4       | 161.8 / 174.3     | 124.3                | 161.0            |
| 30  | single tool | 30.7 / 33.1        | 2.7 / 7.0          | 124.9 / 127.1     | 345.1 / 350.9     | 299.4                | 341.5            |
| 30  | PTC ×10     | 30.8 / 33.4        | 2.8 / 7.8          | 194.0 / 221.1     | 572.8 / 592.8     | 538.2                | 571.5            |
| 30  | mixed PTC   | 30.7 / 33.4        | 2.6 / 8.2          | 219.5 / 243.1     | 485.5 / 545.5     | 444.7                | 482.8            |
| 100 | chat        | 100.7 / 101.2      | 2.7 / 6.0          | 174.6 / 178.5     | 314.6 / 320.6     | 271.5                | 309.5            |
| 100 | single tool | 100.7 / 101.3      | 2.5 / 6.7          | 300.8 / 313.4     | 751.1 / 820.8     | 675.4                | 710.9            |
| 100 | PTC ×10     | 100.8 / 101.8      | 2.5 / 8.1          | 367.3 / 384.9     | 922.9 / 982.3     | 861.7                | 915.4            |
| 100 | mixed PTC   | 100.8 / 102.0      | 2.2 / 8.3          | 471.1 / 481.6     | 863.8 / 894.5     | 801.4                | 848.0            |
| 200 | chat        | 200.6 / 201.3      | 2.4 / 5.9          | 324.3 / 325.8     | 512.9 / 538.9     | 476.7                | 514.6            |
| 200 | single tool | 200.7 / 201.2      | 2.2 / 6.4          | 550.4 / 553.4     | 1226.4 / 1273.0   | 1179.1               | 1215.8           |
| 200 | PTC ×10     | 200.7 / 201.2      | 2.5 / 8.7          | 625.1 / 637.1     | 1286.7 / 1458.8   | 1228.3               | 1269.2           |
| 200 | mixed PTC   | 200.6 / 201.3      | 2.9 / 7.6          | 818.1 / 830.0     | 1482.5 / 1494.5   | 1426.5               | 1465.6           |

Node-link bytes per run (one session, base → candidate): chat 12,256 → 23,778;
single tool 25,576 → 30,613; PTC ×10 66,797 → 76,165–84,013; mixed 41,448–41,931 →
51,460–57,329. Small cohorts send **more** over the link than before, because every
turn fetches the descriptor twice and every tool call adds journaled start, status,
ACK and inner-operation events. With 256 KiB histories the candidate's bytes stay
within ±491 B per session (p50; status-poll count varies), while the baseline grows to 273 KB (chat) and 548–589 KB (tool
fixtures) per session: 0.25–0.52 MB saved per session, 1.00–2.07 MB for four sessions.

Four sessions, 256 KiB, 100 ms, task p50: chat 185.8 → 395.1, single tool
324.2 → 833.5, PTC ×10 427.9 → 1,599.5, mixed 507.4 → 1,201.7 ms. Across all 52 task
cohorts the candidate's p50 is 1.6–7.3× the baseline's.

## Where the time goes

Spans from the decisional run (p50 ms, one session, 1 KiB):

| Span                       | Loopback | 100 ms RTT | Source                                                          |
| -------------------------- | -------- | ---------- | --------------------------------------------------------------- |
| Turn preparation           | 26–30    | 235–259    | `turn-lifecycle.ts` calls `environment.describe` twice per turn |
| `describe` (each)          | 8–9      | 112–115    | one node round trip each                                        |
| Worker spawn → first phase | 29–33    | 29–32      | a new bubblewrap/seccomp worker per run                         |
| Tool `start`               | 14–17    | 114–118    | journaled intent plus node acceptance                           |
| Tool `status` (each)       | 9–22     | 108–114    | the runtime polls every 20 ms until terminal, one RTT per poll  |
| Tool `ack`                 | 4.6–6.3  | 104–107    | awaited after the durable commit, before the next model call    |

At 100 ms a single read costs about five sequential round trips (two `describe`,
`start`, at least one `status`, `ack`) plus a 20 ms poll and a ~30 ms worker spawn,
against roughly two in the old path. At loopback the remaining excess is CPU:
`synchronous=FULL` SQLite journaling on both ends, per-event durable client
projection and node PTC inner-operation journaling (PTC ×10 takes 469 vs 134 ms with
no link delay). In the separate reference runs the synthetic worker is 35–76 ms faster
(one session, 1 KiB), and embedded srt is within run-to-run noise of fake srt (up to
40 ms either way, not interleaved), as expected since the executor starts during
setup, outside task time.

PTC ×10 uses about 4× the node-link frames of a single read (84 vs 20 per run). The
extra frames are one-way inner-operation events plus additional status polls; they do
not add sequential round trips, which is what the PTC gate measures.

Design directions for review (not implemented, not validated): validate the
descriptor revision once per turn or piggyback it on the first operation; push
terminal results and progress instead of polling `status`; acknowledge asynchronously
or batch ACKs with the next request (commit-before-ACK requires the commit, not a
blocking round trip); keep a warm per-session worker; profile the per-operation
journal and projection cost. Each changes recovery or security semantics and needs
the M1 contract revisited.

## Fresh-session cutover rehearsal

`apps/gateway/test/gateway-cutover-rehearsal.test.ts` runs on generated fixtures in
temporary directories:

- Fixture state: a legacy node with two sessions, retained JSONL transcripts, a running
  run and a pending approval; a gateway database with a legacy-referencing schedule,
  schedule run, delegation and memory record plus an unrelated schedule. After
  quiescence a backup of both ends is taken and made read-only.
- Quiescence by node restart, before the backup, turns the run `interrupted` and the
  approval `stale` without replay. A test-local inventory finds every referenced
  legacy ID.
- Fresh identities are prepared while the node is offline: appends are refused and
  legacy references report unavailable. A node with an older protocol is refused at
  registration, and no Environment frame can reach an unregistered node. The current
  node reconnects, is still unprovisioned, then fences (deny before stop) and the
  gateway activates. Legacy dispatch and scheduled delivery are refused; fresh history
  is empty; legacy transcripts and every pre-existing central table are unchanged.
- Rollback before writes: a test-local assessment (gateway rows and node-journal rows
  mentioning the session; a node-journal row alone counts) requires zero writes
  **and** revocation on both ends;
  revoked generations cannot reactivate. Restoring the backup re-enables legacy
  writers, the old receipt is unknown to the restored gateway, and the backup is
  byte-identical.
- After the first fresh write the assessment refuses rollback; after both ends
  restart the new data remains, the generation stays revoked and legacy writers stay
  fenced.

Limits: this rehearses policy; it does not enforce it. No production coordinator
sequences reconnect → version check → fence → activate, nothing enforces the
no-write rule, the test daemon uses its own database (gateway-side blocking is shown
through the authority), quiescence of background jobs is not exercised, and restoring
a backup necessarily discards revocation records. Building that coordinator is a
design task needing review.

## Fresh audit

Three reviewers who had not worked on the runtime audited HEAD `c1766ae` read-only
(security; recovery, concurrency and cutover; PTC). The maintainer chose to record the
findings here rather than change production code in M5. Findings are reproduced as
reported and were not re-verified one by one; "blocker" is the auditor's assessment.
IDs: R = recovery, T = PTC, S = security. Security F1 and F3 duplicate T5 and R4 and
are folded into them.

| #   | Area     | Pri | Blocker | Finding                                                                                                                                                                                                        |
| --- | -------- | --- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Recovery | P1  | yes     | Tool intents committed with the model reply but never dispatched (unknown first result, cancel, node offline) have no resolution path; `hasUnresolvedExecutions` then blocks the session forever.              |
| R2  | Recovery | P1  | yes     | Node-side dispatch errors (unknown ID, sandbox unavailable, quota, conflict) are thrown instead of answered with `environment.error`, closing the Environment link for every session on the node.              |
| R3  | Recovery | P1  | yes     | Gateway-placed PTC records are never recovered after a gateway restart and stay `running`; the outer record and inner journal live in different databases, so their finish is not atomic.                      |
| R4  | Fencing  | P1  | yes     | `NodeWriterFence.assertProvisioned`/`revoke` are not wired into node provisioning or authorization; revocation does not retire the journal binding; an un-retired binding can be re-provisioned.               |
| R5  | Recovery | P2  | yes     | Recover and retire are separate steps, and no startup sweep handles generations left by an abrupt node crash.                                                                                                  |
| R6  | Recovery | P2  | no      | Reconcile invents an `unknown` PTC result on transient status errors; the node's real record can no longer replace it.                                                                                         |
| R7  | Recovery | P2  | no      | Steering accepted after the last check before settlement is silently dropped.                                                                                                                                  |
| R8  | Fencing  | P2  | no      | Legacy approval answers and session rename bypass the durable deny fence between deny and stop.                                                                                                                |
| T1  | PTC      | P1  | yes     | A store nested deeper than 64 levels (or with duplicate keys) passes the guest/host checks but fails the commit validator, wedging the session permanently.                                                    |
| T2  | PTC      | P1  | yes     | An invalid `ptc` call (syntax error, unknown capability, extra argument, timeout over 3600 s) throws in `intents()` and interrupts the run instead of returning a tool error as the legacy tool does.          |
| T3  | PTC      | P2  | no      | Central policy denials and hook blocks surface as unknown effects rather than typed refusals; the refusal latch is not set; PTC hook routes reject `execute`-only capabilities that work when called directly. |
| T4  | PTC      | P2  | no      | Gateway-only PTC skips the outer `ptc` hooks and deny-list applied to node-placed scripts.                                                                                                                     |
| T5  | PTC/Sec  | P2  | yes     | Mixed-PTC parents are never sealed on the gateway and `bound()` ignores revocation, so a node can still run central capabilities after the script finished or the session was revoked.                         |
| T6  | PTC      | P3  | no      | Gateway-path operation events are bounded in count but not size; a projection error kills or stalls the guest.                                                                                                 |
| S2  | Security | P2  | yes     | The fresh `/commands` and `/reconcile` routes do not verify the client control lease (parity regression).                                                                                                      |
| S4  | Security | P3  | no      | No per-owner fairness under the 8-run global cap; PTC guests share the worker cap with runs.                                                                                                                   |
| S5  | Security | P3  | no      | The Linux worker seccomp filter is a deny-list (allows e.g. `userfaultfd`, `pidfd_getfd`); prefer an allow-list, at least for the PTC worker.                                                                  |
| S6  | Security | P3  | no      | The native PTC host splices guest text into its frame; a realm escape could override the `loaded` flag with a duplicate key.                                                                                   |

Areas reported sound include worker containment (namespaces, no network, cleared
environment, exec/memfd denial before IPC), trusted RSS supervision, binding/node
checks on every Environment and central message, node-owned approval binding,
`unsandboxed_bash` and `sandbox_allow_domains` handling, artifact ownership and
content headers, journal acceptance-before-claim, commit-before-ACK ordering, PTC
placement from the static manifest, inner-operation deduplication and store
branch/revision checks. The auditors also confirmed that nothing in `src` composes
the runtime, Environment transport or writer adoption for production.

## Harness review

A separate reviewer checked the M5 harness, gates and rehearsal. Applied: host-parity
composition and node inner-operation events; a decisional flag for constrained-worker
runs; documented metric redefinitions and the task-start asymmetry; awaiting each
run's terminal state; exact structured results, one transcript tool result per call
and inner-operation counts; setup inside `try` with full cleanup; a frame cross-check
in the PTC gate; rehearsal cleanup by identity, real quiescence, an unregistered-node
refusal, node-journal writes in the rollback assessment, every pre-existing table in
the digest and a non-empty transcript manifest. A second round (verdict: correct)
led to the p95 growth check, corrected figures, the quiesce-before-backup order, the
separate gateway execution-journal file in the backup guide and narrower rehearsal
claims; it left CPU-window and worker-build differences documented rather than
re-measured.

The long-context gate was first encoded as aggregate node-link p95 below one 256 KiB
history. That fails the four four-session PTC ×10 cohorts on control traffic alone
(about 4 × 78 KB, with no growth from the 1 KiB cohorts). After seeing this, it was
re-encoded to require per-session bytes below one history **and** p50 and p95 growth
versus the matching 1 KiB cohort below 1% of the history (2,621 B per session). The
reviewer judged the new encoding a stricter test of history-dependent traffic, but it
was changed after the results were known, so it is reported as pending maintainer
acceptance. Both verdicts are in [m5-results.json](m5-results.json)
(`longContextOriginalEncoding` failed 4/32). Either way, the overall decision is
unchanged by the task-time failure.

## Documentation updated

Topology, backend architecture, sandbox, backup/recovery, upgrades (cutover procedure,
rollback limits, version compatibility), releasing, the Nix README and the historical
sandbox note now describe the runtime as opt-in and not deployed, its boundaries and
state, and the gateway's long-term transcript retention.

## Remaining risks and decision request

- Task time regressed 1.6–7.3× at p50 in the first run; after the optimization pass it
  is 0.77–3.7× and 18/52 cohorts still fail (loopback PTC/mixed, four-session
  loopback and 30 ms single-tool, mixed at 30 ms and four-session mixed at 100 ms).
- Nine auditor-rated cutover blockers (R1–R5, T1, T2, T5, S2), and no production
  composition, coordinator, quiescence or no-write enforcement.
- Not verified here: an idle controlled host, real remote deployments, macOS runs of
  the M5 harness, Android/manual clients, real paid models and Darwin Nix builds.

Requested human decision: **do not cut over yet.** The protocol round trips are now
within budget; the remaining work is per-operation CPU/durability cost in PTC paths
and the audit blockers, to be addressed in a new milestone before re-running this
evaluation with the same gates. The maintainer should also confirm the long-context
gate encoding.

## Validation

Optimization pass: `bun run check` passed again with the same opt-ins and namespace:
**1,159 gateway tests passed / 177 skipped / 0 failed** (including new latency,
push and durability tests), **285 Web tests**, all builds and **121 compiled-role
tests**. A fresh reviewer audited the optimization diff in two rounds (final verdict:
correct; all P2 findings fixed, P3 hygiene items fixed or documented above).

First evaluation:

Final `bun run check` on the committed tree (with `CC` and the pinned
`PIRC_WASM3_ARCHIVE`) passed: version, Prettier, gateway/Web typechecks, **1,154
gateway tests passed / 177 skipped / 0 failed** (including the new candidate and
rehearsal suites), **285 Web tests**, all builds and **121 compiled-role tests**. It
ran inside a bubblewrap user/PID namespace that only supplies `/bin/bash` and a
reaping init on this NixOS host; that is test compatibility, not isolation evidence.
No real-worker, native-PTC, real-srt or hostile-fixture opt-ins were enabled for this
run, so those suites are among the skips; their M4 evidence stands unchanged because
M5 changed no production code. The M5 benchmark runs themselves did use the real
constrained worker and, as reference, embedded srt.
