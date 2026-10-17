import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const require = createRequire(import.meta.url);
const {chromium} = require(require.resolve('playwright-core', {
  paths: [path.join(repositoryRoot, 'apps/gateway')],
}));
const fixturePath = path.join(
  repositoryRoot,
  'apps/android/integration_test/document_anchor_activation_fixture.dart',
);
const fixtureSource = readFileSync(fixturePath, 'utf8');
const fixtureMatch = fixtureSource.match(
  /const documentAnchorActivationFixture\s*=\s*r'''([\s\S]*?)''';/,
);
assert.ok(fixtureMatch, 'Could not extract documentAnchorActivationFixture.');
const fixtureHtml = fixtureMatch[1];
const sourceHash = source => createHash('sha256').update(source).digest('hex');
const fixtureSha256 = sourceHash(fixtureSource);
const runnerSha256 = sourceHash(readFileSync(fileURLToPath(import.meta.url)));
const browserExecutable = [
  requireTestBrowserExecutable(),
  chromium.executablePath(),
].find(existsSync);
assert.ok(browserExecutable, 'No local Chrome or Chromium executable was found.');

const serverDownloadBytes = Buffer.from('SERVER_ANCHOR_BYTES_雪_OK', 'utf8');
const requests = [];
let origin = '';
const destinationHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Anchor destination</title></head><body>
<pre id="destination-result"></pre>
<script>
(function() {
  var raw = null;
  try { raw = sessionStorage.getItem('document-anchor-activation-result'); } catch (_) {}
  var parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch (_) {}
  var observation = {
    url: location.href,
    referrer: document.referrer,
    openerPresent: window.opener !== null,
    openerReadableSameOrigin: (function() {
      try { return window.opener ? window.opener.location.origin === location.origin : null; }
      catch (_) { return false; }
    })(),
    eventResult: parsed
  };
  window.documentAnchorDestinationObservation = observation;
  document.querySelector('#destination-result').textContent = JSON.stringify(observation);
})();
</script></body></html>`;

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
  requests.push({
    method: request.method ?? '',
    path: requestUrl.pathname,
    query: requestUrl.search,
    referer: request.headers.referer ?? '',
    secFetchDest: request.headers['sec-fetch-dest'] ?? '',
    secFetchMode: request.headers['sec-fetch-mode'] ?? '',
    secFetchSite: request.headers['sec-fetch-site'] ?? '',
  });
  if (request.method === 'GET' && requestUrl.pathname === '/fixture') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(fixtureHtml);
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname.startsWith('/destination/')) {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(destinationHtml);
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/download/server-bytes.txt') {
    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(serverDownloadBytes);
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
  response.end('unknown local oracle path');
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
origin = 'http://127.0.0.1:' + address.port;
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
  args: ['--disable-gpu'],
  // Playwright disables popup blocking by default; retain Chrome's normal policy.
  ignoreDefaultArgs: ['--disable-popup-blocking'],
});

const blockedRequests = [];
const caseIds = [
  'detached-click',
  'connected-click',
  'child-click',
  'mouse-dispatch',
  'plain-event-dispatch',
  'prevent-default',
  'mutate-href',
  'add-href-in-listener',
  'remove-href-in-listener',
  'mutate-target',
  'mutate-download',
  'remove-anchor',
  'target-blank-default',
  'base-target',
  'rel-noopener',
  'rel-noreferrer',
  'referrerpolicy',
  'data-download',
  'blob-download',
  'blob-download-revoke',
  'gesture-popup',
  'startup-popup',
  'timer-popup',
];
const samePageNavigationCases = new Set([
  'detached-click',
  'connected-click',
  'child-click',
  'mouse-dispatch',
  'mutate-href',
  'add-href-in-listener',
  'remove-anchor',
]);
const popupCases = new Set([
  'mutate-target',
  'target-blank-default',
  'base-target',
  'rel-noopener',
  'rel-noreferrer',
  'referrerpolicy',
  'gesture-popup',
  'startup-popup',
  'timer-popup',
]);
const downloadCases = new Set([
  'mutate-download',
  'data-download',
  'blob-download',
  'blob-download-revoke',
]);

function guard(context) {
  context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'blob:' || url.protocol === 'data:' ||
        (url.protocol === 'http:' && url.port === String(address.port) &&
         (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))) {
      await route.continue();
    } else {
      blockedRequests.push({url: url.href, caseId: route.request().frame()?.url() ?? ''});
      await route.abort();
    }
  });
}

async function waitForPopup(context, parentPage, contextPages) {
  const existing = contextPages.find(candidate => candidate !== parentPage);
  if (existing) return existing;
  return new Promise(resolve => {
    const onPage = candidate => {
      if (candidate === parentPage) return;
      clearTimeout(timer);
      context.off('page', onPage);
      resolve(candidate);
    };
    const timer = setTimeout(() => {
      context.off('page', onPage);
      resolve(null);
    }, 2200);
    context.on('page', onPage);
  });
}

async function snapshotPage(page) {
  if (!page || page.isClosed()) return null;
  try {
    return await page.evaluate(() => ({
      url: location.href,
      referrer: document.referrer,
      openerPresent: window.opener !== null,
      openerReadableSameOrigin: (() => {
        try { return window.opener ? window.opener.location.origin === location.origin : null; }
        catch (_) { return false; }
      })(),
      destinationObservation: window.documentAnchorDestinationObservation ?? null,
      resultText: document.querySelector('#result')?.textContent ?? null,
      resultFromSessionStorage: (() => {
        try {
          const raw = sessionStorage.getItem('document-anchor-activation-result');
          return raw ? JSON.parse(raw) : null;
        } catch (_) { return null; }
      })(),
    }));
  } catch (error) {
    return {snapshotError: String(error)};
  }
}

async function runCase(caseId) {
  const serverRequestStart = requests.length;
  const context = await browser.newContext({acceptDownloads: true});
  guard(context);
  const pageErrors = [];
  let page = await context.newPage();
  const contextPages = [page];
  context.on('page', popup => {
    if (popup === page) return;
    popup.on('pageerror', error => pageErrors.push(error.message));
    contextPages.push(popup);
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__recordAnchorOracleResult = result => {
      try {
        sessionStorage.setItem('document-anchor-activation-result', JSON.stringify(result));
      } catch (_) {}
    };
  });
  const downloadPromise = downloadCases.has(caseId)
    ? page.waitForEvent('download', {timeout: 10000}).catch(() => null)
    : null;

  try {
    await page.goto(origin + '/fixture?case=' + encodeURIComponent(caseId), {
      waitUntil: 'domcontentloaded',
    });
    if (caseId !== 'startup-popup' && caseId !== 'timer-popup') {
      await page.locator('[data-case="' + caseId + '"]').click();
    }

    let popup = null;
    let download = null;
    if (popupCases.has(caseId)) {
      popup = await waitForPopup(context, page, contextPages);
      if (popup && !popup.isClosed()) {
        await popup.waitForLoadState('domcontentloaded', {timeout: 5000}).catch(() => {});
        await popup.waitForTimeout(100);
      }
    }
    if (downloadPromise) download = await downloadPromise;
    if (samePageNavigationCases.has(caseId)) {
      await page.waitForURL(url => url.pathname.startsWith('/destination/'), {timeout: 8000}).catch(() => {});
      await page.waitForTimeout(100);
    }
    if (caseId === 'startup-popup' || caseId === 'timer-popup') {
      // Give a parser-startup or zero-delay timer action a chance to reach Chrome's popup policy.
      if (!popup) popup = await waitForPopup(context, page, contextPages);
      if (popup && !popup.isClosed()) {
        await popup.waitForLoadState('domcontentloaded', {timeout: 5000}).catch(() => {});
        await popup.waitForTimeout(100);
      }
    }
    if (caseId === 'detached-click' || caseId === 'prevent-default') {
      await page.waitForTimeout(120);
    }

    if (popupCases.has(caseId) && !popup) {
      // The timeout above distinguishes blocked/no-popup cases from real child pages.
    }

    let downloadObservation = null;
    if (download) {
      const failed = await download.failure();
      const downloadPath = failed ? null : await download.path();
      const bytes = downloadPath ? await readFile(downloadPath) : null;
      downloadObservation = {
        suggestedFilename: download.suggestedFilename(),
        failure: failed,
        completed: failed === null && bytes !== null,
        byteLength: bytes?.length ?? null,
        utf8Text: bytes ? bytes.toString('utf8') : null,
        sha256: bytes ? sourceHash(bytes) : null,
      };
    }

    const pageSnapshots = [];
    for (const candidate of [page, ...contextPages]) {
      if (candidate && !candidate.isClosed()) pageSnapshots.push(await snapshotPage(candidate));
    }
    let eventResult = null;
    for (const item of pageSnapshots) {
      eventResult = item?.destinationObservation?.eventResult ??
          item?.resultFromSessionStorage ?? null;
      if (eventResult) break;
    }
    if (!eventResult && page && !page.isClosed()) {
      try {
        eventResult = await page.evaluate(() => window.documentAnchorActivationResult ?? null);
      } catch (_) {}
    }
    if (!eventResult) eventResult = apiReturn;

    const caseRequests = requests.slice(serverRequestStart);
    const caseResult = {
      caseId,
      invocation: caseId === 'startup-popup' ? 'parser-startup' :
        caseId === 'timer-popup' ? 'timer' : 'trusted-visible-button',
      eventResult,
      currentPage: await snapshotPage(page),
      popups: await Promise.all(contextPages.filter(candidate => candidate !== page)
        .map(snapshotPage)),
      download: downloadObservation,
      requests: caseRequests,
      pageErrors,
    };
    return caseResult;
  } finally {
    await context.close();
  }
}

try {
  const results = [];
  for (const caseId of caseIds) {
    results.push(await runCase(caseId));
  }

  const byId = Object.fromEntries(results.map(item => [item.caseId, item]));
  assert.equal(byId['detached-click'].eventResult?.event?.event?.isTrusted, false,
    'HTMLElement.click() should expose an untrusted click event.');
  assert.ok(byId['detached-click'].requests.some(item => item.path === '/destination/detached-click'),
    'Chrome should record whether the detached anchor default action navigates.');
  assert.equal(byId['plain-event-dispatch'].requests.some(item => item.path.startsWith('/destination/')), false,
    'Dispatching a plain Event should not perform hyperlink activation.');
  assert.equal(byId['prevent-default'].requests.some(item => item.path.startsWith('/destination/')), false,
    'preventDefault should suppress the anchor default action.');
  assert.equal(byId['remove-href-in-listener'].requests.some(item => item.path.startsWith('/destination/')), false,
    'Removing href during the click listener should suppress hyperlink activation.');
  assert.equal(byId['mutate-download'].download?.completed, true,
    'The listener-mutated same-origin download should complete.');
  assert.equal(byId['mutate-download'].download?.utf8Text, serverDownloadBytes.toString('utf8'));
  assert.equal(byId['data-download'].download?.completed, true,
    'The data URL download should complete.');
  assert.equal(byId['blob-download'].download?.completed, true,
    'The Blob URL download should complete.');
  assert.equal(byId['blob-download'].download?.utf8Text, 'ANCHOR_BLOB_SNOW_✅');
  assert.equal(byId['blob-download-revoke'].download?.completed, true,
    'The Blob URL download should survive immediate URL.revokeObjectURL after click().');
  assert.equal(byId['blob-download-revoke'].download?.utf8Text, 'ANCHOR_BLOB_SNOW_✅');
  for (const caseId of caseIds.filter(id => id !== 'startup-popup' && id !== 'timer-popup')) {
    assert.equal(byId[caseId].eventResult?.triggerEvents?.[0]?.isTrusted, true,
      `${caseId} must be run through the fixture's trusted visible button.`);
  }
  assert.deepEqual(blockedRequests, [], 'No request should escape the local oracle origin.');
  assert.deepEqual(results.flatMap(item => item.pageErrors), []);

  const knownDifferences = [
    'Chrome navigation requests include their actual Referer header; the mobile native HTTP transport currently does not emit Referer metadata.',
  ];
  const evidence = {
    oracle: 'Local Google Chrome through Playwright Core; loopback server only',
    browserVersion: browser.version(),
    browserExecutable,
    checkedAt: new Date().toISOString(),
    fixture: 'apps/android/integration_test/document_anchor_activation_fixture.dart#documentAnchorActivationFixture',
    fixtureSha256,
    runner: 'apps/android/tool/parity/verify_document_anchor_activation_browser.mjs',
    runnerSha256,
    loopbackOrigin: origin,
    cases: results,
    serverRequests: requests,
    serverDownload: {
      byteLength: serverDownloadBytes.length,
      utf8Text: serverDownloadBytes.toString('utf8'),
      sha256: sourceHash(serverDownloadBytes),
    },
    blockedRequests,
    knownDifferences,
  };
  const evidenceDirectory = path.join(
    repositoryRoot,
    'apps/android/build/parity-acceptance/document-anchor-activation-20261016',
  );
  await mkdir(evidenceDirectory, {recursive: true});
  const evidencePath = path.join(evidenceDirectory, 'browser-oracle.json');
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify({
    browserVersion: browser.version(),
    caseCount: results.length,
    evidencePath,
    fixtureSha256,
    runnerSha256,
    cases: results.map(item => ({
      caseId: item.caseId,
      url: item.currentPage?.url,
      popupCount: item.popups.length,
      download: item.download?.suggestedFilename ?? null,
      requestPaths: item.requests.map(request => request.path),
      referers: item.requests.map(request => request.referer),
      eventTrusted: item.eventResult?.event?.event?.isTrusted ?? null,
      triggerTrusted: item.eventResult?.triggerEvents?.[0]?.isTrusted ?? null,
    })),
  }, null, 2) + '\n');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
