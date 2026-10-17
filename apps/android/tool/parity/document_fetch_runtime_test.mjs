import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { URL, URLSearchParams } from 'node:url';

const sourcePath = fileURLToPath(new URL('./document_fetch_source.js', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');

function createIsolatedFetchRuntime(initialBaseUrl = 'https://example.test/docs/page.html') {
  const context = vm.createContext({ URL, URLSearchParams });
  new vm.Script(source + '\nthis.__fetchFactory = createDocumentFetch;', {
    filename: 'document_fetch_source.js'
  }).runInContext(context);

  const requests = [];
  const messages = [];
  let liveBaseUrl = initialBaseUrl;
  context.__enqueue = (request) => {
    messages.push(request);
    requests.push(JSON.parse(JSON.stringify(request)));
  };
  context.__getBaseUrl = () => liveBaseUrl;
  const api = vm.runInContext(
    'new __fetchFactory({ URL, URLSearchParams, baseUrl: __getBaseUrl, enqueue: __enqueue })',
    context
  );
  return {
    api,
    context,
    requests,
    messages,
    setBaseUrl(value) { liveBaseUrl = value; }
  };
}

test('fetch encodes request bytes, uses the live base URL, and exposes cloned response bodies', async () => {
  const { api, requests, setBaseUrl, context } = createIsolatedFetchRuntime();
  assert.equal(vm.runInContext('typeof TextEncoder', context), 'undefined');
  assert.equal(vm.runInContext('typeof TextDecoder', context), 'undefined');

  const body = 'Hello, 猫 🐈';
  const requestPromise = api.fetch('./submit?from=script#fragment', {
    method: 'post',
    headers: [['X-Trace', '  native  ']],
    body
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    id: 'fetch-1',
    cancelled: false,
    kind: 'fetch',
    url: 'https://example.test/docs/submit?from=script',
    method: 'POST',
    headers: [
      ['content-type', 'text/plain;charset=UTF-8'],
      ['x-trace', 'native']
    ],
    bodyBase64: Buffer.from(body, 'utf8').toString('base64'),
    mode: 'cors',
    credentials: 'same-origin',
    redirect: 'follow',
    referrerPolicy: ''
  });

  setBaseUrl('https://other.test/current/document.html');
  const nextRequest = api.fetch('next');
  assert.equal(requests[1].url, 'https://other.test/current/next');
  api.complete({ id: 'fetch-2', ok: true, status: 204, bodyBase64: null });
  const noContentResponse = await nextRequest;
  assert.equal(noContentResponse.body, null);
  await noContentResponse.text();
  assert.equal(noContentResponse.bodyUsed, false);

  assert.equal(api.complete({ id: 'unknown', ok: true, status: 200 }), false);
  assert.equal(api.complete({
    id: 'fetch-1',
    ok: true,
    status: 201,
    statusText: 'Created',
    url: 'https://api.example.test/result',
    type: 'cors',
    redirected: true,
    headers: [['Content-Type', 'application/json'], ['X-Result', 'done']],
    bodyBase64: 'eyJvayI6dHJ1ZX0='
  }), true);
  assert.equal(api.complete({ id: 'fetch-1', ok: true, status: 201 }), false);

  const response = await requestPromise;
  const clone = response.clone();
  assert.equal(response.status, 201);
  assert.equal(response.statusText, 'Created');
  assert.equal(response.ok, true);
  assert.equal(response.url, 'https://api.example.test/result');
  assert.equal(response.type, 'cors');
  assert.equal(response.redirected, true);
  assert.equal(response.bodyUsed, false);
  assert.throws(() => response.headers.set('x-mutated', 'yes'), /immutable/i);
  assert.throws(() => clone.headers.append('x-mutated', 'yes'), /immutable/i);
  assert.deepEqual(JSON.parse(JSON.stringify(await clone.json())), { ok: true });
  assert.equal(clone.bodyUsed, true);
  assert.equal(await response.text(), '{"ok":true}');
  assert.equal(response.bodyUsed, true);
  await assert.rejects(response.text(), /already used/i);
  assert.throws(() => response.clone(), /used Response body/i);
});

test('Headers, Request, URLSearchParams, and binary response bodies follow the bridge shape', async () => {
  const { api, requests } = createIsolatedFetchRuntime('https://example.test/app/page.html');
  const headers = new api.Headers([
    ['X-Mix', ' first '],
    ['accept', 'application/json'],
    ['x-MIX', 'second']
  ]);
  assert.equal(headers.get('X-MIX'), 'first, second');
  assert.equal(headers.has('ACCEPT'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(headers))), [
    ['accept', 'application/json'],
    ['x-mix', 'first, second']
  ]);
  headers.set('x-mix', 'replacement');
  headers.append('X-Mix', 'tail');
  assert.equal(headers.get('x-mix'), 'replacement, tail');

  const params = vm.runInContext(
    'new URLSearchParams([["q", "a b"], ["emoji", "🐈"]])',
    createContextForParams()
  );
  function createContextForParams() {
    return vm.createContext({ URLSearchParams });
  }
  const requestHeaders = new api.Headers(headers);
  requestHeaders.set('cookie', 'fake=from-script');
  const request = new api.Request('submit', {
    method: 'post',
    headers: requestHeaders,
    body: params,
    mode: 'same-origin',
    credentials: 'include',
    redirect: 'manual',
    referrerPolicy: 'strict-origin'
  });
  assert.equal(request.url, 'https://example.test/app/submit');
  assert.equal(request.method, 'POST');
  assert.equal(request.mode, 'same-origin');
  assert.equal(request.credentials, 'include');
  assert.equal(request.redirect, 'manual');
  assert.equal(request.referrerPolicy, 'strict-origin');
  assert.equal(request.headers.get('cookie'), null);
  request.headers.set('cookie', 'late=fake');
  assert.equal(request.headers.get('cookie'), null);
  const requestClone = request.clone();
  assert.equal(requestClone.bodyUsed, false);

  const responsePromise = api.fetch(request);
  assert.equal(request.bodyUsed, true);
  assert.throws(() => request.clone(), /used Request body/i);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    id: 'fetch-1',
    cancelled: false,
    kind: 'fetch',
    url: 'https://example.test/app/submit',
    method: 'POST',
    headers: [
      ['accept', 'application/json'],
      ['content-type', 'application/x-www-form-urlencoded;charset=UTF-8'],
      ['x-mix', 'replacement, tail']
    ],
    bodyBase64: Buffer.from('q=a+b&emoji=%F0%9F%90%88', 'utf8').toString('base64'),
    mode: 'same-origin',
    credentials: 'include',
    redirect: 'manual',
    referrerPolicy: 'strict-origin'
  });
  api.complete({
    id: 'fetch-1',
    ok: true,
    status: 200,
    headers: [['X-Binary', 'yes'], ['Set-Cookie', 'session=fake']],
    bodyBytes: [0, 127, 128, 255]
  });
  const response = await responsePromise;
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), [0, 127, 128, 255]);
  assert.equal(response.bodyUsed, true);
  await assert.rejects(response.arrayBuffer(), /already used/i);
});


