# Mobile audit (web and Android)

Status (2026-09-28): two audits of `apps/web` and `apps/android` on phones, merged. Fixed items are removed; everything listed is still open. Git history has the full original tables (`plans/mobile-ui-audit.md` at 02f54f7, `plans/mobile-parity-audit.md` at aacce86).

- **Part 1, UI on phones** (performance, crashes, keyboard, safe areas, accessibility): implemented in 26c64e4..eebe05f on top of main@94817f9. Only the deliberately skipped items and the real-device checks are left.
- **Part 2, web ↔ Android parity** (flows and components): the correctness fixes (C4, C5, C6, C16, C18, O-C7, S9, S12, S14, S15, F1, F2 `other` entries, F3, F11, F13, D4) are done, as are the liveness fixes S1, S11, C17, F5, F6, F14, F16, O-C3 and O-F5; the feature and polish findings remain.

Effort: S (under an hour), M (half a day), L (a day or more).

---

## Part 1 — UI on phones

### Still open

| ID  | Item                                                                                                                                                                    | Effort |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| —   | Web i18n: every UI string is hard-coded English (`index.html:2 lang="en"`); the font stack already includes PingFang/JhengHei. Skipped on purpose.                      | L      |
| A7  | Optional: record the pairing time in `CredentialStore` and warn on the sessions screen near the 30-day token limit.                                                     | S      |
| A14 | Optional: `setUnlockedDeviceRequired(true)` on the Keystore key.                                                                                                        | S      |
| L7  | Android build strictness: `lint { abortOnError = true; warningsAsErrors = true }`, a baseline profile (`androidx.profileinstaller`), `androidTest`. Skipped on purpose. | S–M    |

W14's `directory_changed` event is opt-in (`directory=1`) because the Android event parser treats unknown types as a reset.

### Not verified on a device

iOS/Android soft keyboard and safe areas (web W2/W5), CJK IME in the Android composer (A2), the terminal's https asset origin (L5), and the release build on poco-x7-pro.

### Already fine

**Web.** `100dvh` in modals/popovers; `env(safe-area-inset-bottom)` on the composer; `content-visibility: auto` + `MESSAGE_PAGE = 60`; throttled Markdown with lazy KaTeX/hljs/mermaid/xterm; native `<dialog>` focus management; `overscroll-behavior: contain`; `overflow-x: auto` on code, tables and math; debounced drafts flushed on `pagehide`; a separate `aria-live` region.

**Android.** Token: Keystore AES-GCM, `allowBackup=false` with full extraction rules, `followRedirects(false)`, `Pairing.toString` masks the secret, no logging interceptor. WebView: JS only on the local page, `allowFileAccess`/`allowContentAccess` off, `shouldOverrideUrlLoading` blocks everything, remote debugging only in debug. Edge-to-edge with `adjustResize` and `navigationBars.union(ime)`; dynamic colour and dark theme; pull-to-refresh and long-press haptics on the sessions list; every `LazyColumn` is keyed with duplicate-key de-duplication (`SessionScreen.kt:203-209`). Control lease logic is unit-tested and aligned with web; `onCleared` releases the lease.

---

## Part 2 — web ↔ Android parity

Scope: operation flow and feature parity between `apps/web` and `apps/android`. Performance, crash and accessibility items are in part 1. Findings come from three read-only reviews (chat flow, side panels, app shell); the high-priority rows were spot-checked against the source, including the gateway's interaction contract.

`W:` = `apps/web/src/lib/…`, `A:` = `apps/android/app/src/main/java/dev/pirc/android/…`.

### Summary

The event normaliser and reducer are faithful ports (`W:api.ts:405-540` ↔ `A:core/timeline/Events.kt:38-158`, `W:state.ts` ↔ `Events.kt:226-306`); every event web handles, Android handles. The gaps are in what the UI does with the reduced state and in the shell around it:

