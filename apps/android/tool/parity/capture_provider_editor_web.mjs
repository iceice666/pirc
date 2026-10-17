import { requireTestBrowserExecutable } from './test_browser.mjs';
// node apps/android/tool/parity/capture_provider_editor_web.mjs
// Captures ProviderEditor inside the pinned SettingsDialog/Modal at mobile and
// desktop widths, in both themes and with model details closed/open.
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const standalone = process.argv.includes('--standalone');
const textScale = Number(
  process.argv.find((arg) => arg.startsWith('--text-scale='))?.split('=')[1] ?? 1,
);
assert.ok(Number.isFinite(textScale) && textScale > 0);
const scaleSuffix = textScale === 1 ? '' : '-scale' + textScale;
const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const fixture = JSON.parse(
  await readFile(resolve(root, 'fixtures/mobile-parity/provider-editor.json'), 'utf8'),
);

assert.equal(fixture.id, 'provider-editor');
assert.equal(fixture.webRevision, 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c');
assert.deepEqual(fixture.widths, [390, 768]);
assert.equal(fixture.height, 1200);
assert.equal(fixture.deviceScaleFactor, 1);
assert.equal(fixture.fontFamily, 'Arial');
assert.deepEqual(fixture.phases, ['collapsed', 'expanded', 'expanded-bottom']);
assert.deepEqual(fixture.presets, []);
assert.equal(fixture.settings.providers[0].id, 'custom');
assert.equal(fixture.settings.providers[0].models[0].id, 'local-model');
execFileSync('git', ['diff', '--exit-code', fixture.webRevision, '--', 'apps/web'], { cwd: root });

const out = resolve(root, 'apps/android/build/parity');
await mkdir(out, { recursive: true });
const server = await createServer({
  cacheDir: resolve(out, 'vite-cache-provider-editor'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18913,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'provider-editor-parity-fixture',
      configureServer(server) {
        server.middlewares.use('/provider-editor-parity.html', async (_, res, next) => {
          const module = [
            "import '/src/app.css';",
            "import { mount } from 'svelte';",
            "import SettingsDialog from '/src/lib/components/dialogs/SettingsDialog.svelte';",
            "document.documentElement.style.setProperty('font-family', 'Arial, sans-serif', 'important');",
            "mount(SettingsDialog, { target: document.querySelector('#app'), props: { open: true, tab: 'models', showSettled: false, onresetlayout: () => {} } });",
            'window.captureReady = true;',
          ].join('\n');
          const html =
            '<!doctype html><html><head>' +
            '<link rel="icon" href="data:,">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<style>html,body,#app{height:100%;margin:0}body{overflow:hidden!important}#app{font-family:Arial,sans-serif!important}</style>' +
            '</head><body><div id="app"></div><script type="module">' +
            module +
            '</script></body></html>';
          try {
            res.setHeader('Content-Type', 'text/html');
            res.end(await server.transformIndexHtml('/provider-editor-parity.html', html));
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});

const styleKeys = [
  'display',
  'position',
  'boxSizing',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderTopStyle',
  'borderTopColor',
  'borderRightWidth',
  'borderBottomWidth',
  'borderBottomColor',
  'borderLeftWidth',
  'borderRadius',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'color',
  'backgroundColor',
  'accentColor',
  'appearance',
  'verticalAlign',
  'whiteSpace',
  'textAlign',
  'outlineStyle',
  'outlineColor',
  'boxShadow',
  'gap',
  'alignItems',
  'justifyContent',
  'overflow',
  'overflowY',
];

const capture = (styleKeys) => {
  const rect = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    const n = (value) => Math.round(value * 1000) / 1000;
    return {
      x: n(r.x),
      y: n(r.y),
      top: n(r.top),
      right: n(r.right),
      bottom: n(r.bottom),
      left: n(r.left),
      width: n(r.width),
      height: n(r.height),
    };
  };
  const text = (element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const computed = (element) => {
    if (!element) return null;
    const s = getComputedStyle(element);
    return Object.fromEntries(styleKeys.map((key) => [key, s[key]]));
  };
  const attributes = (element) =>
    Object.fromEntries(
      [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
    );
  const element = (node) => {
    if (!node) return null;
    const box = rect(node);
    return {
      tag: node.tagName.toLowerCase(),
      id: node.id || null,
      className: typeof node.className === 'string' ? node.className : null,
      text: text(node),
      attributes: attributes(node),
      viewportRect: box,
      documentRect: box
        ? {
            ...box,
            x: box.x + window.scrollX,
            y: box.y + window.scrollY,
            top: box.top + window.scrollY,
            bottom: box.bottom + window.scrollY,
          }
        : null,
      rendered: node.checkVisibility(),
      computed: computed(node),
    };
  };
  const dialog = document.querySelector('dialog.modal-dialog.settings');
  const surface = dialog?.querySelector('.modal.settings');
  const layout = dialog?.querySelector('.settings-layout');
  const panel = dialog?.querySelector('.settings-panels');
  const editor = dialog?.querySelector('form.backend-card');
  if (!dialog || !surface || !layout || !panel || !editor) {
    throw new Error('The SettingsDialog ProviderEditor fixture is not mounted.');
  }
  const labels = [...editor.querySelectorAll('label')].map((label, index) => ({
    index,
    ...element(label),
    spans: [...label.querySelectorAll(':scope > span')].map(element),
    controls: [...label.querySelectorAll('input, select, textarea')].map((control) => ({
      tag: control.tagName.toLowerCase(),
      type: control.type || null,
      id: control.id || null,
      box: rect(control),
    })),
  }));
  const controls = [...editor.querySelectorAll('input, select, textarea')].map(
    (control, index) => ({
      index,
      ...element(control),
      type: control.type || null,
      name: control.name || null,
      value: control.value,
      checked: control.type === 'checkbox' || control.type === 'radio' ? control.checked : null,
      selectedText:
        control.tagName === 'SELECT'
          ? [...control.selectedOptions].map((option) => text(option)).join(', ')
          : null,
      disabled: Boolean(control.disabled),
      required: Boolean(control.required),
      labels: [...(control.labels ?? [])].map((label) => text(label)),
    }),
  );
  const details = editor.querySelector('details');
  const summary = details?.querySelector(':scope > summary');
  const fieldset = details?.querySelector('fieldset');
  const modelHead = editor.querySelector('.model-head');
  const manual = editor.querySelector('.backend-actions.manual');
  const actionGroups = [...editor.querySelectorAll(':scope > .backend-actions')].map(
    (group, index) => ({
      index,
      ...element(group),
      children: [...group.children].map(element),
    }),
  );
  const buttons = [...editor.querySelectorAll('button')].map((button, index) => ({
    index,
    ...element(button),
    disabled: Boolean(button.disabled),
    type: button.type,
  }));
  const tokenNames = [
    '--bg',
    '--bg-layer',
    '--bg-subtle',
    '--ink',
    '--text-2',
    '--muted',
    '--line',
    '--line-dark',
    '--accent',
    '--success',
    '--danger',
    '--radius-md',
  ];
  return {
    viewport: {
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio,
      fontFamily: getComputedStyle(document.documentElement).fontFamily,
      windowScrollX: window.scrollX,
      windowScrollY: window.scrollY,
    },
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    cssTokens: Object.fromEntries(
      tokenNames.map((name) => [
        name,
        getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
      ]),
    ),
    dialog: element(dialog),
    modalSurface: element(surface),
    settingsLayout: element(layout),
    settingsNavigation: element(dialog.querySelector('.settings-nav')),
    settingsPanel: {
      ...element(panel),
      scrollTop: panel.scrollTop,
      scrollHeight: panel.scrollHeight,
      clientHeight: panel.clientHeight,
      overflowY: getComputedStyle(panel).overflowY,
    },
    providerSection: element(dialog.querySelector('.settings-section.backend-settings')),
    editor: {
      ...element(editor),
      title: element(editor.querySelector(':scope > h4')),
      modelsHeading: element(editor.querySelector(':scope > h5')),
      labels,
      controls,
      details: details
        ? {
            ...element(details),
            open: details.open,
            summary: element(summary),
            fieldset: fieldset
              ? {
                  ...element(fieldset),
                  labels: [...fieldset.querySelectorAll(':scope > label')].map((label) => ({
                    ...element(label),
                    textLine: element(label.querySelector(':scope > span')),
                  })),
                }
              : null,
          }
        : null,
      modelHead: modelHead
        ? {
            ...element(modelHead),
            name: element(modelHead.querySelector('strong')),
            detail: element(modelHead.querySelector('small')),
          }
        : null,
      manual: manual
        ? {
            ...element(manual),
            label: element(manual.querySelector('label')),
            labelText: element(manual.querySelector('label > span')),
            input: element(manual.querySelector('input')),
            button: element(manual.querySelector('button')),
          }
        : null,
      actionGroups,
      buttons,
    },
  };
};

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: requireTestBrowserExecutable(),
    headless: true,
  });
  const results = [];
  for (const colorScheme of fixture.themes) {
    for (const width of fixture.widths) {
      const context = await browser.newContext({
        viewport: { width, height: fixture.height },
        deviceScaleFactor: fixture.deviceScaleFactor,
        isMobile: true,
        hasTouch: true,
        locale: 'en-US',
        colorScheme,
      });
      const page = await context.newPage();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const pageErrors = [];
      const consoleErrors = [];
      const badResponses = [];
      const apiCalls = [];
      page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('response', (response) => {
        if (response.status() >= 400) {
          badResponses.push(response.status() + ' ' + response.url());
        }
      });
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        apiCalls.push({ method: request.method(), path: pathname });
        if (request.method() !== 'GET') {
          await route.continue();
          return;
        }
        if (pathname === '/api/providers') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(fixture.settings),
          });
          return;
        }
        if (pathname === '/api/providers/presets') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ presets: fixture.presets }),
          });
          return;
        }
        const harmlessFixtures = {
          '/api/memory': {
            usage: {
              user: { used: 0, max: 1000 },
              note: { used: 0, max: 1000 },
            },
            user: [],
            notes: [],
            removed: [],
            proposals: [],
            sessions: {},
          },
          '/api/push': { publicKey: '', subscriptions: [] },
          '/api/devices': { devices: [] },
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(harmlessFixtures[pathname] ?? {}),
        });
      });
      try {
        await page.goto('http://127.0.0.1:18913/provider-editor-parity.html', {
          waitUntil: 'networkidle',
        });
        await page.waitForFunction(() => window.captureReady);
        await page.getByRole('button', { name: 'Edit custom' }).waitFor({ state: 'visible' });
        await page.getByRole('button', { name: 'Edit custom' }).click();
        await page.locator('form.backend-card input[type="password"]').waitFor({
          state: 'visible',
        });
        await page.waitForFunction(
          () => document.querySelector('form.backend-card details > summary') !== null,
        );
        assert.equal(
          apiCalls.some((call) => call.path === '/api/providers'),
          true,
          'SettingsDialog loads the backend snapshot',
        );
        assert.equal(
          apiCalls.some((call) => call.path === '/api/providers/presets'),
          true,
          'ProviderEditor loads its empty preset list',
        );
        if (textScale !== 1) {
          // Controlled text-only scaling: snapshot computed sizes before changing
          // any ancestor so inherited fonts are not multiplied more than once.
          await page.evaluate((scale) => {
            const entries = [...document.querySelectorAll('dialog, dialog *')]
              .filter((node) => node instanceof HTMLElement)
              .map((node) => [node, parseFloat(getComputedStyle(node).fontSize)]);
            for (const [node, size] of entries) {
              node.style.setProperty('font-size', size * scale + 'px', 'important');
            }
          }, textScale);
        }
        if (standalone) {
          // Preserve the real scoped Modal/SettingsDialog styles and mounted
          // ProviderEditor; flatten only its surrounding layout for the native
          // 24px scrolling scaffold comparison.
          await page.evaluate(() => {
            // Reinsert the same node to leave the browser modal top layer,
            // retaining its mounted component, listeners, and scoped styles.
            const dialog = document.querySelector('dialog.modal-dialog.settings');
            dialog.remove();
            document.querySelector('#app').append(dialog);
          });
          await page.addStyleTag({
            content: `
            html, body, #app { height:auto!important; min-height:100%; }
            body { overflow:auto!important; background:var(--bg)!important; }
            dialog.modal-dialog.settings {
              position:static!important; inset:auto!important;
              width:100%!important; max-width:none!important; height:auto!important;
              max-height:none!important; margin:0!important; padding:24px!important;
              overflow:visible!important; background:var(--bg)!important;
            }
            dialog::backdrop { background:transparent!important; }
            .modal.settings, .settings-layout, .settings-panels,
            .settings-section.backend-settings {
              display:block!important; width:100%!important; max-width:none!important;
              height:auto!important; min-height:0!important; max-height:none!important;
              padding:0!important; margin:0!important; border:0!important;
              overflow:visible!important; box-shadow:none!important; border-radius:0!important;
            }
            .modal.settings > header, .settings-nav,
            .backend-settings > :not(form.backend-card) { display:none!important; }
          `,
          });
        }
        const detail = page.locator('form.backend-card details');
        const summary = detail.locator(':scope > summary');
        const panel = page.locator('.settings-panels');
        for (const phase of fixture.phases) {
          const expanded = phase !== 'collapsed';
          const currentlyOpen = await detail.evaluate((node) => node.open);
          if (currentlyOpen !== expanded) await summary.click();
          if (standalone) {
            await page.evaluate((bottom) => {
              const editor = document.querySelector('form.backend-card');
              document.body.style.height = editor.getBoundingClientRect().height + 72 + 'px';
              window.scrollTo(0, bottom ? document.body.scrollHeight : 0);
            }, phase === 'expanded-bottom');
          } else {
            await panel.evaluate((node, bottom) => {
              node.scrollTop = bottom ? node.scrollHeight : 0;
            }, phase === 'expanded-bottom');
          }
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          // Avoid an incidental mouse hover after scrolling a touch fixture.
          await page.mouse.move(0, 0);
          const geometry = await page.evaluate(capture, styleKeys);
          geometry.phase = phase;
          geometry.textScale = textScale;
          geometry.wrapper = standalone ? 'standalone' : 'dialog';
          geometry.viewport.width = width;
          geometry.viewport.height = fixture.height;
          geometry.pageErrors = pageErrors.slice();
          geometry.consoleErrors = consoleErrors.slice();
          geometry.badResponses = badResponses.slice();
          geometry.apiCalls = apiCalls.slice();
          const screenshot =
            'provider-editor-web-' +
            (standalone ? 'standalone-' : '') +
            width +
            '-' +
            colorScheme +
            '-' +
            phase +
            scaleSuffix +
            '.png';
          geometry.screenshot = screenshot;
          results.push(geometry);
          await page.screenshot({
            path: resolve(out, screenshot),
            fullPage: false,
            animations: 'disabled',
          });
        }
        if (badResponses.length) throw new Error(badResponses.join('\n'));
        if (pageErrors.length) throw new Error(pageErrors.join('\n'));
        if (consoleErrors.length) throw new Error(consoleErrors.join('\n'));
      } finally {
        await context.close();
      }
    }
  }
  const resultDocument = {
    fixture: fixture.id,
    webRevision: fixture.webRevision,
    viewport: {
      widths: fixture.widths,
      height: fixture.height,
      deviceScaleFactor: fixture.deviceScaleFactor,
      fontFamily: fixture.fontFamily,
    },
    themes: fixture.themes,
    phases: fixture.phases,
    runtime: {
      settings: 'GET /api/providers returns fixture.settings',
      presets: 'GET /api/providers/presets returns an empty preset list',
      'all other provider requests': 'not used',
    },
    results,
  };
  await writeFile(
    resolve(
      out,
      (standalone ? 'provider-editor-web-standalone' : 'provider-editor-web') +
        scaleSuffix +
        '.json',
    ),
    JSON.stringify(resultDocument, null, 2) + '\n',
  );
  console.log(
    'Captured ' + results.length + ' ProviderEditor screenshots and geometry records at ' + out,
  );
} finally {
  await browser?.close();
  await server.close();
}
