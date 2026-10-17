import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '../../../..');
const requireFromGateway = createRequire(path.join(projectRoot, 'apps/gateway/package.json'));
const { chromium } = requireFromGateway('playwright-core');
const outputPath = path.resolve(
  projectRoot,
  'fixtures/mobile-parity/html-extended-background-gradients.json',
);
const chromePath =
  requireTestBrowserExecutable(process.env.PIRC_CHROME_PATH);

const cases = [
  {
    id: 'conic-default-red-blue',
    css: 'conic-gradient(in srgb, red, blue)',
    width: 120,
    height: 120,
    points: [[57, 11], [60, 10], [63, 11], [78, 13], [95, 25], [107, 42], [110, 60], [103, 83], [86, 101], [60, 110], [36, 103], [17, 83], [10, 60], [15, 37], [31, 19], [47, 12]],
  },
  {
    id: 'conic-from-angle-three-stops',
    css: 'conic-gradient(from 45deg in srgb, #f00, #0f0 34%, #00f)',
    width: 140,
    height: 140,
    points: [[70, 12], [91, 16], [110, 30], [124, 50], [127, 72], [119, 97], [101, 116], [79, 128], [56, 125], [34, 113], [17, 92], [12, 69], [18, 46], [34, 27], [52, 16], [70, 70]],
  },
  {
    id: 'conic-offcenter-angle-units-and-outside-percent-stops',
    css: 'conic-gradient(from .25turn at 30% 65% in srgb, red -12%, orange 18%, lime 47%, blue 86%, white 118%)',
    width: 160,
    height: 120,
    points: [[48, 12], [66, 18], [82, 34], [94, 57], [90, 82], [74, 103], [51, 112], [26, 101], [10, 82], [5, 57], [9, 35], [27, 20], [48, 58], [69, 68], [43, 90]],
  },
  {
    id: 'conic-double-stops-hard-edges',
    css: 'conic-gradient(at 50% 50% in srgb, red 0deg 72deg, blue 72deg 181deg, lime 181deg 270deg, black 360deg)',
    width: 120,
    height: 120,
    points: [[61, 12], [64, 13], [65, 14], [105, 44], [106, 47], [61, 108], [58, 108], [12, 58], [12, 62], [85, 102], [80, 103], [17, 62], [17, 57], [35, 24], [52, 21], [60, 60]],
  },
  {
    id: 'conic-negative-and-over-one-turn-stops',
    css: 'conic-gradient(from -35deg at 62% 43% in srgb, red -90deg, yellow 15deg, blue 390deg, lime 540deg)',
    width: 150,
    height: 120,
    points: [[93, 8], [113, 13], [133, 33], [143, 52], [139, 78], [118, 101], [93, 111], [68, 96], [50, 76], [49, 49], [61, 28], [78, 16], [93, 51], [114, 66]],
  },
  {
    id: 'conic-transparent-alpha-interpolation',
    css: 'conic-gradient(from 17deg at 40% 60% in srgb, rgba(255, 0, 0, 0) -10deg, rgba(0, 200, 255, .8) 120deg, rgba(255, 255, 0, .35) 250deg, white 1turn)',
    width: 140,
    height: 120,
    points: [[56, 7], [77, 11], [99, 25], [116, 46], [119, 69], [111, 93], [91, 110], [66, 115], [43, 108], [22, 90], [14, 66], [22, 42], [42, 23], [56, 71]],
  },
  {
    id: 'repeating-conic-nondivisor-period',
    css: 'repeating-conic-gradient(from 13deg at center in srgb, red 0deg, blue 83deg, lime 157deg)',
    width: 120,
    height: 120,
    points: [[69, 13], [72, 14], [99, 30], [108, 52], [104, 75], [91, 96], [70, 107], [67, 108], [47, 103], [25, 89], [12, 65], [17, 41], [32, 21], [35, 21], [60, 42], [80, 69], [42, 83]],
  },
  {
    id: 'repeating-conic-negative-start-offcenter',
    css: 'repeating-conic-gradient(from -20deg at 58% 47% in srgb, red -35deg, yellow 27deg, blue 72deg)',
    width: 150,
    height: 120,
    points: [[87, 9], [108, 13], [127, 29], [139, 53], [133, 78], [116, 99], [91, 109], [67, 99], [50, 78], [48, 53], [58, 30], [74, 16], [92, 48], [114, 64], [69, 68]],
  },
  {
    id: 'repeating-linear-pixel-period',
    css: 'repeating-linear-gradient(90deg in srgb, red 0px, blue 26px)',
    width: 144,
    height: 48,
    points: [[4, 24], [13, 24], [25, 24], [29, 24], [39, 24], [51, 24], [55, 24], [65, 24], [77, 24], [81, 24], [91, 24], [103, 24], [107, 24], [117, 24], [129, 24], [139, 24]],
  },
  {
    id: 'repeating-linear-hard-stops-oblique',
    css: 'repeating-linear-gradient(45deg in srgb, red 0px 12px, blue 12px 27px)',
    width: 140,
    height: 100,
    points: [[5, 8], [18, 8], [31, 18], [44, 18], [57, 28], [70, 28], [83, 38], [96, 38], [109, 48], [122, 48], [24, 79], [84, 79], [134, 89], [70, 50]],
  },
  {
    id: 'repeating-linear-percent-stops',
    css: 'repeating-linear-gradient(to right in srgb, red 0%, yellow 20%, blue 45%)',
    width: 160,
    height: 56,
    points: [[3, 28], [14, 28], [29, 28], [36, 28], [48, 28], [62, 28], [70, 28], [83, 28], [98, 28], [108, 28], [121, 28], [136, 28], [147, 28], [157, 28]],
  },
  {
    id: 'repeating-linear-negative-pixel-start',
    css: 'repeating-linear-gradient(0deg in srgb, red -15px, yellow 5px, blue 35px)',
    width: 100,
    height: 100,
    points: [[50, 4], [50, 11], [50, 21], [50, 31], [50, 39], [50, 46], [50, 56], [50, 66], [50, 74], [50, 81], [50, 91], [50, 97], [20, 30], [80, 70]],
  },
  {
    id: 'repeating-linear-zero-period',
    css: 'repeating-linear-gradient(90deg in srgb, red 20px, blue 20px)',
    width: 120,
    height: 40,
    points: [[4, 20], [13, 20], [25, 20], [36, 20], [48, 20], [59, 20], [71, 20], [82, 20], [94, 20], [106, 20], [115, 20], [60, 4]],
  },
  {
    id: 'repeating-radial-circle-pixel-period',
    css: 'repeating-radial-gradient(circle 13px at center in srgb, red 0px, blue 13px)',
    width: 120,
    height: 100,
    points: [[60, 50], [63, 50], [68, 50], [72, 50], [74, 50], [77, 50], [82, 50], [85, 50], [87, 50], [91, 50], [96, 50], [60, 54], [60, 62], [60, 64], [60, 68], [60, 75], [60, 77], [60, 84], [60, 93]],
  },
  {
    id: 'repeating-radial-ellipse-percent-period',
    css: 'repeating-radial-gradient(ellipse 48px 24px at center in srgb, #ff3300 0%, #0044ff 100%)',
    width: 140,
    height: 100,
    points: [[70, 50], [77, 50], [86, 50], [95, 50], [103, 50], [111, 50], [116, 50], [70, 54], [70, 61], [70, 68], [70, 74], [70, 79], [87, 62], [99, 39], [42, 63]],
  },
  {
    id: 'repeating-radial-ellipse-offcenter-alpha',
    css: 'repeating-radial-gradient(ellipse 34px 22px at 28% 60% in srgb, rgba(255, 0, 0, .2) 0px, lime 17px, rgba(0, 0, 255, .65) 43px)',
    width: 150,
    height: 120,
    points: [[42, 18], [50, 23], [59, 34], [66, 48], [68, 72], [59, 90], [44, 101], [27, 96], [17, 78], [16, 55], [23, 35], [42, 61], [52, 60], [38, 73], [79, 62]],
  },
  {
    id: 'repeating-radial-circle-negative-start',
    css: 'repeating-radial-gradient(circle 38px at 72% 42% in srgb, red -9px, yellow 0px, blue 17px)',
    width: 150,
    height: 120,
    points: [[108, 7], [119, 13], [132, 25], [141, 43], [139, 63], [128, 83], [111, 98], [91, 91], [78, 74], [77, 53], [85, 32], [98, 20], [109, 49], [124, 55]],
  },
  {
    id: 'repeating-radial-zero-period',
    css: 'repeating-radial-gradient(circle in srgb, red 10px, blue 10px)',
    width: 120,
    height: 90,
    points: [[60, 45], [63, 45], [72, 45], [84, 45], [96, 45], [108, 45], [60, 49], [60, 58], [60, 69], [60, 81], [25, 25], [100, 20]],
  },
  {
    id: 'conic-default-red-blue-implicit-interpolation',
    css: 'conic-gradient(red, blue)',
    interpolation: 'browser-default',
    width: 120,
    height: 120,
    points: [[57, 11], [60, 10], [63, 11], [78, 13], [95, 25], [107, 42], [110, 60], [103, 83], [86, 101], [60, 110], [36, 103], [17, 83], [10, 60], [15, 37], [31, 19], [47, 12]],
  },
  {
    id: 'repeating-conic-nondivisor-period-implicit-interpolation',
    css: 'repeating-conic-gradient(from 13deg at center, red 0deg, blue 83deg, lime 157deg)',
    interpolation: 'browser-default',
    width: 120,
    height: 120,
    points: [[69, 13], [72, 14], [99, 30], [108, 52], [104, 75], [91, 96], [70, 107], [67, 108], [47, 103], [25, 89], [12, 65], [17, 41], [32, 21], [35, 21], [60, 42], [80, 69], [42, 83]],
  },
  {
    id: 'conic-position-before-angle-header-order',
    css: 'conic-gradient(at 30% 60% from 45deg, red, blue)',
    interpolation: 'browser-default',
    width: 140,
    height: 100,
    points: [[42, 12], [59, 14], [77, 24], [91, 40], [97, 60], [91, 79], [75, 91], [53, 96], [33, 89], [17, 75], [7, 57], [14, 37], [30, 21], [42, 60]],
  },
  {
    id: 'repeating-conic-positive-start-period-over-one-turn',
    css: 'repeating-conic-gradient(red .4turn, blue 1.9turn)',
    interpolation: 'browser-default',
    width: 120,
    height: 120,
    points: [[60, 10], [78, 13], [95, 25], [107, 42], [110, 60], [103, 83], [86, 101], [60, 110], [36, 103], [17, 83], [10, 60], [15, 37], [31, 19], [47, 12], [60, 60]],
  },
];

