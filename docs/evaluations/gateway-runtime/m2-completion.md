# Gateway runtime M2: remaining implementation and platform validation

Status: **additional harness-only implementation and macOS sandbox validation verified; M2 is not marked complete**.
The maintainer authorized the remaining implementation, then handed off the macOS
validation and recovery decision to the continuation below. Production loop/runner selection,
M3 session authority, deployment, legacy imports and deletion remain excluded.

## Added implementation

- Agent-free background/browser/sandbox-exception tool factories share the existing
  local direct/PTC validation/hook/policy chain. Background jobs have a shipped
  liveness watchdog; cancelling a foreground wait does not stop a job. Executor
  shutdown explicitly drains jobs. Browser handoff cancels/drains the losing
  confirmation or panel wait.
- Closed bounded broker payloads bind complete hook-final arguments and schema.
  Node authority rechecks workspace paths, write leases, revisions, sandbox health
  and exact host/network arguments after human approval. Approval action text is
  not truncated; oversized approvals fail closed. Authenticated session/control
  ingress can answer independently provisioned approvals without a legacy runner.
  Expiry/cancellation withdraws UI records; generic environment messages cannot
  approve anything.
- Monotonic active/absolute execution budgets allow only supervisor-recognized
  human waits to pause active time. Broker concurrency and retained interactions
  are bounded. Terminal replies with outstanding effectful broker work fail closed.
- Trusted descriptors use existing config trust/inheritance, role filtering,
  capability flags, AGENTS and skill discovery. Ownership metadata is explicit;
  unclassified registrations fail. Hook/env values remain on the node; only
  revisions leave it. Policy changes use a fenced executor-generation replacement,
  with binding-scoped quiescence and an explicit background stop/handoff prerequisite.
- Gateway-native tool preflight/post phases execute in the sandbox subprocess with
  durable stable phase identities. Central synchronous SQLite effects and their
  result record commit together. Unknown/crashed phases are queried, never replayed.
  Post-hook failure does not erase a committed central effect. Full PTC central
  capability/product dispatch remains M4; transcript/ACK coupling remains M3.
- Owner/hash/range-checked artifact transfer crosses the authenticated Environment
  channel; bounded consumers resolve model image data and expose unavailable UI
  references. Range reads no longer rehash the whole file for every chunk.
- Node protocol **11** requires shared framing on shipped peers. All HTTP/model/
  terminal/browser/Environment producers share a bounded physical writer, 64 KiB
  frames and a 4 MiB persisted-receive credit window. Control and round-robin data
  have separate bounded lanes. Legacy start/cancel/close traffic retains logical
  ordering; it is not mislabeled as durable admission acknowledgment. Component
  test registries may explicitly exercise the old logical transport, but production
  registration rejects missing shared framing.
- Shared fair admission has four active executions/node, one/session, 32 queued/node,
  128 globally, plus queued-byte bounds. Queue residence never resets execution
  budgets. Journal admission reserves terminal headroom at the 1 GiB soft cap;
  acknowledged known results compact to argument-digest tombstones, and permanently
  retired generations retain their non-reusable fence.

## Remaining acceptance gaps (not optional polish)

1. **macOS real sandbox validation**: closed by the 2026-10-08 takeover below.
   The exact handoff suite ran outside an outer Seatbelt sandbox; Linux results
   were not used as macOS evidence.
2. **Platform-specific aggregate background fencing**: an explicitly delegated
   Linux cgroup path now provides a verified aggregate barrier. A trusted bootstrap
   stops before executing any executor code, the supervisor admits its own host PID,
   and fencing waits for `cgroup.events` populated=0 after `cgroup.kill`. The real
   delegated-cgroup crash test passed. Never signal host PIDs reported by the child
   (they are forgeable and differ across namespaces). Without cgroup delegation,
   any generation that dispatched executor code quarantines the binding
   and retains write leases on shutdown, even if child cleanup was reported; no
   automatic replacement/regrant is permitted without independent aggregate proof. macOS
   uses durable quarantine instead of automatic replacement/regrant (the decision
   below). Automatic macOS aggregate fencing remains unimplemented. Watchdog EOF
   alone establishes eventual cleanup, not permission to regrant.
