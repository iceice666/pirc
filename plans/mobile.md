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

- [ ] **Dynamic content compatibility:** extend Canvas font/ink coverage,
      synchronous write/read layout within one callback and broader chart-library acceptance; extend
      the supported computed-style
      properties, list-item/inline-fragment measurements and common-library coverage;
      signed/font-relative/empty-block and bottom-edge
      margin collapse, remaining absolute/fixed variants and sticky positioning, unsupported relative-inset
      units and inline fragments, transformed/zoomed/table offset geometry,
      inline-fragment geometry and image/resize/chart/framework flows. Changed geometry
      still needs a matching native frame; a proved fixed-width ordinary block can
      retain its unchanged `clientWidth` after descendant size writes. The bounded
      edgeless-Canvas box-style and fixed single-child parent proofs are described
      below; other unsupported reads fail explicitly. Native Canvas event
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
  and sticky positioning remain unsupported. Native viewport-fixed positioning
  and the initial absolute surface are described below. A nonzero relative
  inline inset does not acquire offset metadata merely because its syntax parses.
- Some inserted classic-script lexical-scope behavior differs from the browser.
- Two root-height fixtures retain extra trailing blank scroll space: 8 px with
  the default body margin, and 17 px with nested content-box edges. Their element
  rectangles match Chromium; these small scroll-extent differences are deferred.
- Root horizontal scrolling, scrollend/Promise semantics, mixed window/element
  event order, RTL, scroll snap/anchoring and nested touch scroll chaining need
  wider coverage. Common root-block scroll anchoring is covered below; independent
  nested-container anchoring and the remaining variants are still open. Smooth
  scroll timing follows Flutter.
- `window.getComputedStyle()` now reads the native cascade and completed layout
  snapshot for a supported property subset. Declarations are read-only and live
  across accepted frames. Enumeration includes the supplied subset, rather than
  Chromium's full property list; omitted recognized properties, pseudo-elements,
  stale frames and unavailable declarations fail explicitly. Inline `element.style`
  remains independent. DOM writes followed immediately by style/geometry reads
  generally need a matching native frame; the proved unchanged parent width and
  bounded edgeless-Canvas box-style/parent proofs and certified ordinary-text
  cascade values below are exceptions. Arbitrary framework flows remain unverified.
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
  difference is 0.055 px from platform fonts. All 16 additional responsive cases
  now initialize and resize without diagnostics, including intrinsic dimensions,
  authored pixel/percentage sizes, initial inline display, omitted backing
  attributes and container-only width changes. CSS attribute dependencies,
  arbitrary synchronous DOM write/read flows and additional chart configurations
  remain unsupported or unverified. The eight stock types and their default
  animation have separate accepted gates below; animation interruption and
  background/visibility lifecycle remain unverified.
  Stock bar touch tooltips, blank/outside dismissal and rapid outside taps are
  covered, along with legend hide/show, including actual disappearance and
  restoration of the painted bars. The common label strikethrough now uses real
  glyph ink bounds; extended font and chart surfaces remain bounded below.
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
the follow-up below. Remaining absolute/fixed variants and sticky positioning, unsupported relative
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

## Native Canvas text metrics follow-up

Canvas `measureText()` now runs synchronously in the document's existing
JavaScriptSandbox, using the Skia paragraph engine pinned to Flutter 3.44.4. The
Android text shaper supplies the actual selected system font faces, styles and
variation axes. Scripts continue in one execution; there is no script replay,
WebView, character-count estimate or placeholder width. Flutter paints the
recorded Canvas commands with the original platform fonts.

The native collector extracts selected TTC faces and deduplicates their bytes.
It retains full outlines, including CFF/CFF2 variations, and Android 15+ reports
actual per-glyph synthetic bold/italic flags. Android 12–14 infer synthesis from
selected styles/axes, so their synthesis fidelity still needs device acceptance.
Glyph IDs, positions and variation typefaces come from the real shaped runs;
Skia path intercepts supply fractional ink extrema rather than rounded glyph
boxes. Font metrics and the primary face's OS/2 typography supply baseline
placement; Flutter receives that placement with each recorded text command.

The pinned Roboto/Chromium 153 corpus covers two viewports, spaces and ASCII
whitespace, kerning/ligatures, digits, Greek/Cyrillic, combining accents,
DOMString conversion, readonly widths and unchanged context state. Missing
Hebrew/Arabic glyphs in this particular fixture fail explicitly; their browser
fallback widths are observations rather than same-font expectations. The ink
reference adds 57 cases per viewport, including fractional sizes,
alignments and baselines, empty/space-only ink, ligatures and accents. Android
acceptance compares Latin/CJK advances with Flutter TextPainter and actual
rasterized text edges with the independent outline measurements; it also paints
a rectangle whose width comes from the script measurement.
Canvas `fillText`/`strokeText` also normalize whitespace and accept an explicitly
undefined optional maximum width, as used by Chart.js. Nonfinite/nonpositive
maximum widths produce no draw, matching the browser fixture.

The earlier width-only implementation stripped selected CFF/CFF2 outlines,
reducing one CJK preparation to 5,932,888 unique font bytes and a 32 MiB WASM
heap. Those measurements do not describe the current complete-outline engine;
the previous advance-only converter is no longer used for preparation. Current
resource observations and native ink acceptance are recorded in the follow-up
below. The isolate heap and guest execution limits remain unchanged.

Remaining explicit differences:

- The standard width, four actual ink bounds, font ascent/descent and baseline
  properties are supported for prepared faces. OpenType BASE-table hanging/
  ideographic selection, ambiguous font ownership and mixed color/outline glyph
  geometry fail explicitly. Bitmap-only ink uses real Skia glyph bitmap bounds.
  Chromium 153 has no `emHeightAscent`/`emHeightDescent` properties; neither does
  this runtime.
