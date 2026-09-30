# Browser tools (Playwright): web_fetch, interaction, live view, takeover, recording

Status (2026-09-29): phases 1–6 implemented and tested (committed in 22699b8). The design below is as built, apart from the corrections in "As built". Open follow-ups are at the end.

## As built

- **Transport**
  - Agent ↔ node: `browser_request` / `browser_response` / `browser_cancel` on the agent's stdio. This mirrors the write lease: `agent/browser-channel.ts` on the agent side, `PiRunner.handleBrowser` in `node/runner.ts` on the node side.
  - Live view: reuses the terminal relay. `terminal_open` has `kind: 'browser'`, served by `BrowserStreams` in `node/panel-routes.ts` and by `GET /api/sessions/:id/browser/stream` (WS) on the daemon.
  - Live frames are dropped, not queued, when the link backs up: above 4 MiB on the node, 2 MiB at the daemon.
- **Screencast**: Playwright 1.63's `page.screencast.start({ onFrame })`. `screencast.showActions()` draws the agent's clicks and typing into the frames, which covers the "action overlay". Its `path` recording needs Playwright's own ffmpeg download, so recordings pipe frames to the system ffmpeg instead.
- **Tools** (`agent/features/browser.ts`):
  - Page tools: `web_fetch`, `browser_navigate` (`url: "back"` goes back), `browser_snapshot`, `browser_click`, `browser_type`, `browser_select`, `browser_press`, `browser_wait_for`, `browser_screenshot`, `browser_tabs`.
  - `browser_handoff` shows a confirm dialog while the node is in user mode. Whichever comes first ends it: the dialog, or "Return control" in the panel.
  - `browser_record`.
  - There is no `hover` or `close` tool; idle tabs close after `PIRC_BROWSER_IDLE_MS`.
- **Concurrency**: agent operations on a session's tabs run one at a time, as a per-tab chain, because PTC can fire several `web_fetch` calls at once.
- **Recordings**:
  - Served with HTTP `Range` by the daemon (`GET /api/sessions/:id/browser/recording?path=`). The daemon pulls 4 MiB base64 chunks from the node, since node frames are JSON and capped at 16 MiB.
  - Web: an inline `<video>` in the tool card and in the panel's activity list.
  - Android: the file is downloaded to the cache and played in `VideoView`, because it needs the bearer token.
- **Android**:
  - Panels → Browser → "Open browser" opens a full-screen `BrowserScreen`: taps become clicks, drags become scroll-wheel events, and the shared `TerminalInputView` keyboard handles IME, with its bytes mapped to Playwright keys.
  - The session menu has a Browser entry, and tool cards show "Play recording".

## Follow-ups (not done)

- Verify on a real Linux node with nixpkgs `chromium`. The Playwright 1.63 CDP protocol is expected to work with a newer Chromium, but this is unverified. Also run the full `nix build`: the flake only sees git-tracked files, so it can run only after the new files are committed.
- Verify on a real device: Android takeover (tap mapping, IME typing, drag scrolling) and WebM playback.
- Auto mode does not judge browser actions (it covers shell actions only). Consider a classifier pass for `browser_click`/`browser_type` on non-localhost origins, together with the network taint tagging item in `plans/assistant.md`.
- Teammates and subagents have no browser. Sharing the parent's tabs would need a lock or a separate tab group per child.
- The action log (with screenshots) lives in the node's memory only, and is lost on a node restart. Recordings persist.
- Page content is marked "untrusted" in tool results and the system prompt, but it is not yet tagged for observational memory's provenance.

Decisions from the user:

- Agent gets `web_fetch` **and** interactive browser tools (navigate / click / type / snapshot / screenshot).
- Live view and takeover by streaming the page over CDP screencast into the web side panel (same path as terminals). No VNC/Xvfb.
- **Both** live view (watch or take over while the agent works) and recording (video for reviewing front-end work).
- One persistent browser profile per workspace: log in once, and every session in that workspace reuses it.
- Recordings go to `$workspace/.pirc/recordings/`.
- `web_fetch` always uses the browser (no plain-HTTP fast path), so logins apply and every fetch shows in live view.
- Start with the phase 1 spike and report back before going further.

---

## Architecture

```
agent subprocess ──node_request (stdin/stdout)──▶ node: BrowserManager ──CDP──▶ Chromium (1 per workspace, persistent profile)
                                                        │
web side panel ◀── WS ── daemon relay ◀── node link ── screencast frames / input events
```

### Why the node owns the browser

- A persistent `userDataDir` is locked by a single Chromium process, so all sessions in a workspace must share one owner. Agent processes restart; the node does not.
- This is the same lifetime model as `node/terminals.ts`: it outlives browser connections and ends with the node.

### Components

1. **`node/browser.ts` — `BrowserManager`**
   - `playwright-core` `chromium.launchPersistentContext(profileDir, { executablePath, headless: true, viewport })`. `executablePath` comes from config (nix: `pkgs.chromium` / `playwright-driver.browsers`). We do not download browsers at runtime.
   - Profile dir: `$PIRC_STATE/browser/<workspaceId>/profile`.
   - One **tab per session**, created lazily. Idle browsers close after N minutes; the profile persists.
   - Limits like terminals: at most N live browsers per node and N tabs per session.
   - Per-tab state `mode: 'agent' | 'user'` for takeover (see below).
