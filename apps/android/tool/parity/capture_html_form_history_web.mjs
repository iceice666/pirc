import { requireTestBrowserExecutable } from './test_browser.mjs';
// Run from repository root:
// node apps/android/tool/parity/capture_html_form_history_web.mjs
// Uses actual Chrome over a real loopback HTTP server. No Playwright route/fulfill.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const fixturePath = resolve(root, 'fixtures/mobile-parity/html-form-history.json');
const expectedPath = resolve(root, 'fixtures/mobile-parity/html-form-history-expected.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixture.cases.length, 2);
assert.equal(fixture.fileBytes.length, 2);
assert.equal(fixture.postCases.length, 2);
const allCaseById = new Map([...fixture.cases, ...fixture.postCases].map(item => [item.id, item]));
const require = createRequire(resolve(root, 'apps/gateway/package.json'));
const { chromium } = require('playwright-core');
const origin = 'http://127.0.0.1:18936';
const screenshotDir = resolve(root, 'apps/android/build/parity/html-form-history');
await mkdir(screenshotDir, { recursive: true });

const requestCounts = new Map(fixture.cases.map(item => [item.id, 0]));
const postCounts = new Map(fixture.postCases.map(item => [item.id, { posts: 0, gets: 0 }]));
const serverReceipts = [];
const serverErrors = [];
const browserErrors = { pageErrors: [], consoleErrors: [], unexpectedRequests: [], badResponses: [] };
const safeRequestHeaders = headers => Object.fromEntries(
  ['accept', 'cache-control', 'pragma', 'referer', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site']
    .filter(name => headers[name] !== undefined)
    .map(name => [name, String(headers[name])]),
);

const htmlEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function historyDocument(item, version) {
  const suffix = version === 'v1' ? 'v1' : 'v2';
  const date = version === 'v1' ? '2024-02-29' : '2031-03-04';
  const body = `<!doctype html><html lang="en-US"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(item.id)} ${suffix}</title></head><body>
    <main>
      <h1>HTML form history state</h1>
      <p id="server-version">Server version ${suffix}</p>
      <form id="state-form">
        <label>Valid date <input id="valid-date" type="date" name="validDate" autocomplete="off" value="${date}"></label>
        <label>Default-autocomplete date <input id="default-autocomplete-date" type="date" name="defaultAutocompleteDate" value="${version === 'v1' ? '2024-03-10' : '2032-04-11'}"></label>
        <label>Pristine date <input id="pristine-date" type="date" name="pristineDate" value="${version === 'v1' ? '2024-04-12' : '2032-05-13'}"></label>
        <label>Returned-to-default date <input id="reverted-date" type="date" name="revertedDate" value="${version === 'v1' ? '2024-05-15' : '2033-06-16'}"></label>
        <label>Partial date <input id="partial-date" type="date" name="partialDate"></label>
        <label>Regular text <input id="regular-text" name="regularText" value="regular-${suffix}"></label>
        <label>Autocomplete off <input id="autocomplete-off" name="autocompleteOff" autocomplete="off" value="off-${suffix}"></label>
        <label>Disabled text <input id="disabled-text" name="disabledText" disabled value="disabled-${suffix}"></label>
        <label>Readonly text <input id="readonly-text" name="readonlyText" readonly value="readonly-${suffix}"></label>
        <label>Password <input id="password" type="password" name="password" value="password-${suffix}"></label>
        <label>Password autocomplete off <input id="password-off" type="password" name="passwordOff" autocomplete="off" value="password-off-${suffix}"></label>
        <label>Pristine default <input id="pristine-text" name="pristineText" value="pristine-${suffix}"></label>
        <label>Changed back to default <input id="returned-default" name="returnedDefault" value="returned-${suffix}"></label>
        <label>Multiple select <select id="multi-select" name="multiSelect" multiple><option value="alpha"${version === 'v1' ? ' selected' : ''}>Alpha</option><option value="beta">Beta</option><option value="gamma"${version === 'v2' ? ' selected' : ''}>Gamma</option></select></label>
        <label><input id="checkbox" type="checkbox" name="checkbox" value="checked"> Checkbox</label>
        <fieldset><legend>Radio group</legend><label><input id="radio-a" type="radio" name="radio" value="a" checked> A</label><label><input id="radio-b" type="radio" name="radio" value="b"> B</label></fieldset>
        <label>Range <input id="range" type="range" name="range" min="0" max="100" step="1" value="${version === 'v1' ? '20' : '25'}"></label>
        <label>Two files <input id="files" type="file" name="upload" multiple></label>
      </form>
      <a id="continue" href="/history-next?case=${encodeURIComponent(item.id)}">Open next document</a>
    </main>
  </body></html>`;
  return body;
}

function sendHtml(response, body, headers = {}) {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(body);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', origin);
    if (url.pathname === '/favicon.ico') {
      response.statusCode = 204;
      response.end();
      return;
    }
    const caseItem = allCaseById.get(url.searchParams.get('case'));
    if (url.pathname === '/history' && request.method === 'GET' && fixture.cases.some(item => item.id === caseItem?.id)) {
      const requestNumber = (requestCounts.get(caseItem.id) ?? 0) + 1;
      requestCounts.set(caseItem.id, requestNumber);
      const version = requestNumber === 1 ? 'v1' : 'v2';
      const body = historyDocument(caseItem, version);
      const responseHeaders = { 'cache-control': caseItem.cacheControl, 'content-type': 'text/html; charset=utf-8' };
      serverReceipts.push({
        caseId: caseItem.id,
        requestNumber,
        method: request.method,
        url: request.url,
        requestHeaders: safeRequestHeaders(request.headers),
        responseStatus: 200,
        responseHeaders,
        servedVersion: version,
        documentBytes: Buffer.byteLength(body),
      });
      sendHtml(response, body, responseHeaders);
      return;
    }
    if (url.pathname === '/history-next' && request.method === 'GET' && caseItem) {
      const body = `<!doctype html><html lang="en-US"><head><meta charset="utf-8"><title>Next document</title></head><body><main><h1 id="next-document">Next document</h1><p>Case ${htmlEscape(caseItem.id)}</p></main></body></html>`;
      serverReceipts.push({
        caseId: caseItem.id,
        method: request.method,
        url: request.url,
        requestHeaders: safeRequestHeaders(request.headers),
        responseStatus: 200,
        responseHeaders: { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' },
        servedVersion: 'next',
        documentBytes: Buffer.byteLength(body),
      });
      sendHtml(response, body);
      return;
    }
    if (url.pathname === '/post-entry' && request.method === 'GET' && fixture.postCases.some(item => item.id === caseItem?.id)) {
      const blockQuery = caseItem.blockPostResponseBackForwardCache ? '&blockBfCache=1' : '';
      const body = `<!doctype html><html lang="en-US"><head><meta charset="utf-8"><title>POST entry ${htmlEscape(caseItem.id)}</title></head><body><main><h1>Submit a real POST</h1><form id="post-start" method="post" action="/post-result?case=${encodeURIComponent(caseItem.id)}${blockQuery}"><input type="hidden" name="fixture" value="cacheable-post-body"><button id="post-submit" type="submit">Submit POST</button></form></main></body></html>`;
      serverReceipts.push({
        caseId: caseItem.id,
        kind: 'post-entry',
        method: request.method,
        url: request.url,
        requestHeaders: safeRequestHeaders(request.headers),
        responseStatus: 200,
        responseHeaders: { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' },
      });
      sendHtml(response, body);
      return;
    }
    if (url.pathname === '/post-result' && fixture.postCases.some(item => item.id === caseItem?.id)) {
      if (request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const requestBody = Buffer.concat(chunks);
        const counts = postCounts.get(caseItem.id);
        counts.posts += 1;
        const version = counts.posts === 1 ? 'v1' : 'v2';
        const body = historyDocument(caseItem, version);
        const responseHeaders = {
          'cache-control': caseItem.responseCacheControl,
          'content-location': url.pathname + url.search,
          'content-type': 'text/html; charset=utf-8',
        };
        serverReceipts.push({
          caseId: caseItem.id,
          kind: 'post-response',
          requestNumber: counts.posts,
          method: request.method,
          url: request.url,
          requestHeaders: safeRequestHeaders(request.headers),
          requestBodyBytes: requestBody.length,
          requestBodyUtf8: requestBody.toString('utf8'),
          requestBodyBase64: requestBody.toString('base64'),
          responseStatus: 200,
          responseHeaders,
          servedVersion: version,
          documentBytes: Buffer.byteLength(body),
        });
        sendHtml(response, body, responseHeaders);
        return;
      }
      if (request.method === 'GET') {
        const counts = postCounts.get(caseItem.id);
        counts.gets += 1;
        const body = historyDocument(caseItem, 'v2');
        serverReceipts.push({
          caseId: caseItem.id,
          kind: 'post-response-get',
          requestNumber: counts.gets,
          method: request.method,
          url: request.url,
          requestHeaders: safeRequestHeaders(request.headers),
          responseStatus: 200,
          responseHeaders: { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' },
          servedVersion: 'v2',
          documentBytes: Buffer.byteLength(body),
        });
        sendHtml(response, body);
        return;
      }
    }
    serverReceipts.push({ caseId: caseItem?.id ?? null, method: request.method, url: request.url, responseStatus: 404 });
    response.statusCode = 404;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('Unexpected local request');
  } catch (error) {
    serverErrors.push(String(error?.stack || error));
    response.statusCode = 500;
    response.end('local history capture error');
  }
});

async function listen() {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(18936, '127.0.0.1', resolveListen);
  });
}

function metadataInitScript() {
  const blockUrl = new URL(location.href).searchParams.get('blockBfCache') === '1';
  const metadata = {
    documentToken: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    documentStartUrl: location.href,
    pageShows: [],
    pageHides: [],
    testOnlyBfCacheBlocker: blockUrl ? 'unload listener injected by Playwright init script' : null,
  };
  Object.defineProperty(window, '__historyProbe', { value: metadata, configurable: true });
  addEventListener('pageshow', event => metadata.pageShows.push({ persisted: event.persisted, url: location.href }));
  addEventListener('pagehide', event => metadata.pageHides.push({ persisted: event.persisted, url: location.href }));
  if (blockUrl) addEventListener('unload', () => {});
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const control = id => {
      const element = document.getElementById(id);
      if (!element) return null;
      const validity = element.validity ? Object.fromEntries(
        ['badInput', 'rangeOverflow', 'rangeUnderflow', 'stepMismatch', 'valueMissing', 'valid']
          .map(name => [name, element.validity[name]]),
      ) : null;
      return {
        id: element.id,
        type: element.type || null,
        name: element.name || null,
        value: 'value' in element ? element.value : null,
        defaultValue: 'defaultValue' in element ? element.defaultValue : null,
        valueAttribute: element.getAttribute('value'),
        checked: 'checked' in element ? element.checked : null,
        defaultChecked: 'defaultChecked' in element ? element.defaultChecked : null,
        autocomplete: element.autocomplete || null,
        min: element.min ?? null,
        max: element.max ?? null,
        step: element.step ?? null,
        disabled: element.matches(':disabled'),
        readOnly: !!element.readOnly,
        focused: element === document.activeElement,
        validity,
      };
    };
    const fileInput = document.querySelector('#files');
    const files = [];
    for (const file of [...(fileInput?.files ?? [])]) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      files.push({
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
        bytesBase64: btoa(binary),
      });
    }
    return {
      url: location.href,
      title: document.title,
      bodyVersion: document.querySelector('#server-version')?.textContent?.trim() ?? null,
      navigationType: performance.getEntriesByType('navigation')[0]?.type ?? null,
      documentToken: window.__historyProbe?.documentToken ?? null,
      documentStartUrl: window.__historyProbe?.documentStartUrl ?? null,
      pageShows: window.__historyProbe?.pageShows ?? [],
      pageHides: window.__historyProbe?.pageHides ?? [],
      testOnlyBfCacheBlocker: window.__historyProbe?.testOnlyBfCacheBlocker ?? null,
      historyLength: history.length,
      controls: {
        validDate: control('valid-date'),
        defaultAutocompleteDate: control('default-autocomplete-date'),
        pristineDate: control('pristine-date'),
        revertedDate: control('reverted-date'),
        partialDate: control('partial-date'),
        regularText: control('regular-text'),
        autocompleteOffText: control('autocomplete-off'),
        disabledText: control('disabled-text'),
        readonlyText: control('readonly-text'),
        password: control('password'),
        passwordOff: control('password-off'),
        pristineText: control('pristine-text'),
        returnedDefaultText: control('returned-default'),
        multiSelect: (() => {
          const select = document.querySelector('#multi-select');
          return select ? {
            id: select.id,
            name: select.name,
            multiple: select.multiple,
            value: select.value,
            selectedValues: [...select.selectedOptions].map(option => option.value),
            options: [...select.options].map(option => ({ value: option.value, selected: option.selected, defaultSelected: option.defaultSelected })),
            disabled: select.matches(':disabled'),
          } : null;
        })(),
        checkbox: control('checkbox'),
        radioA: control('radio-a'),
        radioB: control('radio-b'),
        range: control('range'),
        files: {
          id: fileInput?.id ?? null,
          disabled: fileInput?.matches(':disabled') ?? null,
          multiple: fileInput?.multiple ?? null,
          count: fileInput?.files?.length ?? null,
          entries: files,
        },
      },
    };
  });
}