- Android 12+ and JavaScriptSandbox WebAssembly, named-data and Promise-return
  features are required for this measurement surface. Older supported Android devices
  retain ordinary native rendering but cannot use synchronous Canvas measurement.
- Preparation covers the listed common generic/Arial/Helvetica/Times/Courier/
  Roboto/Inter aliases, normal/italic and weights 400/700. Custom downloadable
  fonts, other weights and unprepared families are not supported. The first
  family follows the existing Canvas painter policy; complete CSS font fallback
  lists and inherited RTL direction are not yet implemented.
- Fonts are selected from Latin/digits and up to 4,096 UTF-16 units of distinct
  non-ASCII source characters. Later content that needs an unprepared font fails
  explicitly. Collection is bounded to 32 resources and 64 MiB of unique bytes;
  each measurement to 16,384 UTF-16 units, with a bounded result cache.
- Platform font aliases can resolve differently from a desktop browser. Portable
  same-font comparisons use the pinned open-source Roboto file; this does not
  establish arbitrary cross-platform font or complete Canvas visual parity.
- The initial Chart.js fixed-size probe used synthetic native layout packets.
  The native follow-up below supersedes that probe with four real rendered
  cases; genuine size-changing synchronous write/read flows remain open.

The initial width-only verification passed 4,780 Flutter tests, 546 JavaScript
tests, 290 Android JVM tests, Android Canvas width/pixel acceptance, static
analysis and formatting.
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
  Missing proof, non-HTML/non-Canvas boxes, auto/intrinsic sizes, unsupported
  percentages (the narrow extension below is now covered), calc()/relative
  lengths and any genuine DOM/style change keep the existing
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

The later ink-metric follow-up below supersedes the original legend finding.
Full DOM TouchEvent/multitouch lifecycle and animation remain unverified; this
follow-up does not establish general browser input equivalence.

## Canvas ink metrics and legend redraw follow-up

The common Chart.js legend redraw no longer aborts on `TextMetrics` ink reads.
The native fetched-document test now taps hide/show on phone/tablet at DPR 1/3,
compares dataset and legend state with the frozen Chromium reference, samples
each bar's original native center to prove that its fill disappears, and checks
that the exact fill returns. Tooltip, blank/outside dismissal, rapid outside
taps, update and resize checks remain in the same acceptance sequence. All four
configurations complete with no script diagnostics. This checks bar fills and
label redraw, not every antialiased pixel of the whole chart.

The independent same-font Chromium 153 corpus covers 57 ink/metric cases at each
of two viewports, within 1/4096 CSS px. Android 16 acceptance covers 20 actual
platform-font cases, including Latin/CJK, bold/italic, ligatures, combining
accents, fractional size and baseline changes. Widths match TextPainter within
0.02 px. Native raster edges are compared at 4x resolution within 1.1 CSS px;
low-resolution hinting can move individual raster edges, so this is not a claim
of pixel-identical text at every device scale.

Complete outlines cost more than the old width-only copies. This emulator's
representative document transfers 58,325,348 unique font bytes across 20 matched
resources, starts in 1,279 ms, and spends 122 ms on its 20 metric/draw cases. WASM
linear-buffer capacity starts at 64 MiB and grows to 128 MiB after ink reads.
These are one emulator run's measurements, not whole-app resident memory or a
physical-device performance guarantee. Collection now allows 64 MiB of unique
font bytes; the existing 128 MiB isolate heap and two-second guest evaluation
limit are unchanged. Font preparation still fails explicitly above its bound;
low-memory/multiple-document behavior needs physical-device acceptance.

This round passed 573 JavaScript tests, 71 targeted Flutter tests, the native
20-case text/pixel test, four Chart.js configurations, 28 local-HTTP layout cases,
static analysis and formatting. Source, compact browser references and capture
tools stay in Git; detailed acceptance evidence and disposable outputs stay
ignored. Remaining font/API differences are listed in the text-metrics section
above. Production signing, real-device/account and remote-push acceptance remain
open; no release APK or backend API was changed by this round.

## Percentage Canvas sizing and responsive compatibility audit

A native frame can now prove bitmap-size independence for a canvas with authored
percentage width and fixed pixel height in ordinary block flow, with a directly
sized pixel-width parent. The CSS dependency gate still excludes attribute
selectors, `attr()`, unresolved styles and unsupported CSS. Flex/grid/table,
shrink-to-fit, special native controls, fieldset, multicolumn, containment,
aspect-ratio, min/max/logical size and unsupported writing-mode paths do not get
this extension. No old rectangle is used to infer a new layout.

For this proved subset, adding the same computed `display`/`box-sizing` or
normalizing width/height to identical pixel values no longer discards geometry.
The metadata requires a real measured box and exactly representable serialized
dimensions; rounding a fractional width never proves equality. Removing or
changing other declarations, reordering existing shorthand/longhand pairs,
transient size changes restored within one mutation batch, ancestor writes and
actual size/display changes still require a new native frame. Public DOM
mutation records and canvas bitmap/context resets retain their normal behavior.

The new pinned Chromium 153 reference runs the same stock Chart.js 4.5.1 driver
and authored HTML in 16 cases (four sizing modes, phone/tablet, DPR 1/3), with no
external requests or page errors. Native acceptance distinguishes these results:

| Authored sizing                                           | Native initialization                                                                                                 | Container-only +20 px resize                                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `width:100%`, pixel height, block/border-box author reset | Four cases match geometry and actual painted bars without diagnostics; default 300×150 backing attributes are allowed | Final geometry and paint match, but Chart's same-callback parent read still produces stale/unavailable-layout diagnostics: not fully accepted |
| Explicit pixel sizes, initial inline display              | Still requires synchronous layout after Chart changes display                                                         | Not accepted                                                                                                                                  |
| Percentage width/pixel height, initial inline display     | Same initialization gap                                                                                               | Not accepted                                                                                                                                  |
| Container size only, no canvas CSS dimensions             | Intrinsic size and display changes still require synchronous layout                                                   | Not accepted                                                                                                                                  |