1. **Android parses but never renders `widgets`/`statuses`** — no goal dock, no todo dock, no status line, no jobs-at-a-glance. On the web these sit right above the composer.
2. The session list has no search, no empty-workspace groups, no per-workspace quick-create. (It now polls every 20 s while shown and reloads when the network returns: the gateway sends no list events outside a session.)
3. **Deferred-by-plan items that now hurt on a phone**: notifications for `waiting_input`, share-sheet entry, restoring the last session on launch.

### Suggested order

**Batch 1 — S items with the biggest felt difference**

- Chat: C3 (status line).
- Shell: S3 (empty workspace groups), S4 (group `+`), S5 (workspace → session), S8 (optimistic pin/settle), O-S1 (restore last session).
- Panels: F15 (memory badge).

**Batch 2 — M, the docks and liveness**

- C1 goal dock, C2 todo dock, C15 jobs badge.

**Batch 3 — larger or deferred**

- S2 search, S10 settings screen, D2 local notifications, O-S2 share sheet, C9 tool card detail, C14 math/mermaid, O-F2 terminal switching.

---

### Chat and composer (`SessionScreen`, `Composer`, `InteractionCard`, messages)

#### Out of sync (web has, Android lacks or differs)

| ID  | Finding                                                                                                                                                                                                                                                                                                              | Web                                                             | Android                                               | Fix                                                                                                                                                                                      | Effort |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C1  | **Goal dock missing.** Web parses widget `goal` (phase, rounds, objective, reason) and offers Pause/Resume (a `/goal pause\|resume` steer). Android stores `widgets` but nothing reads them.                                                                                                                         | `goal.ts:20-33`, `GoalDock.svelte`, `app.svelte.ts:132,434-459` | `core/timeline/Timeline.kt:110` (stored, no consumer) | Port `parseGoalWidget` to `core/Goal.kt` (+ golden test); collapsible card above the composer; Pause/Resume via `perform { command(gen, Commands.message("steer", "/goal pause", …)) }`. | M      |
| C2  | **Todo dock missing.** Web parses widget `local-todo` into a progress meter and task rows.                                                                                                                                                                                                                           | `todo.ts:26-50`, `TodoDock.svelte`, `Composer.svelte:137`       | `Timeline.kt:110`                                     | Port `parseTodoWidget`; collapsed header `done/total` + in-progress headline, expanded list.                                                                                             | M      |
| C3  | **Status line missing.** Web shows the first line of every non-docked widget plus every `statuses` entry except `background-task`/`agent-team` (e.g. compaction warm-up) under the composer.                                                                                                                         | `app.svelte.ts:53-58,133-140`, `Composer.svelte:303-305`        | `Timeline.kt:111`                                     | One `labelSmall` line under the composer card built with the same exclusions.                                                                                                            | S      |
| C7  | Editor interactions: web labels the field `Response · <language>`; Android's `Interaction` has no `language`.                                                                                                                                                                                                        | `InteractionCard.svelte:108-114`                                | `Timeline.kt:82-95`, `Events.kt:182`                  | Add `language`, parse `request.language`.                                                                                                                                                | S      |
| C8  | **Tool-result images not rendered.** Android parses `ToolCall.images` but `ToolCard` never draws them.                                                                                                                                                                                                               | `ToolCard.svelte:221-229`                                       | `Timeline.kt:25`, `ui/session/ToolCard.kt:115-126`    | Reuse `Images()` from `MessageViews.kt:221` in the expanded card.                                                                                                                        | S      |
| C9  | **Tool card detail.** Web: failed tools auto-expand, duration shown, `bash` command highlighted, `write` content as code, `edit` without a diff shows pending `edits` as ±lines, hidden keys stripped from input, "Error" label. Android: collapsed by default, no duration, raw pretty-JSON input, no failed label. | `ToolCard.svelte:29-73,83-86,110,176-219`                       | `ToolCard.kt:88,117-121`                              | `open = tool.status == "failed"` default; `endedAt - startedAt`; special-case `bash.command`, `write.content`, `edit.edits`; label output "Error" when failed.                           | M      |
| C10 | **Thinking rendering.** Web auto-reveals streaming thinking and renders it as Markdown ("Thought" / "Reasoning redacted"). Android hides live thinking unless tapped and shows plain italic text.                                                                                                                    | `Message.svelte:62-63,163-186`                                  | `ui/session/MessageViews.kt:120-121,146-171`          | `visible = open \|\| live`; render with `MarkdownText(linkPaths = false)`.                                                                                                               | S      |
| C11 | **Notice rows.** Web splits `Source: detail` into bold source + detail, collapses long/multi-line notices behind a chevron, Markdown when expanded. Android prints one plain row.                                                                                                                                    | `Message.svelte:55-61,84-109`                                   | `MessageViews.kt:176-189`                             | Same `^([^:]{1,40}):\s+(.+)$` split; expand on tap when multi-line or > 80 chars.                                                                                                        | S      |
| C12 | `custom` system entries are shown inline on web (only compaction/branch/bash/team/background collapse); Android collapses every non-notice system entry.                                                                                                                                                             | `Message.svelte:49-52,111-138`                                  | `MessageViews.kt:190-217`                             | `open = systemKind == "custom"` initial state.                                                                                                                                           | S      |
| C13 | Message timestamps: web shows `HH:MM` on finished messages and system entries; Android shows none.                                                                                                                                                                                                                   | `Message.svelte:100,124,234`                                    | `MessageViews.kt:137-142`                             | `labelSmall` time next to Copy/model.                                                                                                                                                    | S      |
| C14 | Markdown: web renders GFM tables, hljs, KaTeX math and mermaid; Android (mikepenz) has code highlight only.                                                                                                                                                                                                          | `markdown.ts:4-7,58-88`                                         | `MessageViews.kt:72-87`                               | Math via a small WebView/KaTeX or a monospace fallback; mermaid as a code block with a "diagram" badge.                                                                                  | L      |
| C15 | **Jobs at a glance.** Web's top bar shows "N running / N background tasks" with output tail and two-press Stop, refreshed on `panel_changed` and run end. Android only reaches this via More → Tasks (separate screen).                                                                                              | `JobsMenu.svelte:41-56,178-191`, `App.svelte:398`               | `ui/SessionScreen.kt:125-131`                         | Live-task count badge on "More" (or a chip in the subtitle) from a light `panel/state` fetch on `PanelChanged(background/team)`.                                                         | M      |
| C19 | **No optimistic user message.** Web appends the user's message (and attachments) to the transcript on prompt/steer before t                                                                                                                                                                                          |

