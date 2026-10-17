import { requireTestBrowserExecutable } from './test_browser.mjs';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '../../../..');
const requireFromGateway = createRequire(path.join(projectRoot, 'apps/gateway/package.json'));
const { chromium } = requireFromGateway('playwright-core');
const outputPath = path.resolve(projectRoot, 'fixtures/mobile-parity/svg-backgrounds.json');
const chromePath =
  requireTestBrowserExecutable(process.env.PIRC_CHROME_PATH);

const box = { width: 120, height: 80 };
const svgAssets = {
  fixed: svgDocument('width="40" height="20"'),
  viewboxOnly: svgDocument(''),
  widthOnly: svgDocument('width="40"'),
  noDimensions: svgDocumentNoViewBox(''),
  widthOnlyNoViewBox: svgDocumentNoViewBox('width="40"'),
  heightOnlyNoViewBox: svgDocumentNoViewBox('height="40"'),
};

const cases = [
  svgCase('fixed-auto-repeat', 'fixed', 'auto', 'repeat'),
  svgCase('fixed-auto-no-repeat', 'fixed', 'auto', 'no-repeat'),
  svgCase('fixed-auto-centered-no-repeat', 'fixed', 'auto', 'no-repeat', 'center center'),
  svgCase('fixed-cover-no-repeat', 'fixed', 'cover', 'no-repeat'),
  svgCase('fixed-cover-centered-no-repeat', 'fixed', 'cover', 'no-repeat', 'center center'),
  svgCase('fixed-cover-repeat', 'fixed', 'cover', 'repeat'),
  svgCase('fixed-contain-no-repeat', 'fixed', 'contain', 'no-repeat'),
  svgCase('fixed-contain-centered-no-repeat', 'fixed', 'contain', 'no-repeat', 'center center'),
  svgCase('fixed-contain-repeat', 'fixed', 'contain', 'repeat'),
  svgCase('viewbox-only-auto-repeat', 'viewboxOnly', 'auto', 'repeat'),
  svgCase('viewbox-only-auto-no-repeat', 'viewboxOnly', 'auto', 'no-repeat'),
  svgCase('width-only-auto-repeat', 'widthOnly', 'auto', 'repeat'),
  svgCase('width-only-auto-no-repeat', 'widthOnly', 'auto', 'no-repeat'),
  svgCase('width-only-no-viewbox-auto-no-repeat', 'widthOnlyNoViewBox', 'auto', 'no-repeat'),
  svgCase('width-only-no-viewbox-contain-no-repeat', 'widthOnlyNoViewBox', 'contain', 'no-repeat'),
  svgCase('width-only-no-viewbox-cover-no-repeat', 'widthOnlyNoViewBox', 'cover', 'no-repeat'),
  svgCase('height-only-no-viewbox-auto-no-repeat', 'heightOnlyNoViewBox', 'auto', 'no-repeat'),
  svgCase('height-only-no-viewbox-contain-no-repeat', 'heightOnlyNoViewBox', 'contain', 'no-repeat'),
  svgCase('height-only-no-viewbox-cover-no-repeat', 'heightOnlyNoViewBox', 'cover', 'no-repeat'),
  svgCase('no-dimensions-no-viewbox-auto-no-repeat', 'noDimensions', 'auto', 'no-repeat'),
  svgCase('no-dimensions-no-viewbox-contain-no-repeat', 'noDimensions', 'contain', 'no-repeat'),
  svgCase('no-dimensions-no-viewbox-cover-no-repeat', 'noDimensions', 'cover', 'no-repeat'),
];

function svgDocument(intrinsicAttributes) {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${intrinsicAttributes} viewBox="0 0 40 20">
    <rect width="40" height="20" fill="#ffffff"/>
    <rect width="20" height="10" fill="#ff0000"/>
    <rect x="20" width="20" height="10" fill="#00aa00"/>
    <rect y="10" width="20" height="10" fill="#0000ff"/>
    <rect x="20" y="10" width="20" height="10" fill="#ffff00"/>
    <circle cx="20" cy="10" r="2" fill="#000000"/>
  </svg>`;
}

function svgDocumentNoViewBox(intrinsicAttributes) {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${intrinsicAttributes}>
    <rect width="100%" height="100%" fill="#ffffff"/>
    <rect width="50%" height="50%" fill="#ff0000"/>
    <rect x="50%" width="50%" height="50%" fill="#00aa00"/>
    <rect y="50%" width="50%" height="50%" fill="#0000ff"/>
    <rect x="50%" y="50%" width="50%" height="50%" fill="#ffff00"/>
    <circle cx="50%" cy="50%" r="8" fill="#000000"/>
  </svg>`;
}

function svgCase(id, asset, size, repeat, position = 'left top') {
  return { id, asset, size, repeat, position, ...box };
}

const sampleXs = [0, 10, 20, 40, 50, 60, 70, 80, 100, 119];
const sampleYs = [0, 10, 20, 40, 60, 79];
const points = sampleYs.flatMap((y) => sampleXs.map((x) => [x, y]));

const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath,
  args: ['--no-sandbox'],
});

