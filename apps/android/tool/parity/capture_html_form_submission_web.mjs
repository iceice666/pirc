import { requireTestBrowserExecutable } from './test_browser.mjs';
// Run from repository root:
// node apps/android/tool/parity/capture_html_form_submission_web.mjs
// Measures real pointer/keyboard HTML submission in Chrome after production renderMarkdown sanitization.
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const pinnedRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/html-form-submission.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
if (fixture.webRevision !== pinnedRevision) throw new Error('form submission fixture must use pinned web revision');
execFileSync('git', ['diff', '--exit-code', pinnedRevision, '--', 'apps/web'], { cwd: root });
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const temporaryOutput = resolve('/private/tmp', 'pirc-html-form-submission-parity');
const screenshotOutput = resolve(root, 'apps/android/build/parity');
await mkdir(temporaryOutput, { recursive: true });
await mkdir(screenshotOutput, { recursive: true });
const capturedRequests = [];

const server = await createServer({
  cacheDir: resolve(temporaryOutput, 'vite-cache'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: 18919,
    strictPort: true,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [{
    name: 'html-form-submission-parity',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url || '/';
        const pathname = rawUrl.split('?')[0];
        if (pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
        if (pathname === '/capture/get' || pathname === '/capture/post') {
          const chunks = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks).toString('utf8');
          const requestUrl = new URL(rawUrl, 'http://127.0.0.1:18919');
          capturedRequests.push({
            method: req.method,
            pathname: requestUrl.pathname,
            rawQuery: requestUrl.search,
            contentType: req.headers['content-type'] || null,
            body,
            decodedEntries: [...(req.method === 'GET' ? requestUrl.searchParams : new URLSearchParams(body)).entries()],
          });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end('<!doctype html><html><head><title>Local form capture</title></head><body>Captured locally.</body></html>');
          return;
        }
        if (pathname !== '/parity.html') return next();
        try {
          const html = [
            '<!doctype html><html><head><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
            '<body><main id="fixture"></main><script type="module">',
            "import { renderMarkdown, enhanceMarkdown } from '/src/lib/markdown.ts';",
            'const fixture = ' + fixtureSource + ';',
            'const root = document.querySelector("#fixture");',
            'const html = renderMarkdown(fixture.source);',
            'root.innerHTML = html;',
            'const enhancer = enhanceMarkdown(root, { html, ready: true });',
            'let events = { submits: [], invalid: [], focus: [], clipboard: [] };',
            'const focusedId = () => document.activeElement && document.activeElement.id || null;',
            'const attributeMap = element => Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value]));',
            'const validity = element => {',
            '  const flags = ["badInput", "customError", "patternMismatch", "rangeOverflow", "rangeUnderflow", "stepMismatch", "tooLong", "tooShort", "typeMismatch", "valueMissing", "valid"];',
            '  const result = {};',
            '  for (const flag of flags) result[flag] = element.validity ? element.validity[flag] : null;',
            '  return { willValidate: element.willValidate ?? null, validationMessage: element.validationMessage ?? "", flags: result };',
            '};',
            'const formValidity = form => [...form.elements].filter(element => element.validity).map(element => ({ id: element.id || null, ...validity(element) }));',
            'const entries = formData => [...formData.entries()].map(([name, value]) => [name, value instanceof File ? { filename: value.name, type: value.type, size: value.size } : value]);',
            'const formSnapshot = form => ({',
            '  id: form.id || null, attributes: attributeMap(form),',
            '  action: form.action, method: form.method, enctype: form.enctype, target: form.target, noValidate: form.noValidate,',
            '  controls: [...form.elements].map(element => element.id || null),',
            '});',
            'const controlSnapshot = element => {',
            '  const rect = element.getBoundingClientRect();',
            '  return {',
            '    id: element.id || null, tag: element.localName, type: element.type || null, name: element.name || null,',
            '    value: "value" in element ? element.value : null, valueAttribute: element.getAttribute("value"),',
            '    checked: "checked" in element ? element.checked : null, selectedValues: element.localName === "select" ? [...element.selectedOptions].map(option => option.value) : null,',
            '    attributes: attributeMap(element), formId: element.form?.id || null,',
            '    disabled: element.matches(":disabled"), readOnly: !!element.readOnly, required: !!element.required,',
            '    willValidate: element.willValidate ?? null, validity: element.validity ? validity(element) : null,',
            '    focused: element === document.activeElement, validationMessage: element.validationMessage ?? "",',
            '    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },',
            '  };',
            '};',
            'window.captureSnapshot = () => ({',
            '  sanitizedDOM: root.innerHTML,',
            '  forms: [...root.querySelectorAll("form")].map(formSnapshot),',
            '  fields: [...root.querySelectorAll("input, textarea, select")].map(controlSnapshot),',
            '  buttons: [...root.querySelectorAll("button")].map(controlSnapshot),',
            '  sanitizerAttributes: Object.fromEntries(Object.entries(fixture.sanitizerTargets).map(([id, names]) => {',
            '    const element = root.querySelector("#" + CSS.escape(id));',
            '    return [id, element ? Object.fromEntries(names.map(name => [name, element.getAttribute(name)])) : null];',
            '  })),',
            '  focusedId: focusedId(),',
            '});',
            'window.captureElement = selector => { const element = root.querySelector(selector); return element ? controlSnapshot(element) : null; };',
            'window.takeEvents = () => {',
            '  const writes = [...(window.__clipboardWrites || [])];',
            '  const result = { ...events, clipboardWrites: writes, focusedId: focusedId() };',
            '  window.__clipboardWrites = [];',
            '  events = { submits: [], invalid: [], focus: [], clipboard: [] };',
            '  return result;',
            '};',
            'window.addEventListener("invalid", event => {',
            '  const element = event.target;',
            '  events.invalid.push({ id: element.id || null, formId: element.form?.id || null, selector: element.id ? "#" + CSS.escape(element.id) : null, validationMessage: element.validationMessage, willValidate: element.willValidate, validity: validity(element) });',
            '}, true);',
            'window.addEventListener("focusin", event => {',
            '  const element = event.target;',
            '  events.focus.push({ id: element.id || null, tag: element.localName, focusedId: focusedId(), validationMessage: element.validationMessage ?? "" });',
            '}, true);',
            'root.addEventListener("submit", event => {',
            '  const form = event.target;',
            '  const submitter = event.submitter || null;',
            '  if (!form.hasAttribute("data-allow-default")) event.preventDefault();',
            '  const fieldValidity = formValidity(form);',
            '  const firstInvalid = fieldValidity.find(field => field.willValidate && field.flags.valid === false) || null;',
            '  const data = submitter ? new FormData(form, submitter) : new FormData(form);',
            '  events.submits.push({',
            '    formId: form.id || null,',
            '    submitter: submitter ? { id: submitter.id || null, tag: submitter.localName, type: submitter.type || null, name: submitter.name || null, value: submitter.value ?? null, attributes: attributeMap(submitter), formAction: submitter.formAction ?? null, formMethod: submitter.formMethod ?? null, formEnctype: submitter.formEnctype ?? null, formTarget: submitter.formTarget ?? null, formNoValidate: submitter.formNoValidate ?? false } : null,',
            '    form: { action: form.action, method: form.method, enctype: form.enctype, target: form.target, noValidate: form.noValidate },',
            '    effectiveFormValid: !firstInvalid, firstInvalidSelector: firstInvalid?.id ? "#" + CSS.escape(firstInvalid.id) : null,',
            '    fields: fieldValidity, entries: entries(data), clipboardWritesAtSubmit: [...(window.__clipboardWrites || [])],',
            '    focusedId: focusedId(), validationMessage: document.activeElement?.validationMessage ?? "",',
            '    canceled: event.defaultPrevented,',
            '  });',
            '  window.name = JSON.stringify({ submits: events.submits, invalid: events.invalid, focus: events.focus, focusedId: focusedId() });',
            '}, true);',
            'window.addEventListener("unhandledrejection", event => { events.clipboard.push({ reason: String(event.reason) }); event.preventDefault(); });',
            'window.fixtureReady = true;',
            '</script></body></html>',
          ].join('\n');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(await server.transformIndexHtml('/parity.html', html));
        } catch (error) { next(error); }
      });
    },
  }],
});

