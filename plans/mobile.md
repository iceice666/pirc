# Mobile app follow-up work

[Plans](README.md) · [Build and test the app](../apps/android/README.md) · [Historical records](../docs/development/historical-records.md)

The Flutter Android app is the active client. Its native transport and tests live
under `apps/android/android`; there is no separate legacy UI module. iOS
transport is outside the agreed scope. Current features and reproducible test
entrypoints belong in the app README; completed integration and renderer diaries
are available from Git through Historical records, not repeated here.

## Remaining work, in priority order

- [ ] **Dynamic content compatibility:** wider synchronous DOM write/read layout,
      broader DOM APIs, Canvas font/ink coverage, inline-fragment measurements
      and common-library coverage. Broader image/framework flows remain
      unverified; preserve explicit unsupported errors.
- [ ] **Physical phone/tablet acceptance:** use a real account for pairing,
      streaming/cancel/reconnect, panels, management consent and simultaneous
      web/app confirmations. Check keyboard (including CJK IME), safe areas,
      rotation, background, low memory, OEM permissions/notifications, terminal
      HTTPS asset origin and a release build. Verify multi-line USER/delegation
      confirmation bodies and labels, PTC approval declines/rendering, browser
      takeover tap mapping/IME/drag scrolling and WebM playback.
- [ ] **Project deletion interruption acceptance:** controlled HTTP failures
      cover partial-deletion retry UI, but physical-device/network-interruption
      recovery is unverified. Keep real-account/provider subscription acceptance
      separate from synthetic management-consent tests.
- [ ] **Remote background push:** real relay/delivery remains unverified. The
      user declined third-party relay testing; do not run it without authorization.
- [ ] **Distribution decisions:** production signing and sideload-only versus
      F-Droid/Play; token rotation before the 30-day expiry versus monthly
      re-pairing, including the near-expiry warning (A7); native Context inspector
      later or never. Preview APKs use a separate application ID and local test
      key, not production signing.

## Deferred presentation and compatibility boundaries

The frozen visual corpus is web revision `bd3d909`. Small visual differences,
uncommon syntax and the legacy audit's fine-grained layout/style findings remain
deferred, not verified pixel parity. New 0.6.x features, including native project
files/deletion, are outside that corpus. Original audit IDs and file references
are at `git show 7677d24:plans/mobile-audit.md`.

### Native layout and geometry

- Signed/negative vertical and font-relative top margins, empty-block
  collapse-through and parent/bottom-edge margin collapse need wider support.
  Common nonnegative pixel/percentage parent/first-child top margins, including
  the previous percentage findings, are implemented; do not reopen those fixes.
- Percentage margin settling uses actual containing-block widths with at most
  eight native passes. Missing bases or nonconvergence withhold geometry packets
  and retain committed scroll dimensions. Arbitrary standalone dry/intrinsic
  queries at hypothetical widths and cyclic intrinsic sizing are not general
  browser sizing. Cyclic percentage/fractional intrinsic grid-track sizing also
  remains outside the tested subset; fixed auto-height grid rows are implemented.
- Basic `display:flow-root` sizing and the margin barrier are covered. Float
  placement/containment and negative percentage/auto flex margins are not.
- Relative positioning supports native block/flex/grid/flow-root surfaces,
  signed pixel/percentage physical insets and zero CSS length values. Nonzero
  font/viewport-relative units, `calc()`, logical insets and inline fragments
  remain unsupported. A parsed nonzero inline inset does not by itself gain
  offset metadata. Common absolute positioning and viewport-fixed overlays are
  implemented, including native hit targets. Common 2D transformed block
  containing blocks now support absolute/local fixed children, including
  identity transforms and dynamic ownership changes. Sticky positioning, zoom,
  table offsets and fragmented inline geometry remain open.
- General DOM writes followed immediately by geometry/style reads still need a
  matching native frame; stale, missing or ambiguous reads fail explicitly.
  Scroll-only rectangle reads now use actual native paint ancestry and affine
  matrices where proved. Native Canvas event callbacks have measured geometry
  for synchronous dispatch. A minimum height alone does not establish a definite
  height for percentage descendants.
