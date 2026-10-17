import { requireTestBrowserExecutable } from './test_browser.mjs';
// Capture pinned Message/ToolCard image loading, failure, and lazy layout.
import assert from 'node:assert/strict';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixture = JSON.parse(
  await readFile(resolve(root, 'fixtures/mobile-parity/timeline-image.json'), 'utf8'),
);
assert.equal(fixture.webRevision, revision);
execFileSync(
  'git',
  ['diff', '--exit-code', revision, '--', 'apps/web', ':!apps/web/tool'],
  { cwd: root },
);
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const output = resolve(root, 'apps/android/build/parity');
await mkdir(output, { recursive: true });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');

const imageRequests = [];
let pendingStarted;
let pendingStartedResolve;
let releasePending;
let pendingGate;
function resetImageServerState() {
  imageRequests.length = 0;
  pendingStarted = new Promise((resolve) => (pendingStartedResolve = resolve));
  pendingGate = new Promise((resolve) => (releasePending = resolve));
}
resetImageServerState();

function sendSvg(res, svg) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-store');
  res.end(svg);
}
const server = await createServer({
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  cacheDir: resolve(output, 'vite-cache-timeline-image'),
  server: {
    host: '127.0.0.1',
    port: 18929,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'timeline-image-fixture',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (!req.url) return next();
          const url = new URL(req.url, 'http://127.0.0.1');
          if (!url.pathname.startsWith('/timeline-image/')) return next();
          const id = url.searchParams.get('id') ?? 'missing-id';
          const request = { id, path: url.pathname, status: 'pending' };
          imageRequests.push(request);
          if (url.pathname.endsWith('/pending.svg')) {
            pendingStartedResolve?.();
            pendingGate.then(() => {
              if (!res.destroyed) {
                request.status = 200;
                sendSvg(res, fixture.assets.landscape);
              }
            });
            return;
          }
          if (url.pathname.endsWith('/broken.svg')) {
            request.status = 404;
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain');
            res.setHeader('Cache-Control', 'no-store');
            res.end('fixture not found');
            return;
          }
          if (url.pathname.endsWith('/invalid.svg')) {
            request.status = 200;
            res.statusCode = 200;
            res.setHeader('Content-Type', 'image/svg+xml');
            res.setHeader('Cache-Control', 'no-store');
            res.end('not an image document');
            return;
          }
          if (url.pathname.endsWith('/portrait.svg')) {
            request.status = 200;
            sendSvg(res, fixture.assets.portrait);
            return;
          }
          if (url.pathname.endsWith('/landscape.svg')) {
            request.status = 200;
            sendSvg(res, fixture.assets.landscape);
            return;
          }
          request.status = 404;
          res.statusCode = 404;
          res.end('unknown local image fixture');
        });
        vite.middlewares.use('/timeline-image.html', async (_, res, next) => {
          try {
            const html = `<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
              body{margin:0;overflow:auto!important}#fixture{width:min(780px,100%);margin:0 auto;padding:16px 32px 32px;display:flex;flex-direction:column}
              @media(max-width:1100px){#fixture{padding-inline:24px}}@media(max-width:650px){#fixture{padding:8px 14px 20px}}
              .timeline-image-probe-spacer{flex:none}
              </style></head><body><main id="fixture"></main><script type="module">
              import '/src/app.css'; import '/src/markdown.css'; import {mount,tick} from 'svelte';
              import Message from '/src/lib/components/Message.svelte'; import {app} from '/src/lib/app.svelte.ts';
              const fixture=${fixtureSource}; const target=document.querySelector('#fixture'); app.sessions=[];
              const sources=[...fixture.primaryCases];
              const message={id:'message-image-states',role:'assistant',content:'Image loading and failure cases',createdAt:'2026-10-10T00:00:00Z',images:sources.map(item=>({mimeType:'image/svg+xml',url:item.url}))};
              mount(Message,{target,props:{message}}); await tick();
              const loaded=document.querySelector('img[src*="loaded-portrait"]');
              const failed=document.querySelector('img[src*="broken-http"]');
              for(let i=0;i<500&&(!loaded?.naturalWidth||!failed?.complete);i++)await new Promise(resolve=>setTimeout(resolve,10));
              const tool={id:'tool-image-case',name:'read',status:'failed',input:{path:'image-output'},output:'Expected tool failure fixture',images:[{mimeType:'image/svg+xml',url:fixture.toolCase.url},{mimeType:'image/svg+xml',url:fixture.toolBrokenCase.url}]};
              mount(Message,{target,props:{message:{id:'message-tool-image',role:'assistant',content:'',createdAt:'2026-10-10T00:00:01Z',tools:[tool]}}}); await tick();
              for(const item of fixture.lazyCases){
                const previous=target.lastElementChild;
                const bottom=previous?previous.getBoundingClientRect().bottom+window.scrollY:0;
                const spacer=document.createElement('div'); spacer.className='timeline-image-probe-spacer'; spacer.style.height=Math.max(0,item.targetTop-bottom)+'px'; target.append(spacer);
                const lazyMessage={id:'message-'+item.id,role:'user',content:item.id+' (target '+item.targetTop+'px)',createdAt:'2026-10-10T00:00:02Z',images:[{mimeType:'image/svg+xml',url:item.url}]};
                mount(Message,{target,props:{message:lazyMessage}}); await tick();
              }
              window.timelineImageEvents=[];
              for(const img of document.images){const id=new URL(img.currentSrc||img.src,location.href).searchParams.get('id');for(const name of ['load','error'])img.addEventListener(name,()=>window.timelineImageEvents.push({id,event:name,complete:img.complete,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight}));}
              window.timelineImageStates=()=>[...document.images].map(img=>{const r=img.getBoundingClientRect(),style=getComputedStyle(img),u=new URL(img.currentSrc||img.src,location.href),container=img.closest('.message-images,.tool-images'),cr=container?.getBoundingClientRect();return{id:u.searchParams.get('id'),source:u.pathname+u.search,alt:img.alt,loading:img.loading,complete:img.complete,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,rect:{x:r.x,y:r.y,topDocument:r.top+window.scrollY,width:r.width,height:r.height},container:container?.className??null,containerRect:cr?{x:cr.x,y:cr.y+window.scrollY,width:cr.width,height:cr.height}:null,style:{maxWidth:style.maxWidth,maxHeight:style.maxHeight,borderRadius:style.borderRadius,objectFit:style.objectFit,backgroundColor:style.backgroundColor,fontFamily:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight}};});
              await document.fonts.ready; window.captureReady=true;
              </script></body></html>`;
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/timeline-image.html', html));
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
  const browserVersion = browser.version();
  const captures = [];
  for (const width of fixture.widths) {
    for (const theme of ['light', 'dark']) {
      resetImageServerState();
      const page = await browser.newPage({
        viewport: { width, height: fixture.height },
        colorScheme: theme,
        deviceScaleFactor: 1,
      });
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(String(error)));
      await page.goto('http://127.0.0.1:18929/timeline-image.html', {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForFunction(() => window.captureReady === true);
      await page.waitForFunction(() => {
        const states = window.timelineImageStates();
        return states.some((item) => item.id === 'loaded-portrait' && item.naturalWidth > 0) &&
          states.some((item) => item.id === 'broken-http' && item.complete);
      });
      let pendingRequestStarted = false;
      try {
        await Promise.race([
          pendingStarted,
          new Promise((_, reject) => setTimeout(() => reject(new Error('pending image request timeout')), 2500)),
        ]);
        pendingRequestStarted = true;
      } catch {}
      await page.waitForTimeout(100);
      const environment = await page.evaluate(() => ({
        viewport: { width: window.innerWidth, height: window.innerHeight },
        connection: {
          effectiveType: navigator.connection?.effectiveType ?? null,
          rtt: navigator.connection?.rtt ?? null,
          downlink: navigator.connection?.downlink ?? null,
          saveData: navigator.connection?.saveData ?? null,
        },
      }));
      const initialStates = await page.evaluate(() => window.timelineImageStates());
      const initialRequests = imageRequests.map((request) => ({ ...request }));
      const initialEvents = await page.evaluate(() => [...window.timelineImageEvents]);
      const prefix = `timeline-image-web-${width}-${theme}`;
      const initialScreenshot = `${prefix}-initial.png`;
      await page.screenshot({ path: resolve(output, initialScreenshot) });

      releasePending();
      await page.waitForFunction(() => {
        const states = window.timelineImageStates();
        return states.some((item) => item.id === 'loading-held' && item.complete && item.naturalWidth > 0);
      });
      const scrollPhases = [];
      for (const requestedScroll of fixture.scrollOffsets) {
        await page.evaluate((y) => window.scrollTo(0, y), requestedScroll);
        await page.waitForTimeout(120);
        const phase = await page.evaluate(() => ({
          scrollY: window.scrollY,
          states: window.timelineImageStates().filter((item) => item.id?.startsWith('lazy-')),
        }));
        scrollPhases.push({
          requestedScroll,
          ...phase,
          requests: imageRequests.map((request) => ({ ...request })),
        });
      }
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForFunction(() =>
        window.timelineImageStates().filter((item) => item.id?.startsWith('lazy-')).every((item) => item.complete),
      );
      const fullPageStates = await page.evaluate(() => window.timelineImageStates());
      const finalEvents = await page.evaluate(() => [...window.timelineImageEvents]);
      const finalScreenshot = `${prefix}-loaded-full-page.png`;
      await page.screenshot({ path: resolve(output, finalScreenshot), fullPage: true });

      const sourceChangeProbe = await page.evaluate(async () => {
        const img = [...document.images].find((item) => new URL(item.src).searchParams.get('id') === 'loaded-landscape');
        if (!img) throw new Error('loaded-landscape probe image missing');
        const measure = () => {const r=img.getBoundingClientRect();return{complete:img.complete,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,width:r.width,height:r.height,source:new URL(img.src).pathname+new URL(img.src).search};};
        const before=measure();
        const loaded=new Promise((resolve) => {img.addEventListener('load',resolve,{once:true});img.addEventListener('error',resolve,{once:true});});
        img.src='/timeline-image/portrait.svg?id=source-change-probe';
        const immediate=measure();
        await loaded;
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return {method:'harness direct img.src reassignment; the pinned Svelte each key is separately source-audited',before,immediate,after:measure()};
      });
      assert.deepEqual(pageErrors, []);
      captures.push({
        width,
        theme,
        viewportHeight: fixture.height,
        environment,
        viewportScrollOffsets: fixture.scrollOffsets,
        pendingRequestStarted,
        initialStates,
        initialRequests,
        initialEvents,
        scrollPhases,
        finalStates: fullPageStates,
        finalRequests: imageRequests.map((request) => ({ ...request })),
        finalEvents,
        sourceChangeProbe,
        screenshots: { initial: initialScreenshot, loadedFullPage: finalScreenshot },
        pageErrors,
      });
      await page.close();
    }
  }
  const result = {
    reference: revision,
    browserVersion,
    requestMode: 'local Vite image endpoints; no browser request interception',
    cases: captures,
  };
  await writeFile(
    resolve(root, 'fixtures/mobile-parity/timeline-image-expected.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      browserVersion,
      configurations: captures.length,
      imageStatesPerConfig: captures[0]?.finalStates.length,
      requestsPerConfig: captures.map((capture) => capture.finalRequests.length),
      pendingStarted: captures.map((capture) => capture.pendingRequestStarted),
      pageErrors: captures.flatMap((capture) => capture.pageErrors),
    }),
  );
} finally {
  releasePending?.();
  await browser?.close();
  await server.close();
}