const browserIssues = { pageErrors: [], consoleErrors: [], badResponses: [] };
const observePage = page => {
  page.on('pageerror', error => browserIssues.pageErrors.push(error.stack || error.message));
  page.on('console', message => { if (message.type() === 'error') browserIssues.consoleErrors.push(message.text() + ' ' + JSON.stringify(message.location())); });
  page.on('response', response => { if (response.status() >= 400) browserIssues.badResponses.push(response.status() + ' ' + response.url()); });
};
const url = 'http://127.0.0.1:18919/parity.html';
const outputActions = [];
const defaultNavigations = [];
const screenshots = [];
const controlScreenshots = [];
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
  observePage(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__clipboardWrites = window.__clipboardWrites || []; window.__clipboardWrites.push(text); } } });
  });
  await page.goto(url);
  await page.waitForFunction(() => window.fixtureReady);
  const initial = await page.evaluate(() => window.captureSnapshot());
  const locale = await page.evaluate(() => ({ language: navigator.language, languages: [...navigator.languages] }));
  for (const action of fixture.actions.filter(item => item.mode !== 'networkGet' && item.mode !== 'networkPost')) {
    if (action.mode === 'fill') await page.locator(action.selector).fill(action.value);
    else if (action.mode === 'click') await page.locator(action.selector).click();
    else if (action.mode === 'pressEnter') {
      await page.locator(action.selector).focus();
      await page.locator(action.selector).press('Enter');
    } else throw new Error('Unknown action mode ' + action.mode);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const events = await page.evaluate(() => window.takeEvents());
    const target = await page.evaluate(selector => window.captureElement(selector), action.selector);
    outputActions.push({ id: action.id, events, target });
  }

  for (const id of ['input-default-submit', 'input-default-reset']) {
    const file = resolve(screenshotOutput, 'html-form-submission-' + id + '.png');
    await page.locator('#' + id).screenshot({ path: file });
    const control = initial.fields.find(field => field.id === id);
    controlScreenshots.push({ id, file, value: control?.value ?? null, valueAttribute: control?.attributes.value ?? null, rect: control?.rect ?? null });
  }

  for (const action of fixture.actions.filter(item => item.mode === 'networkGet' || item.mode === 'networkPost')) {
    await page.goto(url);
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => { window.name = ''; });
    const selector = action.mode === 'networkGet' ? '#get-submit' : '#post-submit';
    const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await Promise.all([navigation, page.locator(selector).click()]);
    const savedEvents = await page.evaluate(() => {
      try { return JSON.parse(window.name || 'null'); } catch { return null; }
    });
    defaultNavigations.push({
      id: action.id,
      finalUrl: page.url(),
      events: savedEvents,
      request: capturedRequests.at(-1) || null,
    });
  }

  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      colorScheme,
    });
    const screenshotPage = await context.newPage();
    observePage(screenshotPage);
    await screenshotPage.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
    });
    await screenshotPage.goto(url);
    await screenshotPage.waitForFunction(() => window.fixtureReady);
    await screenshotPage.locator('#main-submit').click();
    const validationState = await screenshotPage.evaluate(() => window.takeEvents());
    const file = resolve(screenshotOutput, 'html-form-submission-validation-' + colorScheme + '.png');
    await screenshotPage.screenshot({ path: file });
    screenshots.push({ colorScheme, file, focusedId: validationState.focusedId, invalidCount: validationState.invalid.length, firstInvalidSelector: validationState.invalid[0]?.selector || null, validationMessage: validationState.invalid[0]?.validationMessage || '' });
    await context.close();
  }

  const unexpectedConsoleErrors = browserIssues.consoleErrors.filter(message => !message.includes('NotAllowedError'));
  if (browserIssues.badResponses.length) throw new Error(browserIssues.badResponses.join('\n'));
  if (browserIssues.pageErrors.length) throw new Error(browserIssues.pageErrors.join('\n'));
  if (unexpectedConsoleErrors.length) throw new Error(unexpectedConsoleErrors.join('\n'));
  if (capturedRequests.length !== 2) throw new Error('Expected exactly two local default submissions, got ' + capturedRequests.length);

  const expected = {
    fixture: fixture.id,
    reference: fixture.webRevision,
    browserVersion,
    locale,
    sanitizer: 'apps/web/src/lib/markdown.ts renderMarkdown() / DOMPurify',
    initial,
    actions: outputActions,
    defaultNavigations,
    screenshots,
    controlScreenshots,
    browserIssues,
    localRequestsOnly: capturedRequests.every(request => request.pathname === '/capture/get' || request.pathname === '/capture/post'),
  };
  const target = resolve(root, 'fixtures/mobile-parity/html-form-submission-expected.json');
  await writeFile(target, JSON.stringify(expected, null, 2) + '\n');
  const compact = {
    target,
    browserVersion,
    actions: outputActions.map(item => ({ id: item.id, submitters: item.events.submits.map(event => event.submitter?.id || null), invalid: item.events.invalid.map(event => ({ id: event.id, validationMessage: event.validationMessage })), focusedId: item.events.focusedId })),
    defaultNavigations,
    screenshots,
    controlScreenshots,
    browserIssues,
  };
  console.log(JSON.stringify(compact, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
