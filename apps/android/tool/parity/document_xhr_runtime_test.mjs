import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { URL, URLSearchParams } from 'node:url';
import { DOMParser } from './vendor/linkedom-0.18.13/worker.js';

const sourceFiles = [
  'document_binary_source.js',
  'document_fetch_source.js',
  'document_file_text_source.js',
  'document_file_reader_source.js',
  'document_xhr_source.js'
];
const source = sourceFiles.map(name =>
  readFileSync(new URL('./' + name, import.meta.url), 'utf8')
).join('\n') + '\nthis.__documentFactories = {' +
  'binary:createDocumentBinary,fetch:createDocumentFetch,' +
  'fileText:createDocumentFileText,fileReader:createDocumentFileReader,' +
  'xhr:createDocumentXHR};';

function createRuntime(initialBaseUrl = 'https://example.test/docs/page.html') {
  const context = vm.createContext({
    URL,
    URLSearchParams,
    Event: globalThis.Event,
    EventTarget: globalThis.EventTarget
  });
  new vm.Script(source, { filename: 'document_xhr_runtime_bundle.js' })
    .runInContext(context, { timeout: 3000 });
  const factories = context.__documentFactories;
  const tasks = new Map();
  const requests = [];
  const reportedErrors = [];
  let baseUrl = initialBaseUrl;
  let time = 0;
  let nextTaskId = 1;

  function schedule(callback, delay = 0) {
    const id = nextTaskId++;
    const duration = Number(delay);
    tasks.set(id, {
      due: time + (Number.isFinite(duration) ? Math.max(0, duration) : 0),
      callback
    });
    return id;
  }

  function cancel(id) {
    tasks.delete(id);
  }

  async function settleMicrotasks() {
    for (let index = 0; index < 16; index++)
      await Promise.resolve();
  }

  async function pump() {
    for (let step = 0; step < 1000; step++) {
      await settleMicrotasks();
      const ready = Array.from(tasks.entries())
        .filter(([, task]) => task.due <= time)
        .sort((left, right) =>
          left[1].due - right[1].due || left[0] - right[0]
        );
      if (ready.length === 0) {
        await settleMicrotasks();
        if (!Array.from(tasks.values()).some(task => task.due <= time))
          return;
        continue;
      }
      const [id, task] = ready[0];
      tasks.delete(id);
      await task.callback();
    }
    throw new Error('The document task queue did not settle.');
  }

  async function advance(milliseconds) {
    time += milliseconds;
    await pump();
  }

  const binary = factories.binary({});
  const fetchRuntime = factories.fetch({
    URL,
    URLSearchParams,
    binary,
    baseUrl: () => baseUrl,
    enqueue(request) {
      requests.push(JSON.parse(JSON.stringify(request)));
    }
  });
  const fileText = factories.fileText();
  const fileReader = factories.fileReader({
    binary,
    Event: globalThis.Event,
    EventTarget: globalThis.EventTarget,
    decodeText: fileText.decode,
    schedule,
    cancel,
    reportError(error) { reportedErrors.push(error); }
  });

  const xhrRuntime = factories.xhr({
    fetch: fetchRuntime.fetchForXHR,
    Headers: fetchRuntime.Headers,
    AbortController: fetchRuntime.AbortController,
    binary,
    Event: globalThis.Event,
    ProgressEvent: fileReader.ProgressEvent,
    DOMException: fileReader.DOMException,
    EventTarget: globalThis.EventTarget,
    URL,
    baseUrl: () => baseUrl,
    decodeText: fileText.decode,
    DOMParser,
    schedule,
    cancel,
    now: () => time,
    reportError(error) { reportedErrors.push(error); }
  });

  return {
    ...xhrRuntime,
    binary,
    fetchRuntime,
    requests,
    reportedErrors,
    pump,
    advance,
    setBaseUrl(value) { baseUrl = value; },
    now() { return time; }
  };
}

function hasName(name) {
  return error => error != null && error.name === name;
}

function capture(xhr, trace, types = [
  'readystatechange', 'loadstart', 'progress', 'load', 'error', 'abort',
  'timeout', 'loadend'
]) {
  for (const type of types) {
    xhr.addEventListener(type, event => {
      trace.push({
        type,
        state: xhr.readyState,
        loaded: Number.isFinite(event.loaded) ? event.loaded : null,
        total: Number.isFinite(event.total) ? event.total : null
      });
    });
  }
}

function responseBytes(body) {
  if (body == null)
    return [];
  if (typeof body === 'string')
    return Array.from(Buffer.from(body, 'utf8'));
  return Array.from(body);
}