[… 347 bytes truncated …]

in `send()`; the reducer's duplicate-id handling already keeps the newest copy. | S |

#### Android-only (keep; consider porting to web)

| ID  | Finding                                                                                      | Android                                   | Web                     |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------- |
| AC1 | Thinking levels narrowed per model (`reasoning` → `off` only); web always lists six.         | `Control.kt:70,90`, `Composer.kt:290-293` | `Composer.svelte:41-48` |
| AC2 | Attachment guardrails: ≤ 4 per pick, 8 MiB cap, JPEG re-encode ≤ 2560 px; web has no limits. | `Composer.kt:136`, `Images.kt:23-50`      | `app.svelte.ts:557-589` |
| AC3 | "Open <file>" button in tool cards from `path/file_path/filePath`.                           | `ToolCard.kt:59-65,122-124`               | —                       |
| AC4 | Run status in the app-bar subtitle ("Running", "Needs your input", "Last run failed").       | `SessionScreen.kt:190-205`                | connection/control only |
| AC5 | Explicit "Take control of this session first." error; web silently no-ops.                   | `SessionViewModel.kt:451-455`             | `app.svelte.ts:372-373` |
| AC6 | Lease released on leaving the session.                                                       | `SessionViewModel.kt:204-210`             | —                       |

#### Optimisation opportunities (Android)