- Common 2D `transform` functions and ordinary `transform-origin` paint and
  hit-test natively around the laid-out border box, including percentage
  translation and composed matrices. Containing blocks that own scrolling or
  clipping, general stacking/compositing between intermediate ancestors,
  inline/table/SVG containing blocks, 3D/perspective, individual transform
  properties, textual inline fragments, transform-box variants and transformed
  overflow extents remain outside the covered subset. Transformed CSSOM
  offset-parent/position reads still lack native offset specifications.
- The transformed-containing-block corpus has 136 Chromium 153 phone/tablet,
  DPR 1/3 and theme profiles, each checked before scrolling, after root/enclosing
  panel scrolling and after transform mutation. It covers static/relative and
  nested hosts, nearest-owner selection, identity transforms, percentage sizing,
  transformed children, Canvas and native buttons. Widget and Android Sandbox
  gates use the same sources and actual native clicks. Geometry allows 1/32 CSS
  px for subpixel rounding. Both compare two painted samples per profile;
  opaque pixels are exact. Android's 0.5 opacity RGB composition differs by at
  most one level (1/255), with exact alpha; widget opacity pixels are exact.
  Common block opacity now groups its positioned children too. Wider inline and
  replaced-element opacity, zero-opacity accessibility semantics, transitions
  and intermediate stacking groups remain unverified, rather than certified
  by this case.
- Two root-height fixtures retain extra trailing blank scroll space: 8 px with
  the default body margin and 17 px with nested content-box edges. Their element
  rectangles match Chromium; these scroll-extent differences remain deferred.
- Root horizontal scrolling, scrollend/Promise semantics, mixed window/element
  event order, RTL, scroll snap/anchoring and nested touch scroll chaining need
  wider coverage. Common vertical root and nested-container scroll anchoring are
  covered. Retained documents keep root/nested offsets through full view
  remounts and document switches; fresh responses start new nested positions.
  Smooth-scroll timing follows Flutter.

### Computed styles and scripts

- `getComputedStyle()` reads the native cascade and completed layout for a
  supported subset. Declarations are read-only and live across accepted frames;
  inline `element.style` remains independent. Enumeration is the supplied subset,
  not Chromium's full property list. Omitted recognized properties,
  pseudo-elements, stale frames and unavailable declarations fail explicitly.
- Common HTML 2D `transform` matrices and `transform-origin` now use the native
  transform parser and real untransformed border-box dimensions. Matrix values
  exclude the separately reported origin and preserve identity versus `none`.
  Hidden elements have no used transform and preserve percentage origins.
  Retained declarations update after accepted native layout, including class,
  size, transform and hidden-to-shown changes. An independent 128-profile
  Chromium 153 corpus covers phone/tablet, DPR 1/3, both themes, border/content
  boxes, Canvas, empty and hidden elements. Native widget and Android Sandbox
  gates check both states; styles compare exactly and rectangles use 0.001 CSS
  px tolerance. Unsupported reference boxes/font bases and missing measurements
  withhold affected values. This does not establish synchronous DOM write/read
  layout or full CSS transform inheritance, animation or SVG serialization.
- Inline-fragment and unmeasured list-item dimensions, auto margins, platform
  form-control UA properties, CSS font shorthand and unsupported length
  expressions remain outside this surface. The full browser
  `CSSStyleDeclaration` prototype/property surface is not implemented;
  custom-property names currently use the ASCII subset.
- Style limits: 256 properties, 128-character names, 4,096-character values and
  16 KiB of names/values per node; aggregate encoded style data is capped at
  2 MiB. Inheritance collection is bounded. Oversized/unavailable declarations
  are withheld whole, never truncated into apparently unset custom properties;
  geometry remains available.
