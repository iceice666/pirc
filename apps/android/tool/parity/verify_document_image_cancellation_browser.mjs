import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../../..');
const fixturePath = 'apps/android/integration_test/document_image_cancellation_fixture.dart';
const fixtureSource = readFileSync(path.join(root, fixturePath), 'utf8');
const htmlMatch = fixtureSource.match(
  /const String documentImageCancellationFixture = r'''([\s\S]*?)''';/,
);
const pngMatch = fixtureSource.match(
  /const String documentImageCancellationPngBase64 =\s*'([^']+)'/,
);
assert.ok(htmlMatch, 'Extract the shared raw Dart HTML fixture');
assert.ok(pngMatch, 'Extract the shared 2x2 PNG bytes');
const fixture = htmlMatch[1];
const png = Buffer.from(pngMatch[1], 'base64');
assert.ok(png.length <= 2 * 1024 * 1024);

const require = createRequire(import.meta.url);
const {chromium} = require(
  require.resolve('playwright-core', {paths: [path.join(root, 'apps/gateway')]}),
);

const expectedSlowPaths = new Set([
  '/slow-image-replace.png',
  ...Array.from({length: 6}, (_, index) => `/slow-image-${index}.png`),
  '/slow-image-owner.png',
  '/slow-image-other.png',
  '/slow-image-policy.png',
  '/slow-image-policy-next.png',
  '/slow-image-same.png',
  '/probe-referrer-policy.png',
  '/probe-same-relative-absolute.png',
  '/probe-remove-attribute.png',
  '/probe-empty-source.png',
]);
const requests = [];
const closed = [];
const held = new Map();
const unexpected = [];
const externalRequests = [];
const pageErrors = [];
let origin = '';

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const entry = {
    path: url.pathname + url.search,
    method: request.method,
    referer: request.headers.referer ?? null,
    originHeader: request.headers.origin ?? null,
    fetchMode: request.headers['sec-fetch-mode'] ?? null,
  };
  requests.push(entry);
  response.on('close', () => {
    if (!response.writableEnded) closed.push(entry.path);
  });

  if (url.pathname === '/fixture') {
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    response.end(fixture);
  } else if (url.pathname === '/probe') {
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    response.end('<!doctype html><html><body></body></html>');
  } else if (url.pathname.startsWith('/slow-image-') || url.pathname.startsWith('/probe-')) {
    if (!expectedSlowPaths.has(url.pathname)) unexpected.push(entry.path);
    const list = held.get(url.pathname) ?? [];
    list.push({response, entry});
    held.set(url.pathname, list);
  } else if (url.pathname === '/image-ok.png') {
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': png.length,
      'cache-control': 'no-store',
    });
    response.end(png);
  } else if (url.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
  } else {
    unexpected.push(entry.path);
    response.writeHead(404);
    response.end();
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitUntil(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(`Timed out: ${message}`);
}
async function waitForRequest(pathname, count = 1) {
  await waitUntil(
    () => requests.filter(request => request.path.split('?')[0] === pathname).length >= count,
    `${count} request(s) to ${pathname}`,
  );
}
async function waitForClose(pathname, count = 1) {
  await waitUntil(
    () => closed.filter(path => path.split('?')[0] === pathname).length >= count,
    `${count} client close(s) for ${pathname}`,
  );
}
function replyHeld(pathname) {
  const pending = held.get(pathname) ?? [];
  const active = pending.find(({response}) => !response.destroyed && !response.writableEnded);
  assert.ok(active, `No live held response for ${pathname}`);
  active.response.writeHead(200, {
    'content-type': 'image/png',
    'content-length': png.length,
    'cache-control': 'no-store',
  });
  active.response.end(png);
}
function listenForPage(page) {
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('request', request => {
    const url = new URL(request.url());
    const entry = {url: request.url(), method: request.method(), resourceType: request.resourceType()};
    if (url.origin !== origin) externalRequests.push(entry);
  });
}
async function readState(page) {
  return JSON.parse(await page.locator('#result').textContent());
}
async function waitForState(page, predicate, message) {
  await waitUntil(async () => predicate(await readState(page)), message);
}

const browser = await chromium.launch({
  headless: true,
  executablePath: requireTestBrowserExecutable(),
  args: ['--disable-background-networking'],
});
const networkRequests = [];
const cases = {};
const mutationProbe = {};
let page;
let probePage;

try {
  const browserVersion = await browser.version();
  assert.match(browserVersion, /^155\./, 'The requested Chrome 155 oracle is installed');

  page = await browser.newPage({viewport: {width: 390, height: 844}});
  listenForPage(page);
  page.on('request', request => networkRequests.push(request.url()));
  await page.goto(`${origin}/fixture`, {waitUntil: 'domcontentloaded'});

  await page.locator('#replace-start').click();
  await waitForRequest('/slow-image-replace.png');
  await page.locator('#replace-fast').click();
  await waitForState(
    page,
    state => state.replacement.newLoad && state.replacement.oldDecode === 'rejected:EncodingError',
    'same Image object must reject the old decode and load its replacement',
  );
  await waitForClose('/slow-image-replace.png');
  let state = await readState(page);
  assert.equal(state.replacement.newDecode, 'resolved');
  assert.equal(state.replacement.newError, 0);
  assert.equal(state.replacement.staleLoads, 0);
  assert.equal(state.replacement.naturalWidth, 2);
  assert.equal(state.replacement.naturalHeight, 2);
  assert.match(state.replacement.currentSrc, /\/image-ok\.png\?replace=1$/);
  cases.replacement = {
    oldDecode: state.replacement.oldDecode,
    newDecode: state.replacement.newDecode,
    newLoad: state.replacement.newLoad,
    newError: state.replacement.newError,
    staleLoads: state.replacement.staleLoads,
    currentSrc: state.replacement.currentSrc,
    naturalWidth: state.replacement.naturalWidth,
    naturalHeight: state.replacement.naturalHeight,
    oldRequestClosed: closed.includes('/slow-image-replace.png'),
  };

  await page.locator('#six-start').click();
  for (let index = 0; index < 6; index++) await waitForRequest(`/slow-image-${index}.png`);
  await page.locator('#six-cancel').click();
  await waitForState(
    page,
    value => value.six.loaded === 6 && value.six.oldDecodeRejected === 6,
    'all six replacement images and all six old decode rejections',
  );
  for (let index = 0; index < 6; index++) await waitForClose(`/slow-image-${index}.png`);
  state = await readState(page);
  assert.equal(state.six.errorCount, 0);
  assert.equal(state.canvas.drawn, true);
  assert.equal(state.canvas.sourceIndex, 0);
  assert.equal(state.canvas.width, 2);
  assert.equal(state.canvas.height, 2);
  const canvasPixel = await page.evaluate(() => {
    const context = document.getElementById('image-cancellation-canvas').getContext('2d');
    return {
      inside: Array.from(context.getImageData(3, 3, 1, 1).data),
      outside: Array.from(context.getImageData(0, 0, 1, 1).data),
    };
  });
  assert.deepEqual(canvasPixel.inside, [37, 181, 92, 255]);
  assert.deepEqual(canvasPixel.outside, [17, 34, 51, 255]);
  cases.six = {
    loaded: state.six.loaded,
    oldDecodeRejected: state.six.oldDecodeRejected,
    errorCount: state.six.errorCount,
    closed: closed.filter(path => /^\/slow-image-[0-5]\.png$/.test(path)),
    canvas: state.canvas,
    canvasPixel,
  };

  await page.locator('#seventh-load').click();
  await waitForState(page, value => value.seventh.loaded, 'the seventh image after cancelling six');
  state = await readState(page);
  assert.equal(state.seventh.error, '');
  assert.match(state.seventh.currentSrc, /\/image-ok\.png\?seventh=1$/);
  cases.seventh = {...state.seventh};

  await page.locator('#consumer-start').click();
  await waitForRequest('/slow-image-owner.png');
  await waitForRequest('/slow-image-other.png');
  await page.locator('#consumer-replace').click();
  await waitForState(
    page,
    value => value.consumer.ownerLoaded && value.consumer.ownerOldDecode === 'rejected:EncodingError',
    'replacing one image consumer',
  );
  await waitForClose('/slow-image-owner.png');
  const otherConsumerStillHeld =
    !closed.includes('/slow-image-other.png') &&
    (held.get('/slow-image-other.png') ?? []).some(({response}) => !response.destroyed && !response.writableEnded);
  assert.equal(otherConsumerStillHeld, true, 'replacing one image must not cancel another consumer');
  replyHeld('/slow-image-other.png');
  await waitForState(page, value => value.consumer.otherLoaded, 'the other image consumer after release');
  state = await readState(page);
  assert.equal(state.consumer.otherError, '');
  cases.consumer = {
    ownerOldDecode: state.consumer.ownerOldDecode,
    ownerLoaded: state.consumer.ownerLoaded,
    otherLoaded: state.consumer.otherLoaded,
    otherError: state.consumer.otherError,
    otherCurrentSrc: state.consumer.otherCurrentSrc,
    otherStayedOpenUntilReleased: otherConsumerStillHeld,
  };

  await page.locator('#policy-start').click();
  await waitForRequest('/slow-image-policy.png');
  await page.locator('#policy-update').click();
  await waitForState(page, value => value.policy.updated, 'the pending image referrerPolicy update');
  await delay(250);
  const policyOnlyRequests = requests.filter(request => request.path.split('?')[0] === '/slow-image-policy.png').length;
  const policyOnlyStillOpen = !closed.includes('/slow-image-policy.png');
  assert.equal(policyOnlyRequests, 1);
  assert.equal(policyOnlyStillOpen, true);
  await page.locator('#policy-next').click();
  await waitForRequest('/slow-image-policy-next.png');
  await waitForClose('/slow-image-policy.png');
  const nextPolicyRequest = requests.find(request => request.path === '/slow-image-policy-next.png');
  assert.ok(nextPolicyRequest);
  assert.equal(nextPolicyRequest.referer, null, 'the next source uses no-referrer after policy mutation');
  cases.referrerPolicy = {
    pendingRequestCountAfterPolicyOnlyChange: policyOnlyRequests,
    pendingRequestStayedOpen: policyOnlyStillOpen,
    nextSourceRequest: nextPolicyRequest,
    oldRequestClosedOnSourceChange: closed.includes('/slow-image-policy.png'),
  };

  await page.locator('#same-start').click();
  await waitForRequest('/slow-image-same.png');
  await page.locator('#same-reset').click();
  await waitForState(page, value => value.sameSrc.reset, 'the pending relative-to-absolute same-src setter');
  await delay(250);
  const sameSourceRequestCount = requests.filter(request => request.path.split('?')[0] === '/slow-image-same.png').length;
  const sameSourceStillOpen = !closed.includes('/slow-image-same.png');
  assert.equal(sameSourceRequestCount, 1);
  assert.equal(sameSourceStillOpen, true);
  assert.equal((await readState(page)).sameSrc.decode, 'pending');
  replyHeld('/slow-image-same.png');
  await waitForState(
    page,
    value => value.sameSrc.loaded && value.sameSrc.decode === 'resolved',
    'the unchanged pending image after its held response is released',
  );
  state = await readState(page);
  cases.sameResolvedSource = {
    requestCountAfterPropertyReset: sameSourceRequestCount,
    requestStayedOpen: sameSourceStillOpen,
    decodedAfterRelease: state.sameSrc.decode,
    loadAfterRelease: state.sameSrc.loaded,
    currentSrc: state.sameSrc.currentSrc,
    naturalWidth: state.sameSrc.naturalWidth,
    naturalHeight: state.sameSrc.naturalHeight,
  };

  probePage = await browser.newPage();
  listenForPage(probePage);
  const probeFailures = [];
  probePage.on('requestfailed', request => {
    probeFailures.push({url: request.url(), error: request.failure()?.errorText ?? null});
  });
  await probePage.goto(`${origin}/probe`, {waitUntil: 'domcontentloaded'});

  const probeStart = async (name, source) => probePage.evaluate(({name, source}) => {
    const image = new Image();
    image.id = 'mutation-image';
    document.body.append(image);
    const record = {events: [], decode: 'pending'};
    image.onload = () => record.events.push('load');
    image.onerror = () => record.events.push('error');
    window.mutationRecord = record;
    window.mutationImage = image;
    image.src = source;
    image.decode().then(() => { record.decode = 'resolved'; }, error => {
      record.decode = 'rejected:' + String(error && error.name || 'Error');
    });
  }, {name, source});
  const probeRead = () => probePage.evaluate(() => ({
    ...window.mutationRecord,
    currentSrc: window.mutationImage.currentSrc,
    src: window.mutationImage.getAttribute('src'),
    complete: window.mutationImage.complete,
    naturalWidth: window.mutationImage.naturalWidth,
    naturalHeight: window.mutationImage.naturalHeight,
  }));
  const probeClear = kind => probePage.evaluate(kind => {
    if (kind === 'remove') window.mutationImage.removeAttribute('src');
    else if (kind === 'empty') window.mutationImage.src = '';
  }, kind);

  let before = requests.length;
  await probeStart('referrer', '/probe-referrer-policy.png');
  await waitForRequest('/probe-referrer-policy.png');
  await probePage.evaluate(() => { mutationImage.referrerPolicy = 'no-referrer'; });
  await delay(250);
  mutationProbe.referrerPolicyOnly = {
    requestCount: requests.slice(before).filter(request => request.path === '/probe-referrer-policy.png').length,
    requestStayedOpen: !closed.includes('/probe-referrer-policy.png'),
    after250ms: await probeRead(),
  };
  await probeClear('remove');
  await waitForClose('/probe-referrer-policy.png');

  before = requests.length;
  await probeStart('same', '/probe-same-relative-absolute.png');
  await waitForRequest('/probe-same-relative-absolute.png');
  await probePage.evaluate(() => { mutationImage.src = mutationImage.src; });
  await delay(250);
  mutationProbe.pendingRelativeToAbsoluteSameSource = {
    requestCount: requests.slice(before).filter(request => request.path === '/probe-same-relative-absolute.png').length,
    requestStayedOpen: !closed.includes('/probe-same-relative-absolute.png'),
    after250ms: await probeRead(),
  };
  await probeClear('remove');
  await waitForClose('/probe-same-relative-absolute.png');

  before = requests.length;
  await probeStart('remove', '/probe-remove-attribute.png');
  await waitForRequest('/probe-remove-attribute.png');
  await probeClear('remove');
  await waitForClose('/probe-remove-attribute.png');
  await delay(250);
  mutationProbe.removeAttributeSource = {
    requestCount: requests.slice(before).filter(request => request.path === '/probe-remove-attribute.png').length,
    closed: closed.includes('/probe-remove-attribute.png'),
    after250ms: await probeRead(),
  };

  before = requests.length;
  await probeStart('empty', '/probe-empty-source.png');
  await waitForRequest('/probe-empty-source.png');
  await probeClear('empty');
  await waitForClose('/probe-empty-source.png');
  await delay(250);
  mutationProbe.emptySource = {
    requestCount: requests.slice(before).filter(request => request.path === '/probe-empty-source.png').length,
    closed: closed.includes('/probe-empty-source.png'),
    after250ms: await probeRead(),
  };

  before = requests.length;
  await probePage.evaluate(() => {
    window.loadedReset = {loads: 0};
    window.loadedImage = new Image();
    loadedImage.onload = () => { loadedReset.loads++; };
    loadedImage.src = '/image-ok.png?loaded-same-reset=1';
  });
  await probePage.waitForFunction(() => window.loadedReset.loads === 1);
  await probePage.evaluate(() => { loadedImage.src = loadedImage.src; });
  await probePage.waitForFunction(() => window.loadedReset.loads === 2);
  mutationProbe.loadedSameSourceReset = {
    requestCount: requests.slice(before).filter(request => request.path === '/image-ok.png?loaded-same-reset=1').length,
    loadEvents: await probePage.evaluate(() => loadedReset.loads),
  };

  assert.deepEqual(unexpected, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(pageErrors, []);

  const result = {
    browser: browserVersion,
    fixturePath,
    sourceHashes: {
      dartFixtureSha256: createHash('sha256').update(fixtureSource).digest('hex'),
      htmlFixtureSha256: createHash('sha256').update(fixture).digest('hex'),
      pngBase64Sha256: createHash('sha256').update(pngMatch[1]).digest('hex'),
    },
    origin,
    cases,
    mutationProbe,
    requests,
    closed,
    networkRequests,
    externalRequests,
    unexpected,
    pageErrors,
    probeFailures,
    externalPush: 'NOT USED; loopback only',
  };

  const output = path.join(
    root,
    'apps/android/build/parity-acceptance/document-image-cancellation-20261016',
  );
  await mkdir(output, {recursive: true});
  await writeFile(path.join(output, 'browser-oracle.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await probePage?.close().catch(() => {});
  await page?.close().catch(() => {});
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
