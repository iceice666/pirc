import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const fixturePath = path.join(repositoryRoot, 'apps/android/integration_test/document_xhr_fixture.dart');
const fixtureSource = readFileSync(fixturePath, 'utf8');
const htmlMatch = fixtureSource.match(/const documentXhrHtml\s*=\s*r'''([\s\S]*?)''';/);
assert.ok(htmlMatch, 'Could not extract documentXhrHtml from the shared fixture.');
const html = htmlMatch[1];
const browserExecutable = requireTestBrowserExecutable();
assert.ok(existsSync(browserExecutable), 'Missing Chrome executable: ' + browserExecutable);

const gatewayDirectory = path.join(repositoryRoot, 'apps/gateway');
const localRequire = createRequire(import.meta.url);
const {chromium} = localRequire(
  localRequire.resolve('playwright-core', {paths: [gatewayDirectory]}),
);

const requests = [];
const unexpectedLocalRequests = [];
const blockedThirdPartyRequests = [];
const serverErrors = [];
let origin = '';
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
    const entry = {
      method: request.method,
      host: request.headers.host ?? '',
      path: url.pathname,
      search: url.search,
      origin: request.headers.origin ?? null,
      accessControlRequestMethod: request.headers['access-control-request-method'] ?? null,
      accessControlRequestHeaders: request.headers['access-control-request-headers'] ?? null,
      authorization: request.headers.authorization ?? null,
      cookie: request.headers.cookie ?? null,
      contentType: request.headers['content-type'] ?? null,
      xTrace: request.headers['x-trace'] ?? null,
    };
    requests.push(entry);

    const write = (status, headers, body) => {
      response.writeHead(status, {'cache-control': 'no-store', ...headers});
      response.end(body);
    };
    const readBody = async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      entry.bodyBase64 = body.toString('base64');
      entry.bodyText = body.toString('utf8');
      return body;
    };

    if (request.method === 'GET' && url.pathname === '/fixture') {
      write(200, {'content-type': 'text/html; charset=utf-8'}, html);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      write(204, {}, '');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/text') {
      write(200, {'content-type': 'text/plain; charset=utf-8'}, 'XHR 中文 text');
      return;
    }
    if (request.method === 'POST' && url.pathname === '/post-json') {
      const body = await readBody();
      const echoed = {
        method: request.method,
        bodyText: body.toString('utf8'),
        contentType: request.headers['content-type'] ?? null,
        xTrace: request.headers['x-trace'] ?? null,
        cookie: request.headers.cookie ?? null,
        host: request.headers.host ?? null,
      };
      write(200, {'content-type': 'application/json; charset=utf-8'}, JSON.stringify(echoed));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/status404') {
      write(404, {'content-type': 'text/plain; charset=utf-8'}, 'Missing 雪');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/json-valid') {
      write(200, {'content-type': 'application/json; charset=utf-8'}, JSON.stringify({city: '台北', ok: true}));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/json-invalid') {
      write(200, {'content-type': 'application/json; charset=utf-8'}, '{invalid json');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/arraybuffer') {
      write(200, {'content-type': 'application/octet-stream'}, Buffer.from([0, 127, 128, 255, 13, 10]));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/blob') {
      write(200, {'content-type': 'text/plain; charset=utf-8'}, 'blob 雪');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/document-response') {
      write(200, {'content-type': 'text/html; charset=utf-8'}, '<!doctype html><title>XHR document 雪</title><p>document response text</p>');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/windows-1252') {
      write(200, {'content-type': 'text/plain; charset=utf-8'}, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/redirect-text') {
      write(302, {location: '/redirect-final?redirected=1'}, '');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/redirect-final') {
      write(201, {'content-type': 'text/plain; charset=utf-8'}, 'final redirected ✓');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/empty204') {
      write(204, {}, '');
      return;
    }
    if (request.method === 'HEAD' && url.pathname === '/head') {
      response.writeHead(200, {'content-type': 'text/plain; charset=utf-8', 'content-length': '13', 'cache-control': 'no-store'});
      response.end();
      return;
    }
    if (request.method === 'OPTIONS' && url.pathname === '/cors-preflight') {
      write(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET',
        'access-control-allow-headers': 'x-trace',
        'access-control-max-age': '0',
      }, '');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/cors-preflight') {
      write(200, {'access-control-allow-origin': origin, 'content-type': 'text/plain; charset=utf-8'}, 'listener preflight ok');
      return;
    }
    if (request.method === 'OPTIONS' && url.pathname === '/upload-simple') {
      // Upload listeners require a preflight even for a safelisted POST body.
      // POST and text/plain need no allow-list; the response intentionally has
      // only ACAO so the oracle catches incorrect allow-method/header checks.
      write(204, {'access-control-allow-origin': origin}, '');
      return;
    }
    if (request.method === 'POST' && url.pathname === '/upload-simple') {
      const body = await readBody();
      write(200, {
        'access-control-allow-origin': origin,
        'content-type': 'text/plain; charset=utf-8',
      }, 'upload body received: ' + body.toString('utf8'));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/cors-allow') {
      write(200, {'access-control-allow-origin': '*', 'content-type': 'text/plain; charset=utf-8'}, 'cors allowed');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/cors-deny') {
      write(200, {'content-type': 'text/plain; charset=utf-8'}, 'cors denied');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/delay') {
      const delayMs = Number(url.searchParams.get('ms') ?? 100);
      let timer = setTimeout(() => {
        if (!response.destroyed) write(200, {'content-type': 'text/plain; charset=utf-8'}, 'delayed response');
      }, delayMs);
      response.once('close', () => {
        clearTimeout(timer);
        timer = 0;
        if (!response.writableEnded) entry.clientAborted = true;
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/slow-stream') {
      const delayMs = Number(url.searchParams.get('delay') ?? 350);
      response.writeHead(200, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
      response.write('partial');
      const timer = setTimeout(() => {
        if (!response.destroyed) response.end(' tail');
      }, delayMs);
      response.once('close', () => {
        clearTimeout(timer);
        if (!response.writableEnded) entry.clientAborted = true;
      });
      return;
    }

    unexpectedLocalRequests.push({method: request.method, host: request.headers.host ?? '', path: url.pathname, search: url.search});
    write(404, {'content-type': 'text/plain; charset=utf-8'}, 'unexpected local request');
  })().catch(error => {
    serverErrors.push(String(error && error.stack || error));
    if (!response.headersSent) response.writeHead(500, {'content-type': 'text/plain; charset=utf-8'});
    response.end('local XHR oracle error');
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
  // Keep outbound traffic on a closed local proxy port. Avoid Playwright
  // routing because it can change how Chrome issues CORS preflights.
  args: ['--disable-gpu', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost'],
});
const pageErrors = [];
const evidenceDirectory = path.join(
  repositoryRoot,
  'apps/android/build/parity-acceptance/document-xhr-20261016',
);
const evidencePath = path.join(evidenceDirectory, 'browser-oracle.json');

try {
  const page = await browser.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', browserRequest => {
    const requestUrl = new URL(browserRequest.url());
    const isLocal = requestUrl.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(requestUrl.hostname) &&
      requestUrl.port === String(address.port);
    if (!isLocal) blockedThirdPartyRequests.push(requestUrl.href);
  });
  await page.goto(origin + '/fixture', {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => {
    const text = document.querySelector('#xhr-result')?.textContent ?? '';
    return text !== '' && text !== 'WAITING';
  }, undefined, {timeout: 30000});
  const observed = JSON.parse(await page.locator('#xhr-result').textContent());
  assert.equal(observed.fixtureError, undefined, 'Shared fixture reported a browser-side error.');
  assert.equal(await page.locator('#xhr-visible').textContent(), 'XMLHttpRequest parity probes complete.');
  const postJson = observed.requests.postJson.value.value;
  const eventTypes = observation => observation.events.map(event => event.type);
  const isOrderedSubsequence = (events, expected) => {
    let index = 0;
    for (const event of events) if (event === expected[index]) index += 1;
    return index === expected.length;
  };
  assert.equal(observed.requests.getText.terminal, 'load');
  assert.equal(observed.requests.getText.value.text, 'XHR 中文 text');
  assert.equal(observed.requests.postJson.terminal, 'load');
  assert.deepEqual(JSON.parse(postJson.bodyText), {city: '台北', count: 2});
  assert.equal(postJson.xTrace, 'first, second');
  assert.equal(postJson.cookie, null);
  assert.ok(!postJson.host.includes('forbidden.invalid'));
  assert.equal(observed.requests.status404.terminal, 'load');
  assert.equal(observed.requests.status404.final.status, 404);
  assert.equal(observed.requests.status404.value.text, 'Missing 雪');
  assert.ok(isOrderedSubsequence(eventTypes(observed.requests.status404), ['readystatechange', 'loadstart', 'load', 'loadend']));
  assert.deepEqual(observed.requests.validJson.value.value, {city: '台北', ok: true});
  assert.equal(observed.requests.invalidJson.value.value, null);
  assert.deepEqual(observed.requests.arrayBuffer.value.bytes, [0, 127, 128, 255, 13, 10]);
  assert.deepEqual(observed.requests.blob.value, {
    kind: 'Blob', isBlob: true, sameIdentity: true, type: 'text/plain', size: Buffer.byteLength('blob 雪'),
    text: {status: 'resolved', text: 'blob 雪'},
  });
  assert.equal(observed.requests.document.value.isDocument, true);
  assert.equal(observed.requests.document.value.title, 'XHR document 雪');
  assert.equal(observed.requests.overrideMimeType.value.text, 'café');
  assert.equal(observed.requests.redirect.final.status, 201);
  assert.equal(observed.requests.redirect.value.text, 'final redirected ✓');
  assert.equal(observed.requests.redirect.final.responseURL, origin + '/redirect-final?redirected=1');
  assert.equal(observed.requests.empty204.final.status, 204);
  assert.equal(observed.requests.empty204.value.text, '');
  assert.equal(observed.requests.head.final.status, 200);
  assert.equal(observed.requests.head.value.text, '');
  assert.equal(observed.requests.corsAllow.terminal, 'load');
  assert.equal(observed.requests.corsAllow.value.text, 'cors allowed');
  assert.equal(observed.requests.corsDeny.terminal, 'error');
  assert.equal(observed.requests.corsDeny.final.status, 0);
  assert.ok(isOrderedSubsequence(eventTypes(observed.requests.corsDeny), ['readystatechange', 'loadstart', 'error', 'loadend']));
  assert.equal(observed.requests.listenerTriggeredPreflight.headerResult.status, 'ok');
  assert.equal(observed.requests.listenerTriggeredPreflight.terminal, 'load');
  assert.equal(observed.requests.listenerTriggeredPreflight.responseText, 'listener preflight ok');
  assert.equal(observed.requests.uploadSimplePreflight.listenerRegistration.status, 'ok');
  assert.equal(observed.requests.uploadSimplePreflight.terminal, 'load');
  assert.equal(observed.requests.uploadSimplePreflight.responseText, 'upload body received: upload body');
  assert.deepEqual(observed.requests.uploadSimplePreflight.uploadEvents.map(event => [event.type, event.loaded, event.total]), [
    ['progress', Buffer.byteLength('upload body'), Buffer.byteLength('upload body')],
  ]);
  assert.deepEqual(observed.cases.abortDuringLoadstart.terminal, 'abort');
  assert.equal(observed.cases.abortDuringLoadstart.final.readyState, 0);
  assert.deepEqual(eventTypes(observed.cases.abortDuringLoadstart), [
    'readystatechange', 'loadstart', 'readystatechange', 'abort', 'loadend',
  ]);
  assert.equal(observed.cases.abortDuringLoading.aborted, true);
  assert.equal(observed.cases.abortDuringLoading.terminal, 'abort');
  assert.equal(observed.cases.abortDuringLoading.final.readyState, 0);
  assert.ok(isOrderedSubsequence(eventTypes(observed.cases.abortDuringLoading), [
    'readystatechange', 'loadstart', 'readystatechange', 'readystatechange', 'abort', 'loadend',
  ]));
  assert.equal(observed.cases.repeatedSend.secondSend.errorName, 'InvalidStateError');
  assert.equal(observed.cases.timeout.terminal, 'timeout');
  assert.ok(isOrderedSubsequence(eventTypes(observed.cases.timeout), [
    'readystatechange', 'loadstart', 'readystatechange', 'timeout', 'loadend',
  ]));
  assert.equal(observed.cases.timeoutShortThenLong.terminal, 'load');
  assert.equal(observed.cases.timeoutLongThenShort.terminal, 'timeout');
  assert.equal(observed.cases.reopenWhileLoading.responseText, 'XHR 中文 text');
  for (const phase of ['readystatechange', 'load', 'loadend']) {
    assert.equal(observed.reentry[phase].reentryError, null, 'Reentry failed at ' + phase);
    assert.equal(observed.reentry[phase].responseText, 'XHR 中文 text');
  }
  const loadReentryEvents = eventTypes(observed.reentry.load);
  assert.ok(loadReentryEvents.indexOf('readystatechange', loadReentryEvents.indexOf('load') + 1) > loadReentryEvents.indexOf('load'));
  assert.ok(loadReentryEvents.lastIndexOf('loadend') > loadReentryEvents.lastIndexOf('load'));
  assert.deepEqual(
    Object.fromEntries(Object.entries(observed.errors.openForbiddenMethods).map(([method, value]) => [method,
      {status: value.status, errorName: value.errorName},
    ])),
    {
      TRACE: {status: 'throws', errorName: 'SecurityError'},
      TRACK: {status: 'throws', errorName: 'SecurityError'},
      CONNECT: {status: 'throws', errorName: 'SecurityError'},
    },
  );
  assert.equal(observed.errors.setRequestHeaderBeforeOpen.errorName, 'InvalidStateError');
  assert.equal(resultRequest('/cors-preflight', 'OPTIONS').accessControlRequestHeaders, 'x-trace');
  assert.equal(resultRequest('/cors-preflight', 'GET').xTrace, 'from-opened-listener');
  const uploadPreflight = resultRequest('/upload-simple', 'OPTIONS');
  assert.equal(uploadPreflight.accessControlRequestMethod, 'POST');
  assert.equal(uploadPreflight.accessControlRequestHeaders, null);
  const uploadPost = resultRequest('/upload-simple', 'POST');
  assert.equal(uploadPost.contentType, 'text/plain');
  assert.equal(uploadPost.bodyText, 'upload body');
  assert.deepEqual(blockedThirdPartyRequests, [], 'The fixture attempted an external network request.');
  assert.deepEqual(unexpectedLocalRequests, [], 'The fixture attempted an unexpected loopback request.');
  assert.deepEqual(pageErrors, [], 'The fixture raised an uncaught browser error.');
  assert.deepEqual(serverErrors, [], 'The loopback server reported an error.');

  function resultRequest(pathname, method) {
    const match = requests.find(item => item.path === pathname && item.method === method);
    assert.ok(match, 'Missing ' + method + ' ' + pathname + ' network request. Seen: ' + JSON.stringify(requests));
    return match;
  }

  const postRequest = resultRequest('/post-json', 'POST');
  assert.equal(postRequest.xTrace, 'first, second');
  assert.equal(postRequest.cookie, null);
  assert.ok(requests.some(item => item.path === '/delay' && item.search.includes('case=repeated-send')));
  assert.ok(requests.some(item => item.path === '/slow-stream' && item.search.includes('case=abort-loading')));
  assert.ok(requests.some(item => item.path === '/slow-stream' && item.search.includes('case=reopen-old')));

  const evidence = {
    browser: 'Google Chrome ' + browser.version(),
    date: '2026-10-16',
    origin,
    network: {allowedRequests: requests, unexpectedLocalRequests, blockedThirdPartyRequests},
    fixture: 'apps/android/integration_test/document_xhr_fixture.dart',
    assertions: 'PASS: Chrome XHR response, event, abort, timeout, CORS, and reentry observations recorded.',
    observed,
    pageErrors,
    serverErrors,
  };
  await mkdir(evidenceDirectory, {recursive: true});
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({
    browser: evidence.browser,
    evidencePath,
    responseSummary: {
      getText: observed.requests.getText.value,
      status404: {terminal: observed.requests.status404.terminal, status: observed.requests.status404.final.status},
      validJson: observed.requests.validJson.value,
      invalidJson: observed.requests.invalidJson.value,
      bytes: observed.requests.arrayBuffer.value.bytes,
      document: observed.requests.document.value,
      windows1252: observed.requests.overrideMimeType.value.text,
      redirect: {status: observed.requests.redirect.final.status, responseURL: observed.requests.redirect.final.responseURL},
      uploadSimplePreflight: {
        terminal: observed.requests.uploadSimplePreflight.terminal,
        responseText: observed.requests.uploadSimplePreflight.responseText,
        uploadEvents: observed.requests.uploadSimplePreflight.uploadEvents.map(event => event.type),
      },
    },
    eventSummary: {
      abortDuringLoadstart: observed.cases.abortDuringLoadstart.events.map(event => [event.type, event.readyState]),
      abortDuringLoading: observed.cases.abortDuringLoading.events.map(event => [event.type, event.readyState]),
      timeout: observed.cases.timeout.events.map(event => [event.type, event.readyState]),
      timeoutShortThenLong: observed.cases.timeoutShortThenLong.terminal,
      timeoutLongThenShort: observed.cases.timeoutLongThenShort.terminal,
      reentry: Object.fromEntries(Object.entries(observed.reentry).map(([phase, value]) => [phase, value.events.map(event => [event.type, event.readyState])])),
    },
    forbiddenMethods: observed.errors.openForbiddenMethods,
    requestCount: requests.length,
  }, null, 2));
} catch (error) {
  serverErrors.push(String(error && error.stack || error));
  throw error;
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
