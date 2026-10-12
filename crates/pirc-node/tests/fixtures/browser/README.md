# Browser golden corpus (M8)

What Playwright itself does on these pages, recorded before the node's browser
was ported to Rust (`plans/rust-rewrite.md`, M8). The Rust browser's tests
replay the same cases against their CDP driver and compare with `expected/`.

- `pages/`: the fixture pages (the first four come from `spikes/browser-snapshot`).
- `cases/<case>.json`: what to do with them, in the small step language below.
- `expected/<case>.json`: what Playwright 1.63.0 returned, written by
  [`scripts/browser-reference.ts`](../../../../../scripts/browser-reference.ts).

## Recording

From the repository root, after `bun install --frozen-lockfile`:

```sh
nix develop -c bun run browser:reference            # every case
nix develop -c bun run browser:reference form oopif # some cases
nix develop -c bun run browser:reference --check    # compare only; exit 1 on a difference
```

The Chromium is the Linux dev shell's `chromium` (Chromium 153.0.8010.47 when
the corpus was recorded), found on `PATH` the way `browser.ts` finds it, or
`PIRC_BROWSER_EXECUTABLE`. Playwright is the pinned `playwright-core` of
`apps/gateway/node_modules`. The context is started as `browser.ts` starts it
(`launchPersistentContext` with a fresh profile, `headless`, viewport
1280x800, `acceptDownloads: false`, `serviceWorkers: 'block'`, a secret-free
environment), with `browser.ts`'s host-guard routes (`context.route('**/*')`,
`routeWebSocket`; loopback allowed as with `PIRC_BROWSER_ALLOW_PRIVATE`) and
its action overlay (`page.screencast.showActions({ duration: 600 })`, which
also delays every input action by 600 ms). Each case runs in a new page of
that one context, which is closed afterwards.

Three consecutive recordings were byte-identical. Another Chromium version may
change snapshots (Chromium's accessibility names, key codes); re-record and
review the diff when the dev shell's Chromium moves.

## Fixture server

The recorder serves the pages itself; a Rust runner must serve them the same
way. One HTTP server on `127.0.0.1:<port>` stands for two sites:

- `{{HOST_A}}` is `127.0.0.1:<port>`, `{{HOST_B}}` is `localhost:<port>`.
  They are different sites, so a page of one framed by the other is an
  out-of-process iframe (`oopif.json` checks that with `targets`).
- `GET /<name>.html` serves `pages/<name>.html` (`text/html; charset=utf-8`,
  `cache-control: no-store`) with `{{HOST_A}}`, `{{HOST_B}}` and `{{PORT}}`
  (the port alone) replaced.
- `GET /slow?ms=<n>&text=<t>` answers `t` as `text/plain` after `n` ms (at most 10000).
- `GET /redirect?to=<url>` answers 302 to `url`.
- `GET /status/<code>` answers that status with
  `<!doctype html><title>Status <code></title><p>Status <code></p>`.
- Anything else is a `404` with the plain text `Not found`.

In `cases/` and `expected/`, `{{HOST_A}}` and `{{HOST_B}}` stand for those
hosts; this is the only normalization.

## Case language

A case is `{ "description": "…", "steps": [step, …] }`. Steps run in order on
one page. Each step has an `op`; `"error": true` means the step must fail, and
its error is recorded as `browser.ts`'s `cleanError` produces it (the message
up to `\nCall log:`, at most 4 lines and 1000 characters). Playwright
prefixes messages with the api name it reads from the caller's stack: the
bare method under Bun (`fill: …`, `goto: …`), which is what the TS node
reports with on-disk playwright-core (`PIRC_PLAYWRIGHT_CORE`, set by its Nix
and release wrappers and by the conformance scenarios); `page.goto: …` under
V8; no prefix when the node uses the playwright-core minified into its
executable. The corpus keeps the Bun form. A step that fails
without `"error": true`, or succeeds with it, fails the recording. `note` is a
comment.

Refs: steps that act on an element take either `"ref": "<ref>"` (literal) or
`"target": "<regex>"`, a JavaScript regular expression matched against each
line of the latest snapshot (or of the snapshot saved as `"in": "<name>"`);
the first matching line with a `[ref=…]` gives the ref. The ref is recorded.

| op           | Arguments                                | Playwright calls (as `browser.ts` makes them)                                                                                                                                                                                                                                                                                                                                         | Recorded                                                                  |
| ------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `goto`       | `url`, `timeout`                         | `page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout ?? 30000 })`, then `waitForLoadState('networkidle', { timeout: 3000 })` ignoring errors (`browser.ts` `goto`, without the host check)                                                                                                                                                                               | `status` (or `null`), `title`                                             |
| `back`       |                                          | `page.goBack({ timeout: 15000, waitUntil: 'domcontentloaded' })`                                                                                                                                                                                                                                                                                                                      | `response`: its status, or `null` (no history, same-document)             |
| `snapshot`   | `name`, `mask`, `timeout`                | `page.ariaSnapshot({ mode: 'ai', timeout: timeout ?? 10000 })`; with `mask`, `maskPasswords` over `passwordValues` of every frame (`pageSummary`)                                                                                                                                                                                                                                     | `snapshot`; saved as `name`                                               |
| `click`      | ref, `button`, `double`, `timeout`       | `locator('aria-ref=<ref>').click({ timeout: timeout ?? 10000, button: button ?? 'left', clickCount: double ? 2 : 1 })`, then `settle`                                                                                                                                                                                                                                                 |                                                                           |
| `hover`      | ref, `timeout`                           | `locator.hover({ timeout: timeout ?? 10000 })`                                                                                                                                                                                                                                                                                                                                        |                                                                           |
| `fill`       | ref, `text`, `timeout`                   | `locator.fill(text, { timeout: timeout ?? 10000 })`, then `settle` (`browser_type`)                                                                                                                                                                                                                                                                                                   |                                                                           |
| `type`       | ref, `text`, `timeout`                   | `locator.fill('', { timeout: 10000 })`, `locator.pressSequentially(text, { timeout: timeout ?? 30000, delay: 20 })`, then `settle` (`browser_type` with `slowly`)                                                                                                                                                                                                                     |                                                                           |
| `press`      | ref, `key`, `timeout`                    | `locator.press(key, { timeout: timeout ?? 10000 })`, then `settle` (`browser_type`'s `submit`)                                                                                                                                                                                                                                                                                        |                                                                           |
| `select`     | ref, `values`, `timeout`                 | `locator.selectOption(values, { timeout: timeout ?? 10000 })`, then `settle`                                                                                                                                                                                                                                                                                                          |                                                                           |
| `keyboard`   | `key`                                    | `page.keyboard.press(key)`, then `settle` (`browser_press`)                                                                                                                                                                                                                                                                                                                           |                                                                           |
| `insertText` | `text`                                   | `page.keyboard.insertText(text)` (the viewer's `text` input)                                                                                                                                                                                                                                                                                                                          |                                                                           |
| `waitFor`    | `text` or `textGone`, `timeout`          | `page.getByText(t).first().waitFor({ state: 'visible' or 'hidden', timeout: timeout ?? 10000 })`                                                                                                                                                                                                                                                                                      |                                                                           |
| `evaluate`   | `helper`, `frames`, ref; or `expression` | `pageMarkdown`: `page.evaluate(pageMarkdown)`; `innerText`: `document.body?.innerText ?? ''` (web_fetch `text`); `content`: `page.content()` (web_fetch `html`); `passwordValues` / `sensitiveField` in the main frame, in every frame (`"frames": "all"`, errors → `[]`/`false`), or `sensitiveField` on a ref via `locator.evaluate(sensitiveField, undefined, { timeout: 10000 })` | `result`                                                                  |
| `frames`     |                                          | `page.frames()`                                                                                                                                                                                                                                                                                                                                                                       | `frames`: `{ url, name, parent }` (`parent` is an index into the list)    |
| `targets`    |                                          | CDP `Target.getTargets` through a page session                                                                                                                                                                                                                                                                                                                                        | `iframeTargets`: sorted URLs of `iframe` targets (out-of-process iframes) |
| `wait`       | `timeout`                                | `page.waitForTimeout(timeout)`                                                                                                                                                                                                                                                                                                                                                        |                                                                           |

`settle` is `browser.ts`'s: `waitForLoadState('domcontentloaded', { timeout: 5000 })` ignoring errors, then `waitForTimeout(250)`.
The helpers are `browser-extract.ts`'s `pageMarkdown` and `passwordValues` and `browser.ts`'s `sensitiveField` and `maskPasswords`.

Every recorded step also has the page's `url` afterwards, except a failed
`goto` or `back` (where the error page lands is a race).

## What the corpus pins down

- **Refs** (`f<seq>e<n>`): a frame's prefix is its page-local sequence number
  (the main frame is 0 and unprefixed; child frames take the next numbers;
  each main-frame navigation to a new document, except from `about:blank`,
  takes a new one: `navigation.json` reaches `f5e1`). Refs are kept across
  snapshots while an element's role and name stay; a renamed or re-created
  element gets the next number (`mutate.json`). Only visible elements that
  receive pointer events get refs.
- **Frames**: same-origin and out-of-process iframes are merged under their
  `iframe` node; `[active]` marks the focused path through frames.
- **Errors** an agent can hit, as `cleanError` leaves them: timeouts (hidden,
  covered, disabled, read-only, stale or unknown refs all end as
  `<method>: Timeout <n>ms exceeded.`), `Invalid frame in aria-ref selector`,
  `Unknown key: "…"` (also inside a chord), `Element is not a <select>
element`, `Input of type "checkbox" cannot be filled`, `Element is not an
<input>, <textarea> or [contenteditable] element`, navigation errors.
- **Quirks kept as found**: selecting a disabled option succeeds; `!` is typed
  as `Digit1` without Shift; characters outside the US layout (`é`) are
  inserted without key events; a closed shadow root is invisible to snapshots;
  `pageMarkdown` strips leading spaces of `pre` lines that do not start with
  `-`, a digit or whitespace, and leaves blank `>` lines between quoted
  paragraphs.
