import { requireTestBrowserExecutable } from './test_browser.mjs';
// node apps/android/tool/parity/capture_conversation_history_web.mjs
// Capture the real pinned App.svelte's 60-message history window and reveals.
// The fixture seeds an already-open App state directly; it does not exercise
// the browser's real open-session transport.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';

const root = resolve(import.meta.dirname, '../../../..');
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/conversation-history.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixture.webRevision, revision, 'fixture must retain the pinned web source');
assert.equal(fixture.messages.length, 145, 'history fixture must contain 145 source messages');
assert.equal(new Set(fixture.messages.map((message) => message.id)).size, 145);
assert.deepEqual(fixture.widths, [390, 650, 651, 768, 860, 861, 1024]);
const captureWidths = process.env.PARITY_CAPTURE_WIDTHS
  ? process.env.PARITY_CAPTURE_WIDTHS.split(',').map(Number)
  : fixture.widths;
const captureScales = process.env.PARITY_CAPTURE_SCALES
  ? process.env.PARITY_CAPTURE_SCALES.split(',').map(Number)
  : fixture.textScales;
execFileSync('git', ['diff', '--exit-code', revision, '--', 'apps/web'], { cwd: root });

const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const outputDir = resolve(root, 'apps/android/build/parity/conversation-history-web');
await mkdir(outputDir, { recursive: true });

