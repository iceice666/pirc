import { requireTestBrowserExecutable } from './test_browser.mjs';
// Capture Chrome's computed CSS background longhands and PNG screenshot pixels
// for raster background sizing, positioning, and repeat cases.
// Run with: node apps/android/tool/parity/capture_background_positions_web.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const outputPath = resolve(root, 'fixtures/mobile-parity/background-positions-expected.json');
const outputName = 'fixtures/mobile-parity/background-positions-expected.json';
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const browserExecutable = requireTestBrowserExecutable();
const box = { width: 120, height: 80 };
const viewport = { width: 390, height: 120 };
const sampleXs = [4, 12, 24, 36, 44, 52, 64, 76, 84, 92, 104, 116];
const sampleYs = [4, 12, 24, 36, 44, 52, 64, 76];

// Fixed replayable PNG assets: 40x20 red/blue halves and a 1x1 #16a085 pixel.
// The fixture records their data URIs, byte lengths, and SHA-256 hashes.
const rasterDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAYAAAD/Rn+7AAAALElEQVR42u3OsQ0AAAzCMP5/mj7BVHnIGjlNumy8awABAQEBAQEBAQEBPwMPbG46G0q0eUoAAAAASUVORK5CYII=';
const rasterBytes = Buffer.from(rasterDataUri.slice(rasterDataUri.indexOf(',') + 1), 'base64');
const rasterImage = 'url("' + rasterDataUri + '")';
const tinyRasterDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQW9D6HwAERgI7Rs/cogAAAABJRU5ErkJggg==';
const tinyRasterBytes = Buffer.from(tinyRasterDataUri.slice(tinyRasterDataUri.indexOf(',') + 1), 'base64');
const tinyRasterImage = 'url("' + tinyRasterDataUri + '")';

