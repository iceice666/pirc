import { requireTestBrowserExecutable } from './test_browser.mjs';
// node apps/android/tool/parity/capture_html_interactions_web.mjs
// Capture production Markdown sanitization, native HTML controls, and details behavior.
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const fixturePath = resolve(root, 'fixtures/mobile-parity/html-text-fields.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
execFileSync('git', ['diff', '--exit-code', fixture.webRevision, '--', 'apps/web'], { cwd: root });

const out = resolve(root, 'apps/android/build/parity');
await mkdir(out, { recursive: true });
const server = await createServer({
  cacheDir: resolve(out, 'vite-cache'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18909,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'html-text-fields-parity-fixture',
      configureServer(server) {
        server.middlewares.use('/parity.html', async (_, res, next) => {
          try {
            const html = `<!doctype html><html><head>
              <link rel="icon" href="data:,">
              <meta name="viewport" content="width=device-width,initial-scale=1">
              <style>
                body{overflow:auto!important}
                #fixture{padding:16px;font-family:Arial;font-size:15px;line-height:1.65;--font-mono:Menlo,monospace}
              </style>
            </head><body><main id="fixture" class="markdown"></main>
              <script type="module">
                import '/src/app.css';
                import '/src/markdown.css';
                import { preloadRenderers, renderMarkdown, enhanceMarkdown } from '/src/lib/markdown.ts';

                const fixture = ${fixtureSource};
                const root = document.querySelector('#fixture');
                let enhancer;
                const rect = (element) => {
                  const r = element.getBoundingClientRect();
                  return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left };
                };
                const attrs = (element) => Object.fromEntries(
                  [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
                );
                const style = (element) => {
                  const computed = getComputedStyle(element);
                  return Object.fromEntries([
                    'display', 'position', 'boxSizing', 'width', 'height', 'minWidth', 'maxWidth',
                    'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
                    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
                    'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderRadius',
                    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
                    'color', 'backgroundColor', 'accentColor', 'appearance', 'verticalAlign',
                    'listStyleType', 'whiteSpace', 'overflow', 'visibility', 'contentVisibility', 'pointerEvents',
                  ].map((key) => [key, computed[key]]));
                };
                const normalizedText = (element) => element.textContent.replace(/\\s+/g, ' ').trim();
                const allBySelector = (selector, callback) =>
                  [...root.querySelectorAll(selector)].map((element, index) => callback(element, index));
                const snapshot = (item, phase, consoleErrors) => {
                  const labelsFor = (input) => [...(input.labels ?? [])].map((label) => ({
                    id: label.id || null,
                    text: normalizedText(label),
                  }));
                  const controls = allBySelector('input, textarea', (element, index) => ({
                    index,
                    tag: element.tagName.toLowerCase(),
                    type: element.type,
                    id: element.id || null,
                    name: element.name || null,
                    value: element.value,
                    attributes: attrs(element),
                    ariaAttributes: Object.fromEntries(Object.entries(attrs(element)).filter(([name]) => name.startsWith('aria-'))),
                    labels: labelsFor(element),
                    state: { defaultValue: element.defaultValue, disabled: element.matches(':disabled'), readOnly: element.readOnly, required: element.required, maxLength: element.maxLength, minLength: element.minLength, rows: element.rows, cols: element.cols, valid: element.validity.valid, tooShort: element.validity.tooShort, tooLong: element.validity.tooLong, typeMismatch: element.validity.typeMismatch, valueMissing: element.validity.valueMissing },
                    focused: element === document.activeElement,
                    box: rect(element),
                    rendered: element.checkVisibility(),
                    computed: style(element),
                  }));
                  // Number interactions produce several phases. Keep only the
                  // browser facts the native capture compares so each phase
                  // does not repeat unrelated page CSS/details measurements.
                  if (item.id === 'number') {
                    return {
                      id: item.id,
                      phase,
                      controls: controls.map(({ ariaAttributes, labels, computed, ...control }) => control),
                      consoleErrors,
                    };
                  }
                  const labels = allBySelector('label', (element, index) => ({
                    index,
                    id: element.id || null,
                    htmlFor: element.htmlFor || null,
                    text: normalizedText(element),
                    focused: element === document.activeElement,
                    attributes: attrs(element),
                    ariaAttributes: Object.fromEntries(Object.entries(attrs(element)).filter(([name]) => name.startsWith('aria-'))),
                    associatedControl: element.control ? {
                      id: element.control.id || null,
                      tag: element.control.tagName.toLowerCase(),
                      type: element.control.type || null,
                      name: element.control.name || null,
                    } : null,
                    box: rect(element),
                    computed: style(element),
                  }));
                  const details = allBySelector('details', (element, index) => {
                    const summary = element.querySelector(':scope > summary');
                    const directContent = [...element.children].filter((child) => child.tagName !== 'SUMMARY');
                    return {
                      index,
                      id: element.id || null,
                      name: element.getAttribute('name'),
                      open: element.open,
                      attributes: attrs(element),
                      ariaAttributes: Object.fromEntries(Object.entries(attrs(element)).filter(([name]) => name.startsWith('aria-'))),
                      summary: summary ? {
                        text: normalizedText(summary),
                        focused: summary === document.activeElement,
                        attributes: attrs(summary),
                        box: rect(summary),
                        rendered: summary.checkVisibility(),
                        computed: style(summary),
                      } : null,
                      box: rect(element),
                      rendered: element.checkVisibility(),
                      content: directContent.map((child) => ({
                        tag: child.tagName.toLowerCase(),
                        text: normalizedText(child),
                        box: rect(child),
                        rendered: child.checkVisibility(),
                        computed: style(child),
                      })),
                      computed: style(element),
                    };
                  });
                  const rootStyle = style(root);
                  const cssTokens = Object.fromEntries(
                    ['--bg', '--ink', '--muted', '--accent', '--line-dark']
                      .map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()]),
                  );
                  return {
                    id: item.id,
                    phase,
                    sanitizedDOM: root.innerHTML,
                    root: {
                      box: rect(root),
                      scrollWidth: root.scrollWidth,
                      scrollHeight: root.scrollHeight,
                      computed: rootStyle,
                    },
                    cssTokens,
                    activeElement: document.activeElement && document.activeElement !== document.body ? {
                      tag: document.activeElement.tagName.toLowerCase(),
                      id: document.activeElement.id || null,
                      type: document.activeElement.type || null,
                      name: document.activeElement.name || null,
                      text: normalizedText(document.activeElement),
                    } : null,
                    controls,
                    labels,
                    details,
                    consoleErrors,
                  };
                };

                window.captureReady = false;
                window.renderInteractionCase = async (id) => {
                  const item = fixture.cases.find((candidate) => candidate.id === id);
                  if (!item) throw new Error('Unknown interaction fixture case: ' + id);
                  const html = renderMarkdown(item.source);
                  root.innerHTML = html;
                  if (!enhancer) enhancer = enhanceMarkdown(root, { html, ready: true });
                  else enhancer.update({ html, ready: true });
                  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                  return snapshot(item, 'initial', []);
                };
                window.captureInteractionSnapshot = (id, phase) => {
                  const item = fixture.cases.find((candidate) => candidate.id === id);
                  if (!item) throw new Error('Unknown interaction fixture case: ' + id);
                  return snapshot(item, phase, []);
                };
                window.replaceInteractionMarkup = async (id, phase, source) => {
                  const item = fixture.cases.find((candidate) => candidate.id === id);
                  if (!item) throw new Error('Unknown interaction fixture case: ' + id);
                  const html = renderMarkdown(source ?? item.source);
                  root.innerHTML = html;
                  if (!enhancer) enhancer = enhanceMarkdown(root, { html, ready: true });
                  else enhancer.update({ html, ready: true });
                  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                  return snapshot(item, phase, []);
                };
                await preloadRenderers();
                window.destroyMarkdownEnhancer = () => enhancer?.destroy();
                window.fixtureReady = true;
              </script>
            </body></html>`;
            res.setHeader('Content-Type', 'text/html');
            res.end(await server.transformIndexHtml('/parity.html', html));
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
  const expectedByTheme = {};
  for (const colorScheme of ['light', 'dark']) {
    const widthResults = [];
    for (const width of fixture.widths) {
      const page = await browser.newPage({
        viewport: { width, height: fixture.height },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
        locale: 'en-US',
        colorScheme,
      });
      const pageErrors = [];
      const consoleErrors = [];
      const badResponses = [];
      page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('response', (response) => {
        if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
      });
      await page.goto('http://127.0.0.1:18909/parity.html');
      await page.waitForFunction(() => window.fixtureReady);
      // Use Chromium's accessibility tree, not a hand-written approximation
      // of accessible-name and description precedence.
      const cdp = await page.context().newCDPSession(page);
      const recordAccessibility = async (result) => {
        const { root: document } = await cdp.send('DOM.getDocument');
        const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
          nodeId: document.nodeId,
          selector: '#fixture input, #fixture textarea',
        });
        if (nodeIds.length !== result.controls.length) throw new Error('AX control count differs');
        for (let index = 0; index < nodeIds.length; index++) {
          const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
            nodeId: nodeIds[index],
            fetchRelatives: false,
          });
          const control = nodes[0];
          result.controls[index].accessibleName = control?.name?.value ?? '';
          result.controls[index].accessibleDescription = control?.description?.value ?? '';
        }
      };
      const caseResults = [];
      for (const item of fixture.cases) {
        const observations = [];
        let result = await page.evaluate((id) => window.renderInteractionCase(id), item.id);
        result.consoleErrors = consoleErrors.slice();
        await recordAccessibility(result);
        observations.push(result);
        await page.screenshot({
          path: resolve(out, `html-text-fields-${item.id}-${width}-${colorScheme}-initial.png`),
          fullPage: true,
        });
        for (const action of item.actions ?? []) {
          if (action.mode === 'replace-markdown') {
            result = await page.evaluate(
              ({ id, phase, source }) => window.replaceInteractionMarkup(id, phase, source),
              { id: item.id, phase: action.id, source: action.source },
            );
          } else {
            const locator = page.locator(action.selector);
            if (action.mode === 'fill') {
              await locator.fill(action.value);
            } else if (action.mode === 'insert') {
              await locator.focus();
              await locator.evaluate(
                (element, action) => element.setSelectionRange(action.start, action.end),
                action,
              );
              await page.keyboard.insertText(action.value);
            } else if (action.mode === 'dom-click') {
              await locator.evaluate((element) => element.click());
            } else if (action.mode === 'pointer-click') {
              const box = await locator.boundingBox();
              if (!box)
                throw new Error(`No visible box for interaction target: ${action.selector}`);
              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            } else if (action.mode === 'key') {
              await locator.focus();
              await page.keyboard.press(action.key);
            } else {
              await locator.click({ timeout: 5000 });
            }
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
            result = await page.evaluate(
              ({ id, phase }) => window.captureInteractionSnapshot(id, phase),
              { id: item.id, phase: action.id },
            );
          }
          result.consoleErrors = consoleErrors.slice();
          await recordAccessibility(result);
          observations.push(result);
          await page.screenshot({
            path: resolve(
              out,
              `html-text-fields-${item.id}-${width}-${colorScheme}-${action.id}.png`,
            ),
            fullPage: true,
          });
        }
        caseResults.push({ id: item.id, observations });
      }
      if (badResponses.length) throw new Error(badResponses.join('\\n'));
      if (pageErrors.length) throw new Error(pageErrors.join('\\n'));
      widthResults.push({ width, cases: caseResults });
      await page.evaluate(() => window.destroyMarkdownEnhancer?.());
      await page.close();
    }
    const resultDocument = {
      fixture: fixture.id,
      reference: fixture.webRevision,
      theme: colorScheme,
      widths: widthResults,
    };
    expectedByTheme[colorScheme] = resultDocument;
    const json = JSON.stringify(resultDocument, null, 2) + '\n';
    await writeFile(resolve(out, `html-text-fields-web-${colorScheme}.json`), json);
  }
  const merged = {
    fixture: fixture.id,
    reference: fixture.webRevision,
    browserVersion: await browser.version(),
    themes: expectedByTheme,
  };
  await writeFile(
    resolve(out, 'html-text-fields-web.json'),
    JSON.stringify(merged, null, 2) + '\n',
  );
  await writeFile(
    resolve(root, 'fixtures/mobile-parity/html-text-fields-expected.json'),
    JSON.stringify(merged, null, 2) + '\n',
  );
  console.log(out);
} finally {
  await browser?.close();
  await server.close();
}
