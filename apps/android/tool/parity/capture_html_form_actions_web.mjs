import { requireTestBrowserExecutable } from './test_browser.mjs';
// node apps/android/tool/parity/capture_html_form_actions_web.mjs
// Capture pinned Chromium reset and data-copy behavior for native HTML parity.
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const fixturePath = resolve(root, 'fixtures/mobile-parity/html-form-actions.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const pinnedRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
if (fixture.webRevision !== pinnedRevision) throw new Error('form action fixture must use pinned web revision');
execFileSync('git', ['diff', '--exit-code', pinnedRevision, '--', 'apps/web'], { cwd: root });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const out = resolve(root, 'apps/android/build/parity');
await mkdir(out, { recursive: true });

const server = await createServer({
  cacheDir: resolve(out, 'vite-cache-html-form-actions'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18915,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [{
    name: 'html-form-actions-parity',
    configureServer(server) {
      server.middlewares.use('/parity.html', async (_, res, next) => {
        try {
          const html = `<!doctype html><html><head>
            <link rel="icon" href="data:,">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <style>
              body{overflow:auto!important}
              #fixture{padding:16px;font-family:Arial,sans-serif;font-size:15px;line-height:1.65;--font-mono:Menlo,monospace}
            </style>
          </head><body><main id="fixture" class="markdown"></main>
            <script type="module">
              import '/src/app.css';
              import '/src/markdown.css';
              import { preloadRenderers, renderMarkdown, enhanceMarkdown } from '/src/lib/markdown.ts';

              const fixture = ${fixtureSource};
              const root = document.querySelector('#fixture');
              let enhancer;
              window.clipboardMode = 'resolve';
              window.clipboardWrites = [];
              window.clipboardRejections = 0;
              window.addEventListener('unhandledrejection', event => {
                if (event.reason?.name === 'NotAllowedError') {
                  window.clipboardRejections++;
                  event.preventDefault();
                }
              });
              const rect = element => {
                const r = element.getBoundingClientRect();
                return {x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,right:r.right,bottom:r.bottom,left:r.left};
              };
              const attrs = element => Object.fromEntries([...element.attributes].map(a=>[a.name,a.value]));
              const computed = element => {
                const s = getComputedStyle(element);
                const keys = ['display','position','boxSizing','width','height','minWidth','minHeight','maxWidth','maxHeight',
                  'marginTop','marginRight','marginBottom','marginLeft','paddingTop','paddingRight','paddingBottom','paddingLeft',
                  'borderTopWidth','borderTopStyle','borderTopColor','borderRightWidth','borderRightStyle','borderRightColor',
                  'borderBottomWidth','borderBottomStyle','borderBottomColor','borderLeftWidth','borderLeftStyle','borderLeftColor',
                  'borderRadius','fontFamily','fontSize','fontWeight','lineHeight','color','backgroundColor','backgroundImage',
                  'opacity','appearance','cursor','outlineStyle','outlineWidth','outlineColor','textAlign','whiteSpace',
                  'verticalAlign','overflow','visibility','pointerEvents'];
                return Object.fromEntries(keys.map(k=>[k,s[k]]));
              };
              const normalizedText = element => element.textContent.replace(/\\s+/g,' ').trim();
              const snapshot = (item, phase, actionIndex) => ({
                id:item.id,
                phase,
                actionIndex,
                sanitizedDOM:root.innerHTML,
                controls:[...root.querySelectorAll('input,textarea,select')].map((element,index)=>({
                  index,
                  tag:element.tagName.toLowerCase(),
                  type:element.type || null,
                  id:element.id || null,
                  name:element.name || null,
                  value:element.value,
                  defaultValue:'defaultValue' in element ? element.defaultValue : null,
                  checked:'checked' in element ? element.checked : null,
                  defaultChecked:'defaultChecked' in element ? element.defaultChecked : null,
                  selectedIndex:element.tagName==='SELECT' ? element.selectedIndex : null,
                  selectedIndices:element.tagName==='SELECT' ? [...element.options].map((o,i)=>o.selected?i:-1).filter(i=>i>=0) : null,
                  selectedValues:element.tagName==='SELECT' ? [...element.options].filter(o=>o.selected).map(o=>o.value) : null,
                  disabled:element.matches(':disabled'),
                  readOnly:!!element.readOnly,
                  required:!!element.required,
                  labels:[...(element.labels ?? [])].map(label=>({id:label.id||null,text:normalizedText(label)})),
                  formId:element.form?.id || null,
                  box:rect(element),
                  computed:computed(element),
                })),
                buttons:[...root.querySelectorAll('button,input[type=button],input[type=reset],input[type=submit]')].map((element,index)=>({
                  index,
                  tag:element.tagName.toLowerCase(),
                  type:element.type,
                  id:element.id || null,
                  name:element.name || null,
                  value:'value' in element ? element.value : null,
                  label:element.tagName==='INPUT' ? element.value : normalizedText(element),
                  textContent:element.textContent,
                  html:element.innerHTML,
                  attributes:attrs(element),
                  disabled:element.matches(':disabled'),
                  formId:element.form?.id || null,
                  labels:[...(element.labels ?? [])].map(label=>({id:label.id||null,text:normalizedText(label)})),
                  focused:element===document.activeElement,
                  box:rect(element),
                  computed:computed(element),
                })),
                forms:[...root.querySelectorAll('form')].map(form=>({
                  id:form.id || null,
                  controls:[...form.elements].map(el=>el.id || null),
                  disabledControls:[...form.elements].filter(el=>el.matches(':disabled')).map(el=>el.id||null),
                })),
                activeElement:document.activeElement && document.activeElement!==document.body ? {
                  tag:document.activeElement.tagName.toLowerCase(),
                  id:document.activeElement.id || null,
                  type:document.activeElement.type || null,
                  text:normalizedText(document.activeElement),
                } : null,
                clipboardWrites:[...window.clipboardWrites],
                clipboardRejections:window.clipboardRejections,
              });

              window.renderFormActionCase = async id => {
                const item=fixture.cases.find(candidate=>candidate.id===id);
                if(!item) throw new Error('Unknown form action case '+id);
                window.clipboardMode='resolve';
                window.clipboardWrites=[];
                window.clipboardRejections=0;
                const html=renderMarkdown(item.source);
                root.innerHTML=html;
                if(!enhancer) enhancer=enhanceMarkdown(root,{html,ready:true});
                else enhancer.update({html,ready:true});
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                return snapshot(item,'initial',null);
              };
              window.applyFormAction = async action => {
                const element=action.selector ? document.querySelector(action.selector) : null;
                if(action.selector && !element) throw new Error('Missing form action target '+action.selector+' in '+root.innerHTML);
                if(action.mode==='setValue') element.value=action.value;
                else if(action.mode==='setChecked') element.checked=action.value;
                else if(action.mode==='select') element.value=action.value;
                else if(action.mode==='clipboard') window.clipboardMode=action.result;
                else if(action.mode==='wait') await new Promise(resolve=>setTimeout(resolve,action.ms));
                else if(action.mode==='domClick') element.click();
                else if(action.mode==='click') throw new Error('Pointer clicks are dispatched through Chromium input');
                else if(action.mode==='key') throw new Error('Keyboard actions are dispatched through Chromium input');
                else throw new Error('Unknown form action mode '+action.mode);
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
              };
              window.captureFormActionSnapshot=(id,phase,actionIndex)=>snapshot(fixture.cases.find(c=>c.id===id),phase,actionIndex);
              window.destroyMarkdownEnhancer=()=>enhancer?.destroy();
              await preloadRenderers();
              window.fixtureReady=true;
            </script>
          </body></html>`;
          res.setHeader('Content-Type','text/html');
          res.end(await server.transformIndexHtml('/parity.html',html));
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
      const page=await browser.newPage({viewport:{width,height:fixture.height},deviceScaleFactor:1,isMobile:true,hasTouch:true,locale:'en-US',colorScheme});
      const cdp=await page.context().newCDPSession(page);
      const pageErrors=[],consoleErrors=[],badResponses=[];
      page.on('pageerror',error=>pageErrors.push(error.stack||error.message));
      page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
      page.on('response',response=>{if(response.status()>=400)badResponses.push(`${response.status()} ${response.url()}`);});
      await page.addInitScript(() => {
        Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{
          window.clipboardWrites.push(text);
          if(window.clipboardMode==='reject') throw new DOMException('Clipboard denied','NotAllowedError');
        }}});
      });
      await page.goto('http://127.0.0.1:18915/parity.html');
      await page.waitForFunction(()=>window.fixtureReady);
      const recordAccessibility=async result=>{
        const {root:document}=await cdp.send('DOM.getDocument');
        const {nodeIds}=await cdp.send('DOM.querySelectorAll',{nodeId:document.nodeId,selector:'#fixture button, #fixture input[type=button], #fixture input[type=reset], #fixture input[type=submit]'});
        if(nodeIds.length!==result.buttons.length) throw new Error('AX button count differs');
        for(let index=0;index<nodeIds.length;index++) {
          const {nodes}=await cdp.send('Accessibility.getPartialAXTree',{nodeId:nodeIds[index],fetchRelatives:false});
          const node=nodes[0];
          result.buttons[index].accessibleRole=node?.role?.value ?? '';
          result.buttons[index].accessibleName=node?.name?.value ?? '';
          result.buttons[index].accessibleDescription=node?.description?.value ?? '';
        }
      };
      const compactObservations=observations=>{
        const initial=observations[0];
        const baselineByKey=rows=>new Map(rows.map((row,index)=>[row.id||`${row.tag}-${index}`,row]));
        const compactRows=(rows,initialRows,kind)=>{
          const baseline=baselineByKey(initialRows);
          return rows.map((row,index)=>{
            const original=baseline.get(row.id||`${row.tag}-${index}`);
            const computedChanges=Object.fromEntries(Object.entries(row.computed||{}).filter(([key,value])=>original?.computed?.[key]!==value));
            if(kind==='control') return {
              id:row.id,tag:row.tag,type:row.type,value:row.value,checked:row.checked,
              disabled:row.disabled,focused:row.focused,selectedIndices:row.selectedIndices,
              box:row.box,computedChanges,
            };
            return {
              id:row.id,tag:row.tag,type:row.type,value:row.value,label:row.label,
              textContent:row.textContent,disabled:row.disabled,focused:row.focused,
              accessibleRole:row.accessibleRole,accessibleName:row.accessibleName,
              box:row.box,computedChanges,
            };
          });
        };
        return observations.map((row,index)=>index===0?row:{
          id:row.id,phase:row.phase,actionIndex:row.actionIndex,
          controls:compactRows(row.controls,initial.controls,'control'),
          buttons:compactRows(row.buttons,initial.buttons,'button'),
          activeElement:row.activeElement,
          clipboardWrites:row.clipboardWrites,
          clipboardRejections:row.clipboardRejections,
          consoleErrors:row.consoleErrors,
        });
      };
      const caseResults=[];
      for(const item of fixture.cases) {
        const observations=[];
        let result=await page.evaluate(id=>window.renderFormActionCase(id),item.id);
        result.consoleErrors=consoleErrors.slice();
        await recordAccessibility(result);
        observations.push(result);
        await page.screenshot({path:resolve(out,`html-form-actions-web-${colorScheme}-${width}-${item.id}-00-initial.png`),fullPage:true});
        for(let index=0;index<(item.actions??[]).length;index++) {
          const action=item.actions[index];
          if(action.mode==='click') {
            await page.locator(action.selector).click();
            await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          } else if(action.mode==='key') {
            const target=page.locator(action.selector);
            await target.focus();
            await page.keyboard.press(action.key);
            await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          } else {
            await page.evaluate(action=>window.applyFormAction(action),action);
          }
          result=await page.evaluate(({id,phase,actionIndex})=>window.captureFormActionSnapshot(id,phase,actionIndex),{id:item.id,phase:action.id,actionIndex:index});
          result.consoleErrors=consoleErrors.slice();
          await recordAccessibility(result);
          observations.push(result);
          const suffix=String(index+1).padStart(2,'0')+'-'+action.id.replace(/[^a-z0-9-]/gi,'-');
          await page.screenshot({path:resolve(out,`html-form-actions-web-${colorScheme}-${width}-${item.id}-${suffix}.png`),fullPage:true});
        }
        if(observations.some(row=>row.consoleErrors.length)) throw new Error(`Console errors in ${item.id}: ${observations.flatMap(row=>row.consoleErrors).join(' | ')}`);
        caseResults.push({id:item.id,observations:compactObservations(observations)});
      }
      if(pageErrors.length) throw new Error(pageErrors.join('\n'));
      if(badResponses.length) throw new Error(badResponses.join('\n'));
      widthResults.push({width,cases:caseResults});
      await page.evaluate(()=>window.destroyMarkdownEnhancer?.());
      await page.close();
    }
    themes[colorScheme]={widths:widthResults};
  }
  const merged={fixture:fixture.id,reference:fixture.webRevision,browserVersion:await browser.version(),themes};
  await writeFile(resolve(out,'html-form-actions-web.json'),JSON.stringify(merged,null,2)+'\n');
  await writeFile(resolve(root,'fixtures/mobile-parity/html-form-actions-expected.json'),JSON.stringify(merged,null,2)+'\n');
  console.log(out);
} finally {
  await browser?.close();
  await server.close();
}
