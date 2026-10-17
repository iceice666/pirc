// Run from the repository root:
// /opt/homebrew/bin/node apps/web/tool/parity/capture_app_document_overlays_web.mjs
// Drives pinned App.svelte over real localhost HTTP, then navigates to raw HTML documents.
// No Playwright context.route/fulfill is used; BFCache remains enabled.
import { createServer } from '../../node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const pinnedRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/app-document-overlays.json');
const expectedPath = resolve(root, 'fixtures/mobile-parity/app-document-overlays-expected.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const routeFixturePath = resolve(root, 'fixtures/mobile-parity', fixture.apiFixtureReference);
const routeFixture = JSON.parse(await readFile(routeFixturePath, 'utf8'));
if (fixture.webRevision !== pinnedRevision || routeFixture.webRevision !== pinnedRevision)
  throw new Error('Overlay fixtures must use the pinned web revision');

execFileSync('git', ['diff', '--exit-code', pinnedRevision, '--', 'apps/web', ':!apps/web/tool'], {
  cwd: root,
  stdio: 'inherit',
});

const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const { WebSocketServer } = require(require.resolve('ws'));
const temporaryOutput = resolve('/private/tmp', 'pirc-app-document-overlays-parity');
await mkdir(temporaryOutput, { recursive: true });
const origin = 'http://127.0.0.1:18944';
const source = routeFixture.apiFixture;
const memoryResponse = makeMemoryResponse();
const apiReceipts = [];
const apiFailures = [];
const documentReceipts = [];
const pendingStateReceipts = [];
const websocketReceipts = [];
const externalRequests = [];
const pageErrors = [];
const pageObservations = new Map();
const captures = [];
let browser;
let server;
let wsServer;
let releaseSlowResponse;
let resolveSlowRequestStarted;
let slowRequestStarted;
let slowRequestReceipt = null;

function makeMemoryResponse() {
  const now = 1760000000000;
  const user = Array.from({ length: fixture.memoryFixture.entryCount }, (_, index) => ({
    id: `overlay-user-${index + 1}`,
    kind: 'user',
    content: `${fixture.memoryFixture.entryTextPrefix} ${index + 1}: this long sample keeps the Settings panel scrollable so history restoration can be observed after returning from a raw document.`,
    status: 'active',
    revision: 1,
    origins: ['user'],
    sources: { sessionId: 'session-second', quote: `I mentioned preference ${index + 1}.` },
    createdAt: now - (index + 3) * 86400000,
    updatedAt: now - (index + 1) * 86400000,
  }));
  const notes = Array.from({ length: fixture.memoryFixture.noteCount }, (_, index) => ({
    id: `overlay-note-${index + 1}`,
    kind: 'note',
    content: `${fixture.memoryFixture.noteTextPrefix} ${index + 1}: a separate note with enough detail to exercise the visible memory list.`,
    status: 'active',
    revision: 1,
    origins: ['assistant'],
    sources: { sessionId: 'session-second' },
    createdAt: now - (index + 4) * 86400000,
    updatedAt: now - (index + 2) * 86400000,
  }));
  const proposals = Array.from({ length: fixture.memoryFixture.proposalCount }, (_, index) => ({
    id: `overlay-proposal-${index + 1}`,
    action: 'add',
    targetId: null,
    targetRevision: null,
    content: `Pending memory proposal ${index + 1} for the overlay oracle.`,
    quote: 'Please remember this while I am working.',
    sources: { sessionId: 'session-second', quote: 'Please remember this while I am working.' },
    sessionId: 'session-second',
    status: 'pending',
    createdAt: now - 3600000,
    decidedAt: null,
    target: null,
  }));
  return {
    usage: { user: { used: 820, max: 10000 }, note: { used: 340, max: 10000 } },
    user,
    notes,
    removed: [],
    proposals,
    sessions: { 'session-second': 'Second chat' },
  };
}

function apiResponse(url) {
  const path = url.pathname;
  if (path === '/api/workspaces')
    return { fixtureKey: 'workspaces', body: { workspaces: source.workspaces } };
  if (path === '/api/sessions')
    return { fixtureKey: 'sessions', body: { sessions: source.sessions } };
  if (path === '/api/models') return { fixtureKey: 'models', body: { models: source.models } };
  if (path === '/api/nodes') return { fixtureKey: 'nodes', body: { nodes: source.nodes } };
  if (path === '/api/memory') return { fixtureKey: 'overlayMemory', body: memoryResponse };
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
      return { fixtureKey: `snapshot:${sessionId}`, body: source.snapshots[sessionId] };
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
        fixtureKey: `schedule:${scheduleId}`,
        body: { schedule: value, runs: source.scheduleRuns },
      };
  }
  return undefined;
}

function jsonResponse(res, match) {
  const status = match ? 200 : 500;
  const body = JSON.stringify(
    match?.body ?? { error: { message: 'Unexpected overlay oracle API request' } },
  );
  res.statusCode = status;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
  return status;
}

