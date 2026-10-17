import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const fixturePath = path.join(repositoryRoot, 'apps/android/integration_test/document_blob_navigation_fixture.dart');
const fixtureSource = readFileSync(fixturePath, 'utf8');
const htmlMatch = fixtureSource.match(/const blobNavigationHtml\s*=\s*r'''([\s\S]*?)''';/);
assert.ok(htmlMatch, 'Could not extract blobNavigationHtml from the shared fixture.');
const html = htmlMatch[1];
const expectedMatch = fixtureSource.match(/const blobNavigationExpectedJson\s*=\s*r'''([\s\S]*?)''';/);
assert.ok(expectedMatch, 'Could not extract blobNavigationExpectedJson.');
const expected = JSON.parse(expectedMatch[1]);
const coreExpectedMatch = fixtureSource.match(/const blobNavigationCoreExpectedJson\s*=\s*r'''([\s\S]*?)''';/);
assert.ok(coreExpectedMatch, 'Could not extract blobNavigationCoreExpectedJson.');
const coreExpected = JSON.parse(coreExpectedMatch[1]);
const baseCoreExpectedMatch = fixtureSource.match(/const blobNavigationBaseCoreExpectedJson\s*=\s*r'''([\s\S]*?)''';/);
assert.ok(baseCoreExpectedMatch, 'Could not extract blobNavigationBaseCoreExpectedJson.');
const baseCoreExpected = JSON.parse(baseCoreExpectedMatch[1]);
const browserExecutable = requireTestBrowserExecutable();
assert.ok(existsSync(browserExecutable), 'Missing Chrome executable: ' + browserExecutable);

const requests = [];
const unexpectedLocalRequests = [];
const blockedThirdPartyRequests = [];
const serverErrors = [];
const pageErrors = [];
let origin = '';
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
    requests.push({method: request.method, host: request.headers.host ?? '', path: url.pathname});
    if (request.method === 'GET' && url.pathname === '/fixture') {
      response.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
      response.end(html);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/absolute.txt') {
      response.writeHead(200, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
      response.end('ABSOLUTE_BLOB_FETCH_OK');
      return;
    }
    if (request.method === 'GET' && (url.pathname === '/relative.txt' || url.pathname === '/base/relative.txt')) {
      response.writeHead(200, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
      response.end(url.pathname === '/base/relative.txt' ? 'BASE_RELATIVE_FETCH_OK' : 'ROOT_RELATIVE_FETCH_OK');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    unexpectedLocalRequests.push({method: request.method, host: request.headers.host ?? '', path: url.pathname});
    response.writeHead(404, {'content-type': 'text/plain'});
    response.end('unexpected local request');
  })().catch(error => {
    serverErrors.push(String(error && error.stack || error));
    if (!response.headersSent) response.writeHead(500, {'content-type': 'text/plain'});
    response.end('local oracle error');
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
origin = 'http://127.0.0.1:' + address.port;
const browser = await chromium.launch({headless: true, executablePath: browserExecutable, args: ['--disable-gpu']});
const evidenceDirectory = path.join(repositoryRoot, 'apps/android/build/parity-acceptance/document-blob-navigation-20261015');
const evidencePath = path.join(evidenceDirectory, 'browser-oracle.json');

function guard(context) {
  context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'blob:' ||
        (url.protocol === 'http:' && url.port === String(address.port) &&
         (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))) {
      await route.continue();
    } else {
      blockedThirdPartyRequests.push(url.href);
      await route.abort();
    }
  });
}

async function preparedPage(context) {
  guard(context);
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin + '/fixture', {waitUntil: 'domcontentloaded'});
  await page.getByRole('button', {name: 'Prepare blob navigation links'}).click();
  await page.waitForFunction(() => (document.querySelector('#blob-navigation-result')?.textContent ?? '').startsWith('{'),
    undefined, {timeout: 10000});
  return page;
}

async function snapshot(page) {
  return page.evaluate(expectedOrigin => {
    const contentType = document.contentType;
    const bodyText = document.body && document.body.innerText || '';
    const base = new URL(document.baseURI);
    const isImage = contentType.startsWith('image/');
    const isPlain = contentType.startsWith('text/plain');
    const plainIsHtmlSource = isPlain && bodyText.startsWith('<!doctype html>');
    const referrer = document.referrer;
    return {
      urlScheme: location.protocol.slice(0, -1),
      originMatchesLoopback: location.origin === expectedOrigin,
      contentType,
      characterSet: document.characterSet,
      baseUriKind: base.protocol === 'blob:' ? 'blob' : base.protocol.slice(0, -1),
      baseHrefPath: base.protocol === 'blob:' ? null : base.pathname,
      referrerMatchesFixture: referrer === expectedOrigin + '/fixture',
      name: window.name,
      openerPresent: window.opener !== null,
      openerReadableSameOrigin: (() => { try { return window.opener ? window.opener.location.origin === expectedOrigin : null; } catch (_) { return false; } })(),
      title: isImage ? null : document.title,
      imageViewerTitleHasDimensions: isImage ? /\(1×1\)$/.test(document.title) : null,
      textPlain: isPlain && !plainIsHtmlSource ? bodyText : null,
      textPlainIsHtmlSource: isPlain ? plainIsHtmlSource : null,
      htmlUnicodeTextPresent: contentType.startsWith('text/html') || plainIsHtmlSource ? bodyText.includes('Blob child document 雪 café') : null,
      image: isImage ? {
        count: document.images.length,
        srcIsBlob: document.images.length ? new URL(document.images[0].src).protocol === 'blob:' : false,
        width: document.images.length ? document.images[0].naturalWidth : 0,
        height: document.images.length ? document.images[0].naturalHeight : 0,
      } : null,
    };
  }, origin);
}

