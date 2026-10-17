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

- [ ] **Dynamic content compatibility:** implement real Canvas text measurement,
      synchronous write/read layout support and resize observation for charts; extend
      the supported computed-style
      properties, list-item/inline-fragment measurements and common-library coverage;
      signed/font-relative/empty-block and bottom-edge
      margin collapse, absolute/fixed/sticky positioning, unsupported relative-inset
      units and inline fragments, transformed/zoomed/table offset geometry,
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
- Relative positioning supports native block/flex/grid/flow-root surfaces,
  signed pixel/percentage physical insets and zero values in CSS length units.
  Nonzero font/viewport-relative units, calc(), logical insets, inline fragments,
  and absolute/fixed/sticky positioning remain unsupported. A nonzero relative
  inline inset does not acquire offset metadata merely because its syntax parses.
- Some inserted classic-script lexical-scope behavior differs from the browser.
- Two root-height fixtures retain extra trailing blank scroll space: 8 px with
  the default body margin, and 17 px with nested content-box edges. Their element
  rectangles match Chromium; these small scroll-extent differences are deferred.
- Root horizontal scrolling, scrollend/Promise semantics, mixed window/element
  event order, RTL, scroll snap/anchoring and nested touch scroll chaining need
  wider coverage. Smooth scroll timing follows Flutter.
- `window.getComputedStyle()` now reads the native cascade and completed layout
  snapshot for a supported property subset. Declarations are read-only and live
  across accepted frames. Enumeration includes the supplied subset, rather than
  Chromium's full property list; omitted recognized properties, pseudo-elements,
  stale frames and unavailable declarations fail explicitly. Inline `element.style`
  remains independent. DOM writes followed immediately by style/geometry reads
  still need a matching native frame, so arbitrary framework flows are unverified.
- Computed-style dimensions use measured native boxes and original containing
  blocks. Inline-fragment dimensions, auto margins, platform form-control UA
  properties, CSS font shorthand, transforms and unimplemented length expressions
  remain outside this initial surface. Generic native font-family names can differ
  from Chromium's resolved UA family names. Per-element and packet limits withhold
  complete declarations rather than truncate custom properties or discard geometry.
- An actual Chart.js 4.5.1 production-runtime probe loads the library, but even
  a fixed-size bar chart stops at unsupported Canvas `measureText`. Its default
  responsive mode separately stops at a stale computed-style read after changing
  canvas dimensions. Native `ResizeObserver` now covers measured horizontal
  HTML content/border boxes; see its separate acceptance below. These Chart.js
  probes supply synthetic native layout packets, so they establish script
  compatibility blockers, not native rendering success. Chart.js support remains
  incomplete until text measurement and synchronous write/read are resolved.
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
zero offsets and a null parent. Common block relative insets are covered by
the follow-up below. Absolute/fixed/sticky positioning, unsupported relative
inset units/logical properties, transforms, zoom, table offsets and fragmented
inline geometry still need native layout support and are not claimed as
implemented.

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

## Native relative positioning and grid rows follow-up

Common `position:relative` blocks keep their normal-flow allocation while their
border box, descendants, paint transforms, hit testing and accessibility geometry
move together. Physical top/right/bottom/left insets support signed px and
percentages, auto, the inset shorthand and both overconstrained-axis rules.
Horizontal percentages use the actual containing-block content width; vertical
percentages use a definite content height and otherwise behave as auto. When
both horizontal sides are specified, the containing block's direction chooses
the winning side, including when the child has the opposite direction.

Offset metadata is exposed only for relative surfaces implemented by the native
renderer. Measured offset-parent identity, unscrolled offsets and signed rounding
are retained. The root/body special offset rules remain distinct. Relative
placement does not change following sibling slots or intrinsic/flow baselines.
Input edits and page scroll position survive viewport resizing; native links hit
at their shifted positions and clipped overflow becomes reachable by scrolling.

The dedicated Chromium 153 reference covers 36 viewport records and 40 geometry
states across 18 cases at 390 × 844 and 768 × 1024. It compares border-box
positions/sizes, offsets and parent identity, plus element scroll positions and
extents, with no named geometry exemptions. Cases include negative/fractional
positions, axis precedence, nested relative boxes, body/root origins,
border/padding, overflow:auto/hidden, margin collapse, flex/grid slots, indented
inline grid items and resize.
The capture reproduced byte for byte using synthetic HTML and the dedicated
test shell with network requests aborted.

The reference also exposed an existing auto-height grid bug: fixed pixel rows
were ignored unless height was tight. Fixed rows now retain their authored track
sizes and gaps with auto container height. Track identity preserves the unit so
zero percent rows are not mistaken for fixed zero-pixel rows. Fractional minmax
tracks retain their pixel floor while still growing to fit content. Direct inline
grid children are blockified and get separate native boxes, position/hit surfaces
and measured offset metadata. General cyclic percentage/fractional intrinsic
track sizing remains outside the tested subset.