async function prepareProbeState(page, item) {
  await page.locator('#valid-date').fill('2025-12-31');
  await page.locator('#default-autocomplete-date').fill('2025-10-30');
  await page.locator('#reverted-date').fill('2026-01-09');
  await page.locator('#reverted-date').fill('2024-05-15');
  await page.locator('#regular-text').fill('typed regular text');
  await page.locator('#autocomplete-off').fill('typed autocomplete off');
  await page.locator('#password').fill('typed-probe-password');
  await page.locator('#password-off').fill('typed-probe-password-off');
  await page.locator('#returned-default').fill('temporary value');
  await page.locator('#returned-default').fill('returned-v1');
  await page.locator('#multi-select').selectOption(['beta', 'gamma']);
  await page.locator('#checkbox').check();
  await page.locator('#radio-b').check();
  const range = page.locator('#range');
  await range.focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < 73; i++) await page.keyboard.press('ArrowRight');
  assert.equal(await range.inputValue(), '73', `${item.id}: range keyboard probe should reach value 73`);
  // Script-only values establish whether BFCache keeps the same live document.
  // They do not imply that the production app should execute scripts.
  await page.locator('#disabled-text').evaluate(element => { element.value = 'script-only-disabled-live'; });
  await page.locator('#readonly-text').evaluate(element => { element.value = 'script-only-readonly-live'; });
  await page.locator('#partial-date').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('03');
  await page.locator('#files').setInputFiles(fixture.fileBytes.map(file => ({
    name: file.name,
    mimeType: file.mimeType,
    buffer: Buffer.from(file.bytes),
  })));
  const before = await snapshot(page);
  assert.deepEqual(before.controls.files.entries.map(file => ({
    name: file.name,
    type: file.type,
    size: file.size,
    bytesBase64: file.bytesBase64,
  })), fixture.fileBytes.map(file => ({
    name: file.name,
    type: file.mimeType,
    size: file.bytes.length,
    bytesBase64: Buffer.from(file.bytes).toString('base64'),
  })), `${item.id}: selected FileList should match fixture names/types/bytes in order`);
  return before;
}