| ID   | Finding                                                                                                                                                       | Where                                     | Fix                                                                            | Effort |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| O-C1 | Queue list is the bottom-most timeline item; web docks it above the composer (kind icon, 2-line clamp, collapse, Clear) so it stays visible when scrolled up. | `SessionScreen.kt:245-248,280-298`        | Render `Queue` inside `Composer` above the card; clamp text to 2 lines.        | S      |
| O-C2 | Model/level picker is one modal sheet with two wheels; changing only the thinking level costs 3 taps.                                                         | `Composer.kt:207-230,279-327`             | Split the label into two targets: model → wheel sheet, level → `DropdownMenu`. | S      |
| O-C4 | Single-select interactions need row tap + Submit.                                                                                                             | `InteractionCard.kt:69-96`                | For `!multiple`, submit on row tap; keep the button for multi.                 | S      |
| O-C5 | `select` interactions with many options overflow the card.                                                                                                    | `InteractionCard.kt:71-88`                | `heightIn(max = …)` + `verticalScroll`.                                        | S      |
| O-C6 | "Copied" state never resets; the copy button on user bubbles adds a row per message.                                                                          | `MessageViews.kt:112,234-245`             | Reset after ~1.5 s; move copy into a long-press menu on the bubble.            | S      |
| O-C8 | Top-bar actions are text ("Files", "More") and take title space; web uses icon buttons.                                                                       | `SessionScreen.kt:124-125`, `ui/Icons.kt` | Add `MoreVertical`, `Folder` paths to `PircIcons` and use `IconButton`s.       | S      |

---

### App shell (pairing, session list, creation, settings, connection)

#### Out of sync

| ID  | Finding                                                                                                                                                                                                               | Web                                                         | Android                             | Fix                                                                                                                                                   | Effort |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| S2  | **No search/filter.** Web filters by name and by node ("Devices: All / node").                                                                                                                                        | `Sidebar.svelte:58-70,189-213`                              | `SessionsScreen.kt:100-185`         | `SearchBar` in the top bar filtering `groups` by `Session.name`; optional node `FilterChip` row.                                                      | S–M    |
| S3  | **Workspaces without sessions are invisible.** Web lists every workspace as a group (with `+`); Android groups from sessions only, so a freshly added or emptied workspace appears only inside the New-session sheet. | `Sidebar.svelte:224-250`                                    | `core/SessionGroups.kt:27`          | Seed `groupSessions` from `workspaces`; render "No sessions — tap + to start".                                                                        | S      |
| S4  | **Per-workspace quick-create.** Web's group header `+` creates and opens in one tap. Android: FAB → sheet → pick.                                                                                                     | `Sidebar.svelte:244-249`, `App.svelte:324-336`              | `SessionsScreen.kt:128-135,187-198` | `+` `IconButton` in `GroupHeader` → `viewModel.createSession(group.workspaceId, onOpen)` (disabled when offline).                                     | S      |
| S5  | **Add workspace → session.** Web creates the session right after adding the workspace; Android reopens the picker and needs another tap.                                                                              | `App.svelte:526-530`                                        | `SessionsScreen.kt:199-206`         | `createWorkspace(...) { ws -> createSession(ws.id, onOpen) }`.                                                                                        | S      |
| S6  | Add-workspace node preselect / zero-node state. Web preselects the filtered node; Android always `nodes.first()`, and with zero nodes shows "No node is online." above an enabled-looking form.                       | `Sidebar.svelte:216-221`, `NewWorkspaceDialog.svelte:24-35` | `ui/SessionActions.kt:90,100`       | Pass the tapped group's node; hide fields when `nodes.isEmpty()`, offer Refresh.                                                                      | S      |
| S7  | **Settled sessions.** Web hides them unless "Show settled sessions" (persisted); Android shows an "N settled" expander whose state is `remember`ed only (resets).                                                     | `App.svelte:62,117`, `SettingsDialog.svelte:68-75`          | `SessionsScreen.kt:170-181`         | Persist the expander (or the web toggle) in `LocalStore`.                                                                                             | S      |
| S8  | **Optimistic session updates.** Web applies rename/pin/settle at once and rolls back on error; Android waits for the PATCH reply.                                                                                     | `app.svelte.ts:325-345`                                     | `AppViewModel.kt:203-216`           | `replaceSession(copy)` first, reconcile with the reply, restore on error.                                                                             | S      |
| S10 | **No settings screen.** Web Settings: show-settled, layout reset, backends (deferred), provider login (deferred), nodes with online count, paired phones, client id. Android: only "More → Unpair this phone".        | `SettingsDialog.svelte:18-23,101-138`                       | `SessionsScreen.kt:116-124`         | `SettingsRoute`: gateway host, client id, nodes online + workspace counts (already fetched), settled toggle, Unpair, "Backends: set on the web" hint. | M      |
| S13 | Relative time: web `shortAgo` ("5m", "3h"); Android `DateUtils` ("5 min. ago", "Yesterday") wraps on narrow rows.                                                                                                     | `time.ts:18-24`, `Sidebar.svelte:352`                       | `SessionsScreen.kt:280`             | `shortAgo(ms)` in `core` mirroring `time.ts`.                                                                                                         | S      |

