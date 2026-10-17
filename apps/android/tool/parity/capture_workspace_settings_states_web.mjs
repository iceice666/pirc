import { requireTestBrowserExecutable } from './test_browser.mjs';
// Capture transient and non-success workspace settings states in the pinned App.svelte shell.
// Run: node apps/android/tool/parity/capture_workspace_settings_states_web.mjs
import assert from 'node:assert/strict';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const fixturePath = resolve(root, 'fixtures/mobile-parity/workspace-settings-states.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const pinned = fixture.webRevision;
const diagnosticEmptyActions = process.argv.includes('--probe-empty-actions');
const diagnosticReveal = process.argv.includes('--probe-reveal');
execFileSync('git', ['diff', '--exit-code', pinned, '--', 'apps/web', ':!apps/web/tool'], { cwd: root });
assert.equal(pinned, 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c', 'unexpected pinned Web source revision');

const out = resolve(root, 'apps/android/build/parity/workspace-settings-states');
await mkdir(out, { recursive: true });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content"><link rel="icon" href="data:,"><title>Workspace settings state capture</title></head>
<body><div id="app"></div><script type="module">
import '/src/app.css';
import '/src/markdown.css';
const fixture = ${fixtureSource};
const params = new URLSearchParams(location.search);
const state = fixture.states.find((item) => item.id === params.get('state'));
if (!state) throw new Error('Unknown workspace state fixture');
window.__workspaceSettingsFixture = fixture;
window.__workspaceSettingsState = state;
window.__apiRequests = [];
window.__apiPending = 0;
window.__apiUnexpected = [];
window.__apiCounts = Object.create(null);
window.__heldSettingsRequests = [];
window.__fontSizeBase = new WeakMap();
window.__baseComputedFontSize = new WeakMap();
const nativeFetch = window.fetch.bind(window);
const reply = (descriptor) => new Response(JSON.stringify(descriptor.body), {
  status: descriptor.status,
  headers: { 'content-type': 'application/json' },
});
const endpointFor = (pathname) => {
  const match = /^\\/api\\/workspaces\\/([^/]+)\\/(instructions|capabilities|project-config|project-trust)$/.exec(pathname);
  if (!match) return null;
  return { id: decodeURIComponent(match[1]), endpoint: match[2] };
};
const defaultResponse = (method, endpoint) => {
  if (method === 'GET' && endpoint === 'instructions') return 'instructions';
  if (method === 'PATCH' && endpoint === 'instructions') return 'instructionsSaved';
  if (method === 'GET' && endpoint === 'capabilities') return 'capabilities';
  if (method === 'PATCH' && endpoint === 'capabilities') return 'capabilitiesSaved';
  if (method === 'GET' && endpoint === 'project-config') return 'projectUntrusted';
  if (method === 'POST' && endpoint === 'project-trust') return 'projectTrusted';
  return null;
};
window.__releaseNextSettingsRequest = () => {
  const held = window.__heldSettingsRequests.shift();
  if (!held) throw new Error('No held settings request to release');
  held.resolve(state.hold.releaseResponse);
};
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);
  const method = (init.method ?? 'GET').toUpperCase();
  const row = { method, path: url.pathname + url.search, requestBody: init.body ? (() => { try { return JSON.parse(init.body); } catch { return String(init.body); } })() : null, status: null, endpoint: null, responseAlias: null, held: false };
  window.__apiRequests.push(row);
  window.__apiPending++;
  try {
    if (method === 'GET' && url.pathname === '/api/workspaces') {
      row.responseAlias = 'fixture-workspaces';
      row.status = 200;
      return reply({ status: 200, body: { workspaces: fixture.workspaces } });
    }
    if (method === 'GET' && url.pathname === '/api/sessions') {
      row.responseAlias = 'fixture-sessions';
      row.status = 200;
      return reply({ status: 200, body: { sessions: fixture.sessions ?? [] } });
    }
    if (method === 'GET' && url.pathname === '/api/models') {
      row.responseAlias = 'fixture-models';
      row.status = 200;
      return reply({ status: 200, body: { models: fixture.models ?? [] } });
    }
    if (method === 'GET' && url.pathname === '/api/nodes') {
      row.responseAlias = 'fixture-nodes';
      row.status = 200;
      const nodes = state.nodes === 'home-only' ? fixture.nodes.filter((item) => item.id === 'home') : fixture.nodes;
      return reply({ status: 200, body: { nodes } });
    }
    if (method === 'GET' && url.pathname === '/api/memory') {
      row.responseAlias = 'fixture-memory';
      row.status = 200;
      return reply({ status: 200, body: { usage: { user: { used: 0, max: 10000 }, note: { used: 0, max: 10000 } }, user: [], notes: [], removed: [], proposals: [], sessions: {} } });
    }
    if (method === 'GET' && url.pathname === '/api/schedules') {
      row.responseAlias = 'fixture-schedules';
      row.status = 200;
      return reply({ status: 200, body: { schedules: [], timezone: 'Asia/Taipei' } });
    }

    const target = endpointFor(url.pathname);
    const expectedWorkspace = state.workspaceId;
    if (!target || target.id !== expectedWorkspace) {
      const message = 'Unexpected API request for workspace settings state fixture';
      row.status = 500;
      window.__apiUnexpected.push({ ...row, message });
      return reply({ status: 500, body: { error: { message } } });
    }
    row.endpoint = target.endpoint;
    const key = method + ' ' + target.endpoint;
    const count = window.__apiCounts[key] ?? 0;
    window.__apiCounts[key] = count + 1;
    const sequence = state.sequences?.[key] ?? [];
    let alias = sequence[count] ?? defaultResponse(method, target.endpoint);
    if (!alias) {
      const message = 'Unexpected method/endpoint in workspace settings state fixture';
      row.status = 500;
      window.__apiUnexpected.push({ ...row, message });
      return reply({ status: 500, body: { error: { message } } });
    }
    if (state.hold && !state.__holdConsumed && method === state.hold.method && target.endpoint === state.hold.endpoint) {
      state.__holdConsumed = true;
      row.held = true;
      alias = await new Promise((resolve) => window.__heldSettingsRequests.push({ resolve }));
    }
    const descriptor = fixture.responses[alias];
    if (!descriptor) {
      const message = 'Unknown fixture response alias: ' + alias;
      row.status = 500;
      window.__apiUnexpected.push({ ...row, message });
      return reply({ status: 500, body: { error: { message } } });
    }
    row.responseAlias = alias;
    row.status = descriptor.status;
    return reply(descriptor);
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
window.__applyParityTextScale = (factor) => {
  const elements = [...document.querySelectorAll('body *')];
  for (const element of elements) {
    if (!window.__fontSizeBase.has(element)) {
      window.__fontSizeBase.set(element, {
        value: element.style.getPropertyValue('font-size'),
        priority: element.style.getPropertyPriority('font-size'),
      });
    }
  }
  // Restore all original inline declarations before computing base sizes. This matters when
  // a released request added nodes under a parent that had already been scaled.
  for (const element of elements) {
    const original = window.__fontSizeBase.get(element);
    if (original.value) element.style.setProperty('font-size', original.value, original.priority);
    else element.style.removeProperty('font-size');
  }
  const baseSizes = elements.map((element) => [element, parseFloat(getComputedStyle(element).fontSize)]);
  for (const [element, size] of baseSizes) {
    if (!Number.isFinite(size)) continue;
    window.__baseComputedFontSize.set(element, size);
    if (factor !== 1) element.style.setProperty('font-size', (size * factor) + 'px', 'important');
  }
};
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
    port: 18922,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [{
    name: 'workspace-settings-states-fixture',
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
const text = (element) => (element?.innerText ?? element?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 500);
const style = (element) => {
  if (!element) return null;
  const s = getComputedStyle(element);
  return {
    fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight,
    lineHeight: s.lineHeight, color: s.color, backgroundColor: s.backgroundColor,
    border: s.border, borderRadius: s.borderRadius, margin: s.margin, padding: s.padding,
    display: s.display, boxSizing: s.boxSizing, opacity: s.opacity,
  };
};
const pageSnapshot = async (page, scale) => page.evaluate(({ scaleValue }) => {
  const round = (value) => Math.round(value * 100) / 100;
  const rect = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height), right: round(r.right), bottom: round(r.bottom) };
  };
  const text = (element) => (element?.innerText ?? element?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 500);
  const style = (element) => {
    if (!element) return null;
    const s = getComputedStyle(element);
    const baseSize = window.__baseComputedFontSize.get(element) ?? null;
    return {
      fontFamily: s.fontFamily, fontSize: s.fontSize, baseFontSize: Number.isFinite(baseSize) ? baseSize + 'px' : null,
      fontWeight: s.fontWeight, lineHeight: s.lineHeight, color: s.color, backgroundColor: s.backgroundColor,
      border: s.border, borderRadius: s.borderRadius, margin: s.margin, padding: s.padding,
      display: s.display, boxSizing: s.boxSizing, opacity: s.opacity,
    };
  };
  const page = document.querySelector('.workspace-page');
  const settings = document.querySelector('#workspace-panel-settings');
  const scroll = document.querySelector('.page-scroll');
  const relevant = 'h3,h4,p,label,textarea,input,button,fieldset,legend,pre,small,code,[role=status],[role=alert]';
  const elements = [...(settings?.querySelectorAll(relevant) ?? [])].map((element, index) => ({
    index, tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), type: element.getAttribute('type'),
    text: text(element), value: 'value' in element ? element.value : undefined,
    checked: 'checked' in element ? element.checked : undefined,
    disabled: 'disabled' in element ? element.disabled : undefined,
    ariaBusy: element.getAttribute('aria-busy'), ariaInvalid: element.getAttribute('aria-invalid'),
    className: typeof element.className === 'string' ? element.className : '',
    rect: rect(element), style: style(element),
  }));
  const controls = [...(settings?.querySelectorAll('button,input,textarea,select,[role=switch],fieldset') ?? [])].map((element, index) => ({
    index, tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), type: element.getAttribute('type'),
    label: text(element.closest('label')) || text(element), value: 'value' in element ? element.value : undefined,
    checked: 'checked' in element ? element.checked : undefined, disabled: 'disabled' in element ? element.disabled : undefined,
    effectiveDisabled: element.matches(':disabled'),
    ariaBusy: element.getAttribute('aria-busy'), rect: rect(element), style: style(element),
  }));
  const statuses = [...(settings?.querySelectorAll('[role=status]') ?? [])].map((element) => ({ text: text(element), rect: rect(element), style: style(element) }));
  const alerts = [...(settings?.querySelectorAll('[role=alert]') ?? [])].map((element) => ({ text: text(element), rect: rect(element), style: style(element) }));
  const textContent = text(settings);
  const countButton = (label) => [...(settings?.querySelectorAll('button') ?? [])].filter((button) => text(button) === label).length;
  return {
    viewport: { width: innerWidth, height: innerHeight, colorScheme: getComputedStyle(document.documentElement).colorScheme },
    canvas: { html: style(document.documentElement), body: style(document.body), app: rect(document.querySelector('#app')) },
    layout: {
      appShell: rect(document.querySelector('.app-shell')),
      workspace: rect(document.querySelector('.app-shell > .workspace')),
      page: rect(page), pageHeader: rect(page?.querySelector('.page-bar')),
      pageTabs: rect(page?.querySelector('.page-tabs')),
      pageScroll: rect(scroll), settings: rect(settings),
      scroll: { top: scroll?.scrollTop ?? null, height: scroll?.scrollHeight ?? null, clientHeight: scroll?.clientHeight ?? null },
    },
    selectedTab: document.querySelector('#workspace-tab-settings')?.getAttribute('aria-selected') ?? null,
    sections: [...(settings?.querySelectorAll('.settings-section') ?? [])].map((element, index) => ({ index, title: text(element.querySelector('h3')), text: text(element), rect: rect(element), style: style(element) })),
    textContent, elements, controls, statuses, alerts,
    buttonCounts: { trust: countButton('Trust'), revokeTrust: countButton('Revoke trust'), retry: countButton('Retry'), save: countButton('Save') },
    apiRequests: window.__apiRequests.map((row) => ({ ...row })), apiPending: window.__apiPending,
    heldRequests: window.__heldSettingsRequests.length, unexpectedRequests: [...window.__apiUnexpected],
  };
}, { scaleValue: scale });

