import { requireTestBrowserExecutable } from './test_browser.mjs';
// Capture actual pinned Markdown sanitization and Chromium input[type=range].
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const fixturePath = resolve(root, 'fixtures/mobile-parity/html-ranges.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const pinnedRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
if (fixture.webRevision !== pinnedRevision) throw new Error('range fixture must use pinned web revision');
execFileSync('git', ['diff', '--exit-code', pinnedRevision, '--', 'apps/web'], { cwd: root });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const out = resolve(root, 'apps/android/build/parity');
await mkdir(out, { recursive: true });
const server = await createServer({
  cacheDir: resolve(out, 'vite-cache-html-ranges'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18913,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [{
    name: 'html-range-parity',
    configureServer(server) {
      server.middlewares.use('/parity.html', async (_, res, next) => {
        try {
          const html = `<!doctype html><html><head>
            <link rel="icon" href="data:,">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <style>body{overflow:auto!important} #fixture{padding:16px;font-family:Arial,sans-serif;font-size:15px;line-height:1.65}</style>
          </head><body><main id="fixture" class="markdown"></main>
            <script type="module">
              import '/src/app.css';
              import '/src/markdown.css';
              import { preloadRenderers, renderMarkdown, enhanceMarkdown } from '/src/lib/markdown.ts';
              const fixture = __HTML_RANGE_FIXTURE__;
              const root = document.querySelector('#fixture');
              let enhancer;
              const rect = (element) => {
                const r = element.getBoundingClientRect();
                return {x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,right:r.right,bottom:r.bottom,left:r.left};
              };
              const attrs = (element) => Object.fromEntries([...element.attributes].map(a => [a.name,a.value]));
              const computed = (element) => {
                const s = getComputedStyle(element);
                const keys = ['display','position','boxSizing','width','height','minWidth','maxWidth','marginTop','marginRight','marginBottom','marginLeft','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderTopStyle','borderTopColor','borderRadius','fontFamily','fontSize','fontWeight','lineHeight','color','backgroundColor','accentColor','appearance','verticalAlign','cursor','outlineStyle','outlineWidth','outlineColor'];
                return Object.fromEntries(keys.map(k => [k,s[k]]));
              };
              const normalizedText = (element) => element.textContent.replace(/\\s+/g,' ').trim();
              const snapshot = (item, phase, consoleErrors) => {
                const controls = [...root.querySelectorAll('input[type="range"]')].map((element,index) => ({
                  index,
                  tag: element.tagName.toLowerCase(),
                  type: element.type,
                  id: element.id || null,
                  name: element.name || null,
                  value: element.value,
                  valueAsNumber: element.valueAsNumber,
                  defaultValue: element.defaultValue,
                  min: element.min,
                  max: element.max,
                  step: element.step,
                  attributes: attrs(element),
                  ariaAttributes: Object.fromEntries(Object.entries(attrs(element)).filter(([name])=>name.startsWith('aria-'))),
                  labels: [...(element.labels ?? [])].map(label=>({id:label.id||null,text:normalizedText(label)})),
                  state: {
                    disabled: element.matches(':disabled'),
                    readOnly: element.readOnly,
                    required: element.required,
                    willValidate: element.willValidate,
                    valid: element.validity.valid,
                    valueMissing: element.validity.valueMissing,
                    stepMismatch: element.validity.stepMismatch,
                    rangeUnderflow: element.validity.rangeUnderflow,
                    rangeOverflow: element.validity.rangeOverflow,
                    tabIndex: element.tabIndex,
                    readOnlyPseudo: element.matches(':read-only'),
                    readWritePseudo: element.matches(':read-write'),
                  },
                  focused: element===document.activeElement,
                  box: rect(element),
                  rendered: element.checkVisibility(),
                  computed: computed(element),
                  pseudo: Object.fromEntries(['::-webkit-slider-runnable-track','::-webkit-slider-thumb'].map(selector=>{
                    const s=getComputedStyle(element,selector);
                    return [selector,Object.fromEntries(['display','width','height','margin','padding','border','borderRadius','backgroundColor','color','boxShadow','appearance'].map(k=>[k,s[k]]))];
                  })),
                }));
                return {
                  id:item.id,
                  phase,
                  sanitizedDOM:root.innerHTML,
                  root:{box:rect(root),scrollWidth:root.scrollWidth,scrollHeight:root.scrollHeight,computed:computed(root)},
                  activeElement:document.activeElement && document.activeElement!==document.body ? {tag:document.activeElement.tagName.toLowerCase(),id:document.activeElement.id||null,type:document.activeElement.type||null,text:normalizedText(document.activeElement)} : null,
                  controls,
                  consoleErrors,
                };
              };
              window.renderRangeCase = async (id) => {
                const item=fixture.cases.find(candidate=>candidate.id===id);
                if(!item) throw new Error('Unknown range fixture case '+id);
                const html=renderMarkdown(item.source);
                root.innerHTML=html;
                if(!enhancer) enhancer=enhanceMarkdown(root,{html,ready:true});
                else enhancer.update({html,ready:true});
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                return snapshot(item,'initial',[]);
              };
              window.captureRangeSnapshot = (id,phase) => {
                const item=fixture.cases.find(candidate=>candidate.id===id);
                if(!item) throw new Error('Unknown range fixture case '+id);
                return snapshot(item,phase,[]);
              };
              window.destroyMarkdownEnhancer = () => enhancer?.destroy();
              await preloadRenderers();
              window.fixtureReady=true;
            </script>
          </body></html>`;
          res.setHeader('Content-Type','text/html');
          res.end(await server.transformIndexHtml('/parity.html',html.replace('__HTML_RANGE_FIXTURE__',fixtureSource)));
        } catch(error) { next(error); }
      });
    },
  }],
});

let browser;
try {
  await server.listen();
  browser=await chromium.launch({executablePath:requireTestBrowserExecutable(),headless:true});
  const themes={};
  for(const colorScheme of ['light','dark']) {
    const widthResults=[];
    for(const width of fixture.widths) {
      const page=await browser.newPage({viewport:{width,height:fixture.height},deviceScaleFactor:fixture.deviceScaleFactor,isMobile:true,hasTouch:true,locale:'en-US',colorScheme});
      const cdp=await page.context().newCDPSession(page);
      const pageErrors=[],consoleErrors=[],badResponses=[];
      page.on('pageerror',error=>pageErrors.push(error.stack||error.message));
      page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
      page.on('response',response=>{if(response.status()>=400)badResponses.push(`${response.status()} ${response.url()}`);});
      await page.goto('http://127.0.0.1:18913/parity.html');
      await page.waitForFunction(()=>window.fixtureReady);
      const recordAccessibility=async result=>{
        const {root:document}=await cdp.send('DOM.getDocument');
        const {nodeIds}=await cdp.send('DOM.querySelectorAll',{nodeId:document.nodeId,selector:'#fixture input[type="range"]'});
        if(nodeIds.length!==result.controls.length) throw new Error('AX slider count differs');
        for(let i=0;i<nodeIds.length;i++) {
          const {nodes}=await cdp.send('Accessibility.getPartialAXTree',{nodeId:nodeIds[i],fetchRelatives:false});
          const node=nodes[0];
          result.controls[i].accessibility={role:node?.role?.value??'',name:node?.name?.value??'',description:node?.description?.value??'',value:node?.value?.value??null,disabled:node?.disabled?.value??null,readonly:node?.readonly?.value??null};
        }
      };
      const caseResults=[];
      for(const item of fixture.cases) {
        let result=await page.evaluate(id=>window.renderRangeCase(id),item.id);
        result.consoleErrors=consoleErrors.slice();
        await recordAccessibility(result);
        const observations=[result];
        await page.screenshot({path:resolve(out,`html-ranges-web-${colorScheme}-${width}-${item.id}-initial.png`),fullPage:true});
        for(const action of item.actions??[]) {
          const locator=page.locator(item.selector);
          if(action.kind==='key') {
            await locator.focus();
            await page.keyboard.press(action.key);
          } else if(action.kind==='key-repeat') {
            await locator.focus();
            await page.keyboard.down(action.key);
            await page.keyboard.down(action.key);
            await page.keyboard.up(action.key);
          } else if(action.kind==='label-click') {
            await page.locator(action.selector).evaluate(element=>element.click());
          } else if(action.kind==='touch-drag') {
            const box=await locator.boundingBox();
            if(!box) throw new Error(`No range bounds for ${item.id}`);
            const start={x:box.x+box.width/2,y:box.y+box.height/2};
            const end={x:box.x+box.width*action.to,y:start.y};
            await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...start,id:0}]});
            for(let i=1;i<=5;i++) await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x+(end.x-start.x)*i/5,y:start.y,id:0}]});
            await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
          } else {
            throw new Error(`Unsupported action ${action.kind}`);
          }
          await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          result=await page.evaluate(({id,phase})=>window.captureRangeSnapshot(id,phase),{id:item.id,phase:action.id});
          result.consoleErrors=consoleErrors.slice();
          await recordAccessibility(result);
          observations.push(result);
          await page.screenshot({path:resolve(out,`html-ranges-web-${colorScheme}-${width}-${item.id}-${action.id}.png`),fullPage:true});
        }
        if(observations.some(row=>row.consoleErrors.length)) throw new Error(`Console errors in ${item.id}`);
        caseResults.push({id:item.id,observations});
      }
      if(pageErrors.length) throw new Error(pageErrors.join('\\n'));
      if(badResponses.length) throw new Error(badResponses.join('\\n'));
      widthResults.push({width,cases:caseResults});
      await page.evaluate(()=>window.destroyMarkdownEnhancer?.());
      await page.close();
    }
    themes[colorScheme]={widths:widthResults};
  }
  const merged={fixture:fixture.id,reference:fixture.webRevision,browserVersion:await browser.version(),themes};
  await writeFile(resolve(out,'html-ranges-web.json'),JSON.stringify(merged,null,2)+'\n');
  await writeFile(resolve(root,'fixtures/mobile-parity/html-ranges-expected.json'),JSON.stringify(merged,null,2)+'\n');
  console.log(out);
} finally {
  await browser?.close();
  await server.close();
}