async function captureCase(browser, item) {
  const context = await browser.newContext({
    viewport: { width: fixture.width, height: fixture.height },
    deviceScaleFactor: 1,
    isMobile: fixture.context.isMobile,
    hasTouch: fixture.context.hasTouch,
    locale: 'en-US',
    colorScheme: 'light',
  });
  await context.addInitScript(metadataInitScript);
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.pageErrors.push(`${item.id}: ${error.stack || error.message}`));
  page.on('console', message => { if (message.type() === 'error') browserErrors.consoleErrors.push(`${item.id}: ${message.text()}`); });
  page.on('request', request => {
    if (!request.url().startsWith(origin + '/') && !request.url().startsWith('data:')) browserErrors.unexpectedRequests.push(`${item.id}: ${request.url()}`);
  });
  page.on('response', response => { if (response.status() >= 400) browserErrors.badResponses.push(`${item.id}: ${response.status()} ${response.url()}`); });

  const cdp = await context.newCDPSession(page);
  const bfcacheNotUsed = [];
  const lifecycle = [];
  const networkEvents = [];
  cdp.on('Page.backForwardCacheNotUsed', event => bfcacheNotUsed.push(event));
  cdp.on('Page.lifecycleEvent', event => {
    if (['init', 'DOMContentLoaded', 'load', 'pageshow', 'pagehide'].includes(event.name)) lifecycle.push({ name: event.name, loaderId: event.loaderId });
  });
  cdp.on('Network.requestWillBeSent', event => {
    if (event.type === 'Document' && event.request.url.startsWith(origin + '/')) {
      networkEvents.push({
        event: 'requestWillBeSent',
        requestId: event.requestId,
        loaderId: event.loaderId,
        method: event.request.method,
        url: event.request.url,
        type: event.type,
        redirectFromResponse: event.redirectResponse ? {
          status: event.redirectResponse.status,
          fromDiskCache: event.redirectResponse.fromDiskCache ?? false,
        } : null,
      });
    }
  });
  cdp.on('Network.responseReceived', event => {
    if (event.type === 'Document' && event.response.url.startsWith(origin + '/')) {
      networkEvents.push({
        event: 'responseReceived',
        requestId: event.requestId,
        loaderId: event.loaderId,
        url: event.response.url,
        type: event.type,
        status: event.response.status,
        fromDiskCache: event.response.fromDiskCache,
        fromServiceWorker: event.response.fromServiceWorker,
        fromPrefetchCache: event.response.fromPrefetchCache,
        cacheControl: event.response.headers['cache-control'] ?? event.response.headers['Cache-Control'] ?? null,
        contentLocation: event.response.headers['content-location'] ?? event.response.headers['Content-Location'] ?? null,
      });
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true });
  await cdp.send('Network.enable');

  const startUrl = `${origin}/history?case=${encodeURIComponent(item.id)}${item.blockBackForwardCache ? '&blockBfCache=1' : ''}`;
  await page.goto(startUrl, { waitUntil: 'load' });
  const initial = await snapshot(page);
  assert.equal(initial.bodyVersion, 'Server version v1');
  const before = await prepareProbeState(page, item);
  const beforeScreenshot = resolve(screenshotDir, `${item.id}-before-back.png`);
  await page.screenshot({ path: beforeScreenshot, fullPage: true });

  await page.locator('#continue').click();
  await page.waitForURL(url => url.pathname === '/history-next', { waitUntil: 'load' });
  const nextDocument = {
    url: page.url(),
    title: await page.title(),
    text: await page.locator('body').innerText(),
  };
  await page.evaluate(() => history.back());
  await page.waitForFunction(() => location.pathname === '/history', undefined, { timeout: 15000 });
  await page.waitForTimeout(50);
  const after = await snapshot(page);
  const afterScreenshot = resolve(screenshotDir, `${item.id}-after-back.png`);
  await page.screenshot({ path: afterScreenshot, fullPage: true });

  const result = {
    caseId: item.id,
    configuredCacheControl: item.cacheControl,
    configuredBfCacheBlocker: item.blockBackForwardCache,
    initial,
    beforeNavigation: before,
    nextDocument,
    afterBack: after,
    observations: {
      sameDocumentTokenAfterBack: before.documentToken === after.documentToken,
      backPageShowPersisted: after.pageShows.at(-1)?.persisted ?? null,
      backRequestCount: requestCounts.get(item.id),
      fileListRestoredExactly: JSON.stringify(before.controls.files.entries) === JSON.stringify(after.controls.files.entries),
      fileBytesRestoredExactly: JSON.stringify(before.controls.files.entries.map(file => file.bytesBase64)) === JSON.stringify(after.controls.files.entries.map(file => file.bytesBase64)),
      validDateRestored: before.controls.validDate.value === after.controls.validDate.value,
      defaultAutocompleteDateRestored: before.controls.defaultAutocompleteDate.value === after.controls.defaultAutocompleteDate.value,
      pristineDateRemainedUntouched: before.controls.pristineDate.value === before.controls.pristineDate.defaultValue,
      pristineDateRestored: before.controls.pristineDate.value === after.controls.pristineDate.value,
      revertedDateWasEqualAtCapture: before.controls.revertedDate.value === before.controls.revertedDate.defaultValue,
      revertedDateRestored: before.controls.revertedDate.value === after.controls.revertedDate.value,
      incompleteDateRestored: before.controls.partialDate.badInput === after.controls.partialDate.badInput && before.controls.partialDate.value === after.controls.partialDate.value,
      regularTextRestored: before.controls.regularText.value === after.controls.regularText.value,
      autocompleteOffRestored: before.controls.autocompleteOffText.value === after.controls.autocompleteOffText.value,
      disabledValueRestored: before.controls.disabledText.value === after.controls.disabledText.value,
      readonlyValueRestored: before.controls.readonlyText.value === after.controls.readonlyText.value,
      passwordRestored: before.controls.password.value === after.controls.password.value,
      passwordOffRestored: before.controls.passwordOff.value === after.controls.passwordOff.value,
      pristineTextRemainedUntouched: before.controls.pristineText.value === before.controls.pristineText.defaultValue,
      pristineTextRestored: before.controls.pristineText.value === after.controls.pristineText.value,
      returnedToDefaultWasEqualAtCapture: before.controls.returnedDefaultText.value === before.controls.returnedDefaultText.defaultValue,
      returnedToDefaultRestored: before.controls.returnedDefaultText.value === after.controls.returnedDefaultText.value,
      multiSelectRestored: JSON.stringify(before.controls.multiSelect.selectedValues) === JSON.stringify(after.controls.multiSelect.selectedValues),
      checkboxRestored: before.controls.checkbox.checked === after.controls.checkbox.checked,
      radioSelectionRestored: (before.controls.radioA.checked === after.controls.radioA.checked) && (before.controls.radioB.checked === after.controls.radioB.checked),
      rangeRestored: before.controls.range.value === after.controls.range.value,
      screenshots: { before: beforeScreenshot, afterBack: afterScreenshot },
    },
    bfcacheNotUsed,
    cdpLifecycle: lifecycle,
    cdpDocumentNetworkEvents: networkEvents,
  };
  await cdp.detach();
  await context.close();
  return result;
}

