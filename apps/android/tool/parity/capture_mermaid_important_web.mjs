import { requireTestBrowserExecutable } from './test_browser.mjs';
// Actual pinned Pirc Markdown/Mermaid rendering; native Flutter is tested separately.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { chromium } from '../../../gateway/node_modules/playwright-core/index.mjs';

const root = resolve(import.meta.dirname, '../../../..');
const baseline = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
execFileSync(
  'git',
  [
    'diff',
    '--quiet',
    baseline,
    '--',
    'apps/web/src/lib/markdown.ts',
    'apps/web/src/app.css',
    'apps/web/src/markdown.css',
    'apps/web/package.json',
  ],
  { cwd: root },
);
const fixture = JSON.parse(
  await readFile(resolve(root, 'fixtures/mobile-parity/mermaid-important-cases.json'), 'utf8'),
);
const output = resolve(root, 'apps/android/build/parity-acceptance/important-mermaid-chrome');
await mkdir(output, { recursive: true });
const server = await createServer({
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  cacheDir: resolve(output, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port: 18927,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'native-diagram-reference',
      configureServer(vite) {
        vite.middlewares.use('/diagram-reference.html', async (_, res, next) => {
          try {
            const boot = [
              "import '/src/app.css';",
              "import '/src/markdown.css';",
              "import {preloadRenderers,renderMarkdown,enhanceMarkdown} from '/src/lib/markdown.ts';",
              `(${bootstrap.toString()})(preloadRenderers,renderMarkdown,enhanceMarkdown);`,
            ].join('\n');
            res.setHeader('Content-Type', 'text/html');
            res.end(
              await vite.transformIndexHtml(
                '/diagram-reference.html',
                `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:"><style>body{overflow:auto!important}#fixture{padding:16px;font-family:Arial;font-size:15px;line-height:1.65;--font-mono:Menlo,monospace}</style></head><body><main id="fixture" class="markdown"></main><script type="module">${boot}</script></body></html>`,
              ),
            );
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});
function bootstrap(preload, render, enhance) {
  const root = document.querySelector('#fixture');
  let action;
  window.renderReference = async (source, fontScale) => {
    root.style.fontSize = `${15 * fontScale}px`;
    const fence = String.fromCharCode(96).repeat(3),
      html = render(`${fence}mermaid\n${source}\n${fence}`);
    root.innerHTML = html;
    action = enhance(root, { html, ready: true });
    const block = root.querySelector('.mermaid-block');
    for (let i = 0; i < 600 && !['ok', 'error'].includes(block?.dataset.rendered); i++)
      await new Promise((r) => setTimeout(r, 10));
    if (block?.dataset.rendered !== 'ok')
      throw new Error(block?.querySelector('.mermaid-error')?.textContent ?? 'diagram timeout');
    await document.fonts.ready;
    const svg = block.querySelector('svg');
    const rect = (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const bbox = (e) => {
      try {
        const b = e.getBBox();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      } catch {
        return null;
      }
    };
    const shape = (e) => {
      const style = getComputedStyle(e);
      return {
        tag: e.tagName,
        class: e.getAttribute('class'),
        text: e.textContent?.trim(),
        bbox: bbox(e),
        attributes: Object.fromEntries(
          ['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'd', 'points', 'transform'].flatMap((n) =>
            e.hasAttribute(n) ? [[n, e.getAttribute(n)]] : [],
          ),
        ),
        paint: {
          fill: style.fill,
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
          color: style.color,
          fontSize: style.fontSize,
        },
      };
    };
    const result = {
      status: block.dataset.rendered,
      sourceDisplay: getComputedStyle(block.querySelector('.mermaid-source')).display,
      box: rect(svg),
      viewBox: svg.getAttribute('viewBox'),
      labels: [...svg.querySelectorAll('text,foreignObject')].map(shape),
      shapes: [...svg.querySelectorAll('path,rect,circle,polygon,line')].map(shape),
      title: svg.querySelector('title')?.textContent ?? '',
      description: svg.querySelector('desc')?.textContent ?? '',
    };
    action?.destroy();
    return result;
  };
  preload()
    .then(() => {
      window.referenceReady = true;
    })
    .catch((error) => {
      window.referenceError = error.toString();
    });
}
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath:
      requireTestBrowserExecutable(process.env.CHROME_PATH),
    headless: true,
  });
  const captures = [];
  for (const colorScheme of ['light', 'dark'])
    for (const width of [390, 768])
      for (const item of fixture.cases) {
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          deviceScaleFactor: 1,
          colorScheme,
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        try {
          await page.goto('http://127.0.0.1:18927/diagram-reference.html');
          await page.waitForFunction(() => window.referenceReady || window.referenceError);
          const result = await page.evaluate(
            ({ source }) => window.renderReference(source, 1),
            item,
          );
          assert.equal(result.status, 'ok');
          assert(result.box.width > 0 && result.box.height > 0);
          assert.equal(result.sourceDisplay, 'none');
          captures.push({
            id: item.id,
            family: item.family,
            source: item.source,
            width,
            colorScheme,
            browser: await browser.version(),
            ...result,
            pageErrors: errors,
          });
          await page
            .locator('.mermaid-block')
            .screenshot({ path: resolve(output, `${item.id}-${width}-${colorScheme}.png`) });
          console.log(
            `${item.id}/${width}/${colorScheme}: ${result.box.width}x${result.box.height}; ${result.labels.length} labels`,
          );
        } finally {
          await context.close();
        }
      }
  await writeFile(
    resolve(root, 'fixtures/mobile-parity/mermaid-important-web.json'),
    JSON.stringify(
      {
        baselineCommit: baseline,
        mermaidVersion: '11.17.2',
        scope:
          'Actual local Chrome with pinned production renderMarkdown/enhanceMarkdown. SVG coordinates and text are browser reference; native implementation has separate acceptance.',
        captures,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser?.close();
  await server.close();
}
