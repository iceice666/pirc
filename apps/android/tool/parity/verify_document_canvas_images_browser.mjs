import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const fixturePath = path.join(
  repositoryRoot,
  'apps/android/integration_test/document_canvas_images_fixture.dart',
);
const fixtureSource = readFileSync(fixturePath, 'utf8');
const fixtureMatch = fixtureSource.match(
  /const documentCanvasImagesHtml\s*=\s*r'''([\s\S]*?)''';/,
);
assert.ok(fixtureMatch, 'Could not extract the shared document canvas images HTML.');
const html = fixtureMatch[1];
const pngMatch = html.match(/const pngBase64\s*=\s*'([^']+)'/);
assert.ok(pngMatch, 'Could not extract the deterministic PNG bytes from the fixture.');
const pngBytes = Buffer.from(pngMatch[1], 'base64');

const gatewayDirectory = path.join(repositoryRoot, 'apps/gateway');
const require = createRequire(import.meta.url);
const {chromium} = require(
  require.resolve('playwright-core', {paths: [gatewayDirectory]}),
);
const browserExecutable = requireTestBrowserExecutable();
assert.ok(existsSync(browserExecutable), 'Google Chrome is not installed at the expected path.');

const requests = [];
const unexpectedLocalRequests = [];
const blockedThirdPartyRequests = [];
const serverErrors = [];
let origin = '';
let slowResponseAborted = false;
const server = createServer((request, response) => {
  void (async () => {
    const requestUrl = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
    const entry = {
      method: request.method,
      host: request.headers.host ?? '',
      path: requestUrl.pathname,
      search: requestUrl.search,
    };
    requests.push(entry);

    if (request.method === 'GET' && requestUrl.pathname === '/fixture') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(html);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/quadrants.png') {
      const headers = {
        'content-type': 'image/png',
        'content-length': String(pngBytes.length),
        'cache-control': 'no-store',
      };
      if (requestUrl.searchParams.get('cors') === '1') {
        headers['access-control-allow-origin'] = '*';
      }
      response.writeHead(200, headers);
      response.end(pngBytes);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/broken.png') {
      const invalidBytes = Buffer.from('This body is not a PNG image.');
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(invalidBytes.length),
        'cache-control': 'no-store',
      });
      response.end(invalidBytes);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/slow-broken.png') {
      const invalidBytes = Buffer.from('This body is not a PNG image.');
      const timer = setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(invalidBytes.length),
          'cache-control': 'no-store',
        });
        response.end(invalidBytes);
      }, 300);
      response.once('close', () => clearTimeout(timer));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/slow.png') {
      let responseFinished = false;
      const timer = setTimeout(() => {
        if (response.destroyed) return;
        responseFinished = true;
        response.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(pngBytes.length),
          'cache-control': 'no-store',
        });
        response.end(pngBytes);
      }, 300);
      response.once('close', () => {
        clearTimeout(timer);
        if (!responseFinished) {
          slowResponseAborted = true;
          entry.clientAborted = true;
        }
      });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    unexpectedLocalRequests.push(entry);
    response.writeHead(404, {'content-type': 'text/plain'});
    response.end('unexpected local request');
  })().catch(error => {
    serverErrors.push(String(error && error.stack || error));
    if (!response.headersSent) response.writeHead(500, {'content-type': 'text/plain'});
    response.end('local image oracle error');
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
  'apps/android/build/parity-acceptance/document-canvas-images-20261016',
);
const evidencePath = path.join(evidenceDirectory, 'browser-oracle.json');

try {
  const context = await browser.newContext({
    viewport: {width: 400, height: 180},
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const requestUrl = new URL(route.request().url());
    const localHosts = new Set(['127.0.0.1', 'localhost']);
    const isLoopback = requestUrl.protocol === 'http:' &&
      localHosts.has(requestUrl.hostname) &&
      requestUrl.port === String(address.port);
    if (isLoopback || requestUrl.protocol === 'blob:' || requestUrl.protocol === 'data:') {
      await route.continue();
    } else {
      blockedThirdPartyRequests.push(requestUrl.href);
      await route.abort('blockedbyclient');
    }
  });

  await page.goto(origin + '/fixture', {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(
    () => document.querySelector('#canvas-images-result')?.textContent !== 'WAITING',
    undefined,
    {timeout: 20000},
  );
  const observed = JSON.parse(await page.locator('#canvas-images-result').textContent());
  assert.equal(observed.fixtureError, undefined, 'Shared fixture reported an error.');

  const pixels = await page.evaluate(() => {
    const canvas = document.querySelector('#images-canvas');
    const context = canvas.getContext('2d');
    const points = {
      threeArgument: [[0, 0], [2, 0], [0, 2], [2, 2]],
      fiveArgument: [[9, 1], [14, 1], [9, 6], [14, 6]],
      nineArgumentCrop: [[21, 1], [23, 3], [24, 4]],
      negativeSourceWidth: [[33, 1], [33, 6]],
      negativeSourceHeight: [[63, 3]],
      negativeDestinationSize: [[41, 9], [45, 9], [41, 13], [45, 13]],
      sourceClippedAtLeft: [[1, 21], [5, 21], [5, 25]],
      smoothingEnabled: [[2, 1], [3, 1], [4, 1]],
      smoothingDisabled: [[10, 1], [11, 1], [12, 1]],
      blobSource: [[17, 21]],
      httpSource: [[25, 21]],
      transformedAlphaComposite: [[85, 21], [89, 21], [85, 25], [89, 25]],
      sourceBeforeReplacement: [[1, 37]],
      sourceAfterReplacement: [[9, 37]],
      loadedImageBeforePendingError: [[56, 36]],
      loadedImageDuringPendingError: [[56, 42]],
      loadedImageAfterReplacementError: [[64, 36]],
      blobRevokedInLoad: [[17, 37]],
      immediatelyRevokedBlob: [[25, 37]],
      cancellationReplacement: [[33, 37]],
      svgSource: [[41, 37]],
      jpegSource: [[49, 37]],
      untouchedInvalidDrawArea: [[89, 1], [89, 9], [89, 33]],
    };
    const sample = ([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data);
    return Object.fromEntries(
      Object.entries(points).map(([name, coordinates]) => [
        name,
        coordinates.map(coordinate => ({x: coordinate[0], y: coordinate[1], rgba: sample(coordinate)})),
      ]),
    );
  });

  const browserOnlySecurityProbe = await page.evaluate(async () => {
    const target = (protocol, hostname, port, pathname, search) => {
      const url = new URL(location.href);
      url.protocol = protocol;
      url.hostname = hostname;
      url.port = port;
      url.pathname = pathname;
      url.search = search;
      return url.href;
    };
    const corsUrl = target('http:', 'localhost', location.port, '/quadrants.png', '?cors=1');
    const nonCorsUrl = target('http:', 'localhost', location.port, '/quadrants.png', '?cors=0');

    async function loadImage(url, crossOrigin) {
      const image = new Image();
      if (crossOrigin) image.crossOrigin = crossOrigin;
      const initial = {
        complete: image.complete,
        currentSrc: image.currentSrc,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      };
      const terminalPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('cross-origin image load timed out')), 10000);
        const finish = event => {
          clearTimeout(timer);
          image.removeEventListener('load', onLoad);
          image.removeEventListener('error', onError);
          resolve({type: event.type, complete: image.complete, currentSrc: image.currentSrc,
            naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight});
        };
        const onLoad = event => finish(event);
        const onError = event => finish(event);
        image.addEventListener('load', onLoad);
        image.addEventListener('error', onError);
      });
      image.src = url;
      const afterAssignment = {
        complete: image.complete,
        currentSrc: image.currentSrc,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      };
      const terminal = await terminalPromise;
      return {initial, afterAssignment, terminal, image};
    }

    function canvasRead(image) {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 4;
      const context = canvas.getContext('2d');
      let drawStatus;
      try {
        context.drawImage(image, 0, 0);
        drawStatus = 'ok';
      } catch (error) {
        return {
          drawStatus: 'throws',
          readStatus: 'not-attempted',
          pixelRgba: null,
          errorName: error && error.name || 'Error',
        };
      }
      try {
        return {
          drawStatus,
          readStatus: 'ok',
          pixelRgba: Array.from(context.getImageData(0, 0, 1, 1).data),
          errorName: null,
        };
      } catch (error) {
        return {
          drawStatus,
          readStatus: 'throws',
          pixelRgba: null,
          errorName: error && error.name || 'Error',
        };
      }
    }

    const cors = await loadImage(corsUrl, 'anonymous');
    const nonCors = await loadImage(nonCorsUrl, null);
    const corsCanvas = canvasRead(cors.image);
    const nonCorsCanvas = canvasRead(nonCors.image);
    return {
      probeScope: 'browser-oracle-only; not evaluated by the native fixture',
      cors: {url: corsUrl, initial: cors.initial, afterAssignment: cors.afterAssignment,
        terminal: cors.terminal, canvas: corsCanvas},
      nonCors: {url: nonCorsUrl, initial: nonCors.initial, afterAssignment: nonCors.afterAssignment,
        terminal: nonCors.terminal, canvas: nonCorsCanvas},
    };
  });

  assert.deepEqual(pageErrors, [], 'Fixture reported browser page errors.');
  assert.deepEqual(blockedThirdPartyRequests, [], 'Fixture attempted a third-party request.');
  assert.deepEqual(unexpectedLocalRequests, [], 'Fixture attempted an unexpected loopback request.');
  assert.deepEqual(serverErrors, [], 'The loopback image fixture server reported an error.');
  assert.equal(observed.canvas.width, 100);
  assert.equal(observed.canvas.height, 48);
  assert.equal(observed.sources.noSource.initial.complete, true);
  assert.equal(observed.sources.noSource.initial.naturalWidth, 0);
  assert.equal(observed.sources.noSource.initial.naturalHeight, 0);
  assert.equal(observed.sources.noSource.draw.status, 'ok');
  assert.equal(observed.sources.noSource.decode.status, 'rejected');
  assert.equal(observed.sources.noSource.decode.errorName, 'EncodingError');
  assert.equal(observed.sources.dataPng.afterAssignment.complete, false);
  assert.equal(observed.sources.dataPng.afterAssignment.currentSrc, '');
  assert.equal(observed.sources.dataPng.afterAssignment.naturalWidth, 0);

  const markupImage = observed.sources.htmlImgElement;
  assert.equal(markupImage.terminal.type, 'load');
  assert.equal(markupImage.terminal.state.complete, true);
  assert.equal(markupImage.terminal.state.naturalWidth, 4);
  assert.equal(markupImage.afterAssignment.complete, false);
  assert.equal(markupImage.afterAssignment.currentSrc, '');
  assert.equal(markupImage.terminal.state.naturalHeight, 4);
  assert.equal(markupImage.decode.status, 'resolved');
  for (const sourceName of ['dataPng', 'blobPng', 'httpPng', 'dataJpeg', 'dataSvg']) {
    const source = observed.sources[sourceName];
    assert.equal(source.terminal.type, 'load', sourceName + ' should load.');
    assert.equal(source.terminal.state.complete, true, sourceName + ' should be complete after load.');
    assert.equal(source.terminal.state.naturalWidth, 4, sourceName + ' should have natural width 4.');
    assert.equal(source.terminal.state.naturalHeight, 4, sourceName + ' should have natural height 4.');
    assert.equal(source.decode.status, 'resolved', sourceName + ' decode promise should resolve.');
  }
  assert.equal(observed.sources.brokenHttpPng.terminal.type, 'error');
  assert.equal(observed.sources.brokenHttpPng.terminal.state.complete, true);
  assert.equal(observed.sources.brokenHttpPng.terminal.state.naturalWidth, 0);
  assert.equal(observed.sources.brokenHttpPng.terminal.state.naturalHeight, 0);
  assert.equal(observed.sources.brokenHttpPng.decode.status, 'rejected');
  assert.equal(observed.draws.brokenImage.errorName, 'InvalidStateError');
  assert.equal(observed.sourceReplacement.before.terminal.type, 'load');
  assert.equal(observed.sourceReplacement.after.terminal.type, 'load');
  assert.equal(observed.sourceReplacement.after.terminal.state.src, observed.sourceReplacement.after.afterAssignment.src);
  assert.equal(observed.imageConstructor.status, 'throws');
  assert.equal(observed.imageConstructor.errorName, 'TypeError');
  assert.ok(observed.imageConstructorArguments, 'Image constructor argument probes should be recorded.');
  assert.deepEqual(
    Object.fromEntries(Object.entries(observed.imageConstructorArguments).map(([name, value]) => [name,
      {width: value.width, height: value.height, widthAttribute: value.widthAttribute, heightAttribute: value.heightAttribute},
    ])),
    {
      zero: {width: 0, height: 0, widthAttribute: null, heightAttribute: null},
      one: {width: 20, height: 0, widthAttribute: '20', heightAttribute: null},
      two: {width: 20, height: 10, widthAttribute: '20', heightAttribute: '10'},
    },
  );
  assert.equal(observed.sourceReplacement.loadedThenPendingError.initialTerminal.type, 'load');
  assert.equal(observed.sourceReplacement.loadedThenPendingError.pendingDraw.status, 'ok');
  assert.equal(observed.sourceReplacement.loadedThenPendingError.terminal.type, 'error');
  assert.equal(observed.blobRevocation.immediatelyAfterAssignment.terminal.type, 'error');
  assert.equal(observed.blobRevocation.immediatelyAfterAssignment.terminal.state.complete, true);
  assert.equal(observed.blobRevocation.immediatelyAfterAssignment.decode.status, 'rejected');
  assert.equal(observed.blobRevocation.inLoadThenLaterDraw.revokedInLoad, true);
  assert.equal(observed.blobRevocation.inLoadThenLaterDraw.terminal.type, 'load');
  assert.equal(observed.draws.blobRevokedInLoad.status, 'ok');
  assert.equal(observed.cancellation.pendingDraw.status, 'ok');
  assert.equal(observed.cancellation.terminal.type, 'load');
  assert.deepEqual(observed.cancellation.events.map(event => event.type), ['load']);
  assert.equal(observed.cancellation.terminal.state.naturalWidth, 4);
  assert.equal(observed.cancellation.decode.status, 'resolved');
  assert.equal(observed.draws.cancellationReplacement.status, 'ok');
  assert.equal(observed.invalidDrawImage.wrongType.status, 'throws');
  assert.equal(observed.invalidDrawImage.arity.zero.errorName, 'TypeError');
  assert.equal(observed.invalidDrawImage.arity.two.errorName, 'TypeError');
  assert.equal(observed.invalidDrawImage.arity.four.errorName, 'TypeError');
  assert.equal(observed.invalidDrawImage.arity.six.errorName, 'TypeError');
  assert.equal(observed.invalidDrawImage.arity.ten.status, 'ok');
  assert.equal(browserOnlySecurityProbe.cors.terminal.type, 'load');
  assert.equal(browserOnlySecurityProbe.cors.canvas.readStatus, 'ok');
  assert.deepEqual(browserOnlySecurityProbe.cors.canvas.pixelRgba, [240, 24, 36, 255]);
  assert.equal(browserOnlySecurityProbe.nonCors.terminal.type, 'load');
  assert.equal(browserOnlySecurityProbe.nonCors.canvas.drawStatus, 'ok');
  assert.equal(browserOnlySecurityProbe.nonCors.canvas.readStatus, 'throws');
  assert.equal(browserOnlySecurityProbe.nonCors.canvas.errorName, 'SecurityError');
  assert.deepEqual(pixels.threeArgument.map(sample => sample.rgba), [
    [240, 24, 36, 255], [22, 205, 74, 255], [34, 92, 248, 255], [250, 206, 18, 255],
  ]);
  assert.deepEqual(pixels.nineArgumentCrop.slice(1).map(sample => sample.rgba), [
    [240, 24, 36, 255], [240, 24, 36, 255],
  ]);
  assert.deepEqual(pixels.negativeSourceWidth.map(sample => sample.rgba), [
    [240, 24, 36, 255], [34, 92, 248, 255],
  ]);
  assert.deepEqual(pixels.negativeSourceHeight[0].rgba, [240, 24, 36, 255]);
  assert.deepEqual(pixels.negativeDestinationSize.map(sample => sample.rgba), [
    [240, 24, 36, 255], [22, 205, 74, 255], [34, 92, 248, 255], [250, 206, 18, 255],
  ]);
  assert.deepEqual(pixels.sourceClippedAtLeft.map(sample => sample.rgba), [
    [255, 255, 255, 255], [240, 24, 36, 255], [34, 92, 248, 255],
  ]);
  assert.notDeepEqual(
    pixels.smoothingEnabled.map(sample => sample.rgba),
    pixels.smoothingDisabled.map(sample => sample.rgba),
  );
  assert.deepEqual(pixels.transformedAlphaComposite.map(sample => sample.rgba), [
    [247, 139, 145, 255], [138, 230, 164, 255], [144, 173, 251, 255], [252, 230, 136, 255],
  ]);
  assert.deepEqual(pixels.sourceBeforeReplacement[0].rgba, [240, 24, 36, 255]);
  assert.deepEqual(pixels.sourceAfterReplacement[0].rgba, [20, 210, 225, 255]);
  assert.deepEqual(pixels.blobRevokedInLoad[0].rgba, [240, 24, 36, 255]);
  assert.deepEqual(pixels.cancellationReplacement[0].rgba, [20, 210, 225, 255]);
  assert.deepEqual(pixels.svgSource[0].rgba, [240, 24, 36, 255]);
  assert.deepEqual(pixels.untouchedInvalidDrawArea.map(sample => sample.rgba), [
    [255, 255, 255, 255], [255, 255, 255, 255], [255, 255, 255, 255],
  ]);
  assert.deepEqual(observed.imageSmoothing, {defaultEnabled: true, defaultQuality: 'low'});

  const allowedPaths = new Set(['/fixture', '/quadrants.png', '/broken.png', '/slow.png', '/slow-broken.png', '/favicon.ico']);
  assert.ok(requests.every(item => allowedPaths.has(item.path)), 'Only known loopback image routes are allowed.');
  assert.ok(requests.some(item => item.path === '/slow.png'), 'Cancellation probe did not request its delayed image.');
  assert.equal(slowResponseAborted, true, 'Replacing the delayed source should abort its pending HTTP request.');
  assert.ok(requests.some(item => item.host.startsWith('localhost:') && item.search === '?cors=1'));
  assert.ok(requests.some(item => item.host.startsWith('localhost:') && item.search === '?cors=0'));

  const evidence = {
    browser: 'Google Chrome ' + browser.version(),
    date: '2026-10-16',
    origin,
    network: {allowedRequests: requests, slowResponseAborted, unexpectedLocalRequests, blockedThirdPartyRequests},
    fixture: 'apps/android/integration_test/document_canvas_images_fixture.dart',
    canvasPixelSource: 'Actual Chrome CanvasRenderingContext2D.getImageData RGBA values; the shared HTML fixture does not call getImageData.',
    browserOnlySecurityProbe,
    observed,
    pixels,
    pageErrors,
    serverErrors,
  };
  await mkdir(evidenceDirectory, {recursive: true});
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({
    browser: evidence.browser,
    evidencePath,
    sources: Object.fromEntries(Object.entries(observed.sources).map(([name, value]) => [name,
      value && value.terminal ? {event: value.terminal.type, width: value.terminal.state.naturalWidth,
        height: value.terminal.state.naturalHeight, decode: value.decode?.status} : value])),
    invalidDrawImage: observed.invalidDrawImage,
    imageConstructor: observed.imageConstructor,
    imageConstructorArguments: observed.imageConstructorArguments,
    loadedImageReplacementError: {
      loaded: observed.sourceReplacement.loadedThenPendingError.loaded,
      afterAssignment: observed.sourceReplacement.loadedThenPendingError.afterAssignment,
      whilePending: observed.sourceReplacement.loadedThenPendingError.whilePending,
      pendingDraw: observed.sourceReplacement.loadedThenPendingError.pendingDraw,
      terminal: observed.sourceReplacement.loadedThenPendingError.terminal,
      drawAfterError: observed.sourceReplacement.loadedThenPendingError.drawAfterError,
      pixels: {
        loaded: pixels.loadedImageBeforePendingError[0].rgba,
        whilePending: pixels.loadedImageDuringPendingError[0].rgba,
        afterErrorArea: pixels.loadedImageAfterReplacementError[0].rgba,
      },
    },
    blobRevocation: {
      immediate: observed.blobRevocation.immediatelyAfterAssignment.terminal.type,
      inLoadThenDraw: observed.blobRevocation.inLoadThenLaterDraw.terminal.type,
      revokedInLoad: observed.blobRevocation.inLoadThenLaterDraw.revokedInLoad,
    },
    slowResponseAborted,
    security: {
      corsRead: browserOnlySecurityProbe.cors.canvas.readStatus,
      nonCorsRead: browserOnlySecurityProbe.nonCors.canvas.errorName,
    },
  }, null, 2));
} catch (error) {
  serverErrors.push(String(error && error.stack || error));
  throw error;
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
