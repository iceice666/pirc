import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const fixturePath = path.join(
  repositoryRoot,
  'apps/android/integration_test/document_binary_fetch_fixture.dart',
);
const fixtureSource = readFileSync(fixturePath, 'utf8');
const htmlMatch = fixtureSource.match(
  /const binaryFetchHtml\s*=\s*r'''([\s\S]*?)''';/,
);
assert.ok(htmlMatch, 'Could not extract binaryFetchHtml from the Android fixture.');
const html = htmlMatch[1];
const responseMatch = fixtureSource.match(
  /const binaryFetchResponseText\s*=\s*'([^']*)';/,
);
assert.ok(responseMatch, 'Could not extract the fixed browser response text.');
const expectedResponseText = responseMatch[1];

const expectedWireEntries = [
  {name: 'city', kind: 'text', value: '城市'},
  {name: 'dup', kind: 'text', value: 'first'},
  {name: 'dup', kind: 'text', value: 'second'},
  {name: 'message', kind: 'text', value: 'first line\r\nsecond line'},
  {name: 'choice', kind: 'text', value: 'yes'},
  {
    name: 'upload',
    kind: 'file',
    filename: '',
    mimeType: 'application/octet-stream',
    size: 0,
    base64: '',
  },
  {name: 'go', kind: 'text', value: 'yes'},
  {name: 'hook', kind: 'text', value: 'from-event'},
  {
    name: 'binary',
    kind: 'file',
    filename: '城市.bin',
    mimeType: 'application/octet-stream',
    size: 6,
    base64: 'AH+A/w0K',
  },
  {
    name: 'blob',
    kind: 'file',
    filename: 'note.txt',
    mimeType: 'text/plain',
    size: 7,
    base64: 'dGV4dOWwvg==',
  },
  {name: 'dup', kind: 'text', value: 'third'},
  {name: 'dup', kind: 'text', value: 'fourth'},
];
const expectedCloneEntries = expectedWireEntries;
const browserExecutable =
  requireTestBrowserExecutable();
assert.ok(
  existsSync(browserExecutable),
  'Missing Chrome executable: ' + browserExecutable,
);

