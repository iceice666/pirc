import { requireTestBrowserExecutable } from './test_browser.mjs';
// Capture real pinned NotificationSettings states through the production
// SettingsDialog, with deterministic local browser-API and gateway fixtures.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';

const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/notification-matrix.json');
const expectedPath = resolve(root, 'fixtures/mobile-parity/notification-matrix-expected.json');
const shellFixturePath = resolve(root, 'fixtures/mobile-parity/settings-matrix.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
const shell = JSON.parse(await readFile(shellFixturePath, 'utf8'));
assert.equal(fixture.webRevision, revision);
assert.equal(expected.webRevision, revision);
assert.equal(shell.webRevision, revision);
assert.deepEqual(fixture.widths, expected.widths);
assert.deepEqual(fixture.themes, expected.themes);
assert.deepEqual(fixture.textScales, expected.textScales);
assert.equal(fixture.focusedCapture.scrollContainerSelector, expected.focusedCapture.scrollContainerSelector);
assert.deepEqual(fixture.focusedCapture.anchors.slice(0, 2), ['notification-section-top', 'status-row']);
assert.equal(fixture.focusedCapture.screenshotPattern, expected.focusedCapture.screenshotPattern);
assert.equal(fixture.focusedCapture.inputMode, expected.focusedCapture.inputMode);
assert.equal(fixture.focusedCapture.actionInput, expected.focusedCapture.actionInput);
assert.equal(fixture.scenarios.length, expected.scenarioCountPerConfiguration);
assert.deepEqual(fixture.scenarios.map((scenario) => scenario.id), expected.scenarios.map((scenario) => scenario.id));
assert.equal(fixture.widths.length * fixture.themes.length * fixture.textScales.length * fixture.scenarios.length, expected.expectedScenarioCaptureCount);
assert.equal(shell.authContexts.adminReference.id, expected.referenceAuthContext);
assert.equal(fixture.syntheticBrowserPush.localOnly, true);
assert.equal(fixture.syntheticBrowserPush.realNotificationPromptDisplayed, false);
assert.equal(fixture.syntheticBrowserPush.realPushServiceContacted, false);
const gatewayAuthSource = await readFile(resolve(root, 'apps/gateway/src/daemon/auth.ts'), 'utf8');
assert.match(gatewayAuthSource, /new ApiError\(403, 'forbidden', 'Identity is not allowed'\)/);
execFileSync('git', ['diff', '--exit-code', revision, '--', 'apps/web', ':!apps/web/tool'], { cwd: root });

const smoke = process.argv.includes('--smoke');
const selectedWidths = smoke ? [390, 768] : fixture.widths;
assert(selectedWidths.every((width) => fixture.widths.includes(width)));
const outputRoot = resolve(root, 'apps/android/build/parity/notification-matrix');
await mkdir(outputRoot, { recursive: true });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const shellSource = JSON.stringify(shell).replaceAll('<', '\\u003c');

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
      const shell = ${shellSource};
      Date.now = () => fixture.now;
      const scenarioId = new URL(location.href).searchParams.get('notificationCase');
      const scenario = fixture.scenarios.find((entry) => entry.id === scenarioId);
      if (!scenario) throw new Error('Unknown notification scenario: ' + scenarioId);
      const harness = {
        scenarioId,
        permission: scenario.permission,
        registrationCalls: 0,
        getSubscriptionCalls: 0,
        requestPermissionCalls: 0,
        subscribeCalls: [],
        unsubscribeCalls: 0,
        touchEvents: [],
        places: structuredClone(scenario.places),
        subscriptionPresent: scenario.subscription,
        subscription: null,
        apiRequests: [],
        apiResponses: [],
        unexpectedApiRequests: [],
        registrationReleased: false,
      };
      window.__notificationHarness = harness;
      window.__apiRequests = harness.apiRequests;
      window.__apiResponses = harness.apiResponses;
      window.__unexpectedApiRequests = harness.unexpectedApiRequests;
      window.__notificationSharedChrome = {
        fixture: fixture.settingsFixture,
        memoryPendingBadgeCount: shell.memory.proposals.length,
      };

      const bytes = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), (ch) => ch.charCodeAt(0));
      const initialKey = bytes(fixture.syntheticBrowserPush.publicVapidKey).buffer;
      function makeSubscription(applicationServerKey = initialKey) {
        return {
          endpoint: fixture.syntheticBrowserPush.subscription.endpoint,
          options: { applicationServerKey },
          toJSON: () => structuredClone(fixture.syntheticBrowserPush.subscription),
          async unsubscribe() {
            harness.unsubscribeCalls++;
            harness.subscriptionPresent = false;
            harness.subscription = null;
            return true;
          },
        };
      }
      if (harness.subscriptionPresent) harness.subscription = makeSubscription();
      const registration = {
        pushManager: {
          async getSubscription() {
            harness.getSubscriptionCalls++;
            return harness.subscription;
          },
          async subscribe(options) {
            harness.subscribeCalls.push({
              userVisibleOnly: options.userVisibleOnly,
              applicationServerKeyLength: options.applicationServerKey?.byteLength ?? options.applicationServerKey?.length ?? null,
            });
            harness.subscriptionPresent = true;
            harness.subscription = makeSubscription(options.applicationServerKey);
            const current = fixture.places.browser;
            harness.places = [
              { ...current, name: fixture.syntheticBrowserPush.subscription.name, lastSuccessAt: null, failing: false },
              ...harness.places.filter((place) => place.id !== current.id),
            ];
            return harness.subscription;
          },
        },
      };
      const serviceWorker = {
        getRegistration() {
          harness.registrationCalls++;
          if (scenario.registration === 'pending') {
            return new Promise((resolve) => {
              window.__releasePushRegistration = () => {
                harness.registrationReleased = true;
                resolve(registration);
              };
            });
          }
          return Promise.resolve(scenario.registration === 'available' ? registration : undefined);
        },
      };
      const realNavigator = window.navigator;
      const navigatorProxy = new Proxy(realNavigator, {
        has(target, key) {
          if (key === 'serviceWorker') return scenario.browserSupport === 'supported';
          return Reflect.has(target, key);
        },
        get(target, key, receiver) {
          if (key === 'serviceWorker') return scenario.browserSupport === 'supported' ? serviceWorker : undefined;
          return Reflect.get(target, key, target);
        },
      });
      Object.defineProperty(window, 'navigator', { value: navigatorProxy, configurable: true });
      if (!('PushManager' in window) || window.PushManager == null) {
        Object.defineProperty(window, 'PushManager', { value: class FakePushManager {}, configurable: true });
      }
      const fakeNotification = {
        get permission() { return harness.permission; },
        async requestPermission() {
          harness.requestPermissionCalls++;
          harness.permission = scenario.requestPermissionResult ?? 'granted';
          return harness.permission;
        },
      };
      Object.defineProperty(window, 'Notification', { value: fakeNotification, configurable: true });
      try {
        if (scenario.subscription) localStorage.setItem('pirc.push.subscription', fixture.places.browser.id);
        else localStorage.removeItem('pirc.push.subscription');
      } catch {}

      const originalFetch = window.fetch.bind(window);
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      const bodySummary = (path, method, body) => {
        if (!body) return null;
        if (path === '/api/push/subscriptions' && method === 'POST') {
          const value = JSON.parse(body);
          return {
            endpointHost: new URL(value.endpoint).host,
            kind: value.kind,
            name: value.name,
            hasP256dh: typeof value.keys?.p256dh === 'string',
            hasAuth: typeof value.keys?.auth === 'string',
          };
        }
        if (path === '/api/push/subscriptions' && method === 'DELETE') {
          const value = JSON.parse(body);
          return { hasId: typeof value.id === 'string', hasEndpoint: typeof value.endpoint === 'string' };
        }
        return JSON.parse(body);
      };
      window.fetch = async (input, init = {}) => {
        const inputUrl = typeof input === 'string' ? input : input.url;
        const url = new URL(inputUrl, location.href);
        if (!url.pathname.startsWith('/api/')) return originalFetch(input, init);
        const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        const requestBody = typeof init.body === 'string' ? init.body : null;
        harness.apiRequests.push({ method, path: url.pathname, body: bodySummary(url.pathname, method, requestBody) });
        let status = 200;
        let body;
        if (url.pathname === '/api/push' && method === 'GET') {
          status = scenario.infoStatus ?? 200;
          body = status === 200
            ? { publicKey: fixture.syntheticBrowserPush.publicVapidKey, subscriptions: structuredClone(harness.places) }
            : structuredClone(scenario.infoBody);
        } else if (url.pathname === '/api/push/subscriptions' && method === 'POST') {
          const submitted = JSON.parse(requestBody ?? '{}');
          const place = {
            ...fixture.places.browser,
            name: submitted.name,
            lastSuccessAt: null,
            failing: false,
          };
          harness.places = [place, ...harness.places.filter((entry) => entry.id !== place.id)];
          status = 201;
          body = { subscription: { id: place.id, kind: 'web', name: place.name, host: place.host } };
        } else if (url.pathname === '/api/push/subscriptions' && method === 'DELETE') {
          const submitted = JSON.parse(requestBody ?? '{}');
          harness.places = harness.places.filter((place) => place.id !== submitted.id && place.id !== submitted.endpoint);
          status = 204;
          body = null;
        } else if (url.pathname === '/api/push/test' && method === 'POST') {
          const result = scenario.testResponse ?? fixture.testActions.success;
          status = result.status;
          body = structuredClone(result.body);
        } else if (url.pathname === '/api/assistant/node') {
          body = shell.binding;
        } else if (url.pathname === '/api/assistant/prompts') {
          body = shell.prompts;
        } else if (url.pathname === '/api/memory') {
          body = shell.memory;
        } else if (url.pathname === '/api/providers') {
          body = shell.providers;
        } else if (url.pathname === '/api/devices') {
          body = shell.devices;
        } else {
          harness.unexpectedApiRequests.push({ method, path: url.pathname });
          status = 501;
          body = { error: { code: 'not_found', message: 'Unexpected notification fixture API request' } };
        }
        harness.apiResponses.push({ method, path: url.pathname, status, body: structuredClone(body) });
        return status === 204 ? new Response(null, { status }) : json(body, status);
      };

      app.clientId = shell.clientId;
      app.nodes = shell.nodes;
      app.memoryPending = shell.memory.proposals.length;
      mount(SettingsDialog, {
        target: document.querySelector('#settings-root'),
        props: { open: true, tab: 'general', showSettled: false, onresetlayout: () => {} },
      });
      await tick();
      await document.fonts.ready;
      const originalInlineFontSizes = new WeakMap();
      window.__applyNotificationTextScale = (scale) => {
        const root = document.querySelector('dialog.modal-dialog .modal');
        if (!root) throw new Error('Settings modal root is missing');
        const elements = [root, ...root.querySelectorAll('*')];
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
          if (authored.value) element.style.setProperty('font-size', authored.value, authored.priority);
          else element.style.removeProperty('font-size');
        }
        const baseFontSizes = elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize));
        root.setAttribute('data-notification-scale', String(scale));
        elements.forEach((element, index) => {
          const base = baseFontSizes[index];
          if (Number.isFinite(base)) element.style.setProperty('font-size', (base * scale) + 'px', 'important');
        });
      };
      window.__settingsMounted = true;
    </script>
  </body>
