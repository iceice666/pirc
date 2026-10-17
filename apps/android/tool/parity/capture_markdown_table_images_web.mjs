import { requireTestBrowserExecutable } from './test_browser.mjs';
// Real pinned Markdown renderer and production table/image CSS.
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixture = JSON.parse(
  await readFile(resolve(root, 'fixtures/mobile-parity/markdown-images.json'), 'utf8'),
);
assert.equal(fixture.webRevision, revision);
execFileSync('git', ['diff', '--exit-code', revision, '--', 'apps/web'], { cwd: root });
const { chromium } = createRequire(resolve(root, 'apps/gateway/package.json'))('playwright-core');
const output = resolve(root, 'apps/android/build/parity');
await mkdir(output, { recursive: true });
const source = JSON.stringify({ cases: fixture.tableCases }).replaceAll('<', '\\u003c');
const server = await createServer({
  root: resolve(root, 'apps/web'),
  configFile: false,
  cacheDir: resolve(output, 'vite-cache-table-images'),
  server: {
    host: '127.0.0.1',
    port: 18925,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'table-image-parity',
      configureServer(vite) {
        vite.middlewares.use('/images/chart.svg', (_, res) => {
          res.setHeader('Content-Type', 'image/svg+xml');
          res.end(fixture.svg);
        });
        vite.middlewares.use('/table-images.html', async (_, res, next) => {
          try {
            const html = `<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
          <main id="fixture" class="markdown"></main><script type="module">
          import '/src/app.css'; import '/src/markdown.css';
          import {renderMarkdown,preloadRenderers} from '/src/lib/markdown.ts';
          const fixture=${source}; await preloadRenderers();
          window.renderTableImage = async (id, width, scale) => {
            const item=fixture.cases.find(item=>item.id===id), target=document.querySelector('#fixture');
            target.style.cssText='width:'+width+'px;font-family:Arial,sans-serif;font-size:'+15*scale+'px;line-height:1.65;';
            target.innerHTML=renderMarkdown(item.source);
            const image=target.querySelector('img'); await image.decode(); await document.fonts.ready;
            await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
            const measure=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}};
            const viewport=target.querySelector('.table-wrap');
            return {src:image.getAttribute('src'),image:measure(image),naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,table:measure(target.querySelector('table')),cell:measure(target.querySelector('td')),viewport:measure(viewport),scrollWidth:viewport.scrollWidth,clientWidth:viewport.clientWidth};
          };
          window.tableImageReady=true;
          </script></body></html>`;
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/table-images.html', html));
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: requireTestBrowserExecutable(),
    headless: true,
  });
  const captures = [];
  for (const width of fixture.tableWidths)
    for (const theme of ['light', 'dark'])
      for (const scale of [1, 2])
        for (const item of fixture.tableCases) {
          const page = await browser.newPage({
            viewport: { width, height: 500 },
            colorScheme: theme,
            deviceScaleFactor: 1,
          });
          const errors = [];
          page.on('pageerror', (error) => errors.push(String(error)));
          await page.goto('http://127.0.0.1:18925/table-images.html');
          await page.waitForFunction(() => window.tableImageReady);
          const measured = await page.evaluate(
            ({ id, width, scale }) => window.renderTableImage(id, width, scale),
            { id: item.id, width, scale },
          );
          assert.deepEqual(errors, []);
          assert.equal(measured.src, item.imageSource);
          assert.equal(measured.naturalWidth, 300);
          assert.equal(measured.naturalHeight, 140);
          assert.ok(measured.image.width > 0 && measured.image.width <= measured.naturalWidth);
          assert.ok(Math.abs(measured.image.width / measured.image.height - 300 / 140) < 0.001);
          assert.equal(measured.viewport.width, width);
          const screenshot = `markdown-table-images-web-${item.id}-${width}-${theme}-scale${scale}.png`;
          captures.push({ id: item.id, width, theme, textScale: scale, ...measured, screenshot });
          await page.screenshot({ path: resolve(output, screenshot) });
          await page.close();
        }
  await writeFile(
    resolve(output, 'markdown-table-images-web.json'),
    JSON.stringify({ reference: revision, captures }, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      configurations: captures.length,
      naturalImageSize: [300, 140],
      narrowTableSizing: 'measured',
      srcFragments: 'retained',
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
