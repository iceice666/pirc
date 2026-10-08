# Browser

[User guides](README.md) · [All documentation](../README.md)

Each node gives its agents a real Chromium through [playwright-core](https://playwright.dev) ([historical browser plan](../history/browser.md)). The node owns one browser per workspace, with a persistent profile under `$PIRC_STATE_DIR/browser/`, so a login made once serves every session in that workspace. Each session drives its own tabs.

- **Tools**:
  - `web_fetch` renders a URL (JavaScript runs, logins apply) and returns readable markdown, text or HTML, in pages of `maxChars`.
  - `browser_navigate`/`snapshot`/`click`/`type`/`select`/`press`/`wait_for`/`screenshot`/`tabs` drive pages through accessibility-snapshot refs.
  - `browser_handoff` asks you to take over, for example to log in or pass a CAPTCHA, and waits until you return control.
  - `browser_record` records a video.

  Snapshots mask password values, and `browser_type` refuses password fields, so logins go through a handoff. Only the node's main agent has the browser (not teammates or subagents), and only `http(s)` URLs open. Auto mode does not judge browser actions; the system prompt tells the agent to ask before consequential submissions.

- **Side panel → Browser** (web and Android):
  - A live JPEG screencast of the session's active tab, streamed only while you watch.
  - **Take over** pauses the agent's browser tools (they wait up to 5 minutes, or for the handoff) and forwards your clicks, scrolling and typing, IME included. **Return control** hands it back.
  - An address bar, tabs, and a **Record** button.
  - An activity log whose steps (with a screenshot per agent action) you can replay one by one.
- **Recordings** are WebM files in `<workspace>/.pirc/recordings/`. Frames are repeated at 10 fps so videos play in real time, and recordings stop after 30 minutes. They play in the `browser_record` tool card (web) or open in the Android player, served with HTTP ranges from `/api/sessions/:id/browser/recording?path=…`.
- **Node settings**:

  | Variable                    | Meaning                                                    | Default                                                                                    |
  | --------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
  | `PIRC_BROWSER`              | Enables the browser                                        | `true`; unavailable when no browser is found                                               |
  | `PIRC_BROWSER_EXECUTABLE`   | Browser executable                                         | `chromium`, `google-chrome`… on `PATH`, then `/Applications/Chromium.app` or Google Chrome |
  | `PIRC_FFMPEG`               | ffmpeg with libvpx, used for recordings                    | `ffmpeg`                                                                                   |
  | `PIRC_BROWSER_VIEWPORT`     | Viewport size                                              | `1280x800`                                                                                 |
  | `PIRC_BROWSER_IDLE_MS`      | Idle time before a session's tabs close; the profile stays | 30 minutes                                                                                 |
  | `PIRC_BROWSER_PROFILES_DIR` | Where the profiles live                                    | `$PIRC_STATE_DIR/browser`                                                                  |

  `features.browser.enabled: false` in an agent config hides the tools. The NixOS module sets these through `services.pirc.browser.{enable,package,ffmpeg}`.

For sandbox policy, installation and Git access, see [Sandbox and browser deployment](../deploy/sandbox-and-browser.md).