function htmlResponse(title, body) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main>${body}</main></body></html>`;
  return {
    html,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
    },
  };
}

function contextOpenerHtml() {
  const appUrl = `${origin}/`;
  const body = `<h1>App overlay target opener</h1>
    <form id="open-blank" method="get" action="${appUrl}" target="_blank"><input type="hidden" name="session" value="session-second"><button type="submit">Open blank App</button></form>
    <form id="open-named" method="get" action="${appUrl}" target="pirc_overlay_named"><input type="hidden" name="session" value="session-second"><button type="submit">Open named App</button></form>`;
  return htmlResponse('App overlay target opener', body);
}

async function handleRequest(req, res, next) {
  const url = new URL(req.url ?? '/', origin);
  if (url.pathname.startsWith('/api/')) {
    const match = apiResponse(url);
    const referer = req.headers.referer
      ? new URL(req.headers.referer).pathname + new URL(req.headers.referer).search
      : null;
    const status = jsonResponse(res, match);
    apiReceipts.push({
      sequence: apiReceipts.length,
      pagePath: referer,
      method: req.method,
      path: url.pathname,
      rawQuery: url.search,
      fixtureKey: match?.fixtureKey ?? null,
      responseStatus: status,
    });
    if (!match) apiFailures.push({ method: req.method, path: url.pathname, pagePath: referer });
    return;
  }
  if (req.method === 'POST' && url.pathname === fixture.routes.pendingStatePath) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let report = null;
    let parseError = null;
    try {
      report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      parseError = error.message;
    }
    pendingStateReceipts.push({
      sequence: pendingStateReceipts.length,
      receivedAt: Date.now(),
      report,
      parseError,
    });
    res.writeHead(parseError ? 400 : 204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === fixture.routes.contextOpenerPath) {
    const page = contextOpenerHtml();
    res.writeHead(200, page.headers);
    res.end(page.html);
    return;
  }
  if (req.method === 'GET' && url.pathname === fixture.routes.rawDocumentPath) {
    const page = htmlResponse(
      'Raw oracle document B',
      `<h1 id="raw-document">Raw GET document B</h1><p id="raw-case">${url.searchParams.get('case') ?? 'unspecified'}</p><p>This document has no Pirc App shell or overlay.</p>`,
    );
    res.writeHead(200, { ...page.headers, 'x-oracle-document': 'raw-html-b' });
    res.end(page.html);
    return;
  }
  if (req.method === 'GET' && url.pathname === fixture.routes.slowDocumentPath) {
    slowRequestReceipt = {
      method: req.method,
      url: req.url,
      status: null,
      responseReleased: false,
    };
    resolveSlowRequestStarted?.(slowRequestReceipt);
    await new Promise((resolveRelease) => {
      releaseSlowResponse = resolveRelease;
    });
    const page = htmlResponse(
      'Slow raw oracle document B',
      `<h1 id="raw-document">Slow raw GET document B</h1><p id="raw-case">${url.searchParams.get('case') ?? 'unspecified'}</p><p>The delayed local HTTP response has been released.</p>`,
    );
    if (!res.destroyed) {
      res.writeHead(200, { ...page.headers, 'x-oracle-document': 'slow-raw-html-b' });
      res.end(page.html);
      slowRequestReceipt.status = 200;
      slowRequestReceipt.responseReleased = true;
    }
    return;
  }
  next();
}

const oraclePlugin = {
  name: 'app-document-overlays-real-http-fixtures',
  configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? '/', origin);
      if (req.headers['sec-fetch-dest'] === 'document') {
        const receipt = {
          method: req.method,
          url: req.url ?? '/',
          path: url.pathname,
          status: null,
          contentType: null,
          cacheControl: null,
          oracleDocument: null,
        };
        documentReceipts.push(receipt);
        res.once('finish', () => {
          receipt.status = res.statusCode;
          receipt.contentType = res.getHeader('content-type') ?? null;
          receipt.cacheControl = res.getHeader('cache-control') ?? null;
          receipt.oracleDocument = res.getHeader('x-oracle-document') ?? null;
        });
      }
      void handleRequest(req, res, next).catch(next);
    });
  },
};

server = await createServer({
  cacheDir: resolve(temporaryOutput, 'vite-cache'),
  plugins: [oraclePlugin],
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18944,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
    proxy: { '/api': { target: origin, changeOrigin: true, ws: false } },
  },
});

function observePage(context, page, label) {
  if (pageObservations.has(page)) return pageObservations.get(page);
  const observation = { label, navigations: [], documentResponses: [], eventStreams: [] };
  pageObservations.set(page, observation);
  page.setDefaultTimeout(8000);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.host !== new URL(origin).host)
      externalRequests.push({ page: label, url: request.url() });
    if (request.isNavigationRequest())
      observation.navigations.push({
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
      });
  });
  page.on('response', (response) => {
    if (!response.request().isNavigationRequest()) return;
    observation.documentResponses.push({
      method: response.request().method(),
      url: response.url(),
      status: response.status(),
      fromServiceWorker: response.fromServiceWorker(),
    });
  });
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    if (url.host !== new URL(origin).host)
      externalRequests.push({ page: label, url: socket.url() });
    if (url.pathname === '/api/events') observation.eventStreams.push({ url: socket.url() });
  });
  page.on('pageerror', (error) =>
    pageErrors.push({ page: label, url: page.url(), error: error.stack || error.message }),
  );
  return observation;
}

function addMetadataInit(context) {
  return context.addInitScript(() => {
    const metadata = {
      instanceId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      documentStartUrl: location.href,
      pageShows: [],
      pageHides: [],
    };
    Object.defineProperty(window, '__appOverlayOracle', { value: metadata, configurable: true });
    addEventListener('pageshow', (event) =>
      metadata.pageShows.push({ persisted: event.persisted, url: location.href, at: Date.now() }),
    );
    addEventListener('pagehide', (event) =>
      metadata.pageHides.push({ persisted: event.persisted, url: location.href, at: Date.now() }),
    );
  });
}

function contextOptions() {
  return {
    viewport: fixture.capture.viewport,
    deviceScaleFactor: fixture.capture.viewport.deviceScaleFactor,
    locale: 'en-US',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  };
}

async function waitForApp(page) {
  await page.waitForFunction(
    () => !!document.querySelector('.app-shell') && !!document.querySelector('.settings-entry'),
    null,
    { timeout: 15000 },
  );
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(150);
}

async function openSettings(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('dialog.modal-dialog.settings')?.open === true,
    null,
    { timeout: 5000 },
  );
}

async function clickWithMouse(page, selector) {
  const locator = page.locator(selector);
  await locator.waitFor({ state: 'visible', timeout: 4000 });
  const box = await locator.boundingBox();
  if (!box) throw new Error(`No visible bounds for ${selector}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(100);
}