test('Request Body mixins, body ownership, and fetch overrides match native semantics', async () => {
  const nativeSource = new globalThis.Request('https://example.test/source', {
    method: 'POST', body: '{"value":7}'
  });
  const nativeCopy = new globalThis.Request(nativeSource);
  assert.equal(nativeSource.bodyUsed, true);
  assert.deepEqual(await nativeCopy.json(), { value: 7 });
  assert.equal(nativeCopy.bodyUsed, true);

  const nativeCloneSource = new globalThis.Request('https://example.test/clone', {
    method: 'POST', body: 'clone me'
  });
  const nativeClone = nativeCloneSource.clone();
  assert.equal(await nativeClone.text(), 'clone me');
  assert.equal(nativeCloneSource.bodyUsed, false);

  const nativeOverrideSource = new globalThis.Request('https://example.test/override', {
    method: 'POST', body: 'source body'
  });
  const nativeOverride = new globalThis.Request(nativeOverrideSource, { body: 'replacement body' });
  assert.equal(nativeOverrideSource.bodyUsed, false);
  assert.equal(await nativeOverride.text(), 'replacement body');

  const { api, requests } = createIsolatedFetchRuntime();
  const source = new api.Request('/source', { method: 'POST', body: '{"value":7}' });
  const copied = new api.Request(source);
  assert.equal(source.bodyUsed, true);
  assert.throws(() => source.clone(), /used Request body/i);
  assert.equal(copied.bodyUsed, false);
  assert.deepEqual(JSON.parse(JSON.stringify(await copied.json())), { value: 7 });
  assert.equal(copied.bodyUsed, true);
  await assert.rejects(copied.text(), /already used/i);

  const cloneSource = new api.Request('/clone-source', { method: 'POST', body: 'clone me' });
  const requestClone = cloneSource.clone();
  assert.equal(cloneSource.bodyUsed, false);
  assert.equal(await requestClone.text(), 'clone me');
  assert.equal(requestClone.bodyUsed, true);
  assert.equal(cloneSource.bodyUsed, false);

  const binaryRequest = new api.Request('/binary', {
    method: 'POST', body: new Uint8Array([0, 127, 128, 255])
  });
  assert.deepEqual(Array.from(new Uint8Array(await binaryRequest.arrayBuffer())), [0, 127, 128, 255]);
  assert.equal(binaryRequest.bodyUsed, true);

  const binaryFetch = api.fetch(new api.Request('/binary-upload', {
    method: 'POST', body: new Uint8Array([0, 127, 128, 255])
  }));
  assert.equal(requests[0].bodyBase64, Buffer.from([0, 127, 128, 255]).toString('base64'));
  api.complete({ id: 'fetch-1', ok: true, status: 200, bodyBase64: null });
  await binaryFetch;

  const arrayBufferFetch = api.fetch(new api.Request('/array-buffer-upload', {
    method: 'POST', body: new Uint8Array([4, 3, 2, 1]).buffer
  }));
  assert.equal(requests[1].bodyBase64, Buffer.from([4, 3, 2, 1]).toString('base64'));
  api.complete({ id: 'fetch-2', ok: true, status: 200, bodyBase64: null });
  await arrayBufferFetch;

  const overrideSource = new api.Request('/override', { method: 'POST', body: 'source body' });
  const overrideFetch = api.fetch(overrideSource, { body: 'replacement body' });
  assert.equal(overrideSource.bodyUsed, false);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].bodyBase64, Buffer.from('replacement body').toString('base64'));
  api.complete({ id: 'fetch-3', ok: true, status: 200, bodyBase64: null });
  await overrideFetch;
  assert.equal(overrideSource.bodyUsed, false);

  const nullOverrideSource = new api.Request('/null-override', {
    method: 'POST', body: 'preserved source body'
  });
  const nullOverrideCopy = new api.Request(nullOverrideSource, { body: null });
  assert.equal(nullOverrideSource.bodyUsed, true);
  assert.equal(await nullOverrideCopy.text(), 'preserved source body');

  const usedSource = new api.Request('/used-override', { method: 'POST', body: 'already consumed' });
  await usedSource.text();
  const usedOverride = new api.Request(usedSource, { body: 'replacement is allowed' });
  assert.equal(usedSource.bodyUsed, true);
  assert.equal(await usedOverride.text(), 'replacement is allowed');

  const emptyRequest = new api.Request('/no-body');
  assert.equal(await emptyRequest.text(), '');
  assert.equal(emptyRequest.bodyUsed, false);
  assert.doesNotThrow(() => emptyRequest.clone());
});