const unexpectedServerRequests = [];
const serverErrors = [];
const posts = [];
let origin = '';
const server = createServer((request, response) => {
  void (async () => {
    const requestUrl = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
    if (request.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/fixture')) {
      response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      response.end(html);
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'POST' || requestUrl.pathname !== '/upload') {
      unexpectedServerRequests.push({method: request.method, path: requestUrl.pathname});
      response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
      response.end('unexpected local request');
      return;
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks);
    const contentType = String(request.headers['content-type'] ?? '');
    assert.match(contentType, /^multipart\/form-data;\s*boundary=.+$/i);
    const parserRequest = new Request(origin + '/upload', {
      method: 'POST',
      headers: {'content-type': contentType},
      body: rawBody,
    });
    const formData = await parserRequest.formData();
    const entries = [];
    for (const [name, value] of formData.entries()) {
      if (typeof value === 'string') {
        entries.push({name, kind: 'text', value});
      } else {
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
    }
    posts.push({
      method: request.method,
      path: requestUrl.pathname,
      contentType: 'multipart/form-data',
      boundaryCaptured: contentType.includes('boundary='),
      rawByteLength: rawBody.length,
      rawSha256: createHash('sha256').update(rawBody).digest('hex'),
      entries,
    });
    response.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
    response.end(expectedResponseText);
  })().catch((error) => {
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
const browser = await chromium.launch({headless: true, executablePath: browserExecutable});
const blockedRequests = [];
const pageErrors = [];

try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === origin) {
      await route.continue();
    } else {
      blockedRequests.push(requestUrl.href);
      await route.abort();
    }
  });

  await page.goto(origin + '/fixture', {waitUntil: 'domcontentloaded'});
  await page.locator('#not-submit').click();
  assert.equal(posts.length, 0, 'A non-submit button must not build or send the form.');

  await page.locator('#send').click();
  await page.waitForFunction(
    () => !['WAITING', 'RUNNING'].includes(document.querySelector('#result')?.textContent ?? ''),
    undefined,
    {timeout: 10000},
  );

  assert.equal(posts.length, 1, 'The submitter must make exactly one local POST.');
  const post = posts[0];
  assert.equal(post.method, 'POST');
  assert.equal(post.path, '/upload');
  assert.equal(post.contentType, 'multipart/form-data');
  assert.equal(post.boundaryCaptured, true);
  assert.ok(post.rawByteLength > 0, 'The server captured the raw multipart body.');
  assert.deepEqual(post.entries, expectedWireEntries);

  const pageState = await page.evaluate(() => ({
    snapshot: window.__binaryFetchSnapshot,
    error: window.__binaryFetchError ?? null,
    resultText: document.querySelector('#result')?.textContent ?? null,
    cloneText: document.querySelector('#clone-result')?.textContent ?? null,
  }));
  assert.equal(pageState.error, null, pageState.error ?? undefined);
  assert.equal(pageState.error, null);
  assert.deepEqual(pageState.snapshot.cloneEntries, expectedCloneEntries);
  assert.equal(pageState.snapshot.afterRequestMutationIncluded, false);
  assert.equal(pageState.snapshot.method, 'POST');
  assert.equal(pageState.snapshot.path, '/upload');
  assert.equal(pageState.snapshot.credentials, 'same-origin');
  assert.deepEqual(pageState.snapshot.sourceBinary, {
    name: '城市.bin',
    type: 'application/octet-stream',
    size: 6,
    lastModified: 123,
  });
  assert.equal(pageState.snapshot.responseStatus, 200);
  assert.equal(pageState.snapshot.responseText, expectedResponseText);
  assert.equal(pageState.resultText, expectedResponseText);
  assert.equal(pageState.cloneText, JSON.stringify(expectedCloneEntries));

  const nativeFormDataCases = await page.evaluate(() => {
    const form = document.createElement('form');
    form.innerHTML = `
      <input type="hidden" name="_charset_" value="original">
      <input type="hidden" name="kept" value="before">
      <input type="file" name="empty">
      <button id="valid" type="submit" name="sent" value="yes">Send</button>
      <button id="invalid" type="button" name="ignored" value="no">Not submit</button>`;
    document.body.append(form);
    const events = [];
    const recordEvent = (listener, event) => events.push({
      listener,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      targetIsForm: event.target === form,
    });
    const formListener = (event) => {
      recordEvent('form', event);
      event.formData.append('listenerMutation', 'visible');
    };
    const documentListener = (event) => recordEvent('document', event);
    form.addEventListener('formdata', formListener);
    document.addEventListener('formdata', documentListener);

    const summarize = (data) => Array.from(data.entries(), ([name, value]) =>
      typeof value === 'string'
        ? {name, kind: 'text', value}
        : {
            name,
            kind: 'file',
            filename: value.name,
            mimeType: value.type,
            size: value.size,
            lastModifiedIsNumber: Number.isFinite(value.lastModified),
          },
    );
    const attempt = (label, make) => {
      try {
        const data = make();
        return {label, status: 'ok', entries: summarize(data)};
      } catch (error) {
        return {label, status: 'throws', errorName: error.name, errorMessage: error.message};
      }
    };
    const validButton = form.querySelector('#valid');
    const invalidButton = form.querySelector('#invalid');
    const detachedButton = document.createElement('button');
    detachedButton.type = 'submit';
    const results = [
      attempt('omitted-submitter', () => new FormData(form)),
      attempt('null-submitter', () => new FormData(form, null)),
      attempt('undefined-submitter', () => new FormData(form, undefined)),
      attempt('valid-submitter', () => new FormData(form, validButton)),
      attempt('non-submit-button', () => new FormData(form, invalidButton)),
      attempt('unassociated-submitter', () => new FormData(form, detachedButton)),
    ];
    form.removeEventListener('formdata', formListener);
    document.removeEventListener('formdata', documentListener);
    form.remove();
    return {results, events};
  });

  assert.equal(nativeFormDataCases.results.find((item) => item.label === 'omitted-submitter').status, 'ok');
  assert.equal(nativeFormDataCases.results.find((item) => item.label === 'null-submitter').status, 'ok');
  assert.equal(nativeFormDataCases.results.find((item) => item.label === 'undefined-submitter').status, 'ok');
  assert.equal(nativeFormDataCases.results.find((item) => item.label === 'valid-submitter').status, 'ok');
  assert.equal(nativeFormDataCases.results.find((item) => item.label === 'non-submit-button').status, 'throws');
  assert.equal(nativeFormDataCases.results.find((item) => item.label === 'unassociated-submitter').status, 'throws');
  for (const result of nativeFormDataCases.results.filter((item) => item.status === 'ok')) {
    assert.ok(result.entries.some((entry) => entry.name === 'listenerMutation' && entry.value === 'visible'));
    const charset = result.entries.find((entry) => entry.name === '_charset_');
    assert.ok(charset, `${result.label} preserves the hidden _charset_ control`);
    assert.equal(charset.value, 'UTF-8');
    const emptyFile = result.entries.find((entry) => entry.name === 'empty');
    assert.deepEqual(
      {filename: emptyFile.filename, mimeType: emptyFile.mimeType, size: emptyFile.size, lastModifiedIsNumber: emptyFile.lastModifiedIsNumber},
      {filename: '', mimeType: 'application/octet-stream', size: 0, lastModifiedIsNumber: true},
    );
    const submitterEntry = result.entries.find((entry) => entry.name === 'sent');
    assert.equal(
      submitterEntry?.value ?? null,
      result.label === 'valid-submitter' ? 'yes' : null,
    );
  }
  assert.ok(nativeFormDataCases.events.some((event) => event.listener === 'form' && event.bubbles && !event.cancelable));
  assert.ok(nativeFormDataCases.events.some((event) => event.listener === 'document' && event.bubbles && !event.cancelable));
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedRequests, [], 'No third-party browser request is allowed.');
  assert.deepEqual(unexpectedServerRequests, [], 'The server only accepts fixture routes.');
  assert.deepEqual(serverErrors, []);

  const result = {
    oracle: 'Google Chrome through local Playwright Core and Node Request.formData()',
    browserVersion: browser.version(),
    checkedAt: new Date().toISOString(),
    source: 'apps/android/integration_test/document_binary_fetch_fixture.dart',
    fixture: 'binaryFetchHtml (extracted directly from source)',
    origin: 'local loopback only',
    request: {
      method: post.method,
      path: post.path,
      credentials: pageState.snapshot.credentials,
      contentType: post.contentType,
      boundaryCaptured: post.boundaryCaptured,
      rawByteLength: post.rawByteLength,
      rawSha256: post.rawSha256,
      entries: post.entries,
    },
    requestClone: {
      method: pageState.snapshot.method,
      path: pageState.snapshot.path,
      sourceFile: pageState.snapshot.sourceBinary,
      entries: pageState.snapshot.cloneEntries,
      lateFormDataMutationExcluded: !pageState.snapshot.afterRequestMutationIncluded,
    },
    nativeFormDataCases,
    responseCloneBlobText: pageState.snapshot.responseText,
    fixedResponseText: expectedResponseText,
    blockedThirdPartyRequests: blockedRequests,
    unexpectedLocalRequests: unexpectedServerRequests,
  };

  const evidenceDirectory = path.join(
    repositoryRoot,
    'apps/android/build/parity-acceptance/document-binary-fetch-20261015',
  );
  const evidencePath = path.join(evidenceDirectory, 'browser-oracle.json');
  await mkdir(evidenceDirectory, {recursive: true});
  await writeFile(evidencePath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({status: 'passed', evidence: path.relative(repositoryRoot, evidencePath)}, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