async function selectMemoryTab(page, { pending = false } = {}) {
  if (pending) await clickWithMouse(page, '#settings-tab-memory');
  else await page.locator('#settings-tab-memory').click();
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('#settings-panel-memory');
      return (
        panel &&
        !panel.hidden &&
        !panel.querySelector('[role="status"]')?.textContent?.includes('Loading memory')
      );
    },
    null,
    { timeout: pending ? 5000 : 8000 },
  );
}

async function scrollMemoryPanel(page) {
  const panel = page.locator('.settings-panels');
  const box = await panel.boundingBox();
  if (!box) return { attempted: false, error: 'Settings panel has no visible bounds' };
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let index = 0; index < 8; index++) {
    await page.mouse.wheel(0, 520);
    await page.waitForTimeout(30);
  }
  return page.evaluate(() => {
    const element = document.querySelector('.settings-panels');
    return {
      attempted: true,
      scrollTop: element?.scrollTop ?? null,
      scrollHeight: element?.scrollHeight ?? null,
      clientHeight: element?.clientHeight ?? null,
      maxScrollTop: element ? element.scrollHeight - element.clientHeight : null,
    };
  });
}

async function openMemoryOverlay(
  page,
  { changeGeneralSetting = false, pending = false, scroll = true, confirmForget = false } = {},
) {
  await openSettings(page);
  if (changeGeneralSetting) {
    const toggle = page
      .locator('#settings-panel-general .settings-toggle input[type="checkbox"]')
      .first();
    await toggle.check();
  }
  await selectMemoryTab(page, { pending });
  const scrollState = scroll ? await scrollMemoryPanel(page) : null;
  if (confirmForget) {
    const lastEntry = page
      .locator('#settings-panel-memory .memory-list[aria-label="About you"] li')
      .last();
    await lastEntry.getByRole('button', { name: 'Forget', exact: true }).click();
    await page
      .getByRole('button', { name: 'Forget for good', exact: true })
      .waitFor({ state: 'visible' });
  }
  return { scrollState };
}

async function snapshotApp(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('dialog.modal-dialog.settings');
    const selectedTab = dialog?.querySelector('[role="tab"][aria-selected="true"]') ?? null;
    const memoryPanel = document.querySelector('#settings-panel-memory');
    const scroll = document.querySelector('.settings-panels');
    const generalToggle = document.querySelector(
      '#settings-panel-general .settings-toggle input[type="checkbox"]',
    );
    const entries = [
      ...(memoryPanel?.querySelectorAll('.memory-list[aria-label="About you"] > li') ?? []),
    ];
    const proposalEntries = [
      ...(memoryPanel?.querySelectorAll('.memory-list[aria-label="Waiting for you"] > li') ?? []),
    ];
    return {
      url: location.href,
      title: document.title,
      instanceId: window.__appOverlayOracle?.instanceId ?? null,
      documentStartUrl: window.__appOverlayOracle?.documentStartUrl ?? null,
      pageShows: window.__appOverlayOracle?.pageShows ?? [],
      pageHides: window.__appOverlayOracle?.pageHides ?? [],
      historyLength: history.length,
      visibilityState: document.visibilityState,
      appShellPresent: !!document.querySelector('.app-shell'),
      sessionHeading: document.querySelector('.workspace .topbar h1')?.textContent?.trim() ?? null,
      settings: {
        dialogElementPresent: !!dialog,
        dialogOpen: dialog?.open ?? false,
        dialogLabelledBy: dialog?.getAttribute('aria-labelledby') ?? null,
        activeTab: selectedTab?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
        activeTabId: selectedTab?.id ?? null,
        memoryPanelHidden: memoryPanel?.hidden ?? null,
        memoryPanelText: memoryPanel?.innerText?.trim().slice(0, 500) ?? null,
        memoryEntryCount: entries.length,
        firstMemoryEntry: entries[0]?.innerText?.trim().slice(0, 220) ?? null,
        lastMemoryEntry: entries.at(-1)?.innerText?.trim().slice(0, 220) ?? null,
        proposalCount: proposalEntries.length,
        memoryScroll: {
          scrollTop: scroll?.scrollTop ?? null,
          scrollHeight: scroll?.scrollHeight ?? null,
          clientHeight: scroll?.clientHeight ?? null,
        },
        showSettledChecked:
          generalToggle instanceof HTMLInputElement ? generalToggle.checked : null,
        forgetConfirmation: [...(memoryPanel?.querySelectorAll('button') ?? [])]
          .map((button) => button.textContent?.trim())
          .filter((text) => text === 'Forget for good' || text === 'Cancel'),
      },
    };
  });
}

