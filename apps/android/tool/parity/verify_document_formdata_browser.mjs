import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const fixturePath = path.join(
  repositoryRoot,
  'apps/android/integration_test/document_formdata_fixture.dart',
);
const fixtureSource = readFileSync(fixturePath, 'utf8');
const htmlMatch = fixtureSource.match(
  /const formDataHtml\s*=\s*r'''([\s\S]*?)''';/,
);
assert.ok(htmlMatch, 'Could not extract formDataHtml from the shared fixture.');
const html = htmlMatch[1];
const expectedMatch = fixtureSource.match(
  /const formDataExpectedOracleJson\s*=\s*r'''([\s\S]*?)''';/,
);
assert.ok(expectedMatch, 'Could not extract formDataExpectedOracleJson.');
const expected = JSON.parse(expectedMatch[1]);
const browserExecutable =
  requireTestBrowserExecutable();
assert.ok(existsSync(browserExecutable), 'Missing Chrome executable: ' + browserExecutable);

const requests = [];
const unexpectedLocalRequests = [];
const blockedThirdPartyRequests = [];
const serverErrors = [];
const acceptedRequests = new Set([
  'POST /button-before',
  'GET /request-before',
  'POST /direct-submit',
  'POST /reentry-submit',
]);
let origin = '';

const summarizeFormData = async formData => {
  const entries = [];
  for (const [name, value] of formData.entries()) {
    if (typeof value === 'string') {
      entries.push({name, kind: 'text', value});
      continue;
    }
    const bytes = Buffer.from(await value.arrayBuffer());
    entries.push({
      name,
      kind: 'file',
      filename: value.name,
      mimeType: value.type,
      size: value.size,
      base64: bytes.toString('base64'),
    });
  }
  return entries;
};