test('Response constructors infer body content types and reject bodies on 204/205/304', async () => {
  const { api } = createIsolatedFetchRuntime();
  const nativeStringResponse = new globalThis.Response('hello');
  const stringResponse = new api.Response('hello');
  assert.equal(stringResponse.headers.get('content-type'), nativeStringResponse.headers.get('content-type'));
  stringResponse.headers.set('x-mutable', 'yes');
  assert.equal(stringResponse.headers.get('x-mutable'), 'yes');

  const params = vm.runInContext(
    'new URLSearchParams([["a", "b"]])',
    vm.createContext({ URLSearchParams })
  );
  const nativeParamsResponse = new globalThis.Response(new URLSearchParams([['a', 'b']]));
  const paramsResponse = new api.Response(params);
  assert.equal(paramsResponse.headers.get('content-type'), nativeParamsResponse.headers.get('content-type'));

  const nativeEmptyResponse = new globalThis.Response(null);
  const emptyResponse = new api.Response(null);
  assert.equal(await emptyResponse.text(), await nativeEmptyResponse.text());
  assert.equal(emptyResponse.bodyUsed, false);

  for (const status of [204, 205, 304]) {
    assert.throws(() => new globalThis.Response('', { status }), TypeError);
    assert.throws(() => new api.Response('', { status }), /cannot have a body/i);
    assert.throws(() => new api.Response(new Uint8Array(0), { status }), /cannot have a body/i);
    assert.equal(new api.Response(null, { status }).status, status);
  }

  const nativeFetchedResponse = await globalThis.fetch('data:text/plain,oracle');
  assert.throws(() => nativeFetchedResponse.headers.set('x-mutated', 'yes'), TypeError);
  assert.equal(await nativeFetchedResponse.text(), 'oracle');
});