3. **Broader full-stack recovery fixtures**: closed by the continuation below,
   except power loss: the disk-exhaustion test covers a real out-of-space
   filesystem, not a power cut.
4. **Descriptor/attachment product lifecycle**: bounded builders, authenticated
   artifact transport and consumer adapters exist; M3/M4 must connect their refresh
   and projections to the authoritative turn/UI lifecycle. This patch does not
   construct production bindings or activate the gateway loop.

The remaining product lifecycle in gap 4 and unimplemented automatic macOS
aggregate fencing keep the milestone checkboxes open. The conservative macOS
recovery policy is implemented, without claiming automatic cleanup evidence.
No paid provider, private history, production service, operator cutover or legacy
state was used or modified.

## Continuation (2026-10-08): both-end recovery and disk exhaustion

- **Gap found by the combined fixture:** without aggregate fencing (macOS, or
  Linux without a delegated cgroup) every generation that dispatched executor
  code is quarantined on shutdown, and `fenceEnvironment` threw before it
  recorded unfinished work or retired the generation. A node restart therefore
  left those executions `running` forever, and the gateway could not reconcile
  them. Once executor IPC and supervisor broker work are drained, recovery marks
  unfinished work `unknown` and retires the generation even under quarantine;
  both only narrow what the old generation may do. The takeover below rejects
  other shutdown failures instead of treating them as proof that IPC has closed. Write leases stay held, because releasing them is a regrant
  that still needs aggregate proof. The result reports `quarantined`.
- `LocalEnvironment.adoptRetired` (supervisor-only, after a restart) exposes a
  generation that was fenced before the restart for `status` and `ack` only;
  start, cancel and describe still fail. `ExecutionJournal.isRetired` backs it.
- `environment-recovery.integration.test.ts` runs one scenario across the
  authenticated WebSocket with a real executor subprocess (fake srt) and
  node-owned approvals: an acknowledged effect; a host execution whose pending
  approval is lost with the link (refused, never run, old interaction
  unanswerable after reconnect and after the approval store restarts); an effect
  whose executor dies before reporting; then both the gateway and the node
  restart from the same journals. Generation 1 is reconciled by status only
  (`unknown` for the lost result, the earlier ACK survives), every retried
  generation-1 start is refused, no effect repeats, the write lease stays held
  under quarantine. The takeover below prevents replacement on that workspace;
  an unrelated workspace can still run. A tool-level refusal is
  recorded `failed`/`unknown`, not `not_started`, by design; the absent file is
  the evidence.
- `environment-disk-full.test.ts` (opt-in, `PIRC_TEST_ENV_SMALLFS` pointing at
  a small filesystem the operator mounted) fills the real filesystem after an
  effect: the terminal write fails, the node faults, no result leaves it, new
  starts and `reconnect` are refused, and after space is freed and the journal
  reopens, recovery reports `unknown` and the ID is never admitted again. It
  passed 4/4 on macOS 15.7.7 against an 8 MiB HFS+ disk image
  (`hdiutil create -size 8m -fs HFS+`, attached with `-nobrowse`).
- **macOS run of the handoff tests (not clean evidence):**
  `PIRC_TEST_SRT=embedded bun test test/environment-*.test.ts test/sandbox-srt.integration.test.ts`
  passed 66, skipped 2 (Linux cgroup and opt-in disk), on macOS 15.7.7 / Bun
  1.4.2. That shell itself ran inside another Seatbelt sandbox, which the
  handoff below rules out, so gap 1 stays open until it is repeated outside one.
