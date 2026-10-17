import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const fixturePath = path.join(
  repositoryRoot,
  'fixtures/mobile-parity/document-canvas-cases.json',
);
const outputPath = path.join(
  repositoryRoot,
  'apps/android/build/parity-acceptance/document-canvas-20261015/browser-oracle.json',
);
const nativeSnapshotsPath = path.join(
  repositoryRoot,
  'apps/android/build/parity-acceptance/document-canvas-20261015/native-snapshots.json',
);
const runtimeAssetPath = path.join(
  repositoryRoot,
  'apps/android/assets/document-script-runtime.js',
);
const fixtureBytes = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
assert.ok(Array.isArray(fixture.cases), 'Fixture must contain a cases array.');
assert.ok(fixture.cases.length > 0, 'Fixture must contain at least one case.');

const caseIds = new Set();
for (const testCase of fixture.cases) {
  assert.ok(testCase.id && !caseIds.has(testCase.id), `Missing or duplicate case id: ${testCase.id}`);
  caseIds.add(testCase.id);
  assert.ok(Number.isInteger(testCase.width) && testCase.width > 0, `Invalid width in ${testCase.id}`);
  assert.ok(Number.isInteger(testCase.height) && testCase.height > 0, `Invalid height in ${testCase.id}`);
  assert.ok(typeof testCase.script === 'string', `Missing script in ${testCase.id}`);
  assert.ok(Array.isArray(testCase.samples), `Missing samples in ${testCase.id}`);
  for (const point of testCase.samples) {
    assert.ok(
      Array.isArray(point) &&
        point.length === 2 &&
        point.every(Number.isInteger) &&
        point[0] >= 0 &&
        point[0] < testCase.width &&
        point[1] >= 0 &&
        point[1] < testCase.height,
      `Sample point is outside the initial canvas in ${testCase.id}: ${JSON.stringify(point)}`,
    );
  }
}

const require = createRequire(import.meta.url);
const gatewayDirectory = path.join(repositoryRoot, 'apps/gateway');
const playwrightEntry = require.resolve('playwright-core', {
  paths: [gatewayDirectory],
});
const playwrightDirectory = path.dirname(playwrightEntry);
const playwrightVersion = JSON.parse(
  readFileSync(path.join(playwrightDirectory, 'package.json'), 'utf8'),
).version;
const { chromium } = require(playwrightEntry);
const browserExecutable = [
  requireTestBrowserExecutable(),
  chromium.executablePath(),
].find((candidate) => candidate && existsSync(candidate));
if (browserExecutable == null) {
  throw new Error('No local Chrome or Playwright Chromium executable is available.');
}

