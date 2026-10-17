import { requireTestBrowserExecutable } from './test_browser.mjs';
// node apps/android/tool/parity/capture_html_input_sizing_web.mjs
// Record actual Chromium intrinsic widths and the resolved font used by the
// pinned web renderer for HTML text, number, and textarea controls.
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const fixturePath = resolve(root, 'fixtures/mobile-parity/html-input-sizing.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const pinnedRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
if (fixture.webRevision !== pinnedRevision) throw new Error('input sizing fixture must use pinned web revision');
execFileSync('git', ['diff', '--exit-code', pinnedRevision, '--', 'apps/web'], { cwd: root });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const out = resolve(root, 'apps/android/build/parity');
await mkdir(out, { recursive: true });

const server = await createServer({
  cacheDir: resolve(out, 'vite-cache-html-input-sizing'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18916,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [{
    name: 'html-input-sizing-parity',
    configureServer(server) {
      server.middlewares.use('/parity.html', async (_, res, next) => {
        try {
          const html = `<!doctype html><html><head>
            <link rel="icon" href="data:,">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <style>
              body{overflow:auto!important}
              #fixture{padding:16px;font-family:Arial,sans-serif;font-size:15px;line-height:1.65;--font-mono:Menlo,monospace}
              #fixture > div{display:block;margin:0 0 8px}
              .font-probe{position:fixed;top:0;left:0;z-index:-1;opacity:.001;pointer-events:none;white-space:pre}
            </style>
          </head><body><main id="fixture" class="markdown"></main>
            <script type="module">
              import '/src/app.css';
              import '/src/markdown.css';
              import { preloadRenderers, renderMarkdown } from '/src/lib/markdown.ts';

              const fixture = ${fixtureSource};
              const root = document.querySelector('#fixture');
              const rect = element => {
                const r=element.getBoundingClientRect();
                return {x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,right:r.right,bottom:r.bottom,left:r.left};
              };
              const attrs = element => Object.fromEntries([...element.attributes].map(a=>[a.name,a.value]));
              const computed = element => {
                const s=getComputedStyle(element);
                const keys=['display','boxSizing','width','height','minWidth','maxWidth',
                  'marginTop','marginRight','marginBottom','marginLeft',
                  'paddingTop','paddingRight','paddingBottom','paddingLeft',
                  'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth',
                  'fontFamily','fontSize','fontWeight','fontStyle','fontStretch','lineHeight','letterSpacing',
                  'appearance','verticalAlign','overflowX','overflowY'];
                return Object.fromEntries(keys.map(k=>[k,s[k]]));
              };
              const readFontMetrics = element => {
                const style=getComputedStyle(element);
                const probe=document.createElement('span');
                probe.className='font-probe';
                probe.id='font-probe-'+element.id;
                probe.textContent='0xWMabcdefghijklmnopqrstuvwxyz';
                probe.style.font=style.font;
                probe.style.letterSpacing=style.letterSpacing;
                probe.style.fontKerning=style.fontKerning;
                probe.style.fontFeatureSettings=style.fontFeatureSettings;
                probe.style.fontVariationSettings=style.fontVariationSettings;
                document.body.append(probe);
                const probeStyle=getComputedStyle(probe);
                const canvas=document.createElement('canvas');
                const context=canvas.getContext('2d');
                context.font=probeStyle.font;
                const widths=Object.fromEntries(['0','x','W','M','abcdefghijklmnopqrstuvwxyz'].map(text=>[text,context.measureText(text).width]));
                const result={
                  fontFamily:probeStyle.fontFamily,fontSize:probeStyle.fontSize,fontWeight:probeStyle.fontWeight,
                  fontStyle:probeStyle.fontStyle,lineHeight:probeStyle.lineHeight,letterSpacing:probeStyle.letterSpacing,
                  sampleWidths:widths,probeId:probe.id,
                };
                return result;
              };
              window.renderInputSizingCase = async id => {
                const item=fixture.cases.find(candidate=>candidate.id===id);
                if(!item) throw new Error('Unknown input sizing case '+id);
                root.innerHTML=renderMarkdown(item.source);
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                const controls=[...root.querySelectorAll('input,textarea')].map(element=>({
                  id:element.id||null,
                  tag:element.tagName.toLowerCase(),
                  type:element.type||null,
                  attributes:attrs(element),
                  value:element.value,
                  box:rect(element),
                  computed:computed(element),
                  fontMetrics:readFontMetrics(element),
                }));
                return {
                  id:item.id,
                  sanitizedDOM:root.innerHTML,
                  controls,
                  environment:{platform:navigator.platform,userAgent:navigator.userAgent,devicePixelRatio},
                };
              };
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
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const pageErrors=[],consoleErrors=[],badResponses=[];
      page.on('pageerror',error=>pageErrors.push(error.stack||error.message));
      page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
      page.on('response',response=>{if(response.status()>=400)badResponses.push(`${response.status()} ${response.url()}`);});
      await page.goto('http://127.0.0.1:18916/parity.html');
      await page.waitForFunction(()=>window.fixtureReady);
      const caseResults=[];
      for(const item of fixture.cases) {
        const result=await page.evaluate(id=>window.renderInputSizingCase(id),item.id);
        const {root:document}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});
        for(const control of result.controls) {
          const {nodeIds}=await cdp.send('DOM.querySelectorAll',{nodeId:document.nodeId,selector:`#fixture #${control.id}`});
          if(nodeIds.length!==1) throw new Error(`Could not resolve CDP node for ${control.id}`);
          const {fonts}=await cdp.send('CSS.getPlatformFontsForNode',{nodeId:nodeIds[0]});
          control.platformFonts=fonts.map(font=>({familyName:font.familyName,isCustomFont:font.isCustomFont,glyphCount:font.glyphCount}));
          const {nodeIds:probeNodeIds}=await cdp.send('DOM.querySelectorAll',{nodeId:document.nodeId,selector:`#${control.fontMetrics.probeId}`});
          if(probeNodeIds.length!==1) throw new Error(`Could not resolve font probe for ${control.id}`);
          const {fonts:probeFonts}=await cdp.send('CSS.getPlatformFontsForNode',{nodeId:probeNodeIds[0]});
          control.fontMetrics.platformFonts=probeFonts.map(font=>({familyName:font.familyName,isCustomFont:font.isCustomFont,glyphCount:font.glyphCount}));
          delete control.fontMetrics.probeId;
        }
        if(result.controls.some(control=>control.box.width<=0)) throw new Error(`Non-positive input width in ${item.id}`);
        if(result.controls.some(control=>!control.computed.fontSize||!control.computed.fontFamily)) throw new Error(`Missing input font style in ${item.id}`);
        caseResults.push(result);
        await page.evaluate(()=>document.querySelectorAll('.font-probe').forEach(probe=>probe.remove()));
        await page.screenshot({path:resolve(out,`html-input-sizing-web-${colorScheme}-${width}-${item.id}.png`),fullPage:true});
      }
      if(pageErrors.length) throw new Error(pageErrors.join('\n'));
      if(consoleErrors.length) throw new Error(consoleErrors.join('\n'));
      if(badResponses.length) throw new Error(badResponses.join('\n'));
      widthResults.push({width,cases:caseResults});
      await page.close();
    }
    themes[colorScheme]={widths:widthResults};
  }
  const merged={fixture:fixture.id,reference:fixture.webRevision,browserVersion:await browser.version(),themes};
  await writeFile(resolve(out,'html-input-sizing-web.json'),JSON.stringify(merged,null,2)+'\n');
  await writeFile(resolve(root,'fixtures/mobile-parity/html-input-sizing-expected.json'),JSON.stringify(merged,null,2)+'\n');
  console.log(out);
} finally {
  await browser?.close();
  await server.close();
}
