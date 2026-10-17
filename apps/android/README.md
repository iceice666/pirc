# pirc mobile

Native Flutter Android client for pirc. Its Android transport lives in
`android/app/src/main/kotlin`; pairing uses Settings → Devices on the web.

The app includes chat and work sessions, streaming and cancellation, approvals,
memory and schedules, workspace panels, attachments, notifications and native
content rendering. Provider and device management uses a short-lived grant that
you approve in the authenticated web UI. HTML, JavaScript-backed documents,
Markdown, code, math and supported diagrams render through Flutter; browser
compatibility is incomplete. See the [remaining mobile work](../../plans/mobile.md).

## Build and run

Use Flutter 3.44.4 / Dart 3.12.2 or a compatible SDK, Android SDK and JDK 17.
Android 10 (API 29) or later is required. Run from this directory:

```sh
flutter pub get
flutter run
flutter build apk --release
```

The application ID is `dev.pirc.mobile.preview`. Release-mode builds currently
use the local Android debug signing key for preview installs. Public distribution
and a production signing identity remain a release decision; do not treat these
builds as store releases. No signing key, pairing credential or local APK belongs
in Git.

Upgrade the gateway and every node together. The 0.6.x server uses node protocol
11; this protocol is between the servers, not the app's REST connection. The app's
management grants and cross-device interaction synchronization need the matching
gateway/web update from this change.

## Verification

```sh
flutter analyze
flutter test
node --test tool/parity/*_test.mjs
```

Install the root Bun dependencies for the JavaScript tooling. Android JVM tests
run with `./gradlew testDebugUnitTest` from `android/`. Device integration tests
live in `integration_test/`; `real_gateway_test.dart` and related service tests
require the isolated synthetic Rust environment in `tool/parity/real_gateway.ts`
and its private Dart define file. Never point those destructive test fixtures at
your normal gateway or production data.

Some pixel/geometry fixtures use macOS Arial and Menlo through
`tool/parity/capture_fonts.dart`; those checks require the matching comparison
fonts. Ordinary app rendering uses the platform fonts. Browser capture tools use
a dedicated test browser, never the user's everyday Chrome; see
[the test browser guide](tool/parity/TEST_BROWSER.md).

Keep source fixtures, compact expectations, regression tests and reproducible
capture tools in Git. APKs, screenshots, raw capture dumps, acceptance logs,
per-machine setup and chronological development notes stay in ignored local
output directories. Development history before 0.6.1 is retained locally under
`build/local-history/`, not published as project documentation.

Historical capture metadata uses `<repository>/` for machine-local paths. This
normalization does not change the recorded browser results or claim a recapture.

Large JSON regression expectations are stored compactly; JSON values are
unchanged. Keep formatting-only capture output out of code reviews.
