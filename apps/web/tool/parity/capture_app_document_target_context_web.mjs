// Run from the repository root:
// /opt/homebrew/bin/node apps/web/tool/parity/capture_app_document_target_context_web.mjs
// Uses real same-origin form navigations into the pinned App; no Playwright HTTP routes.
import { createServer } from '../../node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const pinnedRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/app-document-target-context.json');
const expectedPath = resolve(
  root,
  'fixtures/mobile-parity/app-document-target-context-expected.json',
);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const apiFixturePath = resolve(root, 'fixtures/mobile-parity', fixture.apiFixtureReference);
const apiFixture = JSON.parse(await readFile(apiFixturePath, 'utf8'));
if (fixture.webRevision !== pinnedRevision || apiFixture.webRevision !== pinnedRevision)
  throw new Error('Target-context fixtures must use the pinned web revision');

execFileSync('git', ['diff', '--exit-code', pinnedRevision, '--', 'apps/web', ':!apps/web/tool'], {
  cwd: root,
  stdio: 'inherit',
});

const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const { WebSocketServer } = require(require.resolve('ws'));
const temporaryOutput = resolve('/private/tmp', 'pirc-app-document-target-context-parity');
await mkdir(temporaryOutput, { recursive: true });
const origin = 'http://127.0.0.1:18935';
const apiSource = apiFixture.apiFixture;
const apiFailures = [];
const apiReceipts = [];
const websocketReceipts = [];
const documentHttpReceipts = [];
const historyHttpReceipts = [];
const namedChildRequestCounts = new Map();
const historyARequestCounts = new Map();
const pageErrors = [];
const externalRequests = [];
const pageObservations = new Map();
const captures = [];
let browser;
let server;
let wsServer;

