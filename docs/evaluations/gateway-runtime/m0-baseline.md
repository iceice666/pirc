# Gateway runtime M0: reproducible component baseline

Status: measurement harness implemented; no production runtime or deployment changes.
Related: [plan](../../../plans/gateway-agent-runtime.md), [M1 review candidate](m1-contracts.md).

## Reproduce

```sh
bun test apps/gateway/test/gateway-runtime-baseline.test.ts
bun scripts/gateway-runtime-baseline.ts --repeats 10 --output /tmp/gateway-runtime-m0.json
bun run check
```

Only generated histories and temporary workspaces are used. No provider credentials,
paid requests, private histories, network shaping privileges, deployment changes or
external services are needed. The listener binds to loopback with an ephemeral port;
it is a test endpoint, not the authenticated production endpoint. Fixture files and
sockets are removed after each run. PTC reads only these generated files.

The matrix is 64 cells: RTT **0 / 30 / 100 / 200 ms**, synthetic history
**1 KiB / 256 KiB**, **1 / 4 simultaneous sessions**, and:

- Chat: one four-chunk deterministic provider response.
- Single tool: one real `read`, followed by the final model response.
- Environment PTC: ten dependent real `read` calls in the existing QuickJS guest;
  each file supplies the next path. Two model calls, not ten.
- Mixed PTC: local read → central synthetic lookup over the actual
  `agent_request`/`agent_response` node link → dependent local read. Two model calls.
  The lookup has no external side effects; this is not schedule/delegation recovery.

Each cell has one excluded warmup and ten measured runs. Reports preserve raw samples,
run success rates, nearest-rank p50/p95, source commit/dirty state, Bun, OS and CPU.
Small samples and fixed iteration order are exploratory, not statistical confidence
intervals. Re-run the same fixtures on an otherwise idle machine before a cutover
comparison; alternate baseline/candidate runs to reduce drift. Never pool RTT or
context cohorts to claim a gate passed.

## What is actually measured

The real path is `Agent` → `createRemoteStream` → authenticated Unix HTTP/NDJSON
`startNodeInference` → real loopback WebSocket → `NodeRegistry` → injected synthetic
provider callback, then model deltas return via the node relay and agent emissions,
`NodeRegistry.onEvent`, and a real UI-facing WebSocket consumer. Real session JSONL,
PTC preflight/guest/broker, tool validation and file reads are exercised.

The fixture replaces `Runner`, daemon authentication/ownership middleware, production
event persistence/UI routes and browser rendering with test plumbing. It does not
start the OS sandbox; no isolation claim follows from its success. Features such as
automatic titles/memory are disabled by supplying no feature registrations. The
provider is a deterministic `NodeRegistry.onInference` implementation (four chunks,
5 ms pacing), not HTTP SSE parsing or a real model. These are **component baseline**
measurements, not production end-to-end benchmarks.

| Metric            | Definition and limitation                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `measuredRttMs`   | Heartbeat round trip across the same delayed link, measured before each run with one monotonic clock.                                                                                                                                                   |
| `deltaToUiMs`     | Gateway synthetic delta callback to matching unique text token at UI socket receipt. Includes the node detour, excludes rendering.                                                                                                                      |
| `taskMs`          | Prompt submission through that session's `agent_settled` at the UI socket; includes provider pacing, context transport, tools and the final event hop.                                                                                                  |
| `toolQueueMs`     | Tool execution-start event through actual capability entry; includes local validation/hooks/policy bookkeeping, not an inference admission queue. Inner PTC operations use their own IDs.                                                               |
| `toolExecutionMs` | Actual capability entry through settlement; the central lookup includes its round trip. Guest startup is reflected in task time, not read duration.                                                                                                     |
| `contextBytes`    | UTF-8 JSON bytes of system prompt + messages + tool schemas for every model call. The nominal history size is not the full request size.                                                                                                                |
| Node-link bytes   | All serialized application frames in each direction during the measured run; separate UI frame bytes. Excludes registration, calibration, WebSocket/TCP/TLS overhead and provider uploads.                                                              |
| Delay queue       | Queued UTF-8 bytes in the artificial propagation-delay queues; not a socket backlog.                                                                                                                                                                    |
| Socket backlog    | Sampled `ws.bufferedAmount` on real sockets every 2 ms. A zero means no backlog observed, not proof of zero transient buffering. Unix socket backlog is unavailable.                                                                                    |
| CPU / RSS         | `process.cpuUsage` delta and 2 ms sampled RSS of the shared parent process, including agent/gateway/measurement plumbing. Excludes QuickJS child CPU/RSS; neither attributable per-role nor total deployment resources. RSS is not reset between cells. |

