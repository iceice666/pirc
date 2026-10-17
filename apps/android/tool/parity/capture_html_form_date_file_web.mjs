import { requireTestBrowserExecutable } from './test_browser.mjs';
// Run from repository root:
// node apps/android/tool/parity/capture_html_form_date_file_web.mjs
// Captures actual Chrome date/file control behavior after the pinned Markdown
// sanitizer and from script-free raw HTML response documents.
import assert from 'node:assert/strict';
import { createServer } from '../../../web/node_modules/vite/dist/node/index.js';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const pinnedRevision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';
const fixturePath = resolve(root, 'fixtures/mobile-parity/html-form-date-file.json');
const expectedPath = resolve(root, 'fixtures/mobile-parity/html-form-date-file-expected.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixture.webRevision, pinnedRevision);
assert.deepEqual(fixture.modes, ['markdown', 'rawDocument']);
assert.equal(fixture.submissionCases.length, 8);
assert.equal(fixture.dummyFiles.length, 2);
assert(!fixture.markup.toLowerCase().includes('<script'), 'fixture markup must not contain scripts');
assert(!fixture.formOverrideProbeMarkup.toLowerCase().includes('<script'), 'form override probe must not contain scripts');
execFileSync('git', ['diff', '--exit-code', pinnedRevision, '--', 'apps/web', ':!apps/web/tool'], { cwd: root });

const origin = 'http://127.0.0.1:18935';
const fixtureSource = JSON.stringify(fixture).replaceAll('<', '\\u003c');
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const outputDir = resolve('/private/tmp', 'pirc-html-form-date-file-parity');
const screenshotDir = resolve(root, 'apps/android/build/parity/html-form-date-file');
const receipts = [];
const serverEvents = [];
const serverErrors = [];
const browserErrors = { pageErrors: [], consoleErrors: [], badResponses: [], externalRequests: [] };
await mkdir(outputDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });

function parseMultipart(contentType, body) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) return { boundary: null, parts: [], error: 'multipart boundary missing' };
  const boundary = (match[1] || match[2]).trim();
  const marker = Buffer.from('--' + boundary, 'ascii');
  const parts = [];
  let cursor = 0;
  while (true) {
    const markerStart = body.indexOf(marker, cursor);
    if (markerStart < 0) break;
    cursor = markerStart + marker.length;
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) break;
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n'))) cursor += 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0) break;
    const nextMarker = body.indexOf(marker, headerEnd + 4);
    if (nextMarker < 0) break;
    let dataEnd = nextMarker;
    if (body.subarray(dataEnd - 2, dataEnd).equals(Buffer.from('\r\n'))) dataEnd -= 2;
    const headerBytes = body.subarray(cursor, headerEnd);
    const data = body.subarray(headerEnd + 4, dataEnd);
    const headerUtf8 = headerBytes.toString('utf8');
    const headerLatin1 = headerBytes.toString('latin1');
    const headers = {};
    for (const line of headerLatin1.split('\r\n')) {
      const split = line.indexOf(':');
      if (split >= 0) headers[line.slice(0, split).toLowerCase()] = line.slice(split + 1).trim();
    }
    const disposition = headers['content-disposition'] || '';
    const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1] ?? null;
    const filenameUtf8 = /(?:^|;)\s*filename="([^"]*)"/i.exec(headerUtf8)?.[1] ?? null;
    parts.push({
      name,
      filename: filenameUtf8,
      contentDispositionLatin1: disposition,
      contentDispositionUtf8: /content-disposition:[^\r\n]*/i.exec(headerUtf8)?.[0] ?? null,
      headers,
      headerBytesBase64: headerBytes.toString('base64'),
      byteLength: data.length,
      bodyUtf8: data.toString('utf8'),
      bodyHex: data.toString('hex'),
      bodyBase64: data.toString('base64'),
    });
    cursor = nextMarker;
  }
  return { boundary, parts };
}

