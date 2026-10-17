import { requireTestBrowserExecutable } from './test_browser.mjs';
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
  'fixtures/mobile-parity/html-background-gradients.json',
);
const chromePath =
  requireTestBrowserExecutable(process.env.PIRC_CHROME_PATH);

const cases = [
  {
    id: 'linear-default',
    css: 'linear-gradient(red, blue)',
    width: 120,
    height: 80,
    points: [[60, 0], [60, 20], [60, 40], [60, 60], [60, 79]],
  },
  {
    id: 'linear-angle-45deg',
    css: 'linear-gradient(45deg, #ff0000, #0000ff)',
    width: 120,
    height: 80,
    points: [[0, 0], [30, 20], [60, 40], [90, 60], [119, 79], [0, 79], [119, 0]],
  },
  {
    id: 'linear-to-corner',
    css: 'linear-gradient(to top right, red, blue)',
    width: 120,
    height: 80,
    points: [[0, 0], [30, 20], [60, 40], [90, 60], [119, 79], [0, 79], [119, 0]],
  },
  {
    id: 'linear-to-corner-wide-box',
    css: 'linear-gradient(to bottom right, red, blue)',
    width: 200,
    height: 100,
    points: [[100, 50], [150, 50], [100, 25], [150, 75], [199, 99], [0, 0], [199, 0]],
  },
  {
    id: 'linear-pixel-hard-stop-alpha',
    css: 'linear-gradient(90deg, rgba(255, 0, 0, 0) 0px 20px, blue 40px 60px, white 100%)',
    width: 160,
    height: 32,
    points: [[0, 16], [10, 16], [20, 16], [30, 16], [40, 16], [50, 16], [60, 16], [100, 16], [159, 16]],
  },
  {
    id: 'radial-default-ellipse',
    css: 'radial-gradient(red, blue)',
    width: 120,
    height: 80,
    points: [[60, 40], [90, 40], [60, 20], [60, 0], [0, 0]],
  },
  {
    id: 'radial-circle-farthest-corner',
    css: 'radial-gradient(circle, red 0%, blue 100%)',
    width: 120,
    height: 80,
    points: [[60, 40], [60, 20], [60, 0], [119, 0], [119, 79]],
  },
  {
    id: 'radial-explicit-ellipse-position',
    css: 'radial-gradient(ellipse 60px 30px at 25% 50%, #00ff00 0%, #000000 100%)',
    width: 120,
    height: 80,
    points: [[30, 40], [45, 40], [60, 40], [90, 40], [30, 10], [30, 70]],
  },
  {
    id: 'radial-circle-pixel-stops',
    css: 'radial-gradient(circle 40px at center, rgba(0, 0, 255, 0.25) 0px, white 40px)',
    width: 120,
    height: 80,
    points: [[60, 40], [60, 20], [60, 0], [100, 40], [101, 40]],
  },
];

const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath,
  args: ['--no-sandbox'],
});

try {
  const captured = [];
  for (const testCase of cases) {
    const page = await browser.newPage({
      viewport: { width: testCase.width, height: testCase.height },
      deviceScaleFactor: 1,
    });
    await page.route('**/*', (route) => route.abort());
    await page.setContent('<!doctype html><html><body></body></html>');
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
    captured.push({
      id: testCase.id,
      css: testCase.css,
      width: testCase.width,
      height: testCase.height,
      ...data,
    });
    await page.close();
  }

  writeFileSync(
    outputPath,
    `${JSON.stringify({
      reference: {
        webCommit: 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c',
        browser: browser.version(),
        capture: 'Local Chrome rendering of real CSS gradients; all page requests blocked.',
        deviceScaleFactor: 1,
        screenshotBackground: 'transparent',
      },
      cases: captured,
    }, null, 2)}\n`,
  );
  console.log(`Wrote ${captured.length} gradient references to ${outputPath}`);
} finally {
  await browser.close();
}