function apiResponse(url) {
  const path = url.pathname;
  if (path === '/api/workspaces')
    return { fixtureKey: 'workspaces', body: { workspaces: apiSource.workspaces } };
  if (path === '/api/sessions')
    return { fixtureKey: 'sessions', body: { sessions: apiSource.sessions } };
  if (path === '/api/models') return { fixtureKey: 'models', body: { models: apiSource.models } };
  if (path === '/api/nodes') return { fixtureKey: 'nodes', body: { nodes: apiSource.nodes } };
  if (path === '/api/memory') return { fixtureKey: 'memory', body: apiSource.memory };
  if (path === '/api/schedules')
    return {
      fixtureKey: 'schedules',
      body: { schedules: apiSource.schedules, timezone: 'Asia/Taipei' },
    };
  if (path === '/api/providers') return { fixtureKey: 'providers', body: apiSource.providers };
  if (path === '/api/devices') return { fixtureKey: 'devices', body: apiSource.devices };
  if (path === '/api/push') return { fixtureKey: 'push', body: apiSource.push };

  const snapshot = path.match(/^\/api\/sessions\/([^/]+)\/snapshot$/);
  if (snapshot) {
    const sessionId = decodeURIComponent(snapshot[1]);
    if (apiSource.snapshots[sessionId])
      return { fixtureKey: 'snapshot:' + sessionId, body: apiSource.snapshots[sessionId] };
  }
  const control = path.match(/^\/api\/sessions\/([^/]+)\/control$/);
  if (control) return { fixtureKey: 'controlLease', body: apiSource.controlLease };
  const panelState = path.match(/^\/api\/sessions\/([^/]+)\/panel\/state$/);
  if (panelState) return { fixtureKey: 'panelState', body: apiSource.panelState };
  const schedule = path.match(/^\/api\/schedules\/([^/]+)$/);
  if (schedule) {
    const scheduleId = decodeURIComponent(schedule[1]);
    const value = apiSource.schedules.find((item) => item.id === scheduleId);
    if (value)
      return {
        fixtureKey: 'schedule:' + scheduleId,
        body: { schedule: value, runs: apiSource.scheduleRuns },
      };
  }
  return undefined;
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

function htmlResponse(title, content) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main>${content}</main></body></html>`;
  return {
    html,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
    },
  };
}

function openerFormHtml() {
  const forms = fixture.cases
    .map((item) => {
      const routeInput = item.routeField
        ? `<input type="hidden" name="${escapeAttribute(item.routeField.name)}" value="${escapeAttribute(item.routeField.value)}">`
        : '';
      return `<form id="${escapeAttribute(item.formId)}" method="get" action="${escapeAttribute(item.actionPath)}" target="${escapeAttribute(item.target)}">${routeInput}<label>Source <input id="${escapeAttribute(item.formId)}-source" name="source" value="${escapeAttribute(item.sourceValue)}"></label><button type="submit">Submit ${escapeHtml(item.id)}</button></form>`;
    })
    .join('\n');
  const content = `<h1>Native HTML target forms</h1><p>Each form is a real GET form targeting a separate browsing context.</p>${forms}`;
  return htmlResponse('Target form opener', content);
}

function namedChildFormHtml(version) {
  const template = fixture.namedHistoryDocument.responseHtmlTemplate;
  const values = {
    version,
    number: version === 'server-v1' ? '11' : '22',
    range: version === 'server-v1' ? '10' : '20',
    checkAttribute: version === 'server-v1' ? 'checked' : '',
    selectOneAttribute: version === 'server-v1' ? 'selected' : '',
    selectTwoAttribute: version === 'server-v1' ? '' : 'selected',
  };
  let html = template;
  for (const [key, value] of Object.entries(values))
    html = html.replaceAll(fixture.namedHistoryDocument.htmlVersionTokens[key], value);
  return {
    html,
    headers: {
      'cache-control': fixture.namedHistoryDocument.responseCacheControl,
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'x-oracle-document-version': version,
    },
  };
}

function historyEntryForm(caseId) {
  const entry = fixture.historyProbes.entryForms.find((item) => item.id === caseId);
  if (entry) return entry;
  const status = fixture.historyProbes.responseStatusCases.find(
    (value) => caseId === `named-back-status-${value}`,
  );
  if (status !== undefined) {
    return {
      id: caseId,
      formId: `history-status-${status}`,
      target: `pirc_history_status_${status}`,
      actionPath: `${fixture.historyProbes.aPath}?scenario=status-${status}`,
    };
  }
  throw new Error(`Unknown history probe case: ${caseId}`);
}

function historyOpenerHtml(caseId) {
  const entry = historyEntryForm(caseId);
  const scenario = new URL(entry.actionPath, origin).searchParams.get('scenario') ?? '';
  const content = `<h1>Named history opener</h1><form id="${escapeAttribute(entry.formId)}" method="get" action="${escapeAttribute(entry.actionPath)}" target="${escapeAttribute(entry.target)}"><input type="hidden" name="scenario" value="${escapeAttribute(scenario)}"><label>Opener input <input name="opener" value="history opener"></label><button type="submit">Open ${escapeHtml(entry.id)}</button></form>`;
  return htmlResponse('Named history opener', content);
}

function historyAHtml(version, scenario) {
  const tokens = fixture.namedHistoryDocument.htmlVersionTokens;
  let html = fixture.historyProbes.responseHtmlTemplate.replaceAll(
    '{{scenario}}',
    encodeURIComponent(scenario),
  );
  const replacements = {
    [tokens.version]: version,
    [tokens.range]: version === 'server-v1' ? '10' : '20',
    [tokens.checkAttribute]: version === 'server-v1' ? 'checked' : '',
    [tokens.selectOneAttribute]: version === 'server-v1' ? 'selected' : '',
    [tokens.selectTwoAttribute]: version === 'server-v1' ? '' : 'selected',
  };
  for (const [token, value] of Object.entries(replacements)) html = html.replaceAll(token, value);
  return {
    html,
    headers: {
      'cache-control':
        scenario === 'cacheable'
          ? fixture.historyProbes.cacheableCacheControl
          : fixture.namedHistoryDocument.responseCacheControl,
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'x-oracle-document-version': version,
    },
  };
}

function historyBHtml(scenario) {
  return htmlResponse(
    'Named history B',
    `<h1 id="history-document">Named history B</h1><p id="history-version">Response B for ${escapeHtml(scenario)}</p><p id="document-instance">${escapeHtml(scenario)}-B</p>`,
  );
}

function postFormHtml(scenario) {
  const content = `<h1>POST form source</h1><form id="post-to-result" method="post" action="${escapeAttribute(fixture.historyProbes.postResultPath)}?scenario=${encodeURIComponent(scenario)}" target="_self"><label>Payload <input id="post-payload" name="payload" value=""></label><button type="submit">Send POST</button></form>`;
  return htmlResponse('POST form source', content);
}

function postResultHtml(scenario) {
  const content = `<h1 id="post-result">POST response document</h1><p id="post-scenario">${escapeHtml(scenario)}</p><a id="post-next-link" href="${escapeAttribute(fixture.historyProbes.postNextPath)}?scenario=${encodeURIComponent(scenario)}">Continue with GET</a>`;
  const page = htmlResponse('POST response document', content);
  if (scenario === 'post') {
    page.headers['cache-control'] = fixture.historyProbes.namedPostCacheControl;
    page.headers['content-location'] =
      `${fixture.historyProbes.postResultPath}?scenario=${encodeURIComponent(scenario)}`;
  } else if (scenario === 'post-default') {
    delete page.headers['cache-control'];
  } else if (scenario === 'post-no-cache') {
    page.headers['cache-control'] = 'no-cache';
  } else if (scenario === 'post-max-age-zero') {
    page.headers['cache-control'] = 'max-age=0, must-revalidate';
  }
  return page;
}

function postNextHtml(scenario) {
  return htmlResponse(
    'GET after POST',
    `<h1 id="post-next">GET after POST</h1><p id="post-scenario">${escapeHtml(scenario)}</p>`,
  );
}

function fragmentPageHtml(scenario) {
  const content = `<h1 id="fragment-top">Fragment history document</h1><p id="fragment-instance">${escapeHtml(scenario)}-fragment</p><a id="same-document-link" href="#fragment-target">Jump within this document</a><div style="height:1400px"></div><h2 id="fragment-target">Fragment target</h2>`;
  return htmlResponse('Fragment history document', content);
}

function recordHistoryRequest(req, url, res) {
  if (!url.pathname.startsWith('/__oracle/')) return null;
  const receipt = {
    method: req.method,
    url: req.url ?? '/',
    path: url.pathname,
    rawQuery: url.search,
    requestBody: null,
    contentType: req.headers['content-type'] ?? null,
    status: null,
    responseVersion: null,
    responseCacheControl: null,
    responseContentLocation: null,
    responseContentType: null,
  };
  historyHttpReceipts.push(receipt);
  res.once('finish', () => {
    receipt.status = res.statusCode;
    receipt.responseVersion = res.getHeader('x-oracle-document-version') ?? null;
    receipt.responseCacheControl = res.getHeader('cache-control') ?? null;
    receipt.responseContentLocation = res.getHeader('content-location') ?? null;
    receipt.responseContentType = res.getHeader('content-type') ?? null;
  });
  return receipt;
}

function sendApi(req, res, url) {
  const match = apiResponse(url);
  const status = match ? 200 : 500;
  const body = JSON.stringify(
    match?.body ?? { error: { message: 'Unexpected target-context API request' } },
  );
  const referer = req.headers.referer
    ? new URL(req.headers.referer).pathname + new URL(req.headers.referer).search
    : null;
  apiReceipts.push({
    sequence: apiReceipts.length,
    pagePath: referer,
    method: req.method,
    path: url.pathname,
    rawQuery: url.search,
    fixtureKey: match?.fixtureKey ?? null,
    responseStatus: status,
  });
  if (!match) apiFailures.push({ path: url.pathname, method: req.method });
  res.statusCode = status;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

async function handleLocalRequest(req, res, next) {
  const url = new URL(req.url ?? '/', origin);
  const historyReceipt = recordHistoryRequest(req, url, res);
  if (url.pathname.startsWith('/api/')) {
    sendApi(req, res, url);
    return;
  }
  if (req.method === 'GET' && url.pathname === fixture.capture.openerFormPath) {
    const page = openerFormHtml();
    res.writeHead(200, page.headers);
    res.end(page.html);
    return;
  }
  if (req.method === 'GET' && url.pathname === fixture.historyProbes.openerPath) {
    const page = historyOpenerHtml(url.searchParams.get('case') ?? '');
    res.writeHead(200, page.headers);
    res.end(page.html);
    return;
  }
  if (req.method === 'GET' && url.pathname === fixture.capture.namedChildFormPath) {
    const requestKey = `${url.pathname}?case=${url.searchParams.get('case') ?? 'default'}`;
    const requestCount = (namedChildRequestCounts.get(requestKey) ?? 0) + 1;
    namedChildRequestCounts.set(requestKey, requestCount);
    const page = namedChildFormHtml(requestCount === 1 ? 'server-v1' : `server-v${requestCount}`);
    res.writeHead(200, page.headers);
    res.end(page.html);
    return;
  }
  if (req.method === 'GET' && url.pathname === fixture.historyProbes.aPath) {
    const scenario = url.searchParams.get('scenario') ?? 'default';
    const requestCount = (historyARequestCounts.get(scenario) ?? 0) + 1;
    historyARequestCounts.set(scenario, requestCount);
    if (requestCount > 1 && scenario.startsWith('status-')) {
      const backStatus = Number(scenario.slice('status-'.length));
      if (backStatus === 204 || backStatus === 205) {
        res.writeHead(backStatus, {
          'cache-control': fixture.namedHistoryDocument.responseCacheControl,
          'content-type': 'text/html; charset=utf-8',
          'x-oracle-document-version': `back-${backStatus}-empty`,
        });
        res.end();
        return;
      }
      if (backStatus === 404) {
        const page = htmlResponse(
          'HTTP 404 history response',
          '<h1 id="history-error">HTTP 404 response body</h1><p>Native history document error response.</p>',
        );
        res.writeHead(404, { ...page.headers, 'x-oracle-document-version': 'back-404-body' });
        res.end(page.html);
        return;
      }
      throw new Error(`Unsupported named history back status ${backStatus}`);
    }
    const version = requestCount === 1 ? 'server-v1' : `server-v${requestCount}`;
    const page = historyAHtml(version, scenario);
    res.writeHead(200, page.headers);
    res.end(page.html);
    return;
  }
  if (req.method === 'GET' && url.pathname === fixture.historyProbes.bPath) {
    const page = historyBHtml(url.searchParams.get('scenario') ?? 'default');
    res.writeHead(200, page.headers);
    res.end(page.html);
    return;
  }
  if (req.method === 'GET' && url.pathname === fixture.historyProbes.postFormPath) {
    const page = postFormHtml(url.searchParams.get('scenario') ?? 'post');
    res.writeHead(200, page.headers);
    res.end(page.html);
    return;
  }
  if (req.method === 'POST' && url.pathname === fixture.historyProbes.postResultPath) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const requestBytes = Buffer.concat(chunks);
    if (historyReceipt) historyReceipt.requestBody = requestBytes.toString('utf8');
    const page = postResultHtml(url.searchParams.get('scenario') ?? 'post');
    res.writeHead(200, page.headers);
    res.end(page.html);
    return;
  }
  if (req.method === 'GET' && url.pathname === fixture.historyProbes.postNextPath) {
    const page = postNextHtml(url.searchParams.get('scenario') ?? 'post');
    res.writeHead(200, page.headers);
    res.end(page.html);
    return;
  }
  if (req.method === 'GET' && url.pathname === fixture.historyProbes.fragmentPath) {
    const page = fragmentPageHtml(url.searchParams.get('scenario') ?? 'fragment');
    res.writeHead(200, page.headers);
    res.end(page.html);
    return;
  }
  next();
}

const oraclePlugin = {
  name: 'document-target-context-http-fixtures',
  configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      const requestUrl = new URL(req.url ?? '/', origin);
      if (req.headers['sec-fetch-dest'] === 'document') {
        const receipt = {
          method: req.method,
          url: req.url ?? '/',
          path: requestUrl.pathname,
          status: null,
          contentType: null,
          cacheControl: null,
          contentLocation: null,
          documentVersion: null,
        };
        documentHttpReceipts.push(receipt);
        res.once('finish', () => {
          receipt.status = res.statusCode;
          receipt.contentType = res.getHeader('content-type') ?? null;
          receipt.cacheControl = res.getHeader('cache-control') ?? null;
          receipt.contentLocation = res.getHeader('content-location') ?? null;
          receipt.documentVersion = res.getHeader('x-oracle-document-version') ?? null;
        });
      }
      void handleLocalRequest(req, res, next).catch(next);
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
    port: 18935,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
    // API HTTP is answered by the fixture middleware; leave /api/events for the local WS server.
    proxy: { '/api': { target: origin, changeOrigin: true, ws: false } },
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
    const query = Object.fromEntries(url.searchParams.entries());
    const referer = req.headers.referer
      ? new URL(req.headers.referer).pathname + new URL(req.headers.referer).search
      : null;
    const receipt = {
      pagePath: referer,
      path: url.pathname,
      query,
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
  const browserVersion = await browser.version();
  if (!browserVersion.startsWith('154.'))
    throw new Error('Expected pinned Chrome 154, got ' + browserVersion);

  captures.push(await captureBlankContexts(browser));
  captures.push(await captureNamedContext(browser));
  captures.push(await captureNamedHistoryProbes(browser));

  const blankCapture = captures.find(
    (capture) => capture.caseId === 'blank-two-independent-app-contexts',
  );
  const namedCapture = captures.find(
    (capture) => capture.caseId === 'named-target-reuse-and-form-back',
  );
  const requiredDocuments = [
    {
      label: 'blank session App',
      browserUrl: blankCapture.blankA.submittedNavigationUrl,
      path: '/deep/blank-latest',
    },
    {
      label: 'blank workspace App',
      browserUrl: blankCapture.blankB.submittedNavigationUrl,
      path: '/deep/blank-workspace',
    },
    {
      label: 'named child form',
      browserUrl: namedCapture.namedTarget.firstNavigation.url,
      path: fixture.capture.namedChildFormPath,
    },
    {
      label: 'named App',
      browserUrl: namedCapture.namedTarget.appNavigationUrl,
      path: '/deep/named-app',
    },
  ];
  for (const document of requiredDocuments) {
    if (!document.browserUrl || new URL(document.browserUrl).pathname !== document.path)
      throw new Error(
        `Could not observe the real ${document.label} browser URL: ${document.browserUrl}`,
      );
    const response = documentHttpReceipts.find((entry) => entry.path === document.path);
    if (!response || response.method !== 'GET' || response.status !== 200)
      throw new Error(
        `Expected a real 200 GET for ${document.label}: ${JSON.stringify(response ?? null)}`,
      );
  }
  const namedChildResponses = documentHttpReceipts.filter(
    (entry) => entry.path === fixture.capture.namedChildFormPath,
  );
  if (
    namedChildResponses.length !== 2 ||
    namedChildResponses[0].documentVersion !== 'server-v1' ||
    namedChildResponses[1].documentVersion !== 'server-v2'
  )
    throw new Error(
      `Expected first-load and Back GET response versions server-v1/server-v2; got ${JSON.stringify(namedChildResponses)}`,
    );
  const historyCapture = captures.find(
    (capture) => capture.caseId === 'named-history-browser-behavior',
  );
  if (historyCapture.getBackStatuses.length !== fixture.historyProbes.responseStatusCases.length)
    throw new Error('A named history response status case was not captured');
  const fragmentReceipts = historyHttpReceipts.filter(
    (entry) => entry.path === fixture.historyProbes.fragmentPath,
  );
  if (fragmentReceipts.length !== 1)
    throw new Error(
      `Expected one real GET for the same-document fragment case; got ${JSON.stringify(fragmentReceipts)}`,
    );
  const initialPostReceipt = historyHttpReceipts.find(
    (entry) => entry.method === 'POST' && entry.path === fixture.historyProbes.postResultPath,
  );
  const expectedPostBody = `payload=${encodeURIComponent(fixture.historyProbes.postValue)}`;
  if (!initialPostReceipt || initialPostReceipt.requestBody !== expectedPostBody)
    throw new Error(
      `Expected a real native POST request body ${expectedPostBody}; got ${JSON.stringify(initialPostReceipt ?? null)}`,
    );

  if (apiFailures.length)
    throw new Error('Unexpected local API requests: ' + JSON.stringify(apiFailures));
  if (externalRequests.length)
    throw new Error('Unexpected external requests: ' + JSON.stringify(externalRequests));
  if (pageErrors.length)
    throw new Error('Actual App browser errors: ' + JSON.stringify(pageErrors));
  const connectedEventStreams = websocketReceipts.filter((receipt) => receipt.connected);
  if (connectedEventStreams.length < 3)
    throw new Error(
      `Expected an event stream from each App target page; got ${connectedEventStreams.length}`,
    );

  const result = {
    fixture: fixture.id,
    reference: fixture.webRevision,
    apiFixtureReference: fixture.apiFixtureReference,
    captureMethod:
      'Chrome 154, actual pinned Vite App.svelte, real same-origin native GET and POST forms, HTTP history responses, named browsing contexts, and same-document fragments; no Playwright HTTP route or route fulfillment. Fixture API and WebSocket endpoints are local.',
    browser: {
      version: browserVersion,
      executable: fixture.capture.browserExecutable,
      playwrightHttpRouting: false,
      bfcacheDefaultDisableArgRemoved: '--disable-back-forward-cache',
    },
    viewport: fixture.capture.viewport,
    cases: captures,
    apiReceipts,
    websocketReceipts,
    documentHttpReceipts,
    historyHttpReceipts,
    apiFailures,
    externalRequests,
    pageErrors,
  };
  await writeFile(expectedPath, JSON.stringify(result, null, 2) + '\n');
  console.log('Captured ' + captures.length + ' real-browser target-context cases.');
  console.log(expectedPath);
  console.log(
    JSON.stringify(
      captures.map((item) => ({
        caseId: item.caseId,
        pageCount: item.pageCount,
        targetPagesCreated: item.targetPagesCreated,
        reusedNamedTarget: item.reusedNamedTarget,
        viewStates: item.viewStates,
        storage: item.storage,
        formBack: item.formBack ?? null,
        openerAfterClose: item.openerAfterClose,
        history: item.getCloseOpenerBack
          ? {
              getCloseOpenerBack: {
                returnedToA: item.getCloseOpenerBack.returnedToA,
                reusedAInstance: item.getCloseOpenerBack.reusedAInstance,
                requests: item.getCloseOpenerBack.httpReceipts,
              },
              getBackStatuses: item.getBackStatuses.map((entry) => ({
                status: entry.requestedBackStatus,
                url: entry.afterBack.url,
                heading: entry.afterBack.heading,
                reusedAInstance: entry.reusedAInstance,
                receipts: entry.responseReceipts,
              })),
              getCacheableHistory: {
                requestedCacheControl: item.getCacheableHistory.requestedCacheControl,
                serverGetOnBack: item.getCacheableHistory.serverGetOnBack,
                responseVersionOnBack: item.getCacheableHistory.responseVersionOnBack,
                networkResponses: item.getCacheableHistory.networkResponses,
                bfcacheNotUsed: item.getCacheableHistory.bfcacheNotUsed,
              },
              postBackForward: {
                dialogs: item.postBackForward.dialogs,
                postBackNavigationAttempts: item.postBackForward.postBackNavigationAttempts,
                postResponseReplayedOnBack: item.postBackForward.postResponseReplayedOnBack,
                errorScreenshot: item.postBackForward.errorScreenshot,
                getForward: item.postBackForward.getForward,
              },
              sameDocumentFragment: {
                noAdditionalDocumentRequest: item.sameDocumentFragment.noAdditionalDocumentRequest,
                urls: [
                  item.sameDocumentFragment.initial.url,
                  item.sameDocumentFragment.atFragment.url,
                  item.sameDocumentFragment.afterFragmentBack.url,
                ],
              },
            }
          : undefined,
      })),
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await new Promise((resolveClose) => wsServer?.close(resolveClose));
  await server?.close();
}

function observePage(context, page) {
  let observation = pageObservations.get(page);
  if (observation) return observation;
  observation = { navigations: [], documentResponses: [], eventStreams: [] };
  pageObservations.set(page, observation);
  page.setDefaultTimeout(10000);
  page.on('request', (request) => {
    const url = request.url();
    if (request.isNavigationRequest()) {
      if (new URL(url).origin !== origin) externalRequests.push(url);
      observation.navigations.push({
        method: request.method(),
        url,
        resourceType: request.resourceType(),
      });
    } else if (new URL(url).origin !== origin) {
      externalRequests.push(url);
    }
  });
  page.on('response', (response) => {
    const request = response.request();
    if (!request.isNavigationRequest()) return;
    observation.documentResponses.push({
      method: request.method(),
      url: response.url(),
      status: response.status(),
      fromServiceWorker: response.fromServiceWorker(),
    });
  });
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    if (url.pathname === '/api/events')
      observation.eventStreams.push({ path: url.pathname, rawQuery: url.search });
  });
  page.on('pageerror', (error) =>
    pageErrors.push({ url: page.url(), error: error.stack || error.message }),
  );
  return observation;
}

function makeContextOptions() {
  return {
    viewport: fixture.capture.viewport,
    deviceScaleFactor: fixture.capture.viewport.deviceScaleFactor,
    isMobile: fixture.capture.viewport.isMobile,
    hasTouch: fixture.capture.viewport.hasTouch,
    locale: 'en-US',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  };
}

async function newOpener(browserTarget) {
  const context = await browserTarget.newContext(makeContextOptions());
  await context.addInitScript(() => {
    const metadata = {
      instanceId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      documentStartUrl: location.href,
      pageShows: [],
      pageHides: [],
    };
    Object.defineProperty(window, '__targetContextOracle', { value: metadata, configurable: true });
    addEventListener('pageshow', (event) =>
      metadata.pageShows.push({ persisted: event.persisted, url: location.href }),
    );
    addEventListener('pagehide', (event) =>
      metadata.pageHides.push({ persisted: event.persisted, url: location.href }),
    );
  });
  context.on('page', (newPage) => observePage(context, newPage));
  const page = await context.newPage();
  observePage(context, page);
  await page.goto(origin + fixture.capture.openerFormPath, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  await page.evaluate(() => {
    localStorage.setItem('oracle.shared-marker', 'opener-seed');
    sessionStorage.setItem('oracle.tab-marker', 'opener-seed');
  });
  return { context, page };
}

async function submitToNewTarget(opener, formId) {
  const popupPromise = opener.waitForEvent('popup', { timeout: 10000 });
  await opener.locator(`#${formId}`).locator('button[type="submit"]').click();
  const target = await popupPromise;
  const observation = observePage(opener.context(), target);
  await target.waitForLoadState('domcontentloaded', { timeout: 20000 });
  return { page: target, observation };
}