async function capturePostCase(browser, item) {
  const context = await browser.newContext({
    viewport: { width: fixture.width, height: fixture.height },
    deviceScaleFactor: 1,
    isMobile: fixture.context.isMobile,
    hasTouch: fixture.context.hasTouch,
    locale: 'en-US',
    colorScheme: 'light',
  });
  await context.addInitScript(metadataInitScript);
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.pageErrors.push(`${item.id}: ${error.stack || error.message}`));
  page.on('console', message => { if (message.type() === 'error') browserErrors.consoleErrors.push(`${item.id}: ${message.text()}`); });
  page.on('request', request => {
    if (!request.url().startsWith(origin + '/') && !request.url().startsWith('data:')) browserErrors.unexpectedRequests.push(`${item.id}: ${request.url()}`);
  });
  page.on('response', response => { if (response.status() >= 400) browserErrors.badResponses.push(`${item.id}: ${response.status()} ${response.url()}`); });

  const cdp = await context.newCDPSession(page);
  const bfcacheNotUsed = [];
  const lifecycle = [];
  const networkEvents = [];
  cdp.on('Page.backForwardCacheNotUsed', event => bfcacheNotUsed.push(event));
  cdp.on('Page.lifecycleEvent', event => {
    if (['init', 'DOMContentLoaded', 'load', 'pageshow', 'pagehide'].includes(event.name)) lifecycle.push({ name: event.name, loaderId: event.loaderId });
  });
  cdp.on('Network.requestWillBeSent', event => {
    if (event.type === 'Document' && event.request.url.startsWith(origin + '/')) {
      networkEvents.push({
        event: 'requestWillBeSent',
        requestId: event.requestId,
        loaderId: event.loaderId,
        method: event.request.method,
        url: event.request.url,
        type: event.type,
        redirectFromResponse: event.redirectResponse ? {
          status: event.redirectResponse.status,
          fromDiskCache: event.redirectResponse.fromDiskCache ?? false,
        } : null,
      });
    }
  });
  cdp.on('Network.responseReceived', event => {
    if (event.type === 'Document' && event.response.url.startsWith(origin + '/')) {
      networkEvents.push({
        event: 'responseReceived',
        requestId: event.requestId,
        loaderId: event.loaderId,
        url: event.response.url,
        type: event.type,
        status: event.response.status,
        fromDiskCache: event.response.fromDiskCache,
        fromServiceWorker: event.response.fromServiceWorker,
        fromPrefetchCache: event.response.fromPrefetchCache,
        cacheControl: event.response.headers['cache-control'] ?? event.response.headers['Cache-Control'] ?? null,
        contentLocation: event.response.headers['content-location'] ?? event.response.headers['Content-Location'] ?? null,
      });
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true });
  await cdp.send('Network.enable');

  await page.goto(`${origin}/post-entry?case=${encodeURIComponent(item.id)}`, { waitUntil: 'load' });
  const entry = { url: page.url(), title: await page.title(), text: await page.locator('body').innerText() };
  await page.locator('#post-submit').click();
  await page.waitForURL(url => url.pathname === '/post-result', { waitUntil: 'load', timeout: 15000 });
  const postInitial = await snapshot(page);
  assert.equal(postInitial.bodyVersion, 'Server version v1', `${item.id}: actual POST response version`);
  const before = await prepareProbeState(page, item);
  const beforeScreenshot = resolve(screenshotDir, `${item.id}-before-back.png`);
  await page.screenshot({ path: beforeScreenshot, fullPage: true });

  await page.locator('#continue').click();
  await page.waitForURL(url => url.pathname === '/history-next', { waitUntil: 'load' });
  const nextDocument = { url: page.url(), title: await page.title(), text: await page.locator('body').innerText() };
  const dialogEvents = [];
  let resolveDialog;
  const dialogSeen = new Promise(resolveDialogSeen => { resolveDialog = resolveDialogSeen; });
  page.once('dialog', async dialog => {
    const detail = { type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue() };
    dialogEvents.push(detail);
    await dialog.dismiss();
    resolveDialog(detail);
  });
  const targetWait = page.waitForFunction(() =>
    location.pathname === '/post-result' ||
    location.protocol === 'chrome-error:' ||
    document.documentElement?.innerText?.includes('ERR_CACHE_MISS') === true,
  undefined, { timeout: 10000 }).then(() => 'target-document').catch(() => 'timeout');
  await page.evaluate(() => history.back());
  const navigationOutcome = await Promise.race([
    targetWait,
    dialogSeen.then(() => 'dialog-dismissed'),
    new Promise(resolveTimeout => setTimeout(() => resolveTimeout('timeout'), 10500)),
  ]);
  if (navigationOutcome === 'target-document') await page.waitForTimeout(100);
  let afterBack;
  try {
    afterBack = await snapshot(page);
  } catch (error) {
    afterBack = { url: page.url(), snapshotError: String(error?.message || error), documentToken: null, pageShows: [], controls: null };
  }
  let visibleBodyText = null;
  try { visibleBodyText = await page.locator('body').innerText({ timeout: 2000 }); } catch { /* internal error page may not expose a body */ }
  const afterScreenshot = resolve(screenshotDir, `${item.id}-after-back.png`);
  try { await page.screenshot({ path: afterScreenshot, fullPage: true, timeout: 4000 }); } catch (error) { afterBack.screenshotError = String(error?.message || error); }
  const caseReceipts = serverReceipts.filter(receipt => receipt.caseId === item.id);
  const postResult = {
    caseId: item.id,
    source: 'real HTML form method=post navigation to same-origin server response',
    postResponseCacheControl: item.responseCacheControl,
    contentLocation: `${origin}/post-result?case=${encodeURIComponent(item.id)}${item.blockPostResponseBackForwardCache ? '&blockBfCache=1' : ''}`,
    testOnlyPostResponseBfCacheBlocker: item.blockPostResponseBackForwardCache ? 'unload listener injected by Playwright init script when the POST result document loads' : null,
    entry,
    postResponseBeforeEdit: postInitial,
    beforeNavigation: before,
    nextDocument,
    navigationOutcome,
    dialogEvents,
    afterBack,
    visibleBodyText,
    observations: {
      sameDocumentTokenAfterBack: before.documentToken === afterBack.documentToken,
      backPageShowPersisted: afterBack.pageShows?.at(-1)?.persisted ?? null,
      postRequestCount: caseReceipts.filter(receipt => receipt.kind === 'post-response').length,
      postResultGetCount: caseReceipts.filter(receipt => receipt.kind === 'post-response-get').length,
      backReusedLiveDocument: before.documentToken === afterBack.documentToken && (afterBack.pageShows?.at(-1)?.persisted ?? false),
      backUsedNewDocumentWithoutNetworkRequest: before.documentToken !== afterBack.documentToken && !caseReceipts.some(receipt => receipt.kind === 'post-response-get' || (receipt.kind === 'post-response' && receipt.requestNumber > 1)),
      restoredFileListExactly: !!afterBack.controls && JSON.stringify(before.controls.files.entries) === JSON.stringify(afterBack.controls.files.entries),
      restoredDate: afterBack.controls?.defaultAutocompleteDate?.value === before.controls.defaultAutocompleteDate.value,
      restoredPassword: afterBack.controls?.password?.value === before.controls.password.value,
      restoredAutocompleteOffText: afterBack.controls?.autocompleteOffText?.value === before.controls.autocompleteOffText.value,
      receipts: caseReceipts,
      screenshots: { before: beforeScreenshot, afterBack: afterScreenshot },
    },
    bfcacheNotUsed,
    cdpLifecycle: lifecycle,
    cdpDocumentNetworkEvents: networkEvents,
  };
  await cdp.detach();
  await context.close();
  return postResult;
}