async function runNavigation(linkId, target, isHtml, isOctetDownload) {
  const context = await browser.newContext({acceptDownloads: true});
  let result;
  try {
    const page = await preparedPage(context);
    const selector = '#' + linkId;
    const href = await page.locator(selector).getAttribute('href');
    assert.ok(href && href.startsWith('blob:'), 'Fixture link lacks blob URL: ' + selector);
    let destination = page;
    if (isOctetDownload) {
      const downloadPromise = page.waitForEvent('download', {timeout: 10000});
      await page.locator(selector).click();
      const download = await downloadPromise;
      result = {
        target,
        downloaded: true,
        suggestedFilenamePresent: download.suggestedFilename().length > 0,
        completed: (await download.failure()) === null,
      };
    } else if (target === 'self') {
      await Promise.all([
        page.waitForURL(url => url.protocol === 'blob:', {timeout: 10000}),
        page.locator(selector).click(),
      ]);
      result = {
        target,
        samePage: true,
        hrefScheme: new URL(href).protocol.slice(0, -1),
        snapshot: await snapshot(destination),
        coreResult: isHtml ? JSON.parse(await destination.locator('#blob-navigation-core-result').textContent()) : null,
        htmlResult: isHtml ? JSON.parse(await destination.locator('#blob-navigation-result').textContent()) : null,
      };
    } else {
      const pagePromise = context.waitForEvent('page', {timeout: 10000});
      await page.locator(selector).click();
      destination = await pagePromise;
      destination.on('pageerror', error => pageErrors.push(error.message));
      await destination.waitForLoadState('domcontentloaded', {timeout: 10000}).catch(() => {});
      if (isHtml) {
        await destination.waitForFunction(() => (document.querySelector('#blob-navigation-result')?.textContent ?? '').startsWith('{'),
          undefined, {timeout: 10000});
      }
      result = {
        target,
        samePage: false,
        hrefScheme: new URL(href).protocol.slice(0, -1),
        snapshot: await snapshot(destination),
        coreResult: isHtml ? JSON.parse(await destination.locator('#blob-navigation-core-result').textContent()) : null,
        htmlResult: isHtml ? JSON.parse(await destination.locator('#blob-navigation-result').textContent()) : null,
      };
    }
  } finally {
    await context.close();
  }
  return result;
}

