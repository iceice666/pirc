import { requireTestBrowserExecutable } from './test_browser.mjs';
// Capture real Chrome computed background longhands and screenshot pixels for
// a focused set of layered CSS backgrounds. Screenshot PNGs are sampled in
// memory; the fixture stores pixel RGBA values and hashes, not image base64.
// Run with: node apps/android/tool/parity/capture_background_layers_web.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const outputPath = resolve(root, 'fixtures/mobile-parity/background-layers-expected.json');
const outputName = 'fixtures/mobile-parity/background-layers-expected.json';
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const browserExecutable = requireTestBrowserExecutable();
const box = { width: 120, height: 80 };
const viewport = { width: 390, height: 120 };
const sampleXs = [0, 10, 20, 30, 40, 60, 80, 100, 119];
const sampleYs = [0, 10, 20, 30, 39, 40, 50, 60, 79];

const svgRedBlue = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="20" height="40" fill="#ff0000"/><rect x="20" width="20" height="40" fill="#0000ff"/></svg>`;
const svgRedBlueCutout = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="20" height="20" fill="#ff0000"/><rect x="20" width="20" height="20" fill="#0000ff"/></svg>`;
const svgUrl = markup => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
const assetUrls = {
  svgRedBlue: svgUrl(svgRedBlue),
  svgRedBlueCutout: svgUrl(svgRedBlueCutout),
};

