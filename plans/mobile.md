# Mobile app follow-up work

[Plans](README.md) · [Build and test the app](../apps/android/README.md)

Integration target: 0.6.1, on top of the 0.6.0 Rust gateway/node. The Flutter
Android app is the active client implementation. The previous Android audit is
historical; its unresolved visual details are deferred below. iOS transport is
outside the agreed scope.

## Included in this update

- Native chat/work navigation, session streaming/cancellation/reconnection,
  approvals, memory, schedules, files, Git, terminal, browser and task panels.
- Chat-project files, including top-level Chats: native multi-file selection,
  streaming uploads, listing, same-name replacement and confirmed removal.
- Project deletion previews, mixed-source memory decisions, revision conflicts
  and finishing an interrupted deletion from the app.
- Pairing and first-launch permission guidance, notification/overlay controls,
  attachments, code highlighting, Markdown, math and supported native diagrams.
- Short-lived provider/device management grants approved by the logged-in web
  user; ordinary paired-device permissions remain restricted.
- Cross-device answer ownership and resolved state, including stale/duplicate
  answers and notification withdrawal.
- Native document transport, forms, script/module execution, percentages,
  flex/grid, scrolling and common pointer/click interactions. These implement
  tested browser behavior, not a complete browser engine.

## Remaining work, in priority order

- [ ] **Dynamic content compatibility:** offsetTop/Left/Parent,
      inline-fragment geometry and image/resize/chart/framework
      flows. A DOM write followed immediately by a geometry read still needs a
      matching native frame; unsupported reads fail explicitly. Native Canvas event
      callbacks have measured geometry for their synchronous dispatch.
- [ ] **Physical phone/tablet acceptance:** use a real account for pairing,
      streaming/cancel/reconnect, panels, management consent and simultaneous
      web/App confirmations; check keyboard, rotation, background, low memory and
      OEM permission/notification behavior. Emulator and synthetic-model tests do
      not establish these outcomes.
- [ ] **Remote background push:** real relay/delivery remains unverified. The
      user declined third-party relay testing; keep this explicit until authorized.
- [ ] **Distribution decisions:** production signing and store versus sideload
      delivery; token rotation before expiry versus re-pairing; Context inspector
      scope. Existing preview APKs use a separate application ID and local test key.

## Deferred details and known limits

- Small visual differences, uncommon syntax and the old audit's fine-grained
  layout/style items. The frozen visual corpus is web revision `bd3d909`; newly
  added 0.6.x features are tracked separately rather than claimed as visual parity.
- Eight percentage top-margin cases differ by parent margin collapse. Some
  inserted classic-script lexical-scope behavior differs from the browser.
- Two root-height fixtures retain extra trailing blank scroll space: 8 px with
  the default body margin, and 17 px with nested content-box edges. Their element
  rectangles match Chromium; these small scroll-extent differences are deferred.
- Root horizontal scrolling, scrollend/Promise semantics, mixed window/element
  event order, RTL, scroll snap/anchoring and nested touch scroll chaining need
  wider coverage. Smooth scroll timing follows Flutter.
- Arbitrary websites/frameworks, third-party cookie policies and full browser API
  coverage are not guaranteed. Preserve explicit unsupported errors and record
  real failures before expanding compatibility.
- Previous Rust PTC heap-exhaustion diagnostics are backend findings, not a claim
  that the app or this integration tested arbitrary provider/runtime workloads.

## Integration evidence

Validated on macOS ARM64 against the 0.6.0 merge (`70266c35`), with product
version 0.6.1 and Android build 68:

- Flutter analysis and formatting: clean; 4,362 unit/widget tests passed.
- JavaScript renderer: 514 tests passed; Android app JVM suite: 271 tests passed.
- Web: typecheck, 317 tests and production build passed; version helper tests,
  format, model-catalog and embedded-browser asset checks passed.
- Fresh Rust gateway/node builds and workspace Clippy passed. Gateway unit tests:
  108 passed; node library: 297 passed, two ignored.
- Owned Android emulator plus fresh Rust services: pairing, device-only access,
  streaming, select/text answers, memory edits/conflicts, reconnection, schedules
  and source-chat/memory deletion passed. Browser-approved management grants
  covered both scopes, provider-only isolation and revocation. Lost answer
  responses required explicit reconciliation without automatic resubmission.
- These integration checks use local synthetic models/accounts. They do not
  establish physical-device, real-provider subscription or remote-push acceptance.

At the 0.6.1 release, the full Rust workspace gate was **not green on this host**:
two PTC heap-exhaustion checks reported `Uncaught null`, and the browser corpus
expected OOPIF targets that Headless Shell 153 did not report. These were retained
as findings rather than weakening the assertions; see the follow-up below.
Linux black-box conformance remains a CI check; full Nix package builds were not
run locally. The 0.6.1 CI Nix dependency hashes/evaluation passed.