async function captureStage(page, state, stage, width, theme, scale) {
  const id = `${state.id}-${width}-${theme}-text${scale}-${stage}`;
  const scroll = page.locator('.page-scroll');
  const revealScrollTop = await scroll.evaluate(element => element.scrollTop);
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await page.waitForTimeout(20);
  const top = await pageSnapshot(page, scale);
  assert.equal(top.layout.scroll.top, 0, `${id}: top capture must use scroll offset zero`);
  assert.equal(top.selectedTab, 'true', `${id}: Settings tab is not selected`);
  assert.equal(top.unexpectedRequests.length, 0, `${id}: unexpected API requests ${JSON.stringify(top.unexpectedRequests)}`);
  const topPath = `${id}-top.png`;
  await page.screenshot({ path: resolve(out, topPath), fullPage: false });
  await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(35);
  const bottom = await pageSnapshot(page, scale);
  const bottomPath = `${id}-bottom.png`;
  await page.screenshot({ path: resolve(out, bottomPath), fullPage: false });
  await scroll.evaluate((element) => { element.scrollTop = 0; });
  await page.waitForTimeout(20);
  return {
    name: stage,
    revealScrollTop,
    top,
    bottom,
    screenshot: {
      top: `apps/android/build/parity/workspace-settings-states/${topPath}`,
      bottom: `apps/android/build/parity/workspace-settings-states/${bottomPath}`,
    },
  };
}