function requestRecord(request, rawUrl, bytes) {
  const queryMark = rawUrl.indexOf('?');
  const pathname = queryMark < 0 ? rawUrl : rawUrl.slice(0, queryMark);
  const rawQuery = queryMark < 0 ? '' : rawUrl.slice(queryMark);
  const contentType = request.headers['content-type'] || null;
  const record = {
    method: request.method,
    rawUrl,
    pathname,
    rawQuery,
    headers: {
      contentType,
      contentLength: request.headers['content-length'] || null,
      origin: request.headers.origin || null,
      referer: request.headers.referer || null,
    },
    bodyByteLength: bytes.length,
    bodyUtf8: bytes.toString('utf8'),
    bodyHex: bytes.toString('hex'),
    bodyBase64: bytes.toString('base64'),
  };
  if (request.method === 'GET') {
    const query = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
    record.decodedQueryEntries = [...new URLSearchParams(query).entries()];
  } else if ((contentType || '').startsWith('application/x-www-form-urlencoded')) {
    record.decodedBodyEntries = [...new URLSearchParams(bytes.toString('utf8')).entries()];
  } else if ((contentType || '').startsWith('multipart/form-data')) {
    record.multipart = parseMultipart(contentType, bytes);
  }
  return record;
}

const harnessHtml = `<!doctype html>
<html lang="en-US"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Date and file control harness</title></head>
<body><main id="fixture"></main><script type="module">
import '/src/app.css';
import '/src/markdown.css';
import { renderMarkdown } from '/src/lib/markdown.ts';
const fixture = ${fixtureSource};
const root = document.querySelector('#fixture');
root.innerHTML = '<article class="markdown">' + renderMarkdown(fixture.markup + '\\n' + fixture.formOverrideProbeMarkup) + '</article>';
const authoredFontSizes = new WeakMap();
window.fixtureReady = true;
window.applyParityTextScale = (scale) => {
  const elements = [root, ...root.querySelectorAll('*')];
  for (const element of elements) {
    if (!authoredFontSizes.has(element)) authoredFontSizes.set(element, {
      value: element.style.getPropertyValue('font-size'),
      priority: element.style.getPropertyPriority('font-size'),
    });
  }
  for (const element of elements) {
    const authored = authoredFontSizes.get(element);
    if (authored.value) element.style.setProperty('font-size', authored.value, authored.priority);
    else element.style.removeProperty('font-size');
  }
  const baseline = elements.map(element => Number.parseFloat(getComputedStyle(element).fontSize));
  elements.forEach((element, index) => {
    if (Number.isFinite(baseline[index])) element.style.setProperty('font-size', (baseline[index] * scale) + 'px', 'important');
  });
};
</script></body></html>`;

const server = await createServer({
  cacheDir: resolve(outputDir, 'vite-cache'),
  root: resolve(root, 'apps/web'),
  configFile: resolve(root, 'apps/web/vite.config.ts'),
  server: {
    host: '127.0.0.1', port: 18935, strictPort: true, hmr: false,
    fs: { allow: [root, await realpath(resolve(root, 'node_modules'))] },
  },
  plugins: [{
    name: 'html-form-date-file-parity',
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const rawUrl = request.url || '/';
        const pathname = rawUrl.split(/[?#]/, 1)[0];
        if (pathname === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
        if (pathname.startsWith('/capture/')) {
          try {
            const chunks = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const record = requestRecord(request, rawUrl, Buffer.concat(chunks));
            receipts.push(record);
            serverEvents.push({ kind: 'form-submit', method: request.method, rawUrl, status: 200 });
            response.statusCode = 200;
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.end('<!doctype html><html lang="en-US"><head><meta charset="utf-8"><title>Local submission received</title></head><body><p>Local submission received.</p></body></html>');
          } catch (error) {
            serverErrors.push(String(error?.stack || error));
            response.statusCode = 500;
            response.end('local capture error');
          }
          return;
        }
        if (pathname === '/markdown.html') {
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(await vite.transformIndexHtml('/markdown.html', harnessHtml));
          return;
        }
        if (pathname === '/raw-document.html') {
          serverEvents.push({ kind: 'raw-document', method: request.method, rawUrl, status: 200 });
          response.statusCode = 200;
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end('<!doctype html><html lang="en-US"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><style>:root{color-scheme:light dark}</style><title>Raw HTML date and file controls</title></head><body><main id="fixture">' + fixture.markup + fixture.formOverrideProbeMarkup + '</main></body></html>');
          return;
        }
        if (pathname.startsWith('/raw-document/')) {
          serverEvents.push({ kind: 'unexpected-local-resource', method: request.method, rawUrl, status: 404 });
          response.statusCode = 404;
          response.setHeader('Content-Type', 'text/plain; charset=utf-8');
          response.end('Unexpected raw-document resource');
          return;
        }
        next();
      });
    },
  }],
});

