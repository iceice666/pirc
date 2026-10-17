import { requireTestBrowserExecutable } from './test_browser.mjs';
// Capture the pinned production SettingsDialog in Chrome at the responsive and
// text-scale matrix declared by settings-matrix.json. Output stays ignored.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';

const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const fixturePath = resolve(root, 'fixtures/mobile-parity/settings-matrix.json');
const expectedPath = resolve(root, 'fixtures/mobile-parity/settings-matrix-expected.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
assert.equal(fixture.webRevision, revision, 'fixture must pin the requested Web revision');
assert.equal(expected.webRevision, revision, 'expected contract must pin the Web revision');
assert.deepEqual(fixture.widths, expected.widths);
assert.deepEqual(fixture.themes, expected.themes);
assert.deepEqual(fixture.textScales, expected.textScales);
assert.deepEqual(fixture.tabs, expected.tabs.map((tab) => tab.id));
assert.equal(fixture.authContexts.adminReference.id, expected.referenceAuthContext);
for (const key of ['state', 'permission', 'browserPushSupport', 'registration', 'subscription', 'realPermissionPromptDisplayed', 'realServiceWorkerRegistered', 'expectedMessage']) {
  assert.equal(fixture.notificationBaseline[key], expected.notificationBaseline[key], `notification baseline ${key}`);
}
assert.equal(expected.supplementalDeviceTokenCasesPerConfiguration, 2);
assert.equal(
  fixture.widths.length * fixture.themes.length * fixture.textScales.length * expected.supplementalDeviceTokenCasesPerConfiguration,
  expected.expectedSupplementalDeviceTokenCaseCount,
);
for (const response of expected.deviceTokenResponses) {
  const fixtureResponse = fixture.authContexts.deviceToken.forbiddenResponses[response.path];
  assert(fixtureResponse, `missing pinned device-token API fixture for ${response.path}`);
  assert.equal(fixtureResponse.status, response.status);
  assert.deepEqual(fixtureResponse.body, response.response);
}
const gatewayAuthSource = await readFile(resolve(root, 'apps/gateway/src/daemon/auth.ts'), 'utf8');
const gatewayDevicesSource = await readFile(resolve(root, 'apps/gateway/src/daemon/devices.ts'), 'utf8');
assert.match(gatewayAuthSource, /new ApiError\(403, 'forbidden', 'Device tokens cannot reach this route'\)/);
assert.match(gatewayDevicesSource, /new ApiError\(403, 'forbidden', 'Device tokens cannot manage devices'\)/);
assert.equal(
  fixture.widths.length * fixture.themes.length * fixture.textScales.length * fixture.tabs.length,
  expected.expectedCaseCount,
);
assert.deepEqual(
  {
    user: fixture.memory.user.length,
    notes: fixture.memory.notes.length,
    proposals: fixture.memory.proposals.length,
    removed: fixture.memory.removed.length,
    historyVersions: fixture.memoryHistory['user-response-style'].length,
  },
  expected.memoryFixtureCounts,
);
execFileSync(
  'git',
  ['diff', '--exit-code', revision, '--', 'apps/web', ':!apps/web/tool'],
  { cwd: root },
);

const smoke = process.argv.includes('--smoke');
const selectedWidths = smoke ? [390, 768] : fixture.widths;
assert(selectedWidths.every((width) => fixture.widths.includes(width)));
const outputRoot = resolve(root, 'apps/android/build/parity/settings-matrix');
await mkdir(outputRoot, { recursive: true });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const expectedTabSource = JSON.stringify(expected.tabs).replaceAll('<', '\\u003c');

const pageHtml = `<!doctype html>
<html>
  <head>
    <link rel="icon" href="data:,">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>:root { font-family: Arial !important; --font-mono: Menlo, monospace !important; }</style>
  </head>
  <body>
    <div id="settings-root"></div>
    <script type="module">
      import '/src/app.css';
      import { mount, tick } from 'svelte';
      import SettingsDialog from '/src/lib/components/dialogs/SettingsDialog.svelte';
      import { app } from '/src/lib/app.svelte.ts';

      const fixture = ${fixtureSource};
      const tabContract = ${expectedTabSource};
      Date.now = () => fixture.now;
      const notificationHarness = {
        baseline: structuredClone(fixture.notificationBaseline),
        permission: fixture.notificationBaseline.permission,
        registrationCalls: 0,
        getSubscriptionCalls: 0,
        requestPermissionCalls: 0,
      };
      const notificationRegistration = {
        pushManager: {
          async getSubscription() {
            notificationHarness.getSubscriptionCalls++;
            return null;
          },
        },
      };
      const fakeServiceWorker = {
        async getRegistration() {
          notificationHarness.registrationCalls++;
          return notificationRegistration;
        },
      };
      const sourceNavigator = window.navigator;
      const modeledNavigator = new Proxy(sourceNavigator, {
        has(target, key) {
          if (key === 'serviceWorker') return fixture.notificationBaseline.browserPushSupport;
          return Reflect.has(target, key);
        },
        get(target, key) {
          if (key === 'serviceWorker') return fixture.notificationBaseline.browserPushSupport ? fakeServiceWorker : undefined;
          return Reflect.get(target, key, target);
        },
      });
      Object.defineProperty(window, 'navigator', { value: modeledNavigator, configurable: true });
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: {
          get permission() { return notificationHarness.permission; },
          async requestPermission() {
            notificationHarness.requestPermissionCalls++;
            throw new Error('Settings baseline must not request real notification permission');
          },
        },
      });
      if (!('PushManager' in window) || window.PushManager == null) {
        Object.defineProperty(window, 'PushManager', { value: class FakePushManager {}, configurable: true });
      }
      window.__settingsNotificationHarness = notificationHarness;
      window.__settingsAuthContext = new URLSearchParams(location.search).get('parityAuth') === 'device-token'
        ? fixture.authContexts.deviceToken.id
        : fixture.authContexts.adminReference.id;
      window.__apiRequests = [];
      window.__forbiddenResponses = [];
      window.__unexpectedApiRequests = [];
      const originalFetch = window.fetch.bind(window);
      const json = (body, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
      window.fetch = async (input, init = {}) => {
        const inputUrl = typeof input === 'string' ? input : input.url;
        const url = new URL(inputUrl, location.href);
        if (!url.pathname.startsWith('/api/')) return originalFetch(input, init);
        const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
        const forbiddenResponse = window.__settingsAuthContext === fixture.authContexts.deviceToken.id
          ? fixture.authContexts.deviceToken.forbiddenResponses[url.pathname]
          : undefined;
        if (forbiddenResponse) headers.set(fixture.authContexts.deviceToken.authorizationHeader, fixture.authContexts.deviceToken.authorizationValue);
        const authorization = headers.get('authorization');
        window.__apiRequests.push({
          method,
          path: url.pathname,
          authContext: window.__settingsAuthContext,
          authorizationPresent: authorization !== null,
          authorizationScheme: authorization?.split(' ', 1)[0] ?? null,
          syntheticDeviceToken: authorization === fixture.authContexts.deviceToken.authorizationValue,
        });
        if (forbiddenResponse) {
          window.__forbiddenResponses.push({ method, path: url.pathname, status: forbiddenResponse.status, body: structuredClone(forbiddenResponse.body) });
          return json(forbiddenResponse.body, forbiddenResponse.status);
        }
        if (url.pathname === '/api/assistant/node') return json(fixture.binding);
        if (url.pathname === '/api/assistant/prompts') return json(fixture.prompts);
        if (url.pathname === '/api/memory') return json(fixture.memory);
        if (url.pathname === '/api/providers') return json(fixture.providers);
        if (url.pathname === '/api/devices') return json(fixture.devices);
        if (url.pathname === '/api/push') return json(fixture.push);
        const historyPrefix = '/api/memory/entries/';
        const historySuffix = '/history';
        if (url.pathname.startsWith(historyPrefix) && url.pathname.endsWith(historySuffix)) {
          const entryId = decodeURIComponent(url.pathname.slice(historyPrefix.length, -historySuffix.length));
          const versions = fixture.memoryHistory[entryId];
          if (versions) return json({ versions });
        }
        window.__unexpectedApiRequests.push({ method, path: url.pathname });
        return json({ error: 'Unexpected fixture API request', path: url.pathname }, 501);
      };

      app.clientId = fixture.clientId;
      app.nodes = fixture.nodes;
      app.memoryPending = fixture.memory.proposals.length;
      mount(SettingsDialog, {
        target: document.querySelector('#settings-root'),
        props: { open: true, tab: 'general', showSettled: false, onresetlayout: () => {} },
      });
      await tick();
      await document.fonts.ready;
      window.__settingsMounted = true;

      const originalInlineFontSizes = new WeakMap();
      window.__applyTextScale = (scale) => {
        const root = document.querySelector('dialog.modal-dialog .modal');
        if (!root) throw new Error('Settings modal root is missing');
        const elements = [root, ...root.querySelectorAll('*')];

        // New tab nodes can appear beneath parents that were scaled previously.
        // Remember their authored inline declarations first, then restore every
        // known declaration before reading any computed sizes.
        for (const element of elements) {
          if (!originalInlineFontSizes.has(element)) {
            originalInlineFontSizes.set(element, {
              value: element.style.getPropertyValue('font-size'),
              priority: element.style.getPropertyPriority('font-size'),
            });
          }
        }
        for (const element of elements) {
          const authored = originalInlineFontSizes.get(element);
          if (authored.value) {
            element.style.setProperty('font-size', authored.value, authored.priority);
          } else {
            element.style.removeProperty('font-size');
          }
        }

        // Snapshot the entire tree only after all ancestors have their authored
        // styles again; otherwise inherited values multiply as we visit children.
        const baseFontSizes = elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize));
        root.setAttribute('data-parity-scale', String(scale));
        elements.forEach((element, index) => {
          const base = baseFontSizes[index];
          if (Number.isFinite(base)) {
            element.style.setProperty('font-size', (base * scale) + 'px', 'important');
          }
        });
      };
      window.__tabContract = tabContract;
    </script>
  </body>
</html>`;

const server = await createServer({
  cacheDir: resolve(outputRoot, 'vite-cache'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18931,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'settings-matrix-capture',
      configureServer(vite) {
        vite.middlewares.use('/settings-matrix.html', async (_request, response, next) => {
          try {
            const html = await vite.transformIndexHtml('/settings-matrix.html', pageHtml);
            response.setHeader('Content-Type', 'text/html');
            response.end(html);
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});

function rect(element) {
  if (!element) return null;
  const value = element.getBoundingClientRect();
  return {
    x: value.x,
    y: value.y,
    top: value.top,
    right: value.right,
    bottom: value.bottom,
    left: value.left,
    width: value.width,
    height: value.height,
  };
}

function visible(element) {
  if (!element || element.getClientRects().length === 0) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
}

function intersects(a, b) {
  return !!a && !!b && a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

function styleData(element) {
  const style = getComputedStyle(element);
  return {
    font: style.font,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    textTransform: style.textTransform,
    color: style.color,
    backgroundColor: style.backgroundColor,
    margin: style.margin,
    padding: style.padding,
    border: style.border,
    display: style.display,
    boxSizing: style.boxSizing,
  };
}

function shortText(element) {
  const raw = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
    ? (element.value || element.getAttribute('placeholder') || element.getAttribute('aria-label') || '')
    : (element.innerText || element.textContent || '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function textMetrics(element) {
  const text = shortText(element);
  if (!text) return null;
  const style = getComputedStyle(element);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return null;
  try {
    context.font = style.font;
    const metric = context.measureText(text);
    const range = document.createRange();
    range.selectNodeContents(element);
    const fragments = [...range.getClientRects()].map((box) => ({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    }));
    return {
      text,
      canvasFont: context.font,
      advance: metric.width,
      actualBoundingBoxLeft: metric.actualBoundingBoxLeft,
      actualBoundingBoxRight: metric.actualBoundingBoxRight,
      actualBoundingBoxAscent: metric.actualBoundingBoxAscent,
      actualBoundingBoxDescent: metric.actualBoundingBoxDescent,
      rangeClientRects: fragments,
    };
  } catch (error) {
    return { text, error: String(error) };
  }
}

function captureTab(tab) {
  const dialog = document.querySelector('dialog.modal-dialog.settings');
  const modal = dialog?.querySelector('.modal.settings');
  const header = modal?.querySelector(':scope > header');
  const layout = modal?.querySelector('.settings-layout');
  const navigation = modal?.querySelector('.settings-nav');
  const content = modal?.querySelector('.settings-panels');
  const activePanel = document.querySelector('#settings-panel-' + tab);
  const viewport = content ? rect(content) : null;
  const visibleTextSelectors = 'h2,h3,h4,p,label,span,strong,small,code,summary';
  const textElements = [...(activePanel?.querySelectorAll(visibleTextSelectors) ?? [])]
    .filter(visible)
    .map((element) => {
      const box = rect(element);
      return {
        tag: element.tagName.toLowerCase(),
        className: typeof element.className === 'string' ? element.className : '',
        text: shortText(element),
        fullText: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
        box,
        inViewport: intersects(box, { left: 0, top: 0, right: innerWidth, bottom: innerHeight }),
        inContentViewport: intersects(box, viewport),
        style: styleData(element),
        fontMetrics: textMetrics(element),
      };
    });
  const activeControls = [...(activePanel?.querySelectorAll('input,textarea,select,button') ?? [])]
    .filter(visible)
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type'),
      label: element.getAttribute('aria-label') || element.labels?.[0]?.innerText?.trim() || null,
      text: shortText(element),
      value: 'value' in element ? element.value : null,
      checked: 'checked' in element ? element.checked : null,
      disabled: 'disabled' in element ? element.disabled : null,
      readOnly: 'readOnly' in element ? element.readOnly : null,
      box: rect(element),
      style: styleData(element),
      fontMetrics: textMetrics(element),
    }));
  const structures = [...(activePanel?.querySelectorAll('section,form,.settings-row,.backend-card,.memory-row,.memory-actions,details,ul,ol') ?? [])]
    .filter(visible)
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      className: typeof element.className === 'string' ? element.className : '',
      ariaLabel: element.getAttribute('aria-label'),
      text: shortText(element),
      box: rect(element),
      style: styleData(element),
      scroll: {
        top: element.scrollTop,
        height: element.scrollHeight,
        clientHeight: element.clientHeight,
      },
      open: element instanceof HTMLDetailsElement ? element.open : null,
    }));
  const navItems = [...(navigation?.querySelectorAll('[role="tab"]') ?? [])].map((element) => ({
    id: element.id,
    label: shortText(element),
    selected: element.getAttribute('aria-selected') === 'true',
    tabIndex: element.tabIndex,
    box: rect(element),
    style: styleData(element),
    fontMetrics: textMetrics(element),
  }));
  const headerTitle = header?.querySelector('h2');
  const headerEyebrow = header?.querySelector('.eyebrow');
  const headerClose = header?.querySelector('button[aria-label="Close"]');
  return {
    tab,
    selectedTab: document.querySelector('#settings-tab-' + tab)?.getAttribute('aria-selected') === 'true',
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    theme: {
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      fontAvailable: document.fonts.check('16px Arial'),
      modalFontFamily: modal ? getComputedStyle(modal).fontFamily : null,
      textScale: Number(document.querySelector('.modal')?.getAttribute('data-parity-scale') || '1'),
    },
    frame: {
      dialog: { box: rect(dialog), open: dialog?.open ?? false, backdrop: dialog ? getComputedStyle(dialog, '::backdrop').backgroundColor : null, style: dialog ? styleData(dialog) : null },
      modal: { box: rect(modal), style: modal ? styleData(modal) : null },
      header: {
        box: rect(header),
        title: headerTitle?.innerText?.trim() ?? null,
        style: header ? styleData(header) : null,
        titleBox: rect(headerTitle),
        titleStyle: headerTitle ? styleData(headerTitle) : null,
        titleFontMetrics: headerTitle ? textMetrics(headerTitle) : null,
        eyebrowBox: rect(headerEyebrow),
        eyebrowStyle: headerEyebrow ? styleData(headerEyebrow) : null,
        eyebrowFontMetrics: headerEyebrow ? textMetrics(headerEyebrow) : null,
        closeButtonBox: rect(headerClose),
        closeButtonStyle: headerClose ? styleData(headerClose) : null,
      },
      layout: { box: rect(layout), style: layout ? styleData(layout) : null },
      navigation: { box: rect(navigation), style: navigation ? styleData(navigation) : null, items: navItems },
      content: { box: viewport, style: content ? styleData(content) : null, scrollTop: content?.scrollTop ?? null, scrollHeight: content?.scrollHeight ?? null, clientHeight: content?.clientHeight ?? null },
      activePanel: { id: activePanel?.id ?? null, hidden: activePanel?.hidden ?? null, box: rect(activePanel), style: activePanel ? styleData(activePanel) : null },
    },
    textElements,
    controls: activeControls,
    structures,
    memoryState: tab === 'memory' ? {
      panelScrollTop: content?.scrollTop ?? null,
      historyOpen: !!activePanel?.querySelector('ol.memory-history'),
      historyItems: activePanel?.querySelectorAll('ol.memory-history > li').length ?? 0,
      removedDetailsOpen: activePanel?.querySelector('details.memory-removed')?.open ?? null,
    } : null,
    notificationBrowser: tab === 'general' ? (() => {
      const harness = window.__settingsNotificationHarness;
      const message = activePanel?.querySelector('.push-row > span');
      return {
        baseline: structuredClone(harness.baseline),
        visibleMessage: message?.innerText?.trim() ?? null,
        serviceWorkerPropertyPresent: 'serviceWorker' in navigator,
        pushManagerPropertyPresent: 'PushManager' in window,
        notificationPropertyPresent: 'Notification' in window,
        permission: Notification.permission,
        registrationCalls: harness.registrationCalls,
        getSubscriptionCalls: harness.getSubscriptionCalls,
        requestPermissionCalls: harness.requestPermissionCalls,
      };
    })() : null,
  };
}

const browserCaptureHelpers = [
  rect,
  visible,
  intersects,
  styleData,
  shortText,
  textMetrics,
  captureTab,
].map((helper) => helper.toString()).join('\n');

let browser;
const errors = [];
const totalExpectedCases = selectedWidths.length * fixture.themes.length * fixture.textScales.length * fixture.tabs.length;
let completedCases = 0;
let completedDeviceTokenCases = 0;
const runManifest = {
  fixture: fixture.id,
  webRevision: fixture.webRevision,
  rendererLabel: expected.rendererLabel,
  scalePolicy: expected.textScaleMethod,
  invalidatedPriorCapture: expected.invalidatedPriorCapture,
  referenceAuthContext: expected.referenceAuthContext,
  supplementalDeviceTokenCasesPerConfiguration: expected.supplementalDeviceTokenCasesPerConfiguration,
  expectedSupplementalDeviceTokenCaseCount: selectedWidths.length * fixture.themes.length * fixture.textScales.length * expected.supplementalDeviceTokenCasesPerConfiguration,
  mode: smoke ? 'smoke' : 'full',
  widths: selectedWidths,
  themes: fixture.themes,
  textScales: fixture.textScales,
  tabs: fixture.tabs,
  deviceScaleFactor: 1,
  expectedCaseCount: totalExpectedCases,
  memoryFixtureCounts: expected.memoryFixtureCounts,
  cases: [],
};

async function waitForDeviceTokenTab(page, tab, expectedAlert) {
  await page.locator('#settings-tab-' + tab).click();
  await page.waitForFunction((id) => {
    const panel = document.querySelector('#settings-panel-' + id);
    return !!panel && !panel.hidden && document.querySelector('#settings-tab-' + id)?.getAttribute('aria-selected') === 'true';
  }, tab);
  await page.locator(`#settings-panel-${tab} [role="alert"]`).waitFor();
  await page.getByText(expectedAlert, { exact: true }).waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function waitForTab(page, tab) {
  await page.locator('#settings-tab-' + tab).click();
  await page.waitForFunction((id) => {
    const panel = document.querySelector('#settings-panel-' + id);
    return !!panel && !panel.hidden && document.querySelector('#settings-tab-' + id)?.getAttribute('aria-selected') === 'true';
  }, tab);
  if (tab === 'general') {
    await page.locator('#settings-panel-general .push-row').waitFor();
  } else if (tab === 'assistant') {
    await page.locator('#settings-panel-assistant textarea').first().waitFor();
  } else if (tab === 'memory') {
    await page.locator('#settings-panel-memory .memory-usage').waitFor();
  } else if (tab === 'models') {
    await page.locator('#settings-panel-models .backend-card').first().waitFor();
  } else if (tab === 'devices') {
    await page.locator('#settings-panel-devices .pair-form').waitFor();
    await page.getByText('No phones paired.', { exact: true }).waitFor();
  } else if (tab === 'about') {
    await page.locator('#settings-panel-about h3').waitFor();
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: requireTestBrowserExecutable(),
    headless: true,
  });
  for (const width of selectedWidths) {
    for (const theme of fixture.themes) {
      for (const textScale of fixture.textScales) {
        const configId = `${width}-${theme}-scale${textScale}`;
        const configDir = resolve(outputRoot, configId);
        await mkdir(configDir, { recursive: true });
        const page = await browser.newPage({
          viewport: { width, height: fixture.height },
          deviceScaleFactor: 1,
          isMobile: true,
          hasTouch: true,
          locale: 'en-US',
          colorScheme: theme,
        });
        page.setDefaultTimeout(10000);
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') pageErrors.push(message.text());
        });
        page.on('response', (response) => {
          if (response.status() >= 400) pageErrors.push(`${response.status()} ${response.url()}`);
        });
        await page.goto('http://127.0.0.1:18931/settings-matrix.html');
        await page.waitForFunction(() => window.__settingsMounted === true);
        await page.evaluate((source) => {
          new Function(source + '\nwindow.__captureTab = captureTab;')();
        }, browserCaptureHelpers);
        await page.evaluate((scale) => window.__applyTextScale(scale), textScale);
        const config = {
          id: configId,
          authContext: expected.referenceAuthContext,
          viewport: { width, height: fixture.height, deviceScaleFactor: 1 },
          theme,
          textScale,
          textScaleMethod: expected.textScaleMethod,
          tabCaptures: {},
          apiRequests: [],
          unexpectedApiRequests: [],
          errors: [],
          deviceTokenCaptures: {},
          memorySupplementalCaptures: {},
        };
        for (const tab of fixture.tabs) {
          await waitForTab(page, tab);
          await page.evaluate((scale) => window.__applyTextScale(scale), textScale);
          await page.evaluate(() => {
            const content = document.querySelector('.settings-panels');
            if (content) content.scrollTop = 0;
          });
          const tabContract = expected.tabs.find((entry) => entry.id === tab);
          assert(tabContract, `missing expected contract for tab ${tab}`);
          const state = await page.evaluate((id) => window.__captureTab(id), tab);
          assert.equal(state.frame.dialog.open, true, `${configId}/${tab} modal should stay open`);
          assert.equal(state.selectedTab, true, `${configId}/${tab} should be selected through UI`);
          assert.equal(state.frame.activePanel.hidden, false, `${configId}/${tab} panel should be visible`);
          if (tab === 'general') {
            for (const key of ['state', 'permission', 'browserPushSupport', 'registration', 'subscription', 'realPermissionPromptDisplayed', 'realServiceWorkerRegistered', 'expectedMessage']) {
              assert.equal(state.notificationBrowser.baseline[key], expected.notificationBaseline[key], `${configId} notification baseline ${key}`);
            }
            assert.equal(state.notificationBrowser.visibleMessage, expected.notificationBaseline.expectedMessage, `${configId} actual NotificationSettings off message`);
            assert.equal(state.notificationBrowser.serviceWorkerPropertyPresent, true, `${configId} modeled serviceWorker support`);
            assert.equal(state.notificationBrowser.pushManagerPropertyPresent, true, `${configId} modeled PushManager support`);
            assert.equal(state.notificationBrowser.notificationPropertyPresent, true, `${configId} modeled Notification support`);
            assert.equal(state.notificationBrowser.permission, 'default', `${configId} modeled permission`);
            assert.equal(state.notificationBrowser.registrationCalls, 1, `${configId} pushState calls getRegistration`);
            assert.equal(state.notificationBrowser.getSubscriptionCalls, 1, `${configId} pushState checks for a subscription`);
            assert.equal(state.notificationBrowser.requestPermissionCalls, 0, `${configId} baseline does not request notification permission`);
          }
          assert(
            state.textElements.some((element) =>
              element.text.toLocaleLowerCase().includes(tabContract.visibleHeading.toLocaleLowerCase()),
            ),
            `${configId}/${tab} expected visible heading ${tabContract.visibleHeading}; captured=${JSON.stringify(state.textElements.map((element) => ({ tag: element.tag, text: element.text, box: element.box })))}`,
          );
          await page.screenshot({ path: resolve(configDir, `${tab}.png`) });
          if (tab === 'memory') {
            assert.equal(state.memoryState.panelScrollTop, 0, `${configId} memory baseline starts at top`);
            assert.equal(state.memoryState.historyOpen, false, `${configId} memory baseline has history closed`);
            assert.equal(state.memoryState.removedDetailsOpen, false, `${configId} memory baseline has removed details closed`);
            const panel = page.locator('.settings-panels');
            const historyButton = page.locator('#settings-panel-memory ul[aria-label="About you"] button[aria-expanded]').first();
            await historyButton.click();
            await page.waitForFunction(() => document.querySelector('#settings-panel-memory ul[aria-label="About you"] button[aria-expanded="true"]'));
            await page.waitForFunction(() => document.querySelectorAll('#settings-panel-memory ol.memory-history > li').length === 3);
            const counts = await page.locator('#settings-panel-memory').evaluate((element) => ({
              proposals: element.querySelectorAll('ul[aria-label="Waiting for you"] > li').length,
              user: element.querySelectorAll('ul[aria-label="About you"] > li').length,
              notes: element.querySelectorAll('ul[aria-label="The assistant\'s notes"] > li').length,
              removed: element.querySelectorAll('details.memory-removed ul[aria-label="Removed"] > li').length,
              historyVersions: element.querySelectorAll('ol.memory-history > li').length,
            }));
            assert.deepEqual(counts, expected.memoryFixtureCounts, `${configId} memory fixture rendered`);
            await historyButton.scrollIntoViewIfNeeded();
            await page.evaluate((scale) => window.__applyTextScale(scale), textScale);
            const historyUi = await page.evaluate(() => window.__captureTab('memory'));
            assert.equal(historyUi.memoryState.historyOpen, true, `${configId} supplemental history state is open`);
            config.memorySupplementalCaptures.history = historyUi;
            await page.screenshot({ path: resolve(configDir, 'memory-history.png') });
            await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
            const bottomUi = await page.evaluate(() => window.__captureTab('memory'));
            config.memorySupplementalCaptures.bottom = bottomUi;
            await page.screenshot({ path: resolve(configDir, 'memory-bottom.png') });
            await panel.evaluate((element) => { element.scrollTop = 0; });
            await historyButton.click();
            await page.waitForFunction(() => !document.querySelector('#settings-panel-memory ol.memory-history'));
            await panel.evaluate((element) => { element.scrollTop = 0; });
            assert.equal(await panel.evaluate((element) => element.scrollTop), 0, `${configId} memory panel returns to top after supplemental captures`);
          }
          const apiRequests = await page.evaluate(() => window.__apiRequests.slice());
          const unexpectedApiRequests = await page.evaluate(() => window.__unexpectedApiRequests.slice());
          assert.deepEqual(unexpectedApiRequests, [], `${configId}/${tab} unexpected local API requests`);
          config.apiRequests = apiRequests;
          config.unexpectedApiRequests = unexpectedApiRequests;
          config.tabCaptures[tab] = state;
          completedCases++;
          if (pageErrors.length) throw new Error(`${configId}/${tab}: ${pageErrors.join('\n')}`);
        }
        config.errors = pageErrors;
        assert.deepEqual(config.errors, []);
        await page.close();

        const devicePage = await browser.newPage({
          viewport: { width, height: fixture.height },
          deviceScaleFactor: 1,
          isMobile: true,
          hasTouch: true,
          locale: 'en-US',
          colorScheme: theme,
        });
        devicePage.setDefaultTimeout(10000);
        const devicePageErrors = [];
        devicePage.on('pageerror', (error) => devicePageErrors.push(error.stack || error.message));
        devicePage.on('console', (message) => {
          if (message.type() === 'error') devicePageErrors.push(message.text());
        });
        devicePage.on('response', (response) => {
          if (response.status() >= 400) devicePageErrors.push(`${response.status()} ${response.url()}`);
        });
        await devicePage.goto('http://127.0.0.1:18931/settings-matrix.html?parityAuth=device-token');
        await devicePage.waitForFunction(() => window.__settingsMounted === true);
        await devicePage.evaluate((source) => {
          new Function(source + '\nwindow.__captureTab = captureTab;')();
        }, browserCaptureHelpers);
        await devicePage.evaluate((scale) => window.__applyTextScale(scale), textScale);
        for (const tab of ['models', 'devices']) {
          const contract = expected.deviceTokenResponses.find((entry) => entry.tab === tab);
          assert(contract, `missing device-token response contract for ${tab}`);
          await waitForDeviceTokenTab(devicePage, tab, contract.visibleAlert);
          await devicePage.evaluate((scale) => window.__applyTextScale(scale), textScale);
          await devicePage.evaluate(() => {
            const content = document.querySelector('.settings-panels');
            if (content) content.scrollTop = 0;
          });
          const ui = await devicePage.evaluate((id) => window.__captureTab(id), tab);
          const visibleAlert = ui.textElements.find((element) => element.text === contract.visibleAlert);
          assert(visibleAlert, `${configId}/${tab} expected visible device-token alert ${contract.visibleAlert}`);
          const request = await devicePage.evaluate((path) => window.__apiRequests.find((entry) => entry.path === path), contract.path);
          assert(request, `${configId}/${tab} expected device-token request ${contract.path}`);
          assert.equal(request.method, contract.method, `${configId}/${tab} device-token method`);
          assert.equal(request.authContext, 'device-token', `${configId}/${tab} auth context`);
          assert.equal(request.authorizationPresent, true, `${configId}/${tab} authorization header`);
          assert.equal(request.authorizationScheme, 'Bearer', `${configId}/${tab} authorization scheme`);
          assert.equal(request.syntheticDeviceToken, true, `${configId}/${tab} synthetic pirc_dev credential`);
          const response = await devicePage.evaluate((path) => window.__forbiddenResponses.find((entry) => entry.path === path), contract.path);
          assert(response, `${configId}/${tab} expected forbidden fixture response ${contract.path}`);
          assert.equal(response.status, contract.status, `${configId}/${tab} device-token status`);
          assert.deepEqual(response.body, contract.response, `${configId}/${tab} device-token body`);
          config.deviceTokenCaptures[tab] = {
            authContext: 'device-token',
            request,
            response,
            visibleAlert: contract.visibleAlert,
            messageHandling: contract.messageHandling,
            ui,
          };
          await devicePage.screenshot({ path: resolve(configDir, `${tab}-device-token.png`) });
          completedDeviceTokenCases++;
        }
        const deviceUnexpected = await devicePage.evaluate(() => window.__unexpectedApiRequests.slice());
        assert.deepEqual(deviceUnexpected, [], `${configId} device-token unexpected API requests`);
        assert.deepEqual(devicePageErrors, [], `${configId} device-token browser errors`);
        config.deviceTokenApiRequests = await devicePage.evaluate(() => window.__apiRequests.slice());
        config.deviceTokenResponses = await devicePage.evaluate(() => window.__forbiddenResponses.slice());
        config.deviceTokenUnexpectedApiRequests = deviceUnexpected;
        config.deviceTokenErrors = devicePageErrors;
        await devicePage.close();

        await writeFile(
          resolve(configDir, 'capture.json'),
          JSON.stringify(config, null, 2) + '\n',
        );
        runManifest.cases.push({
          id: configId,
          authContext: expected.referenceAuthContext,
          tabCount: Object.keys(config.tabCaptures).length,
          screenshotCount: fixture.tabs.length + 4,
          apiRequestCount: config.apiRequests.length,
          deviceTokenCaptureCount: Object.keys(config.deviceTokenCaptures).length,
          deviceTokenApiRequestCount: config.deviceTokenApiRequests.length,
        });
        console.log(`captured ${configId} (${completedCases}/${totalExpectedCases} admin tab cases, ${completedDeviceTokenCases}/${runManifest.expectedSupplementalDeviceTokenCaseCount} device-token states)`);
      }
    }
  }
  assert.equal(completedCases, totalExpectedCases);
  assert.equal(completedDeviceTokenCases, runManifest.expectedSupplementalDeviceTokenCaseCount);
  runManifest.completedSupplementalDeviceTokenCaseCount = completedDeviceTokenCases;
  await writeFile(resolve(outputRoot, 'run-manifest.json'), JSON.stringify(runManifest, null, 2) + '\n');
  console.log(`complete: ${completedCases} cases across ${selectedWidths.length} widths; output ${outputRoot}`);
} catch (error) {
  errors.push(error.stack || error.message || String(error));
  await writeFile(
    resolve(outputRoot, 'last-failure.json'),
    JSON.stringify({ mode: smoke ? 'smoke' : 'full', completedCases, expectedCases: totalExpectedCases, completedDeviceTokenCases, errors }, null, 2) + '\n',
  );
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
