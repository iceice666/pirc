// Run from the repository root:
// /opt/homebrew/bin/node apps/web/tool/parity/capture_document_cache_web.mjs
// Uses real localhost HTTP responses and CDP observations; no Playwright HTTP routes are installed.
import { createServer } from '../../node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const pinnedRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/document-cache.json');
const expectedPath = resolve(root, 'fixtures/mobile-parity/document-cache-expected.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const apiFixturePath = resolve(root, 'fixtures/mobile-parity', fixture.apiFixtureReference);
const apiFixture = JSON.parse(await readFile(apiFixturePath, 'utf8'));
if (fixture.webRevision !== pinnedRevision || apiFixture.webRevision !== pinnedRevision)
  throw new Error('Document cache fixtures must use the pinned web revision');

execFileSync('git', ['diff', '--exit-code', pinnedRevision, '--', 'apps/web', ':!apps/web/tool'], {
  cwd: root,
  stdio: 'inherit',
});

const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const { WebSocketServer } = require(require.resolve('ws'));
const temporaryOutput = resolve('/private/tmp', 'pirc-document-cache-parity');
await mkdir(temporaryOutput, { recursive: true });
const origin = 'http://127.0.0.1:18934';
const source = apiFixture.apiFixture;
const caseByPath = new Map(fixture.cacheCases.map((item) => [item.path, item]));
caseByPath.set(fixture.backForwardCacheCase.path, fixture.backForwardCacheCase);
const caseState = new Map(
  [...fixture.cacheCases, fixture.backForwardCacheCase].map((item) => [
    item.id,
    { version: item.initialVersion },
  ]),
);
const httpReceipts = [];
const websocketReceipts = [];
const apiFailures = [];
const activeCaseByContext = new Map();
let activeCaseId = null;
let server;
let wsServer;
let browser;
let bfcacheBrowser;
const captures = [];

function safeHeaders(headers) {
  const allowed = new Set([
    'accept',
    'accept-language',
    'cache-control',
    'content-type',
    'if-modified-since',
    'if-none-match',
    'origin',
    'pragma',
    'referer',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'user-agent',
  ]);
  const output = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase();
    if (allowed.has(key)) output[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return output;
}

function safeResponseHeaders(headers) {
  const allowed = new Set([
    'cache-control',
    'content-length',
    'content-type',
    'etag',
    'expires',
    'last-modified',
    'pragma',
    'vary',
  ]);
  const output = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase();
    if (allowed.has(key)) output[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return output;
}

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

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function etagFor(item, version) {
  const tag = item.validatorChangesWithBody ? version : 'stable';
  return `"${item.id}-${tag}"`;
}

function modifiedFor(version) {
  return version === 'v1' ? 'Thu, 01 Oct 2026 00:00:00 GMT' : 'Fri, 02 Oct 2026 00:00:00 GMT';
}

function cacheDocument(item, version) {
  const formProbe = item.formStateProbe
    ? '<form id="state-probe"><label>Text <input id="state-text" name="text" value="default text"></label><label>Autocomplete off <input id="state-off" name="off" autocomplete="off" value="default off"></label><label>Checked <input id="state-check" name="check" type="checkbox"></label><label>Choice <select id="state-select" name="choice"><option value="one">One</option><option value="two">Two</option></select></label></form>'
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(item.id)}</title></head><body><main><h1 id="document-title">${escapeHtml(item.id)}</h1><p id="server-version">Server document ${escapeHtml(version)}</p>${formProbe}<a id="open-pirc" href="/?session=session-latest">Open the Pirc app</a></main></body></html>`;
}

function responseReceipt(req, res, record) {
  httpReceipts.push({
    caseId: activeCaseId,
    sequence: httpReceipts.length,
    method: req.method,
    url: req.url,
    requestHeaders: safeHeaders(req.headers),
    ...record,
    responseStatus: res.statusCode,
    responseHeaders: safeResponseHeaders(res.getHeaders()),
  });
}

function apiReceipt(req, res, url, fixtureKey, status) {
  httpReceipts.push({
    caseId: activeCaseId,
    sequence: httpReceipts.length,
    kind: 'api',
    method: req.method,
    path: url.pathname,
    rawQuery: url.search,
    requestHeaders: safeHeaders(req.headers),
    fixtureKey,
    responseStatus: status,
    responseHeaders: safeResponseHeaders(res.getHeaders()),
  });
}

function sendApi(req, res, url) {
  const response = apiResponse(url);
  const body = response
    ? JSON.stringify(response.body)
    : JSON.stringify({ error: { message: 'Unexpected cache-oracle API request' } });
  const status = response ? 200 : 500;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', Buffer.byteLength(body));
  apiReceipt(req, res, url, response?.fixtureKey ?? null, status);
  if (!response) apiFailures.push({ caseId: activeCaseId, path: url.pathname, method: req.method });
  res.end(body);
}

function sendCacheDocument(req, res, item) {
  const state = caseState.get(item.id);
  const version = state.version;
  const headers = {
    'cache-control': item.cacheControl,
    'content-type': 'text/html; charset=utf-8',
  };
  if (item.validator === 'etag') headers.etag = etagFor(item, version);
  if (item.validator === 'last-modified')
    headers['last-modified'] = item.validatorChangesWithBody
      ? modifiedFor(version)
      : modifiedFor('v1');

  let notModified = false;
  if (req.method === 'GET' && item.validator === 'etag')
    notModified = req.headers['if-none-match'] === headers.etag;
  if (req.method === 'GET' && item.validator === 'last-modified')
    notModified = req.headers['if-modified-since'] === headers['last-modified'];

  res.statusCode = notModified ? 304 : 200;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (!notModified) {
    const body = cacheDocument(item, version);
    res.setHeader('content-length', Buffer.byteLength(body));
    responseReceipt(req, res, {
      kind: 'cache-document',
      caseId: item.id,
      version,
      validator: item.validator,
    });
    res.end(body);
  } else {
    responseReceipt(req, res, {
      kind: 'cache-revalidation',
      caseId: item.id,
      version,
      validator: item.validator,
    });
    res.end();
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function htmlPage(title, body, cacheControl = 'no-store') {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
  return {
    html,
    headers: {
      'cache-control': cacheControl,
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
    },
  };
}

async function handleLocalRequest(req, res, next) {
  const url = new URL(req.url ?? '/', origin);
  if (url.pathname.startsWith('/api/')) {
    sendApi(req, res, url);
    return;
  }
  const cacheCase = caseByPath.get(url.pathname);
  if (cacheCase && req.method === 'GET') {
    sendCacheDocument(req, res, cacheCase);
    return;
  }
  if (url.pathname === fixture.postCase.entryPath && req.method === 'GET') {
    const page = htmlPage(
      'POST entry document',
      `<main><h1>POST entry</h1><form id="post-form" method="post" action="${fixture.postCase.resultPath}"><label>Payload <input name="payload" value="post-default"></label><button type="submit">Submit POST</button></form></main>`,
    );
    res.writeHead(200, page.headers);
    responseReceipt(req, res, { kind: 'post-entry' });
    res.end(page.html);
    return;
  }
  if (url.pathname === fixture.postCase.resultPath && req.method === 'POST') {
    const body = await readBody(req);
    const decoded = new URLSearchParams(body).get('payload') ?? '';
    const page = htmlPage(
      'POST result document',
      `<main><h1>POST result</h1><p id="post-body">${escapeHtml(decoded)}</p></main>`,
    );
    res.writeHead(200, page.headers);
    responseReceipt(req, res, { kind: 'post-result', body, decoded });
    res.end(page.html);
    return;
  }
  if (url.pathname === fixture.postCase.resultPath && req.method === 'GET') {
    const page = htmlPage(
      'Unexpected GET result',
      '<main><h1 id="post-body">GET result</h1></main>',
    );
    res.writeHead(200, page.headers);
    responseReceipt(req, res, { kind: 'post-unexpected-get' });
    res.end(page.html);
    return;
  }
  next();
}

const oraclePlugin = {
  name: 'document-cache-oracle-http-fixtures',
  configureServer(vite) {
    // Vite's connect middleware reaches this before its SPA fallback/static handler.
    vite.middlewares.use((req, res, next) => {
      void handleLocalRequest(req, res, next).catch(next);
    });
  },
};

server = await createServer({
  plugins: [oraclePlugin],
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18934,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
    proxy: {
      // The fixture middleware serves API HTTP requests. Disable Vite's configured
      // ws proxy so the local event-stream server below receives the real upgrade.
      '/api': { target: origin, changeOrigin: true, ws: false },
    },
  },
});

try {
  await server.listen();
  const httpServer = server.httpServer;
  if (!httpServer) throw new Error('Vite did not expose its real HTTP server');
  wsServer = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname !== '/api/events') return;
    const safeQuery = {};
    for (const key of ['sessionId', 'cursor', 'directory', 'memory', 'schedules', 'sessions']) {
      if (url.searchParams.has(key)) safeQuery[key] = url.searchParams.get(key);
    }
    const receipt = {
      caseId: activeCaseId,
      path: url.pathname,
      query: safeQuery,
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
  wsServer.on('connection', (socket) => {
    // App bootstrap only needs an open local event stream for this static fixture.
    socket.on('error', () => undefined);
  });

  browser = await chromium.launch({
    executablePath: fixture.capture.browserExecutable,
    headless: true,
    // Playwright disables BFCache by default. Remove only that launch flag so these
    // history traversals exercise Chrome's actual cache eligibility decisions.
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
  });
  const browserVersion = await browser.version();
  if (!browserVersion.startsWith('154.'))
    throw new Error('Expected pinned Chrome 154, got ' + browserVersion);

  for (const item of [...fixture.cacheCases, fixture.backForwardCacheCase]) {
    activeCaseId = item.id;
    caseState.set(item.id, { version: item.initialVersion });
    const capture = await captureCacheCase(browser, item);
    captures.push(capture);
  }

  activeCaseId = fixture.postCase.id;
  captures.push(await capturePostCase(browser, fixture.postCase));
  activeCaseId = fixture.postCase.keyboardHistoryCaseId;
  captures.push(
    await capturePostKeyboardCase(
      browser,
      fixture.postCase,
      fixture.postCase.keyboardHistoryCaseId,
    ),
  );

  if (apiFailures.length)
    throw new Error('Unexpected local API requests: ' + JSON.stringify(apiFailures));
  if (!websocketReceipts.length)
    throw new Error('The pinned App never opened the expected same-origin event stream');
  const result = {
    fixture: fixture.id,
    reference: fixture.webRevision,
    apiFixtureReference: fixture.apiFixtureReference,
    captureMethod:
      'Actual Chrome 154 over a real localhost HTTP server. No Playwright HTTP route/fulfill is installed. Vite serves the pinned App shell/assets, local middleware serves fixture API and response-policy documents, and a local WebSocket server supplies the event endpoint.',
    browser: {
      version: browserVersion,
      executable: fixture.capture.browserExecutable,
      httpCacheMatrix: {
        playwrightHttpRouting: false,
        playwrightDefaultBfcacheDisableFlagRemoved: '--disable-back-forward-cache',
        bfcacheObservedByPageshow: true,
      },
    },
    viewport: fixture.capture.viewport,
    cacheResponsePolicies: fixture.cacheCases.map(
      ({ id, path, cacheControl, validator, formStateProbe, reloadMode }) => ({
        id,
        path,
        cacheControl,
        validator,
        formStateProbe: formStateProbe ?? false,
        reloadMode: reloadMode ?? null,
      }),
    ),
    serverReceipts: httpReceipts.filter((receipt) => receipt.kind !== 'api'),
    websocketReceipts,
    apiFailures,
    cases: captures,
  };
  await writeFile(expectedPath, JSON.stringify(result, null, 2) + '\n');
  console.log('Captured ' + captures.length + ' real-HTTP document-cache cases.');
  console.log(expectedPath);
  console.log(
    JSON.stringify(
      captures.map((item) => ({
        caseId: item.caseId,
        back: item.back?.document?.bodyVersion ?? item.back?.bodyVersion ?? null,
        backStatus: item.back?.responseStatus ?? null,
        reload: item.reload?.bodyVersion ?? null,
        reloadStatus: item.reload?.responseStatus ?? null,
        pageshow: item.back?.document?.pageShows ?? item.back?.pageShows ?? null,
        forwardPageshow: item.forward?.app?.pageShows ?? null,
        appConnectionRestored: item.forward?.appConnectionRestored ?? null,
        history: item.history ?? null,
        dialogs: item.dialogs ?? null,
      })),
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await bfcacheBrowser?.close();
  await new Promise((resolveClose) => wsServer?.close(resolveClose));
  await server?.close();
}

function attachCdp(page) {
  const entries = [];
  const byRequestId = new Map();
  const cacheEvents = [];
  const bfcacheEvents = [];
  const lifecycleEvents = [];
  return (async () => {
    const cdp = await page.context().newCDPSession(page);
    cdp.on('Network.requestWillBeSent', (event) => {
      const entry = {
        requestId: event.requestId,
        url: event.request.url,
        method: event.request.method,
        resourceType: event.type ?? null,
        requestHeaders: safeHeaders(event.request.headers),
        redirectResponse: event.redirectResponse
          ? {
              status: event.redirectResponse.status,
              headers: safeResponseHeaders(event.redirectResponse.headers),
            }
          : null,
      };
      entries.push(entry);
      byRequestId.set(event.requestId, entry);
    });
    cdp.on('Network.requestWillBeSentExtraInfo', (event) => {
      const entry = byRequestId.get(event.requestId);
      if (entry) entry.extraRequestHeaders = safeHeaders(event.headers);
    });
    cdp.on('Network.responseReceived', (event) => {
      const entry = byRequestId.get(event.requestId);
      if (!entry) return;
      entry.response = {
        status: event.response.status,
        mimeType: event.response.mimeType,
        fromDiskCache: event.response.fromDiskCache ?? false,
        fromServiceWorker: event.response.fromServiceWorker ?? false,
        fromPrefetchCache: event.response.fromPrefetchCache ?? false,
        headers: safeResponseHeaders(event.response.headers),
      };
    });
    cdp.on('Network.requestServedFromCache', (event) => {
      const entry = byRequestId.get(event.requestId);
      cacheEvents.push({ url: entry?.url ?? null, type: 'requestServedFromCache' });
      if (entry) entry.requestServedFromCache = true;
    });
    cdp.on('Network.loadingFinished', (event) => {
      const entry = byRequestId.get(event.requestId);
      if (entry) entry.encodedDataLength = event.encodedDataLength;
    });
    cdp.on('Network.loadingFailed', (event) => {
      const entry = byRequestId.get(event.requestId);
      if (entry)
        entry.loadingFailed = { errorText: event.errorText, canceled: event.canceled ?? false };
    });
    cdp.on('Page.backForwardCacheNotUsed', (event) => bfcacheEvents.push(event));
    cdp.on('Page.lifecycleEvent', (event) => {
      if (['init', 'DOMContentLoaded', 'load', 'pageshow', 'pagehide'].includes(event.name))
        lifecycleEvents.push({ name: event.name });
    });
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true });
    return { cdp, entries, cacheEvents, bfcacheEvents, lifecycleEvents };
  })();
}

async function addPageMetadata(page) {
  await page.addInitScript(() => {
    const metadata = { documentStartUrl: location.href, pageShows: [], pageHides: [] };
    Object.defineProperty(window, '__documentCacheOracle', { value: metadata, configurable: true });
    addEventListener('pageshow', (event) =>
      metadata.pageShows.push({ persisted: event.persisted, url: location.href }),
    );
    addEventListener('pagehide', (event) =>
      metadata.pageHides.push({ persisted: event.persisted, url: location.href }),
    );
  });
}

async function bindApp(page) {
  await page.evaluate(async () => {
    const module = await import('/src/lib/app.svelte.ts');
    window.__documentCacheAppOracle = module.app;
  });
  await page.waitForFunction(
    () =>
      window.__documentCacheAppOracle?.loading === false &&
      window.__documentCacheAppOracle?.sessionState !== undefined,
    undefined,
    { timeout: 20000 },
  );
}

async function appSnapshot(page) {
  return page.evaluate(() => {
    const app = window.__documentCacheAppOracle;
    return {
      url: location.href,
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
      historyLength: history.length,
      title: document.title,
      app: {
        loading: app?.loading ?? null,
        view: app?.view ?? null,
        activeSessionId: app?.activeSessionId ?? null,
        sessionStateId: app?.sessionState?.session?.id ?? null,
        connection: app?.connection ?? null,
        demoFallback: app?.demo !== undefined,
        pageError: app?.pageError || null,
      },
      documentStartUrl: window.__documentCacheOracle?.documentStartUrl ?? null,
      pageShows: window.__documentCacheOracle?.pageShows ?? [],
      pageHides: window.__documentCacheOracle?.pageHides ?? [],
      scrollY,
    };
  });
}

async function rawDocumentSnapshot(page) {
  return page.evaluate(() => ({
    url: location.href,
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    historyLength: history.length,
    title: document.title,
    bodyVersion: document.querySelector('#server-version')?.textContent?.trim() ?? null,
    bodyText: document.body.innerText.replace(/\s+/g, ' ').trim(),
    scrollY,
    navigationType: performance.getEntriesByType('navigation')[0]?.type ?? null,
    documentStartUrl: window.__documentCacheOracle?.documentStartUrl ?? null,
    pageShows: window.__documentCacheOracle?.pageShows ?? [],
    pageHides: window.__documentCacheOracle?.pageHides ?? [],
    formState: (() => {
      const text = document.querySelector('#state-text');
      const autocompleteOff = document.querySelector('#state-off');
      const checkbox = document.querySelector('#state-check');
      const select = document.querySelector('#state-select');
      if (!text && !autocompleteOff && !checkbox && !select) return null;
      const selection =
        document.activeElement === text
          ? {
              start: text.selectionStart,
              end: text.selectionEnd,
              direction: text.selectionDirection,
            }
          : null;
      return {
        textValue: text?.value ?? null,
        autocompleteOffValue: autocompleteOff?.value ?? null,
        checkboxChecked: checkbox?.checked ?? null,
        selectValue: select?.value ?? null,
        activeElementId: document.activeElement?.id ?? null,
        textSelection: selection,
      };
    })(),
  }));
}

async function newObservedPage(browserTarget) {
  const context = await browserTarget.newContext({
    viewport: fixture.capture.viewport,
    deviceScaleFactor: fixture.capture.viewport.deviceScaleFactor,
    isMobile: fixture.capture.viewport.isMobile,
    hasTouch: fixture.capture.viewport.hasTouch,
    locale: 'en-US',
    colorScheme: 'light',
  });
  const page = await context.newPage();
  await addPageMetadata(page);
  const cdp = await attachCdp(page);
  return { context, page, ...cdp };
}

async function captureCacheCase(browserTarget, item) {
  const { context, page, cdp, entries, cacheEvents, bfcacheEvents, lifecycleEvents } =
    await newObservedPage(browserTarget);
  try {
    const initialResponse = await page.goto(origin + item.path, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await page.locator('#server-version').waitFor();
    if (item.formStateProbe) {
      await page.locator('#state-text').fill('edited text value');
      await page.locator('#state-off').fill('edited autocomplete off');
      await page.locator('#state-check').check();
      await page.locator('#state-select').selectOption('two');
      await page.locator('#state-text').press('End');
      await page.locator('#state-text').press('Shift+ArrowLeft');
    }
    const initial = await rawDocumentSnapshot(page);
    caseState.get(item.id).version = item.versionOnBack;

    const [appResponse] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
      page.locator('#open-pirc').click(),
    ]);
    await bindApp(page);
    await page.waitForTimeout(150);
    const app = await appSnapshot(page);
    const appApiReceipts = httpReceipts.filter(
      (receipt) => receipt.caseId === item.id && receipt.kind === 'api',
    );
    const appWebSocketReceipts = websocketReceipts.filter((receipt) => receipt.caseId === item.id);

    const cdpStartAtBack = entries.length;
    await page.evaluate(() => history.back());
    await page.waitForFunction((path) => location.pathname === path, item.path, { timeout: 15000 });
    await page.locator('#server-version').waitFor();
    await page.waitForTimeout(100);
    const backDocumentRequest = stableDocumentRequests(entries.slice(cdpStartAtBack)).at(-1);
    const back = {
      document: await rawDocumentSnapshot(page),
      responseStatus: backDocumentRequest?.response?.status ?? null,
      responseUrl: backDocumentRequest?.url ?? null,
      documentRequest: backDocumentRequest ?? null,
      serverRequest:
        httpReceipts
          .filter((receipt) => receipt.caseId === item.id && receipt.kind === 'cache-document')
          .at(-1) ?? null,
    };
    let reload;
    if (item.reloadAfterBack) {
      caseState.get(item.id).version = item.versionOnReload;
      const cdpStartAtReload = entries.length;
      let reloadResponse;
      let reloadNavigationTimedOut = false;
      if (item.reloadMode === 'hard') {
        const navigation = page
          .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 })
          .then((response) => {
            reloadResponse = response;
          })
          .catch(() => {
            reloadNavigationTimedOut = true;
          });
        await cdp.send('Page.reload', { ignoreCache: true });
        await navigation;
      } else {
        reloadResponse = await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      }
      await page.locator('#server-version').waitFor();
      const reloadDocumentRequest = stableDocumentRequests(entries.slice(cdpStartAtReload)).at(-1);
      reload = {
        trigger:
          item.reloadMode === 'hard'
            ? 'Chrome CDP Page.reload(ignoreCache: true) (hard cache bypass)'
            : 'Playwright page.reload() (normal reload)',
        navigationTimedOut: reloadNavigationTimedOut,
        document: await rawDocumentSnapshot(page),
        responseStatus: reloadResponse?.status() ?? null,
        responseUrl: reloadResponse?.url() ?? null,
        documentRequest: reloadDocumentRequest ?? null,
        serverRequest:
          httpReceipts
            .filter((receipt) => receipt.caseId === item.id && receipt.kind.startsWith('cache-'))
            .at(-1) ?? null,
      };
    }

    const cdpStartAtForward = entries.length;
    await page.evaluate(() => history.forward());
    await page.waitForFunction((path) => location.pathname === path, '/', { timeout: 15000 });
    const hadHarnessAppBindingBeforeForward = await page.evaluate(() =>
      Boolean(window.__documentCacheAppOracle),
    );
    if (!hadHarnessAppBindingBeforeForward) await bindApp(page);
    else {
      await page.waitForFunction(
        () => window.__documentCacheAppOracle?.loading === false,
        undefined,
        { timeout: 20000 },
      );
    }
    let appConnectionRestored = false;
    try {
      await page.waitForFunction(
        () => window.__documentCacheAppOracle?.connection === 'connected',
        undefined,
        { timeout: 2000 },
      );
      appConnectionRestored = true;
    } catch {
      // Preserve the observed disconnected state; BFCache restoration is not a promise of a live stream.
    }
    const forwardDocumentRequest = stableDocumentRequests(entries.slice(cdpStartAtForward)).at(-1);
    const forwardApp = await appSnapshot(page);
    const appApiReceiptsAfterForward = httpReceipts.filter(
      (receipt) => receipt.caseId === item.id && receipt.kind === 'api',
    );
    const appWebSocketReceiptsAfterForward = websocketReceipts.filter(
      (receipt) => receipt.caseId === item.id,
    );
    return {
      caseId: item.id,
      url: origin + item.path,
      cacheControl: item.cacheControl,
      validator: item.validator,
      initial: {
        document: initial,
        responseStatus: initialResponse?.status() ?? null,
        responseUrl: initialResponse?.url() ?? null,
      },
      app: {
        documentResponseStatus: appResponse?.status() ?? null,
        documentResponseUrl: appResponse?.url() ?? null,
        state: app,
        apiReceipts: appApiReceipts.map(
          ({ method, path, rawQuery, fixtureKey, responseStatus }) => ({
            method,
            path,
            rawQuery,
            fixtureKey,
            responseStatus,
          }),
        ),
        eventStreams: appWebSocketReceipts,
      },
      serverVersionBeforeBack: item.versionOnBack,
      back,
      reload,
      forward: {
        app: forwardApp,
        appConnectionRestored,
        documentRequest: forwardDocumentRequest ?? null,
        harnessBindingAlreadyPresent: hadHarnessAppBindingBeforeForward,
        apiRequestCountAfterInitialApp: appApiReceiptsAfterForward.length - appApiReceipts.length,
        newApiRequests: appApiReceiptsAfterForward
          .slice(appApiReceipts.length)
          .map(({ method, path, rawQuery, fixtureKey, responseStatus }) => ({
            method,
            path,
            rawQuery,
            fixtureKey,
            responseStatus,
          })),
        newEventStreams: appWebSocketReceiptsAfterForward.slice(appWebSocketReceipts.length),
        openEventStreamCount: appWebSocketReceiptsAfterForward.filter((receipt) => !receipt.closed)
          .length,
      },
      history: {
        backRequestedBy: 'window.history.back()',
        forwardRequestedBy: 'window.history.forward()',
        backRestoredFromBfcache: back.document.pageShows.some((show) => show.persisted),
        appRestoredFromBfcache: forwardApp.pageShows.some((show) => show.persisted),
      },
      serverReceipts: httpReceipts.filter(
        (receipt) => receipt.caseId === item.id && receipt.kind !== 'api',
      ),
      cdp: {
        documentRequests: stableDocumentRequests(entries),
        cacheEvents,
        bfcacheNotUsed: bfcacheEvents,
        lifecycleEvents,
      },
    };
  } finally {
    await cdp.detach();
    await context.close();
  }
}

async function capturePostCase(browserTarget, item) {
  const { context, page, cdp, entries, cacheEvents, bfcacheEvents, lifecycleEvents } =
    await newObservedPage(browserTarget);
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  });
  try {
    const initialResponse = await page.goto(origin + item.entryPath, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await page.locator('#post-form').waitFor();
    const initial = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      historyLength: history.length,
      documentStartUrl: window.__documentCacheOracle?.documentStartUrl ?? null,
      pageShows: window.__documentCacheOracle?.pageShows ?? [],
    }));
    await page.locator('input[name="payload"]').fill(item.formValue);
    const [postResponse] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
      page.getByRole('button', { name: 'Submit POST' }).click(),
    ]);
    const postResult = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: document.querySelector('#post-body')?.textContent ?? null,
      historyLength: history.length,
      documentStartUrl: window.__documentCacheOracle?.documentStartUrl ?? null,
      pageShows: window.__documentCacheOracle?.pageShows ?? [],
    }));

    const reloadResponse = await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    const afterReload = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: document.querySelector('#post-body')?.textContent ?? null,
      historyLength: history.length,
      documentStartUrl: window.__documentCacheOracle?.documentStartUrl ?? null,
      pageShows: window.__documentCacheOracle?.pageShows ?? [],
    }));
    await page.waitForTimeout(100);
    return {
      caseId: item.id,
      initial: { state: initial, responseStatus: initialResponse?.status() ?? null },
      postResult: { state: postResult, responseStatus: postResponse?.status() ?? null },
      programmaticReload: {
        method: 'Playwright page.reload()',
        state: afterReload,
        responseStatus: reloadResponse?.status() ?? null,
      },
      dialogs,
      serverReceipts: httpReceipts.filter(
        (receipt) => receipt.caseId === item.id && receipt.kind !== 'api',
      ),
      cdp: {
        documentRequests: stableDocumentRequests(entries),
        cacheEvents,
        bfcacheNotUsed: bfcacheEvents,
        lifecycleEvents,
      },
    };
  } finally {
    await cdp.detach();
    await context.close();
  }
}

async function capturePostKeyboardCase(browserTarget, item, caseId) {
  const { context, page, cdp, entries, cacheEvents, bfcacheEvents, lifecycleEvents } =
    await newObservedPage(browserTarget);
  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message(), action: 'accepted' });
    await dialog.accept();
  });
  try {
    await page.goto(origin + item.entryPath, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('#post-form').waitFor();
    await page.locator('input[name="payload"]').fill(item.formValue);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
      page.getByRole('button', { name: 'Submit POST' }).click(),
    ]);
    const postResult = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: document.querySelector('#post-body')?.textContent ?? null,
      pageShows: window.__documentCacheOracle?.pageShows ?? [],
      pageHides: window.__documentCacheOracle?.pageHides ?? [],
    }));

    const requestStartAtKeyboardReload = entries.length;
    let keyboardReloadResponse;
    let keyboardReloadTimeout = false;
    const reloadNavigation = page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 })
      .then((response) => {
        keyboardReloadResponse = response;
      })
      .catch(() => {
        keyboardReloadTimeout = true;
      });
    await page.keyboard.press('Meta+R');
    await reloadNavigation;
    const keyboardReload = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: document.querySelector('#post-body')?.textContent ?? null,
      pageShows: window.__documentCacheOracle?.pageShows ?? [],
      pageHides: window.__documentCacheOracle?.pageHides ?? [],
    }));
    const keyboardReloadDocumentRequests = stableDocumentRequests(
      entries.slice(requestStartAtKeyboardReload),
    );

    const cdpStartAtBack = entries.length;
    await page.evaluate(() => history.back());
    await page.waitForFunction((path) => location.pathname === path, item.entryPath, {
      timeout: 15000,
    });
    await page.locator('#post-form').waitFor();
    const formAfterBack = await page.evaluate(() => ({
      url: location.href,
      inputValue: document.querySelector('input[name="payload"]')?.value ?? null,
      pageShows: window.__documentCacheOracle?.pageShows ?? [],
      pageHides: window.__documentCacheOracle?.pageHides ?? [],
      scrollY,
    }));
    const backDocumentRequests = stableDocumentRequests(entries.slice(cdpStartAtBack));
    return {
      caseId,
      postResult,
      keyboardReload: {
        trigger: 'Meta+R keyboard shortcut on macOS Chrome',
        navigationTimedOut: keyboardReloadTimeout,
        responseStatus: keyboardReloadResponse?.status() ?? null,
        state: keyboardReload,
        documentRequests: keyboardReloadDocumentRequests,
        correspondingPostReceipts: httpReceipts.filter(
          (receipt) => receipt.caseId === caseId && receipt.kind === 'post-result',
        ),
      },
      historyBack: {
        trigger: 'window.history.back()',
        form: formAfterBack,
        documentRequests: backDocumentRequests,
      },
      dialogs,
      serverReceipts: httpReceipts.filter(
        (receipt) => receipt.caseId === caseId && receipt.kind !== 'api',
      ),
      cdp: {
        documentRequests: stableDocumentRequests(entries),
        cacheEvents,
        bfcacheNotUsed: bfcacheEvents,
        lifecycleEvents,
      },
    };
  } finally {
    await cdp.detach();
    await context.close();
  }
}

function stableDocumentRequests(entries) {
  return entries
    .filter((entry) => entry.resourceType === 'Document')
    .map(({ requestId, ...entry }) => entry);
}
