# Timeline fixtures

Golden cases shared by every client that turns gateway snapshots and events into a chat timeline (the web's `api.ts`/`pi-messages.ts`/`state.ts`, and the Android port in `apps/android/.../core/timeline`).

Each file holds a raw `GET /api/sessions/:id/snapshot` reply (`snapshot`), the raw `/api/events` messages that follow it (`events`), and `expected`: a projection of the client state after the snapshot and after every event has been applied. The projection leaves out timestamps and anything clients may format differently.

`rooms/` holds the same kind of golden case for rooms (plans/rewrite/01-rooms.md): the asking `user`, the room list (`rooms`, as `GET /api/rooms` returns it), the `open` room and its `messages`, then raw `/api/events?rooms=1` frames (`events`); `expected` projects the list with its unread counts, the open room's messages, its pins and who is typing at `typingAt` (web: `rooms-fixtures.test.ts`). The session cases above stay for the engine.

The web implementation is the reference. After an intended behavior change, regenerate `expected` and port the change to the other clients:

```sh
cd apps/web && UPDATE_TIMELINE_FIXTURES=1 npx vitest run src/lib/timeline-fixtures.test.ts
cd ../.. && npx prettier --write fixtures
```