async function snapshotDocument(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    heading: document.querySelector('h1')?.textContent?.trim() ?? null,
    bodyText: document.body?.innerText?.trim().slice(0, 500) ?? null,
    instanceId: window.__appOverlayOracle?.instanceId ?? null,
    documentStartUrl: window.__appOverlayOracle?.documentStartUrl ?? null,
    pageShows: window.__appOverlayOracle?.pageShows ?? [],
    pageHides: window.__appOverlayOracle?.pageHides ?? [],
    appShellPresent: !!document.querySelector('.app-shell'),
    settingsDialogPresent: !!document.querySelector('dialog.modal-dialog.settings'),
    openDialogCount: document.querySelectorAll('dialog[open]').length,
    historyLength: history.length,
  }));
}

async function attachCdp(context, page) {
  const session = await context.newCDPSession(page);
  const bfcacheNotUsed = [];
  const lifecycleEvents = [];
  const networkRequests = [];
  const networkResponses = [];
  session.on('Page.backForwardCacheNotUsed', (event) => bfcacheNotUsed.push(event));
  session.on('Page.lifecycleEvent', (event) => {
    if (['init', 'DOMContentLoaded', 'load', 'pageshow', 'pagehide'].includes(event.name))
      lifecycleEvents.push({ name: event.name, frameId: event.frameId, loaderId: event.loaderId });
  });
  session.on('Network.requestWillBeSent', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== origin || !url.pathname.startsWith('/__oracle/')) return;
    networkRequests.push({
      requestId: event.requestId,
      url: event.request.url,
      method: event.request.method,
      documentURL: event.documentURL,
      initiatorType: event.initiator?.type ?? null,
    });
  });
  session.on('Network.responseReceived', (event) => {
    const url = new URL(event.response.url);
    if (url.origin !== origin || !url.pathname.startsWith('/__oracle/')) return;
    networkResponses.push({
      requestId: event.requestId,
      url: event.response.url,
      status: event.response.status,
      fromDiskCache: event.response.fromDiskCache ?? false,
      fromServiceWorker: event.response.fromServiceWorker ?? false,
      responseType: event.type,
    });
  });
  await session.send('Page.enable');
  await session.send('Page.setLifecycleEventsEnabled', { enabled: true });
  await session.send('Network.enable');
  await session.send('DOM.enable');
  return { session, bfcacheNotUsed, lifecycleEvents, networkRequests, networkResponses };
}

async function boundedCdpCommand(session, method, params, timeoutMs = 2500) {
  let timer;
  try {
    return await Promise.race([
      session.send(method, params),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function dispatchCdpClick(session, rect) {
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await boundedCdpCommand(session, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await boundedCdpCommand(session, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await boundedCdpCommand(session, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
}

async function measurePendingHitTargets(page) {
  const settingsButtonRect = await page
    .locator('button.settings-entry:not(.schedules-entry)')
    .boundingBox();
  if (!settingsButtonRect) throw new Error('Could not measure the actual Settings button');
  await openSettings(page);
  const memoryTabRect = await page.locator('#settings-tab-memory').boundingBox();
  if (!memoryTabRect)
    throw new Error('Could not measure the actual Memory tab while Settings was open');
  await page.locator('dialog.modal-dialog.settings button[aria-label="Close"]').click();
  await page.waitForFunction(
    () => document.querySelector('dialog.modal-dialog.settings')?.open === false,
    null,
    { timeout: 5000 },
  );
  return { settingsButtonRect, memoryTabRect };
}

async function installPendingStateReporter(page, caseId) {
  await page.evaluate(
    ({ caseId, path }) => {
      document.addEventListener(
        'click',
        (event) => {
          const target = event.target instanceof Element ? event.target : null;
          const settingsButton = target?.closest('button.settings-entry:not(.schedules-entry)');
          const memoryTab = target?.closest('#settings-tab-memory');
          if (!settingsButton && !memoryTab) return;
          const eventTarget = settingsButton ? 'settings-button' : 'memory-tab';
          setTimeout(() => {
            const dialog = document.querySelector('dialog.modal-dialog.settings');
            const selectedTab = dialog?.querySelector('[role="tab"][aria-selected="true"]') ?? null;
            const memoryPanel = document.querySelector('#settings-panel-memory');
            const scroll = document.querySelector('.settings-panels');
            const payload = {
              caseId,
              eventTarget,
              href: location.href,
              visibilityState: document.visibilityState,
              instanceId: window.__appOverlayOracle?.instanceId ?? null,
              dialogOpen: dialog?.open ?? false,
              activeTabId: selectedTab?.id ?? null,
              activeTabText: selectedTab?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
              memoryPanelHidden: memoryPanel?.hidden ?? null,
              memoryEntryCount:
                memoryPanel?.querySelectorAll('.memory-list[aria-label="About you"] > li').length ??
                0,
              memoryScrollTop: scroll?.scrollTop ?? null,
              reportedAt: Date.now(),
            };
            navigator.sendBeacon(
              path,
              new Blob([JSON.stringify(payload)], { type: 'application/json' }),
            );
          }, 120);
        },
        false,
      );
    },
    { caseId, path: fixture.routes.pendingStatePath },
  );
}

async function waitForPendingStateReceipt(caseId, eventTarget, afterSequence, timeoutMs = 1800) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = pendingStateReceipts.find(
      (item) =>
        item.sequence >= afterSequence &&
        item.report?.caseId === caseId &&
        item.report?.eventTarget === eventTarget,
    );
    if (receipt) return receipt;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 35));
  }
  throw new Error(`No local pending-state report for ${eventTarget} arrived within ${timeoutMs}ms`);
}

async function addOracleForm(
  page,
  id,
  pathname,
  { insideDialog = false, label = 'Open raw document B' } = {},
) {
  await page.evaluate(
    ({ id, action, insideDialog, label }) => {
      const host = insideDialog
        ? document.querySelector('dialog.modal-dialog.settings')
        : document.body;
      if (!host) throw new Error('Expected Settings dialog as form host');
      const form = document.createElement('form');
      form.id = id;
      form.method = 'get';
      const destination = new URL(action);
      form.action = `${destination.origin}${destination.pathname}`;
      for (const [name, value] of destination.searchParams) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.append(input);
      }
      form.style.cssText =
        'position:fixed;right:24px;bottom:24px;z-index:2147483647;padding:8px;background:white;color:black;border:1px solid #333';
      const button = document.createElement('button');
      button.type = 'submit';
      button.textContent = label;
      form.append(button);
      host.append(form);
    },
    { id, action: `${origin}${pathname}`, insideDialog, label },
  );
}

async function submitOracleForm(page, id) {
  const navigation = page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 })
    .then(() => ({ completed: true }))
    .catch((error) => ({ completed: false, error: error.message }));
  await page.locator(`#${id} button[type="submit"]`).click({ noWaitAfter: true });
  return navigation;
}

