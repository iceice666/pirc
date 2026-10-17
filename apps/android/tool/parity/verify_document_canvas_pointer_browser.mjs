import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const fixturePath = path.join(
  repositoryRoot,
  'apps/android/integration_test/document_canvas_pointer_fixture.dart',
);
const fixtureSource = readFileSync(fixturePath, 'utf8');
const fixtureMatch = fixtureSource.match(
  /const documentCanvasPointerHtml\s*=\s*r'''([\s\S]*?)''';/,
);
assert.ok(fixtureMatch, 'Could not extract the shared document canvas pointer HTML.');
const html = fixtureMatch[1];

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
const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
  requests.push({method: request.method, path: requestUrl.pathname});
  if (request.method === 'GET' && requestUrl.pathname === '/fixture') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(html);
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  unexpectedLocalRequests.push({method: request.method, path: requestUrl.pathname});
  response.writeHead(404, {'content-type': 'text/plain'});
  response.end('unexpected local request');
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
origin = 'http://127.0.0.1:' + address.port;

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable,
    args: ['--disable-gpu'],
  });
  const context = await browser.newContext({
    viewport: {width: 390, height: 400},
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === origin) {
      await route.continue();
    } else {
      blockedThirdPartyRequests.push(requestUrl.href);
      await route.abort('blockedbyclient');
    }
  });
  await page.goto(origin + '/fixture', {waitUntil: 'domcontentloaded'});

  const canvasRect = await page.locator('#pointer-canvas').boundingBox();
  assert.ok(canvasRect, 'The fixture canvas did not receive a layout box.');
  assert.deepEqual(
    {
      x: canvasRect.x,
      y: canvasRect.y,
      width: canvasRect.width,
      height: canvasRect.height,
    },
    {x: 24, y: 32, width: 300, height: 150},
    'The fixture CSS box changed.',
  );

  function lastOf(events, type) {
    const matching = events.filter(event => event.type === type);
    assert.ok(matching.length > 0, 'No ' + type + ' event was recorded.');
    return matching[matching.length - 1];
  }

  function near(actual, expected, message) {
    assert.ok(
      Number.isFinite(actual) && Math.abs(actual - expected) < 0.01,
      message + ': expected ' + expected + ', observed ' + actual,
    );
  }

  await page.evaluate(() => window.__resetDocumentCanvasPointer('none'));
  await page.mouse.move(canvasRect.x + 40, canvasRect.y + 30);
  await page.mouse.move(canvasRect.x + 90, canvasRect.y + 60);
  await page.mouse.down({button: 'left'});
  await page.mouse.move(canvasRect.x + 180, canvasRect.y + 100, {steps: 2});
  await page.mouse.up({button: 'left'});
  const mouse = await page.evaluate(() => ({
    events: window.__documentCanvasPointer.events,
    captureCalls: window.__documentCanvasPointer.captureCalls,
    droppedEvents: window.__documentCanvasPointer.droppedEvents,
    touchAction: window.__documentCanvasPointer.touchAction,
    scrollTop: document.scrollingElement.scrollTop,
    pixel: Array.from(
      document.querySelector('#pointer-canvas')
        .getContext('2d').getImageData(144, 80, 1, 1).data,
    ),
  }));

  const mouseDown = lastOf(mouse.events, 'pointerdown');
  const mouseMove = lastOf(mouse.events, 'pointermove');
  const mouseUp = lastOf(mouse.events, 'pointerup');
  assert.equal(mouseDown.targetId, 'pointer-canvas');
  assert.equal(mouseDown.pointerType, 'mouse');
  assert.equal(mouseDown.isPrimary, true);
  assert.equal(mouseDown.bubbles, true);
  assert.equal(mouseDown.cancelable, true);
  assert.equal(mouseDown.button, 0);
  assert.equal(mouseDown.buttons, 1);
  assert.equal(mouseDown.pointerId, mouseUp.pointerId);
  assert.equal(mouseMove.pointerId, mouseDown.pointerId);
  near(mouseDown.offsetX, 90, 'Mouse down offsetX');
  near(mouseDown.offsetY, 60, 'Mouse down offsetY');
  near(mouseMove.offsetX, 180, 'Mouse move offsetX');
  near(mouseMove.offsetY, 100, 'Mouse move offsetY');
  near(mouseMove.mappedX, 144, 'Mouse move backing-store X');
  near(mouseMove.mappedY, 80, 'Mouse move backing-store Y');
  assert.equal(mouseUp.buttons, 0);
  assert.equal(mouse.events.filter(event => event.type === 'mousedown').length, 1);
  assert.equal(mouse.events.filter(event => event.type === 'mouseup').length, 1);
  assert.equal(mouse.events.filter(event => event.type === 'click').length, 1);
  assert.equal(
    mouse.captureCalls.some(call => call.method === 'setPointerCapture' && call.ok),
    true,
    'Chrome did not accept setPointerCapture for the mouse pointer.',
  );
  assert.ok(mouse.events.some(event => event.type === 'gotpointercapture'));
  assert.ok(mouse.events.some(event => event.type === 'lostpointercapture'));
  assert.deepEqual(mouse.pixel, [225, 29, 72, 255]);
  assert.equal(mouse.scrollTop, 0);

  const cdp = await context.newCDPSession(page);
  async function dispatchTouch(type, point, id) {
    const touchPoints = point === null ? [] : [{
      x: point.x,
      y: point.y,
      id,
      radiusX: 2,
      radiusY: 2,
      force: type === 'touchEnd' ? 0 : 1,
    }];
    await cdp.send('Input.dispatchTouchEvent', {type, touchPoints, modifiers: 0});
  }

  await page.evaluate(() => window.__resetDocumentCanvasPointer('none'));
  const noneId = 17;
  await dispatchTouch('touchStart', {x: canvasRect.x + 40, y: canvasRect.y + 55}, noneId);
  await dispatchTouch('touchMove', {x: canvasRect.x + 120, y: canvasRect.y + 85}, noneId);
  await dispatchTouch('touchMove', {x: canvasRect.x + 150, y: canvasRect.y + 100}, noneId);
  await dispatchTouch('touchEnd', null, noneId);
  await page.waitForTimeout(75);
  const touchNone = await page.evaluate(() => ({
    events: window.__documentCanvasPointer.events,
    captureCalls: window.__documentCanvasPointer.captureCalls,
    droppedEvents: window.__documentCanvasPointer.droppedEvents,
    touchAction: window.__documentCanvasPointer.touchAction,
    computedTouchAction: getComputedStyle(
      document.querySelector('#pointer-canvas'),
    ).touchAction,
    scrollTop: document.scrollingElement.scrollTop,
    pixel: Array.from(
      document.querySelector('#pointer-canvas')
        .getContext('2d').getImageData(120, 80, 1, 1).data,
    ),
  }));

  const noneDown = lastOf(touchNone.events, 'pointerdown');
  const noneMove = lastOf(touchNone.events, 'pointermove');
  const noneUp = lastOf(touchNone.events, 'pointerup');
  assert.equal(touchNone.touchAction, 'none');
  assert.equal(touchNone.computedTouchAction, 'none');
  assert.equal(noneDown.targetId, 'pointer-canvas');
  assert.equal(noneDown.pointerType, 'touch');
  assert.equal(noneDown.isPrimary, true);
  assert.equal(noneDown.bubbles, true);
  assert.equal(noneDown.cancelable, true);
  assert.equal(noneDown.pointerId, noneMove.pointerId);
  assert.equal(noneMove.pointerId, noneUp.pointerId);
  near(noneDown.offsetX, 40, 'Touch down offsetX');
  near(noneDown.offsetY, 55, 'Touch down offsetY');
  near(noneDown.mappedX, 32, 'Touch down backing-store X');
  near(noneDown.mappedY, 44, 'Touch down backing-store Y');
  near(noneMove.offsetX, 150, 'Touch move offsetX');
  near(noneMove.offsetY, 100, 'Touch move offsetY');
  near(noneMove.mappedX, 120, 'Touch move backing-store X');
  near(noneMove.mappedY, 80, 'Touch move backing-store Y');
  assert.equal(touchNone.events.filter(event => event.type === 'pointercancel').length, 0);
  assert.equal(touchNone.scrollTop, 0);
  assert.equal(
    touchNone.captureCalls.some(call => call.method === 'setPointerCapture' && call.ok),
    true,
    'Chrome did not accept setPointerCapture for the touch pointer.',
  );
  assert.ok(touchNone.events.some(event => event.type === 'gotpointercapture'));
  assert.ok(touchNone.events.some(event => event.type === 'lostpointercapture'));
  assert.deepEqual(touchNone.pixel, [225, 29, 72, 255]);

  await page.evaluate(() => {
    window.__resetDocumentCanvasPointer('auto');
    window.scrollTo(0, 0);
  });
  const autoId = 23;
  await dispatchTouch('touchStart', {x: canvasRect.x + 120, y: canvasRect.y + 130}, autoId);
  await dispatchTouch('touchMove', {x: canvasRect.x + 120, y: canvasRect.y + 70}, autoId);
  await dispatchTouch('touchMove', {x: canvasRect.x + 120, y: canvasRect.y + 10}, autoId);
  await dispatchTouch('touchEnd', null, autoId);
  await page.waitForTimeout(150);
  const touchAuto = await page.evaluate(() => ({
    events: window.__documentCanvasPointer.events,
    captureCalls: window.__documentCanvasPointer.captureCalls,
    droppedEvents: window.__documentCanvasPointer.droppedEvents,
    touchAction: window.__documentCanvasPointer.touchAction,
    computedTouchAction: getComputedStyle(
      document.querySelector('#pointer-canvas'),
    ).touchAction,
    scrollTop: document.scrollingElement.scrollTop,
  }));

  assert.equal(touchAuto.touchAction, 'auto');
  assert.equal(touchAuto.computedTouchAction, 'auto');
  const autoDown = lastOf(touchAuto.events, 'pointerdown');
  assert.equal(autoDown.pointerType, 'touch');
  assert.equal(autoDown.isPrimary, true);
  assert.ok(touchAuto.events.some(event => event.type === 'pointermove'));
  const autoCancelCount = touchAuto.events.filter(
    event => event.type === 'pointercancel',
  ).length;
  assert.ok(
    autoCancelCount > 0 || touchAuto.scrollTop > 0,
    'With touch-action:auto, Chrome recorded neither pointercancel nor page scrolling.',
  );

  assert.equal(mouse.droppedEvents, 0);
  assert.equal(touchNone.droppedEvents, 0);
  assert.equal(touchAuto.droppedEvents, 0);
  assert.equal(requests.filter(request => request.path === '/fixture').length, 1);
  assert.deepEqual(pageErrors, [], 'The fixture raised a browser page error.');
  assert.deepEqual(blockedThirdPartyRequests, [], 'A third-party request was blocked.');
  assert.deepEqual(unexpectedLocalRequests, [], 'The fixture made an unexpected loopback request.');

  const result = {
    oracle: 'Google Chrome via Playwright Core and Chrome DevTools touch input',
    browserVersion: browser.version(),
    fixture: 'apps/android/integration_test/document_canvas_pointer_fixture.dart',
    fixtureSymbol: 'documentCanvasPointerHtml',
    origin: '127.0.0.1 loopback only',
    viewportCssPixels: {width: 390, height: 400, deviceScaleFactor: 1},
    canvas: {
      backingStore: {width: 240, height: 120},
      cssBox: {left: 24, top: 32, width: 300, height: 150},
      mappingScale: {x: 0.8, y: 0.8},
    },
    assertions: {
      mouse: {
        pointerType: mouseDown.pointerType,
        normalizedPointerId: mouseDown.pointerId,
        rawPointerId: mouseDown.rawPointerId,
        hoverEvents: mouse.events.filter(event =>
          event.type === 'pointerenter' || event.type === 'mouseenter').length,
        pointerDown: mouseDown,
        pointerMove: mouseMove,
        pointerUp: mouseUp,
        captureCalls: mouse.captureCalls,
        clickCount: mouse.events.filter(event => event.type === 'click').length,
        mappedPixel: mouse.pixel,
      },
      touchActionNone: {
        pointerType: noneDown.pointerType,
        normalizedPointerId: noneDown.pointerId,
        rawPointerId: noneDown.rawPointerId,
        pointerDown: noneDown,
        pointerMove: noneMove,
        pointerUp: noneUp,
        pointerCancelCount: 0,
        captureCalls: touchNone.captureCalls,
        scrollTop: touchNone.scrollTop,
        mappedPixel: touchNone.pixel,
      },
      touchActionAuto: {
        pointerType: autoDown.pointerType,
        normalizedPointerId: autoDown.pointerId,
        rawPointerId: autoDown.rawPointerId,
        pointerCancelCount: autoCancelCount,
        scrollTop: touchAuto.scrollTop,
        captureCalls: touchAuto.captureCalls,
        events: touchAuto.events,
      },
    },
    network: {
      requests,
      unexpectedLocalRequests,
      blockedThirdPartyRequests,
    },
    pageErrors,
  };
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  serverErrors.push(String(error && error.stack || error));
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  if (serverErrors.length) {
    process.stderr.write(serverErrors.join('\n') + '\n');
  }
}
