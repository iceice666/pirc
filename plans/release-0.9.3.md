# 0.9.3 release readiness review

Reviewed 2026-10-23 in `flutter-web-parity`, based on local `a2ad0c64`
and integrated `origin/main` at `1846dfde`. Fetching origin found no newer main
commit. The user authorized publishing 0.9.3 on 2026-10-23. A fresh
`git pull --rebase origin main` found no additional commits or conflicts.
Product manifests are synchronized at 0.9.3, with Android build 77.

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

| Area                                    | Result                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rust workspace library/binary tests     | 1,110 passed; 3 existing subprocess helpers ignored by the ordinary runner                                                                                               |
| Checkpoint file/recovery safety         | 74 passed                                                                                                                                                                |
| macOS sandbox and same-account registry | 23 passed                                                                                                                                                                |
| TLS distrust/control cases              | 3 passed                                                                                                                                                                 |
| Real-process API/Agent integration      | 59 distinct scenarios passed across 22 suites, including required native checkpoint execution                                                                            |
| Web                                     | 412 passed in the full post-bump run; Svelte check and production build passed                                                                                           |
| Flutter                                 | 8,209 passed in the complete post-bump run                                                                                                                               |
| Android native JVM                      | 348 passed                                                                                                                                                               |
| Static/build checks                     | All-target workspace Clippy with warnings denied, Flutter analysis, repository formatting, diff checks, synchronized version check and pinned model catalog check passed |

The production Web build still reports its existing large-bundle advisory;
there is no build error. Disposable Rust targets, Android test/build intermediates
and Web build caches are removed after verification. Existing APKs are retained.

After the version bump, all 18 release/tooling script tests passed with pinned
Bun 1.4.2. Version, catalog, browser-asset, formatting and diff checks passed.
The updated cargoHash reproduced the previous baseline exactly before hashing
the new lockfile; third-party package versions did not change.

The first Linux CI run passed the sandbox security tests, Nix evaluation and
hashes, and executable-size checks. Its checkpoint restart assertion compared
user files with Linux's temporary deny-path mount points. The test now captures
its expected source before sandbox startup, preserves an original empty protected
file, and still compares the whole original tree after recovery/restart. The three
checkpoint API tests also require a native runtime: Linux runs them in the
mandatory sandbox job with PATH and the real Node bridge supplied explicitly.
The test-only helper selection is compiled out of product builds.

Subsequent Linux runs also exercise all 74 checkpoint capture/recovery/safety
cases in that mandatory native job; an absent bubblewrap is a failure there.
Updated the panel snapshot for explicit memory activation and the Calendar
capability. Fixed a cancellation-test race by observing temporary-directory
creation before dropping the prepare future, so delayed blocking work cannot
make an early empty-directory assertion pass before it has even started.

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
- Publication requires successful Check and Android workflows on the exact main
  commit, followed by the annotated v0.9.3 tag and a successful Release workflow.
  Verify the new draft assets, checksums and existing Android release signing
  identity before publishing. Do not reuse 0.9.2 assets.