- **macOS aggregate fencing (gap 2), candidate for review, not implemented:**
  a Seatbelt sandbox cannot be removed and is inherited across `fork`,
  `setsid` and reparenting. Each generation's srt profile could deny reading
  one unique marker path; `sandbox_check(pid, "file-read-data", path)` then
  identifies every process of that generation among the node account's PIDs,
  which the supervisor stops and kills until none remain. Calling it from Bun
  FFI works on arm64 only by padding the variadic path to the ninth argument;
  membership detection of escaped descendants was not verified (the probe
  needed to run outside the outer sandbox). Kill-by-PID keeps a small PID-reuse
  race that Linux `cgroup.kill` does not have.
- Checks: environment suite 66 pass / 2 skip; full gateway suite 1041 pass /
  113 skip / 0 fail. One earlier full run had timing failures in
  `relay.integration`, `browser.integration` and
  `environment-transport.integration` that pass alone (3/3) and in the next full
  run; `relay.integration` also fails intermittently on the unchanged baseline.
  The 17 web failures in this environment (`localStorage` undefined in jsdom)
  are the same on the baseline.

## macOS takeover (2026-10-08): persistent quarantine and clean sandbox evidence

The continuation selects the conservative macOS policy: keep a dispatched
executor's binding and leased paths quarantined until independent aggregate cleanup
is established. Do not automatically replace it or release its write leases.
The marker/`sandbox_check` PID-scanning candidate is not implemented or counted as
cleanup evidence. No user approval endpoint can clear quarantine.

Two recovery problems were corrected:

- `fenceEnvironment` previously caught every `closeAndWait` error as if IPC and
  supervisor broker work had drained. Only the explicit
  `EnvironmentCleanupUnverified` outcome now permits recovery/retirement with an
  `unknown` result. Descriptor-close/cgroup failures persist a deny fence and
  propagate their error without classifying unfinished work as recovered.
- Keeping a session-owned lease in memory allowed the same session's replacement
  executor to reuse it, and an actual supervisor restart lost the lease entirely.
  The journal now persists quarantines and their canonical lease roots. New
  generations on the same session or workspace are refused. WriteBroker denies
  reacquisition by the quarantined session and ordinary release cannot clear the
  fence. Trusted startup calls `restoreEnvironmentQuarantines` before provisioning
  any executor, restoring overlapping-path protection for other sessions as well.
  Policy refresh uses the same fence and never constructs a replacement on
  quarantine. This startup integration is exercised by the harness; M3 must use
  it when adding production supervisor construction.

The combined fixture now creates a fresh WriteBroker after restart, verifies both
same-session and different-session replacement denial, reconciles the original
results through status/ACK only, and continues execution only on an unrelated
workspace. Four supervisor regressions cover drained quarantine, undrained failure,
independently verified cleanup, and denied policy refresh.

Clean macOS evidence: macOS **15.7.7 (24G720)**, arm64, Bun **1.4.2** and the
repository's embedded `@anthropic-ai/sandbox-runtime` **0.0.78**. Tests used a
disposable checkout with isolated dependencies. The ordinary restricted tool
shell reported `sandbox_check(self, NULL, 0) = 1`; the unrestricted validation
shell reported **0**, checked before running the real srt tests.

```sh
cd apps/gateway
PIRC_TEST_SRT=embedded bun test test/environment-*.test.ts test/sandbox-srt.integration.test.ts
```

The handed-off changes passed **66 / 0 failed / 2 skipped** (exit 0) outside the
outer sandbox. After the quarantine fixes, the same suite passed **69 / 0 failed /
2 skipped** (exit 0); the fourth supervisor regression then passed separately.
The skipped tests were Linux cgroup fencing and the opt-in disk-exhaustion fixture.
The disk-exhaustion fixture separately passed **1 / 0 failed** (exit 0) on a newly
created 8 MiB HFS+ disk image; the image was detached and deleted afterward. This
establishes ENOSPC recovery, not power-loss safety. Linux cgroup evidence remains
the earlier Linux run; it was not repeated on macOS.

