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
- **Engine** (`/engine`): a front page (`?open=nodes|brain|loops|wakes|memory|sources`), the workspace/session tree, a workspace's details (`?workspace=`) and a session (`?session=`), which shows only its panes (Files, Git, Memory, Context, Tasks, Terminal, Browser): no conversation, people talk to pirc in the rooms (plan 12 decision 4). Sessions can only be renamed. State: `src/lib/engine.svelte.ts`.

The two states never import each other (`src/lib/boundaries.test.ts`); links carry the user between them. Settings (models & sources, devices, notifications, about) is one dialog both pages open.

Keyboard: arrows move through the room list; the message log and a thread are tab stops whose arrows (Home/End) go through their messages; Alt+ArrowUp/Down opens the previous/next room; Escape closes the thread or the side column. Finished messages from others are announced once from a separate live region.

## Theme, type and languages

- **Dark only.** `src/app.css` holds the design's palette (surfaces `#0f0f11`/`#17171a`/`#1d1d20`/`#26262b`, ink steps, `#5686fe` accent, `#3fbf86` status colours) as CSS custom properties. It is what ships on every device; the light palette is kept under `:root[data-theme='light']` and nothing sets the attribute. `src/lib/theme.ts` is the one place that answers "is it dark" for the terminal and Mermaid.
- **Type.** IBM Plex Sans (15px in the rooms, 14px in the engine), JetBrains Mono for identifiers and Noto Sans TC for Chinese, self-hosted from the `@fontsource-variable` packages (OFL) with unicode-range slices, so nothing loads from fonts.gstatic.com and only the slices a page needs are fetched. Section labels are 12px, uppercase, `0.04em`.
- **Status.** One vocabulary everywhere (`src/lib/components/StatusGlyph.svelte`): green dot working, hollow ring idle or done, yellow square waiting for you, red failure.
- **Languages.** `src/lib/i18n` is a typed message catalogue (`messages/<area>.ts`, one flat `en` and `zh` table per area) and a small reactive `t(key, vars)`; `i18n.test.ts` fails if the two languages disagree on a key, an empty message or a placeholder. Locales are `zh-TW` (default) and `en`: the starting locale comes from the browser's languages, a person's choice is kept in local storage (`relay.layout.locale`) and the selector lives in the Settings header, the one dialog both pages open. Product words (Engine, room, thread, face, worker) stay English in both languages. Add a string to the area's file, in both languages; never leave one in a component.

## Runtime behavior

- Fetch requests include forward-auth cookies with `credentials: include`.
- Room events are reduced by `room-events.ts`, held to golden cases in [`fixtures/timeline/rooms`](../../fixtures/timeline/README.md) that the Android client shares. Session events (`state.ts`) only move the cursor, rename the session or ask for a fresh snapshot: the engine keeps a session's record, run and control lease, not its history. What a working worker does (shown on its anchor message) is derived here from its thread's messages; the gateway writes no progress messages.
- Drafts are kept per room in local storage. They are never sent automatically.
- A room can be muted on this device (its header's bell): the list lives in local storage and is copied to a cache the service worker reads, so that device shows no notifications from it. Other devices keep their own choice.
- Only hashed Vite assets below `/assets/` are cached by the hand-written service worker. HTML, API responses, messages, uploads, and credentials are never cached. Notifications open their room (`/?room=`) or the engine (`/engine?session=`, `/engine?open=memory`), and are not shown for the room or session on screen.
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
