# Gateway runtime M2/M3: macOS regression validation

Status: **macOS regression checks and real node-sandbox containment passed;
macOS gateway-worker support and the combined real-sandbox recovery gate remain
open.** This is validation, not a deployment or implementation of the missing
macOS worker. See [the plan](../../../plans/gateway-agent-runtime.md) and the
[Linux implementation record](m3-linux-runtime.md).

Continuation: [M2/M3 platform completion](m2-m3-platform-completion.md) subsequently
implements and verifies the remaining native macOS arm64 worker and combined
real-srt recovery gates. The status and evidence limits in this initial regression
record are historical; its results and failed first configuration are retained.

## Environment and scope (2026-10-09)

Validation ran over `ssh m3air` against source commit
`9b9c4ee2e7d8d595ca2d09b2ebd6a98ca1c3b2b3`, exported with `git archive` into a
new disposable directory. It did not reuse a deployment or existing checkout.

- macOS **26.5 (25F71)**, Darwin **25.5.0**, **arm64**.
- Bun **1.4.2 (744846f84)**, installed only in the validation directory.
- Node **26.7.0**; embedded `@anthropic-ai/sandbox-runtime` **0.0.78**.
- The validation shell reported `sandbox_check(self, NULL, 0) = 0`, before real
  sandbox testing and again after the full checks. No outer Seatbelt sandbox was
  used; macOS sandboxes do not nest.
- Test processes used `env -i`, an explicit tool PATH, a new empty HOME outside
  `/tmp`, isolated XDG directories, and `NODE_OPTIONS=--no-experimental-webstorage`.
  Provider credentials and existing user configuration were not inherited.
- No real provider calls, private histories, live writer termination, production
  routing, legacy imports, deletion of old data, or service cutover occurred.

HOME must not be placed in `/tmp` for these fixtures: sandbox policy intentionally
allows temporary writes, while the tests use `os.homedir()` as their forbidden
write probe. The first run used a temporary HOME and produced **68 pass / 2 skip /
2 fail** (exit 1). Both real-sandbox tests failed. Moving only the isolated HOME
outside the permitted temporary subtree made the unchanged tests pass. That first
run is retained as an invalid fixture configuration, not containment evidence or
an application fix; no policy or assertion was weakened.

## Commands and results

Commands below ran with the clean environment described above. Each final phase
reported exit **0**.

```sh
bun install --frozen-lockfile

# From the repository root:
bun test \
  apps/gateway/test/gateway-session-authority.test.ts \
  apps/gateway/test/gateway-turn-lifecycle.test.ts \
  apps/gateway/test/gateway-agent-runtime.test.ts \
  apps/gateway/test/gateway-node-fences.integration.test.ts \
  apps/gateway/test/environment-transport.integration.test.ts \
  apps/gateway/test/gateway-worker-isolation.test.ts

# From apps/gateway:
PIRC_TEST_SRT=embedded bun test \
  test/environment-*.test.ts test/sandbox-srt.integration.test.ts

# From the repository root:
PIRC_TEST_SRT=embedded NODE_OPTIONS=--no-experimental-webstorage bun run check

# From apps/gateway, after the build:
PIRC_TEST_SRT=embedded \
PIRC_TEST_AGENT_COMMAND="$PWD/dist/pirc-node" \
  bun test test/sandbox-srt.integration.test.ts
```

| Phase                                                                 | Result                            | Assertions / scope                                                        |
| --------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| Frozen dependency installation                                        | Passed                            | 419 packages installed                                                    |
| Focused authority/lifecycle/runtime/fence/transport/worker regression | **33 pass / 4 skip / 0 fail**     | 258 assertions; six files                                                 |
| Environment and real-srt suite                                        | **70 pass / 2 skip / 0 fail**     | 387 assertions; seventeen files                                           |
| Full gateway tests                                                    | **1079 pass / 115 skip / 0 fail** | Includes the real-srt opt-ins                                             |
| Web tests                                                             | **284 pass**                      | 44 test files                                                             |
| Compiled-role tests                                                   | **121 pass / 0 fail**             | 433 assertions                                                            |
| Compiled `pirc-node` under real srt                                   | **1 pass / 0 fail**               | 15 assertions                                                             |
| Version, format, gateway/web typechecks and all builds                | Passed                            | Includes `pirc-runtime-worker`; build success is not macOS worker support |

The real Environment executor containment test checks private-state read denial,
workspace writes, outside-workspace write denial, blocked network access and
absence of the node token. The real agent fixture also exercises PTC inside srt,
pseudo-terminals and an explicitly fixture-approved host-execution exception. It
passed with both the source entry and the compiled node binary.

The initial focused test wrapper used zsh's read-only `status` name after the test
finished; the underlying log independently recorded `PHASE=focused EXIT_STATUS=0`
and the complete test summary. Later wrappers used `rc`, and propagated phase exit
statuses directly.

## Evidence limits and remaining gates

Passing the commands does not mean every Environment fixture uses real srt:

- `environment-recovery.integration.test.ts` hardcodes fake-srt. It checks actual
  executor subprocesses, authenticated transport, both-end restart, lost approvals,
  quarantine and reconciliation, but is **not real-srt recovery evidence**.
- `environment-authority.test.ts` also uses fake-srt. The real agent fixture's
  approved host execution does not establish new-runtime approval/recovery parity.
- The Environment transport and turn-lifecycle attachment fixtures use synthetic
  executor/artifact behavior. They verify protocol and ownership logic, not
  artifact production and recovery inside a real sandbox.
- `gateway-node-fences.integration.test.ts` reopens the actual node app and proves
  durable quarantine restoration before leases and legacy dispatch refusal, but
  seeds the fences rather than deriving them from real-srt executor shutdown.

Therefore M2's combined continuation gate remains open: add/run explicit real-srt
coverage for approvals, artifact pin/result/ACK recovery and durable quarantine
across node restart, without automatic aggregate regrant. Existing separate
containment and behavioral tests are useful but not equivalent to this coverage.

The M3 macOS **regression** item is verified by the focused and full checks above.
The separate macOS **gateway worker** item remains unimplemented/unsupported:
`GatewayWorkerProcess` explicitly refuses non-Linux platforms. Equivalent enforced
isolation, resource supervision and real adversarial macOS tests are still needed.

Four focused skips are Linux real-worker tests. The two Environment skips are the
Linux delegated-cgroup fixture and opt-in small-filesystem ENOSPC fixture. No disk
image was mounted for this run; historical ENOSPC evidence is separate. The full
suite's other skips likewise are not verified. No Nix evaluation/build, Android
real-device check, browser manual check or M5 performance comparison was performed.

## Evidence retention

Raw phase logs, exact validation wrapper and source identity were copied to the
initiating checkout's ignored directory:
`work/macos-validation-m3air-2026-10-09/`. The disposable remote checkout, test HOME
and tooling were left in place for inspection; no validation processes were found
running after the suites. No global Bun installation or production configuration
was changed. These temporary artifacts are not a deployed service.