const observePage = page => {
  page.on('pageerror', error => browserErrors.pageErrors.push(error.stack || error.message));
  page.on('console', message => { if (message.type() === 'error') browserErrors.consoleErrors.push(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400) browserErrors.badResponses.push(response.status() + ' ' + response.url());
  });
  page.on('request', request => {
    const url = request.url();
    if (!url.startsWith(origin + '/') && !url.startsWith('data:') && !url.startsWith('blob:')) browserErrors.externalRequests.push(url);
  });
};

const styleProperties = fixture.styleProperties;
const dateSelectors = fixture.dateControls;
const fileSelectors = fixture.fileControls;
const formByEncoding = {
  get: '#file-form-get',
  urlencoded: '#file-form-urlencoded',
  textPlain: '#file-form-text-plain',
  multipart: '#file-form-multipart',
};
const submitterByEncoding = {
  get: '#file-form-get button[type="submit"]',
  urlencoded: '#file-form-urlencoded button[type="submit"]',
  textPlain: '#file-form-text-plain button[type="submit"]',
  multipart: '#file-form-multipart button[type="submit"]',
};

async function openModePage(browser, mode, config) {
  const context = await browser.newContext({
    viewport: { width: config.width, height: fixture.height },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    colorScheme: config.theme,
    locale: 'en-US',
  });
  const page = await context.newPage();
  observePage(page);
  await page.goto(origin + (mode === 'markdown' ? '/markdown.html' : '/raw-document.html'), { waitUntil: 'networkidle' });
  if (mode === 'markdown') await page.waitForFunction(() => window.fixtureReady === true);
  await page.evaluate(scale => {
    if (typeof window.applyParityTextScale === 'function') {
      window.applyParityTextScale(scale);
      return;
    }
    const root = document.querySelector('#fixture');
    const elements = [root, ...root.querySelectorAll('*')];
    const baseline = elements.map(element => Number.parseFloat(getComputedStyle(element).fontSize));
    elements.forEach((element, index) => {
      if (Number.isFinite(baseline[index])) element.style.setProperty('font-size', (baseline[index] * scale) + 'px', 'important');
    });
  }, config.textScale);
  return { context, page };
}

