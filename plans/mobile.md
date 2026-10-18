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
- [ ] **Fragment scrolling and target state:** complete CSS scroll margin/padding,
      nested-container alignment, focus/`:target`, late-loaded targets and
      nodes discarded from rendered markup. Target lookup, initial URLs and
      repeated activation have a bounded gate below.
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
  translation and composed matrices. General stacking/compositing between
  intermediate ancestors,
  inline/table/SVG containing blocks, 3D/perspective, individual transform
  properties, textual inline fragments, transform-box variants and general
  transformed overflow propagation remain outside the covered subset. Table/zoom/multicolumn
  and fragmented offset paths still lack the required native offset support.
- Common block containing blocks can now own `auto`/`scroll`/`hidden`/`clip`
  overflow with absolute and local-fixed children. Positioned entries live
  inside the actual native scrollport; its constrained padding box supplies
  percentage and right/bottom bases while content can extend beyond it. Borders
  remain stationary; native paint and clicks share the scroll/clip path. A
  separate 192-profile Chromium 153 corpus checks phone/tablet, DPR 1/3 and both
  themes across three states, including reflow, overflow changes and transforms.
  Viewport-fixed overlays escape ordinary overflow ancestors and switch to/from
  local transform ownership; Canvas/button targets are included.
  Widget and Android Sandbox gates check exact scroll/client sizes, offsets and
  parent ids, rectangles within 1/32 CSS px, exact before/after pixels and real
  clipped/visible taps. Browser and Android use the same observer and compare
  actual before/after pointer click counts. Mixed-axis normalization, scrollbars,
  rounded clips and general transformed overflow propagation still need wider
  coverage.
- Common 2D transformed paths now provide `offsetParent`, `offsetLeft` and
  `offsetTop` for ordinary, absolute and fixed boxes. Measurement follows real
  untransformed native layout translations, removes native scroll displacement
  and ignores owned CSS paint transforms, including singular matrices. Viewport
  fixed offsets use the actual pre-routing layout position. The static-body
  rules distinguish ordinary flow from positioned content, including body
  transforms and html borders/margins. Native widget and Android Sandbox gates
  check 224 Chromium 153 phone/tablet, DPR 1/3 and theme profiles across three
  states, including dynamic ownership changes, Canvas/buttons, negative-half
  rounding and root/enclosing scrolling. All integer offsets, dimensions and
  parent identities compare exactly. Positioned reads require a real native
  positioned item; missing/ambiguous owners, unsupported framework transforms,
  fallback-flow positioning and stale frames withhold offset metadata. This
  does not provide general synchronous DOM write/read layout.
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

**CSS default scrolling:** window/element scroll methods, numeric overloads and
scroll offset setters now honor the matched native `scroll-behavior` value.
The root supplies the viewport default; body styles do not propagate to it.
The property does not inherit unless explicitly requested. `instant` overrides
CSS smooth behavior, and clean commands freeze the resolved choice at call time.
Native execution waits for the actual cascade when a dirty style frame is still
pending; synchronous feedback with an unresolved default fails explicitly.
Interleaved style/scroll/style calls within one turn use the next measured
default and can differ from the browser call-time choice.
A 224-profile Chromium 153 corpus checks computed values and immediate/settled
positions exactly, with native controller/cascade and Android Sandbox gates.
Valid/invalid CSS variables, inherited/unset values, setter/alias calls and
frame-matched class changes are included. This does not certify fragment navigation, exact timing or reads immediately
after dirty writes. `scrollIntoView` has the separate bounded gate below.

**Native element reveal:** `Element.scrollIntoView` uses actual native scrollport
sizes, origins, invertible affine axes and bounded ancestry. It supports the
common standards-mode horizontal LTR block/inline alignments, legacy boolean arguments,
`container:nearest`, nested auto/hidden ports (including zero ranges), current
native scroll ranges, CSS scroll margin/padding, and clipped propagation to
outer ports. Canvas, buttons and text inputs retain real measured targets;
raw document text/select/date/file controls are measured at their replacement
border box rather than a discarded parser placeholder. Unproved geometry is
rejected before queuing any part of a reveal batch.

The 216-profile Chromium 153 corpus covers phone/tablet, DPR 1/3 and both themes.
Native geometry producers are checked separately from the shipped JS planner,
and Android executes the same source in the real Sandbox. Instant positions,
boolean/dictionary conversion, getter order, rejected enum errors, descriptors,
Promise result dictionaries and nested destinations are checked. Smooth reveals
wait for native action acknowledgement and actual native scroll activity; the
host refreshes completion activity even when final pixels have stopped changing;
replacement and stopped-away-from-target completion return `interrupted:true`.
A newly appended element can be revealed after the next native layout frame.
This does not make mutation-then-read layout synchronous.

Explicit reveal differences: Flutter retains its native animation curve/duration
and resolves a smooth reveal after all owned native targets stop. The frozen
browser can resolve while its root is still moving. A redundant instant root
request cancels a preceding animation in Flutter; this Chromium build can drift
beyond that zero-distance request. Those timing differences remain listed and
are not claimed as matching intermediate pixels. Wider native gesture
interruption acceptance, scrollend ordering, RTL/vertical writing, horizontal
root scrolling, logical scroll inset properties, quirks/iframe/XML documents,
sticky/fragmented/SVG geometry, scroll snap, fractional CSS/limit quantization and unresolved CSS inset math/complex variable shorthands remain
outside this gate. Invalid inset declarations also need wider cascade coverage.
Other scroll methods' Promise return semantics and broader fragment scrolling
remain separate work; the selection/activation gate is below.

