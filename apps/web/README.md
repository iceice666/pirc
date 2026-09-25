# Relay web client

Standalone Svelte 5 + TypeScript + Vite client for the pirc gateway. This package intentionally uses no SvelteKit server runtime.

## Commands

From the repository root:

```sh
npm install
npm run dev:web
npm run typecheck --workspace @pirc/web
npm test --workspace @pirc/web
npm run build --workspace @pirc/web
```

Vite proxies `/api` and WebSocket upgrades to `http://localhost:8787` in development.

## Runtime behavior

- Fetch requests include forward-auth cookies with `credentials: include`.
- Session snapshots are reduced with sequenced WebSocket events; reset or epoch mismatch requests a fresh snapshot.
- Drafts are stored per session in local storage. Offline drafts are **never** automatically submitted after reconnecting.
- Only hashed Vite assets below `/assets/` are cached by the hand-written service worker. HTML, API responses, conversations, uploads, and credentials are never cached.
- A waiting service worker shows an update prompt and does not force a page reload.
- If the API is unavailable in development, the interface loads local preview data so the full layout remains reviewable.

## API shape assumptions

All provisional gateway types live in `src/lib/types.ts` so the contract can be aligned without changing the UI components.

- List endpoints return arrays directly (`Workspace[]`, `SessionSummary[]`, `ModelOption[]`) rather than `{ items }` envelopes.
- `POST /api/sessions` accepts `{ workspaceId, name?, modelId?, thinkingLevel? }`.
- Commands accept `{ commandId, kind, controlGeneration, content?, modelId?, thinkingLevel?, attachmentIds? }`.
- `POST /control` accepts `{ clientId, action: "take" }`; `DELETE /control` accepts `{ generation }`.
- Interaction answers accept `{ action, value?, controlGeneration }`.
- Image upload uses multipart field `file` and returns an opaque attachment record.
- WebSocket messages are `EventEnvelope` JSON objects with a cursor, numeric sequence, runner epoch, and typed event payload.
- JSON errors use `{ code, message, requestId? }`.
