# Gateway runtime M4: in-progress implementation and native guest feasibility

Status: **M4 is not complete.** The maintainer requested the entire milestone,
not a foundation-only delivery. Production routing, cutover, legacy imports and
policy relaxation remain excluded. No M4 checkbox has been marked complete.

## Current implementation

The unactivated foundation adds:

- Manifest/catalog-based fixed PTC placement, rejecting missing or conflicting
  ownership and recursive wrapper calls.
- Authoritative branch stores derived from the selected fresh-session ancestry,
  bounded canonical values/provenance, dispatch-time snapshots and revision
  checks. Store/result/dedup commits share a transaction. Conflicts retain effect
  evidence without replay; failed scripts cannot propose stores.
- A shared inner-operation journal on the owning service's SQLite connection,
  stable parent/inner identity checks, intent/result/delivery evidence, atomic
  database-covered mutations, guest-loss sealing and verified unknown refinement.

Follow-up WIP now dispatches node-local PTC through the shipped executor and
supports an isolated native gateway guest and central callback registry. Reverse
central-RPC schemas/adapter and gateway-team transport/storage seams exist, but
full authenticated mixed transport, durable team relays/restart and product
services are not yet complete. Web/Android changes only clarify sandbox wording;
complete client snapshot/event parity remains open. Inner journal methods are
supervisor-only; they are not remotely authorized merely by knowing an ID.

Open integration gates include fully wired central hook-phase recovery and mixed
final-hook-argument write-slot/refusal coordination, full team ask/wait/stop/recovery
wiring, production-quality memory/schedules/delegation adapters, lifecycle hooks
and current UI projections. Follow-up code shares the central operation database
for transactional hook receipts/results and exposes a final-argument gate;
external hooked effects remain explicitly refused. Ordered guest receive counts
now persist inner delivery evidence, and trusted model-image support is carried
in the dispatch snapshot (default false). These additions still require complete
end-to-end recovery/security acceptance. The incomplete client snapshot adapter
was removed rather than presenting truncated history/stale watermarks as parity.

A fresh two-round review found and corrected canonical-number store expansion,
outer unknown-result refinement, inner lost-reply refinement and unbounded
historical store materialization. Store lookup now selects only the nearest
ancestral store; inner listings contain bounded references rather than collecting
all large result bodies.

## macOS native QuickJS/WASM feasibility

The maintainer explicitly authorized a native WASM-host feasibility experiment
and use of a new isolated validation directory on `m3air`, without global installs
or touching production services/sessions/history. The experiment lives in ignored
`work/m4-feasibility/` locally and
`/Users/iceice666/pirc-m4-feasibility.zcAOuE` remotely. It is not a shipped runtime.

The existing Darwin finite worker cannot directly host the Bun QuickJS guest.
Instead, the experiment embeds the **unchanged** pinned QuickJS WASM bytes in a
native C executable using a software-bounds-checked WASM interpreter:

| Input                       | Exact identity                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| wasm3 feasibility candidate | `v0.9.1-beta.1`, commit `ac3c1dd1386e83be7de548211efd02805eb1dcee`                                          |
| Source archive SHA-256      | `c3ee044f23da31055e1c31b3a350dac240c93f0eed8e281739574bf754573c37`                                          |
| QuickJS asset               | `@jitl/quickjs-wasmfile-release-asyncify@0.31.0`                                                            |
| WASM SHA-256                | `98d27ff5e8babbca4b28a7b9242f554cd51e758498d90b00638a4b1b36b6f463`                                          |
| Interpreter build           | `d_m3GuardedMemory=0`, `d_m3SkipMemoryBoundsCheck=0`, `d_m3MaxLinearMemoryPages=4096`; no WASI registration |