async function bindApp(page) {
  await page.evaluate(async () => {
    const module = await import('/src/lib/app.svelte.ts');
    window.__targetContextApp = module.app;
  });
  await page.waitForFunction(
    () =>
      window.__targetContextApp?.loading === false &&
      window.__targetContextApp?.sessionState !== undefined,
    undefined,
    { timeout: 20000 },
  );
  await page.waitForFunction(
    () => window.__targetContextApp?.connection === 'connected',
    undefined,
    { timeout: 10000 },
  );
}

async function appSnapshot(page) {
  return page.evaluate(() => {
    const app = window.__targetContextApp;
    return {
      url: location.href,
      documentStartUrl: window.__targetContextOracle?.documentStartUrl ?? null,
      historyLength: history.length,
      windowName: window.name,
      openerAvailable: Boolean(window.opener),
      pageShows: window.__targetContextOracle?.pageShows ?? [],
      pageHides: window.__targetContextOracle?.pageHides ?? [],
      app: {
        view: app?.view ?? null,
        mode: app?.mode ?? null,
        activeSessionId: app?.activeSessionId ?? null,
        workspaceViewId: app?.workspaceViewId ?? null,
        sessionStateId: app?.sessionState?.session?.id ?? null,
        draft: app?.draft ?? null,
        clientIdPresent: Boolean(app?.clientId),
        connection: app?.connection ?? null,
        loading: app?.loading ?? null,
        pageError: app?.pageError || null,
        demoFallback: app?.demo !== undefined,
      },
      storage: {
        localSharedMarker: localStorage.getItem('oracle.shared-marker'),
        localClientIdPresent: Boolean(localStorage.getItem('relay.client-id')),
        localDraftLatest: localStorage.getItem('relay.draft.session-latest'),
        localDraftSecond: localStorage.getItem('relay.draft.session-second'),
        tabMarker: sessionStorage.getItem('oracle.tab-marker'),
      },
      visiblePage: {
        workspace: document.querySelector('.workspace-page h1')?.textContent?.trim() ?? null,
        session: document.querySelector('.workspace .topbar h1')?.textContent?.trim() ?? null,
      },
    };
  });
}

async function sourceFormSnapshot(page) {
  return page.evaluate(() => ({
    url: location.href,
    historyLength: history.length,
    fields: Object.fromEntries(
      [...document.querySelectorAll('form')].map((form) => [
        form.id,
        {
          target: form.target,
          actionAttribute: form.getAttribute('action'),
          actionResolved: form.action,
          sourceValue: form.querySelector('input[name="source"]')?.value ?? null,
          routeFieldValue: form.querySelector('input[type="hidden"]')?.value ?? null,
        },
      ]),
    ),
    storage: {
      localClientIdPresent: Boolean(localStorage.getItem('relay.client-id')),
      localSharedMarker: localStorage.getItem('oracle.shared-marker'),
      tabMarker: sessionStorage.getItem('oracle.tab-marker'),
    },
  }));
}