**Fragment selection and activation:** rendered HTML resolves IDs before named
`a` anchors and retains the first match in tree order. Literal fragment names
are tried before UTF-8 percent decoding; plus signs are preserved, malformed
percent/UTF-8 sequences are handled, and an actual `id`/`name="top"` wins over
the case-insensitive top-of-document fallback. Hidden targets do not fall back
to the page top. Private rendering aliases keep duplicate anchors distinct and
leave original IDs available to CSS selectors, labels, controls and scripting.

Repeated activation of the same URL requests another reveal without creating
a history entry or repeating HTTP. Explicit activation ignores an old saved
offset and still works in manual restoration mode. Requests survive a workspace
remount until consumed; consumed requests are not replayed. Later history/URL
changes invalidate stale callbacks. Internal alias resolution does not suppress
real link taps during an in-progress reveal, and swapping a viewport controller
rebinds its index without changing the document.

The independent 152-profile Chromium 153 corpus covers initial URLs and actual
first/repeated link clicks at both sizes, DPRs and themes. Flutter checks those
flows plus lifecycle, CSS-ID/label/value preservation and existing history
regressions. Android covers the actual native workspace's 152 click/repeat
profiles and reruns the 216 Sandbox reveal profiles. Source URLs are delivered
as complete final URLs by the existing document RPC; backend redirect/fragment
inheritance is not newly certified by this renderer gate.

**Native fragment geometry:** ordinary HTML and scripted pages now use the
same measured native layout evidence as element reveal. The host computes every
scroll destination before applying any command, using real inner-to-outer
scrollports (including zero-range ports), clipping, affine transforms and actual
scroll limits. Physical CSS scroll margins and padding include measured font
lengths and percentage padding. Root and nested `scroll-behavior` defaults are
honored; smooth animation timing still follows Flutter rather than Chromium.
Initial requests wait for their DOM index, matching layout revision and prior
DOM/history publications to drain, so the initial handoff cannot discard a
new smooth animation; later history/URL changes cancel a pending request. Renderer-only IDs remain outside
script layout packets, and private captures can select a bounded subset from a
larger document. The index now uses the full parsed DOM, so discarded head nodes
retain their priority over a later rendered duplicate.

The additional Chromium 153 corpus contains 280 profiles at phone/tablet sizes,
DPR 1/3 and both themes. The workspace has 48 CSS px of app chrome, excluded from
the browser document viewport; native tests assert the same available viewport.
The native geometry test now includes all 280 first/repeated profiles, plus 88
initial-load profiles with and without real Android Sandbox scripts. It includes CSS padding/margins,
negative margins, font lengths, percentages, transformed ports/targets, hidden
and oversized targets, Canvas, zero-range ports, root padding and click-time DOM
style mutations. Widget tests cover the 136 non-script first/repeated profiles
and 40 initial-load profiles. These are coordinate/navigation checks, not a
claim of pixel-perfect rendering or all fragment behavior.

**Native fragment focus:** the former button/input focus exclusions are now
enabled. Native DOM focus moves before reveal, and the existing trusted event
bridge delivers blur/focusout/focus/focusin with activeElement and relatedTarget.
Focusable links, controls and tabindex targets (including -1) receive
native focus; disabled, hidden and inert targets are not focused.
Nonfocusable targets clear document focus, while top fallback/missing anchors
retain the link's focus. The selected native node is retained across the focus
publication rather than reselecting another duplicate ID.

Focus centering and start/nearest fragment reveal are composed from one completed
native frame. Only the host's own instant scroll effects are translated through
proved native axes; a pending smooth focus goal is not treated as a position.
Textareas use their actual RenderEditable caret rectangle, checked against the
same target/root/revision. This private caret evidence never enters VM packets.
Native deferred caret reveal is suppressed during the focus handoff. Changing
the selected window cancels the pending navigation and cannot steal focus or
replay it on return; remount retention remains a separate existing contract.

The additional 312-profile Chromium 153 focus corpus covers actual native focus,
settled nested positions and first/repeated clicks at both sizes, DPRs and themes.
Android also checks 88 initial loads, with real Sandbox scripts, trusted event
order and relatedTarget/activeElement, including focus handlers changing CSS
margins. It covers buttons, inputs, textareas, selects, checkboxes, links,
tabindex, disabled/hidden/nonfocusable targets, top/missing fragments, insets,
rotation, already visible targets and root/inner/all smooth defaults. The
non-script widget gate has 152 click/repeat and 40 initial profiles. A separate
widget gate checks CSS-sized toggle activation, labels, Space and radio arrow
keys. The browser geometry tolerance is 1/32 CSS px; focus identity and event
reports must match exactly. Exact animation timing is still Flutter-specific.

**Remaining fragment differences:** reentrant focus redirection/navigation,
filled/oversized control caret and selection variants, focus restoration across
remount/background transitions, broader keyboard traversal, focus pseudo styling,
additional toggle box-model combinations and exact toggle appearance/accent
styling are not newly certified. A redirected focus is recorded as a difference.
`:target`, ancestor revealing, late DOM/image retry, targets without a measured
box, inline/text/
non-HTML fragments, RTL/vertical writing, sticky/SVG geometry, scroll snap,
root horizontal scrolling and unresolved inset math remain open. Unsupported
geometry retains the native anchor fallback and an explicit difference; matching
frame waits stay bounded. Backend redirect/hash inheritance, physical devices
and remote push remain outside this gate. This does not establish pixel-perfect
rendering or complete fragment behavior.

**Remaining synchronous layout differences:** general DOM writes followed by
geometry reads still need matching native measurement. Exact animation timing,
scrollend/Promise behavior and mixed root/element event ordering are not certified by this gate. Global getter
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
