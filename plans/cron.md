# Scheduled agent runs (cron)

Status (2026-09-29): phases 1 (gateway core, agent tool, `/cron`) and 2 (web) implemented and tested, uncommitted. Phases 3–5 not started.

## As built (phase 1)

- `daemon/session-dispatch.ts`: code shared by Delegations and Schedules. It starts and names a session on its node, delivers a custom message, and reads the session's progress. Delegations was refactored to use it, with its behavior unchanged (its tests pass).
- `daemon/schedules.ts` (`Schedules`) with migration 11 (`schedules`, `schedule_runs`, `schedule_proposals`):
  - One timer, re-checked at least hourly.
  - A fire time reached more than 2 minutes late becomes one `missed` run, for the latest fire time missed.
  - A fire time with the node offline is also `missed`.
  - A fire time while the previous run is still open is `skipped`.
  - A one-shot becomes `done` after it fires.
  - When the owner is no longer allowed, or the workspace is gone, the schedule is paused and a `failed` run explains why.
  - The history keeps the newest 50 runs. Open and missed runs are never pruned.
- An agent's proposals: `schedule_proposals`. They expire after `PIRC_DELEGATION_TTL_MS`, and they are answered through the chat's interaction route, like delegations. Approval re-validates the proposal, since a one-shot may have passed while it waited.
- Model: the node's `POST /api/sessions/:id/deliver` accepts an optional `model` / `thinking` and sends `set_model` / `set_thinking_level` before delivering. Session creation is unchanged.
- REST:
  - `GET/POST /api/schedules`
  - `GET/PATCH/DELETE /api/schedules/:id` (PATCH also takes `status: active|paused`)
  - `POST /api/schedules/:id/run` (`{ runId }` allows a missed run)
  - `POST /api/schedules/:id/runs/:runId/dismiss`
  - The events WS takes `schedules=1` and sends `schedules_changed`.
- AgentOps: `schedule.list|create|update|pause|resume|delete|run`.
  - Chats may target their own chat or any directory workspace; other sessions may target only their own.
  - A session started by a scheduled run cannot create, update, resume or run schedules. It may still pause or delete them.
- Agent: the `schedule` tool plus `/cron [list | pause|resume|delete|run <id>]` (`agent/features/schedules.ts`). Both exist only with a gateway, and `features.schedules.enabled: false` turns them off.
- `PIRC_TIMEZONE`: the gateway's default time zone for schedules. It defaults to the system's, and an invalid value fails at startup.
- New dependency: `croner` (`nodeModulesHash` updated).
- Tests: `test/schedules.integration.test.ts` and `test/agent-schedules.test.ts`.

## As built (phase 2, web)

- Settings → **Schedules** (`lib/components/ScheduleSettings.svelte`, API client and helpers in `lib/schedules.ts`).
  - The list shows the cron expression in words ("Weekdays at 09:00 (Asia/Taipei)"), the workspace, node, model and thinking level, the next run, the last run, and whether the assistant proposed it.
  - Actions: Runs, Run now (off while the node is offline), Pause/Resume, Edit, and Delete (a second click confirms).
  - Run history: status, due time and result. A missed run has "Allow and run now" and "Dismiss"; a run with a session has "Open session".
  - The form has a workspace picker (node workspaces only), title, prompt, and Repeat (cron plus presets) or Once (`datetime-local`, read in the chosen time zone). The time zone defaults to the device's, and the picker lists every IANA zone. Model and thinking are optional.
- The gateway's schedule view adds `attention`: the number of missed and `waiting_input` runs. The app keeps the total in `app.scheduleAttention` and shows it as a badge on Settings (sidebar) and on the Schedules tab. Opening Settings goes to Schedules when no memory proposal is waiting.
- The events WS subscribes with `schedules=1`; `schedules_changed` bumps `app.scheduleRevision`, so an open page reloads.
- Chat: a `scheduled-run` message is labelled "Scheduled task", with the schedule's title (`pi-messages.ts`).
- Tests: `lib/schedules.test.ts`, `lib/components/ScheduleSettings.test.ts`, plus additions to `events.test.ts` and `pi-messages.test.ts`. Checked by eye at desktop and phone widths, against a mocked API.