async function openWorkspaceThroughSidebar(page, workspaceName, workspaceId) {
  await page.locator('.mobile-menu').click();
  await page.waitForFunction(() => document.querySelector('.sidebar')?.classList.contains('open'));
  await page
    .locator('.sidebar .workspace-heading > button')
    .filter({ hasText: workspaceName })
    .first()
    .click();
  await page.waitForFunction(
    (id) => {
      const app = window.__targetContextApp;
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

async function openSessionThroughWorkspace(page, sessionLabel, sessionId) {
  await page.locator('.workspace-page .row-main').filter({ hasText: sessionLabel }).first().click();
  await page.waitForFunction(
    (id) => {
      const app = window.__targetContextApp;
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

async function setDraft(page, value) {
  await page.locator('#prompt').fill(value);
  await page.waitForFunction(
    (expected) =>
      localStorage.getItem(`relay.draft.${window.__targetContextApp?.activeSessionId}`) ===
      expected,
    value,
    { timeout: 5000 },
  );
}

async function storageAndIdentity(pageA, pageB, opener) {
  const [identityA, identityB, a, b, source] = await Promise.all([
    pageA.evaluate(() => ({
      instanceId: window.__targetContextOracle.instanceId,
      clientId: window.__targetContextApp.clientId,
    })),
    pageB.evaluate(() => ({
      instanceId: window.__targetContextOracle.instanceId,
      clientId: window.__targetContextApp.clientId,
    })),
    appSnapshot(pageA),
    appSnapshot(pageB),
    sourceFormSnapshot(opener),
  ]);
  return {
    independentWindowObjects: identityA.instanceId !== identityB.instanceId,
    appClientIdShared: identityA.clientId === identityB.clientId,
    appClientIdMatchesSharedLocalStorage: await pageA.evaluate(
      () => window.__targetContextApp.clientId === localStorage.getItem('relay.client-id'),
    ),
    pageA: a,
    pageB: b,
    opener: source,
  };
}

async function captureBlankContexts(browserTarget) {
  const itemA = fixture.cases.find((item) => item.id === 'blank-to-session-latest');
  const itemB = fixture.cases.find((item) => item.id === 'blank-to-notes-workspace');
  const { context, page: opener } = await newOpener(browserTarget);
  try {
    await opener.locator(`#${itemA.formId}-source`).fill(itemA.sourceValue);
    await opener.locator(`#${itemB.formId}-source`).fill(itemB.sourceValue);
    const openerBefore = await sourceFormSnapshot(opener);
    const pagesBefore = context.pages().length;

    const openedA = await submitToNewTarget(opener, itemA.formId);
    const pagesAfterA = context.pages().length;
    const pageA = openedA.page;
    await bindApp(pageA);
    const requestUrlA =
      openedA.observation.navigations.find(
        (entry) => new URL(entry.url).pathname === new URL(origin + itemA.actionPath).pathname,
      )?.url ?? null;
    const initialA = await appSnapshot(pageA);
    const openerSessionMarker = await opener.evaluate(() =>
      sessionStorage.getItem('oracle.tab-marker'),
    );
    const childInitialStorageA = await pageA.evaluate(() => ({
      openerAvailable: Boolean(window.opener),
      windowName: window.name,
      tabMarker: sessionStorage.getItem('oracle.tab-marker'),
      sharedMarker: localStorage.getItem('oracle.shared-marker'),
      instanceId: window.__targetContextOracle.instanceId,
    }));
    await pageA.evaluate(() => {
      sessionStorage.setItem('oracle.tab-marker', 'blank-a-tab');
      localStorage.setItem('oracle.shared-marker', 'set-by-blank-a');
    });
    await setDraft(pageA, fixture.appActions.blankLatestDraft);
    await openWorkspaceThroughSidebar(
      pageA,
      'Notes project',
      fixture.appActions.blankLatestWorkspace,
    );
    const afterWorkspaceA = await appSnapshot(pageA);

    const openedB = await submitToNewTarget(opener, itemB.formId);
    const pageB = openedB.page;
    await bindApp(pageB);
    const requestUrlB =
      openedB.observation.navigations.find(
        (entry) => new URL(entry.url).pathname === new URL(origin + itemB.actionPath).pathname,
      )?.url ?? null;
    const initialB = await appSnapshot(pageB);
    const childInitialStorageB = await pageB.evaluate(() => ({
      openerAvailable: Boolean(window.opener),
      windowName: window.name,
      tabMarker: sessionStorage.getItem('oracle.tab-marker'),
      sharedMarker: localStorage.getItem('oracle.shared-marker'),
      instanceId: window.__targetContextOracle.instanceId,
    }));
    await pageB.evaluate(() => {
      sessionStorage.setItem('oracle.tab-marker', 'blank-b-tab');
      localStorage.setItem('oracle.shared-marker', 'set-by-blank-b');
    });
    await openSessionThroughWorkspace(
      pageB,
      'Second chat',
      fixture.appActions.blankWorkspaceSession,
    );
    await setDraft(pageB, fixture.appActions.blankWorkspaceDraft);
    const afterSessionB = await appSnapshot(pageB);
    const storage = await storageAndIdentity(pageA, pageB, opener);
    const localStorageVisibleFromA = await pageA.evaluate(() =>
      localStorage.getItem('oracle.shared-marker'),
    );
    const localStorageVisibleFromOpener = await opener.evaluate(() =>
      localStorage.getItem('oracle.shared-marker'),
    );
    const pageCountAfterBothTargets = context.pages().length;
    const pageCounts = {
      beforeTargets: pagesBefore,
      afterBlankOne: pagesAfterA,
      afterBlankTwo: pageCountAfterBothTargets,
      allTargetsAreDistinctPages: pageA !== pageB && pageCountAfterBothTargets === 3,
    };

    await pageB.close();
    const openerAfterCloseB = await sourceFormSnapshot(opener);
    const pageCountAfterCloseB = context.pages().length;
    await pageA.close();
    const openerAfterCloseBoth = await sourceFormSnapshot(opener);
    const pageCountAfterCloseBoth = context.pages().length;

    return {
      caseId: 'blank-two-independent-app-contexts',
      targetCases: [itemA.id, itemB.id],
      openerBefore: openerBefore,
      pages: pageCounts,
      openerSessionStorageSeed: openerSessionMarker,
      blankA: {
        target: itemA.target,
        submittedNavigationUrl: initialA.documentStartUrl,
        documentResponses: openedA.observation.documentResponses,
        initialApp: initialA,
        initialStorage: { ...childInitialStorageA, instanceId: undefined },
        afterOpenWorkspace: afterWorkspaceA,
        navigations: openedA.observation.navigations,
        eventStreams: openedA.observation.eventStreams,
      },
      blankB: {
        target: itemB.target,
        submittedNavigationUrl: initialB.documentStartUrl,
        documentResponses: openedB.observation.documentResponses,
        initialApp: initialB,
        initialStorage: { ...childInitialStorageB, instanceId: undefined },
        afterOpenSession: afterSessionB,
        navigations: openedB.observation.navigations,
        eventStreams: openedB.observation.eventStreams,
      },
      storage: {
        independentWindowObjects: storage.independentWindowObjects,
        appClientIdShared: storage.appClientIdShared,
        appClientIdMatchesSharedLocalStorage: storage.appClientIdMatchesSharedLocalStorage,
        localStorageMarkerAsSeenByBlankA: localStorageVisibleFromA,
        localStorageMarkerAsSeenByOpener: localStorageVisibleFromOpener,
        pageA: storage.pageA.storage,
        pageB: storage.pageB.storage,
        opener: storage.opener.storage,
      },
      viewStates: {
        blankA: {
          view: afterWorkspaceA.app.view,
          activeSessionId: afterWorkspaceA.app.activeSessionId,
          workspaceViewId: afterWorkspaceA.app.workspaceViewId,
          draft: afterWorkspaceA.app.draft,
        },
        blankB: {
          view: afterSessionB.app.view,
          activeSessionId: afterSessionB.app.activeSessionId,
          workspaceViewId: afterSessionB.app.workspaceViewId,
          draft: afterSessionB.app.draft,
        },
        remainIndependentAfterActions:
          afterWorkspaceA.app.view === 'workspace' &&
          afterSessionB.app.view === 'session' &&
          afterWorkspaceA.app.activeSessionId !== afterSessionB.app.activeSessionId,
      },
      targetLifecycle: {
        blankTargetWindowNames: [initialA.windowName, initialB.windowName],
        blankTargetOpenerAvailable: [initialA.openerAvailable, initialB.openerAvailable],
        formControlsAfterCloseSecondTarget: openerAfterCloseB.fields,
        formControlsAfterCloseAllTargets: openerAfterCloseBoth.fields,
        openerUrlAfterCloseTargets: openerAfterCloseBoth.url,
        openerRemainedOpen: pageCountAfterCloseBoth === 1,
        pageCountAfterCloseSecondTarget: pageCountAfterCloseB,
      },
    };
  } finally {
    await context.close();
  }
}

async function fillNamedChildControls(page) {
  const probe = fixture.formBackProbe;
  const fields = probe.typedControls;
  await page.locator('#child-text').fill(fields.text);
  await page.locator('#child-password').click();
  await page.locator('#child-password').pressSequentially(fields.password);
  await page.locator('#child-number').fill(fields.number);
  await page.locator('#child-textarea').fill(fields.textarea);
  await page.locator('#child-check').uncheck();
  await page.locator('#radio-blue').check();
  await page.locator('#child-multiple').selectOption(fields.multipleSelectValues);
  await page.locator('#duplicate-first').fill(fields.duplicateNameValues[0]);
  await page.locator('#duplicate-second').fill(fields.duplicateNameValues[1]);
  await page.locator('#child-unnamed').fill(fields.unnamed);
  await page.locator('#control-off').fill(fields.controlAutocompleteOff);
  await page.locator('#script-default').fill(fields.scriptDefault);
  await page.locator('#form-off-text').fill(probe.formAutocompleteOffControls.text);
  await page.locator('#form-off-password').fill(probe.formAutocompleteOffControls.password);
  const scrollMetrics = await page.evaluate((y) => {
    window.scrollTo(0, y);
    return {
      scrollY: window.scrollY,
      innerHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
    };
  }, probe.scrollY);
  if (scrollMetrics.scrollY < probe.scrollY)
    throw new Error(
      `Named history form could not reach requested scroll position: ${JSON.stringify(scrollMetrics)}`,
    );
}

async function exerciseScriptModifiedReset(page) {
  const resetProbe = fixture.formBackProbe.scriptDefaultReset;
  await page.locator('#script-default').evaluate((input, value) => {
    input.defaultValue = value;
  }, resetProbe.modifiedDefaultValue);
  await page.locator('#script-default').fill(resetProbe.valueBeforeReset);
  await page.locator('#child-reset').click();
  return page.locator('#script-default').evaluate(
    (input, expected) => ({
      value: input.value,
      defaultValue: input.defaultValue,
      expectedValue: expected,
      resetUsedModifiedDefault: input.value === expected && input.defaultValue === expected,
    }),
    resetProbe.expectedValueAfterReset,
  );
}

async function namedChildFormSnapshot(page) {
  return page.evaluate(() => ({
    url: location.href,
    responseVersion: document.querySelector('#server-version')?.textContent?.trim() ?? null,
    windowName: window.name,
    openerAvailable: Boolean(window.opener),
    historyLength: history.length,
    scrollY: window.scrollY,
    pageShows: window.__targetContextOracle?.pageShows ?? [],
    pageHides: window.__targetContextOracle?.pageHides ?? [],
    fields: {
      formAutocomplete: {
        typed: document.querySelector('#typed-form')?.autocomplete ?? null,
        formOff: document.querySelector('#form-autocomplete-off')?.autocomplete ?? null,
      },
      text: (() => {
        const e = document.querySelector('#child-text');
        return e
          ? { value: e.value, defaultValue: e.defaultValue, autocomplete: e.autocomplete }
          : null;
      })(),
      password: (() => {
        const e = document.querySelector('#child-password');
        return e
          ? { value: e.value, defaultValue: e.defaultValue, autocomplete: e.autocomplete }
          : null;
      })(),
      number: (() => {
        const e = document.querySelector('#child-number');
        return e
          ? { value: e.value, defaultValue: e.defaultValue, autocomplete: e.autocomplete }
          : null;
      })(),
      untouchedText: (() => {
        const e = document.querySelector('#untouched-text');
        return e ? { value: e.value, defaultValue: e.defaultValue } : null;
      })(),
      textEditedThenReverted: (() => {
        const e = document.querySelector('#history-reverted-text');
        return e ? { value: e.value, defaultValue: e.defaultValue } : null;
      })(),
      untouchedRange: (() => {
        const e = document.querySelector('#untouched-range');
        return e ? { value: e.value, defaultValue: e.defaultValue } : null;
      })(),
      untouchedCheckbox: (() => {
        const e = document.querySelector('#untouched-check');
        return e ? { checked: e.checked, defaultChecked: e.defaultChecked } : null;
      })(),
      untouchedSelect: (() => {
        const e = document.querySelector('#untouched-select');
        return e
          ? {
              value: e.value,
              defaultValue: [...e.options].find((option) => option.defaultSelected)?.value ?? null,
              selectedValues: [...e.selectedOptions].map((option) => option.value),
            }
          : null;
      })(),
      textarea: (() => {
        const e = document.querySelector('#child-textarea');
        return e ? { value: e.value, defaultValue: e.defaultValue } : null;
      })(),
      checkbox: (() => {
        const e = document.querySelector('#child-check');
        return e ? { checked: e.checked, defaultChecked: e.defaultChecked } : null;
      })(),
      radio: [...document.querySelectorAll('input[name="radio"]')].map((e) => ({
        id: e.id,
        value: e.value,
        checked: e.checked,
        defaultChecked: e.defaultChecked,
      })),
      multipleSelect: (() => {
        const e = document.querySelector('#child-multiple');
        return e
          ? {
              values: [...e.selectedOptions].map((option) => option.value),
              defaultSelectedValues: [...e.options]
                .filter((option) => option.defaultSelected)
                .map((option) => option.value),
            }
          : null;
      })(),
      duplicateNameValues: [
        ...document.querySelectorAll('#typed-form input[name="duplicate"]'),
      ].map((e) => ({ value: e.value, defaultValue: e.defaultValue })),
      unnamed: (() => {
        const e = document.querySelector('#child-unnamed');
        return e ? { value: e.value, defaultValue: e.defaultValue, name: e.name } : null;
      })(),
      controlAutocompleteOff: (() => {
        const e = document.querySelector('#control-off');
        return e
          ? { value: e.value, defaultValue: e.defaultValue, autocomplete: e.autocomplete }
          : null;
      })(),
      formAutocompleteOff: {
        text: (() => {
          const e = document.querySelector('#form-off-text');
          return e
            ? { value: e.value, defaultValue: e.defaultValue, autocomplete: e.autocomplete }
            : null;
        })(),
        password: (() => {
          const e = document.querySelector('#form-off-password');
          return e
            ? { value: e.value, defaultValue: e.defaultValue, autocomplete: e.autocomplete }
            : null;
        })(),
      },
      disabled: (() => {
        const e = document.querySelector('#child-disabled');
        return e ? { value: e.value, defaultValue: e.defaultValue, disabled: e.disabled } : null;
      })(),
      readonly: (() => {
        const e = document.querySelector('#child-readonly');
        return e ? { value: e.value, defaultValue: e.defaultValue, readOnly: e.readOnly } : null;
      })(),
      scriptDefault: (() => {
        const e = document.querySelector('#script-default');
        return e ? { value: e.value, defaultValue: e.defaultValue } : null;
      })(),
    },
    storage: {
      localClientIdPresent: Boolean(localStorage.getItem('relay.client-id')),
      localSharedMarker: localStorage.getItem('oracle.shared-marker'),
      tabMarker: sessionStorage.getItem('oracle.tab-marker'),
    },
  }));
}

async function openHistoryTarget(browserTarget, caseId) {
  const entry = historyEntryForm(caseId);
  const context = await browserTarget.newContext(makeContextOptions());
  await context.addInitScript(() => {
    const metadata = {
      instanceId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      documentStartUrl: location.href,
      pageShows: [],
      pageHides: [],
    };
    Object.defineProperty(window, '__targetContextOracle', { value: metadata, configurable: true });
    addEventListener('pageshow', (event) =>
      metadata.pageShows.push({ persisted: event.persisted, url: location.href }),
    );
    addEventListener('pagehide', (event) =>
      metadata.pageHides.push({ persisted: event.persisted, url: location.href }),
    );
  });
  context.on('page', (newPage) => observePage(context, newPage));
  const opener = await context.newPage();
  observePage(context, opener);
  await opener.goto(
    `${origin}${fixture.historyProbes.openerPath}?case=${encodeURIComponent(caseId)}`,
    { waitUntil: 'domcontentloaded', timeout: 10000 },
  );
  const popupPromise = opener.waitForEvent('popup', { timeout: 10000 });
  await opener.locator(`#${entry.formId}`).locator('button[type="submit"]').click();
  const target = await popupPromise;
  const observation = observePage(context, target);
  await target.waitForLoadState('domcontentloaded', { timeout: 10000 });
  return { context, opener, target, observation, entry };
}

async function attachHistoryCdp(context, target) {
  const session = await context.newCDPSession(target);
  const bfcacheNotUsed = [];
  const lifecycleEvents = [];
  const networkRequests = [];
  const networkResponses = [];
  const requestsServedFromCache = [];
  session.on('Page.backForwardCacheNotUsed', (event) => bfcacheNotUsed.push(event));
  session.on('Page.lifecycleEvent', (event) => {
    if (['init', 'DOMContentLoaded', 'load', 'pageshow', 'pagehide'].includes(event.name))
      lifecycleEvents.push({ name: event.name, frameId: event.frameId, loaderId: event.loaderId });
  });
  session.on('Network.requestWillBeSent', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== origin || !url.pathname.startsWith('/__oracle/')) return;
    const relevantHeaders = Object.fromEntries(
      Object.entries(event.request.headers ?? {}).filter(([name]) =>
        ['cache-control', 'pragma', 'if-none-match', 'if-modified-since'].includes(
          name.toLowerCase(),
        ),
      ),
    );
    networkRequests.push({
      requestId: event.requestId,
      url: event.request.url,
      method: event.request.method,
      headers: relevantHeaders,
      hasPostData: event.request.hasPostData ?? false,
      postData: event.request.postData ?? null,
      documentURL: event.documentURL,
      initiatorType: event.initiator?.type ?? null,
    });
  });
  session.on('Network.responseReceived', (event) => {
    const url = new URL(event.response.url);
    if (url.origin !== origin || !url.pathname.startsWith('/__oracle/')) return;
    const responseHeaders = event.response.headers ?? {};
    const cacheHeaders = Object.fromEntries(
      Object.entries(responseHeaders).filter(([name]) =>
        [
          'cache-control',
          'pragma',
          'etag',
          'last-modified',
          'age',
          'date',
          'content-location',
        ].includes(name.toLowerCase()),
      ),
    );
    networkResponses.push({
      requestId: event.requestId,
      url: event.response.url,
      status: event.response.status,
      fromDiskCache: event.response.fromDiskCache ?? false,
      fromServiceWorker: event.response.fromServiceWorker ?? false,
      fromPrefetchCache: event.response.fromPrefetchCache ?? false,
      cacheHeaders,
      responseType: event.type,
    });
  });
  session.on('Network.requestServedFromCache', (event) =>
    requestsServedFromCache.push({ requestId: event.requestId }),
  );
  await session.send('Page.enable');
  await session.send('Page.setLifecycleEventsEnabled', { enabled: true });
  await session.send('Network.enable');
  return {
    session,
    bfcacheNotUsed,
    lifecycleEvents,
    networkRequests,
    networkResponses,
    requestsServedFromCache,
  };
}

async function historyDocumentSnapshot(page) {
  return page.evaluate(() => ({
    url: location.href,
    pathname: location.pathname,
    title: document.title,
    heading: document.querySelector('h1')?.textContent?.trim() ?? null,
    marker:
      document
        .querySelector(
          '#history-version, #history-error, #post-result, #post-next, #fragment-instance',
        )
        ?.textContent?.trim() ?? null,
    bodyText: document.body?.innerText?.trim().slice(0, 300) ?? null,
    instanceId: window.__targetContextOracle?.instanceId ?? null,
    documentStartUrl: window.__targetContextOracle?.documentStartUrl ?? null,
    pageShows: window.__targetContextOracle?.pageShows ?? [],
    pageHides: window.__targetContextOracle?.pageHides ?? [],
    historyLength: history.length,
    scrollY: window.scrollY,
    opener: window.opener
      ? { present: true, closed: window.opener.closed }
      : { present: false, closed: null },
    form: {
      untouchedText:
        document.querySelector('#history-untouched, #history-untouched-field')?.value ?? null,
      textEditedThenReverted: document.querySelector('#history-reverted-text')
        ? {
            value: document.querySelector('#history-reverted-text').value,
            defaultValue: document.querySelector('#history-reverted-text').defaultValue,
          }
        : null,
      untouchedRange: (() => {
        const e = document.querySelector('#history-range, #untouched-range');
        return e ? { value: e.value, defaultValue: e.defaultValue } : null;
      })(),
      untouchedCheckbox: document.querySelector('#history-untouched-check')
        ? {
            checked: document.querySelector('#history-untouched-check').checked,
            defaultChecked: document.querySelector('#history-untouched-check').defaultChecked,
          }
        : null,
      untouchedSelect: document.querySelector('#history-untouched-select')
        ? {
            value: document.querySelector('#history-untouched-select').value,
            defaultSelected: [...document.querySelector('#history-untouched-select').options]
              .filter((option) => option.defaultSelected)
              .map((option) => option.value),
          }
        : null,
      postPayload: document.querySelector('#post-payload')?.value ?? null,
    },
    navigationEntry: (() => {
      const entry = performance.getEntriesByType('navigation')[0];
      return entry ? { type: entry.type, redirectCount: entry.redirectCount } : null;
    })(),
  }));
}

async function browserErrorPageSnapshot(page) {
  return page.evaluate(() => {
    const summaryText = '按下重新載入按鈕，重新提交載入網頁所需的資料。';
    const styledNodes = [];
    const seenRoots = new Set();
    const visit = (root) => {
      if (!root || seenRoots.has(root)) return;
      seenRoots.add(root);
      for (const node of root.querySelectorAll('*')) {
        const id = node.id || '';
        const className = typeof node.className === 'string' ? node.className : '';
        const text = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
        const roles = [];
        if (className.split(/\s+/).includes('interstitial-wrapper'))
          roles.push('interstitial-wrapper');
        if (id === 'main-content') roles.push('main-content');
        if (className.split(/\s+/).includes('icon')) roles.push('icon');
        if (node.tagName === 'H1') roles.push('h1');
        if (node.tagName === 'P') roles.push('p');
        if (
          className.split(/\s+/).some((item) => item.includes('suggestion')) ||
          id.includes('suggestion') ||
          text === summaryText
        )
          roles.push('single-suggestion');
        if (
          className.split(/\s+/).includes('error-code') ||
          id === 'error-code' ||
          text.startsWith('ERR_')
        )
          roles.push('error-code');
        if (id === 'main-message') roles.push('main-message');
        if (roles.length) {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          styledNodes.push({
            roles,
            tag: node.tagName,
            id: id || null,
            className: className || null,
            text: text.slice(0, 300),
            style: {
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              lineHeight: style.lineHeight,
              color: style.color,
              marginTop: style.marginTop,
              marginRight: style.marginRight,
              marginBottom: style.marginBottom,
              marginLeft: style.marginLeft,
              paddingTop: style.paddingTop,
              paddingRight: style.paddingRight,
              paddingBottom: style.paddingBottom,
              paddingLeft: style.paddingLeft,
              width: style.width,
              height: style.height,
              boxSizing: style.boxSizing,
              display: style.display,
            },
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          });
        }
        if (node.shadowRoot) visit(node.shadowRoot);
      }
    };
    visit(document);
    return {
      url: location.href,
      title: document.title,
      visibleText: document.body?.innerText ?? '',
      doctype: document.doctype?.name ?? null,
      rootTag: document.documentElement?.tagName ?? null,
      bodyChildren: [...(document.body?.children ?? [])].map((node) => ({
        tag: node.tagName,
        id: node.id || null,
        className: typeof node.className === 'string' ? node.className : null,
        role: node.getAttribute('role'),
        text: node.innerText?.slice(0, 500) ?? '',
        childTags: [...node.children].map((child) => child.tagName),
        outerHTML: node.outerHTML.slice(0, 2500),
      })),
      styledNodes,
    };
  });
}

async function boundedWait(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return { completed: true, result };
    } catch {
      // A document can be between commits while a history navigation is in flight.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return { completed: false, result: null };
}

function scenarioReceipts(path, scenario) {
  return historyHttpReceipts.filter(
    (entry) => entry.path === path && entry.rawQuery.includes(`scenario=${scenario}`),
  );
}

async function waitForHistoryReturn(page, path, scenario, requestsBeforeBack, timeoutMs = 5000) {
  return boundedWait(async () => {
    if (new URL(page.url()).pathname !== path) return false;
    const receipts = scenarioReceipts(path, scenario);
    if (receipts.length > requestsBeforeBack) return receipts.at(-1).status !== null;
    return page.evaluate((expectedPath) => {
      const pageshowRestored =
        window.__targetContextOracle?.pageShows?.some((event) => {
          try {
            return event.persisted && new URL(event.url).pathname === expectedPath;
          } catch {
            return false;
          }
        }) ?? false;
      const navigationEntry = performance.getEntriesByType('navigation')[0];
      return pageshowRestored || navigationEntry?.type === 'back_forward';
    }, path);
  }, timeoutMs);
}

async function captureNamedGetCloseOpenerBack(browserTarget) {
  const probe = fixture.historyProbes.entryForms.find(
    (item) => item.id === 'named-get-close-opener-back',
  );
  const { context, opener, target, observation, entry } = await openHistoryTarget(
    browserTarget,
    probe.id,
  );
  const diagnostics = await attachHistoryCdp(context, target);
  try {
    const initial = await historyDocumentSnapshot(target);
    const aRequestsBeforeBack = scenarioReceipts(
      fixture.historyProbes.aPath,
      'close-opener',
    ).length;
    const revertedTextDefault = await target
      .locator('#history-reverted-text')
      .getAttribute('value');
    await target
      .locator('#history-reverted-text')
      .fill(`${revertedTextDefault} temporarily edited`);
    await target.locator('#history-reverted-text').fill(revertedTextDefault);
    const editThenRevertBeforeNavigation = await target
      .locator('#history-reverted-text')
      .evaluate((input) => ({
        value: input.value,
        defaultValue: input.defaultValue,
        valueEqualsDefault: input.value === input.defaultValue,
      }));
    await target.locator('#go-to-b button[type="submit"]').click();
    await target.waitForURL((url) => url.pathname === fixture.historyProbes.bPath, {
      timeout: 10000,
    });
    const atB = await historyDocumentSnapshot(target);
    const historyLengthBeforeClose = atB.historyLength;
    await opener.close();
    await boundedWait(() => target.evaluate(() => !window.opener || window.opener.closed));
    const openerStateAfterClose = await target.evaluate(() =>
      window.opener
        ? { present: true, closed: window.opener.closed }
        : { present: false, closed: null },
    );
    await target.evaluate(() => history.back());
    const backWait = await waitForHistoryReturn(
      target,
      fixture.historyProbes.aPath,
      'close-opener',
      aRequestsBeforeBack,
    );
    await target.waitForTimeout(100);
    const afterBack = await historyDocumentSnapshot(target);
    return {
      caseId: 'named-get-close-opener-back',
      targetName: entry.target,
      initial,
      editThenRevertBeforeNavigation,
      atB,
      historyLengthBeforeClose,
      openerStateAfterClose,
      backWait,
      afterBack,
      returnedToA: afterBack.pathname === fixture.historyProbes.aPath,
      reusedAInstance: afterBack.instanceId === initial.instanceId,
      pageResponses: observation.documentResponses,
      navigations: observation.navigations,
      httpReceipts: historyHttpReceipts.filter((receipt) =>
        receipt.rawQuery.includes('scenario=close-opener'),
      ),
      bfcacheNotUsed: diagnostics.bfcacheNotUsed,
      lifecycleEvents: diagnostics.lifecycleEvents,
    };
  } finally {
    await diagnostics.session.detach();
    await context.close();
  }
}

async function captureNamedGetBackStatus(browserTarget, status) {
  const caseId = `named-back-status-${status}`;
  const { context, target, observation, entry } = await openHistoryTarget(browserTarget, caseId);
  const diagnostics = await attachHistoryCdp(context, target);
  try {
    const initial = await historyDocumentSnapshot(target);
    const initialInstanceId = initial.instanceId;
    const aRequestsBeforeBack = scenarioReceipts(
      fixture.historyProbes.aPath,
      `status-${status}`,
    ).length;
    await target.locator('#go-to-b button[type="submit"]').click();
    await target.waitForURL((url) => url.pathname === fixture.historyProbes.bPath, {
      timeout: 10000,
    });
    const atB = await historyDocumentSnapshot(target);
    await target.evaluate(() => history.back());
    const backWait = await waitForHistoryReturn(
      target,
      fixture.historyProbes.aPath,
      `status-${status}`,
      aRequestsBeforeBack,
    );
    await target.waitForTimeout(100);
    const afterBack = await historyDocumentSnapshot(target);
    const receipts = scenarioReceipts(fixture.historyProbes.aPath, `status-${status}`);
    return {
      caseId,
      requestedBackStatus: status,
      targetName: entry.target,
      initial,
      atB,
      historyLengthBeforeBack: atB.historyLength,
      backWait,
      afterBack,
      returnedToAUrl: afterBack.pathname === fixture.historyProbes.aPath,
      reusedAInstance: afterBack.instanceId === initialInstanceId,
      retainedBInstance: afterBack.instanceId === atB.instanceId,
      retainedBUrl: afterBack.url === atB.url,
      historyLengthAfterBack: afterBack.historyLength,
      renderedResponseMarker: afterBack.marker,
      responseReceipts: receipts,
      pageResponses: observation.documentResponses,
      navigations: observation.navigations,
      bfcacheNotUsed: diagnostics.bfcacheNotUsed,
      lifecycleEvents: diagnostics.lifecycleEvents,
    };
  } finally {
    await diagnostics.session.detach();
    await context.close();
  }
}

async function captureNamedCacheableHistory(browserTarget) {
  const probe = fixture.historyProbes.entryForms.find(
    (item) => item.id === 'named-get-cacheable-history',
  );
  const { context, opener, target, observation, entry } = await openHistoryTarget(
    browserTarget,
    probe.id,
  );
  const diagnostics = await attachHistoryCdp(context, target);
  try {
    const initial = await historyDocumentSnapshot(target);
    const initialRequestCount = scenarioReceipts(fixture.historyProbes.aPath, 'cacheable').length;
    await target.locator('#go-to-b button[type="submit"]').click();
    await target.waitForURL((url) => url.pathname === fixture.historyProbes.bPath, {
      timeout: 10000,
    });
    const atB = await historyDocumentSnapshot(target);
    await target.evaluate(() => history.back());
    const backWait = await waitForHistoryReturn(
      target,
      fixture.historyProbes.aPath,
      'cacheable',
      initialRequestCount,
    );
    await target.waitForTimeout(100);
    const afterBack = await historyDocumentSnapshot(target);
    const aReceipts = scenarioReceipts(fixture.historyProbes.aPath, 'cacheable');
    const aNetworkRequests = diagnostics.networkRequests.filter(
      (request) =>
        new URL(request.url).pathname === fixture.historyProbes.aPath &&
        new URL(request.url).searchParams.get('scenario') === 'cacheable',
    );
    const aNetworkResponses = diagnostics.networkResponses.filter(
      (response) =>
        new URL(response.url).pathname === fixture.historyProbes.aPath &&
        new URL(response.url).searchParams.get('scenario') === 'cacheable',
    );
    const cachedRequestIds = new Set(
      diagnostics.requestsServedFromCache.map((entry) => entry.requestId),
    );
    return {
      caseId: 'named-get-cacheable-history',
      targetName: entry.target,
      openerRemainedOpen: !opener.isClosed(),
      requestedCacheControl: fixture.historyProbes.cacheableCacheControl,
      initial,
      atB,
      backWait,
      afterBack,
      bfcacheNotUsed: diagnostics.bfcacheNotUsed,
      initialServerRequestCount: initialRequestCount,
      serverRequestCountAfterBack: aReceipts.length,
      serverGetOnBack: aReceipts.length > initialRequestCount,
      responseCacheControl: aReceipts[0]?.responseCacheControl ?? null,
      responseVersionOnBack: aReceipts.at(-1)?.responseVersion ?? null,
      networkRequests: aNetworkRequests.map((request) => ({
        ...request,
        servedFromCacheEvent: cachedRequestIds.has(request.requestId),
      })),
      networkResponses: aNetworkResponses,
      requestsServedFromCache: diagnostics.requestsServedFromCache,
      pageResponses: observation.documentResponses.filter(
        (response) => new URL(response.url).pathname === fixture.historyProbes.aPath,
      ),
      navigationTypeAfterBack: afterBack.navigationEntry?.type ?? null,
    };
  } finally {
    await diagnostics.session.detach();
    await context.close();
  }
}

async function capturePostHistory(browserTarget, probeId) {
  const probe = fixture.historyProbes.entryForms.find((item) => item.id === probeId);
  const scenario = new URL(probe.actionPath, origin).searchParams.get('scenario') ?? 'post';
  const { context, target, observation, entry } = await openHistoryTarget(browserTarget, probe.id);
  const diagnostics = await attachHistoryCdp(context, target);
  const dialogs = [];
  target.on('dialog', async (dialog) => {
    const record = { type: dialog.type(), message: dialog.message(), action: 'dismissed' };
    dialogs.push(record);
    await dialog.dismiss();
  });
  try {
    const initial = await historyDocumentSnapshot(target);
    await target.locator('#post-payload').fill(fixture.historyProbes.postValue);
    const beforePostReceiptCount = historyHttpReceipts.filter(
      (item) =>
        item.method === 'POST' &&
        item.path === fixture.historyProbes.postResultPath &&
        item.rawQuery.includes(`scenario=${scenario}`),
    ).length;
    await Promise.all([
      target.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }),
      target.locator('#post-to-result button[type="submit"]').click(),
    ]);
    const afterPost = await historyDocumentSnapshot(target);
    await Promise.all([
      target.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }),
      target.locator('#post-next-link').click(),
    ]);
    const afterGet = await historyDocumentSnapshot(target);
    const postReceiptCountBeforeBack = historyHttpReceipts.filter(
      (item) =>
        item.method === 'POST' &&
        item.path === fixture.historyProbes.postResultPath &&
        item.rawQuery.includes(`scenario=${scenario}`),
    ).length;
    await target.evaluate(() => history.back());
    const backWait = await boundedWait(
      () =>
        dialogs.length > 0 || new URL(target.url()).pathname !== fixture.historyProbes.postNextPath,
      5000,
    );
    await target.waitForTimeout(100);
    const afterBack = await historyDocumentSnapshot(target).catch((error) => ({
      url: target.url(),
      snapshotError: error.message,
    }));
    const postReceiptCountAfterBack = historyHttpReceipts.filter(
      (item) =>
        item.method === 'POST' &&
        item.path === fixture.historyProbes.postResultPath &&
        item.rawQuery.includes(`scenario=${scenario}`),
    ).length;
    const postBackNavigationAttempts = observation.navigations.filter(
      (item) =>
        item.method === 'POST' &&
        new URL(item.url).pathname === fixture.historyProbes.postResultPath,
    ).length;
    let errorPageDetails = null;
    let errorScreenshot = null;
    if (afterBack.url.startsWith('chrome-error://')) {
      errorPageDetails = await browserErrorPageSnapshot(target).catch((error) => ({
        snapshotError: error.message,
      }));
      const screenshotPath = resolve(temporaryOutput, `${probe.id}-back-error.png`);
      try {
        await target.screenshot({ path: screenshotPath, fullPage: true, timeout: 5000 });
        errorScreenshot = { path: screenshotPath, saved: true };
      } catch (error) {
        errorScreenshot = { path: screenshotPath, saved: false, error: error.message };
      }
    }
    const postNextRequestsBeforeForward = historyHttpReceipts.filter(
      (item) =>
        item.method === 'GET' &&
        item.path === fixture.historyProbes.postNextPath &&
        item.rawQuery.includes(`scenario=${scenario}`),
    ).length;
    let forwardWait = null;
    let afterForward = null;
    if (new URL(target.url()).pathname !== fixture.historyProbes.postNextPath) {
      await target.evaluate(() => history.forward());
      forwardWait = await boundedWait(async () => {
        if (new URL(target.url()).pathname !== fixture.historyProbes.postNextPath) return false;
        const nextReceiptCount = historyHttpReceipts.filter(
          (item) =>
            item.method === 'GET' &&
            item.path === fixture.historyProbes.postNextPath &&
            item.rawQuery.includes(`scenario=${scenario}`),
        ).length;
        if (nextReceiptCount > postNextRequestsBeforeForward) return true;
        return target.evaluate(
          () => window.__targetContextOracle?.pageShows?.some((event) => event.persisted) ?? false,
        );
      }, 5000);
      await target.waitForTimeout(100);
      afterForward = await historyDocumentSnapshot(target).catch((error) => ({
        url: target.url(),
        snapshotError: error.message,
      }));
    } else {
      await target.evaluate(() => history.forward());
      await target.waitForTimeout(250);
      forwardWait = {
        completed: false,
        result:
          'Back remained at the GET document, so no later history entry was available for Forward',
      };
      afterForward = await historyDocumentSnapshot(target).catch((error) => ({
        url: target.url(),
        snapshotError: error.message,
      }));
    }
    const postNextRequestsAfterForward = historyHttpReceipts.filter(
      (item) =>
        item.method === 'GET' &&
        item.path === fixture.historyProbes.postNextPath &&
        item.rawQuery.includes(`scenario=${scenario}`),
    ).length;
    const postDocumentNetworkRequests = diagnostics.networkRequests.filter((request) => {
      const url = new URL(request.url);
      return (
        [fixture.historyProbes.postResultPath, fixture.historyProbes.postNextPath].includes(
          url.pathname,
        ) && url.searchParams.get('scenario') === scenario
      );
    });
    const postDocumentNetworkResponses = diagnostics.networkResponses.filter((response) => {
      const url = new URL(response.url);
      return (
        [fixture.historyProbes.postResultPath, fixture.historyProbes.postNextPath].includes(
          url.pathname,
        ) && url.searchParams.get('scenario') === scenario
      );
    });
    const cachedRequestIds = new Set(
      diagnostics.requestsServedFromCache.map((item) => item.requestId),
    );
    return {
      caseId: probe.id,
      targetName: entry.target,
      initial,
      afterPost,
      afterGet,
      backWait,
      afterBack,
      dialogs,
      postReceiptCountBeforeBack,
      postReceiptCountAfterBack,
      postResponseReplayedOnBack: postReceiptCountAfterBack > postReceiptCountBeforeBack,
      postBackNavigationAttempts,
      errorPageDetails,
      errorScreenshot,
      forwardWait,
      afterForward,
      getForward: {
        path: afterForward.pathname ?? null,
        serverGetCountBefore: postNextRequestsBeforeForward,
        serverGetCountAfter: postNextRequestsAfterForward,
        refetchedFromServer: postNextRequestsAfterForward > postNextRequestsBeforeForward,
        restoredSameDocumentInstance: afterForward.instanceId === afterGet.instanceId,
      },
      historyLengthAtGet: afterGet.historyLength,
      postHttpReceipts: historyHttpReceipts.filter(
        (item) =>
          (item.path === fixture.historyProbes.postResultPath ||
            item.path === fixture.historyProbes.postNextPath) &&
          item.rawQuery.includes(`scenario=${scenario}`),
      ),
      postResultResponseCacheControl:
        historyHttpReceipts.find(
          (item) =>
            item.method === 'POST' &&
            item.path === fixture.historyProbes.postResultPath &&
            item.rawQuery.includes(`scenario=${scenario}`),
        )?.responseCacheControl ?? null,
      postResultResponseContentLocation:
        historyHttpReceipts.find(
          (item) =>
            item.method === 'POST' &&
            item.path === fixture.historyProbes.postResultPath &&
            item.rawQuery.includes(`scenario=${scenario}`),
        )?.responseContentLocation ?? null,
      postDocumentNetworkRequests: postDocumentNetworkRequests.map((request) => ({
        ...request,
        servedFromCacheEvent: cachedRequestIds.has(request.requestId),
      })),
      postDocumentNetworkResponses,
      requestsServedFromCache: diagnostics.requestsServedFromCache,
      pageResponses: observation.documentResponses,
      navigations: observation.navigations,
      bfcacheNotUsed: diagnostics.bfcacheNotUsed,
      lifecycleEvents: diagnostics.lifecycleEvents,
      postRequestCountBeforePost: beforePostReceiptCount,
    };
  } finally {
    await diagnostics.session.detach();
    await context.close();
  }
}