#### Android-only (keep)

| ID  | Finding                                                                                                            | Android                                                     | Web could adopt                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| AS1 | Deep-link pairing with confirmation (`pirc://pair`), ML Kit QR scan, paste fallback, HTTPS-only origin validation. | `MainActivity.kt:31-34`, `PircApp.kt:158-171`, `Pairing.kt` | Show "Open in app" only on Android UAs (`PairedDevices.svelte:126`). |
| AS2 | 401 anywhere → automatic unpair with the gateway's reason shown once.                                              | `AppViewModel.kt:227-241`, `PairScreen.kt:76-78`            | —                                                                    |
| AS3 | Workspace name suggested from the last path segment; path defaults to `~/`.                                        | `SessionActions.kt:91-94,120`                               | Port: default `name` from `path` basename.                           |
| AS4 | New-session sheet sorts online workspaces first, alphabetically.                                                   | `SessionActions.kt:60`                                      | Port.                                                                |
| AS5 | Session actions reachable from inside the session (More menu) and via long-press on the list.                      | `SessionScreen.kt:126-148`, `SessionActions.kt:135-157`     | —                                                                    |
| AS6 | Pull-to-refresh, sticky workspace headers, gateway host under the title.                                           | `SessionsScreen.kt:107-113,138-142,166`                     | —                                                                    |

#### Deferred by plan (`plans/android-client.md`) — does it hurt now?

| ID  | Item                                                                                     | Verdict                                                                                                                                                                                                                                                            | Effort |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| D1  | Backend settings / provider login / default model (tokens are denied `/api/providers*`). | Does not hurt: the composer picks per-session models. Only the _default_ for new sessions cannot be set from the phone. Leave deferred; hint in S10.                                                                                                               | —      |
| D2  | **Notifications** for run finished / `waiting_input`.                                    | **Hurts.** The app is backgrounded most of the time; `waiting_input` is only discoverable by reopening. Minimum: a local notification on `interaction_created`/`agent_end` while the stream is still alive in `STOP_GRACE_MS`; full solution needs a push channel. | L      |
| D3  | Offline mode.                                                                            | Roughly at parity with the PWA (drafts persist; lists do not). Optional: cache last `SessionsState` in `LocalStore` and render greyed.                                                                                                                             | M      |

#### Optimisation opportunities (Android shell)

| ID   | Finding                                                                                                           | Where                       | Fix                                                                                                          | Effort |
| ---- | ----------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| O-S1 | **Restore the last open session on launch.** Web opens `sessions[0]`; Android always lands on the list.           | `PircApp.kt:74-77`          | Store last session id/name in `LocalStore`; on start `navigate(SessionRoute)` with `popUpTo(SessionsRoute)`. | S      |
| O-S2 | **Share-sheet entry.** No `ACTION_SEND` filter; sharing text/images from other apps into a session is impossible. | `AndroidManifest.xml:26-36` | `ACTION_SEND` (`text/plain`, `image/*`) → session picker sheet → prefill draft / `attach()`.                 | M      |
| O-S3 | Workspace groups cannot collapse (web `collapsedGroups`).                                                         | `SessionsScreen.kt:165-169` | Clickable `GroupHeader`; persist collapsed ids.                                                              | S      |
| O-S4 | New-session sheet does not remember the last-used workspace.                                                      | `SessionActions.kt:60`      | `lastWorkspaceId` in `LocalStore`, pinned to the top as "Recent".                                            | S      |
| O-S5 | Empty state is plain text; when there are no workspaces/nodes the real first step is different.                   | `SessionsScreen.kt:156-164` | Branch on `nodes`/`workspaces` and offer an "Add workspace" button.                                          | S      |
| O-S6 | Pasted pairing link is validated only on "Pair".                                                                  | `PairScreen.kt:83-96`       | `PairingLink.parse` on change with inline `isError`/supporting text.                                         | S      |
| O-S7 | Pinned rows use a "Pinned · " text prefix; web shows a pin glyph.                                                 | `SessionsScreen.kt:278-281` | `leadingContent = { Icon(PircIcons.Pin) }`.                                                                  | S      |