const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
});
try {
  const page = await browser.newPage();
  const results = [];
  for (const testCase of fixture.cases) {
    const result = await page.evaluate((input) => {
      const canvas = document.createElement('canvas');
      canvas.width = input.width;
      canvas.height = input.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context == null) {
        throw new Error('The browser did not provide a 2D canvas context.');
      }

      const execute = new Function('context', 'canvas', input.script);
      execute(context, canvas);

      const samples = input.samples.map(([x, y]) => ({
        x,
        y,
        rgba: Array.from(context.getImageData(x, y, 1, 1).data),
      }));
      const output = {
        id: input.id,
        width: canvas.width,
        height: canvas.height,
        samples,
      };

      if (input.id.includes('text-bounds')) {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        let left = canvas.width;
        let top = canvas.height;
        let right = -1;
        let bottom = -1;
        const textInkRows = [];
        for (let y = 0; y < canvas.height; y += 1) {
          let rowLeft = canvas.width;
          let rowRight = -1;
          let rowCount = 0;
          for (let x = 0; x < canvas.width; x += 1) {
            const alpha = pixels.data[(y * canvas.width + x) * 4 + 3];
            if (alpha === 0) continue;
            rowLeft = Math.min(rowLeft, x);
            rowRight = Math.max(rowRight, x);
            rowCount += 1;
          }
          if (rowCount > 0) {
            left = Math.min(left, rowLeft);
            right = Math.max(right, rowRight);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
            textInkRows.push({
              y,
              left: rowLeft,
              right: rowRight,
              nonTransparentPixels: rowCount,
            });
          }
        }
        output.textInkBounds =
          right < left ? null : { left, top, right, bottom };
        output.textInkRows = textInkRows;
        output.textInkNote =
          'Bounding box and per-row ink counts are layout evidence only; glyph pixels are not compared.';
      }

      return output;
    }, testCase);
    assert.equal(result.id, testCase.id);
    assert.ok(result.width > 0 && result.height > 0, `Canvas has invalid size in ${testCase.id}`);
    for (const sample of result.samples) {
      assert.ok(
        sample.x < result.width && sample.y < result.height,
        `Sample point is outside the final canvas in ${testCase.id}`,
      );
    }
    results.push(result);
  }

  const canvasCssGeometry = await page.evaluate(() => {
    const definitions = [
      { id: 'width-only', style: { width: '240px' } },
      { id: 'height-only', style: { height: '90px' } },
      { id: 'width-height-border-padding', style: {
        width: '240px', height: '90px', border: '2px solid black', padding: '3px'
      } },
    ];
    return definitions.map(({ id, style }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 60;
      Object.assign(canvas.style, style);
      document.body.appendChild(canvas);
      const computed = getComputedStyle(canvas);
      const rect = canvas.getBoundingClientRect();
      const result = {
        id,
        bitmap: { width: canvas.width, height: canvas.height },
        computed: {
          width: computed.width,
          height: computed.height,
          boxSizing: computed.boxSizing,
          padding: computed.padding,
          borderWidth: computed.borderWidth,
        },
        layout: {
          width: rect.width,
          height: rect.height,
          clientWidth: canvas.clientWidth,
          clientHeight: canvas.clientHeight,
          offsetWidth: canvas.offsetWidth,
          offsetHeight: canvas.offsetHeight,
        },
        devicePixelRatio: window.devicePixelRatio,
      };
      canvas.remove();
      return result;
    });
  });

  const report = {
    generatedAt: new Date().toISOString(),
    source: {
      browser: browserExecutable.includes('Google Chrome')
        ? 'Google Chrome'
        : 'Playwright Chromium',
      version: await browser.version(),
      executablePath: browserExecutable,
      playwrightCoreVersion: playwrightVersion,
    },
    canvasCssGeometry,
    fixture: {
      path: path.relative(repositoryRoot, fixturePath),
      sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
      caseCount: fixture.cases.length,
    },
    cases: results,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `Wrote ${results.length} browser Canvas2D cases to ${path.relative(repositoryRoot, outputPath)}\n`,
  );
  const runtimeBytes = readFileSync(runtimeAssetPath);
  const runtimeSource = runtimeBytes.toString('utf8');
  const runtimeCases = [];
  for (let index = 0; index < fixture.cases.length; index += 1) {
    const testCase = fixture.cases[index];
    const vmContext = vm.createContext({});
    new vm.Script(runtimeSource, { filename: runtimeAssetPath }).runInContext(vmContext);
    const html =
      '<canvas id="' +
      testCase.id +
      '" width="' +
      testCase.width +
      '" height="' +
      testCase.height +
      '"></canvas><script>const canvas=document.querySelector("canvas");' +
      'const context=canvas.getContext("2d");' +
      testCase.script +
      '</script>';
    const rawInit = vmContext.__pircDocument.init({
      html,
      url: 'https://document-canvas.test/' + encodeURIComponent(testCase.id),
      now: 0,
    });
    const initResult = JSON.parse(rawInit);
    const errorDiagnostics = initResult.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error',
    );
    assert.deepEqual(
      errorDiagnostics,
      [],
      `The generated runtime reported an error for ${testCase.id}: ${JSON.stringify(errorDiagnostics)}`,
    );
    assert.equal(
      initResult.canvases.length,
      1,
      `The generated runtime should report exactly one canvas for ${testCase.id}`,
    );
    const canvasSnapshot = initResult.canvases[0];
    runtimeCases.push({
      id: testCase.id,
      browser: report.cases[index],
      canvas: canvasSnapshot,
      diagnostics: initResult.diagnostics,
    });
  }

  const nativeSnapshots = {
    generatedAt: new Date().toISOString(),
    fixture: report.fixture,
    browserOracle: {
      path: path.relative(repositoryRoot, outputPath),
      source: report.source,
      canvasCssGeometry: report.canvasCssGeometry,
    },
    runtime: {
      path: path.relative(repositoryRoot, runtimeAssetPath),
      sha256: createHash('sha256').update(runtimeBytes).digest('hex'),
    },
    cases: runtimeCases,
  };
  await writeFile(
    nativeSnapshotsPath,
    `${JSON.stringify(nativeSnapshots, null, 2)}\n`,
  );
  process.stdout.write(
    `Wrote ${runtimeCases.length} generated-runtime canvas snapshots to ${path.relative(repositoryRoot, nativeSnapshotsPath)}\n`,
  );
} finally {
  await browser.close();
}