let browser;
try {
  await listen();
  browser = await chromium.launch({
    executablePath: requireTestBrowserExecutable(),
    headless: true,
    // Playwright disables BFCache by default; remove only that switch.
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
  });
  const browserVersion = await browser.version();
  assert(browserVersion.startsWith('154.'), `Expected pinned Chrome 154, got ${browserVersion}`);
  const cases = [];
  for (const item of fixture.cases) cases.push(await captureCase(browser, item));
  const postCases = [];
  for (const item of fixture.postCases) postCases.push(await capturePostCase(browser, item));
  for (const item of postCases) {
    assert.equal(item.observations.postRequestCount, 1, `${item.caseId}: one actual POST should create the response`);
  }
  assert.equal(serverErrors.length, 0, serverErrors.join('\n'));
  assert.equal(browserErrors.pageErrors.length, 0, browserErrors.pageErrors.join('\n'));
  assert.equal(browserErrors.badResponses.length, 0, browserErrors.badResponses.join('\n'));
  assert.equal(browserErrors.unexpectedRequests.length, 0, browserErrors.unexpectedRequests.join('\n'));
  assert.equal(serverReceipts.filter(item => item.responseStatus >= 400).length, 0);

  const result = {
    fixture: fixture.id,
    browser: {
      product: 'Google Chrome',
      version: browserVersion,
      executable: requireTestBrowserExecutable(),
      playwrightDefaultBfCacheDisableFlagRemoved: '--disable-back-forward-cache',
      httpRouting: false,
    },
    viewport: { width: fixture.width, height: fixture.height, deviceScaleFactor: 1, locale: 'en-US', ...fixture.context },
    partialDateMethod: 'Real Chrome date-input keyboard editing after selecting and clearing its segments; state recorded through value/badInput and screenshots.',
    stateInteractionMethod: {
      editedByBrowserActions: ['autocomplete=off date', 'default-autocomplete date', 'partial date segment', 'regular text', 'autocomplete=off text', 'password with default autocomplete', 'password autocomplete=off', 'returned-to-default date', 'returned-to-default text', 'multiple select', 'checkbox', 'radio', 'range'],
      scriptOnlyProbeValues: ['disabled text', 'readonly text'],
      scriptOnlyProbeNote: 'The test mutates disabled/readonly values only to identify same-document preservation; it does not imply production JavaScript execution.',
      pristineDate: 'The date field was not interacted with; value equals defaultValue at the before-navigation snapshot.',
      pristineText: 'The field was not interacted with; value equals defaultValue at the before-navigation snapshot.',
      returnedDefaultDateAndText: 'Each field was edited away and then typed back to its default string; the internal dirty-value flag is not directly observable.',
    },
    filePayloads: fixture.fileBytes.map(file => ({ name: file.name, type: file.mimeType, size: file.bytes.length, bytesBase64: Buffer.from(file.bytes).toString('base64') })),
    cases,
    postCases,
    serverReceipts,
    browserErrors,
    assertions: {
      onlyLoopbackRequests: true,
      noPlaywrightRouteOrFulfill: true,
      backForwardCacheEnabledInLaunch: true,
      fileSelectionContainsTwoFixtureFilesBeforeNavigation: cases.every(item => item.beforeNavigation.controls.files.entries.length === 2),
      fileListNamesTypesAndBytesMatchFixture: true,
      eachPostResponseWasCreatedByOneRealPost: postCases.every(item => item.observations.postRequestCount === 1),
    },
    limits: [
      'The BFCache blocker control adds an unload event listener from the Playwright init script only; it is explicitly not evidence that Cache-Control:no-store alone forces a network GET.',
      'Date segment text is browser-internal. The capture records actual value, badInput, focused state, and screenshots; it does not infer segment contents from the empty value.',
    ],
  };
  await writeFile(expectedPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({
    expectedPath,
    browserVersion,
    requestCounts: Object.fromEntries(requestCounts),
    postCounts: Object.fromEntries(postCounts),
    cases: cases.map(item => ({
      caseId: item.caseId,
      afterBackVersion: item.afterBack.bodyVersion,
      sameDocumentTokenAfterBack: item.observations.sameDocumentTokenAfterBack,
      backPageShowPersisted: item.observations.backPageShowPersisted,
      backRequestCount: item.observations.backRequestCount,
      beforeFiles: item.beforeNavigation.controls.files.entries.map(file => ({ name: file.name, size: file.size })),
      afterFiles: item.afterBack.controls.files.entries.map(file => ({ name: file.name, size: file.size })),
      incompleteDateBefore: item.beforeNavigation.controls.partialDate,
      incompleteDateAfter: item.afterBack.controls.partialDate,
      controlsAfterBack: Object.fromEntries(['validDate', 'defaultAutocompleteDate', 'pristineDate', 'revertedDate', 'partialDate', 'password', 'passwordOff', 'pristineText', 'returnedDefaultText', 'multiSelect', 'checkbox', 'radioA', 'radioB', 'range', 'disabledText', 'readonlyText', 'autocompleteOffText'].map(name => [name, item.afterBack.controls[name]])),
    })),
    postCases: postCases.map(item => ({
      caseId: item.caseId,
      navigationOutcome: item.navigationOutcome,
      afterBackUrl: item.afterBack.url,
      afterBackTitle: item.afterBack.title,
      afterBackBodyVersion: item.afterBack.bodyVersion,
      sameDocumentTokenAfterBack: item.observations.sameDocumentTokenAfterBack,
      backPageShowPersisted: item.observations.backPageShowPersisted,
      postRequestCount: item.observations.postRequestCount,
      postResultGetCount: item.observations.postResultGetCount,
      restoredFileCount: item.afterBack.controls?.files?.count ?? null,
      restoredFiles: item.afterBack.controls?.files?.entries?.map(file => ({ name: file.name, size: file.size, bytesBase64: file.bytesBase64 })) ?? null,
      date: item.afterBack.controls?.defaultAutocompleteDate ?? null,
      password: item.afterBack.controls?.password ?? null,
      autocompleteOffText: item.afterBack.controls?.autocompleteOffText ?? null,
      dialogEvents: item.dialogEvents,
      bfcacheNotUsed: item.bfcacheNotUsed,
    })),
  }, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