The audit retains the layout errors and the final successful resize
state. It does not convert those errors into a claimed responsive pass. General
synchronous DOM write/read support and unrestricted Chart initialization remain
priority gaps. Existing four fixed-pixel chart cases still require clean
initialization, touch/legend/update/resize behavior and painted pixels.

The Android font acceptance now includes a combined `中文🙂` string: all 21 cases
match same-font widths and native raster bounds. This emulator collected
61,138,412 unique font bytes across 24 resources, below the existing 64 MiB
collection bound; no font loading policy changed. This does not resolve physical
device memory/performance, production signing, account or remote push acceptance.

Verification for this follow-up: 578 JavaScript regressions, 93 targeted Flutter
tests, the 21-case native font/pixel test, the four existing clean chart
configurations and 28 native HTTP layout cases pass. The separate 16-case sizing
audit records four accepted initializations with an early-resize-read gap and
12 unsupported initializations; those recorded gaps are not conformance passes.
Static analysis and formatting pass. Compact evidence stays in ignored build
output; disposable builds and emulator disk images are cleaned after testing.

## Animation frame callback checkpoints

Native frame callbacks now return control to the host individually. The engine
runs Promise jobs before the next selected callback; the host reads a fresh VM
snapshot and measures genuine DOM changes with Flutter before continuing.
Callbacks selected for one frame retain the same timestamp and order. Cancelled
handles are skipped, and callbacks added during a frame wait for the next frame.
The final callback's Promise/layout checkpoint precedes ResizeObserver delivery.
Timers cannot replace a paused frame. Existing lifecycle and task budgets still
suspend and resume the owned continuation without replaying its first callback.
A task-budget checkpoint yields Flutter/UI work while retaining the same guest
operation; queued clicks wait until the selected frame callbacks finish. A
140-step host regression queues a click at step 128 and verifies it runs only
after step 140.

A separate dedicated Chromium 153 capture and native fetched-document acceptance
cover eight combinations of phone/tablet, DPR 1/3 and light/dark theme. The same
original HTML verifies Promise ordering, cancellation, nested-frame selection,
equal/advancing frame timestamps and real 100 → 160 → 180 px native widths.
The capture makes no external requests. JS regressions cover error recovery,
missing measurements, callback selection and observer ordering; host tests cover
post-result Promise mutations, detach/resume and the task-budget yield.

This does not provide synchronous layout in the middle of a single JS callback.
The responsive chart audit still records 12 initialization failures and four
initialization-only passes with a stock resize-callback error. Chart.js's resize
RAF callback reads its parent clientWidth, changes canvas CSS/backing sizes, then
reads parent clientWidth again before returning. The second read still requires
synchronous layout. The later cross-callback probe now succeeds, but this does
not turn the stock callback error into full responsive acceptance. The existing
four fixed-pixel chart configurations remain required to finish without errors.

Verification: 583 JavaScript cases, 104 distinct targeted Flutter cases (including
three host lifecycle/budget cases), eight new native frame cases, four existing
clean chart configurations and 28 native HTTP layout cases pass. The separate
16-case chart sizing audit still records its initialization and stock callback
gaps; these remain failed parity requirements. Static analysis and formatting
pass. Compact evidence remains ignored; disposable test and emulator output is
removed while keeping the published preview APK unchanged.

## Parent width reads after descendant resizing

A completed native frame can now prove that an ordinary fixed-pixel-width HTML
block's `clientWidth` is independent of descendant sizes. The runtime retains only
that measured metric after connected strict descendants change width/height
styles or canvas/image backing attributes. The proof excludes attribute-dependent
or uninspectable CSS, intrinsic/special/flex/grid/positioned ancestor sizing,
min/max/logical sizes, percentage padding, mixed overflow and scrollbar layouts.
Self/ancestor/sibling writes, removals, reordered declarations, class/text/child
changes and explicit layout invalidation still fence the snapshot. Rectangles,
heights, descendant geometry and computed styles still require a matching native
frame; no new dimensions are inferred from an old rectangle. Canvas backing
writes continue to clear bitmap and context state.

The common `border` shorthand also resets all five border-image longhands through
the cascade with normal specificity/order/importance; side-specific shorthands
preserve them. CSS-wide keywords retain explicit existing diagnostics. This
removes the previous partial-reset diagnostic for ordinary numeric borders,
without claiming border-image painting or wider CSS-wide computation support.

This supersedes the earlier chart resize gap: all four percentage-width/pixel-
height cases with authored block/border-box now require clean stock Chart.js
initialization, early/settled container-only resize, measured geometry and actual
paint. The 12 other responsive initialization cases remain explicit failures;
general synchronous write/read layout is still open. A separate 32-case pinned
Chromium/native corpus checks plain/nested blocks and content-box/border-box on
phone/tablet, DPR 1/3 and light/dark, including immediate parent-width reads and
next-frame parent/child rectangles.

Verification: all 598 JavaScript and 182 targeted Flutter regressions pass; the
32-case generic native corpus, eight native frame cases, four fixed chart configurations, four responsive
chart configurations and 28 HTTP layout cases pass. The separate chart audit
still records 12 unsupported initializations. Flutter regression tests, static
analysis and formatting are clean. Browser recapture reproduces identical bytes.
Evidence stays in ignored build output; disposable test/emulator output is
removed after verification while preserving the released preview APK.

## Synchronous unchanged-size Canvas box styles

The native cascade now supplies a proof for edgeless Canvas boxes whose pixel
sizes, or percentage width under a fixed-width ordinary block, are independent of
bitmap attributes. With no important width/height/display/box-sizing declarations,
attribute dependencies or scrollbar ancestors, the runtime can update live
computed `display` and `box-sizing` during inline/block switches and same-size
pixel normalization. Width and height remain the exact native measured values;
this does not compute a new layout or substitute an old child rectangle.

