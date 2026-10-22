import { requireTestBrowserExecutable } from './test_browser.mjs';
// node apps/android/tool/parity/capture_web.mjs
// Starts a temporary Vite server with the pinned web renderer and CSS.
import assert from 'node:assert/strict';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const kinds = [
  'attachments',
  'backend-settings',
  'syntax-highlighting',
  'html',
  'markdown-selection',
  'markdown-images',
  'markdown-links',
  'browser',
  'terminal',
  'git',
  'observational-memory',
  'tasks',
  'side-panel',
  'files',
  'streaming',
  'jobs',
  'workspace',
  'navigation',
];
const kind = kinds.find((name) => process.argv.includes('--' + name)) ?? 'markdown';
const fixture = JSON.parse(
  await readFile(resolve(root, `fixtures/mobile-parity/${kind}.json`), 'utf8'),
);
const source = JSON.stringify(fixture).replaceAll('<', '\\u003c');
// Harness additions are not part of the pinned product. Keep every production
// source/configuration change inside the comparison, excluding only tool files.
execFileSync('git', ['diff', '--exit-code', fixture.webRevision, '--', 'apps/web', ':!apps/web/tool'], { cwd: root });
// Match the actual settings content rules without including its not-yet-ported modal chrome.
const settingsSource = await readFile(
  resolve(root, 'apps/web/src/lib/components/dialogs/SettingsDialog.svelte'),
  'utf8',
);
const modalSource = await readFile(
  resolve(root, 'apps/web/src/lib/components/dialogs/Modal.svelte'),
  'utf8',
);
const h3Rule = settingsSource.match(/:global\(\.settings-section h3\)\s*(\{[^}]+\})/)[1];
const pRule = modalSource.match(/:global\(p\)\s*(\{[^}]+\})/)[1];
const pMargins = settingsSource.match(/:global\(\.settings-section p\)\s*(\{[^}]+\})/)[1];
const out = resolve(root, 'apps/android/build/parity');
await mkdir(out, { recursive: true });
const server = await createServer({
  cacheDir: resolve(out, 'vite-cache'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18903,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'parity-fixture',
      configureServer(server) {
        if (kind === 'markdown-images') {
          for (const [url, key] of [
            ['/parity-images/wide.svg', 'wide'],
            ['/images/chart.svg', 'svg'],
          ]) {
            server.middlewares.use(url, (_, res) => {
              res.setHeader('Content-Type', 'image/svg+xml');
              res.end(fixture[key]);
            });
          }
          server.middlewares.use('/parity-images/missing.png', (_, res) => {
            res.setHeader('Content-Type', 'image/png');
            res.end('invalid image fixture');
          });
        }

        server.middlewares.use('/parity.html', async (_, res, next) => {
          const send = async (html) => {
            try {
              res.end(await server.transformIndexHtml('/parity.html', html));
            } catch (error) {
              next(error);
            }
          };
          res.setHeader('Content-Type', 'text/html');
          if (kind === 'markdown-selection') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{overflow:auto!important}#fixture{padding:14px;font-family:Arial;font-size:15px;line-height:1.65;--font-mono:Menlo,monospace}</style></head><body><main id="fixture" class="markdown"></main><script type="module">
            import '/src/app.css'; import '/src/markdown.css';
            import {preloadRenderers,renderMarkdown} from '/src/lib/markdown.ts';
            const fixture=${source}; await preloadRenderers();
            const target=document.querySelector('#fixture');
            window.selectionCases=fixture.cases.map(c=>{
              target.innerHTML=renderMarkdown(c.source);const range=document.createRange();range.selectNodeContents(target);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
              const result={id:c.id,text:selection.toString()};
              if(c.ranges)result.ranges=c.ranges.map(r=>{
                const point=p=>{if(p.selector)return [target.querySelector(p.selector),p.offset];const walk=document.createTreeWalker(target,NodeFilter.SHOW_TEXT);let node;while(node=walk.nextNode())if(node.textContent===p.text)return [node,p.offset];throw new Error('Missing selection text '+p.text);};
                const [start,so]=point(r.from),[end,eo]=point(r.to);
                selection.setBaseAndExtent(start,so,end,eo);const forward=selection.toString();selection.setBaseAndExtent(end,eo,start,so);return {id:r.id,text:forward,reverse:selection.toString()};
              });return result;
            });
            getSelection().removeAllRanges();target.innerHTML=renderMarkdown(fixture.cases.map(c=>c.source).join('\\n\\n'));
            await document.fonts.ready;window.captureReady=true;
            </script></body></html>`);
            return;
          }
          if (kind === 'markdown-links') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{overflow:auto!important}#fixture{padding:14px;font-family:Arial;font-size:15px;line-height:1.75;--font-mono:Menlo,monospace}@media(max-width:650px){#fixture{line-height:1.65}}</style></head><body><main id="fixture" class="markdown"></main><script type="module">
            import '/src/app.css'; import '/src/markdown.css';
            import {preloadRenderers,renderMarkdown} from '/src/lib/markdown.ts';
            import {parseFileLink} from '/src/lib/file-links.ts';
            const fixture=${source}; await preloadRenderers();
            window.linkCases=fixture.cases.map(c=>{const el=document.createElement('div');el.innerHTML=renderMarkdown(c.source);return {id:c.id,links:[...el.querySelectorAll('a')].map(a=>({text:a.textContent,href:a.getAttribute('href'),code:!!a.querySelector('code'),target:parseFileLink(a.getAttribute('href'),c.base)??null}))};});
            document.querySelector('#fixture').innerHTML=renderMarkdown(fixture.source);
            await document.fonts.ready;window.captureReady=true;
            </script></body></html>`);
            return;
          }
          if (kind === 'streaming') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:Arial!important;--font-mono:Menlo,monospace!important}#fixture{padding:14px;font-size:15px;line-height:1.65}.markdown.streaming *::after{animation:none!important}</style></head><body><div id="fixture"></div><script type="module">
        import '/src/app.css'; import '/src/markdown.css'; import {mount,tick} from 'svelte'; import Markdown from '/src/lib/components/Markdown.svelte'; import {preloadRenderers,stableBlockEnd} from '/src/lib/markdown.ts';
        const fixture=${source}; await preloadRenderers();
        window.boundaries=fixture.cases.map(c=>({...c,end:stableBlockEnd(c.source,c.from)}));
        mount(Markdown,{target:document.querySelector('#fixture'),props:{source:fixture.source,streaming:true}});
        await tick(); await document.fonts.ready; window.captureReady=true;
      </script></body></html>`);
            return;
          }
          if (kind === 'jobs') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:Arial!important;--font-mono:Menlo,monospace!important}#fixture{height:56px;display:flex;align-items:center;justify-content:flex-end;padding-right:46px}</style></head><body><div id="fixture"></div><script type="module">
        import '/src/app.css'; import {mount,tick} from 'svelte'; import JobsMenu from '/src/lib/components/JobsMenu.svelte'; import {app} from '/src/lib/app.svelte.ts';
        const fixture=${source}; Date.now=()=>fixture.now;
        const originalFetch=window.fetch.bind(window);
        window.fetch=(input,init)=>String(input).includes('/panel/background/')?Promise.resolve(new Response(JSON.stringify({output:fixture.output}),{headers:{'Content-Type':'application/json'}})):originalFetch(input,init);
        app.sessionState={session:{id:'s'},control:{heldByCurrentClient:true,generation:3}};
        app.panel.reset('s',fixture); mount(JobsMenu,{target:document.querySelector('#fixture')}); await tick();
        document.querySelector('.jobs-trigger').click(); await tick();
        document.querySelector('.job-row').click(); document.querySelector('.jobs-section-toggle').click();
        await new Promise(resolve=>setTimeout(resolve,150)); await tick(); await document.fonts.ready; window.captureReady=true;
      </script></body></html>`);
            return;
          }
          if (kind === 'attachments') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:Arial!important}#fixture{height:100dvh;display:flex;flex-direction:column;justify-content:flex-end}</style></head><body><div id="fixture"></div><script type="module">
        import '/src/app.css'; import { mount, tick } from 'svelte';
        import { app } from '/src/lib/app.svelte.ts';
        import Composer from '/src/lib/components/Composer.svelte';
        import { saveLayout } from '/src/lib/storage.ts';
        const fixture=${source}; for (const [key,value] of Object.entries(fixture.preferences??{})) saveLayout(key,value); app.models=fixture.models; app.connection='connected'; app.activeSessionId='s'; app.draft=fixture.draft; app.uploads=fixture.attachments;
        app.sessionState={...fixture.state,selectedModelId:fixture.state.modelId,selectedModelProvider:fixture.state.modelProvider,thinkingLevel:fixture.state.thinking,control:{heldByCurrentClient:true,generation:1}};
        mount(Composer,{target:document.querySelector('#fixture')}); await tick(); await Promise.all([...document.images].map(i=>i.decode().catch(()=>{}))); await document.fonts.ready; window.captureReady=true;
      </script></body></html>`);
            return;
          }
          if (kind === 'browser') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:Arial!important}#fixture{height:100dvh}</style></head><body><div id="fixture"></div><script type="module">
        import '/src/app.css'; import '/src/lib/components/panel/panel.css'; import {mount,tick} from 'svelte'; import BrowserTab from '/src/lib/components/panel/BrowserTab.svelte';
        const fixture=${source}; const view=new URLSearchParams(location.search).get('view');let ready=false;
        window.WebSocket=class extends EventTarget {static OPEN=1;readyState=1;constructor(){super();setTimeout(()=>{this.dispatchEvent(new Event('open'));if(view==='unavailable'){this.dispatchEvent(new CloseEvent('close',{code:4403,reason:'The browser is disabled on this node.'}));}else{this.frame({type:'state',state:{...fixture.state,active:view!=='empty',mode:view==='user'?'user':'agent',handoff:view==='user'?'Please finish the form.':null,agentWaiting:view==='user'}});this.frame({type:'log',entries:fixture.log});if(view!=='empty')this.frame({type:'frame',data:fixture.image,width:640,height:400});}ready=true;},10);}frame(frame){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(frame)}));}send(raw){const message=JSON.parse(raw);if(message.type==='log_image')this.frame({type:'log_image',index:message.index,data:fixture.image});}close(){}};
        mount(BrowserTab,{target:document.querySelector('#fixture'),props:{sessionId:'s',generation:2,hasControl:true,active:true}});
        for(let n=0;n<100&&!ready;n++){await new Promise(resolve=>setTimeout(resolve,10));await tick();}await tick();
        if(view==='activity'||view==='replay'){document.querySelector('[aria-label="Activity and replay"]').click();await tick();}
        if(view==='replay'){document.querySelector('.browser-log li button').click();await tick();}
        await Promise.all([...document.images].map(img=>img.decode().catch(()=>{})));await document.fonts.ready;window.captureReady=true;
      </script></body></html>`);
            return;
          }
          if (kind === 'terminal') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:Arial!important;--font-mono:Menlo,monospace!important}#fixture{height:100dvh}.xterm-cursor-layer{animation:none!important}</style></head><body><div id="fixture"></div><script type="module">
        import '/src/app.css'; import '/src/lib/components/panel/panel.css'; import {mount,tick} from 'svelte'; import TerminalTab from '/src/lib/components/panel/TerminalTab.svelte';
        const fixture=${source}; const view=new URLSearchParams(location.search).get('view'); const empty=['empty','readonly'].includes(view); let ready=0;
        window.fetch=()=>Promise.resolve(new Response(JSON.stringify({terminals:empty?[]:fixture.terminals}),{headers:{'Content-Type':'application/json'}}));
        window.WebSocket=class extends EventTarget {static OPEN=1;readyState=1;constructor(){super();setTimeout(()=>{this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'ready',replay:fixture.replay})}));if(view==='lost')this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'error',code:'lost_control'})}));if(view==='exited')this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'exit',exitCode:7})}));if(view==='reconnecting')this.dispatchEvent(new CloseEvent('close',{code:1006}));ready++;},30);}send(){}close(){}};
        mount(TerminalTab,{target:document.querySelector('#fixture'),props:{sessionId:'s',generation:2,hasControl:view!=='readonly',active:true}});
        for(let n=0;n<100&&(!empty?ready<2:!document.querySelector('.terminal-empty'));n++){await new Promise(resolve=>setTimeout(resolve,10));await tick();}
        await new Promise(resolve=>setTimeout(resolve,80));await document.fonts.ready;window.captureReady=true;
      </script></body></html>`);
            return;
          }
          if (kind === 'git') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:Arial!important;--font-mono:Menlo,monospace!important}#fixture{height:100dvh;overflow-y:auto;padding:4px 12px 16px}</style></head><body><div id="fixture"></div><script type="module">
        import '/src/app.css'; import '/src/lib/components/panel/panel.css'; import {mount,tick} from 'svelte'; import GitTab from '/src/lib/components/panel/GitTab.svelte';
        const fixture=${source}; const view=new URLSearchParams(location.search).get('view'); Date.now=()=>fixture.now;
        window.fetch=(input)=>{const url=String(input);const data=url.includes('/commits/')?fixture.commit:url.includes('/diff?')?fixture.diff:url.includes('/log?')?fixture.log:view==='nonrepo'?{repo:false}:view==='clean'?{...fixture.status,files:[]}:fixture.status;return Promise.resolve(new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}}));};
        mount(GitTab,{target:document.querySelector('#fixture'),props:{sessionId:'s'}});
        const wait=async(predicate)=>{for(let n=0;n<100&&!predicate();n++){await new Promise(resolve=>setTimeout(resolve,10));await tick();}};
        await wait(()=>document.querySelector('.branch-line')||document.querySelector('.panel-empty')?.textContent.includes('not a Git repository'));
        if(view==='history'||view==='commit'){document.querySelector('#git-view-history').click();await wait(()=>document.querySelector('.commit-row'));}
        if(view==='commit'){document.querySelector('.commit-row').click();await wait(()=>document.querySelector('.commit-card'));}
        if(view==='diff'){document.querySelector('.file-row').click();await wait(()=>document.querySelector('.diff'));}
        await tick();await document.fonts.ready;window.captureReady=true;
      </script></body></html>`);
            return;
          }
          if (kind === 'observational-memory') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:Arial!important;--font-mono:Menlo,monospace!important}#fixture{height:100dvh;overflow-y:auto;padding:4px 12px 16px}.spin{animation:none!important}</style></head><body><div id="fixture"></div><script type="module">
        import '/src/app.css'; import '/src/lib/components/panel/panel.css'; import {mount,tick} from 'svelte'; import MemoryTab from '/src/lib/components/panel/MemoryTab.svelte'; import {app} from '/src/lib/app.svelte';
        const fixture=${source}; const view=new URLSearchParams(location.search).get('view'); Date.now=()=>fixture.now;
        const panel=structuredClone(fixture.panel); if(view==='working')panel.memoryRuntime=fixture.working; if(view==='disabled')panel.memory.enabled=false; if(view==='unavailable')panel.memory=null;
        window.fetch=()=>Promise.resolve(new Response(JSON.stringify(panel),{headers:{'Content-Type':'application/json'}}));
        app.panel.reset('s');mount(MemoryTab,{target:document.querySelector('#fixture')});
        for(let n=0;n<100 && !app.panel.value;n++){await new Promise(resolve=>setTimeout(resolve,10));await tick();}
        if(view==='all')Array.from(document.querySelectorAll('.segmented button')).find(el=>el.textContent==='all').click();
        if(view==='expanded')Array.from(document.querySelectorAll('.memory-item')).find(el=>el.textContent.includes('a00000000001')).click();
        await tick();await document.fonts.ready;window.captureReady=true;
      </script></body></html>`);
            return;
          }
          if (kind === 'tasks') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:Arial!important;--font-mono:Menlo,monospace!important}#fixture{height:100dvh;overflow-y:auto;padding:4px 12px 16px}</style></head><body><div id="fixture"></div><script type="module">
        import '/src/app.css'; import '/src/lib/components/panel/panel.css'; import {mount,tick} from 'svelte'; import TasksTab from '/src/lib/components/panel/TasksTab.svelte'; import {app} from '/src/lib/app.svelte';
        const fixture=${source}; const view=new URLSearchParams(location.search).get('view');Date.now=()=>fixture.now;
        window.fetch=(input)=>Promise.resolve(new Response(JSON.stringify(String(input).includes('/background/')?fixture.output:view==='empty'?fixture.empty:fixture.panel),{headers:{'Content-Type':'application/json'}}));
        app.panel.reset('s');mount(TasksTab,{target:document.querySelector('#fixture'),props:{sessionId:'s'}});
        for(let n=0;n<100 && !app.panel.value;n++){await new Promise(resolve=>setTimeout(resolve,10));await tick();}
        if(view==='output'){document.querySelector('button.task-row').click();for(let n=0;n<100 && !document.querySelector('.task-output')?.textContent.includes('Starting');n++){await new Promise(resolve=>setTimeout(resolve,10));await tick();}}
        await document.fonts.ready;window.captureReady=true;
      </script></body></html>`);
            return;
          }
          if (kind === 'side-panel') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:Arial!important;--font-mono:Menlo,monospace!important}#fixture{position:absolute;top:56px;right:0;bottom:0;display:flex;--panel-width:360px}</style></head><body><div id="fixture"></div><script type="module">
        import '/src/app.css'; import '/src/markdown.css'; import {mount,tick} from 'svelte'; import SidePanel from '/src/lib/components/panel/SidePanel.svelte'; import {app} from '/src/lib/app.svelte';
        const fixture=${source}; const tab=new URLSearchParams(location.search).get('view');
        const width=Math.min(360,Math.max(280,innerWidth-264-380)); document.querySelector('#fixture').style.setProperty('--panel-width',width+'px');
        window.fetch=(input)=>Promise.resolve(new Response(JSON.stringify(String(input).includes('/panel/context')?fixture.context:String(input).includes('/panel/state')?fixture.panel:fixture.directory),{headers:{'Content-Type':'application/json'}}));
        app.workspaces=[{id:'w',kind:'directory',displayName:'Workspace'}]; app.activeSessionId='s'; app.sessionState={session:{id:'s',workspaceId:'w'},run:{status:'idle'}};app.panel.value=fixture.panel;
        mount(SidePanel,{target:document.querySelector('#fixture'),props:{open:true,tab,width}});
        for(let n=0;n<100 && !document.querySelector(tab==='files'?'.file-row':'.usage-bar');n++){await new Promise(resolve=>setTimeout(resolve,10));await tick();}
        await document.fonts.ready;window.captureReady=true;
      </script></body></html>`);
            return;
          }
          if (kind === 'files' || kind === 'markdown-links') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:Arial!important;--font-mono:Menlo,monospace!important}#fixture{height:100dvh;overflow-y:auto;padding:4px 12px 16px}</style></head><body><div id="fixture"></div><script type="module">
        import '/src/app.css'; import '/src/markdown.css'; import '/src/lib/components/panel/panel.css'; import {mount,tick} from 'svelte'; import FilesTab from '/src/lib/components/panel/FilesTab.svelte'; import {parseFileLink} from '/src/lib/file-links.ts'; import {preloadRenderers} from '/src/lib/markdown.ts';
        const fixture=${source}; const view=new URLSearchParams(location.search).get('view'); const chosen=fixture.files[view]; const originalFetch=window.fetch.bind(window);
        window.fetch=(input,init)=>String(input).includes('/files')?Promise.resolve(new Response(JSON.stringify(String(input).includes('/content')?chosen:fixture.directory),{headers:{'Content-Type':'application/json'}})):originalFetch(input,init);
        await preloadRenderers();
        window.linkCases=fixture.links.map(item=>({...item,actual:parseFileLink(item.href,item.base)??null}));
        mount(FilesTab,{target:document.querySelector('#fixture'),props:{sessionId:'s',openRequest:chosen?{path:chosen.path,seq:1,...(view==='source'?{line:2,endLine:4}:{})}:undefined}});
        await new Promise(resolve=>setTimeout(resolve,150));await tick();await document.fonts.ready;
        await Promise.all([...document.images].map(img=>img.decode().catch(()=>{})));
        await tick(); window.captureReady=true;
      </script></body></html>`);
            return;
          }
          if (kind === 'backend-settings') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:Arial!important;--font-mono:Menlo,monospace!important}body{overflow:auto!important}#fixture{padding:24px}#fixture h3${h3Rule}#fixture p${pRule}#fixture p${pMargins}#fixture .settings-section+.settings-section{margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}#fixture input,#fixture select{width:100%;height:40px;padding:0 12px;border:0;border-radius:var(--radius-md);outline:0;background:var(--bg-subtle);font-size:14px}#fixture input:focus,#fixture select:focus{box-shadow:inset 0 0 0 1px var(--accent)}#fixture label{display:grid;gap:6px;margin:12px 0;color:var(--text-2);font-size:13px;font-weight:500}</style></head><body><div id="fixture"></div><script type="module">
        import '/src/app.css'; import {mount,tick} from 'svelte'; import BackendSettings from '/src/lib/components/BackendSettings.svelte';
        const fixture=${source}; const originalFetch=window.fetch.bind(window);
        window.fetch=(input,init)=>String(input).includes('/api/providers')?Promise.resolve(new Response(JSON.stringify(fixture.settings),{headers:{'Content-Type':'application/json'}})):originalFetch(input,init);
        mount(BackendSettings,{target:document.querySelector('#fixture')});
        for(let n=0;n<100 && !document.querySelector('.backend-card');n++){await new Promise(resolve=>setTimeout(resolve,10));await tick();}
        if(!document.querySelector('.backend-card'))throw new Error('Backend fixture did not load');
        await document.fonts.ready; window.captureReady=true;
      </script></body></html>`);
            return;
          }
          if (kind === 'syntax-highlighting') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:Arial!important}body{overflow:auto!important}#fixture{padding:16px;font-family:Arial;font-size:15px;line-height:1.65;--font-mono:Menlo,monospace}.syntax-case{margin-bottom:20px}.reference-only{position:absolute;left:-10000px}</style></head><body><main id="fixture"></main><script type="module">
        import '/src/app.css';import '/src/markdown.css';
        import {preloadRenderers,renderMarkdown,highlightCode} from '/src/lib/markdown.ts';
        import hljs from 'highlight.js/lib/common';
        await preloadRenderers(); const fixture=${source};
        const root=document.querySelector('#fixture');
        window.syntaxLanguages=hljs.listLanguages();
        window.syntaxCases=fixture.cases.map(item=>{
          const section=document.createElement('section');section.className='markdown syntax-case'+(item.visual?'':' reference-only');
          section.innerHTML=renderMarkdown('~~~'+item.language+'\\n'+item.code+'\\n~~~');
          root.append(section);
          const code=section.querySelector('pre code');
          const readSegments=element=>{const segments=[];
            const walk=node=>{if(node.nodeType===Node.TEXT_NODE){const style=getComputedStyle(node.parentElement); const next={text:node.data,color:style.color,italic:style.fontStyle==='italic',bold:Number(style.fontWeight)>=600};const last=segments.at(-1);if(last&&last.color===next.color&&last.italic===next.italic&&last.bold===next.bold)last.text+=next.text;else segments.push(next);}else for(const child of node.childNodes)walk(child);};
            walk(element);return segments;
          };
          const standalone=highlightCode(item.code,item.language);
          const raw=document.createElement('section');raw.className='markdown reference-only';raw.innerHTML='<pre><code class="hljs">'+standalone+'</code></pre>';root.append(raw);
          return {id:item.id,language:item.language,text:code.textContent,segments:readSegments(code),rawSegments:readSegments(raw.querySelector('code')),standalone};
        });
        await document.fonts.ready;window.captureReady=true;
      </script></body></html>`);
            return;
          }
          if (kind === 'html') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:Arial!important}body{overflow:auto!important}#fixture{padding:16px;font-family:Arial;font-size:15px;line-height:1.65;--font-mono:Menlo,monospace}.html-case{margin-bottom:20px}</style></head><body><main id="fixture"></main><script type="module">
        import '/src/app.css';import '/src/markdown.css';
        import {preloadRenderers,renderMarkdown} from '/src/lib/markdown.ts';
        await preloadRenderers(); const fixture=${source};
        window.htmlCases=fixture.cases.map(item=>({id:item.id,html:renderMarkdown(item.source)}));
        document.querySelector('#fixture').innerHTML=window.htmlCases.map(item=>'<section class="markdown html-case" data-case="'+item.id+'">'+item.html+'</section>').join('');
        await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));
        await document.fonts.ready;window.captureReady=true;
      </script></body></html>`);
            return;
          }
          if (kind === 'navigation' || kind === 'workspace') {
            await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:Arial!important}#fixture{height:100dvh;display:flex;flex-direction:column}</style></head><body><div id="fixture"></div><script type="module">
        import '/src/app.css';
        import { mount, tick } from 'svelte';
        import { app } from '/src/lib/app.svelte.ts';
        import Sidebar from '/src/lib/components/Sidebar.svelte';
        import Tabs from '/src/lib/components/MobileTabs.svelte';
        import WorkspacePage from '/src/lib/components/WorkspacePage.svelte';
        const fixture = ${source};
        app.nodes=fixture.nodes; app.workspaces=fixture.workspaces;
        app.sessions=fixture.sessions.map(s=>({...s,pinned:s.pinnedAt!=null,settled:s.settledAt!=null,unread:s.unread===true,lastActivityAt:new Date(s.updatedAt).toISOString()}));
        const noop=()=>{};
        const target=document.querySelector('#fixture');
        mount(Sidebar,{target, props:{open:${kind !== 'workspace'},oncollapse:noop,onselect:noop,onnew:noop,onopenworkspace:noop,onaddworkspace:noop,onclose:noop,onsettings:noop}});
        if (fixture.workspaceId) mount(WorkspacePage,{target,props:{workspace:fixture.workspaces.find(w=>w.id===fixture.workspaceId),onselect:noop,onnew:noop}});
        mount(Tabs,{target,props:{current:'work',onpick:noop}});
        await tick(); await document.fonts.ready; window.captureReady=true;
      </script></body></html>`);
            return;
          }
          await send(`<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{overflow:auto!important}#fixture{padding:${fixture.padding}px;font-family:Arial;font-size:15px;line-height:1.65;--font-mono:Menlo,monospace}</style></head><body><main id="fixture" class="markdown"></main><script type="module">
      import '/src/app.css'; import '/src/markdown.css';
      import { preloadRenderers, renderMarkdown } from '/src/lib/markdown.ts';
      await preloadRenderers();
      document.querySelector('#fixture').innerHTML=renderMarkdown(${JSON.stringify(fixture.source).replaceAll('<', '\\u003c')});
      await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));
      if (${JSON.stringify(kind)} === 'markdown-images') {
        const cases=${JSON.stringify(fixture.svgSizes?.map((c) => c.attrs) ?? [])};
        window.svgSizes=await Promise.all(cases.map(async attrs=>{const i=new Image();i.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" '+attrs+'/>');await i.decode();const box=document.createElement('div');box.style.cssText='position:fixed;left:-10000px;width:300px';i.style.maxWidth='none';box.append(i);document.body.append(box);const r=i.getBoundingClientRect();box.remove();return {attrs,width:r.width,height:r.height,naturalWidth:i.naturalWidth,naturalHeight:i.naturalHeight};}));
      }
      await document.fonts.ready; window.captureReady=true;
    </script></body></html>`);
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
  const measurements = {};
  for (const width of fixture.widths ?? [fixture.width]) {
    for (const view of fixture.views ?? ['']) {
      for (const colorScheme of ['light', 'dark']) {
        const page = await browser.newPage({
          viewport: { width, height: fixture.height },
          deviceScaleFactor: 1,
          isMobile: true,
          hasTouch: true,
          locale: 'en-US',
          colorScheme,
        });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.stack || e.message));
        page.on('console', (e) => {
          if (e.type() === 'error') errors.push(e.text());
        });
        page.on('response', (r) => {
          if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
        });
        await page.goto('http://127.0.0.1:18903/parity.html' + (view ? '?view=' + view : ''));
        await page
          .waitForFunction(() => window.captureReady)
          .catch((e) => {
            throw new Error([e.message, ...errors].join('\n'));
          });
        if (errors.length) throw new Error(errors.join('\n'));
        await page.screenshot({
          path: resolve(
            out,
            `${kind}-web-${fixture.widths ? width + '-' : ''}${view ? view + '-' : ''}${colorScheme}.png`,
          ),
        });
        if (kind === 'attachments') {
          const chips = await page.locator('.attachment-preview').evaluateAll((elements) =>
            elements.map((el) => {
              const rect = (node) => {
                if (!node) return null;
                const r = node.getBoundingClientRect();
                return { width: r.width, height: r.height };
              };
              const image = el.querySelector('img'),
                button = el.querySelector('button');
              return {
                box: rect(el),
                thumbnail: rect(el.firstElementChild),
                image: rect(image),
                imageRadius: image ? getComputedStyle(image).borderRadius : null,
                remove: button?.getAttribute('aria-label') ?? null,
                removeBox: rect(button),
                text: el.querySelector('span')?.textContent,
              };
            }),
          );
          assert.equal(chips.length, 4);
          for (const chip of chips) {
            assert.equal(chip.box.height, 48);
            assert.ok(chip.box.width <= 200);
          }
          assert.deepEqual(chips[0].image, { width: 36, height: 36 });
          assert.equal(chips[0].imageRadius, '8px');
          assert.equal(chips[0].remove, 'Remove diagram.svg');
          assert.deepEqual(chips[0].removeBox, { width: 22, height: 22 });
          assert.equal(chips[2].remove, null);
          assert.equal(chips[2].text, 'Uploading…');
          await writeFile(
            resolve(out, `attachments-web-${width}-${colorScheme}.json`),
            JSON.stringify(chips, null, 2) + '\n',
          );
        }

        if (kind === 'syntax-highlighting')
          await writeFile(
            resolve(out, `syntax-highlighting-web-${colorScheme}.json`),
            JSON.stringify(
              await page.evaluate(() => ({
                languages: window.syntaxLanguages,
                cases: window.syntaxCases,
              })),
              null,
              2,
            ) + '\n',
          );
        if (kind === 'html')
          await writeFile(
            resolve(out, `html-web-metrics-${width}-${colorScheme}.json`),
            JSON.stringify(
              await page.evaluate(() =>
                [...document.querySelectorAll('.html-case')].map((section) => ({
                  id: section.dataset.case,
                  elements: [section, ...section.querySelectorAll('*')].map((element) => {
                    const s = getComputedStyle(element),
                      r = element.getBoundingClientRect();
                    return {
                      tag: element.tagName,
                      text: element.textContent.slice(0, 60),
                      box: { x: r.x, y: r.y, width: r.width, height: r.height },
                      font: s.fontFamily,
                      size: s.fontSize,
                      lineHeight: s.lineHeight,
                      margin: s.margin,
                      padding: s.padding,
                      display: s.display,
                    };
                  }),
                })),
              ),
              null,
              2,
            ) + '\n',
          );
        if (kind === 'html')
          await writeFile(
            resolve(out, 'html-web-cases.json'),
            JSON.stringify(await page.evaluate(() => window.htmlCases), null, 2) + '\n',
          );
        if (kind === 'markdown-selection')
          await writeFile(
            resolve(out, 'markdown-selection-web-text.json'),
            JSON.stringify(await page.evaluate(() => window.selectionCases), null, 2) + '\n',
          );
        if (kind === 'markdown-images') {
          const sizes = await page.evaluate(() => window.svgSizes);
          for (const [index, row] of sizes.entries()) {
            assert.equal(row.width, fixture.svgSizes[index].width, row.attrs);
            assert.equal(row.height, fixture.svgSizes[index].height, row.attrs);
          }
          await writeFile(
            resolve(out, 'markdown-images-svg-sizes.json'),
            JSON.stringify(await page.evaluate(() => window.svgSizes), null, 2) + '\n',
          );
        }
        if (kind === 'files' || kind === 'markdown-links')
          await writeFile(
            resolve(out, `${kind}-web-links.json`),
            JSON.stringify(await page.evaluate(() => window.linkCases), null, 2) + '\n',
          );
        if (kind === 'streaming')
          await writeFile(
            resolve(out, 'streaming-web-boundaries.json'),
            JSON.stringify(await page.evaluate(() => window.boundaries), null, 2) + '\n',
          );
        measurements[
          `${fixture.widths ? width + '-' : ''}${view ? view + '-' : ''}${colorScheme}`
        ] = await page.locator('#fixture').evaluate((el) =>
          Array.from(
            el.querySelector('.backend-settings')?.children ??
              el.querySelector('.context-tab')?.children ??
              el.querySelector('.tab-body')?.children ??
              el.children,
            (node) => ({
              tag: node.tagName,
              text: node.textContent?.slice(0, 80),
              margin: getComputedStyle(node).margin,
              font: getComputedStyle(node).font,
              class: node.className,
              y: node.getBoundingClientRect().y,
              height: node.getBoundingClientRect().height,
            }),
          ),
        );
        await page.close();
      }
    }
  }
  await writeFile(
    resolve(out, `${kind}-web-measurements.json`),
    JSON.stringify({ fixture: fixture.id, reference: fixture.webRevision, measurements }, null, 2) +
      '\n',
  );
  console.log(out);
} finally {
  await browser?.close();
  await server.close();
}