async function captureNamedFragmentHistory(browserTarget) {
  const probe = fixture.historyProbes.entryForms.find(
    (item) => item.id === 'named-same-document-fragment',
  );
  const { context, target, observation, entry } = await openHistoryTarget(browserTarget, probe.id);
  try {
    const initial = await historyDocumentSnapshot(target);
    const documentRequestsBefore = historyHttpReceipts.filter(
      (item) => item.path === fixture.historyProbes.fragmentPath,
    ).length;
    await target.locator('#same-document-link').click();
    await target.waitForURL((url) => url.hash === '#fragment-target', { timeout: 5000 });
    const atFragment = await historyDocumentSnapshot(target);
    await target.evaluate(() => history.back());
    const backWait = await boundedWait(
      () =>
        new URL(target.url()).pathname === fixture.historyProbes.fragmentPath &&
        new URL(target.url()).hash === '',
    );
    await target.waitForTimeout(50);
    const afterFragmentBack = await historyDocumentSnapshot(target);
    const documentRequestsAfter = historyHttpReceipts.filter(
      (item) => item.path === fixture.historyProbes.fragmentPath,
    ).length;
    return {
      caseId: 'named-same-document-fragment',
      targetName: entry.target,
      initial,
      atFragment,
      backWait,
      afterFragmentBack,
      oneDocumentInstance:
        initial.instanceId === atFragment.instanceId &&
        atFragment.instanceId === afterFragmentBack.instanceId,
      documentRequestCountBefore: documentRequestsBefore,
      documentRequestCountAfter: documentRequestsAfter,
      noAdditionalDocumentRequest: documentRequestsBefore === documentRequestsAfter,
      pageResponses: observation.documentResponses,
      navigations: observation.navigations,
    };
  } finally {
    await context.close();
  }
}

