# Native Android client

Status: milestones 1 (gateway device tokens, web pairing), 2 (Android skeleton: pairing, session list), 3 (read-only chat), 4 (interactive chat) and 5 (files panel) implemented.

## Why

The PWA is hard to use on a phone: text is too small, layouts are cramped, the composer does not follow the soft keyboard, message text is hard to select and copy, and there is almost no motion. A native Jetpack Compose client fixes these at the platform level (`imePadding`, `SelectionContainer`, system font scale, predictive back, list item animations) instead of fighting mobile browsers.

The web client stays the primary and complete client. Android is a second client of the same gateway API.

## Scope

**v1**

- Pairing with a gateway via a device token (below).
- Session list grouped by node/workspace; create, rename and delete sessions.
- Chat: live event stream, markdown with highlighted code, collapsible tool calls, copy per message and per code block, text selection.
- Composer: prompt, image attachments (`/uploads`), model picker, stop/commands, glued to the keyboard.
- Control lease: acquire, heartbeat, release, and a clear "read-only, take control" state.
- Interactions: answer agent questions in a bottom sheet.
- Files panel: browse directories, view files with syntax highlighting, open file links from chat.

**Later (v2+)**: git panel, terminal, tasks/memory tabs, run-finished notifications, mermaid/KaTeX (WebView), backend settings.

**Non-goals**: an offline mode, and model or credential management from the phone.

## Authentication: device tokens

Today every request must come from a trusted proxy and carry the forward-auth identity header (`apps/gateway/src/daemon/auth.ts`). A native app cannot comfortably complete an Authelia 2FA web login, so the gateway gains a second way to identify the user: a per-device bearer token.

### Token

- Format: `pirc_dev_` followed by 32 random bytes in base64url. It is shown exactly once.
- Storage: gateway SQLite. The gateway stores only the SHA-256 hash:
  `device_tokens(id TEXT PK, owner_user TEXT, name TEXT, token_hash TEXT UNIQUE, created_at, expires_at, last_used_at)`. Revoked and expired rows are deleted.
- Expiry is aggressive: 7 days without use (`PIRC_DEVICE_TOKEN_IDLE_DAYS`) or 30 days after pairing however often used (`PIRC_DEVICE_TOKEN_MAX_DAYS`). The app must handle a 401 by asking to pair again.
- At most 10 paired devices per user.
- Revocation takes effect on the next request. Open event and terminal WebSockets for that token are closed with `4401` at once, and within a minute of expiry.

### Request validation (`validateRequest`)

1. The trusted-proxy address check and the `Host` allowlist still apply to every request.
2. If an `Authorization` header is present:
   - It must be `Bearer pirc_dev_…` and match a token that is not revoked. There is **no fallback** to the identity header. Anything else is a 401.
   - If the forward-auth identity header is also present, reject the request. This fails closed when the proxy routes are misconfigured.
   - The token owner must still be in `PIRC_ALLOWED_USERS`.
   - `Origin` is optional. If present, it must still be allowlisted. Bearer requests carry no ambient credentials, so there is no CSRF surface. The events WebSocket's `requireOrigin` is relaxed only for bearer requests.
3. Otherwise, the existing forward-auth path runs unchanged.

### Least privilege

Device tokens **cannot** call:

- device management (`/api/devices*`), so a stolen phone cannot mint or hide tokens;
- backend and credential settings (`/api/providers*`, `/api/provider-auth/*`).

Everything else the user can do (sessions, prompts, files, and later terminals) is allowed. A device token therefore gives shell-equivalent access to the user's nodes. This must be documented in the README threat model.

### Pairing flow

1. Web **Settings → Devices → Pair device** (forward-auth only): `POST /api/devices {name}` returns `{id, token}` once. The web shows a QR code for `pirc://pair?url=<gateway origin>&token=<token>`, plus the raw text as a fallback.
2. The app scans the QR code, or you paste the text. It checks `/api/health` and then an authenticated `GET /api/sessions`.
3. `GET /api/devices` lists devices with their last-used time; `DELETE /api/devices/:id` revokes one.
4. The app keeps the token in Keystore-backed encrypted storage and never logs it.

### Proxy (Traefik, as deployed)

Add a router that sends bearer requests past Authelia but still into the gateway, the same way `/node/connect` already works:

```
rule: Host(`<pirc-api host>`) && PathPrefix(`/api/`) && HeaderRegexp(`Authorization`, `^Bearer pirc_dev_`)
priority: above the Authelia router
middlewares: strip the identity header (customRequestHeaders X-Pirc-User: "")
```

The nix module's nginx path has the equivalent behind `services.pirc.nginx.deviceTokens`: the forward-auth subrequest returns 200 with no identity for device-token requests, so nginx drops the identity header. Both are documented in `apps/gateway/README.md`.

## Android app (`apps/android`)

- Kotlin, Jetpack Compose, Material 3, single activity, Navigation Compose, ViewModel + `StateFlow`.
- `minSdk 29`; compile against the installed SDK platform. Built with the Gradle wrapper. It is not part of the Bun workspaces or `bun run check`.
- Libraries: OkHttp (HTTP + WebSocket), kotlinx.serialization, Coil (images), a Compose markdown renderer with code highlighting (e.g. `multiplatform-markdown-renderer-m3`), CameraX + ML Kit barcode for QR codes (paste as fallback).
- Data layer ports the web's `lib/api.ts`, `panel-api.ts`, `types.ts` and the event/state reducers (`events`, `state.ts`, `pi-messages.ts`). Use the web tests' JSON fixtures as shared golden cases so both reducers agree.
- Event stream: connect while the session screen is visible, resume with `cursor`, handle `reset`, back off on failure, pause in background.

### UX requirements (the reasons for this client)

- Type follows the system font scale; body 16sp, code 14sp with horizontal scroll, no wrapping code into mush.
- Comfortable spacing and 48dp touch targets; panels are full-screen routes or bottom sheets, not squeezed side panes.
- Edge-to-edge with `imePadding()` so the composer rides on the keyboard, and the message list stays anchored to the bottom.
- `SelectionContainer` on messages, plus long-press menus: copy message, copy code block, copy file path.
- Motion: `animateItem()` for list changes, `AnimatedVisibility` for tool-call expand/collapse, streaming text without layout jumps, predictive back.

## Milestones

1. **Gateway device tokens**: schema, `validateRequest` branch, deny-list, `/api/devices` routes, WebSocket revocation, tests; web Devices settings with QR; README, threat-model and proxy docs.
2. **Android skeleton**: Gradle project, pairing, token storage, health and session list.
3. **Chat, read-only**: event stream, reducer port with golden fixtures, markdown rendering.
4. **Chat, interactive**: composer, uploads, model picker, control lease, interactions, commands.
5. **Files panel**: browse, viewer, links from chat.
6. **Polish**: motion, copy menus, large-font and small-screen passes; release signing.

## Open questions

- Should the app renew its token before the 30-day limit (e.g. a rotation endpoint), or is re-pairing monthly acceptable?
- Distribution: sideloaded APK only, or F-Droid/Play later?