### Phase 1 follow-ups

- Android: render the `scheduled-run` custom message, and add the Schedules screen (phase 3).
- Push notifications (phase 4). The hook is `ScheduleDeps.changed(user)`, which today only feeds the events WS.
- README / `nix/module.nix`: document `PIRC_TIMEZONE` and schedules (phase 5).
- Deployment: the node's deliver body changed (`scheduled-run`, `model`, `thinking`), so deploy the gateway and nodes together.

## Decisions from the user

- **What**: scheduled agent tasks. At a scheduled time, a prompt runs as an agent turn (like OpenClaw cron / Claude scheduled tasks). This is not system maintenance and not a systemd timer.
- **Where**: the gateway daemon owns the schedules and the timer, and it can target any node/workspace.
- **Session**: every run gets a **new session**.
- **Managed from**: an agent tool, the web UI, Android, and a slash command (`/cron`).
- **Agent authorization**: when the agent creates or edits a schedule, the user confirms it in the chat, the same way as a delegation. Pausing, resuming and deleting need no confirmation. Schedules made from the UI or the slash command are the user's own actions, so they are not confirmed again.
- **Scope of the agent tool**: assistant (chat) sessions may target any workspace in the delegation list. Every other session can only target its own workspace.
- **Notifications**: the schedule list shows the status and result of each run, **and** a push notification is sent (PWA and Android).
- **Time syntax**: a 5-field cron expression plus an IANA time zone, or a one-shot time.
- **Missed runs** (gateway down or node offline at fire time): they are **not** run automatically. The run is recorded as `missed`, and the user has to allow it (the "Run now" action) before it runs.

## Design

### Data (gateway SQLite, new migration)

```
schedules(
  id TEXT PRIMARY KEY,            -- s<hex>
  owner_user TEXT NOT NULL,
  workspace_id TEXT NOT NULL,     -- gateway workspace id (node-prefixed)
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cron TEXT,                      -- 5-field; NULL for one-shot
  run_at INTEGER,                 -- one-shot time (ms); NULL for cron
  timezone TEXT NOT NULL,         -- IANA, e.g. Asia/Taipei
  enabled INTEGER NOT NULL,
  status TEXT NOT NULL,           -- pending_approval | active | paused | done (one-shot fired) | rejected
  created_by_session TEXT,        -- the chat that proposed it (agent-created), else NULL
  next_run_at INTEGER,
  created_at, updated_at
)
schedule_runs(
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,        -- the planned fire time
  status TEXT NOT NULL,           -- missed | skipped | running | waiting_input | completed | failed
  session_id TEXT,                -- gateway session id of the run
  result TEXT,                    -- clipped + redactSecrets, like delegations
  started_at, finished_at, notified_status
)
```

### Scheduler (`daemon/schedules.ts`, class `Schedules`)

- A single timer is armed for the earliest `next_run_at` and re-armed after every change. It never uses per-schedule `setInterval`, and it clamps to about 2^31 ms.
- Next-time calculation uses **`croner`** (new dependency: zero-dependency, handles time zones and DST). Bun 1.4's `Bun.cron.parse` has no time zone option: it only uses the process TZ.
- When a run falls due:
  - If the owner is no longer in `allowedUsers`, or the workspace no longer exists, pause the schedule.
  - If the previous run of the same schedule is still `running` or `waiting_input`, write a `skipped` run.
  - If the target node is offline, write a `missed` run and push a notification.
  - Otherwise, dispatch.
- **Catch-up at startup**: for every active schedule whose `next_run_at < now`, write **one** `missed` run for the most recent missed time only, however many were missed. Then advance `next_run_at` to the next future time. Nothing runs by itself.
- A **dispatch** reuses Delegations' flow: move the create-session / name / deliver / follow `agent_settled` / snapshot-check code into a shared helper (`daemon/session-dispatch.ts`), and have both Delegations and Schedules use it. The prompt is delivered as `customType: 'scheduled-run'` with `details: { scheduleId, runId, title }`. It never counts as the user's own words.
- `waiting_input` (a dangerous command waiting for confirmation, or ask_user) → a push notification. The user opens that session to handle it.
- `completed` / `failed` → the result is written to the run, and a push notification is sent.
- The runs of each schedule keep the last 50 entries.