async function inspectEmptyActions(page) {
  return page.evaluate(() => {
    const round = (value) => Math.round(value * 100) / 100;
    const rect = (element) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height), right: round(r.right), bottom: round(r.bottom) };
    };
    const style = (element) => {
      if (!element) return null;
      const s = getComputedStyle(element);
      return { display: s.display, marginTop: s.marginTop, margin: s.margin, padding: s.padding, color: s.color, fontSize: s.fontSize, lineHeight: s.lineHeight };
    };
    const label = (element) => (element?.innerText ?? element?.textContent ?? '').trim().replace(/\s+/g, ' ');
    const settings = document.querySelector('#workspace-panel-settings');
    const serialize = (element) => {
      const section = element.closest('.settings-section');
      return {
        tag: element.tagName.toLowerCase(), className: element.className,
        innerHTML: element.innerHTML,
        childNodes: [...element.childNodes].map((node) => ({
          nodeType: node.nodeType, nodeName: node.nodeName, textContent: node.textContent,
        })),
        matchesEmpty: element.matches(':empty'),
        text: label(element), style: style(element), rect: rect(element),
        parentSection: section ? {
          title: label(section.querySelector('h3')), text: label(section), rect: rect(section),
        } : null,
      };
    };
    const nonemptyParagraphs = [...(settings?.querySelectorAll('p') ?? [])].filter((p) => label(p));
    return {
      viewport: { width: innerWidth, height: innerHeight },
      actions: [...(settings?.querySelectorAll('.actions') ?? [])].map(serialize),
      lastNonemptyParagraph: nonemptyParagraphs.length ? serialize(nonemptyParagraphs.at(-1)) : null,
      statuses: [...(settings?.querySelectorAll('[role=status]') ?? [])].map(serialize),
      settings: { text: label(settings), rect: rect(settings), style: style(settings) },
    };
  });
}

