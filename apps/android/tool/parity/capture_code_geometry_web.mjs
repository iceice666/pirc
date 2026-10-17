import { requireTestBrowserExecutable } from './test_browser.mjs';
// node apps/android/tool/parity/capture_code_geometry_web.mjs
// Measure pinned Chromium code block/header/body geometry for common fences.
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixture = JSON.parse(
  await readFile(resolve(root, 'fixtures/mobile-parity/code-geometry.json'), 'utf8'),
);
const codeTextFromFence = (source) => {
  const firstLineBreak = source.indexOf('\n');
  const closingFence = source.lastIndexOf('\n```');
  return source.slice(firstLineBreak + 1, closingFence);
};
assert.equal(fixture.webRevision, revision, 'fixture must retain the pinned web source');
assert.equal(fixture.cases.length, 10, 'unexpected code geometry fixture case count');
execFileSync('git', ['diff', '--exit-code', revision, '--', 'apps/web'], { cwd: root });

const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const outputDir = resolve(root, 'apps/android/build/parity/code-geometry');
await mkdir(outputDir, { recursive: true });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');

const server = await createServer({
  root: resolve(root, 'apps/web'),
  configFile: false,
  cacheDir: resolve(outputDir, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port: 18921,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'code-geometry-oracle',
      configureServer(vite) {
        vite.middlewares.use('/code-geometry.html', async (_, res, next) => {
          try {
            const html = `<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
              html,body{margin:0;min-height:100%;}
              body{overflow:auto!important;}
              #fixture{box-sizing:border-box;width:100%;padding:16px;font-family:Arial,sans-serif;font-size:15px;line-height:1.65;--font-mono:Menlo,monospace;}
            </style></head><body><main id="fixture" class="markdown"></main><script type="module">
              import '/src/app.css';
              import '/src/markdown.css';
              import {preloadRenderers,renderMarkdown,enhanceMarkdown} from '/src/lib/markdown.ts';
              const fixture=${fixtureSource};
              const round=value=>Math.round(value*1000)/1000;
              const rectOf=element=>{const r=element.getBoundingClientRect();return {x:round(r.x),y:round(r.y),width:round(r.width),height:round(r.height),top:round(r.top),right:round(r.right),bottom:round(r.bottom),left:round(r.left)}};
              const edges=style=>({top:round(parseFloat(style.top)||0),right:round(parseFloat(style.right)||0),bottom:round(parseFloat(style.bottom)||0),left:round(parseFloat(style.left)||0)});
              const measure=element=>{
                if(!element)return null;
                const s=getComputedStyle(element);
                return {rect:rectOf(element),computed:{display:s.display,boxSizing:s.boxSizing,fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,letterSpacing:s.letterSpacing,whiteSpace:s.whiteSpace,overflow:s.overflow,overflowX:s.overflowX,tabSize:s.tabSize,minHeight:s.minHeight,margin:edges({top:s.marginTop,right:s.marginRight,bottom:s.marginBottom,left:s.marginLeft}),padding:edges({top:s.paddingTop,right:s.paddingRight,bottom:s.paddingBottom,left:s.paddingLeft}),border:edges({top:s.borderTopWidth,right:s.borderRightWidth,bottom:s.borderBottomWidth,left:s.borderLeftWidth})},box:{clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight,offsetWidth:element.offsetWidth,offsetHeight:element.offsetHeight}};
              };
              window.captureHeaderContexts=()=>{
                const target=document.querySelector('#fixture');
                const rows=[];
                for(const parentHeight of [1.65,1.75])for(const compact of [false,true]){
                  const parent=document.createElement('div');parent.style.lineHeight=String(parentHeight);
                  const scope=document.createElement('div');scope.className='markdown'+(compact?' compact':'');
                  scope.innerHTML=renderMarkdown(fixture.cases[1].source);
                  parent.append(scope);target.replaceChildren(parent);
                  const head=scope.querySelector('.code-head'),copy=scope.querySelector('.code-copy');
                  rows.push({parentHeight,compact,head:measure(head),copy:measure(copy),pre:measure(scope.querySelector('pre'))});
                }
                return rows;
              };
              window.setupTerminalDrag=()=>{
                const target=document.querySelector('#fixture');
                target.innerHTML=renderMarkdown('~~~text\\nabc\\n\\n~~~');
                const pre=target.querySelector('pre');
                const code=pre.querySelector('code');
                const node=code.firstChild;
                const r=document.createRange();r.setStart(node,0);r.setEnd(node,2);
                const rect=r.getBoundingClientRect(), pr=pre.getBoundingClientRect(), cr=code.getBoundingClientRect();
                const lineHeight=parseFloat(getComputedStyle(pre).lineHeight);
                return {start:{x:rect.right,y:pr.top+12+lineHeight/2},end:{x:cr.right+10,y:pr.top+12+lineHeight+4},source:code.textContent};
              };
              window.setupCopyCheck=()=>{
                const target=document.querySelector('#fixture');
                const source=fixture.cases[1].source;
                target.innerHTML=renderMarkdown(source);
                window.copyWrites=[];
                Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copyWrites.push(text)}}});
                window.copyEnhancement=enhanceMarkdown(target,{html:target.innerHTML,ready:false});
              };
              window.codeGeometryReady=false;
              window.captureCodeGeometry=async()=>{
                await preloadRenderers();
                const target=document.querySelector('#fixture');
                const results=[];
                for(const item of fixture.cases){
                  target.innerHTML=renderMarkdown(item.source);
                  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                  const block=target.querySelector('.code-block');
                  const head=block?.querySelector('.code-head');
                  const copy=block?.querySelector('.code-copy');
                  const pre=block?.querySelector('pre');
                  const code=pre?.querySelector('code');
                  if(!block||!head||!copy||!pre||!code)throw new Error('Missing rendered code block for '+item.id);
                  const codeText=code.textContent??'';
                  const tabs=[];
                  const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);
                  let offset=0,node;
                  while(node=walker.nextNode()) {
                    for(let i=0;i<node.data.length;i++) {
                      if(node.data.charCodeAt(i)!==9)continue;
                      const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);
                      const r=range.getBoundingClientRect();
                      tabs.push({offset:offset+i,x:r.x-pre.getBoundingClientRect().x,width:r.width});
                    }
                    offset+=node.data.length;
                  }
                  results.push({id:item.id,source:item.source,codeText,tabs,codeLineCount:codeText.length===0?0:codeText.split('\\n').length,root:measure(target),codeBlock:measure(block),codeHead:measure(head),codeCopy:measure(copy),pre:measure(pre),preCode:measure(code),hoverNone:matchMedia('(hover: none)').matches,pointerCoarse:matchMedia('(pointer: coarse)').matches});
                }
                return results;
              };
              await document.fonts.ready;
              window.codeGeometryReady=true;
            </script></body></html>`;
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/code-geometry.html', html));
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
    for (const touch of [true, false]) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width, height: 1400 },
          deviceScaleFactor: 1,
          colorScheme: theme,
          hasTouch: touch,
          isMobile: touch,
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(`${width}/${touch}/${theme}: ${error}`));
        await page.goto('http://127.0.0.1:18921/code-geometry.html');
        await page.waitForFunction(() => window.codeGeometryReady === true);
        const results = await page.evaluate(() => window.captureCodeGeometry());
        assert.equal(results.length, fixture.cases.length, 'missing code geometry cases');
        for (const row of results) {
          assert.equal(
            row.hoverNone,
            touch,
            `hover media mismatch for ${width}/${touch}/${theme}/${row.id}`,
          );
          assert.equal(
            row.codeText,
            codeTextFromFence(fixture.cases.find((item) => item.id === row.id).source),
            `${row.id}: unexpected rendered code text`,
          );
        }
        const headerContexts = await page.evaluate(() => window.captureHeaderContexts());
        for (const row of headerContexts) {
          const height = row.compact ? 1.6 : row.parentHeight;
          for (const part of [row.head, row.copy]) {
            assert.ok(Math.abs(parseFloat(part.computed.lineHeight) - 12 * height) < 0.001);
            assert.equal(part.computed.fontWeight, '400');
          }
          assert.equal(row.pre.computed.lineHeight, '20.8px');
        }
        await page.evaluate(() => window.setupCopyCheck());
        const button = page.locator('.code-copy');
        const copyColors = await button.evaluate((el) => ({
          color: getComputedStyle(el).color,
          background: getComputedStyle(el).backgroundColor,
        }));
        let hoverColors = null;
        if (!touch) {
          await button.hover();
          hoverColors = await button.evaluate((el) => ({
            color: getComputedStyle(el).color,
            background: getComputedStyle(el).backgroundColor,
          }));
          assert.notEqual(hoverColors.color, copyColors.color);
          assert.notEqual(hoverColors.background, copyColors.background);
        }
        await page.clock.install();
        await page.clock.pauseAt(new Date());
        await button.evaluate((el) => el.click());
        assert.equal(await button.textContent(), 'Copied');
        await page.clock.runFor(1000);
        await button.evaluate((el) => el.click());
        await page.clock.runFor(399);
        assert.equal(await button.textContent(), 'Copied');
        await page.clock.runFor(1);
        assert.equal(await button.textContent(), 'Copy');
        await page.clock.runFor(1000);
        const copyWrites = await page.evaluate(() => window.copyWrites);
        assert.deepEqual(copyWrites, Array(2).fill(codeTextFromFence(fixture.cases[1].source)));
        await page.evaluate(() => window.copyEnhancement.destroy());
        const terminalDrag = await page.evaluate(() => window.setupTerminalDrag());
        await page.mouse.move(terminalDrag.start.x, terminalDrag.start.y);
        await page.mouse.down();
        await page.mouse.move(terminalDrag.end.x, terminalDrag.end.y, { steps: 5 });
        await page.mouse.up();
        const terminalDragSelection = await page.evaluate(() => getSelection().toString());
        assert.equal(terminalDrag.source, 'abc\n');
        assert.equal(terminalDragSelection, 'c');
        configurations.push({
          viewport: { width, height: 1400 },
          deviceScaleFactor: 1,
          touch,
          expectedHover: touch ? 'none' : 'hover',
          theme,
          baseFont: { family: 'Arial', size: 15, lineHeight: 1.65 },
          cases: results,
          headerContexts,
          terminalDrag: { ...terminalDrag, selected: terminalDragSelection },
          copyInteraction: {
            copyColors,
            hoverColors,
            copyWrites,
            resetMilliseconds: 1400,
            repeatedClickResetsAtFirstDeadline: true,
          },
        });
        await context.close();
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const result = {
    revision,
    browser: browser.version(),
    fixture: 'fixtures/mobile-parity/code-geometry.json',
    configurations,
  };
  const outputPath = resolve(outputDir, 'web.json');
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        revision,
        browser: result.browser,
        configurations: configurations.length,
        casesPerConfiguration: fixture.cases.length,
        outputPath,
        headerAndBodyHeights: configurations.map((configuration) => ({
          width: configuration.viewport.width,
          touch: configuration.touch,
          theme: configuration.theme,
          hoverNone: configuration.cases[0].hoverNone,
          cases: configuration.cases.map((row) => ({
            id: row.id,
            headerHeight: row.codeHead.rect.height,
            copyHeight: row.codeCopy.rect.height,
            preHeight: row.pre.rect.height,
            codeBlockHeight: row.codeBlock.rect.height,
            codeLines: row.codeLineCount,
            codeText: row.codeText,
            preClientWidth: row.pre.box.clientWidth,
            preScrollWidth: row.pre.box.scrollWidth,
          })),
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
