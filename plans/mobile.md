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

- [ ] **Dynamic content compatibility:** complete Canvas ink/baseline text metrics,
      synchronous write/read layout support and broader chart-library acceptance; extend
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
- Chart.js 4.5.1 bar charts now construct, paint, update data and resize through
  the native fetched-document path on phone/tablet at DPR 1/3. The accepted cases
  use explicit pixel CSS dimensions, initially consistent backing sizes, and a
  CSS cascade without attribute dependencies. Real CSS width changes wait for
  native layout before ResizeObserver updates the chart. Bitmap-only changes
  then retain proven unchanged geometry. The maximum observed bar-geometry
  difference is 0.055 px from platform fonts. Default/unprepared sizes, intrinsic
  and percentage dimensions, CSS attribute dependencies, arbitrary synchronous
  DOM write/read flows, other chart types and animation remain unverified.
  Stock bar touch tooltips, blank/outside dismissal and rapid outside taps are
  covered. **Legend hide/show redraw is not usable yet:** its strikethrough needs
  unsupported Canvas text ink bounds and can leave the chart blank. This is a
  confirmed remaining issue, even though the dataset visibility flag changes.
- Public `MutationObserver` covers live child/attribute/text changes, subtree
  matching, filters/old values, microtask delivery, `takeRecords()` and
  `disconnect()`. Private serialization does not create guest notifications.
  Detached-subtree transient registrations and bulk-operation record grouping
  still differ from browsers. Cross-document observation is explicitly rejected;
  active observers, targets and pending records have documented limits below.
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

These sizing fixes alone did not establish third-party chart-library
compatibility. The later Canvas-width and native-chart follow-ups below cover
pre-sized bar charts; genuine size-changing synchronous write/read flows remain
open. Physical-device/real-account acceptance and remote push remain pending.

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
- Resize observation alone does not establish full Chart.js compatibility.
  The later native-chart follow-up covers pre-sized bar charts; broader chart
  interactions and size-changing synchronous write/read flows remain open.

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

## Native Canvas text width follow-up

Canvas `measureText().width` now runs synchronously in the document's existing
JavaScriptSandbox, using the Skia paragraph engine pinned to Flutter 3.44.4. The
Android text shaper supplies the actual selected system font faces, styles and
variation axes. Scripts continue in one execution; there is no script replay,
WebView, character-count estimate or placeholder width. Flutter paints the
recorded Canvas commands with the original platform fonts.