async function goBack(page) {
  const targetUrl = new URL(fixture.routes.appSessionUrl, origin).href;
  await page.evaluate(() => history.back());
  const deadline = Date.now() + 15000;
  let result = { completed: false, error: 'History did not return to the App URL within 15000ms' };
  while (Date.now() < deadline) {
    if (page.url() === targetUrl) {
      result = { completed: true, observedBy: 'URL polling after history.back' };
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
  }
  await page.waitForTimeout(150);
  return { navigation: result, currentUrl: page.url() };
}

async function saveScreenshot(page, name) {
  const path = resolve(temporaryOutput, `${name}.png`);
  try {
    await page.screenshot({ path, fullPage: true, timeout: 10000 });
    return { path, saved: true };
  } catch (error) {
    return { path, saved: false, error: error.message };
  }
}

async function captureSettingsMemoryHistory(browserTarget) {
  const caseId = 'app-settings-memory-bfcache';
  const context = await browserTarget.newContext(contextOptions());
  await addMetadataInit(context);
  context.on('page', (page) =>
    observePage(context, page, `${caseId}-page-${pageObservations.size + 1}`),
  );
  const page = await context.newPage();
  const observation = observePage(context, page, caseId);
  const cdp = await attachCdp(context, page);
  try {
    await page.goto(`${origin}${fixture.routes.appSessionUrl}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await waitForApp(page);
    await openMemoryOverlay(page, {
      changeGeneralSetting: true,
      scroll: true,
      confirmForget: true,
    });
    const beforeNavigation = await snapshotApp(page);
    const beforeScreenshot = await saveScreenshot(page, 'case-1-app-settings-memory-before');
    const rawPath = `${fixture.routes.rawDocumentPath}?case=app-settings-memory-bfcache`;
    await addOracleForm(page, 'overlay-history-form', rawPath, { insideDialog: true });
    const formNavigation = await submitOracleForm(page, 'overlay-history-form');
    const afterGet = await snapshotDocument(page);
    const bScreenshot = await saveScreenshot(page, 'case-1-raw-document-b');
    const back = await goBack(page);
    await waitForApp(page);
    const afterBack = await snapshotApp(page);
    const afterScreenshot = await saveScreenshot(page, 'case-1-app-settings-memory-after-back');
    return {
      caseId,
      navigation: {
        sourceAction: 'harness-inserted real HTML GET form inside the actual open Settings dialog',
        formAction: `${origin}${rawPath}`,
        formNavigation: await formNavigation,
        back,
      },
      beforeNavigation,
      rawDocument: afterGet,
      afterBack,
      bfcacheNotUsed: cdp.bfcacheNotUsed,
      lifecycleEvents: cdp.lifecycleEvents,
      oracleRequests: cdp.networkRequests,
      oracleResponses: cdp.networkResponses,
      documentReceipts: documentReceipts.filter(
        (entry) => entry.path === fixture.routes.rawDocumentPath,
      ),
      apiReceipts: apiReceipts.filter(
        (entry) => entry.pagePath?.startsWith('/') && entry.fixtureKey === 'overlayMemory',
      ),
      pageNavigations: observation.navigations,
      pageDocumentResponses: observation.documentResponses,
      eventStreams: observation.eventStreams,
      screenshots: {
        beforeNavigation: beforeScreenshot,
        rawDocument: bScreenshot,
        afterBack: afterScreenshot,
      },
      restoredSameAppInstance: beforeNavigation.instanceId === afterBack.instanceId,
      restoredSettingsDialog: afterBack.settings.dialogOpen,
      restoredMemoryTab: afterBack.settings.activeTab === 'Memory',
      restoredScrollTop: afterBack.settings.memoryScroll.scrollTop,
      restoredForgetConfirmation: afterBack.settings.forgetConfirmation,
      restoredShowSettledEdit: afterBack.settings.showSettledChecked,
    };
  } finally {
    await cdp.session.detach().catch(() => undefined);
    await context.close();
  }
}

async function captureSlowNavigationOverlay(browserTarget) {
  const caseId = 'app-settings-while-slow-get-pending';
  const context = await browserTarget.newContext(contextOptions());
  await addMetadataInit(context);
  context.on('page', (page) =>
    observePage(context, page, `${caseId}-page-${pageObservations.size + 1}`),
  );
  const page = await context.newPage();
  const observation = observePage(context, page, caseId);
  const cdp = await attachCdp(context, page);
  try {
    await page.goto(`${origin}${fixture.routes.appSessionUrl}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await waitForApp(page);
    const hitTargets = await measurePendingHitTargets(page);
    await installPendingStateReporter(page, caseId);
    const settingsButtonRect = hitTargets.settingsButtonRect;
    await addOracleForm(
      page,
      'slow-overlay-form',
      `${fixture.routes.slowDocumentPath}?case=${caseId}`,
      { label: 'Submit delayed GET document' },
    );
    slowRequestStarted = new Promise((resolveStarted) => {
      resolveSlowRequestStarted = resolveStarted;
    });
    const navigation = page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 })
      .then(() => ({ completed: true }))
      .catch((error) => ({ completed: false, error: error.message }));
    await page.evaluate(() =>
      document.querySelector('#slow-overlay-form button[type="submit"]')?.click(),
    );
    const requestStarted = await Promise.race([
      slowRequestStarted,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Slow document request did not reach local server')),
          8000,
        ),
      ),
    ]);
    let pendingInteraction = {
      attempted: true,
      succeeded: false,
      method:
        'CDP Input.dispatchMouseEvent at the App Settings button rect measured before provisional navigation',
      settingsButtonRect,
      memoryTabRect: hitTargets.memoryTabRect,
      settingsClickSent: false,
      memoryTabClickSent: false,
      reports: [],
      error: null,
      state: null,
    };
    try {
      const firstSequence = pendingStateReceipts.length;
      await dispatchCdpClick(cdp.session, settingsButtonRect);
      pendingInteraction.settingsClickSent = true;
      const settingsReport = await waitForPendingStateReceipt(
        caseId,
        'settings-button',
        firstSequence,
      );
      pendingInteraction.reports.push(settingsReport);
      if (!settingsReport.report.dialogOpen)
        throw new Error(
          `Settings did not open from CDP pointer input: ${JSON.stringify(settingsReport.report)}`,
        );
      const memorySequence = pendingStateReceipts.length;
      await dispatchCdpClick(cdp.session, hitTargets.memoryTabRect);
      pendingInteraction.memoryTabClickSent = true;
      const memoryReport = await waitForPendingStateReceipt(caseId, 'memory-tab', memorySequence);
      pendingInteraction.reports.push(memoryReport);
      const state = memoryReport.report;
      pendingInteraction.succeeded =
        state.dialogOpen &&
        state.activeTabId === 'settings-tab-memory' &&
        state.memoryPanelHidden === false;
      pendingInteraction.state = state;
      if (!pendingInteraction.succeeded)
        throw new Error(
          `Memory tab did not become active from CDP pointer input: ${JSON.stringify(state)}`,
        );
    } catch (error) {
      pendingInteraction.error = error.message;
    }
    releaseSlowResponse?.();
    const navigationResult = await navigation;
    const slowDocument = await snapshotDocument(page);
    const bScreenshot = await saveScreenshot(page, 'case-2-slow-raw-document-b');
    const back = await goBack(page);
    const afterBack = await snapshotApp(page).catch((error) => ({
      snapshotError: error.message,
      url: page.url(),
    }));
    const bfcacheDetails = cdp.bfcacheNotUsed;
    let fallback = null;
    if (!pendingInteraction.succeeded) {
      fallback = {
        mode: 'direct real HTML form GET after the held-response attempt; reuse an already-open Settings dialog if the CDP Settings click succeeded before Memory selection failed.',
      };
      await waitForApp(page);
      let currentOverlay = await snapshotApp(page);
      fallback.stateAfterFirstBack = currentOverlay;
      if (!currentOverlay.settings.dialogOpen) {
        await openSettings(page);
        currentOverlay = await snapshotApp(page);
      }
      const fallbackToggle = page
        .locator('#settings-panel-general .settings-toggle input[type="checkbox"]')
        .first();
      if (!(await fallbackToggle.isChecked())) await fallbackToggle.check();
      if (currentOverlay.settings.activeTabId !== 'settings-tab-memory')
        await selectMemoryTab(page);
      await scrollMemoryPanel(page);
      const confirmation = page.getByRole('button', { name: 'Forget for good', exact: true });
      if (!(await confirmation.count())) {
        const lastEntry = page
          .locator('#settings-panel-memory .memory-list[aria-label="About you"] li')
          .last();
        await lastEntry.getByRole('button', { name: 'Forget', exact: true }).click();
      }
      await page
        .getByRole('button', { name: 'Forget for good', exact: true })
        .waitFor({ state: 'visible' });
      fallback.beforeNavigation = await snapshotApp(page);
      await addOracleForm(
        page,
        'slow-overlay-fallback-form',
        `${fixture.routes.rawDocumentPath}?case=slow-overlay-fallback`,
        { insideDialog: true, label: 'Open fallback raw document' },
      );
      const fallbackNavigation = await submitOracleForm(page, 'slow-overlay-fallback-form');
      fallback.rawDocument = await snapshotDocument(page);
      fallback.navigation = await fallbackNavigation;
      fallback.back = await goBack(page);
      await waitForApp(page);
      fallback.afterBack = await snapshotApp(page);
      fallback.restoredSameAppInstance =
        fallback.beforeNavigation.instanceId === fallback.afterBack.instanceId;
    }
    return {
      caseId,
      navigation: {
        sourceAction: 'harness-inserted real same-origin HTML GET form',
        formAction: `${origin}${fixture.routes.slowDocumentPath}?case=${caseId}`,
        requestStarted,
        responseReleased: slowRequestReceipt?.responseReleased ?? false,
        navigation: navigationResult,
        back,
      },
      pendingInteraction,
      slowServerReceipt: slowRequestReceipt,
      rawDocument: slowDocument,
      afterBack,
      bfcacheNotUsed: bfcacheDetails,
      lifecycleEvents: cdp.lifecycleEvents,
      oracleRequests: cdp.networkRequests,
      oracleResponses: cdp.networkResponses,
      documentReceipts: documentReceipts.filter(
        (entry) =>
          entry.path === fixture.routes.slowDocumentPath ||
          entry.path === fixture.routes.rawDocumentPath,
      ),
      apiReceipts: apiReceipts.filter((entry) => entry.fixtureKey === 'overlayMemory'),
      pageNavigations: observation.navigations,
      pageDocumentResponses: observation.documentResponses,
      eventStreams: observation.eventStreams,
      screenshots: { rawDocument: bScreenshot },
      restoredSameAppInstance: pendingInteraction.succeeded
        ? pendingInteraction.state.instanceId === afterBack.instanceId
        : (fallback?.restoredSameAppInstance ?? false),
      restoredSettingsDialog: afterBack.settings?.dialogOpen ?? false,
      restoredMemoryTab: afterBack.settings?.activeTab === 'Memory',
      fallback,
    };
  } finally {
    releaseSlowResponse?.();
    await cdp.session.detach().catch(() => undefined);
    await context.close();
  }
}