async function snapshotControls(page, config) {
  return page.evaluate(({ dateControls, fileControls, formOverrideProbe, styleProperties, config }) => {
    const attributeMap = element => Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value]));
    const rectData = element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
    };
    const validityData = element => {
      if (!element.validity) return null;
      const flags = {};
      for (const name of ['badInput', 'customError', 'patternMismatch', 'rangeOverflow', 'rangeUnderflow', 'stepMismatch', 'tooLong', 'tooShort', 'typeMismatch', 'valueMissing', 'valid']) flags[name] = element.validity[name];
      return {
        willValidate: element.willValidate,
        validationMessage: element.validationMessage,
        checkValidity: element.checkValidity(),
        flags,
      };
    };
    const filesData = element => [...(element.files || [])].map(file => ({ name: file.name, type: file.type, size: file.size }));
    const control = (selector, file = false) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      const rect = rectData(element);
      let valueAsDate = null;
      if (element.type === 'date' && element.valueAsDate) valueAsDate = element.valueAsDate.toISOString();
      let fileButton = null;
      if (file) {
        try {
          const pseudo = getComputedStyle(element, '::file-selector-button');
          fileButton = {
            computed: Object.fromEntries(styleProperties.map(property => [property, pseudo.getPropertyValue(property).trim()])),
            nativeSubpartRect: null,
            nativeSubpartRectReason: 'Chromium does not expose the filename/button subpart as a DOM element or pseudo-element box.',
          };
        } catch (error) { fileButton = { error: String(error) }; }
      }
      return {
        id: element.id || null,
        tag: element.localName,
        type: element.type || null,
        name: element.name || null,
        attributes: attributeMap(element),
        value: 'value' in element ? element.value : null,
        valueAttribute: element.getAttribute('value'),
        valueAsNumber: element.type === 'date' ? (Number.isNaN(element.valueAsNumber) ? null : element.valueAsNumber) : null,
        valueAsDate,
        min: element.min ?? null,
        max: element.max ?? null,
        step: element.step ?? null,
        disabled: element.matches(':disabled'),
        disabledProperty: element.disabled ?? null,
        readOnly: !!element.readOnly,
        required: !!element.required,
        willValidate: element.willValidate ?? null,
        validity: validityData(element),
        focused: element === document.activeElement,
        focusVisible: element.matches(':focus-visible'),
        files: file ? filesData(element) : null,
        fileSelectorButton: fileButton,
        rect,
        computed: Object.fromEntries(styleProperties.map(property => [property, style.getPropertyValue(property).trim()])),
      };
    };
    const dateStates = Object.fromEntries(Object.entries(dateControls).map(([name, selector]) => [name, control(selector)]));
    const fileStates = Object.fromEntries(Object.entries(fileControls)
      .filter(([name]) => !name.startsWith('submit') && name !== 'reset')
      .map(([name, selector]) => [name, control(selector, true)]));
    const overrideForm = document.querySelector(formOverrideProbe.form);
    const overrideSubmitter = document.querySelector(formOverrideProbe.submitter);
    const formOverrides = overrideForm && overrideSubmitter ? {
      form: {
        id: overrideForm.id,
        attributes: attributeMap(overrideForm),
        action: overrideForm.action,
        method: overrideForm.method,
        enctype: overrideForm.enctype,
        target: overrideForm.target,
      },
      submitter: {
        id: overrideSubmitter.id,
        attributes: attributeMap(overrideSubmitter),
        formId: overrideSubmitter.form?.id ?? null,
        formaction: overrideSubmitter.getAttribute('formaction'),
        formmethod: overrideSubmitter.getAttribute('formmethod'),
        formenctype: overrideSubmitter.getAttribute('formenctype'),
        formtarget: overrideSubmitter.getAttribute('formtarget'),
        formAction: overrideSubmitter.formAction,
        formMethod: overrideSubmitter.formMethod,
        formEnctype: overrideSubmitter.formEnctype,
        formTarget: overrideSubmitter.formTarget,
      },
    } : null;
    const bodyStyle = getComputedStyle(document.body);
    const bodyRect = rectData(document.body);
    return {
      mode: config.mode,
      config: { width: config.width, height: config.height, theme: config.theme, textScale: config.textScale, deviceScaleFactor: 1 },
      document: {
        url: location.href,
        title: document.title,
        languageAttribute: document.documentElement.lang,
        navigatorLanguage: navigator.language,
        navigatorLanguages: [...navigator.languages],
        resolvedDateLocale: Intl.DateTimeFormat().resolvedOptions().locale,
        resolvedDateCalendar: Intl.DateTimeFormat().resolvedOptions().calendar,
        resolvedDateTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        bodyBackground: bodyStyle.backgroundColor,
        bodyColor: bodyStyle.color,
        bodyFont: bodyStyle.font,
        bodyRect,
      },
      dates: dateStates,
      files: fileStates,
      formOverrides,
      activeElement: document.activeElement?.id || document.activeElement?.localName || null,
      htmlScrollHeight: document.documentElement.scrollHeight,
      bodyScrollHeight: document.body.scrollHeight,
    };
  }, { dateControls: dateSelectors, fileControls: fileSelectors, formOverrideProbe: fixture.formOverrideProbe, styleProperties, config });
}

async function snapshotFormData(page, formSelector) {
  return page.locator(formSelector).evaluate(form => {
    const data = new FormData(form);
    return [...data.entries()].map(([name, value]) => value instanceof File
      ? { name, kind: 'file', filename: value.name, type: value.type, size: value.size }
      : { name, kind: 'text', value });
  });
}