async function inspectRevealScroll(page) {
  return page.evaluate(() => {
    const round = (value) => Math.round(value * 100) / 100;
    const rect = (element) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height), right: round(r.right), bottom: round(r.bottom) };
    };
    const inspect = (element, selector) => {
      if (!element) return null;
      const s = getComputedStyle(element);
      return {
        selector, tag: element.tagName.toLowerCase(), className: typeof element.className === 'string' ? element.className : '',
        scrollTop: round(element.scrollTop), scrollLeft: round(element.scrollLeft), scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight, overflowY: s.overflowY, rect: rect(element),
      };
    };
    const selectors = ['.page-scroll', '.workspace-page', '.app-shell', '#app', 'body', 'html'];
    const explicit = selectors.map((selector) => inspect(document.querySelector(selector), selector));
    explicit.push(inspect(document.scrollingElement, 'document.scrollingElement'));
    const target = document.querySelector('#workspace-panel-settings');
    const chain = [];
    for (let element = target; element; element = element.parentElement) {
      const s = getComputedStyle(element);
      const scrollable = element.scrollHeight > element.clientHeight || /(auto|scroll|overlay)/.test(s.overflowY);
      if (scrollable || element === target || element === document.documentElement || element === document.body) {
        chain.push(inspect(element, element.id ? `#${element.id}` : element.className || element.tagName.toLowerCase()));
      }
    }
    const page = document.querySelector('.workspace-page');
    const firstSwitch = document.querySelector('#workspace-panel-settings input[role=switch]');
    const active = document.activeElement;
    const describeControl = (element) => element ? { tag: element.tagName.toLowerCase(), type: element.getAttribute('type'), role: element.getAttribute('role'), ariaLabel: element.getAttribute('aria-label'), ariaChecked: element.getAttribute('aria-checked'), checked: 'checked' in element ? element.checked : undefined, disabled: 'disabled' in element ? element.disabled : undefined, rect: rect(element), labelRect: rect(element.closest('label')) } : null;
    return {
      viewport: { width: innerWidth, height: innerHeight, scrollX: round(scrollX), scrollY: round(scrollY), visualViewport: visualViewport ? { offsetLeft: round(visualViewport.offsetLeft), offsetTop: round(visualViewport.offsetTop), pageLeft: round(visualViewport.pageLeft), pageTop: round(visualViewport.pageTop), width: round(visualViewport.width), height: round(visualViewport.height) } : null },
      document: { scrollX: round(document.documentElement.scrollLeft || document.body.scrollLeft), scrollY: round(document.documentElement.scrollTop || document.body.scrollTop), scrollingElement: document.scrollingElement?.tagName.toLowerCase() ?? null },
      focusedElement: describeControl(active), firstSwitch: describeControl(firstSwitch), firstSwitchFocused: firstSwitch === active,
      pageRect: rect(page), settingsRect: rect(target), explicitAncestors: explicit, scrollableAncestorChain: chain,
    };
  });
}