RTT/2 is imposed independently on each direction at application-frame enqueue time,
without serial per-frame sleeps. This models propagation delay, **not** bandwidth,
packet loss, TCP congestion, WAN jitter, or end-to-end backpressure. Even the zero-delay
cell has timer/event-loop overhead. The gateway→UI link stays loopback in every cell.
All timing endpoints use `performance.now()` in the same process. Wall time is metadata
only. The existing production buffering remains bounded fail-fast.

## Recorded result

The checked-in [m0-results.json](m0-results.json) contains all 64 summarized cells,
harness SHA-256 hashes and provenance. The recorded Linux x64 run used Bun 1.4.2
on an AMD Ryzen AI 7 350, with **640/640 measured runs successful** and 64 successful
excluded warmups. The full raw report was written to
`/tmp/gateway-runtime-m0-final.json`; its SHA-256 is retained in the summary, but the
temporary file is not a durable repository artifact. Reproduction writes a fresh
full report. Thrown measurements stay in the success denominator, and the CLI
atomically checkpoints completed cells; a failed run exits nonzero.

One session, 1 KiB history (milliseconds; each row is a separate cohort):

| RTT | Fixture     | Delta→UI p50 / p95 | Task p50 / p95  |
| --- | ----------- | ------------------ | --------------- |
| 0   | chat        | 2.64 / 2.98        | 28.14 / 29.21   |
| 0   | single tool | 2.59 / 4.41        | 54.83 / 58.19   |
| 0   | PTC ×10     | 2.63 / 4.87        | 127.38 / 139.16 |
| 0   | mixed PTC   | 2.57 / 3.54        | 99.54 / 117.25  |
| 30  | chat        | 30.46 / 31.90      | 67.76 / 70.47   |
| 30  | single tool | 30.65 / 33.11      | 123.34 / 125.58 |
| 30  | PTC ×10     | 30.59 / 32.95      | 191.66 / 204.78 |
| 30  | mixed PTC   | 30.65 / 32.70      | 216.56 / 232.66 |
| 100 | chat        | 100.56 / 100.95    | 173.48 / 174.88 |
| 100 | single tool | 100.74 / 101.22    | 298.29 / 299.55 |
| 100 | PTC ×10     | 100.76 / 101.25    | 372.43 / 378.91 |
| 100 | mixed PTC   | 100.75 / 101.12    | 468.55 / 474.53 |
| 200 | chat        | 200.65 / 201.20    | 324.01 / 324.49 |
| 200 | single tool | 200.65 / 201.21    | 548.48 / 549.64 |
| 200 | PTC ×10     | 200.66 / 201.23    | 623.37 / 628.60 |
| 200 | mixed PTC   | 200.65 / 201.49    | 818.42 / 826.74 |

The presentation detour tracks the injected node RTT, while total task time also
contains model request transport and final event delivery. At 100 ms RTT, the large
chat fixture retransmits **269,477 context bytes** in its model call and **273,376
node-link bytes** total, versus **12,256 total** for small chat; provider traffic is
not counted as eliminated. The large-chat task p50/p95 is 178.71/181.75 ms and delta
p50/p95 is 100.70/101.62 ms. Ten local PTC reads do not add ten node round trips;
the mixed fixture intentionally includes a central-call RTT. This supports further
design review, **not** a proven centralized-runtime speedup or passing M5 gate.

All cohorts retain queue/tool spans, context/traffic, sampled backlog and parent
CPU/RSS in the JSON. Socket backlog may be zero on fast loopback while the artificial
delay queue is nonzero. Parent-only CPU/RSS must not be used to set production
worker capacity, especially for PTC child processes. This exploratory run shared
the development host with light source-review/test activity; repeat on an idle
controlled host for a performance decision.

