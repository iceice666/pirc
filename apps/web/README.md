# pirc web client

Standalone Svelte 5 + TypeScript + Vite client for the pirc gateway. This package intentionally uses no SvelteKit server runtime; the build is a static bundle (`dist/`) that any web server can serve (see [`docs/deploy/reverse-proxy.md`](../../docs/deploy/reverse-proxy.md)).

## Commands

From the repository root:

```sh
bun install
bun run dev:web
bun run --filter @pirc/web typecheck
bun run --filter @pirc/web test
bun run --filter @pirc/web build
```

Vite proxies `/api` and WebSocket upgrades to `http://localhost:8787` in development (`vite.config.ts`).

## Pages

Two pages, room-first ([plans/rewrite/11-web.md](../../plans/rewrite/README.md)):

- **Rooms** (`/`, `?room=<id>`): the room list (archived ones folded under it), the open room's messages and composer, and a right column with the members, a face's page or a worker's thread (the thread wins; on a phone each is a full page). Bottom tabs on a phone: Rooms, Members, Engine, Settings. State: `src/lib/rooms.svelte.ts`, which applies the room stream through the pure reducer `src/lib/room-events.ts`.
- **Engine** (`/engine`): a front page (`?open=nodes|brain|loops|wakes|memory|sources`), the workspace/session tree, a workspace's details (`?workspace=`) and a session (`?session=`), read-only with its side panel. Sessions can only be renamed. State: `src/lib/engine.svelte.ts`.

The two states never import each other (`src/lib/boundaries.test.ts`); links carry the user between them. Settings (models & sources, devices, notifications, about) is one dialog both pages open.

Keyboard: arrows move through the room list; the message log and a thread are tab stops whose arrows (Home/End) go through their messages; Alt+ArrowUp/Down opens the previous/next room; Escape closes the thread or the side column. Finished messages from others are announced once from a separate live region.

## Runtime behavior

- Fetch requests include forward-auth cookies with `credentials: include`.
- Room events are reduced by `room-events.ts` and session events by `state.ts`; both are held to golden cases in [`fixtures/timeline`](../../fixtures/timeline/README.md) that the Android client shares. What a working worker does (shown on its anchor message) is derived here from its thread's messages; the gateway writes no progress messages.
- Drafts are kept per room in local storage. They are never sent automatically.
- A room can be muted on this device (its header's bell): the list lives in local storage and is copied to a cache the service worker reads, so that device shows no notifications from it. Other devices keep their own choice.
- Only hashed Vite assets below `/assets/` are cached by the hand-written service worker. HTML, API responses, conversations, uploads, and credentials are never cached. Notifications open their room (`/?room=`) or the engine (`/engine?session=`, `/engine?open=memory`), and are not shown for the room or session on screen.
- A waiting service worker shows an update prompt and does not force a page reload.
- If the API is unavailable in development, both pages load local demo data (`src/lib/mock.ts`: rooms, faces and a worker's thread; the engine's sessions) so the full layout remains reviewable. Production builds leave it out.

## API contract

The gateway API is documented in [gateway and node reference](../../docs/development/gateway-and-node.md#api); the room calls live in `src/lib/rooms.ts` (and `faces.ts`, `workers.ts`, `loops.ts`, `wakes.ts`, `memory.ts`, `sources.ts`, `brain.ts`), the engine's in `src/lib/api.ts` with its types in `src/lib/types.ts`. Points that differ from what a generic client might assume:

- List endpoints return envelopes (`{ rooms, user }`, `{ sessions }`, `{ workspaces }`), not bare arrays.
- The room stream is `/api/events?rooms=1` (resumed with `cursor=epoch:sequence`); sequence 0 marks ephemeral events (typing, presence) that are never replayed.
- `PATCH /api/sessions/:id` renames a session; the web sends sessions nothing else but answers to their questions.
- The control lease is `POST /api/sessions/:id/control/{acquire,heartbeat,release}`; interaction answers are `POST /api/sessions/:id/interactions/:interactionId/answer` with `{ clientId, generation, answer }`.
- Room uploads are raw request bodies (`POST /api/rooms/:id/uploads?filename=…`, the file's content type as `content-type`), not multipart.
- JSON errors use `{ error: { code, message, details? } }`.
