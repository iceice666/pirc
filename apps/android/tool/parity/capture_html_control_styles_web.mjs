import { requireTestBrowserExecutable } from './test_browser.mjs';
// Run from repository root:
// node apps/android/tool/parity/capture_html_control_styles_web.mjs
// Measures real Chrome control CSS and interaction state after a form made by
// the pinned production Markdown renderer navigates to a local raw HTML page.
import assert from 'node:assert/strict';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import {
  mkdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const pinnedRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/html-control-styles.json');
const expectedPath = resolve(root, 'fixtures/mobile-parity/html-control-styles-expected.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixture.webRevision, pinnedRevision);
assert(!fixture.responseHtml.toLowerCase().includes('<script'), 'raw HTML response must not contain scripts');
assert.equal(Object.keys(fixture.snapshotControls).length, 14, 'fixture must keep fourteen independent control cases');
execFileSync('git', ['diff', '--exit-code', pinnedRevision, '--', 'apps/web'], { cwd: root });

const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const origin = 'http://127.0.0.1:18926';
const outputDir = resolve('/private/tmp', 'pirc-html-control-styles-parity');
const screenshotDir = resolve(root, 'apps/android/build/parity');
const serverRequests = [];
const serverResponses = [];
const submittedRequests = [];
const externalRequests = [];
const browserErrors = [];

await mkdir(outputDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });

const harnessHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Markdown control style harness</title></head><body><main id="fixture"></main><script type="module">
import { renderMarkdown } from '/src/lib/markdown.ts';
const fixture = ${fixtureSource};
const root = document.querySelector('#fixture');
root.innerHTML = renderMarkdown(fixture.markdownForm);
const form = root.querySelector('#markdown-controls-form');
window.markdownFormSnapshot = form ? {
  action: form.action,
  method: form.method,
  target: form.target,
  html: root.innerHTML,
  submitter: form.querySelector('#markdown-controls-submit')?.outerHTML || null,
  onsubmit: form.getAttribute('onsubmit'),
} : null;
window.fixtureReady = true;
</script></body></html>`;

const server = await createServer({
  cacheDir: resolve(outputDir, 'vite-cache'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18926,
    strictPort: true,
    hmr: false,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [{
    name: 'html-control-styles-parity',
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const rawUrl = request.url || '/';
        const pathname = rawUrl.split(/[?#]/, 1)[0];
        if (pathname === '/favicon.ico') {
          response.statusCode = 204;
          response.end();
          return;
        }
        if (pathname === '/controls-harness.html') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(await vite.transformIndexHtml('/controls-harness.html', harnessHtml));
          return;
        }
        if (pathname === fixture.responsePath) {
          serverRequests.push({ method: request.method, rawUrl, kind: 'raw-document' });
          serverResponses.push({ method: request.method, rawUrl, status: 200, kind: 'raw-document' });
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(fixture.responseHtml);
          return;
        }
        if (pathname === fixture.submitPath) {
          const chunks = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const bytes = Buffer.concat(chunks);
          const url = new URL(rawUrl, origin);
          const bodyText = bytes.toString('utf8');
          const requestRecord = {
            method: request.method,
            pathname: url.pathname,
            rawQuery: url.search,
            contentType: request.headers['content-type'] || null,
            bodyByteLength: bytes.length,
            bodyUtf8: bodyText,
            bodyHex: bytes.toString('hex'),
            bodyBase64: bytes.toString('base64'),
            decodedEntries: [...new URLSearchParams(bodyText).entries()],
          };
          submittedRequests.push(requestRecord);
          serverRequests.push({ method: request.method, rawUrl, kind: 'form-submit' });
          serverResponses.push({ method: request.method, rawUrl, status: 200, kind: 'form-submit' });
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local submit received</title></head><body><p>Submitted to the local fixture endpoint.</p></body></html>');
          return;
        }
        if (pathname.startsWith('/raw/controls/')) {
          serverRequests.push({ method: request.method, rawUrl, kind: 'unexpected-local-resource' });
          serverResponses.push({ method: request.method, rawUrl, status: 404, kind: 'unexpected-local-resource' });
          response.statusCode = 404;
          response.setHeader('Content-Type', 'text/plain; charset=utf-8');
          response.end('Unexpected local control fixture resource');
          return;
        }
        next();
      });
    },
  }],
});

function attributesOf(element) {
  return Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value]));
}

function captureControls(page) {
  return page.evaluate(({ selectors, styleProperties }) => {
    const controls = {};
    for (const [name, selector] of Object.entries(selectors)) {
      const element = document.querySelector(selector);
      if (!element) {
        controls[name] = null;
        continue;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      let selection = null;
      if ('selectionStart' in element) {
        try {
          selection = {
            supported: true,
            start: element.selectionStart,
            end: element.selectionEnd,
            direction: element.selectionDirection,
          };
        } catch (error) {
          selection = { supported: false, reason: `${error.name}: ${error.message}` };
        }
      } else {
        selection = { supported: false, reason: 'This control type has no text selection range.' };
      }
      const validityFlags = {};
      if (element.validity) {
        for (const flag of [
          'badInput', 'customError', 'patternMismatch', 'rangeOverflow',
          'rangeUnderflow', 'stepMismatch', 'tooLong', 'tooShort',
          'typeMismatch', 'valueMissing', 'valid',
        ]) validityFlags[flag] = element.validity[flag];
      }
      controls[name] = {
        id: element.id || null,
        tag: element.localName,
        type: element.type || null,
        name: element.name || null,
        attributes: Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value])),
        value: 'value' in element ? element.value : null,
        valueAttribute: element.getAttribute('value'),
        checked: 'checked' in element ? element.checked : null,
        selectedIndex: element.localName === 'select' ? element.selectedIndex : null,
        selectedValues: element.localName === 'select' ? [...element.selectedOptions].map(option => option.value) : null,
        options: element.localName === 'select' ? [...element.options].map(option => ({
          value: option.value,
          text: option.text,
          selected: option.selected,
          disabled: option.disabled,
        })) : null,
        disabled: element.matches(':disabled'),
        readOnly: !!element.readOnly,
        required: !!element.required,
        focused: element === document.activeElement,
        selection,
        validity: element.validity ? {
          willValidate: element.willValidate,
          validationMessage: element.validationMessage,
          flags: validityFlags,
        } : null,
        formId: element.form?.id || null,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        computed: Object.fromEntries(styleProperties.map(property => [property, style.getPropertyValue(property).trim()])),
      };
    }
    return {
      controls,
      activeElement: document.activeElement?.id || document.activeElement?.localName || null,
      activeElementTag: document.activeElement?.localName || null,
    };
  }, { selectors: fixture.snapshotControls, styleProperties: fixture.styleProperties });
}

function captureInteractionState(page) {
  return page.evaluate(selectors => {
    const controls = {};
    for (const [name, selector] of Object.entries(selectors)) {
      const element = document.querySelector(selector);
      if (!element) {
        controls[name] = null;
        continue;
      }
      let selection = null;
      if ('selectionStart' in element) {
        try {
          selection = {
            supported: true,
            start: element.selectionStart,
            end: element.selectionEnd,
            direction: element.selectionDirection,
          };
        } catch (error) {
          selection = { supported: false, reason: `${error.name}: ${error.message}` };
        }
      } else {
        selection = { supported: false, reason: 'This control type has no text selection range.' };
      }
      controls[name] = {
        id: element.id || null,
        tag: element.localName,
        type: element.type || null,
        value: 'value' in element ? element.value : null,
        checked: 'checked' in element ? element.checked : null,
        selectedIndex: element.localName === 'select' ? element.selectedIndex : null,
        selectedValues: element.localName === 'select' ? [...element.selectedOptions].map(option => option.value) : null,
        disabled: element.matches(':disabled'),
        readOnly: !!element.readOnly,
        required: !!element.required,
        focused: element === document.activeElement,
        selection,
      };
    }
    return {
      controls,
      activeElement: document.activeElement?.id || document.activeElement?.localName || null,
      activeElementTag: document.activeElement?.localName || null,
    };
  }, fixture.snapshotControls);
}

async function captureDocument(page) {
  const controls = await captureControls(page);
  const document = await page.evaluate(() => {
    const form = document.querySelector('#controls-form');
    const rect = document.body.getBoundingClientRect();
    const summaryRules = rules => [...rules].map(rule => ({
      type: rule.constructor.name,
      cssText: rule.cssText,
      selectorText: rule.selectorText || null,
    }));
    const stylesheets = [...document.styleSheets].map(sheet => ({
      href: sheet.href,
      ownerTag: sheet.ownerNode?.localName || null,
      media: sheet.media?.mediaText || '',
      disabled: sheet.disabled,
      rules: summaryRules(sheet.cssRules),
    }));
    const htmlStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    return {
      url: location.href,
      title: document.title,
      characterSet: document.characterSet,
      scriptCount: document.scripts.length,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      preferredColorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      htmlBackground: htmlStyle.backgroundColor,
      htmlColorScheme: htmlStyle.colorScheme,
      bodyBackground: bodyStyle.backgroundColor,
      bodyColor: bodyStyle.color,
      bodyFont: bodyStyle.font,
      bodyRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      form: form ? {
        id: form.id,
        attributes: Object.fromEntries([...form.attributes].map(attribute => [attribute.name, attribute.value])),
        action: form.action,
        method: form.method,
        enctype: form.enctype,
        target: form.target,
        noValidate: form.noValidate,
        controlOrder: [...form.elements].map(element => element.id || null),
      } : null,
      stylesheetTree: stylesheets,
    };
  });
  return { ...document, ...controls };
}

function valueSnapshot(capture) {
  return Object.fromEntries(Object.entries(capture.controls).map(([key, control]) => [
    key,
    control?.tag === 'select' ? control.selectedValues?.[0] ?? null : control?.value,
  ]));
}

function assertValues(capture, expected, label) {
  const actual = valueSnapshot(capture);
  for (const [key, expectedValue] of Object.entries(expected)) {
    assert.deepEqual(actual[key], expectedValue, `${label}: ${key}`);
  }
}

async function replaceTextWithKeyboard(page, selector, value, selectLastCharacter = false) {
  const locator = page.locator(selector);
  await locator.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  const lines = value.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (index > 0) await page.keyboard.press('Enter');
    if (lines[index]) await page.keyboard.type(lines[index]);
  }
  if (selectLastCharacter) await page.keyboard.press('Shift+ArrowLeft');
}

function normalizeTextareaSubmission(value) {
  return value.replace(/\r?\n/g, '\r\n');
}

async function runMatrixCase(browser, width, colorScheme) {
  const context = await browser.newContext({
    viewport: { width, height: fixture.matrix.height },
    deviceScaleFactor: fixture.matrix.deviceScaleFactor,
    colorScheme,
    locale: 'en-US',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(4500);
  page.setDefaultNavigationTimeout(6500);
  const caseRequests = [];
  const caseResponses = [];
  const caseExternalRequests = [];
  page.on('request', request => {
    const requestUrl = request.url();
    if (requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) return;
    try {
      if (new URL(requestUrl).origin !== origin) {
        externalRequests.push(requestUrl);
        caseExternalRequests.push(requestUrl);
      }
    } catch {
      externalRequests.push(requestUrl);
      caseExternalRequests.push(requestUrl);
    }
    if (requestUrl.startsWith(origin + '/raw/controls/') || requestUrl.startsWith(origin + '/controls-harness.html')) {
      caseRequests.push({ url: requestUrl, method: request.method(), resourceType: request.resourceType() });
    }
  });
  page.on('response', response => {
    if (response.url().startsWith(origin + '/raw/controls/') || response.url().startsWith(origin + '/controls-harness.html')) {
      caseResponses.push({ url: response.url(), status: response.status(), method: response.request().method() });
    }
  });
  page.on('pageerror', error => browserErrors.push({ width, colorScheme, kind: 'pageerror', message: error.stack || error.message }));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push({ width, colorScheme, kind: 'console', message: message.text() });
  });
  await context.route('**/*', async route => {
    const requestUrl = route.request().url();
    if (requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) return route.continue();
    try {
      if (new URL(requestUrl).origin === origin) return route.continue();
    } catch { }
    if (!caseExternalRequests.includes(requestUrl)) {
      caseExternalRequests.push(requestUrl);
      externalRequests.push(requestUrl);
    }
    await route.abort();
  });

  await page.goto(origin + '/controls-harness.html', { waitUntil: 'load', timeout: 6500 });
  await page.waitForFunction(() => window.fixtureReady === true);
  const markdownForm = await page.evaluate(() => window.markdownFormSnapshot);
  assert(markdownForm, 'pinned renderer did not produce the Markdown form');
  assert.equal(markdownForm.method, 'get');
  assert(markdownForm.action.endsWith('/raw/controls/response?via=markdown-form'));
  assert.equal(markdownForm.onsubmit, null, 'DOMPurify must strip the Markdown form event handler');
  assert(!markdownForm.html.toLowerCase().includes('onsubmit='));

  const requestStart = serverRequests.length;
  const [documentResponse] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 6500 }),
    page.locator('#markdown-controls-submit').click(),
  ]);
  assert.equal(page.url(), origin + fixture.responsePath + '?via=markdown-form');
  const initialDocument = await captureDocument(page);
  assert.equal(initialDocument.scriptCount, 0, 'raw response must not execute or contain scripts');
  assert.equal(initialDocument.viewport.width, width);
  assert.equal(initialDocument.preferredColorScheme, colorScheme);

  const editedValues = fixture.interactions.editedValues;
  await replaceTextWithKeyboard(page, fixture.snapshotControls.textInherit, editedValues.textInherit, true);
  await replaceTextWithKeyboard(page, fixture.snapshotControls.textExplicit, editedValues.textExplicit);
  await replaceTextWithKeyboard(page, fixture.snapshotControls.passwordInherit, editedValues.passwordInherit, true);
  await page.locator(fixture.snapshotControls.numberExplicit).fill(editedValues.numberExplicit);
  await replaceTextWithKeyboard(page, fixture.snapshotControls.textareaInherit, editedValues.textareaInherit, true);
  await replaceTextWithKeyboard(page, fixture.snapshotControls.textareaExplicit, editedValues.textareaExplicit);
  await page.locator(fixture.snapshotControls.selectInherit).selectOption(editedValues.selectInherit);
  await page.locator(fixture.snapshotControls.selectExplicit).selectOption(editedValues.selectExplicit);

  const readonlySelector = fixture.snapshotControls.textReadonly;
  const readonlyBefore = await page.locator(readonlySelector).inputValue();
  await page.locator(readonlySelector).click();
  await page.keyboard.type(fixture.interactions.readonlyAttempt);
  const readonlyAfter = await page.locator(readonlySelector).inputValue();
  assert.equal(readonlyAfter, readonlyBefore, 'keyboard edits must not change a readonly control');

  const disabledSelector = fixture.snapshotControls.textDisabled;
  const disabledBefore = await page.locator(disabledSelector).inputValue();
  const disabledRect = await page.locator(disabledSelector).boundingBox();
  assert(disabledRect);
  await page.mouse.click(disabledRect.x + disabledRect.width / 2, disabledRect.y + disabledRect.height / 2);
  await page.keyboard.type(fixture.interactions.disabledAttempt);
  const disabledAfter = await page.locator(disabledSelector).inputValue();
  assert.equal(disabledAfter, disabledBefore, 'pointer/keyboard attempts must not change a disabled control');

  const afterEdits = await captureInteractionState(page);
  assertValues(afterEdits, editedValues, 'edited state');
  assert.equal(afterEdits.controls.textReadonly.value, readonlyBefore);
  assert.equal(afterEdits.controls.textDisabled.value, disabledBefore);
  assert.equal(afterEdits.controls.textReadonly.readOnly, true);
  assert.equal(afterEdits.controls.textDisabled.disabled, true);
  for (const key of ['textInherit', 'passwordInherit', 'textareaInherit']) {
    assert(afterEdits.controls[key].selection?.supported, `${key} selection range should be observable`);
  }

  await page.locator('#reset-controls').click();
  const afterReset = await captureInteractionState(page);
  assertValues(afterReset, valueSnapshot(initialDocument), 'reset state');

  const submitValues = fixture.interactions.submitValues;
  await page.locator(fixture.snapshotControls.textInherit).fill(submitValues.textInherit);
  await page.locator(fixture.snapshotControls.textExplicit).fill(submitValues.textExplicit);
  await page.locator(fixture.snapshotControls.passwordInherit).fill(submitValues.passwordInherit);
  await page.locator(fixture.snapshotControls.numberExplicit).fill(submitValues.numberExplicit);
  await page.locator(fixture.snapshotControls.textareaInherit).fill(submitValues.textareaInherit);
  await page.locator(fixture.snapshotControls.textareaExplicit).fill(submitValues.textareaExplicit);
  await page.locator(fixture.snapshotControls.selectInherit).selectOption(submitValues.selectInherit);
  await page.locator(fixture.snapshotControls.selectExplicit).selectOption(submitValues.selectExplicit);
  const beforeSubmit = await captureInteractionState(page);
  assertValues(beforeSubmit, submitValues, 'pre-submit state');
  const screenshotName = `html-control-styles-${colorScheme}-${width}.png`;
  const screenshotPath = resolve(screenshotDir, screenshotName);
  await page.screenshot({ path: screenshotPath, type: 'png' });

  const submitStart = submittedRequests.length;
  const [submitResponse] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 6500 }),
    page.locator('#submit-controls').click(),
  ]);
  assert.equal(page.url(), origin + fixture.submitPath);
  const captureRequests = submittedRequests.slice(submitStart);
  assert.equal(captureRequests.length, 1, 'expected one local form submission');
  const submitRequest = captureRequests[0];
  assert.equal(submitRequest.method, 'POST');
  assert.equal(submitRequest.pathname, fixture.submitPath);
  assert.match(submitRequest.contentType || '', /^application\/x-www-form-urlencoded/);
  const submittedEntries = new Map(submitRequest.decodedEntries);
  assert.equal(submittedEntries.get('plain'), submitValues.textInherit);
  assert.equal(submittedEntries.get('password'), submitValues.passwordInherit);
  assert.equal(submittedEntries.get('count'), submitValues.numberExplicit);
  assert.equal(submittedEntries.get('locked'), 'read only');
  assert.equal(submittedEntries.has('excluded'), false, 'disabled controls must not be submitted');
  assert.equal(submittedEntries.get('submitter'), 'final');
  assert.equal(submittedEntries.get('notes'), normalizeTextareaSubmission(submitValues.textareaInherit));
  const submitPage = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body.innerText.trim(),
    scripts: document.scripts.length,
  }));
  const item = {
    width,
    height: fixture.matrix.height,
    colorScheme,
    deviceScaleFactor: fixture.matrix.deviceScaleFactor,
    markdownForm,
    documentStatus: documentResponse?.status() ?? null,
    initialDocument,
    interactions: {
      afterEdits,
      readonlyAttempt: { before: readonlyBefore, after: readonlyAfter, unchanged: readonlyBefore === readonlyAfter },
      disabledAttempt: { before: disabledBefore, after: disabledAfter, unchanged: disabledBefore === disabledAfter },
      afterReset,
      resetRestoredInitialValues: JSON.stringify(valueSnapshot(afterReset)) === JSON.stringify(valueSnapshot(initialDocument)),
      beforeSubmit,
    },
    submitRequest,
    submitNavigation: { status: submitResponse?.status() ?? null, ...submitPage },
    requests: caseRequests,
    responses: caseResponses,
    serverRequests: serverRequests.slice(requestStart),
    screenshot: `apps/android/build/parity/${screenshotName}`,
  };
  await context.close();
  return item;
}

function checkStyleInvariants(captures) {
  for (const invariant of fixture.invariants) {
    const matching = captures.filter(capture => {
      if (invariant.appliesTo === 'all') return true;
      if (invariant.appliesTo === 'narrow') return capture.width === 390;
      if (invariant.appliesTo === 'wide') return capture.width === 768;
      return capture.colorScheme === invariant.appliesTo;
    });
    for (const capture of matching) {
      const actual = capture.initialDocument.controls[invariant.control]?.computed[invariant.property] ?? null;
      assert.equal(
        actual,
        invariant.expected,
        `CSS invariant ${invariant.control}.${invariant.property} in ${capture.width}/${capture.colorScheme}`,
      );
    }
  }
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: requireTestBrowserExecutable(),
    headless: true,
  });
  const browserVersion = await browser.version();
  assert(browserVersion.startsWith('154.'), `expected Chrome 154, got ${browserVersion}`);

  const captures = [];
  for (const width of fixture.matrix.widths) {
    for (const colorScheme of fixture.matrix.colorSchemes) {
      captures.push(await runMatrixCase(browser, width, colorScheme));
    }
  }
  checkStyleInvariants(captures);
  assert.equal(externalRequests.length, 0, `unexpected external requests: ${JSON.stringify(externalRequests)}`);
  assert.equal(browserErrors.length, 0, `unexpected browser errors: ${JSON.stringify(browserErrors)}`);
  assert(serverResponses.every(response => response.status < 400), `unexpected local error: ${JSON.stringify(serverResponses)}`);
  assert.equal(submittedRequests.length, captures.length);

  const localePage = await browser.newPage();
  const locale = await localePage.evaluate(() => ({ language: navigator.language, languages: [...navigator.languages] }));
  await localePage.close();
  const expected = {
    fixture: fixture.id,
    reference: fixture.webRevision,
    browserVersion,
    locale,
    origin,
    sanitizer: 'apps/web/src/lib/markdown.ts renderMarkdown() / DOMPurify',
    controlsPerCapture: Object.keys(fixture.snapshotControls).length,
    captures,
    serverResponses,
    submittedRequests,
    externalRequests,
    browserErrors,
    localRequestsOnly: externalRequests.length === 0 && captures.every(capture => capture.requests.every(request => request.url.startsWith(origin + '/'))),
    responseScriptsExecuted: false,
    unsupported: [
      'No screenshot pixel comparison is performed; captures are actual computed styles, DOMRects, and form state.',
      'Font matching outside the pinned Chrome host and browser versions other than Chrome 154 are not measured.',
      'Focus and text-selection ranges are recorded at each captured stage; screenshots do not represent a native app rendering.',
    ],
  };
  await writeFile(expectedPath, JSON.stringify(expected, null, 2) + '\n');
  console.log(JSON.stringify({
    target: expectedPath,
    browserVersion,
    captureCount: captures.length,
    controlsPerCapture: expected.controlsPerCapture,
    cases: captures.map(capture => ({
      width: capture.width,
      colorScheme: capture.colorScheme,
      finalUrl: capture.initialDocument.url,
      responseStatus: capture.documentStatus,
      bodyBackground: capture.initialDocument.bodyBackground,
      bodyFont: capture.initialDocument.bodyFont,
      inputSummary: Object.fromEntries(Object.entries(capture.initialDocument.controls).map(([name, control]) => [name, {
        rect: control.rect,
        boxSizing: control.computed['box-sizing'],
        width: control.computed.width,
        font: control.computed['font-family'],
        fontSize: control.computed['font-size'],
        lineHeight: control.computed['line-height'],
        padding: [control.computed['padding-top'], control.computed['padding-right'], control.computed['padding-bottom'], control.computed['padding-left']],
        borders: [control.computed['border-top-width'], control.computed['border-right-width'], control.computed['border-bottom-width'], control.computed['border-left-width']],
        borderRadius: control.computed['border-radius'],
        selection: control.selection,
      }])) ,
      readonlyUnchanged: capture.interactions.readonlyAttempt.unchanged,
      disabledUnchanged: capture.interactions.disabledAttempt.unchanged,
      resetRestoredInitialValues: capture.interactions.resetRestoredInitialValues,
      submitBodyUtf8: capture.submitRequest.bodyUtf8,
    })),
    submittedRequests: submittedRequests.map(request => ({ method: request.method, pathname: request.pathname, contentType: request.contentType, bodyByteLength: request.bodyByteLength, decodedEntries: request.decodedEntries })),
    localRequestsOnly: expected.localRequestsOnly,
  }, null, 2));
} finally {
  if (browser) await browser.close();
  await server.close();
}
