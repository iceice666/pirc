import { requireTestBrowserExecutable } from './test_browser.mjs';
// Capture actual pinned Markdown + KaTeX handling of unsupported controls and parse errors.
import assert from 'node:assert/strict';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/tex-unsupported-commands.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixture.webRevision, revision, 'fixture must retain the pinned Web source');
assert.equal(fixture.cases.length, 17, 'unexpected TeX unsupported-command case count');
execFileSync('git', ['diff', '--exit-code', revision, '--', 'apps/web', ':!apps/web/tool'], { cwd: root });

const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const outputDir = resolve(root, 'apps/android/build/parity/tex-unsupported-commands');
await mkdir(outputDir, { recursive: true });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const server = await createServer({
  root: resolve(root, 'apps/web'),
  configFile: false,
  cacheDir: resolve(outputDir, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port: 18927,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [{
    name: 'tex-unsupported-commands-oracle',
    configureServer(vite) {
      vite.middlewares.use('/tex-unsupported-commands.html', async (_, res, next) => {
        try {
          const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>TeX unsupported command oracle</title><style>
            html,body{margin:0;min-height:100%;}
            body{overflow:auto!important;}
            #fixture{box-sizing:border-box;width:100%;min-height:100vh;padding:16px;font-family:Arial,sans-serif;font-size:calc(15px * var(--fixture-scale,1));line-height:1.65;}
          </style></head><body><main id="fixture" class="markdown"></main><script type="module">
            import '/src/app.css';
            import '/src/markdown.css';
            import { preloadRenderers, renderMarkdown } from '/src/lib/markdown.ts';
            const fixture = ${fixtureSource};
            const round = value => Math.round(value * 1000) / 1000;
            const rectOf = element => {
              if (!element) return null;
              const r = element.getBoundingClientRect();
              return {x:round(r.x),y:round(r.y),width:round(r.width),height:round(r.height),top:round(r.top),right:round(r.right),bottom:round(r.bottom),left:round(r.left)};
            };
            const labelOf = element => (element?.innerText || element?.textContent || '').replace(/\\s+/g,' ').trim().slice(0,500);
            const styleOf = element => {
              if (!element) return null;
              const s = getComputedStyle(element);
              return {fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,color:s.color,backgroundColor:s.backgroundColor,display:s.display,verticalAlign:s.verticalAlign,margin:s.margin,padding:s.padding,overflowX:s.overflowX,boxSizing:s.boxSizing};
            };
            const mathMarkupKind = (node, redRuns) => node.classList.contains('katex-error') ? 'whole-expression-parse-error' : redRuns.length ? 'rendered-with-unsupported-command' : 'normal-rendered';
            window.captureTexCase = async (id, scale) => {
              const item = fixture.cases.find(candidate => candidate.id === id);
              if (!item) throw new Error('Unknown TeX fixture case: ' + id);
              const target = document.querySelector('#fixture');
              target.style.setProperty('--fixture-scale', String(scale));
              target.innerHTML = renderMarkdown(item.source);
              await document.fonts.ready;
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const nodes = [...target.querySelectorAll('.katex, .katex-error')];
              const targetNode = nodes[item.targetMathIndex];
              if (!targetNode) throw new Error(item.id + ': target math node missing, found ' + nodes.length);
              const mathNodes = nodes.map((node,index) => {
                const isError = node.classList.contains('katex-error');
                const display = !!node.closest('.katex-display');
                const katexDisplay = node.closest('.katex-display');
                const wrapper = katexDisplay || node;
                const htmlNode = isError ? node : node.querySelector('.katex-html');
                const annotation = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? null;
                const baseBoxes = htmlNode ? [...htmlNode.children].filter(element=>element.classList.contains('base')).map((element,index)=>({index,text:labelOf(element),rect:rectOf(element)})) : [];
                const paintedBaseBoxes = baseBoxes.filter(box=>box.rect && box.rect.width>0 && box.rect.height>0);
                const baseUnionRect = paintedBaseBoxes.length ? {
                  x:round(Math.min(...paintedBaseBoxes.map(box=>box.rect.x))),
                  y:round(Math.min(...paintedBaseBoxes.map(box=>box.rect.y))),
                  left:round(Math.min(...paintedBaseBoxes.map(box=>box.rect.left))),
                  top:round(Math.min(...paintedBaseBoxes.map(box=>box.rect.top))),
                  right:round(Math.max(...paintedBaseBoxes.map(box=>box.rect.right))),
                  bottom:round(Math.max(...paintedBaseBoxes.map(box=>box.rect.bottom))),
                  width:round(Math.max(...paintedBaseBoxes.map(box=>box.rect.right))-Math.min(...paintedBaseBoxes.map(box=>box.rect.x))),
                  height:round(Math.max(...paintedBaseBoxes.map(box=>box.rect.bottom))-Math.min(...paintedBaseBoxes.map(box=>box.rect.y))),
                } : null;
                const redCandidates = [...(htmlNode ? [htmlNode,...htmlNode.querySelectorAll('[style]')] : [])];
                const redRuns = redCandidates.filter(element => getComputedStyle(element).color === 'rgb(204, 0, 0)').map(element => ({tag:element.tagName.toLowerCase(),className:typeof element.className==='string'?element.className:'',text:labelOf(element),color:getComputedStyle(element).color,style:element.getAttribute('style')}));
                const mathmlRedRuns = [...node.querySelectorAll('mstyle[mathcolor]')].filter(element => element.getAttribute('mathcolor')?.toLowerCase() === '#cc0000').map(element => ({text:labelOf(element),mathcolor:element.getAttribute('mathcolor')}));
                const paragraph = node.closest('p');
                const mathBlock = node.closest('.math-block');
                let baseline = null;
                if (!display && node.parentElement) {
                  const marker = document.createElement('span');
                  marker.setAttribute('data-parity-baseline-probe','');
                  marker.style.cssText = 'display:inline-block;width:0;height:0;overflow:hidden;vertical-align:baseline;padding:0;margin:0;border:0;';
                  node.after(marker);
                  const r = marker.getBoundingClientRect();
                  baseline = {y:round(r.y),offsetFromParentTop:round(r.y-node.parentElement.getBoundingClientRect().top)};
                  marker.remove();
                }
                return {
                  index, className:node.className, kind:mathMarkupKind(node,redRuns), title:node.getAttribute('title'),
                  text:labelOf(htmlNode || node), annotation, display:!!katexDisplay, hasKatexDisplay:!!katexDisplay,
                  rect:rectOf(node), wrapperRect:rectOf(wrapper), katexHtmlRect:rectOf(htmlNode), baseBoxes, baseUnionRect,
                  paragraphRect:rectOf(paragraph), mathBlockRect:rectOf(mathBlock),
                  katexDisplayRect:rectOf(katexDisplay), mathBlockStyle:styleOf(mathBlock),
                  style:styleOf(node), wrapperStyle:styleOf(wrapper), katexDisplayStyle:styleOf(katexDisplay), baseline,
                  redRuns, mathmlRedRuns,
                  htmlMathMarkup:node.outerHTML,
                };
              });
              const blocks = [...target.children].map((element,index) => ({index,tag:element.tagName.toLowerCase(),className:typeof element.className==='string'?element.className:'',text:labelOf(element),rect:rectOf(element),style:styleOf(element),children:[...element.children].map(child=>({tag:child.tagName.toLowerCase(),className:typeof child.className==='string'?child.className:'',text:labelOf(child),rect:rectOf(child),style:styleOf(child)}))}));
              const targetMath = mathNodes[item.targetMathIndex];
              const before = mathNodes.slice(0,item.targetMathIndex).map(node=>node.annotation);
              const after = mathNodes.slice(item.targetMathIndex+1).map(node=>node.annotation);
              const actualRed = targetMath.redRuns.map(run=>run.text);
              if (targetMath.kind !== item.expectedKind) throw new Error(item.id+': expected '+item.expectedKind+', got '+targetMath.kind+' / '+targetMath.className);
              if (!targetMath.className.split(' ').includes(item.expectedMathClass)) throw new Error(item.id+': expected class '+item.expectedMathClass+', got '+targetMath.className);
              if (item.expectedDisplay !== undefined && targetMath.display !== item.expectedDisplay) throw new Error(item.id+': expected display wrapper '+item.expectedDisplay+', got '+targetMath.display);
              if (item.expectedMathBlock !== undefined && (targetMath.mathBlockRect !== null) !== item.expectedMathBlock) throw new Error(item.id+': expected math-block '+item.expectedMathBlock+', got '+JSON.stringify(targetMath.mathBlockRect));
              for (const text of item.expectedRedText) if (!actualRed.some(value=>value.includes(text))) throw new Error(item.id+': expected visible red text '+JSON.stringify(text)+' in '+JSON.stringify(actualRed));
              if (JSON.stringify(before)!==JSON.stringify(item.expectedBeforeAnnotations)) throw new Error(item.id+': before formulas differ '+JSON.stringify(before));
              if (JSON.stringify(after)!==JSON.stringify(item.expectedAfterAnnotations)) throw new Error(item.id+': after formulas differ '+JSON.stringify(after));
              return {
                id:item.id,source:item.source,expectedKind:item.expectedKind,targetMathIndex:item.targetMathIndex,
                rootRect:rectOf(target),rootStyle:styleOf(target),rootBackground:getComputedStyle(document.body).backgroundColor,
                text:labelOf(target),blocks,mathNodes,
                targetMathMarkup:targetMath.htmlMathMarkup,
                validation:{actualKind:targetMath.kind,actualClass:targetMath.className,actualRedText:actualRed,actualBeforeAnnotations:before,actualAfterAnnotations:after},
                rawMarkdownHtml:target.innerHTML,
                renderer:{katexMainFontReady:document.fonts.check('16px KaTeX_Main'),katexComputedFontSize:getComputedStyle(targetNode.classList.contains('katex-error')?targetNode:targetNode.querySelector('.katex-html')).fontSize},
              };
            };
            await preloadRenderers();
            await document.fonts.ready;
            window.texUnsupportedPageReady = true;
          </script></body></html>`;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(await vite.transformIndexHtml('/tex-unsupported-commands.html', html));
        } catch (error) { next(error); }
      });
    },
  }],
});

const browser = await chromium.launch({ executablePath: requireTestBrowserExecutable(), headless: true });
const configurations = [];
const htmlByCase = Object.create(null);
const errors = [];
try {
  await server.listen();
  for (const width of fixture.capture.widths) {
    for (const theme of fixture.capture.themes) {
      for (const textScale of fixture.capture.textScales) {
        const context = await browser.newContext({viewport:{width,height:fixture.capture.height},deviceScaleFactor:fixture.capture.deviceScaleFactor,colorScheme:theme,locale:'en-US'});
        const page = await context.newPage();
        page.on('pageerror',error=>errors.push(`${width}/${theme}/${textScale}: ${error.stack||error.message}`));
        page.on('console',message=>{if(message.type()==='error')errors.push(`${width}/${theme}/${textScale}: ${message.text()}`)});
        await page.goto('http://127.0.0.1:18927/tex-unsupported-commands.html',{waitUntil:'load'});
        await page.waitForFunction(()=>window.texUnsupportedPageReady===true);
        const capturedCases=[];
        for (const item of fixture.cases) {
          const measured=await page.evaluate(({id,scale})=>window.captureTexCase(id,scale),{id:item.id,scale:textScale});
          assert.equal(measured.id,item.id);
          const htmlSignature=measured.rawMarkdownHtml;
          if (htmlByCase[item.id]===undefined) htmlByCase[item.id]={rawMarkdownHtml:htmlSignature,targetMathMarkup:measured.targetMathMarkup};
          else {
            assert.equal(htmlByCase[item.id].rawMarkdownHtml,htmlSignature,`${item.id}: renderer HTML changed across theme/scale/width`);
            assert.equal(htmlByCase[item.id].targetMathMarkup,measured.targetMathMarkup,`${item.id}: target math markup changed across theme/scale/width`);
          }
          delete measured.rawMarkdownHtml;
          delete measured.targetMathMarkup;
          const screenshot=`tex-unsupported-${item.id}-${width}-${theme}-scale${textScale}.png`;
          await page.screenshot({path:resolve(outputDir,screenshot),fullPage:true});
          capturedCases.push({...measured,screenshot:`apps/android/build/parity/tex-unsupported-commands/${screenshot}`});
        }
        configurations.push({viewport:{width,height:fixture.capture.height},theme,textScale,deviceScaleFactor:fixture.capture.deviceScaleFactor,font:{family:fixture.capture.paragraphFontFamily,size:fixture.capture.paragraphFontSize,lineHeight:fixture.capture.paragraphLineHeight,katexScale:fixture.capture.katexFontScale},cases:capturedCases});
        await context.close();
      }
    }
  }
  assert.deepEqual(errors,[],'browser errors');
  assert.equal(configurations.length,8);
  const expected={
    fixture:'fixtures/mobile-parity/tex-unsupported-commands.json',
    webRevision:revision,
    capturedAt:new Date().toISOString(),
    browser:{name:'Google Chrome',version:browser.version(),executable:requireTestBrowserExecutable(),deviceScaleFactor:1,viewportWidths:fixture.capture.widths,height:fixture.capture.height,themes:fixture.capture.themes,textScales:fixture.capture.textScales},
    renderer:fixture.rendererOptions,
    sourceBehavior:{unsupportedControl:'KaTeX Parser.formatUnsupportedCmd creates colored text inside a normal rendered formula when throwOnError is false',parseErrors:'KaTeX renderError returns whole source in span.katex-error with title and inline error color',paintGeometry:'baseBoxes are direct positive-area .katex-html > .base DOM boxes; baseUnionRect unions those boxes and does not use the full .katex display wrapper or zero-width struts'},
    caseMarkup:htmlByCase,
    configurations,
  };
  const outputPath=resolve(root,'fixtures/mobile-parity/tex-unsupported-commands-expected.json');
  await writeFile(outputPath,JSON.stringify(expected,null,2)+'\n');
  console.log(JSON.stringify({revision,browser:expected.browser.version,configurations:configurations.length,casesPerConfiguration:fixture.cases.length,totalCaptures:configurations.reduce((n,c)=>n+c.cases.length,0),outputPath,screenshots:outputDir,baseline390LightScale1:configurations.find(c=>c.viewport.width===390&&c.theme==='light'&&c.textScale===1).cases.map(c=>({id:c.id,math:c.mathNodes.map((node,index)=>({index,kind:node.kind,className:node.className,annotation:node.annotation,rect:node.rect,baseline:node.baseline,redRuns:node.redRuns.map(run=>({text:run.text,color:run.color}))})),blocks:c.blocks.map(block=>({tag:block.tag,className:block.className,text:block.text,rect:block.rect}))}))},null,2));
} finally {
  await browser.close();
  await server.close();
}