## Remote deployment measurement handoff (not executed)

Use a disposable gateway/node pair with synthetic data, a local fake provider, and
explicit operator authorization. Do not shape a production interface or replay
private history. No measurement below is implied by this local report.

1. Pin the baseline/candidate commits, Bun, build flags, CPU limits and fixture
   sizes. Build with `bun run build`; use isolated state/config roots and synthetic
   accounts. Keep provider credentials out of the fixture environment. Real models
   require separate authorization.
2. First measure natural node RTT from correlated heartbeat/ping request/reply
   traces. In a disposable Linux network namespace only, an operator may apply
   `tc qdisc add dev <test-interface> root netem delay <half-rtt>ms` on **both**
   directions. Record existing qdiscs first; restore them afterward. This requires
   privileges and is deliberately not automated here. On macOS use a separately
   approved disposable network conditioner, not unreviewed host-wide shaping.
3. Instrument gateway delta receipt, node receipt/emission and UI socket receipt
   with trace IDs, local monotonic spans and payload byte counters. Clock origins
   on different machines are unrelated: use round-trip measurements, or estimate
   offset and uncertainty from repeated ping exchanges. Report uncertainty; never
   subtract unsynchronized `Date.now()` values. Keep UI on the gateway clock host
   if measuring the node detour without cross-host clock calibration.
4. Run the same 64-cell fixture matrix, with separate warmups and at least ten runs;
   capture actual RTT, loss/jitter, per-process CPU/RSS (including PTC children),
   `ss -tinm` socket queues on Linux, event-loop pressure and application queues.
   Capture only counters/trace IDs, not prompt contents or tokens/credentials.
5. Exercise the real daemon event store, authenticated UI WebSocket and browser;
   report socket receipt separately from rendered text. Retain task-time and
   streaming percentiles, errors/timeouts and traffic, not only faster cases.
6. Stop only the disposable processes, restore networking, remove disposable state,
   and retain a sanitized report. Linux/macOS sandbox tests, Android rendering,
   real-node restart and migration rehearsal remain separate M2–M5 gates.

## Validation environment

The initial host `bun run check` passed version/format/type checks but failed existing
shell/team tests because this NixOS host has no `/bin/bash`. With operator approval,
validation uses a temporary mount namespace supplying `/bin/bash` and `/bin/sh`,
without changing host `/bin` or production shell code. The installed bubblewrap
path used here is machine-specific; set `BWRAP` to an available executable:

```sh
BWRAP=/nix/store/bs0izr20qsssmygsg7qzis680ncifdil-bubblewrap-0.12.0/bin/bwrap
"$BWRAP" --bind / / --proc /proc --dev-bind /dev /dev --tmpfs /bin \
  --ro-bind "$(readlink -f "$(command -v bash)")" /bin/bash \
  --ro-bind "$(readlink -f /bin/sh)" /bin/sh \
  -- /bin/bash -c 'bun run check'
```

This is only filesystem compatibility for testing, **not** a security sandbox:
workspace/home/network permissions remain those of the invoking user. It does not
verify real node isolation or the proposed M1 gateway worker boundary. An initial
namespace attempt without `/proc`/`/dev` mounts crashed Bun; the command above
includes both and the isolated previously failing team test passes.

The full command above subsequently passed: version check, Prettier, gateway/web
typechecks, **966 gateway tests passed / 123 skipped**, **284 web tests passed**,
all web/gateway/chat/node builds, and **121 compiled-role tests passed**. The focused
M0 suite also passed **11 tests / 54 assertions**. Skipped opt-in tests are not
claimed as verified: real Linux/macOS sandbox isolation, Android, manual browser,
remote deployments/restarts and migration/cutover remain unverified here.

## Decision boundary

M0 can establish the detour's cost and retransmitted context bytes, but cannot prove
that a centralized loop, stronger isolation, hooks or mixed-script recovery meet the
proposed M5 budgets. Do not claim an additional RTT saved for each tool iteration.
Human confirmation of the original performance gates and proposed resource limits
is requested in M1; no gates are relaxed based on these results.