async function openFormTarget(opener, formSelector) {
  const popup = opener.waitForEvent('popup', { timeout: 12000 });
  await opener.locator(`${formSelector} button[type="submit"]`).click();
  const page = await popup;
  await waitForApp(page);
  return page;
}

async function captureIndependentContextOverlays(browserTarget) {
  const caseId = 'blank-and-named-app-overlays-independent';
  const context = await browserTarget.newContext(contextOptions());
  await addMetadataInit(context);
  context.on('page', (page) =>
    observePage(context, page, `${caseId}-page-${pageObservations.size + 1}`),
  );
  const opener = await context.newPage();
  const openerObservation = observePage(context, opener, `${caseId}-opener`);
  try {
    await opener.goto(`${origin}${fixture.routes.contextOpenerPath}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    const blankApp = await openFormTarget(opener, '#open-blank');
    const blankObservation = observePage(context, blankApp, `${caseId}-blank-app`);
    const namedApp = await openFormTarget(opener, '#open-named');
    const namedObservation = observePage(context, namedApp, `${caseId}-named-app`);

    await openSettings(blankApp);
    await blankApp
      .locator('#settings-panel-general .settings-toggle input[type="checkbox"]')
      .first()
      .check();
    await selectMemoryTab(blankApp);
    await scrollMemoryPanel(blankApp);

    await openSettings(namedApp);
    const blankStateWhileNamedFront = await snapshotApp(blankApp);
    const namedState = await snapshotApp(namedApp);
    await saveScreenshot(blankApp, 'case-3-blank-app-settings-memory');
    await saveScreenshot(namedApp, 'case-3-named-app-settings-general');

    await blankApp.bringToFront();
    const blankStateAfterSwitch = await snapshotApp(blankApp);
    await namedApp.bringToFront();
    const namedStateAfterSwitch = await snapshotApp(namedApp);
    const openerState = await opener.evaluate(() => ({
      url: location.href,
      windowName: window.name,
      appShellPresent: !!document.querySelector('.app-shell'),
    }));
    return {
      caseId,
      openerState,
      pageCount: context.pages().length,
      blankApp: {
        windowName:
          blankStateAfterSwitch.windowName ?? (await blankApp.evaluate(() => window.name)),
        openerPresent: await blankApp.evaluate(() => !!window.opener),
        instanceId: blankStateAfterSwitch.instanceId,
        firstSnapshot: blankStateWhileNamedFront,
        afterSwitch: blankStateAfterSwitch,
        navigations: blankObservation.navigations,
        documentResponses: blankObservation.documentResponses,
        eventStreams: blankObservation.eventStreams,
      },
      namedApp: {
        windowName: await namedApp.evaluate(() => window.name),
        openerPresent: await namedApp.evaluate(() => !!window.opener),
        instanceId: namedStateAfterSwitch.instanceId,
        firstSnapshot: namedState,
        afterSwitch: namedStateAfterSwitch,
        navigations: namedObservation.navigations,
        documentResponses: namedObservation.documentResponses,
        eventStreams: namedObservation.eventStreams,
      },
      openerNavigations: openerObservation.navigations,
      distinctDocuments: blankStateAfterSwitch.instanceId !== namedStateAfterSwitch.instanceId,
      bothDialogsRemainOpen:
        blankStateAfterSwitch.settings.dialogOpen && namedStateAfterSwitch.settings.dialogOpen,
      selectedTabsStayIndependent:
        blankStateAfterSwitch.settings.activeTab !== namedStateAfterSwitch.settings.activeTab,
      bothAppContextsShareFixtureOriginStorage: await Promise.all(
        [blankApp, namedApp].map((page) => page.evaluate(() => location.origin)),
      ),
    };
  } finally {
    await context.close();
  }
}

let browserVersion;
try {
  await server.listen();
  const httpServer = server.httpServer;
  if (!httpServer) throw new Error('Vite did not expose the local HTTP server');
  wsServer = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname !== '/api/events') return;
    const referer = req.headers.referer
      ? new URL(req.headers.referer).pathname + new URL(req.headers.referer).search
      : null;
    const receipt = {
      pagePath: referer,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      connected: false,
      closed: false,
    };
    websocketReceipts.push(receipt);
    wsServer.handleUpgrade(req, socket, head, (client) => {
      receipt.connected = true;
      client.once('close', () => {
        receipt.closed = true;
      });
      wsServer.emit('connection', client, req);
    });
  });
  wsServer.on('connection', (socket) => socket.on('error', () => undefined));

  browser = await chromium.launch({
    executablePath: fixture.capture.browserExecutable,
    headless: true,
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
  });
  browserVersion = await browser.version();
  if (!browserVersion.startsWith('154.'))
    throw new Error(`Expected pinned Chrome 154, got ${browserVersion}`);

  captures.push(await captureSettingsMemoryHistory(browser));
  captures.push(await captureSlowNavigationOverlay(browser));
  captures.push(await captureIndependentContextOverlays(browser));

  if (apiFailures.length)
    throw new Error(`Unexpected local API requests: ${JSON.stringify(apiFailures)}`);
  if (externalRequests.length)
    throw new Error(`Unexpected external requests: ${JSON.stringify(externalRequests)}`);
  if (pageErrors.length)
    throw new Error(`Pinned App browser errors: ${JSON.stringify(pageErrors)}`);

  const result = {
    fixture: fixture.id,
    reference: fixture.webRevision,
    apiFixtureReference: fixture.apiFixtureReference,
    captureMethod:
      'Chrome 154, actual pinned App.svelte served by local Vite, local fixture HTTP API/WebSocket, real same-origin GET documents and HTML form targets; no Playwright route interception or fulfill; BFCache enabled.',
    browser: {
      version: browserVersion,
      executable: fixture.capture.browserExecutable,
      backForwardCacheDefaultDisabledArgRemoved: true,
    },
    viewport: fixture.capture.viewport,
    memoryApiFixture: {
      entryCount: memoryResponse.user.length,
      noteCount: memoryResponse.notes.length,
      proposalCount: memoryResponse.proposals.length,
    },
    cases: captures,
    serverReceipts: {
      documentRequests: documentReceipts,
      apiRequests: apiReceipts,
      websocketConnections: websocketReceipts,
    },
    diagnostics: { apiFailures, externalRequests, pageErrors },
  };
  await writeFile(expectedPath, JSON.stringify(result, null, 2) + '\n');
  console.log(
    `Captured ${captures.length} actual-browser overlay cases using Chrome ${browserVersion}.`,
  );
  console.log(expectedPath);
  console.log(
    JSON.stringify(
      captures.map((item) => ({
        caseId: item.caseId,
        sourceInstance: item.beforeNavigation?.instanceId ?? null,
        afterBackInstance:
          item.afterBack?.instanceId ?? item.fallback?.afterBack?.instanceId ?? null,
        pageshow: item.afterBack?.pageShows ?? item.fallback?.afterBack?.pageShows ?? null,
        settingsAfterBack: item.afterBack?.settings ?? item.fallback?.afterBack?.settings ?? null,
        pendingInteraction: item.pendingInteraction ?? null,
        bfcacheNotUsed:
          item.bfcacheNotUsed?.map((entry) =>
            entry.notRestoredExplanations?.map((reason) => reason.reason),
          ) ?? [],
        independent:
          item.distinctDocuments === undefined
            ? null
            : {
                distinctDocuments: item.distinctDocuments,
                bothDialogsRemainOpen: item.bothDialogsRemainOpen,
                selectedTabsStayIndependent: item.selectedTabsStayIndependent,
              },
      })),
      null,
      2,
    ),
  );
} finally {
  releaseSlowResponse?.();
  await browser?.close();
  await new Promise((resolveClose) => wsServer?.close(resolveClose));
  await server?.close();
}