Final verification with fixed source files passed (exit 0):

```sh
PIRC_TEST_SRT=embedded NODE_OPTIONS=--no-experimental-webstorage bun run check
```

Version checks, repository formatting, gateway/web typechecks and all builds
passed; **1047 gateway tests passed / 111 skipped / 0 failed**, **284 web tests
passed**, and **121 compiled-role tests passed**. Node **26.8.1** provides a
built-in `localStorage` stub that interferes with jsdom; the explicit Node option
lets tests use jsdom's browser storage without changing application code.
A preliminary full run encountered the existing relay live-view timeout;
`bun test test/relay.integration.test.ts` then passed **11 / 0 failed**, and the
final full run above passed. The final checks include all four supervisor
regressions and the real-srt Environment isolation tests. Skips are not counted as
verified, and no paid provider was called.

M2 remains harness-only. Descriptor refresh and attachment projections still need
M3/M4's authoritative turn/UI wiring; the production loop, live deployments,
legacy histories and user workspaces were not activated or migrated.

## Validation and review

Two independent read-only lenses reviewed security and recovery in two bounded
rounds. Fixes include argument-binding/browser routing, untruncated approval text,
hook phase identity/post arguments, queued-ID conflicts/deadlines, socket lifecycle
ordering/in-flight settlement, broker cancellation/drain, retained interaction
bounds, watchdog FD/lifetime cleanup and binding-scoped fencing. Review false
positives about serialized receive assembly and a quiescence slot race were
withdrawn rather than counted as bugs.

Focused Environment suite: **64 passed / 0 failed**, followed by **7 subprocess
checks passed** after adding the interactive TTY regression, including opt-in real Linux
srt executor containment, a real delegated-cgroup detached-descendant crash test,
independent child crash and job-watchdog tests. The authenticated transport fixture
also reconnects both ends after an intentionally lost ACK reply and verifies that
status/ACK retries do not repeat the original effect. The existing real-srt agent
test also passed separately. The full `bun run check` passed: version/format/typechecks, **1029 gateway tests
passed / 125 skipped**, **284 web tests passed**, gateway/chat/node/web builds and
**121 compiled-role tests passed**. The two opt-in executor containment/cgroup
checks skipped in the ordinary suite were separately run successfully. Skipped tests are not verified.

Validation uses the already-authorized NixOS temporary `/bin/bash`/`/bin/sh`
compatibility namespace documented in [M0](m0-baseline.md#validation-environment).
The outer namespace is not isolation evidence; the opt-in test starts the actual
embedded srt inside it and asserts node-private file denial, outside-workspace
write denial, blocked network and secret-free environment.

For the optional Linux aggregate test, use an already delegated writable cgroup
parent belonging to the invoking user; do not change system delegation implicitly:

```sh
cd apps/gateway
PIRC_TEST_ENV_CGROUP=/sys/fs/cgroup/<delegated-user-scope> \
  PIRC_TEST_SRT=embedded bun test test/environment-subprocess.test.ts
```

## macOS handoff

Use a disposable checkout/test workspace on macOS with Bun and a working real srt.
Do not run these inside an existing macOS sandbox (Seatbelt sandboxes do not nest).
No provider keys or paid calls are needed.

```sh
bun install --frozen-lockfile
bun run check
cd apps/gateway
PIRC_TEST_SRT=embedded bun test test/environment-*.test.ts test/sandbox-srt.integration.test.ts
```

If using an external srt, set `PIRC_TEST_SRT=/absolute/path/to/srt` instead. Return
OS/Bun/srt versions, exact command/exit status and sanitized failure output. A
missing/unavailable sandbox is a failed gate, not permission to run unsandboxed.
Do not mark M2 complete until remaining recovery/aggregate fencing and platform
validation requirements pass.
