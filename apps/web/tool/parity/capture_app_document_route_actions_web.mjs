// Run from the repository root:
// /opt/homebrew/bin/node apps/web/tool/parity/capture_app_document_route_actions_web.mjs
// Drives the actual pinned App.svelte through phone navigation and native browser history.
import { createServer } from '../../node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const pinnedRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/app-document-route-actions.json');
const expectedPath = resolve(
  root,
  'fixtures/mobile-parity/app-document-route-actions-expected.json',
);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const apiFixturePath = resolve(root, 'fixtures/mobile-parity', fixture.apiFixtureReference);
const apiFixture = JSON.parse(await readFile(apiFixturePath, 'utf8'));
if (fixture.webRevision !== pinnedRevision || apiFixture.webRevision !== pinnedRevision)
  throw new Error('App document route-action fixtures must use the pinned web revision');

execFileSync('git', ['diff', '--exit-code', pinnedRevision, '--', 'apps/web', ':!apps/web/tool'], {
  cwd: root,
  stdio: 'inherit',
});

const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const temporaryOutput = resolve('/private/tmp', 'pirc-app-document-route-actions-parity');
await mkdir(temporaryOutput, { recursive: true });
const origin = 'http://127.0.0.1:18933';
const source = apiFixture.apiFixture;
const apiFailures = [];
const externalRequests = [];
const pageErrors = [];
const consoleErrors = [];
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
    port: 18933,
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
    const unexpected = [];
    const documentRequests = [];
    const socketAttempts = [];
    const formHtml =
      item.kind === 'form-history'
        ? `<!doctype html><html><head><meta charset="utf-8"><title>Route action form document</title></head><body><main><h1>Before the app</h1><p>This is a native HTML form history entry.</p><form id="route-form" method="get" action="${origin}${escapeAttribute(item.actionUrl)}"><label>Source value <input name="source" value="source-default"></label><button type="submit">Open app</button></form></main></body></html>`
        : undefined;

    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        externalRequests.push({ caseId: item.id, url: request.url() });
        await route.abort('blockedbyclient');
        return;
      }
      if (item.kind === 'form-history' && url.pathname === item.documentPath) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: formHtml,
        });
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
            body: JSON.stringify({
              error: { message: 'Unexpected route-action oracle API request' },
            }),
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
      // Preserve the actual app event-stream attempt without reaching a gateway.
    });

    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.addInitScript(() => {
      const metadata = { documentStartUrl: location.href, replaceStateCalls: [] };
      Object.defineProperty(window, '__appDocumentRouteActionsNavigation', {
        value: metadata,
        configurable: true,
      });
      const originalReplaceState = history.replaceState;
      history.replaceState = function (...args) {
        const before = location.href;
        const result = Reflect.apply(originalReplaceState, this, args);
        metadata.replaceStateCalls.push({
          before,
          requestedUrl: args.length >= 3 ? String(args[2]) : null,
          after: location.href,
        });
        return result;
      };
    });
    page.on('request', (request) => {
      if (request.isNavigationRequest())
        documentRequests.push({
          method: request.method(),
          url: request.url(),
          postData: request.postData() || null,
        });
    });
    page.on('websocket', (socket) => {
      const url = new URL(socket.url());
      if (url.pathname === '/api/events')
        socketAttempts.push({ path: url.pathname, rawQuery: url.search });
    });
    page.on('pageerror', (error) =>
      pageErrors.push({ caseId: item.id, error: error.stack || error.message }),
    );
    page.on('console', (message) => {
      if (message.type() === 'error')
        consoleErrors.push({ caseId: item.id, error: message.text() });
    });

    try {
      const firstUrl = item.kind === 'form-history' ? item.documentPath : item.url;
      const firstResponse = await page.goto(origin + firstUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      if (item.kind === 'form-history') {
        const initialForm = await page.evaluate(() => ({
          url: location.href,
          pathname: location.pathname,
          search: location.search,
          hash: location.hash,
          historyLength: history.length,
          formActionAttribute:
            document.querySelector('#route-form')?.getAttribute('action') ?? null,
          formActionResolved: document.querySelector('#route-form')?.action ?? null,
          title: document.title,
          sourceValue: document.querySelector('input[name="source"]')?.value ?? null,
          bodyText: document.body.innerText.replace(/\s+/g, ' ').trim(),
          navigationMetadata: window.__appDocumentRouteActionsNavigation,
        }));
        await page.locator('input[name="source"]').fill(item.formValue);
        const beforeSubmitHistoryLength = await page.evaluate(() => history.length);
        const [submitResponse] = await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
          page.getByRole('button', { name: 'Open app' }).click(),
        ]);
        await bindAppOracle(page);
        await waitForApp(page);
        await page.waitForTimeout(250);
        const afterSubmit = await snapshot(page);
        const submitRequest = [...documentRequests]
          .reverse()
          .find((entry) => entry.url.includes('/deep/form-target'));
        const afterSubmitHistoryLength = afterSubmit.historyLength;
        const beforeSelect = afterSubmit;

        const session = page
          .locator('.sidebar .session-card')
          .filter({ hasText: item.sessionLabel })
          .first();
        await session.click();
        await waitForSession(page, item.sessionId);
        await page.waitForTimeout(150);
        const afterSelect = await snapshot(page);
        const afterSelectHistoryLength = afterSelect.historyLength;

        const backResponse = await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.locator('#route-form').waitFor({ state: 'visible' });
        const backToForm = await page.evaluate(() => ({
          url: location.href,
          pathname: location.pathname,
          search: location.search,
          hash: location.hash,
          historyLength: history.length,
          title: document.title,
          sourceValue: document.querySelector('input[name="source"]')?.value ?? null,
          bodyText: document.body.innerText.replace(/\s+/g, ' ').trim(),
          navigationType: performance.getEntriesByType('navigation')[0]?.type ?? null,
          navigationMetadata: window.__appDocumentRouteActionsNavigation,
        }));

        const forwardResponse = await page.goForward({
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        });
        await bindAppOracle(page);
        await waitForApp(page);
        await page.waitForTimeout(250);
        const forwardToApp = await snapshot(page);
        captures.push({
          caseId: item.id,
          requestedDocumentUrl: origin + item.documentPath,
          initialForm,
          beforeSubmitHistoryLength,
          submittedDocumentUrl: submitResponse?.url() ?? null,
          submittedDocumentStatus: submitResponse?.status() ?? null,
          submitNavigationRequest: submitRequest ?? null,
          appAfterFormSubmit: beforeSelect,
          appAfterSidebarSelection: afterSelect,
          historyLengthAfterSubmit: afterSubmitHistoryLength,
          historyLengthAfterSidebarSelection: afterSelectHistoryLength,
          backToForm: {
            ...backToForm,
            responseStatus: backResponse?.status() ?? null,
          },
          forwardToApp: {
            ...forwardToApp,
            responseStatus: forwardResponse?.status() ?? null,
            navigationType: await page.evaluate(
              () => performance.getEntriesByType('navigation')[0]?.type ?? null,
            ),
          },
          documentRequests,
          eventStreamAttempts: socketAttempts,
          apiEventOrder: eventOrder,
          unexpectedApiRequests: unexpected,
          initialDocumentStatus: firstResponse?.status() ?? null,
        });
      } else {
        await bindAppOracle(page);
        await waitForApp(page);
        await page.waitForTimeout(250);
        const initial = await snapshot(page);
        const actions = [];
        for (const step of item.steps) {
          const before = await snapshot(page);
          await performStep(page, step);
          await page.waitForTimeout(150);
          const after = await snapshot(page);
          actions.push({ stepId: step.id, action: step.action, before, after });
        }
        captures.push({
          caseId: item.id,
          requestedUrl: origin + item.url,
          initialNavigationUrl: firstResponse?.url() ?? null,
          initialDocumentStatus: firstResponse?.status() ?? null,
          initial,
          actions,
          final: await snapshot(page),
          documentRequests,
          eventStreamAttempts: socketAttempts,
          apiEventOrder: eventOrder,
          unexpectedApiRequests: unexpected,
        });
      }
    } finally {
      await context.close();
    }
  }

  if (externalRequests.length)
    throw new Error('Unexpected external browser requests: ' + JSON.stringify(externalRequests));
  if (apiFailures.length)
    throw new Error('Unexpected API requests: ' + JSON.stringify(apiFailures));
  if (pageErrors.length)
    throw new Error('Actual App.svelte browser page errors: ' + JSON.stringify(pageErrors));
  if (consoleErrors.length)
    throw new Error('Actual App.svelte browser console errors: ' + JSON.stringify(consoleErrors));
  if (captures.some((item) => item.unexpectedApiRequests.length))
    throw new Error('Unexpected API requests were captured');

  const result = {
    fixture: fixture.id,
    reference: fixture.webRevision,
    apiFixtureReference: fixture.apiFixtureReference,
    captureMethod:
      'Actual pinned Vite App.svelte, real rendered controls, browser history, and a script-free same-origin native HTML form document; Playwright supplies only the stable API fixture and observes runtime state.',
    browser: { version: browserVersion, executable: fixture.capture.browserExecutable },
    viewport: fixture.capture.viewport,
    externalRequests,
    cases: captures,
  };
  await writeFile(expectedPath, JSON.stringify(result, null, 2) + '\n');
  console.log('Captured ' + captures.length + ' real-app route-action cases.');
  console.log(expectedPath);
  console.log(
    JSON.stringify(
      captures.map((item) => ({
        caseId: item.caseId,
        initialUrl: item.initial?.url ?? item.initialForm?.url,
        finalUrl: item.final?.url ?? item.appAfterSidebarSelection?.url,
        urlSteps:
          item.actions?.map((action) => ({ stepId: action.stepId, url: action.after.url })) ?? null,
        backToForm: item.backToForm?.url,
        forwardToApp: item.forwardToApp?.url,
        historyLengths: item.initialForm
          ? [
              item.beforeSubmitHistoryLength,
              item.historyLengthAfterSubmit,
              item.historyLengthAfterSidebarSelection,
            ]
          : item.initial?.historyLength,
      })),
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}

function escapeAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

async function bindAppOracle(page) {
  await page.evaluate(async () => {
    const module = await import('/src/lib/app.svelte.ts');
    window.__appDocumentRouteActionsOracle = module.app;
  });
}

async function waitForApp(page) {
  await page.waitForFunction(
    () =>
      window.__appDocumentRouteActionsOracle &&
      window.__appDocumentRouteActionsOracle.loading === false,
    undefined,
    { timeout: 20000 },
  );
  await page.waitForFunction(
    () => window.__appDocumentRouteActionsOracle?.sessionState !== undefined,
    undefined,
    { timeout: 10000 },
  );
}

async function snapshot(page) {
  return page.evaluate(() => {
    const app = window.__appDocumentRouteActionsOracle;
    const sidebar = document.querySelector('.sidebar');
    const activeTab = document.querySelector('.mobile-tabs [aria-current="page"]');
    return {
      url: location.href,
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
      historyLength: history.length,
      navigationMetadata: window.__appDocumentRouteActionsNavigation,
      appState: {
        view: app?.view ?? null,
        mode: app?.mode ?? null,
        activeSessionId: app?.activeSessionId ?? null,
        workspaceViewId: app?.workspaceViewId ?? null,
        sessionStateId: app?.sessionState?.session?.id ?? null,
        loading: app?.loading ?? null,
        pageError: app?.pageError || null,
        demoFallback: app?.demo !== undefined,
      },
      phoneNavigation: {
        listOpen: sidebar?.classList.contains('open') ?? false,
        sidebarVisibility: sidebar ? getComputedStyle(sidebar).visibility : null,
        activeTab: activeTab?.textContent?.replace(/\s+/g, ' ').trim() || null,
      },
      visiblePage: {
        session: !!document.querySelector('.conversation'),
        workspace: document.querySelector('.workspace-page h1')?.textContent?.trim() || null,
        schedules: !!document.querySelector('.schedules-page'),
        sessionHeading:
          document.querySelector('.workspace .topbar h1')?.textContent?.trim() || null,
      },
    };
  });
}

async function performStep(page, step) {
  if (step.action === 'mobile-menu') {
    await page.locator('.mobile-menu').click();
    await page.waitForFunction(() =>
      document.querySelector('.sidebar')?.classList.contains('open'),
    );
    return;
  }
  if (step.action === 'mobile-tab') {
    const button = page.locator('.mobile-tabs button').filter({ hasText: step.label }).first();
    const count = await button.count();
    const visible = count > 0 && (await button.isVisible());
    if (!visible) {
      const diagnostic = await page.evaluate(() => ({
        width: innerWidth,
        tabs: document.querySelector('.mobile-tabs')?.outerHTML ?? null,
        sidebar: document.querySelector('.sidebar')?.outerHTML.slice(0, 500) ?? null,
        appState: window.__appDocumentRouteActionsOracle && {
          loading: window.__appDocumentRouteActionsOracle.loading,
          view: window.__appDocumentRouteActionsOracle.view,
          mode: window.__appDocumentRouteActionsOracle.mode,
          workspaces: window.__appDocumentRouteActionsOracle.workspaces.map(
            (workspace) => workspace.id,
          ),
        },
      }));
      throw new Error(
        `Mobile tab ${step.label} missing or hidden (${count} matches): ${JSON.stringify(diagnostic)}`,
      );
    }
    await button.click();
    await page.waitForFunction(() =>
      document.querySelector('.sidebar')?.classList.contains('open'),
    );
    return;
  }
  if (step.action === 'sidebar-session') {
    await page.locator('.sidebar .session-card').filter({ hasText: step.label }).first().click();
    await waitForSession(page, step.sessionId);
    return;
  }
  if (step.action === 'sidebar-workspace') {
    await page
      .locator('.sidebar .workspace-heading > button')
      .filter({ hasText: step.label })
      .first()
      .click();
    await waitForWorkspace(page, step.workspaceId);
    return;
  }
  if (step.action === 'workspace-session') {
    await page.locator('.workspace-page .row-main').filter({ hasText: step.label }).first().click();
    await waitForSession(page, step.sessionId);
    return;
  }
  throw new Error('Unknown interaction step: ' + JSON.stringify(step));
}

async function waitForSession(page, sessionId) {
  await page.waitForFunction(
    (id) => {
      const app = window.__appDocumentRouteActionsOracle;
      return (
        app?.view === 'session' &&
        app.activeSessionId === id &&
        app.sessionState?.session?.id === id &&
        new URL(location.href).searchParams.get('session') === id
      );
    },
    sessionId,
    { timeout: 10000 },
  );
}

async function waitForWorkspace(page, workspaceId) {
  await page.waitForFunction(
    (id) => {
      const app = window.__appDocumentRouteActionsOracle;
      return (
        app?.view === 'workspace' &&
        app.workspaceViewId === id &&
        new URL(location.href).searchParams.get('workspace') === id
      );
    },
    workspaceId,
    { timeout: 10000 },
  );
}
