# Rust post-cutover follow-ups

[Active plans](README.md) · [Implementation and decision history](../docs/history/rust-rewrite.md) · [Security audit](security-audit.md)

Status: rewritten as a post-cutover work queue on 2026-10-14. **M0–M9 are complete**: version 0.4.0 ships native `pirc-gateway` and `pirc-node`, with chat selected by `pirc-node chat` and node protocol 10. The TS server implementation and its retained test/evaluation tooling have been removed. The original milestones, measurements, accepted compatibility differences and validation evidence are preserved in the history linked above.

This checklist is not authorization to implement fixes, run paid evaluations, access credentials, deploy services or delete state. Each work item needs the user's go-ahead. Unchecked verification items mean evidence is missing, not that the implementation is known to fail. Previously accepted risks and waived gates remain accepted unless the user explicitly reopens them.

## 1. Security fixes deferred until after cutover

The authoritative findings are S1–S5 in [the Rust agent port review](security-audit.md#found-while-reviewing-the-rust-agent-port-2026-10-11). These affect advisory controls; the mandatory OS sandbox remains a separate enforcement layer. M7 fixed S6–S9 and other native-sandbox findings, not S1–S5.

- [x] **S1 — High: program execution through read-only commands.** Check execution options such as `fd -x/-X/--exec`, `rg --pre` and `bat --pager`, or remove the affected commands from the read-only table. Add regression cases proving they cannot bypass approval/write-lease decisions.
- [x] **S2 — High: writes through read-only commands.** Correct classification of output operands, in-place options and state-changing commands, including `uniq`, `xxd`, `tree -o`, `yq -i`, `date -s`, `hostname NAME` and compact `sed` write syntax. Add regression cases for the audit's examples.
- [x] **S3 — High: symlink followed by `..`.** Make path classification agree with filesystem traversal, or conservatively classify ambiguous paths as unknown. Test reads and writes through symlink/`..` chains.
- [x] **S4 — Medium: exfiltration and recursive credential reads.** Review `wget --post-file`/`--body-file` and recursive `grep`/`rg` over home or credential directories. Record the intended approval policy and add regression tests.
- [x] **S5 — Low: unbounded agent stdin lines.** Define a limit and failure behavior for node-to-agent RPC lines; test oversized input without unbounded buffering.

Closure: record fixes and regression evidence in the security audit as well as checking items here. Existing historical TS recordings need not reproduce deliberately stricter security behavior.

Done 2026-10-14 (`a1c938a`): fixes, the S4 approval policy, the S5 limit and failure behavior, and the regression tests are recorded in [S1–S5 resolution](security-audit.md#s1s5-resolution-2026-10-14). An independent reviewer probed four rounds of the fixes against real GNU/BSD tools; every bypass it found is a test. `pirc-agent` lib tests 308/308 and `pirc-policy` 26/26 on macOS 26.5.1 (arm64), clippy and fmt clean.

## 2. Known implementation and test follow-ups

These were explicitly left by M6/M7. The 2026-10-14 documentation review found no later closure evidence; the macOS and OOM failures were not rerun during that review.

- [x] **macOS policy test:** investigate and fix `pirc_policy::tests::guard_refuses_private_reads_and_protected_writes` (`crates/pirc-policy/src/lib.rs`). M7 recorded a failure because `/etc` resolves to `/private/etc`; the test still expects `/etc/x`. Verify the intended guard behavior rather than merely weakening the assertion, then run the relevant tests on macOS. Done 2026-10-14 (`05172a9`): the guard is right to name the real path when a link leads elsewhere (`Path /etc/x (/private/etc/x) …`); the test now derives the expected text from `real_resolve` and passes on macOS and keeps its Linux expectation.
- [ ] **QuickJS OOM teardown:** reproduce the `JS_FreeRuntime` assertion after an out-of-memory script has emitted `done`; fix or explicitly disposition it, with a regression test covering guest teardown and the parent-observed result. Start in `crates/pirc-ptc/src/guest.rs` and PTC runtime tests.
- [ ] **Host execution session isolation:** review the M6 difference from TS `setsid`. `crates/pirc-node/src/runner/host.rs` currently creates a process group, not a separate session, so a host command can reach the node's controlling terminal via `/dev/tty`. Decide whether to restore session isolation; validate terminal access, cancellation and process cleanup.

## 3. Verification evidence still missing

Use the current Rust-only test stack. Record the tested commit, platform, commands, outcomes and any skips. Historical passes are not evidence for later code changes.

- [x] **GitHub CI:** obtain and review a successful workflow run for the cutover/current revision, including the Linux sandbox/podman coverage. Workflow definitions and local passes alone are not evidence that hosted CI passed. Done 2026-10-14: `Check` run 38530392152 on `5ef6c8e` passed all three jobs: `bun run check` (every step, Linux conformance included), `Native sandbox (bubblewrap, uid 0, podman)` and `Rust executable sizes`. Every `Check` run since M7, the cutover `2aad2d3` included, had failed on `a_denied_root_is_expanded_and_kernel_paths_are_left_alone`, whose assertion took the `/dev/null` source hiding a root-level file (the runner's swap file; `/.dockerenv` reproduced it in a container) for a mount under `/dev` (`fc8bc93`); the run after that fix exposed a race in a PTY test's read loop (`5ef6c8e`). Both were test bugs; the sandbox plan was right. Two more flaky tests surfaced in the next runs and were fixed: `ptc_runtime` read `/proc` before the script process had exec'd, and `agent_memory_auto_compaction` could record the automatic compaction's request with the turn before it. `Check` run 38536863723 on `c28fab1` passed all three jobs, with conformance run through `scripts/conformance.ts`.
- [x] **Android APK:** run the APK build against the post-cutover repository and record its result. Android sources were not part of the server rewrite. Hosted CI's `Android` workflow passed on the cutover commit `2aad2d3` (run 38506133531, 2026-10-14); no Android source changed since.
- [x] **Complete macOS runtime validation:** run the applicable Rust unit/integration/conformance suites on a real Mac, explicitly reporting platform skips and resolving or dispositioning failures, including the policy test above.
  - 2026-10-14, `5de551b`, macOS 26.5.1 arm64, rustc 1.98.1 and Bun 1.4.2 from `nix develop`, Chromium 150 installed: `bun run check` passes every step up to conformance (version, catalog, browser assets, prettier, `cargo fmt`/`clippy -D warnings`, workspace tests 1110 passed / 0 failed, script tests 8/8, web 284/284, web and release builds). Platform skips: Linux-only tests (`cfg(target_os = "linux")`: the bubblewrap backend, its uid-0/real-root cases, `/proc` checks) are not built.
  - Fixed on the way: the policy test above; four tests that assumed Linux (`pirc-config` browser default with Chromium installed, `/proc` in `ptc_runtime`, two listing tests on a case-folding file system); a real bug, Chromium 150 on macOS reporting a popup's initial document as `:` so it lost frame number 0 (`5de551b`, `browser_engine` 18/18).
  - Flaky under full-suite load, passing alone three times: `browser_netio::concurrent_screencast_restarts_leave_one_running`, `browser_engine::{waits_for_load_states_and_networkidle, drags_do_not_wait_for_a_frame_still_loading}` (elapsed-time bounds), `agent_memory_auto_compaction`.
  - Conformance (`--no-fail-fast`, after `d0e3ba8` masks the background log directory's `/var/folders` parent): 17 snapshots still differ, all from snapshots recorded on Linux rather than behavior bugs: token estimates and memory gauges counted before path normalization (longer macOS temporary paths: `estimatedTokens` 19→21 in eight agent scenarios, `node_panels_state`), the guard naming `/private/…` real paths (`agent_tool_errors`, `agent_ptc_operations`), Seatbelt settings listing `allowUnixSockets` (`node_link_side_sandbox`), the node's macOS warning that its temporary directory lies inside a writable path (`/private/tmp`; `node_link_side_runs`, `node_session_*`, `node_workspaces`, `session_lifecycle`), and `node_session_commands` finding the agent through `/proc`. Decided by the user on 2026-10-14: conformance is Linux-only. Its snapshots record the platform-independent HTTP, WebSocket and RPC contract, and CI and deployments are Linux; macOS-specific behavior is covered by the crates' own tests (Seatbelt, browser engine). `bun run test:conformance` (`scripts/conformance.ts`) skips the suite on other platforms and `conformance:record` refuses there, so macOS output never replaces the Linux snapshots.
- [ ] **macOS extracted-archive end-to-end checks:** cover `pirc-node chat`, a real agent run under the native sandbox, browser functionality and web assets behind a representative real proxy. The existing archive smoke test covered CLI/version, checksums, library dependencies, gateway/node registration, an auth refusal and sandbox readiness only.
- [ ] **Real-browser recovery checks:** exercise an actual out-of-process iframe renderer crash and service-worker restart. M8 covered these with a fake CDP browser, not real Chromium fault/restart tests.

Already recorded, not pending: Linux `bun run check`, size budgets, native Nix builds and closure checks; macOS release build/CLI checks and archive execution/basic smoke test; M7's two real-host-root sandbox tests. The root tests remain deliberately ignored in the default suite and require separate authorization/environment preparation to rerun. See the historical record for dates and scope.

## 4. Waived evaluations — optional reopening, not release blockers

On 2026-10-14 the user explicitly waived the remaining M5 gate to permit M9 cutover. **These evaluations did not pass by virtue of the waiver.** No new runs are authorized by this checklist.

| Evaluation                        | Outstanding evidence                                                                     | Gate before any new work                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Full PTC and task-time comparison | Complete, valid results against the TS baseline                                          | Agree on protocol, baseline, budget and paid-run approval                    |
| Real-provider smoke tests         | Each of the four wire APIs and subscription login flows: one text turn and one tool call | Explicit provider/account scope, credentials and spending approval           |
| Polyglot evaluation               | Review-required/accounting-invalid results cannot establish a passing comparison         | Resolve review and accounting validity before interpreting or repeating runs |

The current tree no longer contains `scripts/ptc-*`, the TS implementation or the TS-era fixture recorders. Historical tooling is available at `2d480d3`, the last TS revision. Reopening comparisons requires a separate historical checkout or newly agreed tooling; do not restore a shipped JS runtime or overwrite frozen parity fixtures merely to make comparisons pass. Existing evaluation artifacts remain under [PTC evaluations](../docs/evaluations/ptc/README.md).

## 5. Accepted security risks — watch items, not uncompleted gates

These decisions remain in force. Any mitigation work requires a new scope decision; this list does not silently reopen acceptance.

| Finding or limitation                                                                          | Recorded disposition                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S10 — High:** host-side atomic replacement can detach a protected file's Linux sandbox mount | Accepted by the user on 2026-10-12; possible mitigations and their trade-offs are recorded in the [M7 security gate](security-audit.md#m7-security-gate-2026-10-12)                                       |
| **S18 — High:** browser WebSocket bypasses and non-HTTP egress; Chromium DNS rebinding         | Accepted by the user on 2026-10-12; a node-local filtering proxy was considered but not implemented; see the [M8 browser review](security-audit.md#m8-browser-review-2026-10-12)                          |
| Other sandbox and compatibility limitations                                                    | Retained in the historical M2–M8 records: filesystem planning races, remaining visible host daemon sockets, newly created SSH-agent directories, srt stand-in gaps and port-specific behavior differences |

The broader security audit also contains older open Low/Info findings. This rewrite follow-up list does not close or supersede them.

## 6. Release and deployment decisions outside the cutover scope

M9 authorized repository code, packaging and documentation only. No live-service deployment, state deletion or additional paid runs were authorized. The macOS archive was locally built and smoke-tested, but no formally signed/notarized archive or release was published.

- [ ] **Decide release publication scope:** whether to publish release artifacts and whether macOS signing/notarization is required. If approved, agree on credentials, artifact provenance and distribution checks before proceeding.
- [ ] **Decide live deployment scope:** target systems, maintenance window and fresh-start migration/rollback procedure. Follow [upgrade notes](../docs/deploy/upgrades.md); protocol 10 is intentionally incompatible with TS nodes/gateways, and users must re-pair devices, re-login subscription backends and start new sessions. Never delete old state without explicit approval.

## Completion discipline

For each approved item, add dated implementation or validation evidence before checking it off. Run the narrowest relevant tests and the repository-required checks for code changes. Keep security finding status in sync with `plans/security-audit.md`. Do not count waived evaluations, accepted risks, fake-provider tests or fake-CDP tests as real-provider or real-browser validation.