---

### Side panels (Files, Git, Tasks, Memory, Terminal)

#### Out of sync

| ID  | Finding                                                                                                                                                                                                                                                  | Web                                      | Android                                              | Fix                                                                               | Effort |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- | ------ |
| F2  | Symlinks get no distinct icon (on either client).                                                                                                                                                                                                        | —                                        | `ui/files/FilesPane.kt:102-118`                      | Link icon for `symlink`.                                                          | S      |
| F4  | Git diff header links to the file in Files; Android `DiffScreen` has no "open file" action.                                                                                                                                                              | `GitTab.svelte:182-189`                  | `ui/panels/GitPane.kt:203-232`; `PircApp.kt:116-120` | Top-bar action → `FileRoute(sessionId, path)`.                                    | S      |
| F7  | No "No commits yet." empty state; diff drill-in lacks the status chip (`Staged`/`Modified`…).                                                                                                                                                            | `GitTab.svelte:190-192,302-303`          | `GitPane.kt:106-114,209-218`                         | Add empty item; append `GIT_LABELS[code]` to the subtitle.                        | S      |
| F8  | Tasks: `agentRunning` unused (no "agent is not running" explanation); background tasks not newest-first; no elapsed duration; `matches` for `notifyOn` not shown; team events lack timestamps.                                                           | `TasksTab.svelte:57,114-117,131-141,218` | `ui/panels/TasksPane.kt:67-70,98-104,130-139`        | Use `agentRunning`; `asReversed()`; duration + "watch N"; event time.             | S      |
| F9  | Task output sheet does not scroll to the tail on load/refresh.                                                                                                                                                                                           | `TasksTab.svelte:50`                     | `TasksPane.kt:204`                                   | Scroll to the last line after each load.                                          | S      |
| F10 | Memory status: web shows human phase labels and an Idle/Agent-stopped chip, and distinguishes `memory == null` (unavailable) from `!enabled` (disabled in config). Android shows raw `Working: observer` and merges the two into "off for this session". | `MemoryTab.svelte:47-52,82-97`           | `ui/panels/MemoryPane.kt:59-61,74`                   | Port `phaseLabel`; idle chip from `agentRunning`; split null vs disabled.         | S      |
| F12 | Reflections omit the "N sources" count and id; observations omit id; both render full content (web clamps to 3 lines, tap to expand).                                                                                                                    | `MemoryTab.svelte:144-158,181-198`       | `MemoryPane.kt:102-104,115-122,149-165`              | Sources count + monospace id; `maxLines = 3` with expand.                         | S      |
| F15 | Tab badges: web dots Tasks (running) and Memory (phase active); Android badges Git + Tasks only, and Git only after the Git tab loaded.                                                                                                                  | `SidePanel.svelte:112-116`               | `PanelsScreen.kt:96-100`                             | Badge Memory when `memoryRuntime.phase != null`; load git status on screen start. | S      |

#### Android-only (keep)