async function captureNamedHistoryProbes(browserTarget) {
  return {
    caseId: 'named-history-browser-behavior',
    getCloseOpenerBack: await captureNamedGetCloseOpenerBack(browserTarget),
    getBackStatuses: await Promise.all(
      fixture.historyProbes.responseStatusCases.map((status) =>
        captureNamedGetBackStatus(browserTarget, status),
      ),
    ),
    getCacheableHistory: await captureNamedCacheableHistory(browserTarget),
    postBackForward: await capturePostHistory(browserTarget, 'named-post-history'),
    postBackForwardNoOpener: await capturePostHistory(browserTarget, 'blank-noopener-post-history'),
    postBackForwardNoOpenerDefaultCache: await capturePostHistory(
      browserTarget,
      'blank-noopener-post-history-default-cache',
    ),
    postBackForwardNoOpenerNoCache: await capturePostHistory(
      browserTarget,
      'blank-noopener-post-history-no-cache',
    ),
    postBackForwardNoOpenerMaxAgeZeroMustRevalidate: await capturePostHistory(
      browserTarget,
      'blank-noopener-post-history-max-age-zero-must-revalidate',
    ),
    sameDocumentFragment: await captureNamedFragmentHistory(browserTarget),
  };
}

async function captureNamedContext(browserTarget) {
  const firstCase = fixture.cases.find((item) => item.id === 'named-target-opens-control-document');
  const secondCase = fixture.cases.find(
    (item) => item.id === 'named-target-reuses-context-for-app',
  );
  const { context, page: opener } = await newOpener(browserTarget);
  let namedCdp;
  const bfcacheNotUsed = [];
  const lifecycleEvents = [];
  try {
    await opener.locator(`#${firstCase.formId}-source`).fill(firstCase.sourceValue);
    await opener.locator(`#${secondCase.formId}-source`).fill(secondCase.sourceValue);
    const openerBefore = await sourceFormSnapshot(opener);
    const pagesBefore = context.pages().length;
    const childPromise = opener.waitForEvent('popup', { timeout: 10000 });
    await opener.locator(`#${firstCase.formId}`).locator('button[type="submit"]').click();
    const namedTarget = await childPromise;
    const observation = observePage(context, namedTarget);
    await namedTarget.waitForLoadState('domcontentloaded', { timeout: 20000 });
    await namedTarget.locator('#typed-form').waitFor();
    const childCreated = await namedChildFormSnapshot(namedTarget);
    await namedTarget.evaluate(() => {
      sessionStorage.setItem('oracle.tab-marker', 'named-tab-before-app');
      localStorage.setItem('oracle.shared-marker', 'set-by-named-child');
    });
    const scriptDefaultReset = await exerciseScriptModifiedReset(namedTarget);
    await fillNamedChildControls(namedTarget);
    const childFormBeforeApp = await namedChildFormSnapshot(namedTarget);
    const pagesBeforeReuse = context.pages().length;
    const childNavigationCountBeforeReuse = observation.navigations.length;

    namedCdp = await context.newCDPSession(namedTarget);
    namedCdp.on('Page.backForwardCacheNotUsed', (event) => bfcacheNotUsed.push(event));
    namedCdp.on('Page.lifecycleEvent', (event) => {
      if (['init', 'DOMContentLoaded', 'load', 'pageshow', 'pagehide'].includes(event.name))
        lifecycleEvents.push({
          name: event.name,
          frameId: event.frameId,
          loaderId: event.loaderId,
        });
    });
    await namedCdp.send('Page.enable');
    await namedCdp.send('Page.setLifecycleEventsEnabled', { enabled: true });

    await opener.locator(`#${secondCase.formId}`).locator('button[type="submit"]').click();
    await namedTarget.waitForURL(
      (url) => url.pathname === new URL(secondCase.actionPath, origin).pathname,
      { timeout: 20000 },
    );
    await bindApp(namedTarget);
    const namedAppInitial = await appSnapshot(namedTarget);
    const pageCountAfterReuse = context.pages().length;
    const childNavigationCountAfterReuse = observation.navigations.length;
    const reusedNamedTarget =
      context.pages().includes(namedTarget) && pageCountAfterReuse === pagesBeforeReuse;
    await namedTarget.evaluate(() =>
      sessionStorage.setItem('oracle.tab-marker', 'named-tab-in-app'),
    );
    await openSessionThroughWorkspace(
      namedTarget,
      'Second chat',
      fixture.appActions.namedTargetSession,
    );
    const namedAppAfterSession = await appSnapshot(namedTarget);

    const historyLengthBeforeBack = namedAppAfterSession.historyLength;
    await namedTarget.evaluate(() => history.back());
    await namedTarget.waitForURL((url) => url.pathname === fixture.capture.namedChildFormPath, {
      timeout: 15000,
    });
    await namedTarget.locator('#typed-form').waitFor();
    await namedTarget.waitForTimeout(100);
    const formBack = await namedChildFormSnapshot(namedTarget);
    const pageCountBeforeClose = context.pages().length;
    await namedCdp.detach();
    namedCdp = undefined;
    await namedTarget.close();
    const openerAfterClose = await sourceFormSnapshot(opener);
    const pageCountAfterClose = context.pages().length;

    return {
      caseId: 'named-target-reuse-and-form-back',
      targetCases: [firstCase.id, secondCase.id],
      openerBefore: openerBefore,
      pageCounts: {
        beforeTarget: pagesBefore,
        afterNamedTargetCreated: pagesBeforeReuse,
        afterSecondNamedSubmission: pageCountAfterReuse,
        beforeClose: pageCountBeforeClose,
        afterClose: pageCountAfterClose,
      },
      namedTarget: {
        name: fixture.capture.namedTarget,
        firstNavigation: childCreated,
        childFormBeforeApp,
        scriptDefaultReset,
        appNavigationUrl: namedAppInitial.documentStartUrl,
        documentResponses: observation.documentResponses,
        appAfterRoute: namedAppInitial,
        afterOpenSession: namedAppAfterSession,
        samePageReused: reusedNamedTarget,
        childNavigationsAddedBySecondSubmission:
          childNavigationCountAfterReuse - childNavigationCountBeforeReuse,
        navigations: observation.navigations,
        eventStreams: observation.eventStreams,
        sessionStorageAfterApp: namedAppAfterSession.storage.tabMarker,
      },
      formBack: {
        trigger: 'window.history.back() in the named target browsing context',
        historyLengthBeforeBack,
        returnedToSourceDocument:
          new URL(formBack.url).pathname === fixture.capture.namedChildFormPath,
        restoredState: formBack,
        returnedViaBackForwardCache: formBack.pageShows.some((event) => event.persisted),
        bfcacheNotUsed,
        lifecycleEvents,
      },
      closeReturnsToOpener: {
        openerStillOpen: pageCountAfterClose === 1,
        openerUrl: openerAfterClose.url,
        openerFormValues: openerAfterClose.fields,
        openerSessionStorage: openerAfterClose.storage.tabMarker,
      },
    };
  } finally {
    await namedCdp?.detach();
    await context.close();
  }
}