function buildCases() {
  const svgImage = 'url("data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><path fill="red" d="M0 0h20v20H0z"/><path fill="blue" d="M20 0h20v20H20z"/></svg>').toString('base64') + '")';
  const gradient = 'linear-gradient(to right, red 0%, red 50%, blue 50%, blue 100%)';
  const single = (id, position, size='40px 20px', repeat='no-repeat', image=rasterImage) => ({
    id, backgroundImage:image, backgroundColor:'#ffffff', backgroundSize:size,
    backgroundPosition:position, backgroundRepeat:repeat, expectedImageLayerCount:1,
  });
  return [
    single('raster-px', '20px 10px'),
    single('raster-one-px', '20px'),
    single('raster-percent', '25% 75%'),
    single('raster-mixed-percent-px', '50% 10px'),
    single('raster-negative-repeat', '-10px -5px', '40px 20px', 'repeat'),
    single('raster-end-edge-offset', 'right 10px bottom 20px'),
    single('raster-edge-percent', 'right 20% bottom 25%'),
    single('raster-three-tokens', 'bottom 10px right'),
    single('raster-cover-px', '10px 0', 'cover'),
    single('raster-contain-end-edge', 'right 10px bottom', 'contain'),
    single('raster-oversize-percent', '25% 75%', '160px 100px'),
    single('raster-auto-px', '20px 10px', 'auto'),
    single('svg-edge-offset', 'right 10px bottom 20px', '40px 20px', 'no-repeat', svgImage),
    single('svg-percent', '25% 75%', '40px 20px', 'no-repeat', svgImage),
    single('gradient-edge-offset', 'right 10px bottom 20px', '40px 20px', 'no-repeat', gradient),
    single('gradient-px-repeat-x', '10px 20px', '40px 20px', 'repeat-x', gradient),
    {
      id:'layered-independent-offsets', backgroundImage:gradient+', '+rasterImage,
      backgroundColor:'#ffffff', backgroundSize:'40px 20px, 40px 20px',
      backgroundPosition:'left 10px top 10px, right 10px bottom 10px',
      backgroundRepeat:'no-repeat', expectedImageLayerCount:2,
    },
  ];
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const localPage = [
  '<!doctype html>',
  '<html lang="en"><head>',
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<link rel="icon" href="data:,"><title>CSS raster background size oracle</title>',
  '<style>',
  'html,body{margin:0;padding:0;overflow:hidden;}',
  'body{background:#ddd;}',
  '#target{display:block;box-sizing:border-box;width:120px;height:80px;margin:0;border:0;padding:0;}',
  '</style></head><body><div id="target"></div>',
  '<script>window.rasterBackgroundPageReady=true;</script></body></html>',
].join('');
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
const origin = 'http://127.0.0.1:' + address.port;

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
  await page.goto(origin + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.rasterBackgroundPageReady === true);
  await page.evaluate(async dataUris => {
    for (const dataUri of dataUris) {
      const image = new Image();
      image.src = dataUri;
      await image.decode();
    }
  }, [rasterDataUri, tinyRasterDataUri]);

  const cases = buildCases();
  const points = sampleYs.flatMap(y => sampleXs.map(x => ({ x, y })));
  const captures = [];

  for (const testCase of cases) {
    const measured = await page.evaluate(async ({ testCase, points }) => {
      const target = document.querySelector('#target');
      target.removeAttribute('style');
      target.style.width = '120px';
      target.style.height = '80px';
      target.style.backgroundImage = testCase.backgroundImage;
      target.style.backgroundColor = testCase.backgroundColor;
      target.style.backgroundSize = testCase.backgroundSize;
      target.style.backgroundPosition = testCase.backgroundPosition;
      target.style.backgroundRepeat = testCase.backgroundRepeat;
      if (!target.style.backgroundPosition) throw new Error('Invalid position '+testCase.backgroundPosition);
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
          backgroundRepeatX: style.backgroundRepeatX,
          backgroundRepeatY: style.backgroundRepeatY,
          backgroundOrigin: style.backgroundOrigin,
          backgroundClip: style.backgroundClip,
          backgroundAttachment: style.backgroundAttachment,
          backgroundBlendMode: style.backgroundBlendMode,
        },
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
        effectivePerImageLayer: imageLayers.map((image, index) => ({
          index,
          image,
          size: sizeLayers[index % sizeLayers.length],
          position: positionLayers[index % positionLayers.length],
          repeat: repeatLayers[index % repeatLayers.length],
          authoredSizeListIndex: index % authoredSizeLayers.length,
          authoredPositionListIndex: index % authoredPositionLayers.length,
          authoredRepeatListIndex: index % authoredRepeatLayers.length,
        })),
      };
    }, { testCase, points });
    assert.deepEqual(measured.rect, { x: 0, y: 0, width: box.width, height: box.height }, testCase.id + ': unexpected element bounds');
    assert.equal(measured.imageLayers.length, testCase.expectedImageLayerCount, testCase.id + ': invalid CSS image declaration');

    const screenshot = await page.locator('#target').screenshot({ omitBackground: false, animations: 'disabled' });
    const pixelCapture = await page.evaluate(async ({ png, points }) => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + png;
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
    assert.equal(pixelCapture.width, box.width, testCase.id + ': screenshot width changed');
    assert.equal(pixelCapture.height, box.height, testCase.id + ': screenshot height changed');

    captures.push({
      id: testCase.id,
      element: { width: testCase.width ?? box.width, height: testCase.height ?? box.height },
      authoredCss: {
        backgroundImage: testCase.backgroundImage,
        backgroundColor: testCase.backgroundColor,
        backgroundSize: testCase.backgroundSize,
        backgroundPosition: testCase.backgroundPosition,
        backgroundRepeat: testCase.backgroundRepeat,
      },
      computedBackgroundLonghands: measured.computedStyle,
      computedBackgroundImageSha256: sha256(measured.computedStyle.backgroundImage),
      imageLayers: measured.imageLayers,
      authoredBackgroundPropertyListCounts: measured.authoredBackgroundPropertyListCounts,
      computedBackgroundPropertyListCounts: measured.computedBackgroundPropertyListCounts,
      effectivePerImageLayer: measured.effectivePerImageLayer,
      screenshot: {
        width: pixelCapture.width,
        height: pixelCapture.height,
        mimeType: 'image/png',
        deviceScaleFactor: 1,
        byteLength: screenshot.byteLength,
        sha256: sha256(screenshot),
      },
      sampleGrid: { x: sampleXs, y: sampleYs },
      pixelSamples: pixelCapture.samples,
    });
  }

  assert.deepEqual(browserErrors, [], 'unexpected browser errors');
  assert.equal(captures.length, 17);
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
      method: 'Playwright on localhost; each 120x80 element is captured as a Chrome screenshot and RGBA values are read back from those PNG bytes in Chrome.',
    },
    assets: [{
      id: 'png-red-blue-40x20',
      mimeType: 'image/png',
      dataUri: rasterDataUri,
      width: 40,
      height: 20,
      byteLength: rasterBytes.byteLength,
      sha256: sha256(rasterBytes),
      description: 'Opaque red left half and blue right half; the data URI is embedded for replay.',
    }, {
      id: 'png-green-1x1',
      mimeType: 'image/png',
      dataUri: tinyRasterDataUri,
      width: 1,
      height: 1,
      byteLength: tinyRasterBytes.byteLength,
      sha256: sha256(tinyRasterBytes),
      description: 'Opaque #16a085 pixel, repeated as a 0.25px by 0.25px background.',
    }],
    interpretation: {
      raster: 'The 40x20 asset has opaque red pixels in x=0..19 and blue pixels in x=20..39. The additional asset is a single opaque #16a085 pixel.',
      sizing: 'Cases cover explicit dimensions, one auto axis, percentage dimensions, independent stretching, zero width, and a 0.25px by 0.25px background repeated across the element. Computed longhands preserve Chrome values.',
      positionsAndRepeat: 'Position cases include center, right, and bottom anchoring; repeat cases include repeat-x, repeat-y, and repeat in both axes.',
      alphaComposition: 'The final case places a half-alpha green gradient over the raster image; sampled output is recorded from the Chrome screenshot PNG.',
      screenshotPixels: 'Pixel RGBA values come from the actual PNG bytes returned by locator.screenshot(); no manually calculated pixel values are used as expected results.',
      sampling: 'The normal-size raster samples avoid principal image, tile, and red/blue split boundaries. The tiny repeat case uses the same 96 integer device-pixel locations to capture the rendered texture after many subpixel tiles contribute to each sample.',
    },
    cases: captures,
    coverage: {
      caseCount: captures.length,
      samplesPerCase: sampleXs.length * sampleYs.length,
      totalPixelSamples: captures.length * sampleXs.length * sampleYs.length,
      sampleGrid: { x: sampleXs, y: sampleYs },
      sizeCases: [
        'size-60px-40px',
        'size-60px-auto',
        'size-auto-40px',
        'size-50-percent-50-percent',
        'size-30-percent-auto',
        'size-stretch-80px-20px',
        'zero-width-zero-px-40px',
        'tiny-repeat-quarter-pixel',
      ],
      positionCases: [
        'position-center-center',
        'repeat-y-left-bottom',
        'raster-with-alpha-gradient-right-top',
      ],
      repeatCases: [
        'repeat-x-left-top',
        'repeat-y-left-bottom',
        'repeat-both-axes',
        'tiny-repeat-quarter-pixel',
      ],
      alphaRasterLayerCase: 'raster-with-alpha-gradient-right-top',
      tinyRepeatCase: 'tiny-repeat-quarter-pixel',
    },
  };
  await writeFile(outputPath, JSON.stringify(expected, null, 2) + '\n');
  console.log(JSON.stringify({
    browser: expected.browser.version,
    configuration: '390-light-1',
    cases: captures.map(testCase => ({
      id: testCase.id,
      backgroundSize: testCase.computedBackgroundLonghands.backgroundSize,
      backgroundPosition: testCase.computedBackgroundLonghands.backgroundPosition,
      backgroundRepeat: testCase.computedBackgroundLonghands.backgroundRepeat,
      samples: testCase.pixelSamples.length,
      screenshotSha256: testCase.screenshot.sha256,
    })),
    assets: [
      { id: 'png-red-blue-40x20', byteLength: rasterBytes.byteLength, sha256: sha256(rasterBytes) },
      { id: 'png-green-1x1', byteLength: tinyRasterBytes.byteLength, sha256: sha256(tinyRasterBytes) },
    ],
    outputPath,
  }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
}