async function step(page, state, flowStep) {
  switch (flowStep.type) {
    case 'waitIdle':
      await page.waitForFunction(() => window.__apiPending === 0 && window.__heldSettingsRequests.length === 0, null, { timeout: 12000 });
      await page.waitForTimeout(40);
      return;
    case 'waitHeld':
      if (flowStep.withOtherSettingsLoaded) {
        await page.waitForFunction(() => window.__heldSettingsRequests.length === 1 && document.querySelectorAll('#workspace-panel-settings [role=switch]').length === 5, null, { timeout: 12000 });
      } else {
        await page.waitForFunction(() => window.__heldSettingsRequests.length === 1, null, { timeout: 12000 });
      }
      await page.waitForTimeout(40);
      return;
    case 'releaseHeld':
      await page.evaluate(() => window.__releaseNextSettingsRequest());
      return;
    case 'waitRequests':
      await page.waitForFunction(({ endpoint, count }) => window.__apiRequests.filter((row) => row.endpoint === endpoint).length >= count && window.__apiPending === 0, { endpoint: flowStep.endpoint, count: flowStep.count }, { timeout: 12000 });
      await page.waitForTimeout(40);
      return;
    case 'fillInstructions':
      await page.locator('#workspace-panel-settings textarea').fill(flowStep.text);
      return;
    case 'clickFirstSwitch':
      await page.locator('#workspace-panel-settings input[role=switch]').first().click();
      return;
    case 'click':
      await page.getByRole('button', { name: flowStep.target, exact: true }).click();
      return;
    default:
      throw new Error(`${state.id}: unknown workflow step ${flowStep.type}`);
  }
}