try {
  const parentContext = await browser.newContext();
  const parentPage = await preparedPage(parentContext);
  const parentSetup = JSON.parse(await parentPage.locator('#blob-navigation-result').textContent());
  await parentContext.close();

  const navigations = {};
  for (const type of ['html', 'plain', 'image']) {
    navigations[type] = {};
    for (const target of ['self', 'blank', 'named']) {
      navigations[type][target] = await runNavigation(type + '-' + target, target, type === 'html', false);
    }
  }
  const mimeCases = {
    htmlNoCharset: await runNavigation('html-no-charset-self', 'self', true, false),
    htmlUtf8Charset: await runNavigation('html-charset-self', 'self', true, false),
    emptyMime: await runNavigation('empty-self', 'self', false, false),
    octetStream: await runNavigation('octet-self', 'self', false, true),
    plainUtf8Charset: await runNavigation('plain-charset-self', 'self', false, false),
  };

  const namedContext = await browser.newContext();
  const namedParent = await preparedPage(namedContext);
  const firstHref = await namedParent.locator('#html-named').getAttribute('href');
  const namedPagePromise = namedContext.waitForEvent('page', {timeout: 10000});
  await namedParent.locator('#html-named').click();
  const namedPage = await namedPagePromise;
  namedPage.on('pageerror', error => pageErrors.push(error.message));
  await namedPage.waitForFunction(() => (document.querySelector('#blob-navigation-result')?.textContent ?? '').startsWith('{'),
    undefined, {timeout: 10000});
  const firstNamedSnapshot = await snapshot(namedPage);
  const firstNamedResult = JSON.parse(await namedPage.locator('#blob-navigation-result').textContent());
  const firstNamedCoreResult = JSON.parse(await namedPage.locator('#blob-navigation-core-result').textContent());
  const secondHref = await namedParent.locator('#html-named-second').getAttribute('href');
  await namedParent.locator('#html-named-second').click();
  await namedPage.waitForURL(url => url.href === secondHref, {timeout: 10000});
  await namedPage.waitForFunction(() => (document.querySelector('#blob-navigation-result')?.textContent ?? '').startsWith('{'),
    undefined, {timeout: 10000});
  const secondNamedSnapshot = await snapshot(namedPage);
  const namedReuse = {
    first: firstNamedSnapshot,
    firstHtmlResult: firstNamedResult,
    firstCoreResult: firstNamedCoreResult,
    second: secondNamedSnapshot,
    secondCoreResult: JSON.parse(await namedPage.locator('#blob-navigation-core-result').textContent()),
    secondHtmlResult: JSON.parse(await namedPage.locator('#blob-navigation-result').textContent()),
    pageCount: namedContext.pages().length,
    sameWindowName: firstNamedSnapshot.name === secondNamedSnapshot.name,
  };
  await namedContext.close();

  const reloadContext = await browser.newContext();
  const reloadParent = await preparedPage(reloadContext);
  const reloadHref = await reloadParent.locator('#html-blank').getAttribute('href');
  const reloadPopupPromise = reloadContext.waitForEvent('page', {timeout: 10000});
  await reloadParent.locator('#html-blank').click();
  const reloadPopup = await reloadPopupPromise;
  reloadPopup.on('pageerror', error => pageErrors.push(error.message));
  await reloadPopup.waitForFunction(() => (document.querySelector('#blob-navigation-result')?.textContent ?? '').startsWith('{'),
    undefined, {timeout: 10000});
  const loadedBeforeRevoke = await snapshot(reloadPopup);
  await reloadParent.evaluate(url => URL.revokeObjectURL(url), reloadHref);
  const fetchAfterRevoke = await reloadParent.evaluate(async url => {
    try { const response = await fetch(url); return {ok: true, status: response.status}; }
    catch (error) { return {ok: false, errorName: error.name}; }
  }, reloadHref);
  let reloadError = null;
  try { await reloadPopup.reload({waitUntil: 'domcontentloaded', timeout: 5000}); }
  catch (error) { reloadError = error.message; }
  const afterReload = await snapshot(reloadPopup).catch(() => ({snapshotFailed: true}));
  const revokeReload = {
    loadedBeforeRevoke,
    fetchAfterRevoke,
    reloadError: reloadError && reloadError.includes('net::ERR_FILE_NOT_FOUND') ? 'net::ERR_FILE_NOT_FOUND' : reloadError !== null,
    afterReload,
  };
  await reloadContext.close();

  assert.deepEqual(blockedThirdPartyRequests, [], 'The oracle attempted a third-party request.');
  assert.deepEqual(unexpectedLocalRequests, [], 'The oracle attempted an unexpected loopback request.');
  assert.deepEqual(serverErrors, [], 'Loopback server reported an error.');
  assert.deepEqual(pageErrors, [], 'Blob child reported a page error.');
  const allowedPaths = new Set(['/fixture', '/absolute.txt', '/relative.txt', '/base/relative.txt', '/favicon.ico']);
  assert.ok(requests.every(item => allowedPaths.has(item.path)), 'Only fixture and fetch loopback routes are allowed.');

  const observed = {parentSetup, navigations, mimeCases, namedReuse, revokeReload};
  assert.deepEqual(navigations.html.self.coreResult, coreExpected, 'Common HTML blob core differs from Chrome fixture expectation.');
  assert.deepEqual(namedReuse.secondCoreResult, baseCoreExpected, 'Base href HTML blob core differs from Chrome fixture expectation.');
  let assertions = 'PASS: Chrome common-core expectations match; full observation captured for freeze';
  if (Object.keys(expected).length > 0) {
    assert.deepEqual(observed, expected, 'Chrome observation differs from shared expected JSON.');
    assertions = 'PASS: Chrome core and full observed JSON match shared expectations';
  }
  const evidence = {
    browser: 'Google Chrome ' + browser.version(),
    date: '2026-10-15',
    origin: 'loopback HTTP',
    network: {allowedRequests: requests.map(item => ({method: item.method, path: item.path})), unexpectedLocalRequests, blockedThirdPartyRequests},
    assertions,
    expected,
    observed,
    pageErrors,
    serverErrors,
  };
  await mkdir(evidenceDirectory, {recursive: true});
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({assertions, browser: evidence.browser, evidencePath,
    htmlSelf: navigations.html.self.htmlResult,
    htmlBase: namedReuse.secondHtmlResult,
    mimeCases,
    revokeReload,
    coreExpected,
    baseCoreExpected,
  }));
} catch (error) {
  serverErrors.push(String(error && error.stack || error));
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
