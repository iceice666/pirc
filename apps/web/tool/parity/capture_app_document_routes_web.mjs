// Run from the repository root:
// /opt/homebrew/bin/node apps/web/tool/parity/capture_app_document_routes_web.mjs
// Loads the actual pinned Vite app entry and lets App.svelte bootstrap from a stable local API fixture.
import { createServer } from '../../node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const pinnedRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/app-document-routes.json');
const expectedPath = resolve(root, 'fixtures/mobile-parity/app-document-routes-expected.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
if (fixture.webRevision !== pinnedRevision)
  throw new Error('App document routes fixture must use the pinned web revision');

execFileSync('git', ['diff', '--exit-code', pinnedRevision, '--', 'apps/web', ':!apps/web/tool'], {
  cwd: root,
  stdio: 'inherit',
});

const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const temporaryOutput = resolve('/private/tmp', 'pirc-app-document-routes-parity');
await mkdir(temporaryOutput, { recursive: true });
const origin = 'http://127.0.0.1:18932';
const source = fixture.apiFixture;
const apiFailures = [];
const externalRequests = [];
const captures = [];

function apiResponse(url) {
  const path = url.pathname;
  if (path === '/api/workspaces')
    return { fixtureKey: 'workspaces', body: { workspaces: source.workspaces } };
  if (path === '/api/sessions')
    return { fixtureKey: 'sessions', body: { sessions: source.sessions } };
  if (path === '/api/models') return { fixtureKey: 'models', body: { models: source.models } };
  if (path === '/api/nodes') return { fixtureKey: 'nodes', body: { nodes: source.nodes } };
  if (path === '/api/memory') return { fixtureKey: 'memory', body: source.memory };
  if (path === '/api/schedules')
    return {
      fixtureKey: 'schedules',
      body: { schedules: source.schedules, timezone: 'Asia/Taipei' },
    };
  if (path === '/api/providers') return { fixtureKey: 'providers', body: source.providers };
  if (path === '/api/devices') return { fixtureKey: 'devices', body: source.devices };
  if (path === '/api/push') return { fixtureKey: 'push', body: source.push };

  const snapshot = path.match(/^\/api\/sessions\/([^/]+)\/snapshot$/);
  if (snapshot) {
    const sessionId = decodeURIComponent(snapshot[1]);
    if (source.snapshots[sessionId])
      return { fixtureKey: 'snapshot:' + sessionId, body: source.snapshots[sessionId] };
  }
  const control = path.match(/^\/api\/sessions\/([^/]+)\/control$/);
  if (control) return { fixtureKey: 'controlLease', body: source.controlLease };
  const panelState = path.match(/^\/api\/sessions\/([^/]+)\/panel\/state$/);
  if (panelState) return { fixtureKey: 'panelState', body: source.panelState };
  const schedule = path.match(/^\/api\/schedules\/([^/]+)$/);
  if (schedule) {
    const scheduleId = decodeURIComponent(schedule[1]);
    const value = source.schedules.find((item) => item.id === scheduleId);
    if (value)
      return {
        fixtureKey: 'schedule:' + scheduleId,
        body: { schedule: value, runs: source.scheduleRuns },
      };
  }
  return undefined;
}

const server = await createServer({
  cacheDir: resolve(temporaryOutput, 'vite-cache'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18932,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: fixture.capture.browserExecutable,
    headless: true,
  });
  const browserVersion = await browser.version();
  if (!browserVersion.startsWith('154.'))
    throw new Error('Expected pinned Chrome 154, got ' + browserVersion);

  for (const item of fixture.cases) {
    const context = await browser.newContext({
      viewport: fixture.capture.viewport,
      deviceScaleFactor: fixture.capture.viewport.deviceScaleFactor,
      isMobile: fixture.capture.viewport.isMobile,
      hasTouch: fixture.capture.viewport.hasTouch,
      locale: 'en-US',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    const eventOrder = [];
    const pageErrors = [];
    const consoleErrors = [];
    const unexpected = [];
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        externalRequests.push({ caseId: item.id, url: request.url() });
        await route.abort('blockedbyclient');
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const response = apiResponse(url);
        const entry = {
          sequence: eventOrder.length,
          kind: 'http',
          method: request.method(),
          path: url.pathname,
          rawQuery: url.search,
          contentType: request.headers()['content-type'] || null,
          body: request.postData() || null,
          fixtureKey: response?.fixtureKey || null,
          status: response ? 200 : 500,
        };
        eventOrder.push(entry);
        if (!response) {
          unexpected.push(entry);
          apiFailures.push({ caseId: item.id, path: url.pathname, method: request.method() });
          await route.fulfill({
            status: 500,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ error: { message: 'Unexpected route-oracle API request' } }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify(response.body),
        });
        return;
      }
      await route.continue();
    });
    await context.routeWebSocket('**/api/events**', () => {
      // Keep the actual app's event connection open, with no gateway or external server.
    });

    const page = await context.newPage();
    await context.addInitScript(() => {
      const nativeWebSocket = window.WebSocket;
      window.__appDocumentRoutesSocketAttempts = [];
      window.WebSocket = new Proxy(nativeWebSocket, {
        construct(target, args) {
          const url = new URL(String(args[0]), location.href);
          if (url.pathname === '/api/events')
            window.__appDocumentRoutesSocketAttempts.push({
              path: url.pathname,
              rawQuery: url.search,
            });
          return Reflect.construct(target, args, target);
        },
      });
    });
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('websocket', (socket) => {
      const url = new URL(socket.url());
      if (url.pathname === '/api/events')
        eventOrder.push({
          sequence: eventOrder.length,
          kind: 'websocket',
          path: url.pathname,
          rawQuery: url.search,
        });
    });

    try {
      const navigationResponse = await page.goto(origin + item.url, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await page.evaluate(async () => {
        const module = await import('/src/lib/app.svelte.ts');
        window.__appDocumentRoutesOracle = module.app;
      });
      await page.waitForFunction(
        () =>
          window.__appDocumentRoutesOracle && window.__appDocumentRoutesOracle.loading === false,
        undefined,
        { timeout: 20000 },
      );
      await page.waitForFunction(
        () =>
          window.__appDocumentRoutesOracle.demo === undefined &&
          window.__appDocumentRoutesOracle.sessionState !== undefined,
        undefined,
        { timeout: 10000 },
      );
      if (item.url.includes('open=schedules')) {
        await page.waitForFunction(
          () => {
            const status = document.querySelector('.schedules-page [role="status"]');
            return !status || !status.textContent.includes('Loading schedules');
          },
          undefined,
          { timeout: 10000 },
        );
      }
      if (item.url.includes('open=memory')) {
        await page.waitForFunction(
          () => {
            const dialog = document.querySelector('dialog[aria-labelledby="settings-title"]');
            return dialog && dialog.open;
          },
          undefined,
          { timeout: 10000 },
        );
      }
      await page.waitForTimeout(300);
      const observation = await page.evaluate(() => {
        const app = window.__appDocumentRoutesOracle;
        const sidebar = document.querySelector('.sidebar');
        const scrim = document.querySelector('.sidebar-scrim');
        const workspace = document.querySelector('.workspace');
        const settingsDialog = document.querySelector('dialog[aria-labelledby="settings-title"]');
        const selectedSettingsTab = document.querySelector(
          '.settings-nav [role="tab"][aria-selected="true"]',
        );
        const mobileTabs = document.querySelector('.mobile-tabs');
        const activeMobileTab = mobileTabs?.querySelector('[aria-current="page"]');
        const scheduleRows = [...document.querySelectorAll('.schedule-list > li')].map((row) => ({
          title: row.querySelector('.schedule-title strong')?.textContent?.trim() || null,
          runsExpanded:
            row.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'true',
        }));
        const visibleText = (selector) =>
          document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() || null;
        return {
          finalUrl: location.href,
          title: document.title,
          appState: {
            view: app.view,
            mode: app.mode,
            activeSessionId: app.activeSessionId || null,
            workspaceViewId: app.workspaceViewId || null,
            scheduleFocus: app.scheduleFocus || null,
            requestedTarget: app.requestedTarget || null,
            loading: app.loading,
            connection: app.connection,
            demoFallback: app.demo !== undefined,
            pageError: app.pageError || null,
            sessionIds: app.sessions.map((session) => session.id),
          },
          phoneNavigation: {
            viewportWidth: innerWidth,
            listOpen: sidebar?.classList.contains('open') || false,
            sidebarClass: sidebar?.className || null,
            sidebarVisibility: sidebar ? getComputedStyle(sidebar).visibility : null,
            scrimPresent: !!scrim,
            workspaceInert: workspace?.hasAttribute('inert') || false,
            mobileTabsPresent: !!mobileTabs,
            activeTab: activeMobileTab?.textContent?.replace(/\s+/g, ' ').trim() || null,
          },
          apiEventStreamAttempts: window.__appDocumentRoutesSocketAttempts || [],
          visiblePage: {
            schedulePage: !!document.querySelector('.schedules-page'),
            workspacePage: !!document.querySelector('.workspace-page'),
            sessionPage: !!document.querySelector('.conversation'),
            settingsOpen: !!settingsDialog?.open,
            settingsTab: selectedSettingsTab?.textContent?.replace(/\s+/g, ' ').trim() || null,
            sessionHeading: visibleText('.workspace .topbar h1'),
            pageHeading: visibleText('.schedules-page h1, .workspace-page h1'),
            scheduleRows,
            hasScheduleEmptyState: !![...document.querySelectorAll('.schedules-page p')].find(
              (node) => node.textContent.includes('No schedules yet'),
            ),
          },
        };
      });
      observation.caseId = item.id;
      observation.initialUrl = origin + item.url;
      observation.documentResponseStatus = navigationResponse?.status() ?? null;
      observation.requestedPath = item.url;
      observation.apiEventOrder = eventOrder;
      observation.unexpectedApiRequests = unexpected;
      observation.pageErrors = pageErrors;
      observation.consoleErrors = consoleErrors;
      captures.push(observation);
    } finally {
      await context.close();
    }
  }

  const invalidDocuments = captures
    .filter((item) => item.documentResponseStatus !== 200)
    .map((item) => ({ caseId: item.caseId, status: item.documentResponseStatus }));
  if (invalidDocuments.length)
    throw new Error(
      'Expected HTTP 200 for every app document: ' + JSON.stringify(invalidDocuments),
    );
  const invalidEventStreams = captures
    .filter((item) => item.apiEventStreamAttempts.length !== 1)
    .map((item) => ({ caseId: item.caseId, attempts: item.apiEventStreamAttempts }));
  if (invalidEventStreams.length)
    throw new Error(
      'Expected exactly one app event-stream attempt per case: ' +
        JSON.stringify(invalidEventStreams),
    );

  if (externalRequests.length)
    throw new Error('Unexpected external browser requests: ' + JSON.stringify(externalRequests));
  if (apiFailures.length)
    throw new Error('Unexpected API requests: ' + JSON.stringify(apiFailures));
  const pageErrors = captures.flatMap((item) =>
    item.pageErrors.map((error) => item.caseId + ': ' + error),
  );
  if (pageErrors.length)
    throw new Error('Actual App.svelte browser page errors: ' + pageErrors.join('\n'));
  const consoleErrors = captures.flatMap((item) =>
    item.consoleErrors.map((error) => item.caseId + ': ' + error),
  );
  if (consoleErrors.length)
    throw new Error('Actual App.svelte browser console errors: ' + consoleErrors.join('\n'));

  const result = {
    fixture: fixture.id,
    reference: fixture.webRevision,
    captureMethod:
      'Actual Vite index.html -> src/main.ts -> App.svelte; Playwright only supplies the stable same-origin API fixture and observes runtime state/DOM.',
    browser: { version: browserVersion, executable: fixture.capture.browserExecutable },
    viewport: fixture.capture.viewport,
    apiFixtureDescription: fixture.capture.apiMode,
    externalRequests: externalRequests,
    cases: captures,
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  await writeFile(expectedPath, json);
  console.log('Captured ' + captures.length + ' real-app route cases.');
  console.log(expectedPath);
  console.log(
    JSON.stringify(
      captures.map((item) => ({
        caseId: item.caseId,
        requestedPath: item.requestedPath,
        finalUrl:
          new URL(item.finalUrl).pathname +
          new URL(item.finalUrl).search +
          new URL(item.finalUrl).hash,
        view: item.appState.view,
        activeSessionId: item.appState.activeSessionId,
        workspaceViewId: item.appState.workspaceViewId,
        scheduleFocus: item.appState.scheduleFocus,
        listOpen: item.phoneNavigation.listOpen,
        apiEventStream: item.apiEventStreamAttempts,
        page: item.visiblePage,
        apiOrder: item.apiEventOrder.map((entry) =>
          entry.kind === 'http'
            ? entry.method + ' ' + entry.path + entry.rawQuery
            : 'WS ' + entry.path + entry.rawQuery,
        ),
      })),
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
