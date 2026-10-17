import { requireTestBrowserExecutable } from './test_browser.mjs';
// Capture pinned WorkspacePage states in the complete pinned App.svelte shell.
// Run: node apps/android/tool/parity/capture_workspace_matrix_web.mjs [--smoke]
import assert from 'node:assert/strict';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const fixturePath = resolve(root, 'fixtures/mobile-parity/workspace-matrix.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const pinned = fixture.webRevision;
execFileSync('git', ['diff', '--exit-code', pinned, '--', 'apps/web', ':!apps/web/tool'], { cwd: root });

const out = resolve(root, 'apps/android/build/parity/workspace-matrix');
await mkdir(out, { recursive: true });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content"><link rel="icon" href="data:,"><title>Workspace matrix</title></head>
<body><div id="app"></div><script type="module">
import '/src/app.css';
import '/src/markdown.css';
const fixture = ${fixtureSource};
window.__workspaceMatrix = fixture;
window.__apiRequests = [];
window.__apiPending = 0;
window.__parityErrors = [];
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);
  const row = { method: init.method ?? 'GET', path: url.pathname + url.search };
  window.__apiRequests.push(row);
  window.__apiPending++;
  try {
    let body;
    const reply = (value, status = 200) => {
      row.status = status;
      return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    };
    const unexpected = (message, status = 500) => {
      window.__parityErrors.push(row.method + ' ' + row.path + ': ' + message);
      return reply({ error: { message } }, status);
    };
    const workspacePath = /^\\/api\\/workspaces\\/([^/]+)\\/(instructions|capabilities|project-config)$/.exec(url.pathname);
    if (url.pathname === '/api/workspaces') body = { workspaces: fixture.workspaces };
    else if (url.pathname === '/api/sessions') body = { sessions: fixture.sessions };
    else if (url.pathname === '/api/models') body = { models: fixture.models };
    else if (url.pathname === '/api/nodes') body = { nodes: fixture.nodes };
    else if (url.pathname === '/api/memory') body = { usage: { user: { used: 0, max: 10000 }, note: { used: 0, max: 10000 } }, user: [], notes: [], removed: [], proposals: [], sessions: {} };
    else if (url.pathname === '/api/schedules') body = { schedules: [], timezone: 'Asia/Taipei' };
    else if (/^\\/api\\/sessions\\/[^/]+\\/snapshot$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[3]);
      const session = fixture.sessions.find((item) => item.id === id);
      if (!session) return unexpected('Unknown session', 404);
      body = { ...fixture.snapshot, session };
    } else if (/^\\/api\\/sessions\\/[^/]+\\/control$/.test(url.pathname)) {
      body = { lease: { clientId: 'other-client', expired: false, generation: 1, expiresAt: Date.now() + 60_000 } };
    } else if (workspacePath) {
      const [, encodedId, endpoint] = workspacePath;
      const id = decodeURIComponent(encodedId);
      if (endpoint === 'instructions' && id === 'home:trip') body = { instructions: fixture.instructions };
      else if (endpoint === 'capabilities' && id === 'home:trip') body = { capabilities: fixture.capabilities };
      else if (endpoint === 'project-config' && id === 'device:repo') body = { project: fixture.projectConfig };
      else return unexpected('Unexpected workspace API request');
    } else return unexpected('Unexpected parity API request');
    return reply(body);
  } finally {
    window.__apiPending--;
  }
};
const NativeWebSocket = window.WebSocket;
class FixtureEventSocket extends EventTarget { close() {} }
window.WebSocket = new Proxy(NativeWebSocket, {
  construct(target, args) {
    if (String(args[0]).includes('/api/events?')) return new FixtureEventSocket();
    return Reflect.construct(target, args);
  }
});
const { mount } = await import('svelte');
const { default: App } = await import('/src/App.svelte');
mount(App, { target: document.querySelector('#app') });
window.__appMounted = true;
</script></body></html>`;

const server = await createServer({
  cacheDir: resolve(out, 'vite-cache'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18921,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [{
    name: 'workspace-matrix-fixture',
    configureServer(vite) {
      vite.middlewares.use('/parity.html', async (_req, res, next) => {
        try {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(await vite.transformIndexHtml('/parity.html', html));
        } catch (error) { next(error); }
      });
    },
  }],
});

const round = (value) => Math.round(value * 100) / 100;
const rect = (element) => {
  if (!element) return null;
  const r = element.getBoundingClientRect();
  return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height), right: round(r.right), bottom: round(r.bottom) };
};
const style = (element) => {
  const s = getComputedStyle(element);
  return {
    fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight,
    lineHeight: s.lineHeight, color: s.color, backgroundColor: s.backgroundColor,
    border: s.border, borderRadius: s.borderRadius,
    margin: s.margin, padding: s.padding, display: s.display,
  };
};
const pageSnapshot = async (page) => page.evaluate(({ roundSource }) => {
  const round = (value) => Math.round(value * 100) / 100;
  const rect = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height), right: round(r.right), bottom: round(r.bottom) };
  };
  const style = (element) => {
    const s = getComputedStyle(element);
    return { fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, color: s.color, backgroundColor: s.backgroundColor, border: s.border, borderRadius: s.borderRadius, margin: s.margin, padding: s.padding, display: s.display };
  };
  const text = (element) => (element?.innerText ?? element?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 240);
  const page = document.querySelector('.workspace-page');
  const body = document.querySelector('.page-body');
  const scroll = document.querySelector('.page-scroll');
  const layoutNodes = ['html', 'body', '#app', '.app-shell', '.app-shell > .workspace', '.workspace-page', '.page-scroll'];
  const layout = Object.fromEntries(layoutNodes.map((selector) => {
    const element = document.querySelector(selector);
    if (!element) return [selector, null];
    const s = getComputedStyle(element);
    return [selector, {
      rect: rect(element), height: s.height, minHeight: s.minHeight,
      display: s.display, overflow: s.overflow, overflowY: s.overflowY,
      flex: s.flex, gridTemplateRows: s.gridTemplateRows,
      scrollTop: element.scrollTop, scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }];
  }));
  const semantic = 'h1,h2,h3,h4,p,label,input,textarea,select,button,fieldset,legend,pre,dl,dt,dd,li,small';
  return {
    documentTitle: document.title,
    theme: { colorScheme: getComputedStyle(document.documentElement).colorScheme, canvas: getComputedStyle(document.documentElement).backgroundColor, ink: getComputedStyle(document.documentElement).color },
    inputModality: { hoverNone: matchMedia('(hover: none)').matches, pointerCoarse: matchMedia('(pointer: coarse)').matches, anyHover: matchMedia('(any-hover: hover)').matches, anyPointerCoarse: matchMedia('(any-pointer: coarse)').matches, maxTouchPoints: navigator.maxTouchPoints },
    rootLayout: layout,
    frame: {
      appShell: rect(document.querySelector('.app-shell')),
      sidebar: rect(document.querySelector('.sidebar')),
      workspace: rect(document.querySelector('.app-shell > .workspace')),
      mobileTabs: rect(document.querySelector('.mobile-tabs')),
    },
    page: {
      rect: rect(page), header: rect(page?.querySelector('.page-bar')),
      title: { rect: rect(page?.querySelector('.page-title')), text: text(page?.querySelector('h1')), subtitle: text(page?.querySelector('.page-title small')) },
      newButton: { rect: rect(page?.querySelector('.new-in')), text: text(page?.querySelector('.new-in')), style: page?.querySelector('.new-in') ? style(page.querySelector('.new-in')) : null },
      tabs: { rect: rect(page?.querySelector('.page-tabs')), items: [...(page?.querySelectorAll('[role=tab]') ?? [])].map((e) => ({ text: text(e), selected: e.getAttribute('aria-selected'), rect: rect(e), style: style(e) })) },
      scrollViewport: rect(scroll), body: rect(body), bodyContentWidth: body ? round(body.clientWidth - parseFloat(getComputedStyle(body).paddingLeft) - parseFloat(getComputedStyle(body).paddingRight)) : null,
      scroll: { top: scroll?.scrollTop ?? null, height: scroll?.scrollHeight ?? null, clientHeight: scroll?.clientHeight ?? null },
      sections: [...(body?.querySelectorAll('.settings-section') ?? [])].map((section, index) => ({ index, heading: text(section.querySelector('h3')), rect: rect(section) })),
      elements: [...(body?.querySelectorAll(semantic) ?? [])].map((e, index) => ({ index, tag: e.tagName.toLowerCase(), role: e.getAttribute('role'), type: e.getAttribute('type'), text: text(e), value: 'value' in e ? e.value : undefined, checked: 'checked' in e ? e.checked : undefined, rect: rect(e), style: style(e) })),
      controls: [...(body?.querySelectorAll('input,textarea,select,button,[role=switch]') ?? [])].map((e, index) => ({ index, tag: e.tagName.toLowerCase(), type: e.getAttribute('type'), label: text(e.closest('label')) || text(e), value: 'value' in e ? e.value : undefined, checked: 'checked' in e ? e.checked : undefined, disabled: 'disabled' in e ? e.disabled : undefined, rect: rect(e), style: style(e) })),
    },
    apiRequests: window.__apiRequests,
    apiPending: window.__apiPending,
    consoleErrors: window.__parityErrors ?? [],
  };
}, { roundSource: String(round) });

const smoke = process.argv.includes('--smoke');
const widths = smoke ? fixture.widths.filter((width) => width === 390 || width === 768) : fixture.widths;
const scales = smoke ? [1] : fixture.textScales;
let browser;
const cases = [];
const diagnostics = [];
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: requireTestBrowserExecutable(), headless: true });
  for (const width of widths) {
    for (const theme of fixture.themes) {
      const context = await browser.newContext({
        viewport: { width, height: fixture.height }, deviceScaleFactor: 1,
        isMobile: true, hasTouch: true, locale: 'en-US', colorScheme: theme,
      });
      try {
        for (const state of fixture.states) {
          for (const scale of scales) {
            const page = await context.newPage();
            const browserErrors = [];
            page.on('pageerror', (error) => browserErrors.push(error.stack || error.message));
            page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
            await page.goto(`http://127.0.0.1:18921/parity.html?workspace=${encodeURIComponent(state.workspaceId)}`, { waitUntil: 'load' });
            await page.waitForFunction(() => window.__appMounted && document.querySelector('#workspace-title') && window.__apiPending === 0, null, { timeout: 15000 });
            await page.waitForTimeout(320);
            if (state.tab === 'settings') {
              await page.locator('#workspace-tab-settings').click();
              await page.waitForFunction((stateId) => {
                const body = document.querySelector('.page-body');
                if (!body || window.__apiPending !== 0) return false;
                if (stateId === 'chat-settings') return !!body.querySelector('textarea') && body.querySelectorAll('[role=switch]').length === 5;
                return body.innerText.includes('npm ci');
              }, state.id, { timeout: 12000 });
            }
            await page.evaluate(async (scaleValue) => {
              await document.fonts.ready;
              if (scaleValue === 1) return;
              // Read every original computed size first, then apply the scale in a second pass.
              const sizes = [...document.querySelectorAll('body *')].map((element) => [element, parseFloat(getComputedStyle(element).fontSize)]);
              for (const [element, size] of sizes) element.style.setProperty('font-size', `${size * scaleValue}px`, 'important');
            }, scale);
            await page.waitForTimeout(40);
            const id = `${state.id}-${width}-${theme}-text${scale}`;
            const base = { id, state: state.id, workspaceId: state.workspaceId, width, height: fixture.height, theme, textScale: scale, browser: 'Google Chrome pinned executable; deviceScaleFactor 1; isMobile true; hasTouch true' };
            const top = await pageSnapshot(page);
            assert.equal(top.apiPending, 0, `${id}: pending API fetch`);
            assert.equal(top.page.title.text.length > 0, true, `${id}: workspace title missing`);
            assert.ok(top.frame.workspace?.width > 0, `${id}: workspace shell missing`);
            assert.ok(!browserErrors.length, `${id}: browser errors: ${browserErrors.join('\n')}`);
            assert.ok(!top.consoleErrors.length, `${id}: API errors: ${top.consoleErrors.join('\n')}`);
            const pngTop = `${id}-top.png`;
            await page.screenshot({ path: resolve(out, pngTop), fullPage: false });
            let pngBottom = null;
            let bottomScroll = null;
            if (state.id !== 'sessions') {
              await page.locator('.page-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight; });
              await page.waitForTimeout(40);
              bottomScroll = await page.locator('.page-scroll').evaluate((element) => ({ top: Math.round(element.scrollTop * 100) / 100, height: element.scrollHeight, clientHeight: element.clientHeight }));
              pngBottom = `${id}-bottom.png`;
              await page.screenshot({ path: resolve(out, pngBottom), fullPage: false });
            }
            cases.push({ ...base, top, bottomScroll, screenshot: { top: `apps/android/build/parity/workspace-matrix/${pngTop}`, bottom: pngBottom ? `apps/android/build/parity/workspace-matrix/${pngBottom}` : null } });
            await page.close();
          }
        }
      } finally {
        await context.close();
      }
    }
  }
  const expected = {
    fixture: 'fixtures/mobile-parity/workspace-matrix.json',
    webRevision: pinned,
    capturedAt: new Date().toISOString(),
    browser: { name: 'Google Chrome', executable: requireTestBrowserExecutable(), deviceScaleFactor: 1, isMobile: true, hasTouch: true, pointerPolicy: 'hover:none + pointer:coarse', height: fixture.height, viewportWidths: widths, themes: fixture.themes, textScales: scales },
    simulation: {
      scope: 'Actual pinned App.svelte plus real Sidebar, WorkspacePage and MobileTabs mounted into the production index.html body/#app wrapper; app.css and markdown.css are both loaded. Browser APIs use deterministic local fixture responses; no external backend or websocket is used.',
      textScale: 'Harness reads computed font sizes for all DOM elements before changing any, then applies the requested multiplier in a second pass to avoid parent/child double scaling.',
      scroll: 'Settings top screenshot starts at scrollTop 0; a second screenshot is taken after scrolling .page-scroll to its maximum. DOM rectangles in JSON are from the initial top state; bottom scroll metrics are recorded separately.',
    },
    cases,
  };
  assert.equal(cases.length, fixture.states.length * widths.length * fixture.themes.length * scales.length, 'case matrix is incomplete');
  const expectedPath = resolve(root, 'fixtures/mobile-parity/workspace-matrix-expected.json');
  await writeFile(expectedPath, JSON.stringify(expected, null, 2) + '\n');
  console.log(JSON.stringify({
    caseCount: cases.length, expected: expectedPath, output: out,
    geometry: cases.filter((c) => c.theme === 'light' && c.textScale === 1).map((c) => ({
      state: c.state, width: c.width, sidebar: c.top.frame.sidebar?.width ?? null,
      workspace: c.top.frame.workspace,
      page: c.top.page.rect,
      header: c.top.page.header,
      tabs: c.top.page.tabs.rect,
      body: c.top.page.body,
      bodyContentWidth: c.top.page.bodyContentWidth,
      scroll: c.top.page.scroll,
      sections: c.top.page.sections.map((section) => ({ heading: section.heading, rect: section.rect })),
    }))
  }, null, 2));
} finally {
  if (browser) await browser.close();
  await server.close();
}