function buildCases({ svgRedBlueUrl, svgRedBlueCutoutUrl, pngOverlayUrl }) {
  const alphaRed = 'rgba(255, 0, 0, 0.5)';
  const alphaBlue = 'rgba(0, 0, 255, 0.5)';
  const alphaGreen = 'rgba(0, 255, 0, 0.55)';
  const commonLayered = {
    width: box.width,
    height: box.height,
    backgroundColor: '#ffffff',
    backgroundPosition: 'left top, left top',
    backgroundRepeat: 'no-repeat, no-repeat',
  };
  return [
    {
      id: 'two-alpha-linear-layers-over-white',
      ...commonLayered,
      backgroundImage: `linear-gradient(to right, ${alphaRed} 0%, ${alphaRed} 50%, transparent 50%, transparent 100%), linear-gradient(to top, ${alphaBlue} 0%, ${alphaBlue} 50%, transparent 50%, transparent 100%)`,
      backgroundSize: '120px 80px, 120px 80px',
      expectedImageLayerCount: 2,
    },
    {
      id: 'linear-over-radial',
      ...commonLayered,
      backgroundImage: `linear-gradient(to right, ${alphaGreen} 0%, ${alphaGreen} 40%, transparent 80%), radial-gradient(circle 35px at center, rgba(0, 0, 255, 0.6), transparent)`,
      backgroundSize: '120px 80px, 120px 80px',
      expectedImageLayerCount: 2,
    },
    {
      id: 'transparent-stop-gradient-over-svg',
      ...commonLayered,
      backgroundImage: `linear-gradient(to right, ${alphaGreen} 0%, transparent 100%), url("${svgRedBlueUrl}")`,
      backgroundSize: '120px 80px, 120px 80px',
      expectedImageLayerCount: 2,
    },
    {
      id: 'svg-over-transparent-stop-gradient',
      ...commonLayered,
      backgroundImage: `url("${svgRedBlueUrl}"), linear-gradient(to right, ${alphaGreen} 0%, transparent 100%)`,
      backgroundSize: '120px 80px, 120px 80px',
      expectedImageLayerCount: 2,
    },
    {
      id: 'none-layer-gradient-none-over-color',
      width: box.width,
      height: box.height,
      backgroundImage: `none, linear-gradient(to right, ${alphaRed} 0%, transparent 100%), none`,
      backgroundColor: '#ffff00',
      backgroundSize: '20px 20px, 40px 30px',
      backgroundPosition: 'left top, center center',
      backgroundRepeat: 'no-repeat, repeat-x',
      expectedImageLayerCount: 3,
    },
    {
      id: 'png-over-svg-two-url-layers',
      width: box.width,
      height: box.height,
      backgroundImage: `url("${pngOverlayUrl}"), url("${svgRedBlueUrl}")`,
      backgroundColor: '#ffffff',
      backgroundSize: '40px 40px, 120px 80px',
      backgroundPosition: 'left top, left top',
      backgroundRepeat: 'no-repeat, no-repeat',
      expectedImageLayerCount: 2,
    },
    {
      id: 'background-shorthand-color-on-last-layer',
      width: box.width,
      height: box.height,
      backgroundShorthand: `linear-gradient(to right, ${alphaGreen} 0%, transparent 100%) left top / 120px 80px no-repeat, url("${svgRedBlueCutoutUrl}") left top / 120px 80px no-repeat #ffffff`,
      expectedImageLayerCount: 2,
    },
    {
      id: 'three-images-two-value-lists-cycle',
      width: box.width,
      height: box.height,
      backgroundImage: `linear-gradient(to right, ${alphaRed} 0%, transparent 100%), linear-gradient(to top, rgba(0, 180, 0, 0.5) 0%, transparent 100%), linear-gradient(135deg, rgba(0, 0, 255, 0.5) 0%, transparent 100%)`,
      backgroundColor: '#ffffff',
      backgroundSize: '30px 30px, 60px 40px',
      backgroundPosition: 'left top, center center',
      backgroundRepeat: 'no-repeat, repeat-x',
      expectedImageLayerCount: 3,
    },
  ];
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function redactDataUrls(value, urls) {
  return value
    .replaceAll(urls.svgRedBlueUrl, '<asset:svg-red-blue>')
    .replaceAll(urls.svgRedBlueCutoutUrl, '<asset:svg-red-blue-cutout>')
    .replaceAll(urls.pngOverlayUrl, '<asset:png-overlay>')
    .replace(/data:image\/svg\+xml(?:;charset=utf-8)?,[^"')]+/g, '<asset:svg-data>')
    .replace(/data:image\/png;base64,[^"')]+/g, '<asset:png-data>');
}

const localPage = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,"><title>CSS background layers oracle</title>
<style>
html,body{margin:0;padding:0;overflow:hidden;}
body{background:#ddd;}
#target{display:block;box-sizing:border-box;width:120px;height:80px;margin:0;border:0;padding:0;}
</style></head><body><div id="target"></div><script>window.backgroundLayersPageReady=true;</script></body></html>`;
const server = createServer((request, response) => {
  if (request.url !== '/') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(localPage);
});

await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', resolveListen);
});
const address = server.address();
assert.ok(address && typeof address === 'object', 'local server did not expose its port');
const origin = `http://127.0.0.1:${address.port}`;

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
  });
  const page = await context.newPage();
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.stack || error.message));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.route('**/*', route => route.request().url().startsWith(origin)
    ? route.continue()
    : route.abort());
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.backgroundLayersPageReady === true);

  const pngOverlayUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 40;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, 40, 40);
    context.fillStyle = 'rgba(0, 255, 0, 0.75)';
    context.fillRect(0, 0, 20, 20);
    context.fillStyle = 'rgba(255, 255, 0, 0.75)';
    context.fillRect(20, 0, 20, 20);
    return canvas.toDataURL('image/png');
  });
  const urls = {
    svgRedBlueUrl: assetUrls.svgRedBlue,
    svgRedBlueCutoutUrl: assetUrls.svgRedBlueCutout,
    pngOverlayUrl,
  };
  const cases = buildCases(urls);
  const points = sampleYs.flatMap(y => sampleXs.map(x => ({ x, y })));
  const captures = [];

  for (const testCase of cases) {
    const measured = await page.evaluate(async ({ testCase, urls, points }) => {
      const target = document.querySelector('#target');
      target.removeAttribute('style');
      target.style.width = `${testCase.width}px`;
      target.style.height = `${testCase.height}px`;
      if (testCase.backgroundShorthand !== undefined) {
        target.style.background = testCase.backgroundShorthand;
      } else {
        target.style.backgroundImage = testCase.backgroundImage;
        target.style.backgroundColor = testCase.backgroundColor;
        target.style.backgroundSize = testCase.backgroundSize;
        target.style.backgroundPosition = testCase.backgroundPosition;
        target.style.backgroundRepeat = testCase.backgroundRepeat;
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const style = getComputedStyle(target);
      const splitCssList = value => {
        const parts = [];
        let start = 0;
        let depth = 0;
        let quote = '';
        for (let i = 0; i < value.length; i += 1) {
          const character = value[i];
          if (quote) {
            if (character === quote && value[i - 1] !== '\\') quote = '';
          } else if (character === '"' || character === "'") {
            quote = character;
          } else if (character === '(') {
            depth += 1;
          } else if (character === ')') {
            depth -= 1;
          } else if (character === ',' && depth === 0) {
            parts.push(value.slice(start, i).trim());
            start = i + 1;
          }
        }
        parts.push(value.slice(start).trim());
        return parts;
      };
      const imageLayers = splitCssList(style.backgroundImage);
      const sizeLayers = splitCssList(style.backgroundSize);
      const positionLayers = splitCssList(style.backgroundPosition);
      const repeatLayers = splitCssList(style.backgroundRepeat);
      const authoredImageLayers = splitCssList(target.style.backgroundImage);
      const authoredSizeLayers = splitCssList(target.style.backgroundSize);
      const authoredPositionLayers = splitCssList(target.style.backgroundPosition);
      const authoredRepeatLayers = splitCssList(target.style.backgroundRepeat);
      const perImageLayer = imageLayers.map((image, index) => ({
        index,
        image,
        size: sizeLayers[index % sizeLayers.length],
        position: positionLayers[index % positionLayers.length],
        repeat: repeatLayers[index % repeatLayers.length],
        authoredSizeListIndex: index % authoredSizeLayers.length,
        authoredPositionListIndex: index % authoredPositionLayers.length,
        authoredRepeatListIndex: index % authoredRepeatLayers.length,
      }));
      const rect = target.getBoundingClientRect();
      return {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        computedStyle: {
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          backgroundPosition: style.backgroundPosition,
          backgroundPositionX: style.backgroundPositionX,
          backgroundPositionY: style.backgroundPositionY,
          backgroundSize: style.backgroundSize,
          backgroundRepeat: style.backgroundRepeat,
          backgroundOrigin: style.backgroundOrigin,
          backgroundClip: style.backgroundClip,
          backgroundAttachment: style.backgroundAttachment,
          backgroundBlendMode: style.backgroundBlendMode,
        },
        imageLayerCount: imageLayers.length,
        imageLayers,
        authoredBackgroundPropertyListCounts: {
          image: authoredImageLayers.length,
          size: authoredSizeLayers.length,
          position: authoredPositionLayers.length,
          repeat: authoredRepeatLayers.length,
        },
        computedBackgroundPropertyListCounts: {
          image: imageLayers.length,
          size: sizeLayers.length,
          position: positionLayers.length,
          repeat: repeatLayers.length,
        },
        effectivePerImageLayer: perImageLayer,
        pointCount: points.length,
      };
    }, { testCase, urls, points });
    assert.deepEqual(measured.rect, { x: 0, y: 0, width: box.width, height: box.height }, `${testCase.id}: unexpected element bounds`);
    assert.equal(measured.imageLayerCount, testCase.expectedImageLayerCount, `${testCase.id}: invalid CSS image declaration`);

    const screenshot = await page.locator('#target').screenshot({ omitBackground: false, animations: 'disabled' });
    const pixelSamples = await page.evaluate(async ({ png, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      return {
        width: image.width,
        height: image.height,
        samples: points.map(({ x, y }) => ({
          x,
          y,
          rgba: [...context.getImageData(x, y, 1, 1).data],
        })),
      };
    }, { png: screenshot.toString('base64'), points });
    assert.equal(pixelSamples.width, box.width, `${testCase.id}: screenshot width changed`);
    assert.equal(pixelSamples.height, box.height, `${testCase.id}: screenshot height changed`);

    const normalizedStyle = Object.fromEntries(Object.entries(measured.computedStyle)
      .map(([key, value]) => [key, redactDataUrls(value, urls)]));
    captures.push({
      id: testCase.id,
      element: { width: testCase.width, height: testCase.height },
      authoredCss: testCase.backgroundShorthand !== undefined
        ? { background: redactDataUrls(testCase.backgroundShorthand, urls) }
        : {
            backgroundImage: redactDataUrls(testCase.backgroundImage, urls),
            backgroundColor: testCase.backgroundColor,
            backgroundSize: testCase.backgroundSize,
            backgroundPosition: testCase.backgroundPosition,
            backgroundRepeat: testCase.backgroundRepeat,
          },
      computedBackgroundLonghands: normalizedStyle,
      computedBackgroundImageSha256: sha256(measured.computedStyle.backgroundImage),
      imageLayers: measured.imageLayers.map(image => redactDataUrls(image, urls)),
      authoredBackgroundPropertyListCounts: measured.authoredBackgroundPropertyListCounts,
      computedBackgroundPropertyListCounts: measured.computedBackgroundPropertyListCounts,
      effectivePerImageLayer: measured.effectivePerImageLayer.map(layer => ({
        ...layer,
        image: redactDataUrls(layer.image, urls),
      })),
      screenshot: {
        width: pixelSamples.width,
        height: pixelSamples.height,
        mimeType: 'image/png',
        deviceScaleFactor: 1,
        byteLength: screenshot.byteLength,
        sha256: sha256(screenshot),
      },
      sampleGrid: { x: sampleXs, y: sampleYs },
      pixelSamples: pixelSamples.samples,
    });
  }

  assert.deepEqual(browserErrors, [], 'unexpected browser errors');
  assert.equal(captures.length, 8);
  const pngBase64 = pngOverlayUrl.slice(pngOverlayUrl.indexOf(',') + 1);
  const expected = {
    fixture: outputName,
    capturedAt: new Date().toISOString(),
    browser: {
      name: 'Google Chrome',
      version: browser.version(),
      executable: browserExecutable,
      viewport,
      colorScheme: 'light',
      deviceScaleFactor: 1,
      method: 'Playwright on localhost; each 120x80 element is captured as a Chrome screenshot and pixel samples are read from that PNG.',
    },
    assets: [
      {
        id: 'svg-red-blue',
        mimeType: 'image/svg+xml',
        dataUri: assetUrls.svgRedBlue,
        width: 40,
        height: 40,
        byteLength: Buffer.byteLength(svgRedBlue, 'utf8'),
        sha256: sha256(svgRedBlue),
        description: 'Opaque red left half and blue right half.',
      },
      {
        id: 'svg-red-blue-cutout',
        mimeType: 'image/svg+xml',
        dataUri: assetUrls.svgRedBlueCutout,
        width: 40,
        height: 40,
        byteLength: Buffer.byteLength(svgRedBlueCutout, 'utf8'),
        sha256: sha256(svgRedBlueCutout),
        description: 'Red/blue top half with a transparent bottom half.',
      },
      {
        id: 'png-overlay',
        mimeType: 'image/png',
        dataUri: pngOverlayUrl,
        width: 40,
        height: 40,
        byteLength: Buffer.from(pngBase64, 'base64').byteLength,
        sha256: sha256(Buffer.from(pngBase64, 'base64')),
        description: 'Semitransparent green/yellow top half and transparent bottom half; PNG bytes omitted.',
      },
    ],
    interpretation: {
      backgroundLayerOrder: 'CSS background-image layer 0 is painted on top of layer 1, then subsequent layers; background-color is beneath all image layers.',
      cyclicLonghandLists: 'background-size, background-position, and background-repeat values repeat from the start when fewer values are present than background-image layers; effectivePerImageLayer records the applied list index for each layer.',
      screenshotPixels: 'RGBA values are sampled from the actual PNG bytes returned by locator.screenshot(); screenshot base64 is not stored.',
      coverage: 'Eight specified multilayer-background cases at 390px viewport, light scheme, and device scale factor 1; no claim about other widths or broader background grammar.',
    },
    cases: captures,
    coverage: {
      caseCount: captures.length,
      samplesPerCase: sampleXs.length * sampleYs.length,
      backgroundListCycleCase: 'three-images-two-value-lists-cycle',
      imageOrderPair: ['transparent-stop-gradient-over-svg', 'svg-over-transparent-stop-gradient'],
    },
  };
  await writeFile(outputPath, JSON.stringify(expected, null, 2) + '\n');
  console.log(JSON.stringify({
    browser: expected.browser.version,
    configuration: '390-light-1',
    cases: captures.length,
    samplesPerCase: expected.coverage.samplesPerCase,
    outputPath,
    results: captures.map(testCase => ({
      id: testCase.id,
      imageLayers: testCase.imageLayers,
      backgroundColor: testCase.computedBackgroundLonghands.backgroundColor,
      authoredListCounts: testCase.authoredBackgroundPropertyListCounts,
      computedListCounts: testCase.computedBackgroundPropertyListCounts,
      samplePoints: testCase.pixelSamples.filter(point =>
        (point.x === 0 && point.y === 0) ||
        (point.x === 30 && point.y === 0) ||
        (point.x === 60 && point.y === 40) ||
        (point.x === 119 && point.y === 79)),
    })),
  }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