Final gates for this follow-up: **4,692 Flutter unit/widget tests**, **519
JavaScript tests**, clean Flutter analysis and formatting. The Android local-HTTP
integration passed with the shipped JavaScript sandbox and native renderer:
relative parent movement from 30 to 50 px, unchanged child-relative offsets,
stale-read rejection and a successful button click after the move. It also
retains the previous two-axis-scroll and percentage-margin checks. Physical
phone/tablet, real-provider and remote-push acceptance remain pending.

## Native computed-style follow-up

`getComputedStyle()` is available on both the window and script global. It reads
supported properties from the winning native cascade and completed layout for
the same document revision. Each call returns a fresh declaration object;
retained declarations read the latest accepted frame. CSS property methods,
camel-case getters, indexed/subset iteration, empty computed `cssText`, detached
empty declarations and read-only mutation errors are covered. Inline authored
`element.style` remains independent.

Measured block dimensions include the original containing-block basis,
content-box/border-box edges, percentage padding/margins and resolved relative
insets. Common colors, inherited typography, font-relative lengths, custom
properties, stylesheet/class changes and blockified flex/grid items are covered. Unknown standard-property
values are explicitly unavailable, rather than copied from inline declarations.
CSSOM percentage inset reads in auto-height parents use the parent's actual used
height, separately from the CSS2 paint displacement's definite-height rule.

Declarations are bounded to 256 properties, 128-character names, 4,096-character
values and 16 KiB of names/values per node. Aggregate style data also has a 2 MiB
budget, counting encoded bytes. Inheritance is bounded while collecting custom
properties, so an oversized root scope is not copied into every descendant.
An oversized/unavailable declaration is withheld
whole; geometry remains available and custom properties are never silently
truncated into apparently unset values. Custom-property names currently use the
ASCII subset. The full browser CSSStyleDeclaration prototype/property surface,
pseudo-elements, font shorthand serialization, unmeasured list-item/inline
fragment dimensions, auto margins and unsupported expressions remain outside
this initial API. Arbitrary frameworks are still unverified.

The Chromium 153 capture has 12 cases at two viewports (24 records). Every sampled
property is matched or has a named boundary in the native oracle. The following
existing UA layout differences remain in the default text/list fixture, at both
viewport widths; native computed heights report the actual native boxes:

| Element   | Native height | Chromium height |
| --------- | ------------: | --------------: |
| html      |     197.88 px |      184.875 px |
| body      |     173.88 px |      152.875 px |
| paragraph |         16 px |           18 px |
| heading   |         32 px |           37 px |
| list      |         16 px |           18 px |

The paragraph/heading/list line boxes differ with native font metrics; the root
and body also retain measured flow/margin differences. Generic UA font-family
names (`serif` versus Chromium `Times`) and custom-property comma whitespace
normalization are recorded separately. Platform form-control UA defaults are
excluded explicitly. These boundaries do not exempt explicit block sizes,
percentage edges, relative inset values or list content width from comparison.

Verification: **4,733 Flutter tests** passed in the full regression run, then
**42 final focused tests** passed after the bounded-inheritance and unknown-basis
follow-ups. All **527 JavaScript tests**, Flutter analysis/formatting, repository
formatting and the Android local-HTTP integration passed. The Android test uses
the shipped JavaScriptSandbox runtime and native renderer to verify initial
reads, retained declarations after class/inline changes, inherited color, native
content/border dimensions, blockified flex/grid widths, read-only errors and
stale-frame rejection. Existing scroll, percentage-margin, relative-offset and
moved-button checks remain covered. Browser references reproduced byte for byte
in the dedicated test shell with network requests aborted. Physical-device,
real-account/provider and remote-push acceptance remain pending.

## Native image and canvas sizing follow-up

Computed dimensions for atomic inline `img`, `canvas` and SVG roots use their
actual native border boxes, with content-box edges removed where appropriate.
Unmeasured replaced elements do not acquire dimensions from author declarations.
Their percentage padding/margin reads use the real containing block when there
is no owned sizing wrapper.

Raw HTML image/canvas sizing now keeps natural dimensions in narrow containers,
including `display:block`. Explicit dimensions and percentage `max-width` still
control fitting; inline `border-box` no longer adds padding and borders twice.
The inline overflow marker reads the child's live intrinsic size after image
decode and retains bounded constraints for percentage/deferred expressions.
Single replaced-element paragraphs avoid an artificial empty leading line.
Auto-width block images/canvases derive height-constrained sizes from their actual
intrinsic content ratio. Intrinsic dependencies are restored after containing-block
invalidation, so an asynchronously decoded image can grow from its initial empty
box even when its CSS height makes the child a tight relayout boundary.
Markdown image fitting retains its existing path.

The dedicated Chromium 153 capture covers eight cases at 390×844 and 768×1024
(16 records), including real 64×32 PNG decoding, HTML dimensions, inline/block content/border
boxes, padded percentage parents, hidden elements, intrinsic overflow, explicit
max-width fitting, block auto sizing, height/max-height aspect ratios and
replacements mixed with text and horizontal edges. Image/canvas dimensions, offsets and rectangles are compared
directly. Atomic inline boxes keep their complete padding/border/margin model;
CSS edge spacers cannot silently discard sizing or geometry capture.

