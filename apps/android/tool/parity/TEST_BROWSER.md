# Isolated browser tests

Mobile parity tools use a dedicated Headless Shell or Chrome for Testing
executable. They refuse everyday `Google Chrome.app`; no fallback to the user's
browser/profile is permitted. Playwright creates a fresh temporary profile and
only its owned browser connection is closed. Do not use global kill/quit commands
or connect to an existing browser session.

Install the Playwright-pinned headless shell from the repository root:

```sh
node apps/android/tool/parity/install_test_browser.mjs
```

The reusable cache is `.pirc/test-browsers/` (ignored by Git). It is a test runtime,
not a disposable per-run screenshot/build output. Current package 1.63.0 supplies
Headless Shell **153.0.8010.12**. `PIRC_TEST_BROWSER` may select another dedicated
headless-shell/Chrome-for-Testing executable; validation still rejects everyday
Chrome, including legacy `CHROME_PATH`/`PIRC_CHROME_PATH` overrides.

Historical Chrome 154/155 observations retain their original fixtures and versions.
Origin, Referrer, and Referrer Navigation were recaptured on 2026-10-17 with the
dedicated Chromium 153 headless shell after the runners became portable. The new
`document-origin-chromium153.json`, `document-referrer-chromium153.json`, and
`document-referrer-navigation-chromium153.json` fixtures record the executable
basename, not a host-specific path. Their oracle tests hash the exact current
runner and fixture bytes and pin the reported browser version. The older embedded
Android integration fixtures remain labeled as Chrome 155 historical device
baselines; they are not rewritten from the new captures.

Validation on 2026-10-16: dedicated-shell launch, synthetic page and owned close
passed while the pre-existing daily Chrome PID remained running. Two selector
unit tests reject everyday Chrome, including an explicit override. No personal
tab/profile content was accessed. Browser lifecycle isolation is separately
recorded in `build/parity-acceptance/document-storage-20261016/`.

Legacy `apps/web/tool/parity` captures and the design handoff renderer also use
the same executable guard. Their launch paths no longer select the installed
everyday Chrome. Existing captured fixtures and their historical browser metadata
remain unchanged; changing a runner does not recapture or reaccept a baseline.