- Generic native UA font-family names may differ from Chromium's resolved names
  (`serif` versus `Times`); custom-property comma whitespace normalization also
  differs. Default text/list fixture heights retain these measured boundaries
  at both viewport widths:

  | Element   | Native height | Chromium height |
  | --------- | ------------: | --------------: |
  | html      |     197.88 px |      184.875 px |
  | body      |     173.88 px |      152.875 px |
  | paragraph |         16 px |           18 px |
  | heading   |         32 px |           37 px |
  | list      |         16 px |           18 px |

  Native font metrics account for line-box differences; root/body also retain
  flow/margin differences. Native computed heights report actual native boxes.
  These boundaries do not exempt explicit block sizes, percentage edges,
  relative inset values or list content width from comparison.

- Some inserted classic-script lexical-scope behavior differs from browsers.
  Arbitrary websites/frameworks, third-party cookie policies and full browser API
  coverage are not guaranteed.

### Implemented interactive content

Native Canvas supports matched text measurement, intrinsic/pixel/percentage
sizing, container resizing, the eight stock Chart.js chart types and their default
animations. Covered bar interactions include touch tooltips, outside dismissal,
legend hide/show and redraw with real glyph ink bounds. MutationObserver handles
common live DOM changes, and animation callbacks receive current native geometry.
Document visibility suspends pending callbacks. These bounded gates do not certify
arbitrary chart configurations or frameworks; unsupported reads fail explicitly.

Root and nested vertical scroll anchoring use actual native clips and shared DOM
identity. Simultaneous root/outer/inner compensation, node replacement, hide/show,
style suppression and end clamping are covered. Text/focus/find priority,
RTL/horizontal writing, scroll snap/padding, complex transformed/out-of-flow
geometry, image-load identity and simultaneous smooth scrolling remain open.

Native root/element scroll commands now execute in their authored order. A
relative command uses actual current pixels, including after a smooth command;
instant-then-smooth retains the instant starting position. Same-position,
zero-delta, omitted-axis and empty-option commands cancel prior animations.
Native-frame scroll events still coalesce. The Chromium 153 command corpus has
160 phone/tablet, DPR and theme profiles; widget tests compare immediate native
positions and settled positions. Android checks immediate and settled JS readings
through the actual sandbox and native Run button.

**Scroll-position feedback:** root/element getters replay only unacknowledged
commands over actual native positions and programmatic ranges. Consecutive
`element.scrollTop += 20` calls now reach 40. Each accepted native packet names
its processed command prefix, so an older frame cannot erase newer commands or
replay an already consumed relative command. Native ranges include disabled axes
and clamping; smooth destinations are not treated as current positions. The
standards root uses viewport measurements even without a separate html box.
The additional Chromium 153 feedback corpus has 96 profiles for setters,
clamp-then-subtract, mixed methods, smooth cancellation, Promise jobs and RAF.
The position-feedback corpus compares 256 profiles, including aliases and
intermediate traces; the former 80 immediate-read mismatches are resolved.

`document.scrollingElement` and read-only `document.compatMode` are now supplied
for the active HTML document. Native startup passes the existing HTML parser's
initial mode, including valid strict/limited/quirks legacy doctypes. Guest
masking of `document.doctype` cannot change that mode. Standards roots and quirks
viewport-owning bodies use measured viewport positions, scroll extents and client
sizes. Quirks selection uses current native box/overflow evidence, including the
root-clip exception; absent or stale evidence is an explicit unsupported read.
Ownership queries inspect existing children and do not create a missing body.
The additional 88 Chromium 153 profiles cover 11 mode/overflow cases at phone and
tablet sizes, DPR 1/3 and both themes. The ownership/position corpus checks 344
profiles through the actual Sandbox and native Run button; rectangle coverage
extends the combined gate below.

This gate does not certify full quirks layout, inactive/DOMParser-created
Documents, XML/frameset documents, mixed-axis overflow normalization or mixed
viewport/body scroll routing. DOM doctype node removal and DocumentType ChildNode
helpers (including `.remove()`) remain unsupported by the vendored DOM; the mode
mutation test covers legal property masking, not successful node removal.

