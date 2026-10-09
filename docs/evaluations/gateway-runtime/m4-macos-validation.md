# Gateway runtime M4: macOS arm64 validation

Source: `8bb2718399d8` (the [M4 completion](m4-completion.md) commit), exported
with `git archive` to a disposable root on `ssh m3air`. This record closes the
macOS checks that the M4 Linux continuation skipped. No source change was needed;
every check below ran against the unmodified commit. Production routing, writer
adoption, legacy import/deletion and M5 cutover remain outside this validation.

## Environment

**macOS 26.5 (25F71), Darwin 25.5.0, arm64**, Bun **1.4.2**, Node **26.7.0**,
Apple clang **21.0.0**, embedded sandbox-runtime **0.0.78**. The shell was
outside Seatbelt (`sandbox_check(self, NULL, 0) = 0`). Tests used a clean
environment, `TMPDIR` inside the disposable root, an isolated HOME outside
`/tmp`, `NODE_OPTIONS=--no-experimental-webstorage`, and `bun install
--frozen-lockfile`. The pinned wasm3 archive matched SHA-256
`c3ee044f…bf754573c37`; no network fallback was used.

## Build

`scripts/build-gateway-worker.ts` built the Darwin native phase driver, bootstrap,
inspection library and watchdog. `scripts/build-native-ptc-worker.ts` built
`pirc-ptc-worker` with `-Werror` against the verified wasm3/QuickJS inputs
(binary SHA-256 `bc11c084…a39b4fd5`, provenance and license files emitted). On
Darwin the PTC worker has no seccomp seal of its own; it runs through the same
watchdog, injected bootstrap and deny-default Seatbelt profile as the phase
worker, and launch fails closed if any asset is missing. The macOS C fixtures
(probe, forged worker/bootstrap, memory, fork, ports/helper, stall) were built
with `clang -O2` as in the [platform record](m2-m3-platform-completion.md); they
are test fixtures, not alternate workers.

## Results

All phases set the native opt-ins (`PIRC_TEST_GATEWAY_WORKER`,
`PIRC_TEST_NATIVE_PTC` and the eight macOS fixture variables). The Environment
and full phases also set `PIRC_TEST_SRT=embedded`.

| Phase                                                                                                                 | Result                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Native PTC, PTC service, guest SDK, team runtime with native children, worker isolation/ports/lifecycle/protocol      | **51 pass / 1 Linux-only skip / 0 fail; 282 assertions**                                                                                  |
| Focused M4: acceptance, parity, mixed transport, PTC authority, central link, inner journal, memory, hooks, host etc. | **88 pass / 2 skip / 0 fail; 625 assertions**                                                                                             |
| Environment suite under real embedded srt                                                                             | **91 pass / 2 skip / 0 fail; 548 assertions**                                                                                             |
| Full `bun run check` with real-srt/native opt-ins                                                                     | Passed: **1,207 gateway pass / 112 skip / 0 fail**, **285 Web pass**, **121 compiled-role pass**; version/format/typechecks/builds passed |

On macOS, the native phase actually exercised:

- isolated native PTC dependency batches and store proposals;
- bounded broker bursts;
- realm-poisoning resistance;
- ambient-API denial and busy-guest kill;
- the eight-worker quota;
- over-RSS admission and supervision;
- allocation-loop slot release;
- PTC termination after a SIGKILLed supervisor;
- gateway-only PTC through the isolated guest;
- a team member as a gateway runtime instance with bound ask/reply and no
  node agent loop.

The existing Mach-port revocation, uncooperative-worker sealing, forged-readiness
rejection, fork denial, RSS interruption and watchdog reaping tests also passed
against this commit.

### Skips (not acceptance evidence)

- The real Linux worker test, which is Linux-only.
- Delegated Linux cgroup fencing.
- Opt-in full-journal-disk ENOSPC injection.
- The real-srt executor protection test in the focused phase, which ran in the
  Environment phase instead.
- In the full check:
  - optional fake-provider fixture matrices (OpenAI/M4 PTC real-srt fixtures,
    the fixture runner and the warm same-path proof);
  - cgroup smoke tests;
  - in-suite compiled-entry duplicates, which `test:compiled` covers separately.

## Not verified

The following were not run:

- macOS x86_64 or other macOS releases;
- a Darwin Nix build or Nix package containment;
- portable release archive acceptance;
- Android APK/device checks;
- manual browser checks;
- real providers;
- delegated cgroups;
- full-disk injection;
- abrupt whole-supervisor crash or power loss.

Raw logs are kept in two places: the initiating checkout's ignored
`work/m4-macos-m3air-2026-10-10/` directory and the remote disposable root. Each
phase's own `PHASE=… EXIT_STATUS=0` line is the evidence; the SSH wrapper's
status is not.
