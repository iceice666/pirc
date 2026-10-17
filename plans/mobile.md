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

- [ ] **Dynamic content compatibility:** signed/font-relative/empty-block and bottom-edge
      margin collapse, positioned/transformed/zoomed/table offset geometry,
      inline-fragment geometry and image/resize/chart/framework flows. A DOM write followed immediately by a geometry read still needs a
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
- Negative and font-relative top margins, empty-block collapse-through and
  parent/bottom-edge collapse need wider native layout support. Common
  nonnegative pixel and percentage parent/first-child top margins now match
  their browser references, including the previous eight percentage findings.
- Percentage margin settling uses actual containing-block widths, with at most
  eight native layout passes. Missing bases or a nonconverging layout withhold
  geometry packets and retain committed scroll dimensions. Arbitrary standalone
  dry/intrinsic queries at hypothetical widths and cyclic intrinsic sizing are
  not a general browser sizing implementation.
- Basic `display:flow-root` box sizing and the margin barrier are covered;
  float placement/containment and negative percentage/auto flex margins remain
  outside the tested subset.
- Some inserted classic-script lexical-scope behavior differs from the browser.
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

## Native element offsets follow-up

Full HTML pages now expose measured `offsetTop`, `offsetLeft` and the actual DOM
`offsetParent` through the existing revision/identity-checked layout bridge.
Native measurements preserve the browser's root/body origins, parent border
insets, signed rounding and unscrolled coordinates. Missing, ambiguous or stale
measurements remain explicit errors; detached and unrendered elements report
zero offsets and a null parent. Absolute/fixed/sticky positioning, relative
insets, transforms, zoom, table offsets and fragmented inline geometry still
need native layout support and are not claimed as implemented.

Normal block negative horizontal margins and fixed flex-item margins now
contribute to native layout and flex allocation. Negative vertical block margins,
negative percentage/auto flex margins and full CSS margin collapsing still
need wider support.

The dedicated Chromium 153 reference has 36 observations across 18 cases at
390×844 and 768×1024, including nested and window scroll states. All 18 cases now
match the captured offset and origin checks after the top-margin follow-up.
Browser reference values are not replaced with native results. The bundle tests
cover actual LinkeDOM parent identity, the classic-script frame gate, mutation/reparenting
staleness, detached/unrendered elements and missing metadata.

Additional flex references check signed row margins with weighted shrinking,
positive block margins with column grow/shrink, and cross-axis centering. Both
coordinates and allocated width/height match; fixed flex margins keep the tight
allocation instead of entering the HTML core's loose margin Column. Android
emulator acceptance uses a real local HTTP page and JavaScriptSandbox: initial
parent identity/offsets, two-axis scrolling, stale reads after a style mutation
and the subsequent freshly measured offset all pass.

Final gates for this follow-up: 4,501 Flutter tests and 519 JavaScript tests
pass; Flutter analysis and formatting are clean. The local HTTP Android
integration passes in the emulator. Physical-device and remote-push acceptance
remain pending.

## Parent/first-child top-margin follow-up

Full fetched pages now compute a render-only collapse plan from the original DOM
and winning author cascade before converting the root/body to native wrappers.
Nonnegative pixel top margins collapse through eligible nonempty block chains;
the parent’s actual border box/background moves with the collapsed edge.
Computed styles retain their authored values. Root margins never collapse;
body default margins, visibility:hidden and fixed parent heights are covered.
Borders, padding, inline content, clearance, floats, flex/grid items and new
formatting contexts stop the relevant collapse. Signed, font-relative,
empty-block and bottom-edge groups remain outside this subset. Percentage
support is described in the next follow-up.

The prior five offset findings now match Chromium, including scroll-content
parent bounds and a body shifted by a 1000 px first-child margin. A separate
32-observation reference across 16 cases and both viewport widths checks actual
x/y/width/height and offsets. All sixteen cases now match, including the
flow-root control after the native block sizing correction below. Production
fetched-page widget tests cover fixed heights, following siblings, resize and
large body-margin scrolling. Browser capture tools use the dedicated test shell.

Final gates: 4,575 Flutter tests and 519 JavaScript tests pass; Flutter analysis
and formatting are clean. The 32-observation Chromium margin capture reproduces
without geometry changes. This follow-up uses production-path host/widget tests;
physical-device and remote-push acceptance remain pending.

## Percentage top margins and flex sizing follow-up

Percentage parent/first-child top-margin groups retain each contribution's
original element identity. Native layout resolves each percentage against that
element's actual containing-block content width, then collapses the resolved
values. A bounded synchronous layout loop applies those margins before exposing
geometry. Authored DOM styles and cascade values remain intact. Provisional or
failed passes cannot clamp nested or page scroll offsets; only settled metrics
are committed. Resizing retains form state and page scroll position.

A new dedicated Chromium reference covers 30 observations across 15 cases at
390 × 844 and 768 × 1024: distinct parent/child bases, nested pixel/percentage
chains, body defaults, fixed heights, viewport resize, borders/padding/overflow,
flow-root and flex/grid barriers, flex wrapping and competing margin sizes.
The previous eight percentage-collapse findings and the fixed-margin flow-root
finding are resolved. All 48 original percentage observations and all 32 fixed
margin observations also match their expected geometry.

Positive percentage flex margins participate in sizing and shrink allocation
using the container's content width. Auto-height column regression coverage
checks that the margin is counted once. Hypothetical dry queries cannot poison
the next actual viewport layout. Unsettled geometry fails explicitly rather
than being reported as current. Remaining intrinsic/cyclic sizing, signed,
font-relative, empty-block and bottom-edge limits are listed above.

Final gates for this follow-up: **4,622 Flutter tests** and **519 JavaScript
tests** passed; Flutter analysis and formatting are clean. The local-HTTP Android
integration passed with the shipped JavaScript sandbox and native renderer:
offset-parent identity, two-axis scrolling, stale-read rejection and percentage
margin recomputation after a 200-to-300 px parent-width mutation. Its scroll
assertion waits for the native result and then the fresh script observation;
a fixed delay had allowed an old observation to be read on Android.

Browser captures use only synthetic local HTML in the dedicated headless shell.
Physical-device, real-account/provider and remote-push acceptance remain pending.
