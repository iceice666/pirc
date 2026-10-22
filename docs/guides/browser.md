# Browser

[User guides](README.md) · [All documentation](../README.md)

Each node gives its agents a real Chromium, driven over the Chrome DevTools Protocol by a native port of the parts of [playwright-core](https://playwright.dev) it needs (nothing JavaScript is installed). The node owns one browser per workspace, with a persistent profile under `$PIRC_STATE_DIR/browser/`, so a login made once serves every session in that workspace. Each session drives its own tabs.

- **Tools**:
  - `web_fetch` renders a URL (JavaScript runs, logins apply) and returns readable markdown, text or HTML, in pages of `maxChars`.
  - `browser_navigate`/`snapshot`/`click`/`type`/`select`/`press`/`wait_for`/`screenshot`/`tabs` drive pages through accessibility-snapshot refs.
  - `browser_handoff` asks you to take over, for example to log in or pass a CAPTCHA, and waits until you return control.
  - `browser_record` records a video.

  Snapshots mask password values, and `browser_type` refuses password fields, so logins go through a handoff. Only the node's main agent has the browser (not teammates or subagents), and only `http(s)` URLs open. Clicking, typing, choosing or pressing a key on another site is [sending something out](tools.md): the node refuses it until you allow that site, once or for the session.

- **Engine → a session → Browser** (web and Android):
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
