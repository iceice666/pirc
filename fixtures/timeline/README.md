# Timeline fixtures

Golden cases shared by every client that turns the gateway's room stream into what a room shows: the web's pure reducer (`apps/web/src/lib/room-events.ts`, test `rooms-fixtures.test.ts`) and the Android port (`apps/android/.../core/rooms`, test `RoomFixturesTest`).

`rooms/` holds them (plans/rewrite/01-rooms.md, 11-web.md): the asking `user`, the room list (`rooms`, as `GET /api/rooms` returns it), the `open` room and its `messages`, optionally the `faces` (`GET /api/faces`) and the `thread` open beside the room with its `threadMessages`, then raw `/api/events?rooms=1` frames (`events`). `expected` projects, after loading and after all events: the list with its unread counts, the open room's messages, its pins, who is typing at `typingAt`, which faces think in which room, what each face is doing, the open thread's messages, each thread's latest worker activity (`threadActivity`, what a worker's anchor shows as its progress) and the loop/wake revisions; `effects` lists what the events asked the client to do next (`mark_read`, `refresh_room`, `refresh_list`, `refresh_thread_workers`), in order.

There are no session cases: the engine shows a session's panes, not its conversation (plan 12 decision 4), so no client projects a session timeline any more.

The web implementation is the reference. After an intended behavior change, regenerate `expected` and port the change to the other clients:

```sh
cd apps/web && UPDATE_TIMELINE_FIXTURES=1 bunx vitest run src/lib/rooms-fixtures.test.ts
cd ../.. && bunx prettier --write fixtures
```