const server = createServer((request, response) => {
  void (async () => {
    const requestUrl = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
    if (request.method === 'GET' && requestUrl.pathname === '/fixture') {
      response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      response.end(html);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    const method = String(request.method ?? 'GET');
    if (!acceptedRequests.has(method + ' ' + requestUrl.pathname)) {
      unexpectedLocalRequests.push({method, path: requestUrl.pathname, search: requestUrl.search});
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks);
    const contentTypeHeader = String(request.headers['content-type'] ?? '');
    const contentType = contentTypeHeader
      ? contentTypeHeader.split(';', 1)[0].trim().toLowerCase()
      : null;
    let entries = [];
    if (contentType === 'multipart/form-data') {
      assert.match(contentTypeHeader, /^multipart\/form-data;\s*boundary=.+$/i);
      const parsedRequest = new Request(origin + requestUrl.pathname, {
        method: 'POST',
        headers: {'content-type': contentTypeHeader},
        body: rawBody,
      });
      entries = await summarizeFormData(await parsedRequest.formData());
    } else if (method === 'GET') {
      entries = Array.from(
        new URLSearchParams(requestUrl.search),
        ([name, value]) => ({name, kind: 'text', value}),
      );
    }

    const requestRecord = {
      method,
      path: requestUrl.pathname,
      search: requestUrl.search,
      contentType,
      boundaryCaptured: contentType === 'multipart/form-data' && /boundary=/i.test(contentTypeHeader),
      rawByteLength: rawBody.length,
      rawSha256: createHash('sha256').update(rawBody).digest('hex'),
      entries,
    };
    requests.push(requestRecord);
    const responseText = method + ':' + requestUrl.pathname;
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    response.end(
      '<!doctype html><meta charset="utf-8"><p id="response">DONE:' +
        responseText +
        '</p>',
    );
  })().catch(error => {
    serverErrors.push(String(error && error.stack || error));
    if (!response.headersSent) {
      response.writeHead(500, {'content-type': 'text/plain; charset=utf-8'});
    }
    response.end('local oracle error');
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
origin = 'http://127.0.0.1:' + address.port;
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
  args: ['--disable-gpu'],
});

const waitForRequestCount = async count => {
  const deadline = Date.now() + 10000;
  while (requests.length < count && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(requests.length >= count, 'Timed out waiting for local request ' + count);
};

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === origin) {
      await route.continue();
    } else {
      blockedThirdPartyRequests.push(requestUrl.href);
      await route.abort();
    }
  });

  await page.goto(origin + '/fixture', {waitUntil: 'domcontentloaded'});
  await page.locator('#selected-file').setInputFiles({
    name: 'selected-資料.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([0, 127, 128, 255, 13, 10]),
  });
  await page.locator('#button-submit').click();
  await waitForRequestCount(1);
  await page.waitForFunction(
    () => document.querySelector('iframe[name="button-before-frame"]')
      ?.contentDocument?.querySelector('#response')?.textContent === 'DONE:POST:/button-before',
    undefined,
    {timeout: 10000},
  );

  await page.locator('#request-submit-runner').click();
  await waitForRequestCount(2);
  await page.waitForFunction(
    () => document.querySelector('iframe[name="request-before-frame"]')
      ?.contentDocument?.querySelector('#response')?.textContent === 'DONE:GET:/request-before',
    undefined,
    {timeout: 10000},
  );

  await page.locator('#direct-submit-runner').click();
  await waitForRequestCount(3);
  await page.waitForFunction(
    () => document.querySelector('iframe[name="direct-frame"]')
      ?.contentDocument?.querySelector('#response')?.textContent === 'DONE:POST:/direct-submit',
    undefined,
    {timeout: 10000},
  );

  await page.locator('#reentry-submit-runner').click();
  await waitForRequestCount(4);
  await page.waitForFunction(
    () => document.querySelector('iframe[name="reentry-frame"]')
      ?.contentDocument?.querySelector('#response')?.textContent === 'DONE:POST:/reentry-submit',
    undefined,
    {timeout: 10000},
  );

  await page.locator('#cancel-submit-runner').click();
  await page.waitForTimeout(100);

  const pageState = await page.evaluate(() => {
    const oracle = window.__formDataOracle;
    const formState = id => {
      const form = document.getElementById(id);
      return {
        actionPath: new URL(form.action).pathname,
        method: form.method,
        enctype: form.enctype,
        target: form.target,
      };
    };
    const frameText = name =>
      document.querySelector(`iframe[name="${name}"]`)
        ?.contentDocument?.querySelector('#response')?.textContent ?? '';
    const buttonEvents = oracle.events.filter(event => event.form === 'button-form');
    const propertyEvent = buttonEvents.find(event => event.type === 'formdata-property');
    const listenerEvent = buttonEvents.find(event => event.type === 'formdata-listener');
    const documentEvent = buttonEvents.find(event => event.type === 'formdata-document');
    return {
      counts: oracle.counts,
      reentry: oracle.reentry,
      cancel: oracle.cancel,
      events: oracle.events,
      buttonEventOrder: buttonEvents.map(event => event.type),
      nativeEventFlags: {
        bubbles: propertyEvent?.flags.bubbles ?? null,
        cancelable: propertyEvent?.flags.cancelable ?? null,
        composed: propertyEvent?.flags.composed ?? null,
        isTrusted: propertyEvent?.flags.isTrusted ?? null,
        defaultPrevented: propertyEvent?.flags.defaultPrevented ?? null,
        formEventPhase: propertyEvent?.flags.eventPhase ?? null,
        documentEventPhase: documentEvent?.flags.eventPhase ?? null,
        targetIsForm: propertyEvent?.flags.targetIsForm ?? null,
        listenerTargetIsForm: listenerEvent?.flags.targetIsForm ?? null,
        documentTargetIsForm: documentEvent?.flags.targetIsForm ?? null,
      },
      propertyCases: window.__propertyCases,
      attributeMutations: {
        button: formState('button-form'),
        request: formState('request-form'),
      },
      targetFrames: {
        'button-before-frame': frameText('button-before-frame'),
        'button-after-frame': frameText('button-after-frame'),
        'request-before-frame': frameText('request-before-frame'),
        'request-after-frame': frameText('request-after-frame'),
        'direct-frame': frameText('direct-frame'),
        'reentry-frame': frameText('reentry-frame'),
        'cancel-frame': frameText('cancel-frame'),
      },
      topLevelPath: location.pathname,
    };
  });

  assert.equal(requests.length, 4, 'Only the four non-cancelled native submissions should reach the server.');
  assert.deepEqual(pageState.counts, expected.submissionCounts);
  assert.deepEqual(pageState.reentry.nested, expected.reentry.nested);
  assert.equal(pageState.reentry.submitEvents, expected.reentry.submitEvents);
  assert.equal(pageState.reentry.formdataEvents, expected.reentry.formdataEvents);
  assert.equal(pageState.cancel.defaultPrevented, expected.cancel.defaultPrevented);
  assert.equal(requests.filter(request => request.path === '/cancelled').length, expected.cancel.requestCount);
  assert.equal(pageState.counts['cancel-form'].submit, expected.cancel.submitEvents);
  assert.equal(pageState.counts['cancel-form'].formdata, expected.cancel.formdataEvents);
  assert.deepEqual(pageState.buttonEventOrder, expected.buttonEventOrder);
  assert.deepEqual(pageState.nativeEventFlags, {
    ...expected.nativeEventFlags,
    listenerTargetIsForm: true,
    documentTargetIsForm: true,
  });
  assert.deepEqual(pageState.attributeMutations, expected.attributeMutations);
  assert.deepEqual(pageState.propertyCases, expected.propertyCases);
  assert.equal(pageState.topLevelPath, '/fixture');

  const findRequest = expectedRequest => {
    const matches = requests.filter(request =>
      request.method === expectedRequest.method && request.path === expectedRequest.path,
    );
    assert.equal(matches.length, 1, 'Expected exactly one ' + expectedRequest.method + ' ' + expectedRequest.path);
    return matches[0];
  };
  for (const [key, expectedRequest] of [
    ['buttonSubmit', expected.buttonSubmit],
    ['requestSubmit', expected.requestSubmit],
    ['directSubmit', expected.directSubmit],
    ['reentry', expected.reentry],
  ]) {
    const actualRequest = findRequest(expectedRequest);
    assert.equal(actualRequest.search, expectedRequest.search, key + ' search string');
    assert.equal(actualRequest.contentType, expectedRequest.contentType, key + ' content type');
    assert.deepEqual(actualRequest.entries, expectedRequest.entries, key + ' ordered wire entries');
    if (expectedRequest.contentType === 'multipart/form-data') {
      assert.equal(actualRequest.boundaryCaptured, true, key + ' multipart boundary');
      assert.ok(actualRequest.rawByteLength > 0, key + ' raw multipart body');
    } else {
      assert.equal(actualRequest.rawByteLength, 0, key + ' has no request body');
    }
    assert.equal(pageState.targetFrames[expectedRequest.targetFrame], expectedRequest.responseText);
  }
  assert.deepEqual(blockedThirdPartyRequests, [], 'No third-party browser request is allowed.');
  assert.deepEqual(unexpectedLocalRequests, [], 'Only the fixture submission endpoints are allowed.');
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(pageErrors, []);

  const result = {
    oracle: 'Google Chrome through local Playwright Core; multipart parsed independently with Node Request.formData()',
    browserVersion: browser.version(),
    checkedAt: new Date().toISOString(),
    source: 'apps/android/integration_test/document_formdata_fixture.dart',
    fixture: 'formDataHtml (extracted directly from the shared Dart source)',
    origin: '127.0.0.1 loopback only',
    submissions: requests,
    submissionCounts: pageState.counts,
    nativeEventFlags: pageState.nativeEventFlags,
    buttonEventOrder: pageState.buttonEventOrder,
    requestSubmitEvent: pageState.events.find(event => event.form === 'request-form' && event.type === 'submit'),
    directSubmitEventCount: pageState.counts['direct-form'],
    reentry: pageState.reentry,
    cancellation: pageState.cancel,
    propertyCases: pageState.propertyCases,
    attributeMutations: pageState.attributeMutations,
    targetFrameResponses: pageState.targetFrames,
    topLevelPath: pageState.topLevelPath,
    blockedThirdPartyRequests,
    unexpectedLocalRequests,
  };

  const evidenceDirectory = path.join(
    repositoryRoot,
    'apps/android/build/parity-acceptance/document-formdata-20261015',
  );
  const evidencePath = path.join(evidenceDirectory, 'browser-oracle.json');
  await mkdir(evidenceDirectory, {recursive: true});
  await writeFile(evidencePath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({status: 'passed', evidence: path.relative(repositoryRoot, evidencePath)}, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}