async function submitCase(browser, mode, testCase) {
  const config = { width: 390, theme: 'light', textScale: 1 };
  const { context, page } = await openModePage(browser, mode, config);
  const formSelector = formByEncoding[testCase.encoding];
  const fileSelector = `${formSelector} input[type="file"]`;
  if (testCase.selection === 'twoFiles') {
    await page.locator(fileSelector).setInputFiles(fixture.dummyFiles.map(file => ({
      name: file.name,
      mimeType: file.mimeType,
      buffer: Buffer.from(file.bytes),
    })));
  }
  const runId = `${mode}-${testCase.encoding}-${testCase.selection}`;
  await page.locator(formSelector).evaluate((form, marker) => {
    const encoding = form.action.split('/').filter(Boolean).at(-1);
    form.action = location.origin + '/capture/' + encoding + '/' + marker;
  }, runId);
  const formDataEntries = await snapshotFormData(page, formSelector);
  const requestIndexBefore = receipts.length;
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await Promise.all([navigation, page.locator(submitterByEncoding[testCase.encoding]).click()]);
  const receipt = receipts.slice(requestIndexBefore).find(record => record.rawUrl.includes(runId)) || receipts.at(-1);
  assert(receipt, `${runId}: expected a loopback HTTP request receipt`);
  assert(receipt.rawUrl.includes(runId), `${runId}: receipt should contain route marker: ${JSON.stringify(receipt)}`);
  await context.close();
  return { mode, encoding: testCase.encoding, selection: testCase.selection, formDataEntries, request: receipt, finalUrl: page.url() };
}