function assertStateStage(state, stage, capture) {
  const top = capture.top;
  const allText = top.textContent;
  const statusText = top.statuses.map((item) => item.text).filter(Boolean).join(' | ');
  const alertText = top.alerts.map((item) => item.text).filter(Boolean).join(' | ');
  const expect = state.expect ?? {};
  if (state.id === 'chat-loading' && stage === 'loading') assert.match(statusText, /Loading project instructions/);
  if (state.id === 'chat-loading' && stage === 'ready') {
    const textarea = top.controls.find((item) => item.tag === 'textarea');
    assert.ok(textarea, `${state.id}/${stage}: textarea missing from snapshot controls: ${JSON.stringify(top.controls)}`);
    assert.equal(textarea.value, 'Be curious and precise.', `${state.id}/${stage}: wrong textarea snapshot`);
  }
  if (state.id === 'chat-read-error-retry' && stage === 'error') assert.equal(alertText, expect.error);
  if (state.id === 'chat-read-error-retry' && stage === 'recovered') assert.equal(top.controls.find((item) => item.tag === 'textarea')?.value, expect.recovered);
  if (state.id === 'instructions-saving' && stage === 'saving') {
    const submit = top.controls.find((item) => item.tag === 'button' && item.type === 'submit');
    assert.match(submit?.label ?? '', /Saving/);
    assert.equal(top.controls.find((item) => item.tag === 'textarea')?.disabled, true);
    assert.equal(submit?.disabled, true);
  }
  if (state.id === 'instructions-saving' && stage === 'saved') assert.match(statusText, /Project instructions saved/);
  if (state.id === 'instructions-save-error') assert.equal(alertText, expect.error);
  if (state.id === 'capabilities-saving' && stage === 'saving') {
    assert.match(statusText, /Saving project capabilities/);
    assert.equal(top.elements.find((item) => item.tag === 'fieldset')?.disabled, true);
  }
  if (state.id === 'directory-offline') {
    assert.match(allText, /workspace's node is offline/);
    assert.equal(top.apiRequests.filter((row) => row.endpoint === 'project-config').length, 0);
  }
  if (state.id === 'config-loading' && stage === 'loading') assert.match(statusText, /Loading project config/);
  if (state.id === 'config-read-error-retry' && stage === 'error') assert.equal(alertText, expect.error);
  if (state.id === 'config-read-error-retry' && stage === 'recovered') assert.match(allText, /Not trusted: ignored/);
  if (state.id === 'config-invalid' && stage === 'final') {
    assert.match(allText, /The project config is invalid and is not used: Invalid JSON at line 2/);
    assert.equal(top.buttonCounts.trust, 0);
    assert.equal(top.buttonCounts.revokeTrust, 0);
  }
  if (state.id === 'config-empty' && stage === 'final') {
    assert.match(allText, /sets no hooks, environment or allowed paths/);
    assert.equal(top.buttonCounts.trust, 0);
    assert.equal(top.buttonCounts.revokeTrust, 0);
  }
  if (state.id === 'config-trusted' && stage === 'final') {
    assert.match(allText, /Trusted/);
    assert.equal(top.buttonCounts.trust, 0);
    assert.equal(top.buttonCounts.revokeTrust, 1);
  }
  if (state.id === 'config-changed' && stage === 'final') {
    assert.match(allText, /Changed since trusted: ignored until you trust it again/);
    assert.equal(top.buttonCounts.trust, 1);
    assert.equal(top.buttonCounts.revokeTrust, 1);
  }
  if (state.id === 'config-revoked' && stage === 'final') {
    assert.match(statusText, /Trust revoked\. New sessions ignore them\./);
    assert.match(allText, /Not trusted: ignored/);
    assert.equal(top.buttonCounts.trust, 1);
    assert.equal(top.buttonCounts.revokeTrust, 0);
  }
  if (state.id === 'trust-saving' && stage === 'saving') {
    assert.match(statusText, /Saving…/);
    assert.equal(top.controls.find((item) => item.tag === 'button' && item.label === 'Trust')?.disabled, true);
  }
  if (state.id === 'trust-error' && stage === 'error') {
    assert.equal(alertText, expect.error);
    assert.equal(top.controls.find((item) => item.tag === 'button' && item.label === 'Trust')?.disabled, false);
  }
  if (state.id === 'trust-409' && stage === 'final') {
    assert.equal(alertText, expect.error);
    assert.match(allText, /Changed since trusted: ignored until you trust it again/);
    assert.equal(top.apiRequests.filter((row) => row.endpoint === 'project-config').length, expect.projectConfigGets);
  }
  if (expect.status && stage === expect.stage) assert.match(statusText, new RegExp(expect.status.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  if (expect.error && stage === expect.stage) assert.equal(alertText, expect.error);
}

const cases = [];
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: requireTestBrowserExecutable(), headless: true });
  const smoke = process.argv.includes('--smoke');
  const oneCaseDiagnostic = diagnosticEmptyActions || diagnosticReveal;
  const widths = oneCaseDiagnostic || smoke ? [390] : fixture.widths;
  const themes = oneCaseDiagnostic || smoke ? ['light'] : fixture.themes;
  const scales = diagnosticReveal ? [2] : diagnosticEmptyActions || smoke ? [1] : fixture.textScales;
  const states = diagnosticReveal
    ? fixture.states.filter((state) => state.id === 'capabilities-saving')
    : diagnosticEmptyActions ? fixture.states.filter((state) => state.id === 'config-empty')
      : smoke ? fixture.states.filter((state) => state.id === 'chat-loading') : fixture.states;
  const diagnostics = [];
  for (const width of widths) {
    for (const theme of themes) {
      const context = await browser.newContext({
        viewport: { width, height: fixture.height }, deviceScaleFactor: 1,
        isMobile: true, hasTouch: true, locale: 'en-US', colorScheme: theme,
      });
      try {
        for (const state of states) {
          for (const scale of scales) {
            const page = await context.newPage();
            const browserErrors = [];
            page.on('pageerror', (error) => browserErrors.push(error.stack || error.message));
            page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
            await page.goto(`http://127.0.0.1:18922/parity.html?workspace=${encodeURIComponent(state.workspaceId)}&state=${encodeURIComponent(state.id)}`, { waitUntil: 'load' });
            await page.waitForFunction(() => window.__appMounted && document.querySelector('#workspace-title') && window.__apiPending === 0, null, { timeout: 15000 });
            await page.locator('#workspace-tab-settings').click();
            await page.waitForFunction(() => document.querySelector('#workspace-tab-settings')?.getAttribute('aria-selected') === 'true', null, { timeout: 5000 });
            await page.waitForTimeout(45);
            const snapshots = [];
            for (const flowStep of state.flow ?? [{ type: 'waitIdle' }, { type: 'capture', stage: 'initial' }]) {
              await page.evaluate(factor => window.__applyParityTextScale(factor), scale);
              if (flowStep.type === 'capture') {
                if (diagnosticReveal && flowStep.stage === 'saving') {
                  diagnostics.push({ id: `${state.id}-${width}-${theme}-text${scale}`, phase: 'saving-before-top-snapshot-after-real-interaction', ...await inspectRevealScroll(page) });
                }
                const capture = await captureStage(page, state, flowStep.stage, width, theme, scale);
                assertStateStage(state, flowStep.stage, capture);
                snapshots.push(capture);
                if (diagnosticReveal && flowStep.stage === 'saving') {
                  diagnostics.push({ id: `${state.id}-${width}-${theme}-text${scale}`, phase: 'saving-after-captureStage', ...await inspectRevealScroll(page) });
                }
              } else {
                await step(page, state, flowStep);
              }
            }
            assert.equal(snapshots.length > 0, true, `${state.id}: no captured stages`);
            assert.equal(browserErrors.length, 0, `${state.id}/${width}/${theme}/${scale}: browser errors ${browserErrors.join('\n')}`);
            const captureId = `${state.id}-${width}-${theme}-text${scale}`;
            if (diagnosticEmptyActions) diagnostics.push({ id: captureId, ...await inspectEmptyActions(page) });
            cases.push({
              id: captureId, state: state.id, workspaceId: state.workspaceId,
              width, height: fixture.height, theme, textScale: scale,
              browser: 'Google Chrome pinned executable; deviceScaleFactor 1; isMobile true; hasTouch true; pointer hover:none/pointer:coarse',
              stages: snapshots,
              finalApiRequests: await page.evaluate(() => window.__apiRequests.map((row) => ({ ...row }))),
              finalPending: await page.evaluate(() => window.__apiPending),
              unexpectedRequests: await page.evaluate(() => [...window.__apiUnexpected]),
              browserErrors,
            });
            assert.equal(await page.evaluate(() => window.__apiUnexpected.length), 0, `${captureId}: unexpected API route`);
            assert.equal(await page.evaluate(() => window.__heldSettingsRequests.length), 0, `${captureId}: request left held at finish`);
            assert.equal(await page.evaluate(() => window.__apiPending), 0, `${captureId}: request left pending at finish`);
            await page.close();
          }
        }
      } finally {
        await context.close();
      }
    }
  }
  assert.equal(cases.length, states.length * widths.length * themes.length * scales.length, 'state/configuration matrix is incomplete');
  if (oneCaseDiagnostic) {
    const diagnosticFile = diagnosticReveal ? 'workspace-settings-capabilities-saving-reveal-probe.json' : 'workspace-settings-empty-actions-dom-probe.json';
    const diagnosticPath = resolve(out, diagnosticFile);
    const diagnosticMeta = diagnosticReveal
      ? { browser: 'Google Chrome pinned executable; 390x900; light; text scale 2', state: 'capabilities-saving', observedStages: ['saving-before-top-snapshot-after-real-interaction', 'saving-after-captureStage'] }
      : { browser: 'Google Chrome pinned executable; 390x900; light; text scale 1', state: 'config-empty' };
    await writeFile(diagnosticPath, JSON.stringify({ webRevision: pinned, ...diagnosticMeta, diagnostics }, null, 2) + '\n');
    console.log(JSON.stringify({ caseCount: cases.length, diagnosticPath, diagnostics }, null, 2));
  } else {
  const expected = {
    fixture: 'fixtures/mobile-parity/workspace-settings-states.json',
    webRevision: pinned,
    capturedAt: new Date().toISOString(),
    browser: {
      name: 'Google Chrome', executable: requireTestBrowserExecutable(),
      deviceScaleFactor: 1, isMobile: true, hasTouch: true,
      pointerPolicy: 'hover:none + pointer:coarse',
      viewportWidths: fixture.widths, height: fixture.height, themes: fixture.themes, textScales: fixture.textScales,
    },
    simulation: fixture.simulation,
    stateIds: fixture.states.map((state) => state.id),
    cases,
  };
  const expectedPath = resolve(root, 'fixtures/mobile-parity/workspace-settings-states-expected.json');
  await writeFile(expectedPath, JSON.stringify(expected, null, 2) + '\n');
  console.log(JSON.stringify({ caseCount: cases.length, stageCount: cases.reduce((n, item) => n + item.stages.length, 0), expected: expectedPath, screenshots: out }, null, 2));
  }
} finally {
  await browser?.close();
  await server.close();
}