| ID  | Finding                                                                                                                                           | Android                                                                                        | Note                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------- |
| AF1 | File viewer: wrap toggle, Copy path, Copy contents, Reload, relative modified time.                                                               | `FileScreen.kt:91-114`                                                                         | Port the wrap toggle to web.           |
| AF2 | Hardware Back goes up one folder.                                                                                                                 | `FilesPane.kt:59`                                                                              |                                        |
| AF3 | Stop background task from the Tasks pane — but single tap, no confirmation (web arms with two presses).                                           | `TasksPane.kt:199`; `PanelsViewModel.kt:260-264`                                               | Add a confirm/arm step. S              |
| AF4 | Task row shows `task.error`; sheet shows `cwd`. Memory shows `visiblePool` and per-observation tokens.                                            | `TasksPane.kt:137,193`; `MemoryPane.kt:82,118`                                                 |                                        |
| AF5 | Terminal: `cwd` and `cols×rows` in the list, in-place "Take control", pinch-zoom font (persisted), Ctrl chip + key row, IME composition handling. | `PanelsScreen.kt:145-168`; `TerminalScreen.kt:95-98,207,262-267`; `TerminalWebView.kt:113-152` |                                        |
| AF6 | Terminal list polled every 5 s while shown; web loads once and learns exits via the socket.                                                       | `PanelsViewModel.kt:155-158`                                                                   | Stop polling when the list is empty. S |

#### Optimisation opportunities (Android panels)

| ID   | Finding                                                                                                                                                               | Where                                                         | Fix                                                                                         | Effort |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| O-F1 | Deep link from chat opens `FileRoute` with no "reveal in folder"; web also navigates the folder list to the parent.                                                   | `PircApp.kt:89,141-153`; `FileScreen.kt:69-116`               | Tappable subtitle path → `PanelsRoute(Files)` with `files.open(parent)`.                    | S      |
| O-F2 | Switching terminals is list → tap → new screen; each `stop()` closes the socket, so switching reconnects and replays. Web keeps every xterm alive behind a tab strip. | `TerminalViewModel.kt:150-156`; `PircApp.kt:126-140`          | Session-scoped `TerminalViewModel`s, or a `HorizontalPager` of terminals with a chip strip. | L      |
| O-F3 | Key row lacks Paste and `^C`; copying from the WebView is not exposed (multi-touch swallowed at `TerminalWebView.kt:69`).                                             | `TerminalScreen.kt:95-98,262-267`; `TerminalWebView.kt:58-71` | Paste (`LocalClipboard` → `viewModel.input`) and `^C` chips; "Copy screen" via the bridge.  | S–M    |
| O-F4 | Multi-file commit diffs have no file-level navigation (web has sticky file headers).                                                                                  | `ui/panels/DiffView.kt:63-67`                                 | `stickyHeader` for `Kind.File` rows + "jump to file" dropdown.                              | M      |
| O-F6 | Git rows use one "Changed" colour for `R/C/T/U` and show `?` literally; web maps `?→U` and colours R/C accent, D red.                                                 | `GitPane.kt:143-148`                                          | Map `"?"→U`; colours for `R/C` and conflict.                                                | S      |
| O-F7 | Breadcrumb `LazyRow` does not scroll to the current segment on long paths.                                                                                            | `FilesPane.kt:63-70,85`                                       | `LaunchedEffect(segments) { animateScrollToItem(last) }`.                                   | S      |
| O-F8 | Task output renders 400 lines in a non-lazy `Column` capped at 2 000 dp.                                                                                              | `TasksPane.kt:189-205`                                        | `LazyColumn` of lines (reuse `CodeView` with `wrap = true`).                                | S      |

---

### Already aligned

Event normalisation and reducer (shared golden fixtures); control-lease sync and heartbeat; Steer as the default active-run send with per-item send-now and Clear queue; `set_model`/`set_thinking` applied before the first prompt; interaction answer shapes for select/input/editor; image upload flow; file-link parsing (`file-links.ts` ↔ `FileLinks.kt`); Files/Git/Tasks/Memory/Terminal endpoints all reachable; pin/settle/rename; the 401 → re-pair path.

### Not verified

Everything in part 2 is from reading source; nothing was built or run on a device. The fixes were checked by web typecheck/tests and Android unit tests plus a debug build, not on a device.
[exit 0]