const layers = [
  {
    id: 'semi-transparent-conic-over-repeating-linear',
    css: 'conic-gradient(from 31deg at 38% 54% in srgb, rgba(255, 0, 0, 0.05) 0deg, rgba(255, 0, 0, .65) 135deg, rgba(0, 80, 255, .3) 1turn), repeating-linear-gradient(45deg in srgb, rgba(0, 180, 90, .7) 0px 12px, rgba(0, 0, 0, .25) 12px 29px)',
    interpolation: 'srgb',
    width: 120,
    height: 100,
    points: [[10, 10], [25, 10], [40, 10], [55, 10], [70, 10], [85, 10], [100, 10], [115, 10], [10, 35], [35, 35], [60, 35], [85, 35], [110, 35], [10, 75], [60, 75], [110, 75]],
  },
  {
    id: 'repeating-radial-over-conic',
    css: 'repeating-radial-gradient(ellipse 42px 25px at 32% 56% in srgb, rgba(255, 170, 0, .45) 0px, rgba(0, 110, 255, .35) 17px, rgba(0, 110, 255, .2) 43px), conic-gradient(from 27deg at 70% 40% in srgb, rgba(180, 0, 255, .4) 0deg, rgba(0, 255, 100, .55) 150deg, rgba(255, 40, 60, .25) 1turn)',
    interpolation: 'srgb',
    width: 150,
    height: 120,
    points: [[10, 10], [35, 10], [60, 10], [85, 10], [110, 10], [140, 10], [10, 40], [35, 40], [60, 40], [85, 40], [110, 40], [140, 40], [10, 75], [35, 75], [60, 75], [85, 75], [110, 75], [140, 75], [10, 110], [60, 110], [110, 110], [140, 110]],
  },
];