test('GET and HEAD body restrictions and unsupported body types are explicit', async () => {
  const { api } = createIsolatedFetchRuntime();
  assert.throws(
    () => new api.Request('/read', { method: 'GET', body: 'not allowed' }),
    /GET or HEAD method cannot have a body/i
  );
  assert.throws(
    () => new api.Request('/upload', { method: 'POST', body: { constructor: { name: 'Blob' } } }),
    /Blob, FormData, and streaming request bodies are not supported/i
  );
  assert.throws(
    () => new api.Request('/upload', { method: 'POST', body: { arbitrary: 'object' } }),
    /Request bodies must be strings/i
  );
  await assert.rejects(api.fetch('javascript:alert(1)'), /HTTP and HTTPS/i);
  await assert.rejects(
    api.fetch('https://user:secret@example.test/private'),
    /cannot contain username or password/i
  );
  await assert.rejects(
    api.fetch('/oversized', { method: 'POST', body: new Uint8Array(2 * 1024 * 1024 + 1) }),
    /cannot exceed 2 MiB/i
  );

  const opaquePromise = api.fetch('/opaque', { mode: 'no-cors' });
  api.complete({
    id: 'fetch-1', ok: true, status: 0, type: 'opaque',
    url: 'https://cross-origin.example/private',
    headers: [['X-Secret', 'hidden']],
    bodyBytes: [115, 101, 99, 114, 101, 116]
  });
  const opaque = await opaquePromise;
  assert.equal(opaque.type, 'opaque');
  assert.equal(opaque.status, 0);
  assert.equal(opaque.url, '');
  assert.equal(opaque.headers.get('x-secret'), null);
  assert.equal(await opaque.text(), '');
});

test('AbortSignal cancels queued requests before drain and rejects in-flight requests only once', async () => {
  const { api, requests, messages } = createIsolatedFetchRuntime();
  const alreadyAborted = api.AbortSignal.abort('stopped before fetch');
  await assert.rejects(api.fetch('/never-started', { signal: alreadyAborted }),
    (reason) => reason === 'stopped before fetch');
  assert.equal(requests.length, 0);

  const controller = new api.AbortController();
  let abortEvents = 0;
  controller.signal.addEventListener('abort', () => { abortEvents += 1; }, { once: true });
  const inFlight = api.fetch('/slow', { signal: controller.signal });
  assert.equal(requests.length, 1);
  assert.equal(messages[0].cancelled, false);
  controller.abort('cancelled');
  assert.equal(messages[0].cancelled, true);
  await assert.rejects(inFlight, (reason) => reason === 'cancelled');
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason, 'cancelled');
  assert.equal(abortEvents, 1);
  assert.equal(api.complete({ id: 'fetch-1', ok: true, status: 200, bodyBytes: [] }), false);

  const falsyReasonController = new api.AbortController();
  const falsyReasonRequest = api.fetch('/also-slow', { signal: falsyReasonController.signal });
  assert.equal(messages[1].cancelled, false);
  falsyReasonController.abort(null);
  assert.equal(messages[1].cancelled, true);
  await assert.rejects(falsyReasonRequest, (reason) => reason === null);
  assert.equal(api.complete({ id: 'fetch-2', ok: true, status: 200 }), false);

  const completed = api.fetch('/fast');
  assert.equal(messages[2].cancelled, false);
  api.complete({ id: 'fetch-3', ok: false, error: 'connection failed' });
  await assert.rejects(completed, /connection failed/);
  assert.equal(api.complete({ id: 'fetch-3', ok: true, status: 200 }), false);
});