2. **Agent → node channel.** The existing `gateway_request` goes to the daemon. Add a sibling `node_request` op family (`browser.*`) that the runner answers locally, without relaying. Tools stay in the agent's feature set, so the model sees them normally, and they work in PTC.
3. **Tools** (`agent/features/browser.ts`, disable with `features.browser.enabled=false`):
   - `web_fetch({url, format?: 'markdown'|'text'|'html', maxChars?})` renders in the session tab (JS executed, cookies from the profile), then returns readable markdown. It is also the entry point that surfaces login walls.
   - `browser_navigate`, `browser_snapshot` (accessibility tree with stable `ref`s, like Playwright MCP), `browser_click({ref})`, `browser_type({ref, text, submit?})`, `browser_select`, `browser_press`, `browser_screenshot` (returns an ImageContent), `browser_tabs`.
   - `browser_handoff({reason})` asks the human to take over (login, captcha, sensitive form), blocks until the human presses "Return control" or cancels, then returns a fresh snapshot. It is unavailable when `!hasUI`.
4. **Live view** (`panel` tab "Browser").
   - `Page.startScreencast` (JPEG, quality/size adapted to the panel), frame acks for back-pressure, and only while a viewer is attached. The relay reuses the terminal stream frames (`browser_frame` / `browser_closed` in `daemon/nodes.ts`, `RELAYED_*` routes in `daemon/app.ts`).
   - Frame overlay shows the agent's current action (for example "click ref=e12 'Submit'") from tool events.
5. **Takeover.**
   - Pressing "Take over" in the panel requires the session **control lease**, the same authority as terminals and prompting. The tab switches to `mode:'user'`.
   - The panel forwards mouse/wheel/keyboard/IME text through `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`. Coordinates are scaled from the viewer size to the viewport. There is a URL bar with back/forward/reload.
   - While `mode:'user'`, agent browser tools **wait** (up to a timeout, abortable) instead of fighting the user. The tool result says the user took over, and gives the new URL/snapshot after return.
   - "Return control" switches back to `mode:'agent'` and resolves a pending `browser_handoff`.
6. **Recording.**
   - `browser_record({action:'start'|'stop', name?})`, plus a Record button in the panel.
   - Implementation: screencast frames (timestamped) are piped to `ffmpeg` → `webm`/`mp4` under `$workspace/.pirc/recordings/` (or state dir). That works with a persistent context, where Playwright's `recordVideo` is fixed at launch and records every page.
   - Tool result links the file. Web and Android render it as a video in the tool card.
   - An action log (tool calls plus a screenshot per action) is kept per session and is replayable step by step in the panel ("what did the agent do").

## Security / trust

- Not a sandbox: the browser has the node account's network access and the workspace profile's logins.
- Content from pages is **untrusted** and must be tagged like network output (ties into roadmap item "coarse network taint tagging" in `plans/assistant.md`). Auto mode should classify `browser_click`/`browser_type` on non-localhost origins as consequential.
- Password fields: `browser_type` refuses `type=password` inputs and tells the agent to use `browser_handoff`. Screenshots and snapshots mask password values.
- Profile dirs are protected paths (the agent's file tools must not read cookies).

## Packaging

- `playwright-core` dependency (no bundled browsers). Needs a spike: does `launchPersistentContext` work under Bun **and** inside `bun build --compile`? If not, fall back to raw CDP over `--remote-debugging-pipe`, which is small enough to own.
- nix: `services.pirc.browser.package` (default `pkgs.chromium`) plus `ffmpeg` in the node's `path`. On macOS dev, use a config/env `PIRC_BROWSER_EXECUTABLE`.

## Spike results (2026-09-29, playwright-core 1.63.0, Bun 1.4.2, macOS arm64)

Result: **use playwright-core.** Raw CDP is not needed.

- Under `bun` and inside `bun build --compile`, `launchPersistentContext`, `goto`, `ariaSnapshot`, `newCDPSession` screencast, `Input.dispatchMouseEvent`/`insertText`/`dispatchKeyEvent` (CJK text included) and ffmpeg piping all work. The compiled binary also runs outside `node_modules`.
- Compiling needs `--external chromium-bidi`, which is only used for Firefox/BiDi. Add this to `build` in `apps/gateway/package.json` and `nix/package.nix`.
- Binary size grows by about 6.5 MB (62.2 → 68.8 MB).
- A second launch on the same profile dir fails with `ProcessSingleton`. This confirms the node must be the single owner.
- **`ariaSnapshot` includes password field values** (`textbox "Pass": secret`). The snapshot must mask them.
- The screencast only emits frames when the page changes (5–6 frames in about 1 s). Recording must pace frames by `metadata.timestamp`, for example by repeating the last frame at a fixed fps or using the ffmpeg concat demuxer with durations. Otherwise the video runs too fast.
- Startup is about 0.4 s with a warm browser. The first launch of a fresh `Chromium.app` took about 1.3 s, and its close took about 23 s once (not reproduced; about 250 ms afterwards). Still, close with a timeout and fall back to killing the process.
- On this Mac, `~/Library/Caches/ms-playwright/chromium-1208` is incomplete (its Framework is missing). The spike used `/Applications/Chromium.app`. The executable must be configurable (`PIRC_BROWSER_EXECUTABLE`), and nix should provide `pkgs.chromium` on Linux.

## Phases

1. **Spike** Playwright under Bun and the compiled binary with the nix chromium, then choose playwright-core or raw CDP.
2. BrowserManager + `node_request` channel + `web_fetch` + interactive tools + tests (local test server page).
3. Live view panel (web) + relay + action overlay.
4. Takeover (control lease, input forwarding, `browser_handoff`).
5. Recording (ffmpeg) + action-log replay + video rendering in tool cards.
6. Android: live view and takeover in the session screen.
