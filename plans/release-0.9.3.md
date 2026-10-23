# 0.9.3 local readiness review

Reviewed 2026-10-23 in `flutter-web-parity`, based on local `a2ad0c64`
and integrated `origin/main` at `1846dfde`. Fetching origin found no newer main
commit. This record does not authorize a remote push or release. Product
manifests remain at 0.9.2; the next release commit will bump them together.

## Changes reviewed

- Checkpoint capture, retention, isolated recovery and continuation: owner/control
  checks, source identity, symlink/hardlink rejection, stale confirmations,
  concurrent writer fencing, crash/restart recovery and preservation of later
  user edits. Recovery does not publish into the original workspace or enable
  its repository-memory writers.
- Integrated session handoff/repository memory: provenance and owner checks,
  cold activation, idempotent receipts, clear/forget boundaries, concurrent
  runners, 69 MiB multi-session history and source changes after cache eviction.
- Same-account private-state sandbox registration, macOS native isolation and
  TLS rejection of compromised emSign keys, including trusted fixture roots
  and valid-certificate controls.
- Web/Android calendar, memory/checkpoint panels, account/control changes,
  pairing, streams, interaction withdrawal, session editing and terminal APIs.

## Fixed during this review

- Web/Android now group execution details under one response activity row.
  Streaming only updates the row; thoughts, tools, scripts and system results
  remain collapsed until opened. Final text, images, warnings and failure counts
  remain visible. Pending approvals stay outside the disclosure; an actual App
  route test verifies they are usable and withdrawn after another device answers.
- Image-only system results retain an accessible child disclosure. Tool failures
  no longer automatically expand their output. English/Traditional Chinese labels
  use the existing catalogs.
- Updated the protocol-rejection snapshot from daemon 13 to 14. Corrected the
  Calendar navigation test's obsolete Schedules label.
- Made session crash/restart tests identify only their own RPC agent on macOS.
  Relevant transcript fixtures now keep temporary files inside their private
  directories, avoiding an unrelated macOS shared-temp warning without changing
  the product's warnings or weakening snapshot assertions.
- Corrected upgrade documentation to Gateway schema 1008, Node schema 2002 and
  node protocol 14. Reconciled release instructions: main checks must succeed
  before pushing its tag. Added concise Unreleased notes.

## Local verification

| Area                                    | Result                                                                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust workspace library/binary tests     | 1,110 passed; 3 existing subprocess helpers ignored by the ordinary runner                                                                                                                    |
| Checkpoint file/recovery safety         | 74 passed                                                                                                                                                                                     |
| macOS sandbox and same-account registry | 23 passed                                                                                                                                                                                     |
| TLS distrust/control cases              | 3 passed                                                                                                                                                                                      |
| Real-process API/Agent integration      | 59 distinct scenarios passed across 22 suites, including required native checkpoint execution                                                                                                 |
| Web                                     | 412 distinct tests passed across the full suite and final targeted rerun; Svelte check and production build passed                                                                            |
| Flutter                                 | Full run: 8,207 passed, one obsolete Calendar label failed; that test passed after correction. Final focused reruns and the new App approval regression passed (8,209 distinct tests covered) |
| Android native JVM                      | 348 passed                                                                                                                                                                                    |
| Static/build checks                     | All-target workspace Clippy with warnings denied, Flutter analysis, repository formatting, diff checks, synchronized version check and pinned model catalog check passed                      |

The production Web build still reports its existing large-bundle advisory;
there is no build error. Disposable Rust targets, Android test/build intermediates
and Web build caches are removed after verification. Existing APKs are retained.

## Remaining release gates and known limits

No unresolved blocker was found in the reviewed local paths. This is not a claim
that every platform or deployment is verified.

- Nix runtime/build validation remains waived by the user. Linux bubblewrap and
  `/proc` process-privacy cases require Linux CI; macOS tests do not substitute.
- Android hardware keyboard/background behavior and true remote notification
  delivery still require acceptance. No emulator or third-party relay was used.
- Browser automation and deployed hosts were not exercised in this pass. TLS
  unit fixtures do not verify OS CA updates or curl/Git trust stores.
- Existing memory ledgers were not activated and no deployment state was changed.
- When publication is authorized: make the 0.9.3 release commit, increment Android
  build number, refresh version-dependent Nix hashes, run the exact-commit CI
  gates, then tag and review the signed draft assets. Do not reuse 0.9.2 assets.
