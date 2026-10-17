# Mobile app follow-up work

[Plans](README.md) · [Build and test the app](../apps/android/README.md)

Integration target: 0.6.1, on top of the 0.6.0 Rust gateway/node. The Flutter
Android app is the active client implementation. The previous Android audit is
historical; its unresolved visual details are deferred below. iOS transport is
outside the agreed scope.

## Included in this update

- Native chat/work navigation, session streaming/cancellation/reconnection,
  approvals, memory, schedules, files, Git, terminal, browser and task panels.
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

- [ ] **Project files:** add native project-file upload/list/delete controls for
      the new Web/backend feature (`1acc4371`). Existing project chats remain
      available; manage their shared files on the Web until this UI is added.

- [ ] **0.6.0 project deletion:** add the deletion preview, mixed-source memory
      decisions, confirmation and interrupted-deletion retry UI. Until then, finish
      deletion on the web; the app must block creating chats in a deleting project.
- [ ] **Dynamic content compatibility:** root percentage-height chains,
      offsetTop/Left/Parent, inline-fragment geometry and image/resize/chart/framework
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

The full Rust workspace gate is **not green on this host**: two PTC heap-exhaustion
checks report `Uncaught null`, and the browser corpus expects OOPIF targets that
Headless Shell 153 does not report. Those implementation/test sources are
unchanged from 0.6.0; retain these findings rather than weakening the assertions.
Linux black-box conformance remains a CI check; full Nix package builds were not
run locally. The 0.6.1 CI Nix dependency hashes/evaluation passed.

The Linux sandbox CI test `a_real_agent_is_confined` also fails with
`bwrap: Can't read seccomp data: Resource temporarily unavailable`. This is the
same failure recorded by the [0.6.0 baseline CI](https://github.com/iceice666/pirc/actions/runs/39009632614),
and remains a backend follow-up; do not report the whole repository as green.

Raw logs, synthetic state, screenshots, generated captures and APKs remain in
ignored local output. Only the Android and web clients are published under
`apps/`; the native transport and its tests are part of the Flutter Android tree.
