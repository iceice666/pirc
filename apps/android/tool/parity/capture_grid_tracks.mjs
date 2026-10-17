import { requireTestBrowserExecutable } from './test_browser.mjs';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '../../../..');
const requireFromGateway = createRequire(path.join(projectRoot, 'apps/gateway/package.json'));
const { chromium } = requireFromGateway('playwright-core');
const outputPath = path.resolve(projectRoot, 'fixtures/mobile-parity/html-grid-tracks.json');
const chromePath =
  requireTestBrowserExecutable(process.env.PIRC_CHROME_PATH);
const webCommit = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const colors = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b'];

function makeCase(id, width, gap, rowGap, template, direction, spans) {
  return { id, width, gap, rowGap, template, direction, spans };
}

const cases = [
  makeCase('fixed-and-fractional', 320, 16, 8, '160px 1fr', 'ltr', [1, 1]),
  makeCase('weighted-fractions', 360, 12, 8, '80px 1fr 2fr', 'ltr', [1, 1, 1]),
  makeCase('percentage-and-fraction', 400, 16, 6, '25% 1fr', 'ltr', [1, 1, 1, 1]),
  makeCase('minmax-floor-binds', 220, 12, 8, 'minmax(100px, 1fr) 2fr', 'ltr', [1, 1]),
  makeCase('minmax-floor-does-not-bind', 400, 12, 8, 'minmax(100px, 1fr) 2fr', 'ltr', [1, 1]),
  makeCase('repeated-fixed-and-fractional', 500, 10, 8, 'repeat(2, 100px 1fr)', 'ltr', [1, 1, 1, 1]),
  makeCase('span-two-explicit-tracks', 360, 12, 8, '80px 1fr 2fr', 'ltr', [2, 1, 1]),
  makeCase('full-span-explicit-tracks', 360, 12, 8, '80px 1fr 2fr', 'ltr', [-1, 1]),
  makeCase('row-gap-with-auto-placement', 300, 10, 9, '1fr 1fr', 'ltr', [1, 1, 1, 1, 1]),
  {...makeCase('declared-heights-retain-shorter-card', 300, 10, 8, '1fr 1fr', 'ltr', [1, 1, 1]), heights:[20,40,30]},
  makeCase('rtl-logical-track-order', 360, 12, 8, '80px 1fr 2fr', 'rtl', [1, 1, 1]),
  makeCase('partial-fractions-leave-remainder', 400, 12, 8, '0.2fr 0.2fr', 'ltr', [1, 1]),
  {...makeCase('hidden-leading-full-span', 400, 12, 8, '1fr 1fr', 'ltr', [1, 1]), hiddenLeading: true},
];

for (const [width, childCounts] of [
  [260, [1, 2, 4]],
  [390, [2, 4]],
  [650, [2, 4]],
  [1024, [1, 4]],
]) {
  for (const childCount of childCounts) {
    const spans = Array.from({ length: childCount }, () => 1);
    for (const repeatMode of ['auto-fill', 'auto-fit']) {
      cases.push(
        makeCase(
          `${repeatMode}-${width}px-${childCount}-children`,
          width,
          12,
          8,
          `repeat(${repeatMode}, minmax(120px, 1fr))`,
          'ltr',
          spans,
        ),
      );
    }
  }
}

cases.push(
  makeCase(
    'auto-fit-span-two-retains-occupied-tracks',
    650,
    12,
    8,
    'repeat(auto-fit, minmax(120px, 1fr))',
    'ltr',
    [2, 1],
  ),
  makeCase(
    'auto-fit-full-span-retains-all-tracks',
    650,
    12,
    8,
    'repeat(auto-fit, minmax(120px, 1fr))',
    'ltr',
    [-1, 1],
  ),
);

function makeAuthoredHtml(testCase) {
  const hidden = testCase.hiddenLeading ? '<div style="display:none;grid-column:1 / -1;height:20px"></div>' : '';
  const items = testCase.spans
    .map((span, index) => {
      const itemId = `item-${index + 1}`;
      const spanStyle =
        span === -1 ? 'grid-column:1 / -1;' : span > 1 ? `grid-column:span ${span};` : '';
      return `<div id="${itemId}" data-grid-item="${itemId}" class="grid-item" style="background:${colors[index % colors.length]};${spanStyle}${testCase.heights ? `height:${testCase.heights[index]}px;` : ''}"></div>`;
    })
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;padding:0;overflow:hidden}body{background:transparent}.grid{display:grid;width:${testCase.width}px;min-width:0;margin:0;padding:0;border:0;grid-template-columns:${testCase.template};column-gap:${testCase.gap}px;row-gap:${testCase.rowGap}px;grid-auto-flow:row;grid-auto-rows:auto;align-content:start;align-items:stretch;justify-items:stretch;direction:${testCase.direction}}.grid-item{width:auto;min-width:0;height:20px;min-height:0;margin:0;padding:0;border:0}</style></head><body><div id="grid" class="grid" data-grid-case="${testCase.id}">${hidden}${items}</div></body></html>`;
}

const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath,
  args: ['--no-sandbox'],
});

try {
  const capturedCases = [];
  for (const testCase of cases) {
    const authoredHTML = makeAuthoredHtml(testCase);
    const page = await browser.newPage({
      viewport: { width: 1200, height: 1000 },
      deviceScaleFactor: 1,
    });
    await page.route('**/*', (route) => route.abort());
    await page.setContent(authoredHTML);
    const geometry = await page.evaluate(() => {
      const grid = document.querySelector('[data-grid-case]');
      const gridRect = grid.getBoundingClientRect();
      const round = (value) => Math.round(value * 1000) / 1000;
      return {
        height: round(gridRect.height),
        computedColumns: getComputedStyle(grid).gridTemplateColumns,
        rects: [...grid.querySelectorAll('[data-grid-item]')].map((item) => {
          const rect = item.getBoundingClientRect();
          return {
            id: item.dataset.gridItem,
            x: round(rect.left - gridRect.left),
            y: round(rect.top - gridRect.top),
            width: round(rect.width),
            height: round(rect.height),
          };
        }),
      };
    });
    await page.close();

    capturedCases.push({ ...testCase, authoredHTML, ...geometry });
  }

  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        webCommit,
        oracle: {
          browser: `Google Chrome ${browser.version()}`,
          capture: 'Actual local Chrome CSS Grid layout; dimensions are CSS pixels measured from DOMRect.',
          viewport: { width: 1200, height: 1000 },
          deviceScaleFactor: 1,
          childHeight: 20,
          gap: 'The gap field is column-gap in CSS pixels; rowGap is row-gap in CSS pixels.',
          page: 'Local authored HTML only; external page requests are blocked.',
        },
        cases: capturedCases,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`Wrote ${capturedCases.length} actual Chrome grid cases to ${outputPath}\n`);
} finally {
  await browser.close();
}
