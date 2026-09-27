# pirc for Android

A native Jetpack Compose client for the pirc gateway. See [`plans/android-client.md`](../../plans/android-client.md) for the design and milestones.

Current state: pairing, the session list, and a live read-only chat view (markdown with highlighted, copyable code; collapsible thinking, tool calls and system entries; pending questions and the queue). The composer, answering questions and the files panel come next; until then, use the web client for those.

## Pairing

The app authenticates with a device token instead of forward auth (see [Device tokens](../gateway/README.md#device-tokens)); the proxy must route `Authorization: Bearer pirc_dev_…` requests to the gateway.

1. In the web client, open **Settings → Devices → Phones** and pair a device.
2. In the app, tap **Scan QR code** (Google Play services' scanner; the app needs no camera permission), or paste the `pirc://pair?…` link. Opening the link on the phone also works; the app asks before it pairs.

The token is encrypted with a non-exportable Android Keystore key and excluded from backups and device transfer. The app never follows redirects with it. When the gateway answers `401` (the token expired or was revoked), the app unpairs and asks you to pair again.

Only HTTPS gateways are accepted, except `localhost`, `127.0.0.1` and the emulator's `10.0.2.2` for development.

## Build

Needs JDK 21 and the Android SDK (platform 37). Point Gradle at the SDK with `ANDROID_HOME` or `local.properties` (`sdk.dir=…`, not committed).

```sh
cd apps/android
./gradlew testDebugUnitTest   # JVM unit tests
./gradlew assembleDebug       # app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

This project is not part of the Bun workspace, `bun run check`, or the Nix package.

## Timeline port

`core/timeline` ports the web's snapshot/event handling (`api.ts`, `pi-messages.ts`, `state.ts`). Both are tested against the shared golden cases in [`fixtures/timeline`](../../fixtures/timeline/README.md); change them together.

## Trying it without a gateway

`dev/fake-gateway.ts` serves one session from the fixtures and streams a demo reply each time the chat opens:

```sh
bun apps/android/dev/fake-gateway.ts   # http://0.0.0.0:8799
adb shell am start -a android.intent.action.VIEW \
  -d "pirc://pair?url=http%3A%2F%2F10.0.2.2%3A8799&token=$(bun apps/android/dev/fake-gateway.ts --token)"
```
