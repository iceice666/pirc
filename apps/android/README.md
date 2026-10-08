# pirc for Android

A native Jetpack Compose client for the pirc gateway. See [`docs/history/android-client.md`](../../docs/history/android-client.md) for the design and milestones.

Current state: pairing; bottom tabs (docs/guides/session-ui.md): **Chat** (the assistant's projects and chats), **Work** (other sessions by state: Needs you with inline actions for answers, missed scheduled runs and memory proposals; Running; Recent, with a schedule's runs folded into one row, a workspace filter and Show done), **Schedules** and **Settings** (notifications, memory proposals, unpairing); and a live chat: markdown with highlighted, copyable code; collapsible thinking, tool calls and system entries; a composer that rides on the keyboard (prompt, steer while a run is active, send a queued message now, stop, image attachments, model and thinking level); answering the agent's questions; the control lease (kept alive while the chat is open, taken over on request); session management (new session in any online workspace, adding a workspace, rename, pin, settle); and the side panels: workspace files (folder browser; viewer with highlighted source, line numbers, optional wrapping and Markdown preview), Git (branch, changes, diffs, history, commits), tasks (background jobs with live output and stop, subagents, teammates, the task board and team messages), observational memory, and terminals. File links and bare paths in messages, and files named by tool calls, open the viewer at the cited lines. Tool-only turns fold into run cards (count, duration, status, file names; a failure opens them); a write refused for another session's write lease names that session and links to it. A scheduled or delegated session has a header chip back to its schedule or chat.

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

The terminal draws with xterm.js in a WebView that loads only bundled assets; the app keeps the WebSocket (it needs the device token). The build copies xterm.js from the web client's pinned dependencies, so run `bun install` in the repository first.

This project is not part of the Bun workspace, `bun run check`, or the Nix package.

## Timeline port

`core/timeline` ports the web's snapshot/event handling (`api.ts`, `pi-messages.ts`, `state.ts`). Both are tested against the shared golden cases in [`fixtures/timeline`](../../fixtures/timeline/README.md); change them together.

## Trying it without a gateway

`dev/fake-gateway.ts` serves one session from the fixtures, streams a demo reply each time the chat opens, hands out the control lease, accepts uploads, echoes prompts back, and serves a small in-memory workspace, Git data, tasks, memory and an echoing pretend terminal for the panels:

```sh
bun apps/android/dev/fake-gateway.ts   # http://127.0.0.1:8799 (the emulator sees it as 10.0.2.2)
adb shell am start -a android.intent.action.VIEW \
  -d "pirc://pair?url=http%3A%2F%2F10.0.2.2%3A8799&token=$(bun apps/android/dev/fake-gateway.ts --token)"
```