The native collector extracts selected TTC faces and deduplicates their bytes.
For supported CFF/CFF2 faces it keeps the real glyph IDs, cmap, advances and
shaping tables while omitting outlines from the measurement-only copy. CFF2
conversion retains `fvar`, supported `avar` and `HVAR` data; TrueType outline
variation is not stripped. Unsupported conversions retain the original face,
subject to the resource budget. Derived faces never paint text or supply ink
bounds. This follows the OpenType [horizontal metric](https://learn.microsoft.com/en-us/typography/opentype/spec/hmtx)
and [HVAR](https://learn.microsoft.com/en-us/typography/opentype/spec/hvar)
advance sources.

The pinned Roboto/Chromium 153 corpus covers two viewports, spaces and ASCII
whitespace, kerning/ligatures, digits, Greek/Cyrillic, combining accents,
DOMString conversion, readonly widths and unchanged context state. Missing
Hebrew/Arabic glyphs in this particular fixture fail explicitly; their browser
fallback widths are observations rather than same-font expectations. Actual
Android acceptance compares 14 Latin/CJK cases with Flutter TextPainter and
paints labels plus a rectangle whose width comes from the script measurement.
Canvas `fillText`/`strokeText` also normalize whitespace and accept an explicitly
undefined optional maximum width, as used by Chart.js. Nonfinite/nonpositive
maximum widths produce no draw, matching the browser fixture.

Resource observations on the dedicated emulator: the representative CJK document
transfers 5,932,888 unique font bytes, uses a 32 MiB WASM heap and initializes in
about one second. Before omitting CFF2 outlines, it needed 35,019,020 font bytes
and a 128 MiB heap. These are engine observations, not whole-app memory or
physical-device performance guarantees. A separate comparison of the original
and native-derived CFF2 face covers nine weights × eight texts, including
variable Latin advances and Chinese; all 72 widths match exactly.

Remaining explicit differences:

- Only `TextMetrics.width` is implemented. Ink bounds, font bounds and baseline
  metrics fail with `NotSupportedError` instead of returning fabricated values.
- Android 12+ and JavaScriptSandbox WebAssembly, named-data and Promise-return
  features are required for this width surface. Older supported Android devices
  retain ordinary native rendering but cannot use synchronous Canvas measurement.
- Preparation covers the listed common generic/Arial/Helvetica/Times/Courier/
  Roboto/Inter aliases, normal/italic and weights 400/700. Custom downloadable
  fonts, other weights and unprepared families are not supported. The first
  family follows the existing Canvas painter policy; complete CSS font fallback
  lists and inherited RTL direction are not yet implemented.
- Fonts are selected from Latin/digits and up to 4,096 UTF-16 units of distinct
  non-ASCII source characters. Later content that needs an unprepared font fails
  explicitly. Collection is bounded to 32 resources and 48 MiB of unique bytes;
  each measurement to 16,384 UTF-16 units, with a bounded result cache.
- Platform font aliases can resolve differently from a desktop browser. Portable
  same-font comparisons use the pinned open-source Roboto file; this does not
  establish arbitrary cross-platform font or complete Canvas visual parity.
- The initial Chart.js fixed-size probe used synthetic native layout packets.
  The native follow-up below supersedes that probe with four real rendered
  cases; genuine size-changing synchronous write/read flows remain open.

Verification: 4,780 Flutter tests, 546 JavaScript tests, 290 Android JVM tests,
Android Canvas width/pixel acceptance, static analysis and formatting passed.
The existing Android local-HTTP layout/interaction integration also passed
with the new engine preparation; detailed run evidence stays in ignored local
acceptance output.

## Native chart and DOM observation follow-up

Exact same-value HTML attribute writes no longer invalidate an otherwise current
native layout packet. Canvas width/height setters still clear the bitmap and
reset context state, including when their value does not change. Real changes,
A → B → A changes, unknown old values, non-HTML namespaces and repeatable
resource/control assignments retain their conservative layout fences. No stale
geometry is returned to satisfy a library read.

The packaged runtime now exposes `MutationObserver` and readonly-field
`MutationRecord` instances with iterable NodeList records. It uses the private
LinkeDOM observer with checksum-verified build-time fixes for nested targets,
removal sibling context, attribute matching and character-data records. Public
notifications are queued at mutation time so later Promise jobs follow them;
callbacks can drain or disconnect a later observer before it is notified.
Internal marker attributes and document-clone serialization stay private while
already pending authored records are preserved. Callback failures are diagnostic
and do not prevent other observers from receiving their records.

Explicit observation differences:

- Mutations inside a detached subtree between its removal and notification do
  not use browser transient registrations. Live subtree observation is covered.
- Bulk `innerHTML`, fragment and replacement operations can produce per-node
  child-list records instead of browser aggregate records. Those groupings are
  not claimed equivalent.
- Namespaced attributes and complete Web IDL property descriptor behavior are
  not accepted as a complete browser surface. The two `data-pirc-script-*`
  instrumentation attributes are reserved and hidden from public notifications.
- Observation is limited to nodes from the current document. There are at most
  128 active observers, 1,000 target registrations and 5,000 pending records.
  Capacity exhaustion produces an explicit error/diagnostic; `disconnect()`
  releases capacity and allows reuse. Private suppression is synchronous only.

Chart.js 4.5.1 is a test-only pinned UMD dependency with original MIT license and
SHA-256 provenance. It is served over loopback for acceptance and is not bundled
as an app library. The dedicated Chromium 153 reference blocks all network
requests and captures phone 390 × 844 / tablet 768 × 1024 at DPR 1 and 3.
Android acceptance fetches the same library through the real native transport,
uses real Flutter layout and synchronous native Skia text widths, compares
Canvas CSS/bitmap dimensions and bar geometry, samples the native painted bars,
and taps the rendered update button to change data from [3, 7] to [6, 2].
All four cases pass with no script diagnostics. Every bar-geometry delta is
retained in ignored evidence; the observed maximum is 0.054108 px, with matching
vertical geometry and exact sampled blue RGBA pixels. Browser and Android fonts
are different, so this is not a complete cross-platform screenshot equivalence
claim. The initial acceptance did not cover container/CSS resizing. The follow-up
below accepts a measured fixed-pixel subset. The later touch follow-up covers
stock bar tooltips; arbitrary chart types and animation remain open.

The test reuses one Gateway across document cases, matching the app's ownership.
Separate EventChannel listeners with the same channel name replace each other;
creating a Gateway for each case had triggered event-stream teardown and closed
its document isolate. No product timeout or geometry fence was weakened.

Verification for this follow-up: all 563 JavaScript tests, 132 targeted Flutter
controller/layout/Canvas tests, Android DOM-observer IPC acceptance, all four
Chart.js cases, existing native Canvas font/pixel acceptance and the existing
local-HTTP layout/scroll/interaction acceptance pass. Static analysis and format
checks also pass. Run counts and detailed logs remain in ignored acceptance
output; disposable builds and owned emulator disk images are removed after the
run. This does not close the broader parity goal or the listed rendering gaps.

## Native chart resizing and style mutation follow-up

The Chart.js acceptance now also taps a rendered resize button, increases the
container and Canvas CSS widths by 20 px, waits for the chart's real responsive
frame callback, compares the resulting geometry with the same Chromium fixture,
and samples both native painted bars. Phone/tablet cases at DPR 1/3 pass with
no script diagnostics. This uses the authored chart instance without replaying
its script or guessing new dimensions.

Two underlying corrections make this path reliable:

- Direct CSSOM property assignments and `setProperty`/`removeProperty` now report
  their genuine prior style attribute to DOM observers. Previously LinkeDOM
  changed that attribute internally without a mutation record, allowing a size
  change to bypass the native revision fence. New property writes produce one
  record, while exact repeat assignments and absent-property removals do not;
  explicit `style.cssText` writes retain normal attribute-set behavior. Those
  notification cases were checked against dedicated Chromium 153. Full CSSOM
  parsing, priority handling and serialization equivalence are not claimed.
- A completed native frame can mark a Canvas bitmap-size change independent of
  geometry only when both authored CSS dimensions are nonnegative numeric pixel
  lengths and the complete parsed CSS has no attribute selector or `attr()`
  dependency. The proof includes inline styles, inactive rules and nested
  selectors; malformed or unsupported CSS and unresolved imports withhold it.
  This covers selectors that could otherwise change ancestors or siblings.
  Missing proof, non-HTML/non-Canvas boxes, auto/intrinsic sizes, percentages,
  calc()/relative lengths and any genuine DOM/style change keep the existing
  remeasurement requirement. Packet metadata is validated and bound to the exact
  measured element, current revision and real box.

The bitmap reset still clears Canvas state and draw commands. Retaining the
completed native geometry for a proven bitmap-only change does not make a new
CSS size readable before layout. General synchronous size-changing DOM write/read
support remains open, including arbitrary library initialization and CSS-driven
intrinsic resizing. Attribute-dependent pages use the conservative fallback.

Verification: all 567 JavaScript regressions and 162 focused
CSS/cascade/style/Canvas and navigation tests, native chart initialization/update/resize at all four screen
and density cases, real Android style-mutation records, and existing HTTP
layout/scroll/interaction acceptance pass. Static analysis and formatting pass.
Detailed counts, source/bundle hashes, browser observations and geometry deltas
remain in ignored acceptance output; disposable test/emulator outputs are cleaned
afterward. The broader parity goal and previously listed physical-device and
push acceptance remain active.


## Native bar touch interactions

The fixed-pixel Chart.js cases now compare stock bar touch tooltips, blank-area
and outside taps with the dedicated Chromium 153 touch reference. Native paint
checks cover highlight colors, tooltip background pixels and actual tooltip text
commands. An additional Android sequence taps a bar and immediately taps outside
without pumping between gestures, then checks the final cleared state.

A passive document listener uses the real Flutter view hit path, including
stacking, clipping, transforms and scrolling. It waits for a matching native
frame when the DOM revision has advanced. New primary gestures, cancellation,
document replacement and detachment invalidate old pending results. Accepted
Canvas clicks announce accepted queue entries before asynchronous delivery;
boundary exits wait for those entries to complete and reconcile the final real
target. This also preserves ordering for libraries that coalesce events per frame,
so an early exit cannot be merged ahead of a late click and revive its tooltip. Desktop pointer boundaries also deliver their
corresponding mouse events, including after pointer capture releases.

Remaining: the browser oracle includes legend taps, but native hide/show redraw
is **not accepted**. Chart.js requests actual glyph ink bounds for a hidden-label
strikethrough; the current width-only TextMetrics rejects that read, aborts the
redraw and can leave the chart blank. Keep this issue ahead of further chart
coverage. Full DOM TouchEvent/multitouch lifecycle and animation are unverified;
this follow-up does not establish general browser input equivalence.