const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath,
  args: ['--no-sandbox'],
});

try {
  const captured = [];
  const capturedLayers = [];
  const unsupportedSyntax = [];
  const requests = [
    ...cases.map((testCase) => ({ collection: 'cases', testCase })),
    ...layers.map((testCase) => ({ collection: 'layers', testCase })),
  ];
  for (const { collection, testCase } of requests) {
    assert.ok(testCase.points.length >= 12 && testCase.points.length <= 30, `${testCase.id} sample count`);
    const interpolation = testCase.interpolation ?? 'srgb';
    if (interpolation === 'srgb') {
      assert.match(testCase.css, /\bin srgb\b/, `${testCase.id} must pin interpolation to sRGB`);
    } else {
      assert.equal(interpolation, 'browser-default', `${testCase.id} interpolation label`);
      assert.doesNotMatch(testCase.css, /\bin\s+\w+/, `${testCase.id} must omit the interpolation clause`);
    }
    const page = await browser.newPage({
      viewport: { width: testCase.width, height: testCase.height },
      deviceScaleFactor: 1,
    });
    await page.route('**/*', (route) => route.abort());
    await page.setContent('<!doctype html><html><body></body></html>');
    const browserAcceptsCss = await page.evaluate((css) => CSS.supports('background-image', css), testCase.css);
    if (!browserAcceptsCss) {
      const computed = await page.evaluate(({ css, width, height }) => {
        const box = document.createElement('div');
        box.style.cssText = `width:${width}px;height:${height}px;background-image:${css}`;
        document.body.append(box);
        return {
          inlineBackgroundImage: box.style.backgroundImage,
          computedBackgroundImage: getComputedStyle(box).backgroundImage,
        };
      }, testCase);
      unsupportedSyntax.push({
        collection,
        id: testCase.id,
        css: testCase.css,
        interpolation,
        width: testCase.width,
        height: testCase.height,
        cssSupportsBackgroundImage: false,
        ...computed,
        capture: 'Chrome rejected this CSS declaration; no gradient pixels were captured.',
      });
      await page.close();
      continue;
    }
    await page.evaluate(({ css, width, height }) => {
      document.documentElement.style.cssText =
        'margin:0;padding:0;background:transparent;overflow:hidden';
      document.body.style.cssText =
        'margin:0;padding:0;background:transparent;overflow:hidden';
      const box = document.createElement('div');
      box.id = 'gradient';
      box.style.cssText = `width:${width}px;height:${height}px;background-image:${css}`;
      document.body.append(box);
    }, testCase);

    const screenshot = await page.screenshot({ omitBackground: true });
    const data = await page.evaluate(async ({ base64, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      return {
        computedBackgroundImage: getComputedStyle(document.querySelector('#gradient')).backgroundImage,
        samples: points.map(([x, y]) => ({
          x,
          y,
          rgba: [...context.getImageData(x, y, 1, 1).data],
        })),
      };
    }, { base64: screenshot.toString('base64'), points: testCase.points });
    assert.notEqual(data.computedBackgroundImage, 'none', `${testCase.id} was rejected by Chrome`);
    assert.equal(data.samples.length, testCase.points.length, `${testCase.id} sample capture count`);
    assert.ok(data.samples.some(({ rgba }) => rgba[3] > 0), `${testCase.id} captured only transparent pixels`);
    const reference = {
      id: testCase.id,
      css: testCase.css,
      interpolation,
      width: testCase.width,
      height: testCase.height,
      ...data,
    };
    (collection === 'layers' ? capturedLayers : captured).push(reference);
    await page.close();
  }

  assert.equal(captured.length + capturedLayers.length + unsupportedSyntax.length, requests.length, 'not all extended gradient cases were handled');
  writeFileSync(
    outputPath,
    `${JSON.stringify({
      reference: {
        webCommit: 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c',
        browser: browser.version(),
        capture: 'Local Chrome rendering of real CSS gradients; all page requests blocked.',
        deviceScaleFactor: 1,
        screenshotBackground: 'transparent',
        interpolation: {
          explicit: 'srgb',
          omitted: 'browser-default',
        },
      },
      cases: captured,
      layers: capturedLayers,
      unsupportedSyntax,
    }, null, 2)}\n`,
  );
  console.log(`Wrote ${captured.length} gradient cases, ${capturedLayers.length} layers, and ${unsupportedSyntax.length} unsupported syntax records to ${outputPath}`);
} finally {
  await browser.close();
}
