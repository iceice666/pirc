import { requireTestBrowserExecutable } from './test_browser.mjs';
// node apps/android/tool/parity/capture_markdown_spacing_web.mjs
// Measure pinned Chromium block geometry for common Markdown spacing cases.
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/markdown-spacing.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixture.webRevision, revision, 'fixture must retain the pinned web source');
assert.equal(fixture.cases.length, 12, 'unexpected Markdown spacing fixture case count');
execFileSync('git', ['diff', '--exit-code', revision, '--', 'apps/web'], { cwd: root });

const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const outputDir = resolve(root, 'apps/android/build/parity/markdown-spacing');
await mkdir(outputDir, { recursive: true });

const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const server = await createServer({
  root: resolve(root, 'apps/web'),
  configFile: false,
  cacheDir: resolve(outputDir, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port: 18920,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'markdown-spacing-oracle',
      configureServer(vite) {
        vite.middlewares.use('/spacing.html', async (_, res, next) => {
          try {
            const html = `<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
              html,body{margin:0;min-height:100%;}
              body{overflow:auto!important;}
              #fixture{box-sizing:border-box;width:100%;padding:16px;font-family:Arial,sans-serif;font-size:calc(15px * var(--fixture-scale,1));line-height:1.65;--font-mono:Menlo,monospace;}
            </style></head><body><main id="fixture" class="markdown"></main><script type="module">
              import '/src/app.css';
              import '/src/markdown.css';
              import {preloadRenderers,renderMarkdown} from '/src/lib/markdown.ts';
              const fixture=${fixtureSource};
              const round=value=>Math.round(value*1000)/1000;
              const rectOf=element=>{const r=element.getBoundingClientRect();return {x:round(r.x),y:round(r.y),width:round(r.width),height:round(r.height),top:round(r.top),right:round(r.right),bottom:round(r.bottom),left:round(r.left)}};
              const marginOf=style=>({top:round(parseFloat(style.marginTop)||0),right:round(parseFloat(style.marginRight)||0),bottom:round(parseFloat(style.marginBottom)||0),left:round(parseFloat(style.marginLeft)||0)});
              const labelOf=element=>(element.innerText||element.textContent||'').replace(/\\s+/g,' ').trim().slice(0,100);
              const measureLevel=elements=>elements.map((element,index)=>{
                const style=getComputedStyle(element), rect=rectOf(element), previous=index?rectOf(elements[index-1]):null;
                return {index,tag:element.tagName.toLowerCase(),className:element.className||'',text:labelOf(element),rect,margins:marginOf(style),gapBefore:previous?round(rect.top-previous.bottom):null,fontSize:style.fontSize,lineHeight:style.lineHeight,children:measureLevel([...element.children])};
              });
              window.measureMarkdownSpacing=async()=>{
                await preloadRenderers();
                const target=document.querySelector('#fixture');
                const cases=[];
                for(const item of fixture.cases){
                  target.innerHTML=renderMarkdown(item.source);
                  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                  const children=[...target.children];
                  cases.push({id:item.id,source:item.source,rect:rectOf(target),blocks:measureLevel(children)});
                }
                return cases;
              };
              await document.fonts.ready;
              window.spacingPageReady=true;
            </script></body></html>`;
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/spacing.html', html));
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});

await server.listen();
let browser;
try {
  browser = await chromium.launch({
    executablePath: requireTestBrowserExecutable(),
    headless: true,
  });
  const configurations = [];
  const errors = [];
  for (const width of [390, 768]) {
    for (const textScale of [1, 2]) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width, height: 1500 },
          deviceScaleFactor: 1,
          colorScheme: theme,
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(`${width}/${textScale}/${theme}: ${error}`));
        await page.goto('http://127.0.0.1:18920/spacing.html');
        await page.waitForFunction(() => window.spacingPageReady === true);
        await page.locator('#fixture').evaluate((element, scale) => {
          element.style.setProperty('--fixture-scale', String(scale));
        }, textScale);
        await page.evaluate(() => document.fonts.ready);
        const cases = await page.evaluate(() => window.measureMarkdownSpacing());
        assert.equal(cases.length, fixture.cases.length, 'missing measured fixture cases');
        for (const row of cases) assert.ok(row.blocks.length > 0, `no blocks measured for ${row.id}`);
        configurations.push({
          viewport: { width, height: 1500 },
          deviceScaleFactor: 1,
          theme,
          textScale,
          font: { family: 'Arial', size: 15, lineHeight: 1.65 },
          cases,
        });
        await context.close();
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const result = {
    revision,
    browser: browser.version(),
    fixture: 'fixtures/mobile-parity/markdown-spacing.json',
    configurations,
  };
  const outputPath = resolve(outputDir, 'web.json');
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({
    revision,
    browser: result.browser,
    configurations: configurations.length,
    casesPerConfiguration: fixture.cases.length,
    outputPath,
    baseline390LightScale1: configurations.find((c) => c.viewport.width === 390 && c.theme === 'light' && c.textScale === 1).cases.map((item) => ({
      id: item.id,
      blocks: item.blocks.map((block) => ({tag:block.tag,text:block.text,top:block.rect.top,height:block.rect.height,marginTop:block.margins.top,marginBottom:block.margins.bottom,gapBefore:block.gapBefore})),
    })),
  }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