Only a fixed-width/fixed-height ordinary parent whose sole element child is that
zero-margin Canvas can retain its bounding rectangle and computed style during
these changes. Child positions, offsets, scrolling data and unrelated ancestors
still need a new frame. Other style/DOM mutations, declaration removals/reordering,
transient real size changes and explicit invalidation revoke the proof until
native layout. Canvas bitmap resets and public mutation records remain intact.
CSS `!important`, edges, intrinsic/min/max/logical sizing and scrollbar layouts
are rejected rather than approximated.

This supersedes the earlier 12 responsive initialization failures: eight more
original Chart.js cases (pixel or percentage sizes with initial inline display)
now require clean initialization and container resizing. Together with the prior
four author-reset cases, 12 responsive configurations match native geometry,
early/settled resize and actual paint. The four container-only/intrinsic cases
remain unsupported; unrestricted synchronous layout remains open.

A separate 32-case Chromium 153/native corpus covers phone/tablet, DPR 1/3,
light/dark, pixel/percentage sizing, inline/block switches and same-batch property
restoration. Synchronous styles and parent geometry are exact. The next-frame
inline child's platform-font baseline has a recorded tolerance of 0.1 px; other
coordinates and all dimensions remain exact. This small visual difference is
explicitly deferred under the user's existing guidance, not counted as identical
pixels. Other physical-device, account, push and distribution gates remain open.

Verification: 613 JavaScript and 183 targeted Flutter regressions pass, with clean
analysis and formatting. Native acceptance passes the new 32 style cases, the
prior 32 parent-width cases, eight frame cases, 28 HTTP layout cases, four fixed
chart configurations and 12 responsive chart configurations. The separate audit
records four unsupported intrinsic initializations. Maximum recorded inline
baseline difference is 0.09375 px. Compact evidence remains ignored; disposable
builds/emulator disk images are removed while preserving the released preview APK.

## Intrinsic Canvas sizing and synchronous used dimensions

The runtime can now calculate edgeless, zero-margin Canvas used width/height
from `auto`, numeric pixels, percentages or zero, using the real measured content
box of its fixed-pixel parent and the Canvas's current natural bitmap axes.
The packet builder first requires this calculation to agree with the actual
native measurement. Bitmap writes still reset drawing state; switching a fixed
CSS axis to auto immediately restores its dependence on bitmap dimensions.
The same natural-size formula drives Flutter painting and intrinsic layout,
including the no-aspect-ratio case where a natural axis is zero.

Inline Canvas percentage heights now use the native definite containing-block
height instead of the HTML core's intrinsic-height fallback. Existing natural
inline Canvas layout remains on its established path. A single-child block flow
now permits the same natural vertical overflow as the multi-child path; a fixed
parent height no longer silently compresses an auto-height block Canvas.

Size-changing projection requires a first-flow, left-anchored LTR ancestor path
with fixed pixel edges, no earlier rendered siblings/text and no transforms or
percentage relative offsets. Auto margins, percentage padding, RTL and preceding
wrapping text withhold this proof: a new classic root scrollbar can change those
positions/bases even when the direct parent has fixed width and height. Other
styles, important overrides, attribute-dependent CSS and scrollbar/intrinsic
ancestors also retain the remeasurement fence. The numeric projection surface is
bounded to 1,000,000 CSS pixels per axis; calc/var and declaration removal are
not projected. Canvas bitmap/drawing limits remain separately enforced.

The synchronous result certifies only the supported live computed styles and
its proved fixed parent's old rectangle while root scroll offsets are zero.
A scrolled root withholds that parent rectangle because changed overflow can
clamp scrolling even when local edges stay fixed. It does not certify a changed Canvas
rectangle, offsets, scroll extents or general synchronous native layout.

A separate Chromium 153 corpus records 72 cases (nine modes, phone/tablet,
DPR 1/3, light/dark), including every immediate style read and every following
native-frame rectangle, not only the final size. One fractional-ratio mode
allows a named 0.02 CSS-pixel browser-layout quantization difference; other
values remain exact. Capture uses only the dedicated test browser and blocks
all external requests. The existing Chart.js HTML, library and driver remain
unchanged; the native chart gate now requires all 16 responsive configurations.

Verification: 631 JavaScript tests, 285 targeted Flutter regressions and all
192 native comparison cases pass, with clean analysis and formatting. These
include 72 new Canvas cases, 4 fixed charts, all 16 responsive charts (closing
the prior four intrinsic initialization failures), 32 box-style cases, 32 parent
width cases, 28 HTTP cases and 8 frame cases. The recorded fractional-ratio
maximum is 0.013549 px within its named 0.02 px bound. Compact acceptance records
remain ignored; disposable builds and emulator images are cleared while the
published APK is preserved. General synchronous layout, broader chart/touch
compatibility and real-device/account/remote-push acceptance remain open.

## Stock chart types and nonfinite path arguments

The stock-chart gate now exercises all eight Chart.js 4.5.1 types: bar, line,
pie, doughnut, scatter, bubble, radar and polar area. Its 64 cases combine
phone/tablet, DPR 1/3 and light/dark. Browser and native clients receive the exact
same authored HTML and driver, with the unmodified pinned library and stock
legend/tooltip behavior. Every case requires initialization, first/second data
hits, outside dismissal, legend hide/show, data updates and container resizing.
The fixture capture verifies that hits and resizing actually happened and that
legend toggles remove and restore painted features.

