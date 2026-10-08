# Gateway runtime M2: remaining implementation and Linux validation

Status: **additional harness-only implementation verified; M2 is not marked complete**.
The maintainer authorized the remaining implementation and selected Linux validation
now, with macOS validation handed off to them. Production loop/runner selection,
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

1. **macOS real sandbox validation**: no macOS environment was available here. The
   maintainer chose the handoff below. Linux success is not macOS evidence.
2. **Platform-specific aggregate background fencing**: an explicitly delegated
   Linux cgroup path now provides a verified aggregate barrier. A trusted bootstrap
   stops before executing any executor code, the supervisor admits its own host PID,
   and fencing waits for `cgroup.events` populated=0 after `cgroup.kill`. The real
   delegated-cgroup crash test passed. Never signal host PIDs reported by the child
   (they are forgeable and differ across namespaces). Without cgroup delegation,
   any generation that dispatched executor code quarantines the binding
   and retains write leases on shutdown, even if child cleanup was reported; no
   automatic replacement/regrant is permitted without independent aggregate proof. macOS
   still needs equivalent independent aggregate fencing evidence. Watchdog EOF
   alone establishes eventual cleanup, not permission to regrant.
3. **Broader full-stack recovery fixtures**: real child death after an effect,
   duplicate starts, lost result ACK, approval invalidation, and WebSocket/artifact
   integration are covered individually. A single combined both-end subprocess
   reconnect/restart/approval-loss scenario and disk-exhaustion OS test remain
   needed. Disk cap/in-memory fault tests do not prove power-loss behavior.
4. **Descriptor/attachment product lifecycle**: bounded builders, authenticated
   artifact transport and consumer adapters exist; M3/M4 must connect their refresh
   and projections to the authoritative turn/UI lifecycle. This patch does not
   construct production bindings or activate the gateway loop.

These gaps keep all M2 milestone checkboxes open. No paid provider, private history,
production service, operator cutover or legacy state was used or modified.

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