const server = await createServer({
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  cacheDir: resolve(outputDir, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port: 18921,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'conversation-history-oracle',
      configureServer(vite) {
        vite.middlewares.use('/history.html', async (_, res, next) => {
          try {
            const html = `<!doctype html><html><head>
            <link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
          </head><body><div id="app"></div><script type="module">
            import '/src/app.css';
            import '/src/markdown.css';
            import { mount, tick } from 'svelte';
            import App from '/src/App.svelte';
            import { app, MESSAGE_PAGE } from '/src/lib/app.svelte';
            import { fromSnapshot } from '/src/lib/state.ts';
            import { preloadRenderers } from '/src/lib/markdown.ts';
            const fixture = ${fixtureSource};
            document.documentElement.style.setProperty('font-family', fixture.fontOverride.fontFamily, 'important');
            document.documentElement.style.setProperty('--font-mono', fixture.fontOverride.mono, 'important');
            window.__historyNetworkCalls = [];
            window.fetch = (input, init) => {
              const url = typeof input === 'string' ? input : input.url;
              window.__historyNetworkCalls.push({ url, method: init?.method ?? 'GET' });
              return Promise.reject(new Error('Network access is disabled in conversation-history capture: ' + url));
            };
            window.WebSocket = class { constructor(url) { throw new Error('WebSocket access is disabled in conversation-history capture: ' + url); } };
            window.requestIdleCallback = () => 0;
            for (const name of fixture.runtimeStubs.singletonMethods) app[name] = async () => undefined;
            const session = fixture.session;
            const model = fixture.models[0];
            app.view = 'session';
            app.workspaces = fixture.workspaces;
            app.nodes = fixture.nodes;
            app.sessions = [session];
            app.models = fixture.models;
            app.activeSessionId = session.id;
            app.sessionState = fromSnapshot({
              session,
              runnerStatus: session.runnerStatus,
              run: fixture.state.run,
              messages: fixture.messages,
              interactions: fixture.state.interactions,
              queue: fixture.state.queue,
              control: { heldByCurrentClient: true, holderName: 'This browser', generation: 7 },
              cursor: '1:1',
              runnerEpoch: 'conversation-history-fixture',
              selectedModelId: model.id,
              selectedModelProvider: model.provider,
              thinkingLevel: 'medium',
              widgets: fixture.state.widgets,
              statuses: fixture.state.statuses,
            });
            // Match App.svelte's openSession initializer using its exported page size.
            app.hiddenMessages = Math.max(0, app.sessionState.messages.length - MESSAGE_PAGE);
            app.loading = false;
            app.connection = 'connected';
            app.pageError = '';
            app.demo = undefined;
            app.draft = fixture.draft;
            app.uploads = [];
            app.commandBusy = false;
            await preloadRenderers();
            mount(App, { target: document.querySelector('#app') });
            await tick();
            await document.fonts.ready;
            await new Promise((resolve) => setTimeout(resolve, 300));
            await tick();
            window.__historyFixture = fixture;
            window.__historyApp = app;
            window.captureHistory = (stateId) => {
              const timeline = document.querySelector('.timeline');
              const timelineRect = timeline.getBoundingClientRect();
              const messages = [...document.querySelectorAll('.timeline-inner > .message')];
              const ids = messages.map((article) => {
                const text = article.textContent ?? '';
                const match = /History entry (\\d+)/.exec(text);
                if (!match) throw new Error('Visible article has no fixture ID: ' + article.outerHTML.slice(0, 160));
                return 'history-' + Number(match[1]);
              });
              const anchor = messages.find((article) => (article.textContent ?? '').includes('History entry 90'));
              const earlier = document.querySelector('.earlier-messages');
              const earlierStyle = earlier ? getComputedStyle(earlier) : null;
              const box = (element) => {
                if (!element) return null;
                const r = element.getBoundingClientRect();
                return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
              };
              return {
                state: stateId,
                hiddenMessages: app.hiddenMessages,
                messageCount: app.sessionState.messages.length,
                renderedIds: ids,
                sourceMatchesFixture: JSON.stringify(app.sessionState.messages) === JSON.stringify(fixture.messages),
                sourceUniqueIdCount: new Set(app.sessionState.messages.map((message) => message.id)).size,
                readingAnchor: { id: 'history-90', box: box(anchor) },
                earlierButton: earlier ? { text: earlier.innerText, box: box(earlier), style: { borderTopWidth: earlierStyle.borderTopWidth, borderTopStyle: earlierStyle.borderTopStyle, paddingTop: earlierStyle.paddingTop, paddingBottom: earlierStyle.paddingBottom, marginBottom: earlierStyle.marginBottom, fontSize: earlierStyle.fontSize, lineHeight: earlierStyle.lineHeight } } : null,
                scroll: { top: timeline.scrollTop, height: timeline.scrollHeight, viewport: timeline.clientHeight, maxExtent: timeline.scrollHeight - timeline.clientHeight, extentAfter: timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop },
                viewport: { width: innerWidth, height: innerHeight },
              };
            };
            window.positionEarlierButton = async (bottomTarget, settle) => {
              const timeline = document.querySelector('.timeline');
              const button = document.querySelector('.earlier-messages');
              if (!button) throw new Error('Earlier-message button is missing before all messages are revealed');
              // content-visibility:auto may realize message blocks as they enter
              // the viewport, and the browser's own scroll anchoring adjusts
              // scrollTop for that growth. Re-measure until the sentinel reaches
              // the requested viewport coordinate before testing its observer.
              let actualBottom = button.getBoundingClientRect().bottom - timeline.getBoundingClientRect().top;
              if (!settle) {
                timeline.scrollTop += actualBottom - bottomTarget;
                return { bottomTarget, scrollTop: timeline.scrollTop, buttonBottomInViewport: button.getBoundingClientRect().bottom - timeline.getBoundingClientRect().top };
              }
              for (let attempt = 0; attempt < 8; attempt++) {
                actualBottom = button.getBoundingClientRect().bottom - timeline.getBoundingClientRect().top;
                const delta = actualBottom - bottomTarget;
                if (Math.abs(delta) < 0.25) break;
                timeline.scrollTop += delta;
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              }
              actualBottom = button.getBoundingClientRect().bottom - timeline.getBoundingClientRect().top;
              if (Math.abs(actualBottom - bottomTarget) > 1)
                throw new Error('Earlier button did not settle at requested viewport position: ' + JSON.stringify({bottomTarget, actualBottom, scrollTop: timeline.scrollTop}));
              return { bottomTarget, scrollTop: timeline.scrollTop, buttonBottomInViewport: actualBottom };
            };
            window.historyCaptureReady = true;
          </script></body></html>`;
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/history.html', html));
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});

const expectedState = {
  initial60: { hidden: 85, firstIndex: 85, count: 60 },
  revealed120: { hidden: 25, firstIndex: 25, count: 120 },
  final145: { hidden: 0, firstIndex: 0, count: 145 },
};
const captures = [];
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: requireTestBrowserExecutable(),
    headless: true,
  });
  for (const width of captureWidths) {
    for (const colorScheme of ['light', 'dark']) {
      for (const textScale of captureScales) {
        const context = await browser.newContext({
          viewport: { width, height: fixture.height },
          deviceScaleFactor: fixture.deviceScaleFactor,
          isMobile: true,
          hasTouch: true,
          locale: 'en-US',
          colorScheme,
        });
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
        try {
          await page.goto('http://127.0.0.1:18921/history.html', { waitUntil: 'networkidle' });
          await page.waitForFunction(() => window.historyCaptureReady === true);
          // Use App.svelte's actual navigation handler to close the phone list.
          // Seeding app.view alone leaves the mobile sidebar over the chat.
          await page
            .locator('.session-card')
            .filter({ hasText: fixture.session.name })
            .first()
            .click({ position: { x: 16, y: 16 } });
          await page.waitForFunction(
            () => {
              const timeline = document.querySelector('.timeline');
              if (!timeline) return false;
              const box = timeline.getBoundingClientRect();
              return !!document
                .elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
                ?.closest('.timeline');
            },
            null,
            { timeout: 5000 },
          );

          if (textScale !== 1) {
            await page.evaluate((scale) => {
              const entries = [...document.querySelectorAll('.app-shell, .app-shell *')]
                .filter((node) => node instanceof HTMLElement)
                .map((node) => {
                  const style = getComputedStyle(node);
                  return [node, parseFloat(style.fontSize), style.lineHeight];
                });
              for (const [node, size, line] of entries) {
                node.style.setProperty('font-size', size * scale + 'px', 'important');
                if (line !== 'normal')
                  node.style.setProperty(
                    'line-height',
                    parseFloat(line) * scale + 'px',
                    'important',
                  );
              }
            }, textScale);
            await page.evaluate(() => document.fonts.ready);
          }
          await page.waitForTimeout(150);
          const initial = await page.evaluate(() => window.captureHistory('initial60'));
          assertHistory(initial, 'initial60', width, colorScheme, textScale);
          await saveCapture(page, initial, width, colorScheme, textScale);
          captures.push(captureRow(initial, width, colorScheme, textScale));

          const firstThreshold = await page.evaluate(() =>
            window.positionEarlierButton(-201, true),
          );
          await page.waitForTimeout(100);
          const stillInitial = await page.evaluate(() => window.captureHistory('initial60'));
          assert.equal(
            stillInitial.hiddenMessages,
            85,
            `${width}/${colorScheme}/${textScale}: 201px outside the observer margin must remain hidden (${JSON.stringify(firstThreshold)})`,
          );
          const anchorBefore = stillInitial.readingAnchor.box;
          await page.evaluate(() => window.positionEarlierButton(-199, false));
          await page.waitForFunction(() => window.__historyApp.hiddenMessages === 25, null, {
            timeout: 5000,
          });
          await page.waitForTimeout(100);
          const revealed = await page.evaluate(() => window.captureHistory('revealed120'));
          assertHistory(revealed, 'revealed120', width, colorScheme, textScale);
          const anchorRetention = measureRectRetention(
            anchorBefore,
            revealed.readingAnchor.box,
            fixture.anchorBoxToleranceCssPixels,
          );
          await saveCapture(page, revealed, width, colorScheme, textScale);
          captures.push({
            ...captureRow(revealed, width, colorScheme, textScale),
            anchorBefore,
            anchorAfter: revealed.readingAnchor.box,
            anchorDeltaCssPixels: revealed.readingAnchor.box.top - anchorBefore.top,
            anchorRetention,
            earlierButtonBefore: stillInitial.earlierButton,
            earlierButtonAfter: revealed.earlierButton,
            scrollBefore: stillInitial.scroll,
            scrollAfter: revealed.scroll,
            scrollHeightDelta: revealed.scroll.height - stillInitial.scroll.height,
            maxExtentDelta: revealed.scroll.maxExtent - stillInitial.scroll.maxExtent,
          });

          await page.evaluate(() => window.positionEarlierButton(-201, true));
          await page.waitForTimeout(100);
          assert.equal(
            await page.evaluate(() => window.__historyApp.hiddenMessages),
            25,
            `${width}/${colorScheme}/${textScale}: remaining history must wait outside the margin`,
          );
          await page.evaluate(() => window.positionEarlierButton(-199, false));
          await page.waitForFunction(() => window.__historyApp.hiddenMessages === 0, null, {
            timeout: 5000,
          });
          await page.waitForTimeout(100);
          const final = await page.evaluate(() => window.captureHistory('final145'));
          assertHistory(final, 'final145', width, colorScheme, textScale);
          await saveCapture(page, final, width, colorScheme, textScale);
          captures.push(captureRow(final, width, colorScheme, textScale));

          if (pageErrors.length) throw new Error(pageErrors.join('\n'));
          const networkCalls = await page.evaluate(() => window.__historyNetworkCalls);
          if (networkCalls.length)
            throw new Error(
              'Fixture unexpectedly attempted gateway requests: ' + JSON.stringify(networkCalls),
            );
        } finally {
          await context.close();
        }
      }
    }
  }

  const expectedCaptures = captureWidths.length * 2 * captureScales.length * 3;
  assert.equal(
    captures.length,
    expectedCaptures,
    'must capture every requested width/theme/scale/state tuple',
  );
  assert.equal(
    new Set(captures.map(tupleKey)).size,
    expectedCaptures,
    'history capture tuples must be unique',
  );
  const manifest = {
    fixture: fixture.id,
    reference: fixture.webRevision,
    fontOverride: fixture.fontOverride,
    runtimeStub: fixture.runtimeStubs.description,
    widths: captureWidths,
    colorSchemes: ['light', 'dark'],
    textScales: captureScales,
    anchorBoxToleranceCssPixels: fixture.anchorBoxToleranceCssPixels,
    anchorBoxToleranceNote: fixture.anchorBoxToleranceNote,
    states: fixture.states,
    captures,
  };
  const outputPath = resolve(outputDir, 'conversation-history-web.json');
  await writeFile(outputPath, JSON.stringify(manifest, null, 2) + '\n');
  const retainedRows = captures.filter((row) => row.state === 'revealed120');
  console.log(
    JSON.stringify(
      {
        outputPath,
        captures: captures.length,
        widths: captureWidths,
        states: Object.keys(expectedState),
        anchorToleranceViolations: retainedRows.filter(
          (row) => !row.anchorRetention.withinTolerance,
        ).length,
        maximumAnchorShiftCssPixels: Math.max(
          ...retainedRows.map((row) => row.anchorRetention.maximumAbsoluteDeltaCssPixels),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}

function expectedIds(state) {
  const { hidden } = expectedState[state];
  return fixture.messages.slice(hidden).map((message) => message.id);
}

function assertHistory(result, state, width, colorScheme, textScale) {
  const expected = expectedState[state];
  const reason = `${state} ${width}/${colorScheme}/scale${textScale}`;
  assert.equal(result.hiddenMessages, expected.hidden, `${reason}: hidden message count`);
  assert.equal(result.messageCount, 145, `${reason}: complete source count`);
  assert.equal(result.sourceMatchesFixture, true, `${reason}: fixture source tuple content`);
  assert.equal(result.sourceUniqueIdCount, 145, `${reason}: complete source IDs unique`);
  assert.equal(result.renderedIds.length, expected.count, `${reason}: rendered message count`);
  assert.equal(
    new Set(result.renderedIds).size,
    result.renderedIds.length,
    `${reason}: duplicate rendered IDs`,
  );
  assert.deepEqual(
    result.renderedIds,
    expectedIds(state),
    `${reason}: missing, duplicate, or reordered IDs`,
  );
  assert.equal(result.readingAnchor.id, fixture.readingAnchorId);
  assert.ok(result.readingAnchor.box, `${reason}: reading anchor box must be measurable`);
}

function measureRectRetention(before, after, tolerance) {
  assert.ok(before && after, 'both reading-anchor boxes must exist');
  const deltas = {};
  for (const side of ['left', 'top', 'right', 'bottom', 'width', 'height']) {
    deltas[side] = after[side] - before[side];
  }
  const maximumAbsoluteDeltaCssPixels = Math.max(...Object.values(deltas).map(Math.abs));
  return {
    toleranceCssPixels: tolerance,
    withinTolerance: maximumAbsoluteDeltaCssPixels <= tolerance,
    maximumAbsoluteDeltaCssPixels,
    deltas,
  };
}

function tupleKey(row) {
  return `${row.width}/${row.colorScheme}/${row.textScale}/${row.state}`;
}

function captureRow(result, width, colorScheme, textScale) {
  return { ...result, width, colorScheme, textScale };
}

async function saveCapture(page, result, width, colorScheme, textScale) {
  const path = `${result.state}-${width}-${colorScheme}-scale${textScale}.png`;
  await page.screenshot({ path: resolve(outputDir, path) });
  result.screenshot = path;
}