The remaining text-flow rounding differences are named in the oracle: three
Arial line-flow parents have native content heights 76/194/104 px versus
Chromium's 77/195/105 px. Their image/canvas dimensions and horizontal positions
match. The first inline baseline differs by about 0.058 px; later vertical
positions also inherit the preceding one-pixel line-height differences. These
user-deferred details do not widen tolerances for other geometry or dimensions.
The earlier fitted-image one-pixel line-box difference is fixed by the atomic
baseline path.

Image reflow can leave a paragraph briefly awaiting layout during selection
registration. Selection ordering now catches only that specific layout
assertion, keeps a temporary transform-based order and retries after layout,
with bounded retries and selection endpoints retained by identity. Other
assertions still propagate. The decoded-image reflow regression verifies a
selection exists before the image is revealed and can still be copied afterward.

Chart.js remains blocked by the separately recorded `measureText` and synchronous
write/read gaps; these sizing fixes and the following resize-observation work do not establish
third-party chart-library compatibility. Physical-device/real-account acceptance
and remote push remain pending as listed above.

Verification for this follow-up: **4,753 Flutter tests** passed on the final
source, including the 16 Chromium sizing records and the decoded-image selection
regression. The final targeted sizing/selection run passed **48 tests**. Android
local-HTTP acceptance passed with the shipped JavaScriptSandbox runtime and
production fetched-document renderer: real PNG decoding, initial/content/border
box dimensions, percentages, height-driven aspect ratios, retained computed
styles, scroll/offset changes and moved-button interaction. This acceptance uses
synthetic local data; it does not replace the real-account/physical-device checks.

## Native resize observation follow-up

`ResizeObserver` now uses a separate measured payload alongside the accepted
Flutter layout snapshot. Content dimensions exclude resolved padding/borders;
border dimensions use the native surface before transforms. It does not infer
size from authored width/height or rounded client/offset metrics. Unsupported
or unresolved boxes withhold entries with a diagnostic, rather than supplying
estimated values. The native payload remains available when computed-style
serialization reaches its property/character budget.

Supported: one horizontal HTML box per target, `content-box` and `border-box`
observation, fractional content rectangles, atomic inline canvas/images, initial
zero-size entries, changes after native layout, hide/show and removal/reinsertion,
re-observation, `unobserve`, `disconnect`, readonly entries/sizes and frozen size
arrays. Callback order follows observer creation; each frame gathers all entries
before guest callbacks can mutate the DOM. Cancellation by an earlier callback
suppresses the cancelled target's undelivered entry, matching Chromium; changing
its observed box does not duplicate delivery. Unchanged dimensions do not generate
another entry. Delivery pauses with the existing document lifecycle and never
polls continuously merely because an observer remains registered.

The dedicated Chromium 153 fixture covers **two viewports × 12 stages**: initial,
unchanged width, repeated observation, width, padding-only, border-only,
changing the observed box, hidden, shown, unobserved, reobserved and disconnected.
Native Flutter tests compare the measured box payload; runtime tests compare the
actual callback entries and suppression behavior against the browser. Additional
runtime checks cover malformed packets, callback mutations/errors, removal,
missing measurements, readonly data, receiver/argument validation and resource
limits (256 active observers, 5,000 target observations; explicit failure at the
limit, capacity restored on cancellation).

Remaining explicit differences:

- `device-pixel-content-box` and `devicePixelContentBoxSize` fail explicitly; no
  fabricated physical-pixel metrics are returned.
- Cross-document targets, vertical writing, SVG geometry, fragmented boxes and unresolved native box
  edges are outside this measured observer surface.
- Callback-driven layout changes are measured and delivered on a later native
  frame. This does not implement the browser's same-rendering-cycle depth loop
  and `ResizeObserver loop completed with undelivered notifications` error event.
- Callback exceptions remain visible through document diagnostics, following the
  runtime's existing callback-error policy.
- Full Chart.js remains unverified/blocked by the separately listed text-metrics
  and synchronous write/read issues. This feature is not evidence of chart-library
  compatibility.

Reference: [CSSWG Resize Observer processing model](https://drafts.csswg.org/resize-observer/);
the pinned Chromium capture is authoritative for the compared behavior.

Verification: **4,779 Flutter tests**, **541 JavaScript tests** (including 14
resize-specific runtime checks), Android local-HTTP integration, Flutter analysis
and repository formatting passed. Android used the shipped JavaScriptSandbox and
production fetched-document renderer, real decoded PNGs, measured content/border
boxes and a 200 → 300 px parent resize whose callback redraws the native canvas
with a 40 → 60 px rectangle. The integration waits for queued reads to drain
before asynchronous frame delivery; repeatedly enqueueing synthetic read taps
would starve the frame under test. Existing offset, scroll, percentage layout,
computed-style fences and moved-button hit checks still pass. Browser captures
reproduce byte for byte. No third-party data or personal browser was used.
