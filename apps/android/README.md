# pirc mobile

Native Flutter Android client for pirc. Its Android transport lives in
`android/app/src/main/kotlin`; pairing uses Settings → Devices on the web.

The app opens on the rooms, like the web: the room list, the messages of a
room, its members (the faces) and a worker's thread beside it. Behind them the
engine shows the nodes, the brain's turns, open loops, wakes, memory, sources
and the sessions' panes. Notifications open rooms. Provider and device
management uses a short-lived grant that you approve in the authenticated web UI. HTML, JavaScript-backed documents,
Markdown, code, math and supported diagrams render through Flutter; browser
compatibility is incomplete. See the [remaining mobile work](../../plans/mobile.md).

## Build and run

Use Flutter 3.44.4 / Dart 3.12.2 or a compatible SDK, Android SDK and JDK 17.
Android 10 (API 29) or later is required. From the repository root, `nix develop`
provides Flutter, its matching Dart SDK, and JDK 17 alongside the Rust and web tools.
The Android SDK must be installed separately for native builds; point
`ANDROID_HOME` at your Android SDK. `flutter pub get` prepares the local Flutter
SDK configuration used by Gradle; do not commit `android/local.properties`.
Flutter tests and analysis work with the Nix SDK. Native Gradle 9 builds currently
reject the SDK's read-only `packages/integration_test/android` project directory;
use a writable Flutter SDK installation for those builds until this is addressed.
Run from this directory:

```sh
flutter pub get
flutter run
flutter build apk --release
```