The release-time Linux sandbox CI test `a_real_agent_is_confined` also failed with
`bwrap: Can't read seccomp data: Resource temporarily unavailable`. This is the
same failure recorded by the [0.6.0 baseline CI](https://github.com/iceice666/pirc/actions/runs/39009632614),
and is addressed by the follow-up below.

Raw logs, synthetic state, screenshots, generated captures and APKs remain in
ignored local output. Only the Android and web clients are published under
`apps/`; the native transport and its tests are part of the Flutter Android tree.

## Backend CI follow-up

[PR #4](https://github.com/iceice666/pirc/pull/4) integrates the project-files
update (`1acc4371`) and fixes the release-time backend failures:

- Retry only SQLite WAL-mode lock conflicts before the existing schema
  transaction; deterministic lock-release tests cover gateway and node.
- Use the production sandbox command in the real-agent test so its seccomp
  descriptor is passed. The complete Linux sandbox CI job passes.
- Track actual QuickJS allocation failures within the existing 128 MiB cap.
  PTC allocator/unit tests and all 34 runtime cases pass, including ordinary
  `throw null`, heap exhaustion and a busy loop after catching exhaustion.
- Gateway/node API, protocol and schema versions remain unchanged. Consult the
  PR for final CI and Android integration results against the updated backend.

With dedicated Chrome for Testing 153.0.8010.47, the local OOPIF cases pass.
The macOS keyboard corpus still differs at step 14 by the active-focus marker;
its expected data remains unchanged. This local platform finding is separate
from the Linux CI gate and the Android client.

## Native project-files follow-up

The Android settings now expose the Web/backend project-files feature
(`1acc4371`) through Flutter. The system document picker returns scoped native
file tokens; files stream one at a time within the node's reported limit rather
than using the session-attachment picker's older 8 MiB cap. Batch uploads keep
successful files after another fails. Switching account, project, host or online
state discards stale results and stops the remaining batch; temporary tokens are
released after completion or cancellation.

Local acceptance against fresh Rust gateway/node binaries at `2560ea17`:

- Flutter analysis and formatting are clean; 49 project-files, project-links and
  workspace-settings widget tests pass, including stale reads/uploads, limits,
  partial failures, retries and inline removal confirmation.
- All 280 Android JVM tests pass, including streaming, raw-byte encoding,
  provider-read failures and project/account/window token isolation.
- Owned Android emulator integration passes native document selection, raw JSON
  and Unicode names, same-name replacement, a 9 MiB upload, list/removal and the
  existing per-session attachment path. Test projects are deleted afterwards.
- The system picker is Android UI; the project settings and content remain
  Flutter. At very narrow widths or enlarged text, file actions can move to a
  second row to remain usable. This new feature is outside the frozen `bd3d909`
  visual corpus. Physical-device acceptance and remote push remain pending.

## Native project-deletion follow-up

Chat-project settings now include the Web deletion preview, automatic
project-only note removal and rollback summaries, explicit Forget/Keep/Edit
choices for mixed memory, and the interrupted-deletion Finish deleting action.
The top-level Chats workspace cannot be deleted. A memory revision conflict
reloads the preview and clears prior decisions. Other failures reload the
remaining deletion plan before retrying; no POST is retried automatically.

Preview and confirmation requests carry the captured pairing stamp. Android
captures that account's API before network I/O; a stale stamp is rejected before
sending a destructive request. Account, host and project changes discard the
old dialog. Acknowledged deletion clears only that project's sessions, drafts,
selection and navigation, refreshes memory/schedules and fences stale indexes
or pending chat creation from restoring deleted content.

Local evidence against fresh Rust services at `d36d86e5`:

- 91 Flutter controller/widget tests pass across deletion, navigation, settings,
  project files and links, including partial failures, explicit choices,
  conflicts, stale responses, duplicate clicks and 320 px / 2× text layout.
- All 280 Android JVM tests pass; Flutter analysis and formatting are clean.
- Owned Android emulator integration uses real `memory_note` source histories:
  project-only removal, external-text rollback and mixed-source edit all pass.
  A real concurrent memory edit produces 409 and requires a fresh decision;
  a stale pairing stamp is rejected. Project chats, instructions and files are
  removed while top-level Chats and external reviewed memory stay intact.
- Partial-deletion retry UI uses controlled HTTP failures in widget tests;
  physical-device/network-interruption acceptance remains pending.
- This 0.6.x feature is outside the frozen visual corpus. Its native radio/input
  controls follow the Web text and layout. A constrained keyboard viewport may
  scroll the entire dialog; dismissal and edits are blocked while submitting.

## Native full-page height follow-up

Full HTML documents now publish their actual document viewport as the initial
containing block. `html` / `body` / app percentage-height chains resolve without
forcing auto-height content to fill the screen. Fixed viewport units (`vw`,
`vh`, `vmin`, `vmax`) are supported by native block/flex sizing. A minimum height
alone still does not establish a definite height for percentage descendants.
Markdown and HTML fragments without an explicit document viewport keep their
existing sizing.

Normal block content can extend below a CSS-sized container without a Flutter
Column overflow. Visible vertical overflow contributes to the page's outer
scroll extent; nested hidden/auto overflow keeps its own viewport and scroll
extent. The root wrapper preserves hit testing for content below the CSS root.

The dedicated Chromium 153 capture in
`capture_document_root_heights_web.mjs` records 42 cases at 390×844, 844×390 and
768×1024. Native geometry, auto-height controls, viewport units, box edges and
clipped/nested scrolling are compared to the captured browser results. The two
small trailing-space differences are explicitly asserted and listed above.
Fetched-page tests also cover resizing with retained input/scroll state,
clicking an overflowing bottom link and excluding surrounding app chrome from
the document viewport. The complete Flutter suite passes 4,438 tests; Flutter
analysis and formatting are clean. Physical phone/tablet acceptance remains
pending.