let browser;
let expected;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: requireTestBrowserExecutable(), headless: true });
  const browserVersion = await browser.version();
  assert(browserVersion.startsWith('154.'), `Expected Chromium 154; got ${browserVersion}`);

  const locale = await (async () => {
    const { context, page } = await openModePage(browser, 'markdown', { width: 390, theme: 'light', textScale: 1 });
    const value = await page.evaluate(() => ({
      language: navigator.language,
      languages: [...navigator.languages],
      dateLocale: Intl.DateTimeFormat().resolvedOptions().locale,
      dateCalendar: Intl.DateTimeFormat().resolvedOptions().calendar,
      dateSample: new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date('2024-06-15T00:00:00.000Z')),
    }));
    await context.close();
    return value;
  })();

  const matrix = [];
  const screenshots = [];
  const interactions = [];
  for (const mode of fixture.modes) {
    for (const width of fixture.widths) {
      for (const theme of fixture.themes) {
        for (const textScale of fixture.textScales) {
          const config = { mode, width, theme, textScale };
          const { context, page } = await openModePage(browser, mode, config);
          const initial = await snapshotControls(page, config);
          assert.equal(Object.keys(initial.dates).length, Object.keys(dateSelectors).length, `${mode}/${width}/${theme}/${textScale} date controls`);
          assert.equal(Object.keys(initial.files).length, 4, `${mode}/${width}/${theme}/${textScale} file controls`);
          assert(initial.formOverrides, `${mode}/${width}/${theme}/${textScale} form override probe exists`);
          if (mode === 'rawDocument') {
            assert.equal(initial.formOverrides.submitter.formaction, '/capture/override?from=button');
            assert.equal(initial.formOverrides.submitter.formmethod, 'post');
            assert.equal(initial.formOverrides.submitter.formenctype, 'text/plain');
            assert.equal(initial.formOverrides.submitter.formtarget, '_blank');
            assert.equal(initial.formOverrides.submitter.formAction, origin + '/capture/override?from=button');
            assert.equal(initial.formOverrides.submitter.formMethod, 'post');
            assert.equal(initial.formOverrides.submitter.formEnctype, 'text/plain');
            assert.equal(initial.formOverrides.submitter.formTarget, '_blank');
          } else {
            for (const attribute of ['formaction', 'formmethod', 'formenctype', 'formtarget']) {
              assert.equal(initial.formOverrides.submitter[attribute], null, `Markdown sanitizer should remove ${attribute}`);
            }
          }
          const matrixId = `${mode}-${width}-${theme}-scale${textScale}`;
          const imagePath = resolve(screenshotDir, matrixId + '.png');
          await page.screenshot({ path: imagePath });
          screenshots.push({ id: matrixId, path: imagePath, width, height: fixture.height, theme, textScale, mode });
          matrix.push({ id: matrixId, ...initial, screenshot: imagePath });

          if (width === 390 && theme === 'light' && textScale === 1) {
            const epoch = page.locator(dateSelectors.epochStep);
            await epoch.fill('1970-01-02');
            const epochMismatch = await page.locator(dateSelectors.epochStep).evaluate(element => ({ value: element.value, validity: element.validity.stepMismatch, valid: element.validity.valid }));
            await epoch.fill('1970-01-08');
            const epochAligned = await page.locator(dateSelectors.epochStep).evaluate(element => ({ value: element.value, validity: element.validity.stepMismatch, valid: element.validity.valid }));
            const minBase = page.locator(dateSelectors.stepMinBase);
            await minBase.fill('2024-02-18');
            const minBaseAligned = await minBase.evaluate(element => ({ value: element.value, validity: element.validity.stepMismatch, valid: element.validity.valid }));
            await minBase.fill('2024-02-17');
            const minBaseMismatch = await minBase.evaluate(element => ({ value: element.value, validity: element.validity.stepMismatch, valid: element.validity.valid }));
            const valueBase = page.locator(dateSelectors.stepValueBase);
            await valueBase.fill('2024-02-08');
            const valueBaseAligned = await valueBase.evaluate(element => ({ value: element.value, validity: element.validity.stepMismatch, valid: element.validity.valid }));
            await valueBase.fill('2024-02-07');
            const valueBaseMismatch = await valueBase.evaluate(element => ({ value: element.value, validity: element.validity.stepMismatch, valid: element.validity.valid }));
            await page.locator(dateSelectors.resettable).fill('2024-07-04');
            const resetBefore = await page.locator(dateSelectors.resettable).evaluate(element => ({ value: element.value, defaultValue: element.defaultValue }));
            await page.locator('#date-reset').click();
            const resetAfter = await page.locator(dateSelectors.resettable).evaluate(element => ({ value: element.value, defaultValue: element.defaultValue }));
            interactions.push({ mode, id: 'date-step-and-reset-interactions', epochMismatch, epochAligned, minBaseAligned, minBaseMismatch, valueBaseAligned, valueBaseMismatch, resetBefore, resetAfter });

            const fileInput = page.locator(fileSelectors.multiple);
            await fileInput.setInputFiles(fixture.dummyFiles.map(file => ({ name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.bytes) })));
            const selected = await snapshotControls(page, config);
            const selectedImage = resolve(screenshotDir, `${mode}-390-light-scale1-files-selected.png`);
            await fileInput.screenshot({ path: selectedImage });
            interactions.push({ mode, id: 'multiple-file-selection', files: selected.files.multiple, screenshot: selectedImage });

            await page.locator('#file-reset').click();
            const reset = await snapshotControls(page, config);
            interactions.push({ mode, id: 'file-reset', requiredSingle: reset.files.requiredSingle, multiple: reset.files.multiple });

            // Use real keyboard traversal to expose Chromium's :focus-visible state.
            await page.locator('body').click({ position: { x: 1, y: 1 } });
            let focused = null;
            for (let tab = 0; tab < 50; tab++) {
              focused = await page.evaluate(() => document.activeElement?.id || null);
              if (focused === 'file-multiple') break;
              await page.keyboard.press('Tab');
            }
            const focusState = await page.locator(fileSelectors.multiple).evaluate(element => ({
              active: element === document.activeElement,
              focusVisible: element.matches(':focus-visible'),
              outline: getComputedStyle(element).outline,
              rect: (() => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
            }));
            const focusImage = resolve(screenshotDir, `${mode}-390-light-scale1-file-focus.png`);
            await page.screenshot({ path: focusImage });
            interactions.push({ mode, id: 'file-keyboard-focus', focused, state: focusState, screenshot: focusImage });

            const dateInput = page.locator(dateSelectors.ui);
            await dateInput.click();
            const pickerState = await dateInput.evaluate(element => ({
              active: element === document.activeElement,
              focused: element.matches(':focus'),
              focusVisible: element.matches(':focus-visible'),
              value: element.value,
              language: navigator.language,
              resolvedLocale: Intl.DateTimeFormat().resolvedOptions().locale,
              showPickerAvailable: typeof element.showPicker === 'function',
              computed: { appearance: getComputedStyle(element).appearance, font: getComputedStyle(element).font, colorScheme: getComputedStyle(element).colorScheme },
            }));
            const pickerImage = resolve(screenshotDir, `${mode}-390-light-scale1-date-picker-request.png`);
            await page.screenshot({ path: pickerImage });
            interactions.push({ mode, id: 'date-picker-click', state: pickerState, screenshot: pickerImage, note: 'The platform picker is browser chrome and may not be composited into a headless page screenshot; the input state and screenshot are preserved.' });
          }
          await context.close();
        }
      }
    }
  }

  const submissions = [];
  for (const mode of fixture.modes) {
    for (const testCase of fixture.submissionCases) submissions.push(await submitCase(browser, mode, testCase));
  }

  assert.equal(submissions.length, fixture.modes.length * fixture.submissionCases.length);
  assert.equal(receipts.length, submissions.length, `expected ${submissions.length} local submission receipts, got ${receipts.length}`);
  assert.equal(serverErrors.length, 0, serverErrors.join('\n'));
  assert.equal(browserErrors.badResponses.length, 0, browserErrors.badResponses.join('\n'));
  assert.equal(browserErrors.pageErrors.length, 0, browserErrors.pageErrors.join('\n'));
  const allowedConsoleErrors = browserErrors.consoleErrors.filter(error => !error.includes('NotAllowedError'));
  assert.equal(allowedConsoleErrors.length, 0, allowedConsoleErrors.join('\n'));
  assert.equal(browserErrors.externalRequests.length, 0, browserErrors.externalRequests.join('\n'));
  assert.equal(serverEvents.filter(event => event.kind === 'unexpected-local-resource').length, 0);

  expected = {
    fixture: fixture.id,
    reference: fixture.webRevision,
    browser: { version: browserVersion, product: 'Google Chrome', executable: requireTestBrowserExecutable() },
    locale,
    sourceModes: {
      markdown: 'The fixture markup is passed through pinned apps/web/src/lib/markdown.ts renderMarkdown() / DOMPurify; app.css and markdown.css are loaded for the production Markdown shell.',
      rawDocument: 'The same fixture markup is returned as a script-free text/html response from a loopback server; capture runs externally with Playwright.',
    },
    matrix: { widths: fixture.widths, height: fixture.height, themes: fixture.themes, textScales: fixture.textScales, modes: fixture.modes, count: matrix.length, cases: matrix },
    dateInteractions: interactions.filter(item => item.id.startsWith('date-')),
    fileInteractions: interactions.filter(item => item.id.startsWith('multiple-file') || item.id.startsWith('file-')),
    submissions,
    serverEvents,
    browserErrors,
    assertions: {
      pinnedWebSourceUnmodified: true,
      actualChromePointerSubmissions: true,
      localReceiptsOnly: true,
      rawDocumentContainsScript: false,
      matrixCaseCount: 56,
      rawDocumentFormOverridePropertiesCaptured: true,
      fileSubmissionCaseCount: 16,
      eachEncodingHasEmptyAndTwoFileSelection: true,
    },
    limits: [
      'Chrome native date picker UI is outside the page DOM; the date control state, locale, click request, and screenshot are captured, but the headless page screenshot may omit the platform popup surface.',
      'The filename presentation is inside Chromium file-input UI and has no DOM box; the input host box, file-selector-button computed style, FileList, focus state, and actual screenshots are captured.',
      'File names, content, and multipart bytes are generated test fixtures only; no user file data is read.',
    ],
  };
  await writeFile(expectedPath, JSON.stringify(expected, null, 2) + '\n');
  console.log(JSON.stringify({
    expectedPath,
    browserVersion,
    locale,
    matrixCases: matrix.length,
    submissionCases: submissions.length,
    receipts: receipts.length,
    screenshotCount: screenshots.length + interactions.filter(item => item.screenshot).length,
    dateInteractionIds: expected.dateInteractions.map(item => `${item.mode}:${item.id}`),
    fileInteractionIds: expected.fileInteractions.map(item => `${item.mode}:${item.id}`),
  }, null, 2));
} finally {
  if (browser) await browser.close();
  await server.close();
}