This exposed a real native pie initialization failure: the Canvas recorder
threw on nonfinite arc arguments. Path methods now follow unrestricted-number
conversion and ignore the whole path operation when any numeric argument is
nonfinite. Missing required arguments and user conversion errors still throw;
finite negative radii still fail. Finite coordinate/path/recording limits remain
enforced. The change covers moveTo, lineTo, rect, quadraticCurveTo,
bezierCurveTo, arc and ellipse, rather than patching the chart library. See the
[HTML Canvas path algorithms](https://html.spec.whatwg.org/multipage/canvas.html#dom-context-2d-arc).
A separate 129-case Chromium observation matrix checks errors, conversion order
and unchanged pixels; recorder regression checks also require the original path
and drawing state to survive unchanged.

Native acceptance compares real Flutter snapshots and painting, including
negative-space probes, doughnut holes and actual line connections. Tooltip text
must reach the painter; values, visibility, active indices, click callbacks,
Canvas CSS/bitmap dimensions and probe colors remain independent checks.
The stock fonts retain the existing platform-alias limitation: pixel geometry
uses the prior bar gate's 2 px bound, with every difference over 0.1 px recorded.
Angles have their own 1e-12-radian bound; numeric data and Canvas dimensions are
not covered by the font tolerance. This does not claim identical fonts or whole
chart-image pixels. Animation, custom plugins/configurations and other chart
libraries remain separate acceptance work.

The retained first-point sample in a hidden radar chart crosses a neutral tick
backdrop edge: desktop `[248,248,248,196]` versus native `[244,244,244,200]` in
the first observed profile. This named antialiasing difference has an 8 × DPR / 255
per-channel bound (4 observed at DPR 1, 10 at DPR 3); both must remain neutral, while the data hide/show and all
other sampled colors remain independently checked.

Tooltip interiors composited over data have a separate 1/255-per-channel rounding
allowance (observed polar-area `[6,40,19,255]` versus `[7,39,19,255]`). This
applies only at samples at least 8 CSS px inside the tooltip background; solid
data, transparent holes and clear-space samples keep their exact checks.

Verification: all 648 JavaScript tests and all 64 native profiles pass, including
512 chart stages and 56 painted line-connection checks. All profiles have empty
script diagnostics. The 129 Chromium path observations agree with the recorder;
analysis and formatting are clean. Actual maximum differences by chart type:

| Type      | Profiles | Pixel geometry (CSS px) | Neutral edge channel delta | Tooltip channel delta |
| --------- | -------: | ----------------------: | -------------------------: | --------------------: |
| bar       |        8 |                0.977539 |                          0 |                     0 |
| line      |        8 |                0.977539 |                          0 |                     0 |
| pie       |        8 |                0.977539 |                          0 |                     0 |
| doughnut  |        8 |                0.977539 |                          0 |                     0 |
| scatter   |        8 |                0.304138 |                          0 |                     0 |
| bubble    |        8 |                1.360138 |                          0 |                     0 |
| radar     |        8 |                0.977539 |                         10 |                     0 |
| polarArea |        8 |                0.977539 |                          0 |                     1 |

All recorded angle differences are zero. Other selected color samples are
exact. This closes the stock-type initialization/interaction gap for these
configurations. The next gate covers default animation; custom
configurations/plugins, arbitrary framework layout and
physical-device/real-account/remote-push acceptance remain open. Compact evidence stays ignored; disposable builds/emulator disk images are
removed while preserving the published APK.

## Native default chart animation follow-up

The default-animation gate uses the original Chart.js 4.5.1 duration/easing and
ordinary `chart.update()`. Monitoring callbacks record progress/completion but
do not replace the clock, shorten animations or set `animation:false`. Its
64 profiles retain all eight chart types, phone/tablet, DPR 1/3 and light/dark,
with initial/data updates, point hits, tooltips, outside dismissal, legend
hide/show and resizing. Final values, poses, Canvas dimensions and selected
colors are compared to the pinned browser fixture. Completion callback counts
must match the browser.

Canvas now owns a repaint boundary. Changed snapshots repaint the Canvas layer
without repainting a static parent. The shared native chart paint check now
captures that actual widget layer at backing density. Default-animation tests
also capture active intermediate layers and require a different painted result
before completion; this checks visible updates alongside progress callbacks.
Sampling starts at the first available active frame because a hiding line can
leave the viewport early in its 1,000 ms numeric transition.

A first data point can already equal the scale's reset baseline in a line,
scatter or radar chart. The gate follows that browser observation while still
requiring the full native layer to change. Initial/data progress must be
monotone, have multiple callbacks, finish at the reported last step and complete
within the integration timing budget. Stock fonts retain the existing named
pixel-geometry/color differences. Frame counts and elapsed times are recorded
under the harness rather than claimed as identical browser/App cadence.

The driver accumulates progress since the latest Canvas pointer-down or explicit
data/resize operation. An outside-dismissal summary can therefore include the
previous interaction plus the new fade; its overall step sequence is not a
single monotone run. Initial/data runs have fresh counters. Volatile readiness
serials and frame counts are not compared as UI state, but user click callback
contents and animation completion counts remain required matches.

Animation interruption/retargeting, background/visibility lifecycle and physical
device smoothness remain separate acceptance work, alongside custom chart
configurations/plugins, other libraries and the broader native layout gaps.

Verification: all 64 native profiles and 512 operations pass with actual widget
layer capture; 652 JavaScript checks and 66 Flutter repaint/sizing/layout tests
pass, and static analysis is clean. All final angle differences are zero; the
largest final pixel-geometry difference is 1.360138 CSS px from stock font aliases,
within the previously recorded bound. Every completion count matches Chromium.

Under this instrumented integration harness, initial/data runs have 6–7 native
progress callbacks and finish in 1,216–1,459 ms; the frozen browser has about
60–63 callbacks. Native sampling pumps in 50 ms increments and captures actual
layers, so these counts do not establish normal device FPS. This remains a
performance acceptance gap, not a claim of matching smoothness. Initial/data
runs and all six other operation stages retain their reported callback/elapsed
ranges in ignored compact evidence. Disposable builds and emulator disk images
are removed after the run; the published APK is retained.

## Native document visibility lifecycle follow-up

The shipped runtime exposes read-only `document.hidden` and `visibilityState`
before page scripts execute, plus `document.onvisibilitychange`. Host changes
produce trusted, bubbling, noncancelable/noncomposed events at Document with
Window capture/bubble propagation. The existing event path preserves once,
abort, removal, handler replacement, exception isolation and Promise work.
The event flags follow the [HTML visibility algorithm](https://html.spec.whatwg.org/multipage/interaction.html#page-visibility).

Visibility combines document attachment, the active window's TickerMode and app
visibility. An inactive but still visible app is not reported hidden; hidden,
paused and detached app states are. The prior foreground-only scheduler still
suspends in inactive state; an ordinary visible but unfocused browser page may
continue animation, so this scheduling difference remains explicit.

Lifecycle notifications share the serialized VM queue and retain rapid edges,
including changes while initialization or another visibility evaluation is in
flight. They commit event/Promise effects without draining timers, native
animation continuations, parser Scripts or native layout. Normal resume then
services the retained work. A hidden window previously could finish already
selected native frame callbacks; it now suspends that batch and resumes once
without selecting a replacement frame.

The pinned Chromium 153 fixture proves initial read-only properties and synthetic
event propagation only. The dedicated Headless Shell stayed visible during
attempted background/window-state changes, so it does not establish real browser
background event delivery. Runtime/host tests verify the host-driven hidden and
visible transitions separately. Physical phone/tablet OS transitions, process
freeze/death, chart retarget/interruption, inactive-state scheduling and actual
smoothness remain open; broader native layout gaps are unchanged.

Verification: 657 JavaScript checks and 127 affected Flutter host/view tests pass;
static analysis and formatting are clean. All eight Android profiles (two
viewports, DPR 1/3, light/dark) pass through the real Android JS engine and
Flutter document view. TickerMode changes and simulated AppLifecycleState
notifications produce the exact hidden/visible event and Promise order; frame
counters remain unchanged during each hidden interval and increase on resume.
These are simulated lifecycle notifications, not physical OS background tests.
Compact results are kept ignored; disposable outputs are removed after testing.

## Native absolute positioning follow-up

The native renderer extracts accepted absolute elements from normal flow and
attaches them to their nearest supported relative/absolute block containing box.
An element without a positioned ancestor uses the initial viewport. Layout uses
the containing padding box and actual published border geometry; it never reads
a grandchild RenderBox.size illegally during an ancestor's layout. Absolute
children do not enlarge the normal-flow size or add flex/grid gaps. Geometry,
painting, inherited direction and hit transforms follow the relocated widget.

Accepted physical axes need at least one non-auto inset each. Signed px and
percentage insets, em/pt and the existing vw/vh/vmin/vmax forms are accepted;
auto widths can shrink to content, opposing insets stretch auto axes, CSS min/max
and content-/border-box edge conversion constrain the result. Fixed/percentage
and auto margins use the containing width. RTL resolves overconstrained
horizontal axes from the right. Inline, image and Canvas replacements build a
complete native CSS box before relocation. Nonnegative local sibling z-indices
and equal-index source order determine paint/hit order.

The document root routes visible positioned overflow to its actual widget even
outside a short normal-flow root, while real ancestor clips still gate hits.
Normal inline overflow retains its previous root-bounds gate. A separate common
bug was found and fixed: empty clickable blocks had a zero-sized inner gesture
surface; the gesture now wraps the actual border box inside relative motion and
outside its size/decoration, without covering margins. Nested click dispatch
continues to fire once.

Remaining positioning work is explicit: both-auto axes need real static-position
markers; inline containing blocks, positioned scroll/clipping containers,
transforms/containment, logical insets, nonzero rem/calc and other unsupported
lengths, negative z-index and complex nested stacking contexts remain open.
Unsupported absolute declarations retain the previous flow fallback, so those
cases do not have positional parity. offsetParent/offsetLeft/offsetTop for
positioned subtrees remain withheld; native getBoundingClientRect is measured.
Owned element scrollWidth/scrollHeight do not yet include relocated positioned
overflow. Root scroll-overflow integration and physical-device behavior still
need wider acceptance. Viewport-fixed positioning is covered by the follow-up below; sticky remains open.

The frozen Chromium fixture compares phone/tablet, DPR 1/3 and light/dark,
including actual screenshot samples and elementFromPoint targets. The native
widget gate checks geometry plus those exact solid-color pixels and taps each
sample, including a portion outside the positioned ancestor's border. Percentage
geometry retains Chromium's 1/64 px quantization difference: isolated percentage
terms differ by up to 0.0125 CSS px; the content-box percentage-padding case keeps a separate 1/32 CSS px bound
for accumulated per-edge quantization. These are named case bounds, not a
general geometry tolerance.
The Android gate uses the shipped JS engine and document view, real click
handlers, requestAnimationFrame measurement and CSS mutation; it checks that
position/size update without moving other flow boxes. Broader state transitions
and layout APIs are not implied by these gates.

A prior relative-scroll test failed unchanged at HEAD: its 80 × 20 CSS px serif
link used normal line height and wrapped text. Android measured 248 px scroll
height, Chromium 153 measured 236 px, and the test incorrectly expected 220 px.
The positioning gate now authors 20 px line-height and nowrap so it isolates
positioned overflow and clipping; default serif font/wrapping/normal-line-height
parity remains a named difference rather than being claimed repaired here.
A separate mixed inline fixture verifies that extracting an absolute element
leaves no block bit or extra line between neighboring inline images.

A containing-block resize can change percentage edges while the absolute
border-box constraints stay identical. A regression reproduces stale 10% padding
when only its flow child changes width; the layer now invalidates the existing
positioned subtree at that basis change. The same widget grows and shrinks with
correct padding without requiring a document rebuild.

Verification: all 168 frozen widget profiles pass geometry, 672 actual solid
pixel probes and 672 native taps. The affected layout/interaction regression run
has 629 passing tests; all 659 JavaScript tests pass. All 48 Android profiles pass
initial measurements plus real click-driven position/size updates and unchanged
flow neighbors on the final implementation. Static analysis and formatting are
clean. Compact evidence is ignored; generated builds, owned emulator images and
the isolated HEAD comparison copy are removed after the run, preserving the
published APK.

The pointer-events overlay gap identified by this positioning gate is addressed
by the native pointer policy gate below. Vertical writing modes and
grid-area-based absolute containing boxes remain unverified.

Final Android maximum initial geometry delta is 0.0125 CSS px in the percentage
case; the remaining selected cases are exact. The controlled relative-scroll
reference also confirms 220 px scroll height and a reachable link after scroll.

## Native HTML pointer policy

The native renderer now resolves inherited `pointer-events:auto/none`, explicit
child restoration, `initial`/`inherit`/`unset`, CSS variables and invalid declaration
fallback. Disabled surfaces remain painted; pointer hits can reach the underlying
box. Restored native buttons, Canvas and ordinary blocks retain their gesture
ancestors. The Android gate also exposed fixed button widths being compressed by
the core intrinsic wrapper: raw inline-block buttons now use native sizing, and
both widget and Android gates assert the actual authored 90 × 40 border box.
Restored text uses recognizer metadata and real text fragment bounds,
without converting text to atomic widget spans or changing line breaking.

Restoration checks actual scrolling and rounded/path clips. Visible relative
child overflow can still receive input outside an absolute ancestor's border;
local positioned paint order decides which enabled surface wins. Dynamic style
changes rebuild the policy, while click events from a restored child still bubble
through a pointer-inert parent. Pointer policy does not disable programmatic
`click()` or keyboard focus. A native text-field regression verifies rejected
touch focus plus preserved programmatic focus and text input.

The frozen Chromium 153 fixture contains 176 cases across phone/tablet, DPR 1/3
and light/dark. It captures real touch hit targets, cumulative click traces,
computed pointer policy and solid paint samples with all network requests
blocked. Widget tests compare actual native hit targets and paint; Android
integration uses the same unmodified browser driver in JavaScriptSandbox.
The latter covers none, restored block/inline/button/Canvas, inline suppression,
clipped and visible overflow, dynamic none/auto/none and programmatic activation.
The programmatic click and its final computed-style report now run immediately,
identically in both environments. The ordinary-text cascade-value proof below
repairs the previously recorded stale pointer-events read after report text
changes. Geometry and unproved style mutations retain their separate fences.

This gate covers HTML box policy. SVG shape-specific fill/stroke hit geometry,
complex nested stacking contexts, hover, pointer capture and policy changes
mid-gesture remain outside this acceptance. Inline computed-style/fragment APIs
still need their own native measurements. Positioned clipping containers and
scroll/offset metrics retain the separate limitations listed above; this policy
change does not certify those layout features.

Verification: 943 affected Flutter layout/control/style tests and all 663
JavaScript tests pass. All 88 Android profiles pass the frozen driver state after
every step, including exact restored button bounds; diagnostics stay empty.
Static analysis is clean. Compact acceptance evidence is ignored; disposable
builds and emulator images are removed after testing, preserving the published APK.


## Computed styles after ordinary text updates

The native cascade certifies text-independent selectors only when the complete
parsed stylesheet/inline set is understood and contains no `:empty`/`:blank` dependency,
including nested negation. Unsupported selectors/rules, retained imports, parse
errors and unresolved values withhold this proof. Attribute and structural
selectors may qualify because the runtime separately rejects element/attribute
changes.

After plain text replacement, character-data writes, text-node insertion/removal
or replaceChildren with text, certified cascade values remain synchronously
readable: colors, typography, display/pointer policy and supplied custom properties.
Retained declarations and property enumeration stay live. Width, height, edges,
rectangles and other measured geometry still require a matching native frame;
no old rectangle is returned as a new layout result.

The runtime keeps a full fence for mixed element/attribute/style changes,
stylesheet/script/title text, text in form value containers, SVG text and
automatic-direction content. Native metadata names only values computed without
layout, is validated against the supplied declaration and shares its size budget.
Missing proof or rejected packets do not weaken invalidation.

The 48 frozen Chromium profiles use the same driver on Android for visible and
hidden replacements, character data, append, remove and replaceChildren. They
compare immediate cascade values and next-frame actual geometry at phone/tablet,
DPR 1/3 and light/dark. The 88 pointer profiles restore the original immediate
programmatic report rather than waiting for a frame. The Node regression covers
mixed/special mutations, missing proof, retained declarations and atomic rejection.
General synchronous write/read layout, selector-dependent text and the other
remaining layout/library/physical-device gates stay open.

Verification: 961 affected Flutter tests, all 694 JavaScript tests and all
136 Android profiles pass on the final implementation, with empty script
diagnostics. Format and static analysis are clean. Source/fixture driver identity
is checked, and capture blocks all external requests. Compact local evidence is
ignored; disposable builds and owned emulator images are removed after testing.


## Viewport-fixed HTML positioning

Full fetched documents now own an explicit native viewport outside the root
Scrollable. Fixed elements use that viewport through ordinary positioned,
clipping and scrolling ancestors. Their actual layout/DOM ancestry stays intact;
painting and hit testing share the viewport transform and root z/source order.
Root fixed and absolute entries compete in the same order. Local absolute
children use the fixed box as their containing block. Fixed subtrees do not
inflate scroll extents, including when a bottom control lies below a short flow
root. Dynamic hide/show and viewport resize update the same document.

The gate checks native buttons with authored and UA-default edges, Canvas,
pointer-events pass-through, nested scrolling, escaped overflow clips and
position/size changes. Empty transparent surfaces keep their own mapped DOM hit
identity rather than falling back to body. Gesture measurement order is corrected
without expanding element geometry. Positioned buttons retain their native
activation/focus widget and use UA border-box/padding/border defaults.

Native scroll requests are now published at the layout checkpoint before RAF
callbacks/continuations. Their one-shot payload is consumed once; a fresh native
packet acknowledges the actual position. A callback and its Promise scrollBy
compose in order. Hidden/detached documents cancel old requests; resuming does not
replay them. Immediate same-callback scroll/geometry reads are still asynchronous
relative to the native UI, and smooth-scroll timing still follows Flutter.

The frozen Chromium 153 reference contains 120 phone/tablet × DPR 1/3 × light/dark
profiles and 368 states, including actual pixels and elementFromPoint targets.
The widget gate uses matching scroll offsets, verifies real inner scrollTop,
checks fixed paint/taps and all measured boxes, and does not rebuild the document
for a scroll-only state. The Android gate runs the same driver through
JavaScriptSandbox and real native controls. Percentage/padding geometry keeps a
named 1/32 CSS px accumulated browser-quantization bound; other boxes use 0.01 px.

**Resolved in the root anchoring follow-up below:** the initial implementation
kept scrollY at 180 when a 120 px flow block appeared above the viewport; Chromium
changed it to 300. The follow-up removes the eight hidden_dynamic allowances and
compares their actual viewport boxes and native scroll offset with the unchanged
browser reference, using the same strict gate as the other profiles.

Other remaining positioning work: transformed/filter/contain or other special
fixed containing blocks; intervening stacking contexts/opacity, nested fixed
contexts and negative z-index; hidden-visibility/clip-path/mask composition;
both-auto static-position axes; unsupported rem/calc/logical insets; positioned
offset APIs and wider scroll metrics; sticky. Unsupported cases retain the
existing flow fallback and do not have positioning parity. Physical device
keyboard/rotation/background acceptance remains separate.


Initial verification, before the root anchoring follow-up: 1,215 affected Flutter
tests and all 697 JavaScript tests pass; static analysis is clean. The Android gate evaluates all 120 profiles: 112 have
complete viewport agreement, and eight retain the named root-scroll-anchoring
difference above. Their fixed overlays and document-space geometry pass; the raw
120 px viewport difference is retained. Maximum matching geometry delta is
0.009375 CSS px. Two additional synthetic Android scenarios pass same-turn
scroll-owner resizing/replacement with real native controls and local HTTP.
Their diagnostic overlays now use pointer-events:none so fixed labels do not
obscure the controls. Compact ignored evidence records the original browser
fixture and source hashes; disposable builds and owned emulator images are
removed after testing, preserving the published APK.


## Root scroll anchoring

Scripted full documents now keep a DOM anchor from the last completed native
frame. The selection uses measured flow boxes and their actual DOM ordering:
fully visible boxes can be selected directly; partially visible containers search
their descendants. Fixed/sticky subtrees and overflow-anchor:none exclusions do
not become anchors. User/programmatic scrolling selects afresh against retained
document-space geometry. Selection does not rescan native surfaces on each drag.

When the anchor disappears, surviving nodes are selected at their previous-frame
positions before computing their new offset. This preserves the browser's
phone/tablet distinction when a replacement was visible only on the larger
viewport. Offset deltas are clamped to actual native scroll limits. Authored
geometry changes along the anchor's ancestor path, out-of-flow position changes,
zero offsets and changed viewport dimensions fence compensation. Native layout
must be settled, uniquely owned and current; provisional margin layout does not
replace the previous anchor snapshot. Scroll corrections retain drag/ballistic
activities. Script layout publication waits for the corrected frame to paint.

The Chromium 153 corpus contains 18 behaviors × phone/tablet × DPR 1/3 × light/dark
(144 profiles, 576 states). It covers expansion/shrink, insertion/removal, changes
below the viewport, nested partial/fully visible candidates, removed anchors,
anchor/ancestor geometry suppression, root/subtree exclusions, the page top,
scrollTo/scrollBy and end-of-document clamping. Widget checks compare every box,
scroll offset/extent and an actual solid-color screen pixel at each step. Android
checks use identical source/driver bytes through the production JS sandbox and
native Advance button. The previously frozen fixed-position driver is also run
with its root-anchor exception removed. Selection/suppression semantics are
informed by the [CSS scroll anchoring draft](https://www.w3.org/TR/css-scroll-anchoring-1/);
the frozen browser's actual results remain the acceptance baseline.

Remaining anchoring boundaries: independent nested scroll-container anchoring,
non-scripted document/image-load identity, text-fragment and focused/find-match
priority candidates, scroll-padding/snap, RTL/vertical writing, overflowing and
out-of-flow candidate ordering, complex transformed containing blocks and
simultaneous programmatic smooth-scroll/DOM changes and fractional adjustment
quantization. These are not certified by the root-block corpus. Synchronous DOM
write/read layout retains its separate native-frame limitation. Physical keyboard/rotation/background acceptance remains
open.


Verification: 507 affected Flutter tests across 36 files and all 700 JavaScript
tests pass. Analysis and formatting are clean. All 144 Android anchor profiles
match every measured box and offset exactly; all 120 fixed-position profiles pass
strict viewport comparison, including the previous eight 120 px findings.
The fixed percentage cases retain their named bound (maximum delta 0.009375 CSS
px), with no root-anchor allowance. Two same-turn element-scroll mutation cases
and the existing native HTTP offset/style integration also pass. Test/browser
source identity and empty diagnostics are checked. Compact evidence is ignored;
disposable builds and the owned emulator images are cleaned while preserving the
published APK. The wider goal and the remaining gates above remain open.