### API (daemon, owner-scoped)

- `GET /api/schedules`, `POST /api/schedules`, `PATCH /api/schedules/:id` (edit/pause/resume), `DELETE /api/schedules/:id`
- `GET /api/schedules/:id/runs`
- `POST /api/schedules/:id/run` — "Run now". This also approves a `missed` run (`{ runId }` marks that missed run as handled).
- Validation: the cron expression parses, the time zone is valid (`Intl.supportedValuesOf('timeZone')`), a one-shot time is in the future, and the owner may access the workspace.
- The events WS broadcasts `schedules_changed`, so clients reload.

### Agent side

- New AgentOps: `schedule.list`, `schedule.propose` (create/edit → `pending_approval` plus a confirm interaction in the chat that proposed it, the same as `Delegations.pendingInteractions`), `schedule.pause`, `schedule.resume`, `schedule.delete`.
  - The target workspace check happens on the gateway. A chat workspace may choose any workspace from `delegations.workspaces()`. Any other session is forced to `context.workspace`.
- The tool in `agent/features/schedules.ts` is registered only when the agent has a gateway (the same condition as web_search). There is a single `schedule` tool with `action: list|create|update|pause|resume|delete`.
- Slash command `/cron` in the agent: `list`, `pause <id>`, `resume <id>`, `delete <id>`, `run <id>`. Creating a schedule is left to natural language or the tool, so there is no fiddly command-line syntax.
- The session a run starts in can see that it is a scheduled run (from the custom message). It must not create another schedule in it: `schedule.propose` refuses to run from inside a scheduled-run session, so schedules cannot multiply.

### Web UI

- Settings → "Schedules" page: the list shows the title, the workspace, a human-readable description of the cron expression, the next run, and the last status. You can create, edit, pause, and delete schedules. The detail view shows the run history. Clicking a run opens its session. Missed runs have an "Allow and run now" button.
- The chat renders a `scheduled-run` custom message (label "Scheduled", with the title), the same way as `pi-messages.ts` handles skill messages.

### Android

- `SchedulesScreen`, with the same features as the web page. `PiMessages.kt` renders `scheduled-run`.

### Push notifications (new infrastructure, currently absent from the repo)

- **Web / PWA**: Web Push with VAPID.
  - The gateway generates or reads VAPID keys (`PIRC_VAPID_*` or a state file).
  - `POST /api/push/subscriptions`
  - The service worker handles `push` and `notificationclick` (it opens the session or the schedule page).
  - Sent with the `web-push` dependency.
- **Android**: UnifiedPush. The app registers a distributor endpoint with the gateway, and the gateway POSTs to it (encrypted as RFC 8291 through `web-push`).
- Events that push: a run `completed` / `failed` / `waiting_input` / `missed`. Push only carries the title and a short summary: the result text stays out of third-party push services.

## Phases

1. Gateway core: migration, `Schedules`, the Delegations dispatch refactor, the API, AgentOps, the agent tool, `/cron`, and tests (fake clock: cron, DST, missed catch-up, skip on overlap, approval, cross-workspace permission).
2. The web Schedules page and message rendering.
3. The Android Schedules screen and message rendering.
4. Push: Web Push, then Android.
5. README / nix/module.nix documentation (VAPID keys, the time zone default).

## Resolved (2026-09-29)

- Android push: **UnifiedPush** (the user runs their own distributor, e.g. ntfy). No FCM.
- Web Push: use the **`web-push`** dependency.
- Time zone: UI-created schedules default to the device's time zone, agent-created ones to the gateway's TZ. Either can be changed.
- Model: **each schedule can set its own** `model` / `thinking`. Without one, the default applies. This needs a model option on the node's `POST /api/sessions`, or a set_model call before deliver.
- Scope of this round: **phase 1 only** (gateway core, agent tool, `/cron`, tests). Report back when it is done.