</html>`;

const helpers = `
function rect(element) {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return { x: box.x, y: box.y, top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
}
function visible(element) {
  if (!element || element.getClientRects().length === 0) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
}
function styleData(element) {
  const style = getComputedStyle(element);
  return {
    font: style.font,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    color: style.color,
    backgroundColor: style.backgroundColor,
    margin: style.margin,
    padding: style.padding,
    border: style.border,
    display: style.display,
    boxSizing: style.boxSizing,
  };
}
function overlaps(a, b) {
  return !!a && !!b && a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}
function labelText(element) {
  return (element?.innerText || element?.textContent || '').replace(/\\s+/g, ' ').trim();
}
function fontMetrics(element) {
  const text = labelText(element);
  if (!text) return null;
  const style = getComputedStyle(element);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  context.font = style.font;
  const metric = context.measureText(text);
  const range = document.createRange();
  range.selectNodeContents(element);
  return {
    text,
    canvasFont: context.font,
    advance: metric.width,
    actualBoundingBoxAscent: metric.actualBoundingBoxAscent,
    actualBoundingBoxDescent: metric.actualBoundingBoxDescent,
    rangeClientRects: [...range.getClientRects()].map((box) => ({ x: box.x, y: box.y, width: box.width, height: box.height })),
  };
}
function notificationAnchorSpecs() {
  const section = document.querySelector('#notifications-title')?.closest('.settings-section');
  const title = section?.querySelector('h3');
  if (!section || !title) throw new Error('Notification section anchor is missing');
  const statusRow = section.querySelector('.push-row') ?? section.querySelector('[role="status"]');
  const specs = [
    { id: 'notification-section-top', selector: '#notifications-title', target: title },
    { id: 'status-row', selector: statusRow?.matches('.push-row') ? '.push-row:first-of-type' : '[role="status"]', target: statusRow },
  ];
  const feedback = section.querySelector('[role="alert"], [role="status"]');
  if (feedback && feedback !== statusRow) {
    specs.push({ id: 'feedback', selector: feedback.matches('[role="alert"]') ? '[role="alert"]' : '[role="status"]', target: feedback });
  }
  const placeList = section.querySelector('.push-places');
  if (placeList) {
    specs.push({ id: 'subscriptions-list', selector: '.push-places', target: placeList });
    const rows = [...placeList.querySelectorAll(':scope > li')];
    if (rows.length) specs.push({ id: 'subscriptions-bottom', selector: '.push-places > li:last-child', target: rows.at(-1) });
  }
  const buttons = [...section.querySelectorAll('.push-row button')];
  const actionButton = buttons.find((button) => labelText(button) === 'Send a test')
    ?? buttons.find((button) => labelText(button) === 'Turn on' || labelText(button) === 'Turn off');
  if (actionButton) {
    specs.push({
      id: 'action-row',
      selector: actionButton.closest('.push-row') === statusRow ? '.push-row:first-of-type' : '.push-row:last-of-type',
      target: actionButton.closest('.push-row'),
      actionText: labelText(actionButton),
    });
  }
  return specs.filter((spec) => !!spec.target).map(({ id, selector, target, actionText }) => ({ id, selector, target, actionText: actionText ?? null }));
}
function captureNotification(focus = null) {
  const dialog = document.querySelector('dialog.modal-dialog.settings');
  const modal = dialog?.querySelector('.modal.settings');
  const header = modal?.querySelector(':scope > header');
  const layout = modal?.querySelector('.settings-layout');
  const nav = modal?.querySelector('.settings-nav');
  const navigationTabs = [...(nav?.querySelectorAll('[role="tab"]') ?? [])].map((tab) => ({
    id: tab.id,
    label: labelText(tab),
    selected: tab.getAttribute('aria-selected') === 'true',
    box: rect(tab),
    memoryBadge: tab.id === 'settings-tab-memory' ? labelText(tab.querySelector('.tab-count')) || null : null,
  }));
  const panelViewport = modal?.querySelector('.settings-panels');
  const panel = document.querySelector('#settings-panel-general');
  const section = document.querySelector('#notifications-title')?.closest('.settings-section');
  const pushRows = [...(section?.querySelectorAll('.push-row') ?? [])].map((row) => ({
    text: labelText(row),
    box: rect(row),
    style: styleData(row),
    children: [...row.children].map((child) => ({ tag: child.tagName.toLowerCase(), text: labelText(child), box: rect(child), style: styleData(child), fontMetrics: fontMetrics(child) })),
  }));
  const places = section?.querySelector('.push-places');
  const placeRows = [...(places?.querySelectorAll(':scope > li') ?? [])].map((row) => ({
    text: labelText(row),
    box: rect(row),
    style: styleData(row),
    name: row.querySelector('strong') ? { text: labelText(row.querySelector('strong')), box: rect(row.querySelector('strong')), style: styleData(row.querySelector('strong')), fontMetrics: fontMetrics(row.querySelector('strong')) } : null,
    details: row.querySelector('small') ? { text: labelText(row.querySelector('small')), box: rect(row.querySelector('small')), style: styleData(row.querySelector('small')), fontMetrics: fontMetrics(row.querySelector('small')) } : null,
    removeButton: (() => { const button = row.querySelector('button'); return button ? { text: labelText(button), box: rect(button), style: styleData(button), disabled: button.disabled } : null; })(),
  }));
  const controls = [...(section?.querySelectorAll('button') ?? [])].map((button) => ({
    text: labelText(button),
    box: rect(button),
    style: styleData(button),
    disabled: button.disabled,
    type: button.type,
  }));
  const alerts = [...(section?.querySelectorAll('[role="alert"],[role="status"]') ?? [])].filter(visible).map((element) => ({ role: element.getAttribute('role'), text: labelText(element), box: rect(element), style: styleData(element), fontMetrics: fontMetrics(element) }));
  const messageElement = section?.querySelector('.push-row > span');
  const title = section?.querySelector('h3');
  const introduction = section?.querySelector('p');
  const content = panelViewport;
  const harness = window.__notificationHarness;
  const activeElement = document.activeElement;
  const closeButton = modal?.querySelector('button[aria-label="Close"]');
  return {
    scenarioId: harness.scenarioId,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    theme: { colorScheme: getComputedStyle(document.documentElement).colorScheme, modalFontFamily: modal ? getComputedStyle(modal).fontFamily : null, textScale: Number(modal?.getAttribute('data-notification-scale') || '1') },
    chrome: { dialogBox: rect(dialog), modalBox: rect(modal), headerBox: rect(header), navigationBox: rect(nav), navigationTabs, layoutBox: rect(layout), panelViewportBox: rect(content), panelScrollTop: content?.scrollTop ?? null },
    sharedChrome: structuredClone(window.__notificationSharedChrome),
    input: {
      mode: 'touch',
      events: structuredClone(harness.touchEvents),
      activeElement: activeElement ? { tag: activeElement.tagName?.toLowerCase() ?? null, id: activeElement.id || null, text: labelText(activeElement) || null, focusVisible: activeElement.matches?.(':focus-visible') ?? false } : null,
      closeButtonFocusVisible: closeButton?.matches(':focus-visible') ?? false,
    },
    focus,
    heading: title ? { text: labelText(title), box: rect(title), style: styleData(title), fontMetrics: fontMetrics(title) } : null,
    introduction: introduction ? { text: labelText(introduction), box: rect(introduction), style: styleData(introduction), fontMetrics: fontMetrics(introduction) } : null,
    notificationMessage: messageElement ? { text: labelText(messageElement), box: rect(messageElement), style: styleData(messageElement), fontMetrics: fontMetrics(messageElement) } : null,
    pushRows,
    placeList: places ? { box: rect(places), style: styleData(places), scrollHeight: places.scrollHeight, rows: placeRows } : null,
    controls,
    alerts,
    browserApis: {
      serviceWorkerPropertyPresent: 'serviceWorker' in navigator,
      pushManagerPropertyPresent: 'PushManager' in window,
      notificationPropertyPresent: 'Notification' in window,
      permission: Notification.permission,
      registrationCalls: harness.registrationCalls,
      registrationReleased: harness.registrationReleased,
      getSubscriptionCalls: harness.getSubscriptionCalls,
      subscriptionPresent: harness.subscriptionPresent,
      requestPermissionCalls: harness.requestPermissionCalls,
      subscribeCalls: harness.subscribeCalls,
      unsubscribeCalls: harness.unsubscribeCalls,
    },
    apiRequests: structuredClone(harness.apiRequests),
    apiResponses: structuredClone(harness.apiResponses),
    unexpectedApiRequests: structuredClone(harness.unexpectedApiRequests),
  };
}
async function focusNotificationAnchor(anchorId) {
  const spec = notificationAnchorSpecs().find((candidate) => candidate.id === anchorId);
  if (!spec) return null;
  const panel = document.querySelector('.settings-panels');
  const section = document.querySelector('#notifications-title')?.closest('.settings-section');
  const before = panel?.scrollTop ?? null;
  const windowScrollBefore = window.scrollY;
  spec.target.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const panelBox = panel?.getBoundingClientRect() ?? null;
  const targetBox = rect(spec.target);
  const firstStatusRow = section?.querySelector('.push-row');
  const feedback = section?.querySelector('[role="alert"], [role="status"]');
  const placeList = section?.querySelector('.push-places');
  const actionButton = [...(section?.querySelectorAll('.push-row button') ?? [])].find((button) => ['Send a test', 'Turn on', 'Turn off'].includes(labelText(button)));
  const currentPanelScrollTop = panel?.scrollTop ?? null;
  const metadata = {
    id: spec.id,
    selector: spec.selector,
    actionText: spec.actionText,
    targetText: labelText(spec.target),
    targetBox,
    panelViewportBox: panelBox ? { x: panelBox.x, y: panelBox.y, right: panelBox.right, bottom: panelBox.bottom, width: panelBox.width, height: panelBox.height } : null,
    panelScrollTopBefore: before,
    panelScrollTopAfter: currentPanelScrollTop,
    panelScrollDelta: before === null || currentPanelScrollTop === null ? null : currentPanelScrollTop - before,
    windowScrollYBefore: windowScrollBefore,
    windowScrollYAfter: window.scrollY,
    targetIntersectsPanelViewport: overlaps(targetBox, panelBox),
    targetFullyWithinPanelViewport: !!targetBox && !!panelBox && targetBox.top >= panelBox.top && targetBox.bottom <= panelBox.bottom,
    targetIntersectsBrowserViewport: !!targetBox && targetBox.bottom > 0 && targetBox.top < innerHeight,
    relatedGeometry: {
      notificationSection: rect(section),
      title: rect(section?.querySelector('h3')),
      introduction: rect(section?.querySelector('p')),
      statusRow: rect(firstStatusRow),
      feedback: rect(feedback),
      subscriptionsList: rect(placeList),
      subscriptionRows: [...(placeList?.querySelectorAll(':scope > li') ?? [])].map(rect),
      actionRow: rect(actionButton?.closest('.push-row')),
      actionButton: rect(actionButton),
    },
  };
  return { anchor: metadata, capture: captureNotification(metadata) };
}
function notificationAnchorIds() {
  return notificationAnchorSpecs().map((spec) => spec.id);
}
`;

let browser;
const errors = [];
let completedScenarioCaptures = 0;
let completedFocusedAnchorCaptures = 0;
const expectedScenarioCaptureCount = selectedWidths.length * fixture.themes.length * fixture.textScales.length * fixture.scenarios.length;
const manifest = {
  fixture: fixture.id,
  webRevision: fixture.webRevision,
  rendererLabel: expected.rendererLabel,
  referenceAuthContext: expected.referenceAuthContext,
  mode: smoke ? 'smoke' : 'full',
  widths: selectedWidths,
  themes: fixture.themes,
  textScales: fixture.textScales,
  scenarios: fixture.scenarios.map((scenario) => scenario.id),
  scenarioCountPerConfiguration: fixture.scenarios.length,
  expectedScenarioCaptureCount,
  completedScenarioCaptureCount: 0,
  deviceScaleFactor: 1,
  textScaleMethod: expected.textScaleMethod,
  focusedCapture: fixture.focusedCapture,
  browserApiAssumptions: fixture.syntheticBrowserPush,
  configurations: [],
};

function errorText(capture) {
  return capture.alerts.find((entry) => entry.role === 'alert')?.text ?? null;
}
function statusText(capture) {
  return capture.alerts.find((entry) => entry.role === 'status')?.text ?? null;
}
function messageText(capture) {
  return capture.notificationMessage?.text ?? statusText(capture);
}

async function tapButton(page, name) {
  const button = page.getByRole('button', { name, exact: true });
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  assert(box, `Touch target is not visible: ${name}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.touchscreen.tap(x, y);
  await page.evaluate((event) => window.__notificationHarness.touchEvents.push(event), {
    kind: 'button-action',
    target: 'button',
    accessibleName: name,
    x,
    y,
  });
}

