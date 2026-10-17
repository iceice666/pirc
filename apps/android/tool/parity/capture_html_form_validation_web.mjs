import { requireTestBrowserExecutable } from './test_browser.mjs';
// Run from repository root:
// node apps/android/tool/parity/capture_html_form_validation_web.mjs
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const fixturePath = resolve(root, 'fixtures/mobile-parity/html-form-validation.json');
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
    port: 18917,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [
    {
      name: 'html-form-validation-parity-fixture',
      configureServer(server) {
        server.middlewares.use('/form-validation.html', async (_, res, next) => {
          try {
            const html = `<!doctype html><html><head>
              <link rel="icon" href="data:,">
              <meta name="viewport" content="width=device-width,initial-scale=1">
            </head><body><main id="fixture"></main>
              <script type="module">
                import { renderMarkdown } from '/src/lib/markdown.ts';
                const fixture = __FIXTURE_SOURCE__;
                const root = document.querySelector('#fixture');
                root.innerHTML = renderMarkdown(fixture.source);
                const validityFlags = [
                  'badInput', 'customError', 'patternMismatch', 'rangeOverflow',
                  'rangeUnderflow', 'stepMismatch', 'tooLong', 'tooShort',
                  'typeMismatch', 'valueMissing', 'valid',
                ];
                const one = (element) => ({
                  id: element.id,
                  tag: element.localName,
                  type: element.type || null,
                  value: element.value,
                  name: element.name || null,
                  formOwner: element.form?.id || null,
                  checked: 'checked' in element ? element.checked : null,
                  required: element.required,
                  disabledAttribute: element.hasAttribute('disabled'),
                  disabledByBrowser: element.matches(':disabled'),
                  readOnly: 'readOnly' in element ? element.readOnly : false,
                  multiple: 'multiple' in element ? element.multiple : false,
                  minLength: 'minLength' in element ? element.minLength : null,
                  maxLength: 'maxLength' in element ? element.maxLength : null,
                  size: element.localName === 'select' ? (element.size > 0 ? element.size : 1) : null,
                  sizeProperty: element.localName === 'select' ? element.size : null,
                  options: element.localName === 'select' ? [...element.options].map((option) => ({ value: option.value, selected: option.selected, disabled: option.matches(':disabled'), directChild: option.parentElement === element })) : null,
                  min: element.getAttribute('min'),
                  max: element.getAttribute('max'),
                  step: element.getAttribute('step'),
                  pattern: element.getAttribute('pattern'),
                  attributes: Object.fromEntries([...element.attributes].map(({ name, value }) => [name, value])),
                  willValidate: element.willValidate,
                  validity: (() => {
                    const values = {};
                    for (const flag of validityFlags) {
                      try {
                        values[flag] = element.validity[flag];
                      } catch (error) {
                        values[flag] = null;
                        values[flag + 'Error'] = error.message;
                      }
                    }
                    return values;
                  })(),
                });
                window.captureValidationSnapshot = () => ({
                  sanitizedHtml: root.innerHTML,
                  fields: [...root.querySelectorAll('input,textarea,select')].map(one),
                });
                window.captureValidationField = (id) => {
                  const element = root.querySelector('#' + CSS.escape(id));
                  return element ? one(element) : null;
                };
                window.fixtureReady = true;
              </script>
            </body></html>`.replace('__FIXTURE_SOURCE__', fixtureSource);
            res.setHeader('Content-Type', 'text/html');
            res.end(await server.transformIndexHtml('/form-validation.html', html));
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
  const browserVersion = await browser.version();
  if (!browserVersion.startsWith('154.')) throw new Error('Expected Chromium 154, got ' + browserVersion);
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const pageErrors = [];
  const consoleErrors = [];
  const badResponses = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) badResponses.push(response.status() + ' ' + response.url());
  });
  await page.goto('http://127.0.0.1:18917/form-validation.html');
  await page.waitForFunction(() => window.fixtureReady);
  const initial = await page.evaluate(() => window.captureValidationSnapshot());
  const actions = [];
  for (const action of fixture.actions) {
    await page.locator(action.selector).fill(action.value);
    actions.push({
      id: action.id,
      fieldId: action.fieldId,
      field: await page.evaluate((id) => window.captureValidationField(id), action.fieldId),
    });
  }
  if (badResponses.length) throw new Error(badResponses.join('\n'));
  if (pageErrors.length) throw new Error(pageErrors.join('\n'));
  const invalidPatternValues = ['[', '[A-Z0-9-]+'];
  const unexpectedConsoleErrors = consoleErrors.filter((message) =>
    !invalidPatternValues.some((pattern) =>
      message.startsWith(`Pattern attribute value ${pattern} is not a valid regular expression`),
    ),
  );
  if (unexpectedConsoleErrors.length) throw new Error(unexpectedConsoleErrors.join('\n'));
  const expected = {
    fixture: fixture.id,
    reference: fixture.webRevision,
    browserVersion,
    sanitizer: 'apps/web/src/lib/markdown.ts renderMarkdown()',
    consoleErrors,
    initial,
    actions,
  };
  const target = resolve(root, 'fixtures/mobile-parity/html-form-validation-expected.json');
  await writeFile(target, JSON.stringify(expected, null, 2) + '\n');
  console.log(target);
} finally {
  await browser?.close();
  await server.close();
}
