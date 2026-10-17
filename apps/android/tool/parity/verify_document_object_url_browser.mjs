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
const fixturePath = path.join(repositoryRoot, 'apps/android/integration_test/document_object_url_fixture.dart');
const fixtureSource = readFileSync(fixturePath, 'utf8');
const htmlMatch = fixtureSource.match(/const objectUrlHtml\s*=\s*r'''([\s\S]*?)''';/);
assert.ok(htmlMatch, 'Could not extract objectUrlHtml from the shared fixture.');
const html = htmlMatch[1];
const expectedMatch = fixtureSource.match(/const objectUrlExpectedJson\s*=\s*r'''([\s\S]*?)''';/);
assert.ok(expectedMatch, 'Could not extract objectUrlExpectedJson.');
const expected = JSON.parse(expectedMatch[1]);
const browserExecutable = requireTestBrowserExecutable();
assert.ok(existsSync(browserExecutable), 'Missing Chrome executable: ' + browserExecutable);

const requests = [];
const unexpectedLocalRequests = [];
const blockedThirdPartyRequests = [];
const serverErrors = [];
let origin = '';
const server = createServer((request, response) => {
  void (async () => {
    const requestUrl = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
    requests.push({method: request.method, host: request.headers.host ?? '', path: requestUrl.pathname});
    if (request.method === 'GET' && requestUrl.pathname === '/fixture') {
      response.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
      response.end(html);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/foreign') {
      const blobUrl = JSON.stringify(requestUrl.searchParams.get('blob'));
      response.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
      response.end('<!doctype html><script>(async()=>{try{const r=await fetch(' + blobUrl +
        ');const b=await r.arrayBuffer();parent.postMessage({kind:"foreign-blob-fetch",ok:true,status:r.status,url:r.url,bodyLength:b.byteLength},"*")}' +
        'catch(e){parent.postMessage({kind:"foreign-blob-fetch",ok:false,errorName:e.name},"*")}})()</script>');
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/scope-child') {
      response.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
      response.end('<!doctype html><meta charset="utf-8"><title>same-origin object URL child</title>');
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    unexpectedLocalRequests.push({method: request.method, host: request.headers.host ?? '', path: requestUrl.pathname});
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
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
  args: ['--disable-gpu'],
});

const evidenceDirectory = path.join(
  repositoryRoot,
  'apps/android/build/parity-acceptance/document-object-url-20261015',
);
const evidencePath = path.join(evidenceDirectory, 'browser-oracle.json');

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.protocol === 'blob:' ||
        (requestUrl.protocol === 'http:' && requestUrl.port === String(address.port) &&
         (requestUrl.hostname === '127.0.0.1' || requestUrl.hostname === 'localhost'))) {
      await route.continue();
    } else {
      blockedThirdPartyRequests.push(requestUrl.href);
      await route.abort();
    }
  });
  await page.goto(origin + '/fixture', {waitUntil: 'domcontentloaded'});
  await page.getByRole('button', {name: 'Create blob previews'}).click();
  await page.waitForFunction(() => (document.querySelector('#object-url-result')?.textContent ?? '').startsWith('{'),
    undefined, {timeout: 15000});
  const observed = JSON.parse(await page.locator('#object-url-result').textContent());

  const scope = await page.evaluate(async () => {
    const fetchText = async target => {
      try { const response = await fetch(target); return {ok: true, status: response.status, text: await response.text()}; }
      catch (error) { return {ok: false, errorName: error.name}; }
    };
    const iframe = document.createElement('iframe');
    iframe.src = '/scope-child';
    document.body.append(iframe);
    await new Promise(resolve => { iframe.onload = resolve; });
    const parentUrl = URL.createObjectURL(new Blob(['from-parent'], {type: 'text/plain'}));
    const childFetchesParent = await iframe.contentWindow.fetch(parentUrl).then(async response => ({
      ok: true, status: response.status, responseUrlMatches: response.url === parentUrl,
      text: await response.text()
    }), error => ({ok: false, errorName: error.name}));
    const childUrl = iframe.contentWindow.URL.createObjectURL(
      new iframe.contentWindow.Blob(['from-child'], {type: 'text/plain'}),
    );
    const parentFetchesChild = await fetch(childUrl).then(async response => ({
      ok: true, status: response.status, responseUrlMatches: response.url === childUrl,
      text: await response.text()
    }), error => ({ok: false, errorName: error.name}));
    iframe.contentWindow.URL.revokeObjectURL(childUrl);
    const parentAfterChildRevokes = await fetchText(childUrl);
    iframe.contentWindow.URL.revokeObjectURL(parentUrl);
    const parentAfterChildRevokesParentUrl = await fetchText(parentUrl);

    const foreignFrame = document.createElement('iframe');
    const foreignResultPromise = new Promise(resolve => {
      const listener = event => {
        if (event.source !== foreignFrame.contentWindow || !event.data || event.data.kind !== 'foreign-blob-fetch') return;
        window.removeEventListener('message', listener);
        resolve(event.data);
      };
      window.addEventListener('message', listener);
    });
    const foreignUrl = new URL(location.href);
    foreignUrl.hostname = 'localhost';
    foreignUrl.pathname = '/foreign';
    foreignUrl.search = '';
    const foreignBlobUrl = URL.createObjectURL(new Blob(['cross-origin'], {type: 'text/plain'}));
    foreignUrl.searchParams.set('blob', foreignBlobUrl);
    foreignFrame.src = foreignUrl.href;
    document.body.append(foreignFrame);
    const foreignFetch = await Promise.race([
      foreignResultPromise,
      new Promise(resolve => setTimeout(() => resolve({timeout: true}), 2000)),
    ]);
    URL.revokeObjectURL(foreignBlobUrl);
    return {
      sameOrigin: {
        childFetchesParent,
        parentFetchesChild,
        parentAfterChildRevokes,
        parentAfterChildRevokesParentUrl,
      },
      crossOrigin: foreignFetch,
    };
  });

  assert.deepEqual(pageErrors, [], 'Fixture reported browser page errors.');
  assert.deepEqual(blockedThirdPartyRequests, [], 'Fixture attempted a third-party request.');
  assert.deepEqual(unexpectedLocalRequests, [], 'Fixture attempted an unexpected loopback request.');
  const allowedPaths = new Set(['/fixture', '/scope-child', '/foreign', '/favicon.ico']);
  assert.ok(requests.every(item => allowedPaths.has(item.path)), 'Only known loopback fixture routes are allowed.');

  let assertions = 'captured for expected fixture freeze';
  if (Object.keys(expected).length > 0) {
    assert.deepEqual(observed, expected, 'Chrome observation differs from frozen shared expected JSON.');
    assertions = 'PASS: Chrome observed JSON exactly matches shared expected JSON';
  }
  assert.equal(scope.sameOrigin.childFetchesParent.ok, true);
  assert.equal(scope.sameOrigin.parentFetchesChild.ok, true);
  assert.equal(scope.sameOrigin.parentAfterChildRevokes.ok, false);
  assert.equal(scope.sameOrigin.parentAfterChildRevokesParentUrl.ok, false);
  assert.equal(scope.crossOrigin.ok, false);

  const evidence = {
    browser: 'Google Chrome ' + browser.version(),
    date: '2026-10-15',
    origin,
    network: {allowedRequests: requests, unexpectedLocalRequests, blockedThirdPartyRequests},
    png: {mimeType: 'image/png', byteLength: 70, redPixelRgba: [255, 0, 0, 255]},
    imageApiCoverage: {
      tested: ['img.src blob URL identity', "img.getAttribute('src') identity"],
      unsupportedInNativeRuntime: [
        'Image constructor',
        'HTMLImageElement complete/naturalWidth/naturalHeight/load/error',
        'CanvasRenderingContext2D.drawImage/getImageData',
      ],
      fullChromeLifecycleEvidence: 'browser-image-lifecycle-oracle.json',
    },
    assertions,
    expected,
    observed,
    scope,
    pageErrors,
    serverErrors,
  };
  await mkdir(evidenceDirectory, {recursive: true});
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({assertions, evidencePath, browser: evidence.browser,
    scope: 'same-origin registry shared; foreign-origin fetch rejected'}));
} catch (error) {
  serverErrors.push(String(error && error.stack || error));
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

async function fetchText(target) {
  try {
    const response = await fetch(target);
    return {ok: true, status: response.status, text: await response.text()};
  } catch (error) {
    return {ok: false, errorName: error.name};
  }
}
