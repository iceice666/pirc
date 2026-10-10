# Spike A: the agent's browser model over raw CDP

M1 spike for [the Rust rewrite](../../plans/rust-rewrite.md): can a Rust `pirc-node` give agents the same browser view as `node/browser.ts` without Node and Playwright?

The agent sees Playwright's AI aria snapshot (`page.ariaSnapshot({ mode: 'ai' })`) and acts on its `[ref=…]`s through `aria-ref=` locators. Both are computed inside the page by Playwright's injected script. The spike evaluates that same script over a minimal hand-written CDP client (WebSocket and JSON, about 300 lines), compares each page's snapshot with what Playwright returns for it, and fills and submits a form through refs with CDP input events.

```sh
bun extract.ts                    # target/injected.js from playwright-core 1.63.0 (Apache-2.0)
bun reference.ts <chromium>       # target/expected/*.yaml from Playwright itself
cargo run --release -- <chromium>
```

## Result (2026-10-10, Chromium 154.0.8037.97 from nixpkgs, playwright-core 1.63.0)

| Page                                                                                       | Matches Playwright                          | Snapshot |
| ------------------------------------------------------------------------------------------ | ------------------------------------------- | -------- |
| form (inputs, password, checkbox, select, disabled button)                                 | yes                                         | 11 ms    |
| form after filling `textbox "Name"` and clicking `button "Submit"` by ref                  | yes, incl. `[active]` and the new paragraph |          |
| nav (links with `/url`, inline text, details, `aria-hidden`, alert, img, `cursor=pointer`) | yes                                         | 7 ms     |
| table (caption, headers, cells, nested status, tabs, slider, textarea)                     | yes                                         | 4 ms     |
| iframe                                                                                     | **no**: the frame's content is missing      | 2 ms     |

Refs are compared without their frame prefix (`f3e2` versus `e2`): Playwright numbers frames per browser context.

The release executable is 921 KiB (tokio, tokio-tungstenite, serde_json); the injected script adds 313 KiB of JavaScript when embedded.

## Conclusions

- Feasible, and the snapshot text the agent reads stays byte-identical, because it is Playwright's own in-page code. A CDP-native re-implementation of the accessibility tree is not needed and would change what agents see.
- Pin the injected script to a playwright-core version, extract it at build time like `extract.ts`, embed it, and keep Apache-2.0 attribution. Updating it is a deliberate change with a snapshot diff.
- Work this spike leaves for M8:
  - **Frames.** Playwright snapshots each child frame separately (`ariaSnapshotJSONForFrame` in playwright-core's server code) and merges it under the iframe node, numbering refs per frame (`f<frameSeq>e<n>`). The Rust driver needs a frame tree (`Page.getFrameTree`, out-of-process iframes through `Target.setAutoAttach`), one injected script per frame, the merge, and ref routing to the right frame.
  - **Isolation.** Inject into an isolated world (`Page.createIsolatedWorld`) rather than the main world the spike uses, so page scripts cannot tamper with the snapshot code.
  - **The rest of `browser.ts`'s Playwright use** maps to CDP domains: navigation and history (`Page`), `context.route`/`routeWebSocket` host guard (`Fetch`), screenshots and the live view (`Page.captureScreenshot`, `Page.startScreencast`), keyboard and mouse (`Input`), waits for load state (`Page` lifecycle events), persistent profiles (`--user-data-dir`). Playwright's actionability checks (visible, stable, enabled, receiving events) before a click or fill are also in the injected script and should be used the same way.
- Chromium stays an external runtime dependency, as it is today.