async function neutralizeFocusWithTouch(page) {
  const heading = page.locator('#notifications-title');
  await heading.scrollIntoViewIfNeeded();
  const box = await heading.boundingBox();
  assert(box, 'Notifications heading must be visible for touch focus neutralization');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.touchscreen.tap(x, y);
  await page.evaluate(({ x, y }) => {
    window.__notificationHarness.touchEvents.push({
      kind: 'focus-neutralization',
      target: '#notifications-title (static heading)',
      x,
      y,
    });
    const panel = document.querySelector('.settings-panels');
    if (panel) panel.scrollTop = 0;
  }, { x, y });
}

try {
  const server = await createServer({
    cacheDir: resolve(outputRoot, 'vite-cache'),
    root: resolve(root, 'apps/web'),
    configFile: resolve(root, 'apps/web/vite.config.ts'),
    server: { host: '127.0.0.1', port: 18932, strictPort: true, fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] } },
    plugins: [{
      name: 'notification-matrix-capture',
      configureServer(vite) {
        vite.middlewares.use('/notification-matrix.html', async (_request, response, next) => {
          try {
            response.setHeader('Content-Type', 'text/html');
            response.end(await vite.transformIndexHtml('/notification-matrix.html', pageHtml));
          } catch (error) {
            next(error);
          }
        });
      },
    }],
  });
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: requireTestBrowserExecutable(), headless: true });
    for (const width of selectedWidths) {
      for (const theme of fixture.themes) {
        for (const textScale of fixture.textScales) {
          const configId = `${width}-${theme}-scale${textScale}`;
          const configDir = resolve(outputRoot, configId);
          await mkdir(configDir, { recursive: true });
          const config = {
            id: configId,
            authContext: expected.referenceAuthContext,
            viewport: { width, height: fixture.height, deviceScaleFactor: 1 },
            theme,
            textScale,
            textScaleMethod: expected.textScaleMethod,
            states: {},
            errors: [],
          };
          const context = await browser.newContext({
            viewport: { width, height: fixture.height },
            deviceScaleFactor: 1,
            isMobile: true,
            hasTouch: true,
            locale: 'en-US',
            colorScheme: theme,
          });
          try {
            for (const scenario of fixture.scenarios) {
              const page = await context.newPage();
              page.setDefaultTimeout(10000);
              const pageErrors = [];
              page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
              page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
              await page.goto(`http://127.0.0.1:18932/notification-matrix.html?notificationCase=${encodeURIComponent(scenario.id)}`);
              try {
                await page.waitForFunction(() => window.__settingsMounted === true);
              } catch (error) {
                const body = await page.locator('body').innerText().catch(() => '<unavailable>');
                throw new Error(`${error.message}; url=${page.url()}; pageErrors=${JSON.stringify(pageErrors)}; body=${JSON.stringify(body)}`);
              }
              await page.evaluate((source) => {
                new Function(source + '\nwindow.__captureNotification = captureNotification; window.__notificationAnchorIds = notificationAnchorIds; window.__focusNotificationAnchor = focusNotificationAnchor;')();
              }, helpers);
              await page.evaluate((scale) => window.__applyNotificationTextScale(scale), textScale);

              if (scenario.id === 'loading') {
                await page.waitForFunction(() => window.__notificationHarness.registrationCalls > 0);
                await page.waitForFunction(() => window.__notificationHarness.apiRequests.some((request) => request.path === '/api/push'));
                await page.getByText('Checking notifications…', { exact: true }).waitFor();
              } else {
                await page.waitForFunction(() => window.__notificationHarness.apiResponses.some((response) => response.path === '/api/push'));
                await page.waitForFunction(() => document.querySelector('#settings-panel-general .push-row') || document.querySelector('#settings-panel-general .push-error'));
              }

              if (scenario.action === 'enable') {
                await tapButton(page, 'Turn on');
                await page.getByText(scenario.expectedMessage, { exact: true }).waitFor();
                await page.waitForFunction(() => window.__notificationHarness.subscriptionPresent && window.__notificationHarness.apiRequests.some((request) => request.path === '/api/push/subscriptions' && request.method === 'POST'));
              } else if (scenario.action === 'test') {
                await tapButton(page, 'Send a test');
                if (scenario.expectedNote) await page.getByRole('status').filter({ hasText: scenario.expectedNote }).waitFor();
                else await page.getByRole('alert').filter({ hasText: scenario.expectedError }).waitFor();
              }

              await neutralizeFocusWithTouch(page);
              await page.evaluate((scale) => window.__applyNotificationTextScale(scale), textScale);
              await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
              const capture = await page.evaluate(() => window.__captureNotification());
              assert.equal(capture.chrome.panelScrollTop, 0, `${configId}/${scenario.id} base capture preserves the initial top scroll position`);
              assert.deepEqual(capture.unexpectedApiRequests, [], `${configId}/${scenario.id} unexpected fixture API routes`);
              if (scenario.expectedMessage) assert.equal(messageText(capture), scenario.expectedMessage, `${configId}/${scenario.id} visible state text`);
              if (scenario.expectedError) assert.equal(errorText(capture), scenario.expectedError, `${configId}/${scenario.id} visible API error`);
              if (scenario.expectedNote) assert.equal(statusText(capture), scenario.expectedNote, `${configId}/${scenario.id} test result`);
              if (scenario.expectedState === 'unsupported') {
                assert.equal(capture.browserApis.serviceWorkerPropertyPresent, false, `${configId} unsupported state hides serviceWorker support`);
              }
              if (scenario.expectedState === 'denied') assert.equal(capture.browserApis.permission, 'denied');
              if (scenario.expectedState === 'on') assert.equal(capture.browserApis.subscriptionPresent, true);
              if (scenario.id === 'on') {
                assert.equal(capture.placeList.rows.length, 3);
                assert(capture.placeList.rows.some((row) => row.name?.text === scenario.expectedCurrentPlace));
              }
              if (scenario.id === 'off-enable-success') {
                const subscriptionPost = capture.apiRequests.find((request) => request.path === '/api/push/subscriptions' && request.method === 'POST');
                assert(subscriptionPost, `${configId} enabling push sends a subscription registration`);
                assert.equal(subscriptionPost.body.kind, 'web');
                assert.equal(subscriptionPost.body.hasP256dh, true);
                assert.equal(subscriptionPost.body.hasAuth, true);
                assert.equal(capture.browserApis.requestPermissionCalls, 1);
              }
              if (scenario.id === 'on-test-success') {
                assert(capture.apiRequests.some((request) => request.path === '/api/push/test' && request.method === 'POST'));
                assert(capture.apiResponses.some((response) => response.path === '/api/push/test' && response.status === 200));
              }
              if (scenario.id === 'on-test-error') {
                assert(capture.apiResponses.some((response) => response.path === '/api/push/test' && response.status === 503));
              }
              if (scenario.id === 'info-forbidden') {
                assert(capture.apiResponses.some((response) => response.path === '/api/push' && response.status === 403 && response.body?.error?.code === 'forbidden'));
              }
              if (scenario.id === 'unsupported') {
                assert(capture.apiRequests.some((request) => request.path === '/api/push' && request.method === 'GET'), 'unsupported browser still fetches the server notification list');
                assert(capture.placeList?.rows.some((row) => row.name?.text === fixture.places.phone.name), 'unsupported browser can still see phone notification places');
              }
              await page.screenshot({ path: resolve(configDir, `${scenario.id}.png`) });
              const focusedAnchors = {};
              const anchorIds = await page.evaluate(() => window.__notificationAnchorIds());
              for (const anchorId of anchorIds) {
                const focused = await page.evaluate((id) => window.__focusNotificationAnchor(id), anchorId);
                assert(focused, `${configId}/${scenario.id}/${anchorId} focused capture target exists`);
                assert(focused.anchor.targetIntersectsPanelViewport, `${configId}/${scenario.id}/${anchorId} target intersects the panel viewport`);
                assert(focused.anchor.targetIntersectsBrowserViewport, `${configId}/${scenario.id}/${anchorId} target is visible in the screenshot viewport`);
                const screenshot = `${scenario.id}--${anchorId}.png`;
                await page.screenshot({ path: resolve(configDir, screenshot) });
                focused.screenshot = screenshot;
                focusedAnchors[anchorId] = focused;
                completedFocusedAnchorCaptures++;
              }
              if (scenario.id === 'loading') await page.evaluate(() => window.__releasePushRegistration?.());
              config.states[scenario.id] = { capture, focusedAnchors, browserErrors: pageErrors };
              assert.deepEqual(pageErrors, [], `${configId}/${scenario.id} page errors`);
              completedScenarioCaptures++;
              await page.close();
            }
          } finally {
            await context.close();
          }
          await writeFile(resolve(configDir, 'capture.json'), JSON.stringify(config, null, 2) + '\n');
          manifest.configurations.push({
            id: configId,
            authContext: config.authContext,
            stateCount: Object.keys(config.states).length,
            focusedAnchorCount: Object.values(config.states).reduce((sum, state) => sum + Object.keys(state.focusedAnchors).length, 0),
            screenshotCount: Object.keys(config.states).length + Object.values(config.states).reduce((sum, state) => sum + Object.keys(state.focusedAnchors).length, 0),
            apiRequestCount: Object.values(config.states).reduce((sum, state) => sum + state.capture.apiRequests.length, 0),
          });
          console.log(`captured ${configId} (${completedScenarioCaptures}/${expectedScenarioCaptureCount} states)`);
        }
      }
    }
    assert.equal(completedScenarioCaptures, expectedScenarioCaptureCount);
    manifest.completedScenarioCaptureCount = completedScenarioCaptures;
    manifest.completedFocusedAnchorCaptureCount = completedFocusedAnchorCaptures;
    await writeFile(resolve(outputRoot, 'run-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`complete: ${completedScenarioCaptures} notification states across ${selectedWidths.length} widths; output ${outputRoot}`);
  } finally {
    await browser?.close();
    await server.close();
  }
} catch (error) {
  errors.push(error.stack || error.message || String(error));
    await writeFile(resolve(outputRoot, 'last-failure.json'), JSON.stringify({ mode: smoke ? 'smoke' : 'full', completedScenarioCaptures, completedFocusedAnchorCaptures, expectedScenarioCaptureCount, errors }, null, 2) + '\n');
  throw error;
}