**Scroll-only rectangle feedback:** `getBoundingClientRect()` and
`getClientRects()` replay unacknowledged commands using real native paint
ancestors, measured scroll ranges and affine 2D coefficients. Root, nested and
combined scrolling, clamping, instant/smooth sequences, fixed/unrelated boxes
and actual Canvas taps are covered by 128 additional Chromium 153 profiles.
Canvas pointer rectangles are not reused after a pending script scroll. Native
2D transforms preserve the border-box origin and normal-flow allocation while
also transforming paint and hit tests. The combined Android gate covers 472
profiles; the original 344 remain exact comparisons, and the new rectangle
cases use at most 0.001 CSS px tolerance for affine floating-point differences.

Native proof includes every real owned scroll viewport, including visible or
zero-range wrappers, and stops at a proved viewport-fixed boundary. Metadata is
bounded to 64 scroll ancestors per box and 16,384 references per packet. Missing
or stale proof, sticky/unsupported positioning and nonaffine geometry retain
explicit errors. Browser expectations are captured independently, including
scroll displacement coefficients; native output does not generate them.

**Remaining synchronous layout differences:** general DOM writes followed by
geometry reads still need matching native measurement. CSS `scroll-behavior`
default selection, exact animation timing, scrollend/Promise behavior and mixed
root/element event ordering are not certified by this gate. Global getter
exception propagation during stale layout is not certified on Android; Node's VM
can return undefined instead of propagating the accessor error. These unsupported
reads are separate from the certified clean-layout scroll-position updates.

Retained-document scrolling is owned by the document/VM lifecycle, including
root offsets across a new PageStorage bucket. Switching the document in one view
creates a separate native scroll position. The Chromium 153 retention corpus
covers eight phone/tablet, DPR and theme profiles: same-document history restores
the root per entry in auto mode, keeps current nested offsets, and leaves the root
unchanged in manual mode. A reconstructed response starts nested offsets at zero.
Native workspace tests cover traversal, remounts and named-window refetch. A
workspace captures the current entry's latest root offset before unmounting,
including after scroll positions detach, so it cannot replay an obsolete fragment
or history snapshot. New fragment navigation while unmounted still takes effect.
The Android gate checks fresh JS reads and native controls after remount/switch,
plus the full workspace's retained-entry and offscreen-fragment paths.
Smooth-scroll interruption during remount and OS process-death restoration remain
outside this gate; physical-device/background acceptance remains open.

The latest dedicated local Android renderer gate covers 168 nested-anchor, 144
root-anchor and 120 fixed-position profiles against frozen Chromium 153 results.
Maximum box differences are 0.00625, 0 and 0.009375 CSS px respectively. Related
Flutter regressions and JavaScript fixture tests passed before the 0.7.0 merge;
this is bounded renderer evidence, not physical-device or full backend acceptance.
Reproduce through the committed integration tests and parity capture tools.

## Validation boundaries and separate backend findings

Local emulator/synthetic-model tests are evidence for covered code paths, not
physical-device, real-account/provider or remote-push acceptance. Android
integration uses the shipped JavaScriptSandbox runtime and native renderer;
production-path widget tests and dedicated Chromium references provide layout
coverage, not a complete browser engine. Capture only synthetic local HTML in a
dedicated test browser, never the user's everyday browser. Keep reference results
independent of native output; do not weaken assertions to erase findings.

The release-time SQLite WAL lock, Linux seccomp descriptor and PTC
heap-exhaustion failures were addressed by
[PR #4](https://github.com/iceice666/pirc/pull/4), not left as Android tasks.
OOPIF cases passed with dedicated Chrome for Testing 153.0.8010.47. The macOS
keyboard corpus still differs at step 14 by the active-focus marker; expectations
remain unchanged. This local platform finding is separate from Linux CI and the
Android client. Backend runtime checks do not establish arbitrary provider/runtime
workloads in the app.

At 0.6.1 release, the full Rust workspace gate was not green on the local host;
later fixes must not be represented as a rerun of that release gate. Linux
black-box conformance remains a CI check; full Nix package builds were not run
locally (dependency hashes/evaluation passed). Consult PR #4 and current CI for
backend/integration evidence rather than old test counts. Raw logs, synthetic
state, screenshots, generated captures and APKs stay in ignored local output.
