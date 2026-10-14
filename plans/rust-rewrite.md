# Rust post-cutover follow-ups

[Active plans](README.md) · [Implementation and decision history](../docs/history/rust-rewrite.md) · [Security audit](security-audit.md)

Status: rewritten as a post-cutover work queue on 2026-10-14. **M0–M9 are complete**: version 0.4.0 ships native `pirc-gateway` and `pirc-node`, with chat selected by `pirc-node chat` and node protocol 10. The TS server implementation and its retained test/evaluation tooling have been removed. The original milestones, measurements, accepted compatibility differences and validation evidence are preserved in the history linked above.

This checklist is not authorization to implement fixes, run paid evaluations, access credentials, deploy services or delete state. Each work item needs the user's go-ahead. Unchecked verification items mean evidence is missing, not that the implementation is known to fail. Previously accepted risks and waived gates remain accepted unless the user explicitly reopens them.

## 1. Security fixes deferred until after cutover

The authoritative findings are S1–S5 in [the Rust agent port review](security-audit.md#found-while-reviewing-the-rust-agent-port-2026-10-11). These affect advisory controls; the mandatory OS sandbox remains a separate enforcement layer. M7 fixed S6–S9 and other native-sandbox findings, not S1–S5.

- [ ] **S1 — High: program execution through read-only commands.** Check execution options such as `fd -x/-X/--exec`, `rg --pre` and `bat --pager`, or remove the affected commands from the read-only table. Add regression cases proving they cannot bypass approval/write-lease decisions.
- [ ] **S2 — High: writes through read-only commands.** Correct classification of output operands, in-place options and state-changing commands, including `uniq`, `xxd`, `tree -o`, `yq -i`, `date -s`, `hostname NAME` and compact `sed` write syntax. Add regression cases for the audit's examples.
- [ ] **S3 — High: symlink followed by `..`.** Make path classification agree with filesystem traversal, or conservatively classify ambiguous paths as unknown. Test reads and writes through symlink/`..` chains.
- [ ] **S4 — Medium: exfiltration and recursive credential reads.** Review `wget --post-file`/`--body-file` and recursive `grep`/`rg` over home or credential directories. Record the intended approval policy and add regression tests.
- [ ] **S5 — Low: unbounded agent stdin lines.** Define a limit and failure behavior for node-to-agent RPC lines; test oversized input without unbounded buffering.

Closure: record fixes and regression evidence in the security audit as well as checking items here. Existing historical TS recordings need not reproduce deliberately stricter security behavior.

## 2. Known implementation and test follow-ups

These were explicitly left by M6/M7. The 2026-10-14 documentation review found no later closure evidence; the macOS and OOM failures were not rerun during that review.

- [ ] **macOS policy test:** investigate and fix `pirc_policy::tests::guard_refuses_private_reads_and_protected_writes` (`crates/pirc-policy/src/lib.rs`). M7 recorded a failure because `/etc` resolves to `/private/etc`; the test still expects `/etc/x`. Verify the intended guard behavior rather than merely weakening the assertion, then run the relevant tests on macOS.
- [ ] **QuickJS OOM teardown:** reproduce the `JS_FreeRuntime` assertion after an out-of-memory script has emitted `done`; fix or explicitly disposition it, with a regression test covering guest teardown and the parent-observed result. Start in `crates/pirc-ptc/src/guest.rs` and PTC runtime tests.
- [ ] **Host execution session isolation:** review the M6 difference from TS `setsid`. `crates/pirc-node/src/runner/host.rs` currently creates a process group, not a separate session, so a host command can reach the node's controlling terminal via `/dev/tty`. Decide whether to restore session isolation; validate terminal access, cancellation and process cleanup.

## 3. Verification evidence still missing

Use the current Rust-only test stack. Record the tested commit, platform, commands, outcomes and any skips. Historical passes are not evidence for later code changes.

- [ ] **GitHub CI:** obtain and review a successful workflow run for the cutover/current revision, including the Linux sandbox/podman coverage. Workflow definitions and local passes alone are not evidence that hosted CI passed.
- [ ] **Android APK:** run the APK build against the post-cutover repository and record its result. Android sources were not part of the server rewrite.
- [ ] **Complete macOS runtime validation:** run the applicable Rust unit/integration/conformance suites on a real Mac, explicitly reporting platform skips and resolving or dispositioning failures, including the policy test above.
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