The application ID is `dev.pirc.mobile.preview`. Local release-mode builds use
the existing Android debug signing key for preview installs. Release CI requires
a persistent keystore supplied through Actions secrets; see
[Release CI setup](../../docs/development/releasing.md#github-release-ci-setup-once-per-repository).
Public distribution and a production signing identity remain a release decision;
do not treat these builds as store releases. No signing key, pairing credential
or local APK belongs in Git.

Upgrade the gateway and every node together. The 0.6.x server uses node protocol
11; this protocol is between the servers, not the app's REST connection. The app's
management grants and cross-device interaction synchronization need the matching
gateway/web update from this change.

## Rooms

The state of the rooms lives in the native runtime (`RoomsRuntime.kt`): it
loads the list and the open room, follows `/api/events?rooms=1` and reduces
each event with `core/rooms/RoomEvents.kt`, the port of the web's
`room-events.ts`, held to the shared cases in `fixtures/timeline/rooms`.
Flutter (`lib/live/rooms_*.dart`, `room_*.dart`) renders its snapshots.

- The list sorts by activity with unread dots and "Your turn"; archived rooms
  load when the fold opens. A phone has the web's tabs: Rooms, Members,
  Engine, Settings.
- Messages show by kind: text, lines (undo "Don't keep", the loop's action,
  Cancel; "Details" opens the engine), progress, and a worker's anchor with
  what its thread did last. A worker's red-line question is answered in the
  room and stays above the composer while it waits.
- Typing is signalled at most every 3 s. Send waits for more as usual; a long
  press on Send (Ctrl+Enter on a keyboard) sends at once. Drafts are kept per
  room. Files are uploaded to the room; images and files come back with this
  phone's token.
- A face's page edits its name, voice, role and territory; the host's page
  also edits `SOUL.md` and `CHAT.md`.

Notifications about a room open it and carry an inline Reply, which is sent
as your message in the room. **Mute** (the bell in a room) is kept on this
phone only and never sent to the gateway; a muted room, or the room on screen,
does not notify. Settings → Notifications lists the muted rooms.

## Engine

The engine's overview has six tabs, also opened by links
(`/engine?open=nodes|brain|loops|wakes|memory|sources`): Nodes, Brain turns,
Open loops, Wakes, Memory (preferences and facts) and Sources. A session is
shown by its header and panes (files, git, terminals, browser, tasks): the
app does not show sessions as conversations.

## Workspace modes

The app loads the gateway's mode catalog (`GET /api/modes`) with the workspace
index and asks capabilities, never mode ids, as described in the
[modes guide](../../docs/guides/modes.md); `lib/live/modes.dart` holds the
lookups. Every workspace, including per-session ones such as a scratch mode, is
in the engine, grouped by device. Side panels, settings sections and
nouns follow the mode's capabilities. Add workspace offers the node's accepted
modes and asks for a path only for `workdir: workspace`. A
workspace whose mode is missing from the catalog is read-only under Work. An
older gateway without the catalog (404) falls back to the directory mode.

## Verification

```sh
flutter analyze
flutter test
node --test tool/parity/*_test.mjs
```

Whoever changes the app runs `flutter analyze`, `flutter test` and the JVM
tests below; integration tests, emulator and physical-device acceptance are
run by the maintainer ([plan 12](../../plans/rewrite/12-android.md), decision 6).
Some widget tests compare against macOS Arial and Menlo and fail without them.

Install the root Bun dependencies for the JavaScript tooling. Android JVM tests
run with `./gradlew testDebugUnitTest` from `android/`. Device integration tests
live in `integration_test/`; the real-gateway service tests
require the isolated synthetic Rust environment in `tool/parity/real_gateway.ts`
and its private Dart define file. Never point those destructive test fixtures at
your normal gateway or production data.

Some pixel/geometry fixtures use macOS Arial and Menlo through
`tool/parity/capture_fonts.dart`; those checks require the matching comparison
fonts. `document_root_height_oracle_test.dart` compares native full-page height,
viewport units and overflow against the dedicated Chromium capture generated by
`tool/parity/capture_document_root_heights_web.mjs`.
`document_root_height_view_test.dart` checks resizing, retained form state,
bottom-link interaction and the viewport remaining below app chrome. The two
known trailing-space differences are listed in [the mobile plan](../../plans/mobile.md).
`document_offsets_oracle_test.dart` compares offsets and fixed flex margins with
Chromium. `document_margin_collapse_oracle_test.dart` and the fetched-page tests
cover common parent/first-child top margins. The percentage-margin oracle and
layout/view tests cover distinct containing-block widths, resizing, flex sizing,
flow-root barriers and scroll preservation during provisional or failed layout.
Remaining limits are recorded in the plan. `document_offsets_http_test.dart`
checks the shipped JavaScript runtime, scrolling, percentage geometry and style
mutation over local HTTP on Android.
`document_relative_position_oracle_test.dart` compares physical relative insets,
root/body offsets, flex/grid flow slots and scroller extents with Chromium.
The relative fetched-page tests check shifted link hits, clipped scrolling,
resizing and retained input state; the renderer tests also verify semantics and
flow baselines. Fixed grid rows retain their sizes in auto-height containers.
`document_computed_styles_oracle_test.dart` compares the supported style values
with the dedicated Chromium reference. The production runtime and Android HTTP
checks cover live read-only declarations, native dimensions and mutation fences.
Computed styles are a supported subset; absent standard properties and stale
frames fail explicitly. The detailed boundaries remain in the mobile plan.
`document_replaced_styles_oracle_test.dart` compares decoded PNG/canvas intrinsic
sizes, HTML dimensions, border-box edges, percentages, overflow and max-width
fitting and height-driven aspect ratios with eight Chromium cases at two viewports. Small text-flow rounding
differences are named in the test and mobile plan. The Android HTTP
integration also reads canvas/image styles and rectangles through the shipped
runtime after actual image decoding. The native Chart.js cases below cover
bar-chart initialization, updates and measured container resizing; broader
library support and size-changing synchronous write/read gaps remain in the plan.

`document_canvas_text_test.dart` runs synchronous Canvas `measureText()`
through Android JavaScriptSandbox, compares it with actual Flutter font advances,
compares real ink bounds with native raster pixels at 4x resolution and paints
the resulting native Canvas commands. It requires Android 12+ and the
sandbox's WebAssembly/named-data features. The bundled Skia text engine is pinned
to the Flutter engine above, with source checksums and license notices; rebuild
its assets offline with `python3 tool/parity/build_document_script_runtime.py`.
`document_canvas_text_runtime_test.mjs` compares the real engine with the pinned
Roboto/Chromium width and ink fixtures, including alignment and baselines.
Unprepared fonts, missing glyphs, ambiguous ownership, OpenType BASE selection
and mixed color/outline ink remain explicit differences. Font preparation keeps
complete outlines, bounded to 64 MiB of unique data; isolate limits are unchanged.
This is a bounded Canvas surface, not full browser font support.

`document_mutation_observer_test.dart` verifies public DOM observation through
Android IPC: nested child/attribute/text records, old values, NodeList records,
Promise ordering, record draining and private-snapshot suppression. The matching
Node suites exercise the helper and the shipped bundle. Detached-subtree
transient observation and bulk record grouping remain explicit differences.

`document_absolute_position_test.dart` compares native absolute positioning with
pinned Chromium geometry, actual screenshot pixels and topmost hit targets.
It covers nearest relative/absolute block containing boxes, initial viewport
positioning, percentage sizes, stretching, auto/percentage margins, min/max,
flex/grid flow, inline/image/Canvas blockification, RTL and sibling overlap order.
With the loopback fixture server and define used below, run
`integration_test/document_absolute_test.dart` on a dedicated Android device.
Its selected profiles execute actual JS click handlers that change position and
size; settled rectangles must match and other flow boxes must not move.
Recreate the reference with
`node apps/android/tool/parity/capture_document_absolute_chromium153.mjs`.
At least one physical inset on each axis and an ordinary visible-overflow block
containing box are required. Both-auto static-position axes, inline containing
blocks, positioned scrolling/clipping, transformed containing blocks, negative
and complex nested stacking, positioned scroll/offset metrics, fixed and sticky
positioning remain open. See the mobile plan for the complete boundaries.

`integration_test/document_visibility_test.dart` runs without a fixture server.
It checks the real Android JS engine and Flutter document view across eight
phone/tablet, DPR 1/3 and light/dark profiles: `document.hidden`, read-only
`visibilityState`, ordered `visibilitychange` events, Promise updates and
animation suspension/resumption after window and simulated app activity changes.
The host tests also retain rapid hide/show edges during startup and in-flight
evaluations. A visible but unfocused (`inactive`) app stays visible to the DOM;
its existing scheduler still pauses until foreground resumes.
Recreate the pinned initial-property/synthetic-event browser observations with
`node apps/android/tool/parity/capture_document_visibility_chromium153.mjs`.
The dedicated Headless Shell does not prove real browser background transitions;
physical OS lifecycle delivery and chart-specific interruption remain separate
acceptance work. Neither the fixture nor test code is included in the APK.

`document_chart_http_test.dart` uses the pinned test-only Chart.js 4.5.1 UMD and
Chromium 153 fixture for phone/tablet at DPR 1/3. It compares actual native
geometry and painted bar/tooltip pixels, taps both bars and blank/outside areas,
checks legend hide/show with actual bar pixels and rapid outside taps, taps the
update button and increases the container
and Canvas CSS widths by 20 px. Initial CSS and backing sizes are consistent;
both CSS dimensions use explicit pixels, with no CSS attribute dependencies.
Other sizing modes and synchronous reads before native layout remain open. Run it with the loopback fixture server (keep it running in another
terminal) and an attached dedicated test device/emulator:

```sh
# From the repository root:
node apps/android/tool/parity/serve_document_chart_fixture.mjs --port 19261
# In the test terminal:
adb -s emulator-5554 reverse tcp:19261 tcp:19261
cd apps/android
flutter test integration_test/document_chart_http_test.dart -d emulator-5554 \
  --dart-define=PIRC_CHART_FIXTURE_ORIGIN=http://127.0.0.1:19261
adb -s emulator-5554 reverse --remove tcp:19261
```

Without the define, the fixture-dependent test is skipped. The server binds only
to loopback and verifies the pinned library hash. Recreate the browser reference
with `node apps/android/tool/parity/capture_document_chart_chromium153.mjs` from
the repository root; the capture refuses everyday Chrome and blocks requests.
The touch oracle is reproducible with
`node apps/android/tool/parity/capture_document_chart_interactions_chromium153.mjs`.
The native acceptance includes legend state and bar fill disappearance/restoration;
label strikethrough uses real glyph ink bounds. Full TouchEvent/multitouch compatibility,
custom plugins and untested chart configurations remain open; default animation
has the separate gate below.
Neither the test library nor its fixture is included in the APK.

With the same fixture server and define, run
`integration_test/document_chart_types_test.dart` for the stock-chart gate:
bar, line, pie, doughnut, scatter, bubble, radar and polar area across 64
phone/tablet, DPR 1/3 and light/dark profiles. The exact shared HTML/driver tests
first/second data hits, stock tooltips, outside dismissal, legend hide/show,
data updates and resizing. It also checks actual data pixels, cleared space,
doughnut holes and line connections. Recreate the frozen reference with
`node apps/android/tool/parity/capture_document_chart_types_chromium153.mjs`.
All browser resources are fulfilled locally by request interception; external
requests are blocked, and the dedicated test browser remains mandatory.

With the same server and define, run the default-animation gate:

```sh
flutter test integration_test/document_chart_animation_test.dart -d emulator-5554 \
  --dart-define=PIRC_CHART_FIXTURE_ORIGIN=http://127.0.0.1:19261
```

Its 64 profiles retain the original Chart.js 1,000 ms duration and `easeOutQuart`
easing and use ordinary `chart.update()`. The eight operations match the stock
gate. Progress/complete callbacks are monitored without replacing the clock or
shortening transitions. The test captures the actual Canvas widget layer during
active frames, requires changing paint and compares settled geometry, selected
colors, hits and completion counts against the browser. Canvas has an independent
repaint boundary; its unit test checks that changed pixels do not repaint a static
parent. Recreate the frozen reference from the repository root with
`node apps/android/tool/parity/capture_document_chart_animation_chromium153.mjs`.
Observed callback cadence is recorded rather than required to equal Chromium's.
Animation interruption/retargeting, background/visibility lifecycle and physical
device smoothness still need separate acceptance.

The stock font aliases keep the prior 2 px pixel-geometry bound, with raw
differences recorded; angles use a separate 1e-12 bound. A neutral radar tick
backdrop edge after hiding the data has an explicitly recorded 8 × DPR / 255-channel
antialiasing bound. Canvas dimensions, solid data and clear-space probes stay exact.
These are functional and selected-paint checks, not whole-image equality.
Tooltip interiors composited over data have a separate 1/255-per-channel rounding
allowance (observed polar-area `[6,40,19,255]` versus `[7,39,19,255]`). This
applies only at samples at least 8 CSS px inside the tooltip background; solid
data, transparent holes and clear-space samples keep their exact checks.
The same reference includes 129 font-independent path-call observations that
verify ignored nonfinite arguments, WebIDL arity/conversion errors and negative
radii. The original chart library is unchanged and is excluded from the APK.

The `document_chart_http_test.dart` command also audits 16 responsive sizing cases from
`document-chart-responsive-layout-chromium153.json`, loading the exact authored
HTML and driver used by the browser. All 16 cases must initialize without
diagnostics and match native geometry and bar pixels, including Canvas with no
authored size, pixel/percentage widths, initial inline display, content-box sizing
and omitted backing attributes. Container-only resizing requires matching early
and settled geometry and paint, including Chart's same-callback parent-width
read after changing descendant sizes. Native-proved simple used-size calculation
supports intrinsic initialization; general synchronous layout remains open.
Recreate this separate browser reference with
`node apps/android/tool/parity/capture_document_chart_responsive_layout_chromium153.mjs`.
The capture records both the early two-frame and settled resize observations;
the native audit keeps failures visible rather than substituting fixed sizes.

With the same fixture server, run from `apps/android`:

```sh
flutter test integration_test/document_frame_steps_test.dart -d emulator-5554 \
  --dart-define=PIRC_CHART_FIXTURE_ORIGIN=http://127.0.0.1:19261
```

It compares native frame callbacks with eight frozen Chromium cases: phone/tablet,
DPR 1/3, light/dark. It checks Promise jobs, cancellation, nested frames, frame
timestamps and actual native dimensions after earlier callbacks change width.
Recreate its reference with
`node apps/android/tool/parity/capture_document_frame_steps_chromium153.mjs`.
This repairs layout between callbacks. Within one callback, a measured fixed-width
ordinary block can also retain its `clientWidth` after strict descendants' size
changes when CSS cannot depend on those attributes and no scrollbar or intrinsic
sizing is involved. Other metrics and newly changed geometry still require native
layout; arbitrary synchronous writes and reads remain a separate gap.

With the same server and define, `integration_test/document_layout_dependencies_test.dart`
compares 32 browser/native cases: ordinary/nested blocks, content-box/border-box,
phone/tablet, DPR 1/3 and light/dark. It reads parent `clientWidth` immediately
after resizing a descendant, then compares actual native rectangles on the next
frame. Recreate the reference with
`node apps/android/tool/parity/capture_document_layout_dependencies_chromium153.mjs`.

`integration_test/document_box_style_projection_test.dart` uses the same server
and define to compare 32 independent computed-style cases against Chromium 153.
It switches edgeless fixed-size Canvas display/box-sizing, including percent width,
inline/block changes and same-batch restoration. The live computed declaration
and fixed single-child parent rectangle are checked synchronously; actual native
child geometry is checked on the next frame. Inline child baseline rounding may
differ by at most 0.1 px with platform fonts; the raw difference is recorded and
all other values stay exact. Recreate the reference with
`node apps/android/tool/parity/capture_document_box_style_projection_chromium153.mjs`.
This proof excludes scrollbar ancestors, edges, important box declarations,
attribute-dependent CSS and real dimension changes. It does not provide general
synchronous native layout or certify a replaced element's old position/scroll data.

`integration_test/document_canvas_sizing_test.dart` uses the same server and
define for 72 Chromium/native cases. It checks natural dimensions, auto-axis
ratios, px/percent switches, bitmap resets, zero natural axes and narrow fixed
parents after each individual write and native frame. The fractional-ratio mode
allows 0.02 px of browser layout quantization; other values remain exact.
`capture_document_canvas_sizing_chromium153.mjs` recreates the reference with
all network requests blocked. The runtime projects only host-proved simple CSS
sizes and stable parent data: a first-flow LTR path with pixel edges and no auto
margins, preceding rendered content, transforms or percentage relative offsets.
A scrolled root defers parent rectangles to native measurement to account for
scroll clamping after overflow changes. Unknown sizing expressions, changed child rectangles and scroll data still
require native measurement. Projection is bounded to 1,000,000 CSS pixels per
axis; the existing bitmap and drawing budgets remain separate.

`document_pointer_events_test.dart` compares 176 frozen Chromium 153 profiles
for native HTML hit targets and paint, including inherited `none`, explicit child
restoration, inline text, native buttons/Canvas, clipped/visible overflow and
dynamic changes. `document_pointer_restore_clip_test.dart` covers rounded clips
and text-field focus. Recreate the reference with
`node apps/android/tool/parity/capture_document_pointer_events_chromium153.mjs`.

`integration_test/document_pointer_events_test.dart` uses the same local server
and `PIRC_CHART_FIXTURE_ORIGIN` define for 88 Android profiles. The frozen browser
driver runs unchanged in JavaScriptSandbox; native touches, event targets,
bubbling, computed policy, dynamic updates and programmatic click traces are
compared after every step; restored native button border boxes are checked
against their authored sizes. The fixture server binds only to loopback and no
remote service is needed. SVG shape-specific hit geometry, pointer capture and
mid-gesture policy changes remain separate acceptance work.

`integration_test/document_text_style_test.dart` uses the same local server and
define for 48 frozen Chromium profiles. It compares synchronous cascade values
after visible/hidden text updates and next-frame native rectangles. Recreate the
reference with `node apps/android/tool/parity/capture_document_text_style_chromium153.mjs`.
`document_text_style_test.dart` checks native dependency proofs and packet metadata;
`document_text_style_runtime_test.mjs` checks the shipped bundle's retained styles
and invalidation. The pointer integration also checks immediate reads after its
programmatic click. Geometry still requires native layout, and text-sensitive
selectors or other DOM/style mutations retain their normal invalidation.

`document_fixed_oracle_test.dart` compares 120 Chromium profiles and 368 states
for viewport-fixed geometry, native paint, hit identities, root/inner scrolling
and same-document viewport resize. `document_fixed_position_test.dart` covers
short-document hit ownership and scroll extents. Recreate with
`node apps/android/tool/parity/capture_document_fixed_chromium153.mjs`.

`integration_test/document_fixed_test.dart` uses the same local fixture server and
`PIRC_CHART_FIXTURE_ORIGIN` define. Native Advance controls drive root/inner scroll,
style changes and hide/show; every state checks measured boxes and native clicks.
The eight hidden_dynamic profiles now use strict viewport comparison after the
root anchoring follow-up; their previous 180/300 allowance is removed. See the
mobile plan for the remaining positioning limits.
`document_scroll_frame_host_test.dart` verifies scroll acknowledgement before RAF,
ordered callback/Promise scrollBy and cancellation across hide/detach.

`document_scroll_anchor_oracle_test.dart` compares 144 profiles and 576 states
against Chromium: actual offset, extent, every captured box and a native painted
pixel. `document_scroll_anchor_activity_test.dart` checks ongoing drag/inertia.
The shared generator is `tool/parity/document_scroll_anchor_fixture.mjs`; capture
from the repository root with
`node apps/android/tool/parity/capture_document_scroll_anchor_chromium153.mjs`.
The Node contract checks source/driver identity, exclusion/suppression and removed
anchor behavior. `integration_test/document_scroll_anchor_test.dart` uses the same
local server/define as the fixed test, with the shipped JS sandbox and native
Advance control. Same-turn scrollTo/scrollBy wait for anchor compensation, and
layout acknowledgements wait for the resulting native paint.

`document_element_anchor_oracle_test.dart` compares 168 nested-scroll profiles
and 672 states, including actual native paint, owner replacement and hide/show.
Recreate its frozen reference from the repository root with
`node apps/android/tool/parity/capture_document_element_anchor_chromium153.mjs`.
The shared page/driver generator is `tool/parity/document_element_anchor_fixture.mjs`;
the Node contract verifies exact source identity, exclusions and coupled layers.
`integration_test/document_element_anchor_test.dart` uses the same loopback
fixture server and define as the root-anchor test, comparing all scroll/client
metrics and rectangles through the shipped JS engine and native controls.

`document_scroll_retention_test.dart` checks complete view/workspace remounts,
document switches, independent root/nested offsets, real link activation and fresh
history responses against eight Chromium 153 phone/tablet/DPR/theme profiles.
Capture the common HTML/driver reference with
`node apps/android/tool/parity/capture_document_scroll_retention_chromium153.mjs`.
Root history positions restore per entry in auto mode; nested positions stay with
the retained document. A fresh response starts nested positions at zero. The
Android `integration_test/document_scroll_retention_test.dart` uses the loopback
server/define above and real Step/Read buttons, requiring a new JS probe sequence
after each remount so a cached report cannot count as acceptance. The original VM
and offsets survive retained-view rebuilding; different documents stay isolated.
The workspace saves the latest root position at unmount, preserving user reading
past the original anchor; the native workspace gate also checks that a new
fragment selected while unmounted still applies on reveal.
Interrupted smooth scrolling and OS process-death restoration are separate gates.

`document_scroll_commands_test.dart` compares immediate **native controller**
positions and settled positions with 160 Chromium 153 command profiles. It also
checks cancellation after animation has already started. Commands retain their
root/element order; relative movement uses current pixels, and zero/omitted
coordinates can stop an animation. The Node contract checks the exact shared
HTML/driver plus the shipped JS command queue, including empty/null options.
Recreate the reference with
`node apps/android/tool/parity/capture_document_scroll_commands_chromium153.mjs`.
The Android `integration_test/document_scroll_commands_test.dart` uses the same
loopback fixture server/define as above and verifies settled readings after a real
Run click. It separately records immediate JS readings: same-callback getters
still return the prior accepted frame, so synchronous read/modify/write scrolling
remains a difference. Do not count these immediate mismatches as passed parity.
Smooth animation follows Flutter's timing; CSS defaults and event-order variants
remain in the mobile plan.

Ordinary app rendering uses the platform fonts. Browser capture tools use
a dedicated test browser, never the user's everyday Chrome; see
[the test browser guide](tool/parity/TEST_BROWSER.md).

Keep source fixtures, compact expectations, regression tests and reproducible
capture tools in Git. APKs, screenshots, raw capture dumps, acceptance logs,
per-machine setup and chronological development notes stay in ignored local
output directories. Raw development output before 0.6.1 is retained locally under
`build/local-history/`, not published as project documentation. Retired tracked
plans and implementation notes are available through [Historical records in Git](../../docs/development/historical-records.md).

Historical capture metadata uses `<repository>/` for machine-local paths. This
normalization does not change the recorded browser results or claim a recapture.

Large JSON regression expectations are stored compactly; JSON values are
unchanged. Keep formatting-only capture output out of code reviews.

`document_resize_capture_test.dart` compares fractional content/border box data
with the dedicated Chromium 153 resize fixture at phone/tablet widths.
`document_resize_runtime_test.mjs` checks actual observation delivery and lifecycle
against that fixture. The Android offsets integration also exercises observer
callbacks through JavaScriptSandbox and the production native renderer. Supported
boxes and remaining observer differences are recorded in the mobile plan.