async function completeRequest(runtime, index, options = {}) {
  const request = runtime.requests[index];
  assert.ok(request, 'expected a host fetch request');
  const completion = {
    id: request.id,
    ok: true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    url: options.url ?? request.url,
    headers: options.headers ?? [['content-type', 'text/plain;charset=UTF-8']],
    bodyBytes: responseBytes(options.body ?? '')
  };
  assert.equal(runtime.fetchRuntime.complete(completion), true);
  await runtime.pump();
  return completion;
}

test('XHR validates construction, state, dangerous methods and headers, and credentials', async () => {
  const runtime = createRuntime();
  const xhr = new runtime.XMLHttpRequest();
  const constants = [
    xhr.UNSENT, xhr.OPENED, xhr.HEADERS_RECEIVED, xhr.LOADING, xhr.DONE,
    runtime.XMLHttpRequest.UNSENT, runtime.XMLHttpRequest.OPENED,
    runtime.XMLHttpRequest.HEADERS_RECEIVED, runtime.XMLHttpRequest.LOADING,
    runtime.XMLHttpRequest.DONE
  ];

  assert.deepEqual(constants, [0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
  assert.equal(xhr.readyState, xhr.UNSENT);
  assert.equal(xhr.status, 0);
  assert.equal(xhr.response, '');
  assert.equal(xhr.responseText, '');
  assert.equal(xhr.responseURL, '');
  assert.equal(xhr.upload, xhr.upload);
  assert.throws(() => xhr.send(), hasName('InvalidStateError'));
  assert.throws(() => xhr.setRequestHeader('X-Test', 'value'), hasName('InvalidStateError'));

  for (const method of ['CONNECT', 'TRACE', 'TRACK']) {
    assert.throws(
      () => xhr.open(method, '/blocked'),
      hasName('SecurityError'),
      method
    );
  }
  assert.throws(
    () => xhr.open('GET', 'https://user:secret@example.test/private'),
    hasName('NotSupportedError')
  );
  assert.throws(
    () => xhr.open('GET', '/sync', false),
    hasName('NotSupportedError')
  );

  const states = [];
  xhr.addEventListener('readystatechange', () => states.push(xhr.readyState));
  xhr.open('pOsT', '/submit');
  assert.deepEqual(states, [xhr.OPENED]);
  xhr.setRequestHeader('X-Trace', ' first ');
  xhr.setRequestHeader('x-trace', 'second');
  xhr.setRequestHeader('Cookie', 'script=must-not-escape');
  xhr.withCredentials = true;
  assert.equal(xhr.withCredentials, true);
  xhr.send('payload');

  assert.equal(xhr.readyState, xhr.OPENED);
  assert.equal(runtime.requests.length, 1);
  const request = runtime.requests[0];
  assert.equal(request.url, 'https://example.test/submit');
  assert.equal(request.method, 'POST');
  assert.equal(request.credentials, 'include');
  assert.equal(request.bodyBase64, Buffer.from('payload').toString('base64'));
  assert.equal(request.forcePreflight, undefined);
  const headers = Object.fromEntries(request.headers);
  assert.equal(headers['x-trace'], 'first, second');
  assert.equal(headers.cookie, undefined);
  assert.equal(headers['content-type'], 'text/plain;charset=UTF-8');
  assert.throws(() => xhr.send(), hasName('InvalidStateError'));
  assert.throws(
    () => xhr.setRequestHeader('X-Late', 'not allowed'),
    hasName('InvalidStateError')
  );
  assert.throws(() => { xhr.withCredentials = false; }, hasName('InvalidStateError'));

  await completeRequest(runtime, 0, { status: 201, statusText: 'Created', body: 'accepted' });
  assert.equal(xhr.status, 201);
  assert.equal(xhr.responseText, 'accepted');
  assert.deepEqual(states, [xhr.OPENED, xhr.HEADERS_RECEIVED, xhr.LOADING, xhr.DONE]);
});

test('response types use the real binary and text helpers, preserve object identity, and filter headers', async () => {
  const cases = [
    {
      type: 'json',
      body: '{"answer":42}',
      contentType: 'application/json',
      check(response) {
        assert.deepEqual(JSON.parse(JSON.stringify(response)), { answer: 42 });
      }
    },
    {
      type: 'arraybuffer',
      body: [0, 127, 128, 255],
      contentType: 'application/octet-stream',
      check(response) {
        assert.deepEqual(Array.from(new Uint8Array(response)), [0, 127, 128, 255]);
      }
    },
    {
      type: 'blob',
      body: [0, 127, 128, 255],
      contentType: 'application/octet-stream',
      async check(response) {
        assert.equal(response.size, 4);
        assert.equal(response.type, 'application/octet-stream');
        assert.deepEqual(Array.from(await response.bytes()), [0, 127, 128, 255]);
      }
    },
    {
      // This runtime exposes only its bundled HTML parser subset here; this
      // case does not claim XML response parsing conformance.
      type: 'document',
      body: '<!doctype html><title>native parser</title><p>native parser seam</p>',
      contentType: 'text/html',
      check(response) {
        assert.equal(response.nodeType, 9);
        assert.equal(response.documentElement.localName, 'html');
        assert.equal(response.querySelector('title').textContent, 'native parser');
        assert.equal(response.body.textContent, 'native parser seam');
        assert.equal(response.URL, 'https://example.test/final/typed');
      }
    }
  ];

  for (const item of cases) {
    const runtime = createRuntime();
    const xhr = new runtime.XMLHttpRequest();
    xhr.responseType = item.type;
    xhr.open('GET', '/typed');
    xhr.send();
    await completeRequest(runtime, 0, {
      body: item.body,
      headers: [
        ['content-type', item.contentType],
        ['x-result', 'visible'],
        ['set-cookie', 'private=hidden']
      ],
      url: 'https://example.test/final/typed'
    });

    assert.equal(xhr.status, 200);
    assert.equal(xhr.responseURL, 'https://example.test/final/typed');
    assert.equal(xhr.getResponseHeader('X-Result'), 'visible');
    assert.equal(xhr.getResponseHeader('Set-Cookie'), null);
    assert.doesNotMatch(xhr.getAllResponseHeaders(), /set-cookie/i);
    const response = xhr.response;
    assert.equal(xhr.response, response);
    await item.check(response, runtime);
    assert.throws(() => xhr.responseText, hasName('InvalidStateError'));
  }

  const textRuntime = createRuntime();
  const textXhr = new textRuntime.XMLHttpRequest();
  textXhr.open('GET', '/text');
  textXhr.send();
  await completeRequest(textRuntime, 0, { body: 'plain text' });
  assert.equal(textXhr.response, 'plain text');
  assert.equal(textXhr.responseText, 'plain text');
});

test('abort resets after DONE events and late completion is ignored; timeout changes remain live', async () => {
  const abortRuntime = createRuntime();
  const xhr = new abortRuntime.XMLHttpRequest();
  const abortTrace = [];
  capture(xhr, abortTrace);
  xhr.open('GET', '/abort');
  xhr.send();
  assert.deepEqual(
    abortTrace.map(event => event.type + ':' + event.state),
    ['readystatechange:1', 'loadstart:1']
  );
  const pendingRequest = abortRuntime.requests[0];
  assert.ok(pendingRequest);

  xhr.abort();
  assert.deepEqual(
    abortTrace.map(event => event.type + ':' + event.state),
    [
      'readystatechange:1', 'loadstart:1',
      'readystatechange:4', 'abort:4', 'loadend:4'
    ]
  );
  assert.equal(xhr.readyState, xhr.UNSENT);
  assert.equal(xhr.status, 0);
  assert.equal(xhr.responseURL, '');
  assert.equal(xhr.response, '');
  assert.equal(abortRuntime.fetchRuntime.complete({
    id: pendingRequest.id,
    ok: true,
    status: 200,
    bodyBytes: responseBytes('too late')
  }), false);
  await abortRuntime.pump();
  assert.equal(xhr.readyState, xhr.UNSENT);
  assert.equal(abortTrace.length, 5);

  const loadingRuntime = createRuntime();
  const loading = new loadingRuntime.XMLHttpRequest();
  const loadingTrace = [];
  capture(loading, loadingTrace);
  let abortedWhileLoading = false;
  loading.addEventListener('readystatechange', () => {
    if (loading.readyState === loading.LOADING && !abortedWhileLoading) {
      abortedWhileLoading = true;
      loading.abort();
    }
  });
  loading.open('GET', '/abort-while-loading');
  loading.send();
  await completeRequest(loadingRuntime, 0, { body: 'cancel during loading' });
  assert.equal(loading.readyState, loading.UNSENT);
  assert.deepEqual(
    loadingTrace
      .filter(event => ['readystatechange', 'abort', 'loadend'].includes(event.type))
      .map(event => event.type + ':' + event.state),
    [
      'readystatechange:1', 'readystatechange:2', 'readystatechange:3',
      'readystatechange:4', 'abort:4', 'loadend:4'
    ]
  );
  assert.equal(loadingTrace.some(event => event.type === 'load'), false);
  const trailingProgress = loadingTrace.filter(event => event.type === 'progress').at(-1);
  assert.ok(trailingProgress);
  assert.equal(trailingProgress.state, loading.UNSENT);
  assert.equal(trailingProgress.loaded, 0);

  const timeoutRuntime = createRuntime();
  const timed = new timeoutRuntime.XMLHttpRequest();
  const timeoutTrace = [];
  capture(timed, timeoutTrace);
  timed.timeout = 25;
  timed.open('GET', '/timeout');
  timed.send();
  await timeoutRuntime.advance(10);
  timed.timeout = 40;
  await timeoutRuntime.advance(29);
  assert.equal(timed.readyState, timed.OPENED);
  assert.equal(timeoutTrace.some(event => event.type === 'timeout'), false);
  await timeoutRuntime.advance(1);
  assert.deepEqual(
    timeoutTrace.map(event => event.type + ':' + event.state),
    [
      'readystatechange:1', 'loadstart:1',
      'readystatechange:4', 'timeout:4', 'loadend:4'
    ]
  );
  assert.equal(timed.readyState, timed.DONE);
  assert.equal(timed.status, 0);
  assert.equal(timed.responseURL, '');
  assert.equal(timeoutRuntime.fetchRuntime.complete({
    id: timeoutRuntime.requests[0].id,
    ok: true,
    status: 200,
    bodyBytes: responseBytes('too late')
  }), false);
});

test('reopening from DONE readystatechange isolates the new request generation', async () => {
  const runtime = createRuntime();
  const xhr = new runtime.XMLHttpRequest();
  const trace = [];
  let restarted = false;
  xhr.addEventListener('readystatechange', () => {
    trace.push('state:' + xhr.readyState);
    if (xhr.readyState === xhr.DONE && !restarted) {
      restarted = true;
      xhr.open('GET', '/second');
      xhr.send();
    }
  });
  xhr.addEventListener('load', () => trace.push('load:' + xhr.readyState));
  xhr.addEventListener('loadend', () => trace.push('loadend:' + xhr.readyState));

  xhr.open('GET', '/first');
  xhr.send();
  await completeRequest(runtime, 0, { body: 'first response' });

  assert.equal(runtime.requests.length, 2);
  assert.equal(runtime.requests[1].url, 'https://example.test/second');
  assert.equal(xhr.readyState, xhr.OPENED);
  assert.equal(xhr.responseText, '');
  assert.equal(trace.some(item => item === 'load:4'), false);
  assert.equal(trace.some(item => item.startsWith('loadend:')), false);

  await completeRequest(runtime, 1, { body: 'second response' });
  assert.equal(xhr.readyState, xhr.DONE);
  assert.equal(xhr.responseText, 'second response');
  assert.equal(trace.filter(item => item.startsWith('load:')).length, 1);
  assert.equal(trace.filter(item => item.startsWith('loadend:')).length, 1);
});

test('upload listeners force preflight and handler replacement errors do not stop later listeners', async () => {
  const runtime = createRuntime('https://page.example.test/docs/form');
  const xhr = new runtime.XMLHttpRequest();
  const uploadTrace = [];
  const handlerTrace = [];

  xhr.upload.addEventListener('loadstart', event =>
    uploadTrace.push(event.type)
  );
  xhr.upload.addEventListener('progress', event =>
    uploadTrace.push(event.type)
  );
  xhr.upload.addEventListener('load', event =>
    uploadTrace.push(event.type)
  );
  xhr.upload.addEventListener('loadend', event =>
    uploadTrace.push(event.type)
  );

  xhr.onload = () => handlerTrace.push('old handler');
  xhr.addEventListener('load', () => handlerTrace.push('ordinary listener'));
  xhr.onload = () => {
    handlerTrace.push('replacement handler');
    throw new Error('replacement handler failure');
  };
  xhr.addEventListener('load', () => {
    handlerTrace.push('throwing listener');
    throw new Error('ordinary listener failure');
  });
  xhr.addEventListener('load', () => handlerTrace.push('after throwing listener'));

  xhr.open('POST', 'https://api.example.test/upload');
  xhr.send('body');
  assert.equal(runtime.requests.length, 1);
  assert.equal(runtime.requests[0].forcePreflight, true);
  assert.deepEqual(uploadTrace, ['loadstart']);

  await completeRequest(runtime, 0, { body: 'uploaded' });
  assert.deepEqual(handlerTrace, [
    'replacement handler',
    'ordinary listener',
    'throwing listener',
    'after throwing listener'
  ]);
  assert.deepEqual(
    runtime.reportedErrors.map(error => error.message),
    ['replacement handler failure', 'ordinary listener failure']
  );
  assert.deepEqual(uploadTrace, ['loadstart', 'progress', 'load', 'loadend']);

  const noUploadListeners = createRuntime('https://page.example.test/docs/form');
  const plain = new noUploadListeners.XMLHttpRequest();
  plain.open('POST', 'https://api.example.test/upload');
  plain.send('body');
  assert.equal(noUploadListeners.requests.length, 1);
  assert.equal(noUploadListeners.requests[0].forcePreflight, undefined);
});