Upstream sources: [pinned archive](https://codeload.github.com/wasm3/wasm3/tar.gz/ac3c1dd1386e83be7de548211efd02805eb1dcee),
[release](https://github.com/wasm3/wasm3/releases/tag/v0.9.1-beta.1).
This candidate is a **beta in a minimally maintained project**. After the
feasibility experiment, the maintainer explicitly accepted this exact pinned
version for continued M4 integration, retaining all isolation and adversarial
acceptance gates. The offline native build script checks the source archive and
QuickJS checksums and emits provenance/license files; normal/Nix packaging is
still pending.

### Observed results

On macOS arm64 Darwin 25.5.0, compiled with system clang:

1. Exact QuickJS WASM initialized and evaluated `1 + 2` to `3`.
2. The same probe ran after the unchanged native bootstrap, Seatbelt profile and
   watchdog, with independent kernel-denial checks in a small native launcher.
3. A second probe reentered WASM from a native host callback, created a deferred
   QuickJS promise, settled it later, drained jobs and obtained `42` exactly once.
4. That callback/promise probe then passed through the actual
   `GatewayWorkerProcess` launcher, including its PID/kernel/RSS admission, using
   a fixture-only `model`/`done` phase handshake. Remote output explicitly reported
   `production_probe_status=0`.

Earlier attempts exposed an incorrect memory-size pointer type (fixed to
`size_t`), an unimplemented environment-size import (replaced with bounded empty
values), and a phase-protocol mismatch (fixed in the fixture). These failed
attempts are not credited as acceptance. SSH tool-wrapper success alone was not
used as evidence: remote phase status/output was inspected.

### Not established

- Complete SDK, `tools.par`, attachments, store and refusal semantics.
- Full hostile-worker/IPC/deadline/cancellation/parent-death regression matrix.
- Production packaging, Linux interpreter acceptance or performance gates.
- The initial arithmetic probe used 16 MiB memory; the follow-up worker uses a
  trusted fixed 256 MiB adapter. Full memory-pressure/adversarial parity remains
  unverified.
- A production-quality ABI bridge: proof imports are deliberately narrow and
  fail unsupported calls; they must not be presented as full platform support.

The complete bridge and its integration require further review and testing.
The successful feasibility result removes the assumption that early-sealed native
QuickJS/WASM is impossible; it does not complete M4.

## Validation

Targeted foundation tests and gateway typecheck pass. The first plain
`bun run check` failed existing shell tests because this NixOS host has no
`/bin/bash`; it was stopped rather than weakening tests. The documented temporary
shell/PID compatibility namespace subsequently passed the full check. That
namespace is not containment evidence. The foundation checkpoint passed **1085
gateway tests / 166 skipped / 0 failures**, **284 Web tests**, and **121 compiled
role tests**, plus formatting/typechecks/builds. Subsequent native worker/guest
integration edits require a fresh full check; no full-milestone verification is
claimed here. Later checkpoint `bun run check` runs passed **1093 gateway tests**,
**171 skipped**, **284 Web tests** and **121 compiled-role tests**. A subsequent
run exposed a reconnect fixture race (directory registration before environment
subchannel readiness); the fixture now waits for authenticated status rather than
assuming both handshakes finish together. The full stack passed after that fix: **1094 gateway tests / 172 skipped / 0 failures**,
**284 Web tests**, **121 compiled-role tests**, version/format/typechecks and builds.
This is the current WIP checkpoint, not complete M4 feature acceptance.

Android `./gradlew --no-configuration-cache testDebugUnitTest assembleDebug` was
attempted with JDK 21 but failed because no Android SDK location was configured.
No Android build/device acceptance is claimed; the Gradle daemon was stopped.

Linux real embedded-srt focused validation passed **9 tests / 1 delegated-cgroup
skip / 0 failures**, including ten dependent node-local reads and durable inner
records/delivery. The first attempt correctly refused startup because `bwrap` was
not on PATH; the documented installed executable was then supplied. Gateway
native tests additionally covered 40 quick replies, runaway cancellation and
prototype-poisoning attempts against idle accounting. macOS full host + isolated
native guest ten-call/store fixture passed again; full macOS regression remains
open.

A follow-up native guest prototype now uses a trusted fixed 256 MiB memory adapter
and the shared PTC prelude. Under the actual macOS worker launcher, a synthetic
broker completed ten dependent calls, returned store value `12`, and preserved the
native store-read latch (`isolated_native_batch_status=0`). This is a guest/IPC
fixture, **not** node-local execution or proof of ten real filesystem operations
without WAN round trips. Runtime/broker wiring and security review remain open.