try {
  const captured = [];
  for (const testCase of cases) {
    const svg = svgAssets[testCase.asset];
    const dataUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    const page = await browser.newPage({
      viewport: { width: box.width + 8, height: box.height + 8 },
      deviceScaleFactor: 1,
    });
    await page.route('**/*', (route) => route.abort());
    await page.setContent('<!doctype html><html><body></body></html>');
    const intrinsic = await page.evaluate(async ({ dataUrl, testCase }) => {
      document.documentElement.style.cssText = 'margin:0;padding:0;overflow:hidden';
      document.body.style.cssText = 'margin:0;padding:0;overflow:hidden';
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const target = document.createElement('div');
      target.id = 'target';
      target.style.cssText = [
        `width:${testCase.width}px`,
        `height:${testCase.height}px`,
        'background-color:#eeeeee',
        `background-image:url("${dataUrl}")`,
        `background-size:${testCase.size}`,
        `background-position:${testCase.position}`,
        `background-repeat:${testCase.repeat}`,
      ].join(';');
      document.body.append(target);
      const rect = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      return {
        intrinsicWidth: image.naturalWidth,
        intrinsicHeight: image.naturalHeight,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        computedStyle: {
          backgroundSize: style.backgroundSize,
          backgroundPosition: style.backgroundPosition,
          backgroundRepeat: style.backgroundRepeat,
          backgroundColor: style.backgroundColor,
          backgroundImageIsDataSvg: style.backgroundImage.startsWith('url("data:image/svg+xml'),
        },
      };
    }, { dataUrl, testCase });

    const screenshot = await page.locator('#target').screenshot({
      omitBackground: false,
      animations: 'disabled',
    });
    const capturedPixels = await page.evaluate(async ({ base64, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const pixelAt = (x, y) => [...context.getImageData(x, y, 1, 1).data];
      return points.map(([x, y]) => ({ x, y, rgba: pixelAt(x, y) }));
    }, { base64: screenshot.toString('base64'), points });

    const samples = capturedPixels.filter(({ x }) => x >= 0);
    const pixelMap = new Map(samples.map((sample) => [`${sample.x},${sample.y}`, sample.rgba]));
    const topLeft = pixelMap.get('0,0');
    const rowPixels = await page.evaluate(async ({ base64, width }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const row = (y) => Array.from({ length: width }, (_, x) => [...context.getImageData(x, y, 1, 1).data]);
      const column = (x) => Array.from({ length: 80 }, (_, y) => [...context.getImageData(x, y, 1, 1).data]);
      return { row: row(0), column: column(0) };
    }, { base64: screenshot.toString('base64'), width: testCase.width });
    const firstChange = (pixels) => pixels.findIndex((rgba) => rgba.some((channel, index) => channel !== topLeft[index]));
    const halfWidthBoundary = firstChange(rowPixels.row);
    const halfHeightBoundary = firstChange(rowPixels.column);
    const measuredTileSize = testCase.size === 'auto' && testCase.position === 'left top' &&
      halfWidthBoundary > 0 && halfHeightBoundary > 0
      ? { width: halfWidthBoundary * 2, height: halfHeightBoundary * 2 }
      : null;
    const measuredPaintedBounds = testCase.repeat === 'no-repeat'
      ? await page.evaluate(async ({ base64, background }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${base64}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          context.drawImage(image, 0, 0);
          const data = context.getImageData(0, 0, image.width, image.height).data;
          let left = image.width;
          let top = image.height;
          let right = -1;
          let bottom = -1;
          for (let y = 0; y < image.height; y++) {
            for (let x = 0; x < image.width; x++) {
              const offset = (y * image.width + x) * 4;
              if (data[offset] === background[0] && data[offset + 1] === background[1] &&
                  data[offset + 2] === background[2] && data[offset + 3] === 255) continue;
              left = Math.min(left, x);
              top = Math.min(top, y);
              right = Math.max(right, x + 1);
              bottom = Math.max(bottom, y + 1);
            }
          }
          return right < 0 ? null : { x: left, y: top, width: right - left, height: bottom - top };
        }, { base64: screenshot.toString('base64'), background: [238, 238, 238] })
      : null;

    captured.push({
      id: testCase.id,
      svgAsset: testCase.asset,
      css: {
        width: `${testCase.width}px`,
        height: `${testCase.height}px`,
        backgroundSize: testCase.size,
        backgroundPosition: testCase.position,
        backgroundRepeat: testCase.repeat,
      },
      intrinsicImageSize: {
        width: intrinsic.intrinsicWidth,
        height: intrinsic.intrinsicHeight,
      },
      autoTileSizeFromRenderedColorBoundaries: measuredTileSize,
      noRepeatPaintedBounds: measuredPaintedBounds,
      box: intrinsic.rect,
      computedStyle: intrinsic.computedStyle,
      screenshot: {
        width: testCase.width,
        height: testCase.height,
        mimeType: 'image/png',
        sha256: createHash('sha256').update(screenshot).digest('hex'),
        base64: screenshot.toString('base64'),
      },
      samples,
    });
    await page.close();
  }

  writeFileSync(
    outputPath,
    `${JSON.stringify({
      reference: {
        webCommit: 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c',
        browser: browser.version(),
        capture: 'Local Chrome SVG image/background rendering; all page requests blocked; static data URLs only.',
        autoSizingNote: 'img naturalWidth/naturalHeight are recorded separately; ratio-only SVG backgrounds use the positioning-area contain constraint, SVGs with no intrinsic dimensions or ratio use the positioning area as their concrete size, and SVGs with one intrinsic axis but no ratio use the positioning area for the missing auto axis. autoTileSizeFromRenderedColorBoundaries is derived from screenshot transitions.',
        deviceScaleFactor: 1,
        sampleGrid: { x: sampleXs, y: sampleYs },
        svgAssets,
      },
      cases: captured,
    }, null, 2)}\n`,
  );
  console.log(`Wrote ${captured.length} SVG background references to ${outputPath}`);
} finally {
  await browser.close();
}
