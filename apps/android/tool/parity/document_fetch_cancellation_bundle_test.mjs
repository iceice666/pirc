import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import nativeVm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';
const vm=createDocumentScriptHostVm(nativeVm);

const bundlePath = process.env.PIRC_DOCUMENT_SCRIPT_RUNTIME_BUNDLE || fileURLToPath(
  new URL('../../assets/document-script-runtime.js', import.meta.url)
);
const bundle = readFileSync(bundlePath, 'utf8');
const RUN_TIMEOUT_MS = 3000;

function createRuntime() {
  const context = vm.createContext({});
  new vm.Script(bundle, { filename: 'document-script-runtime.js' }).runInContext(
    context,
    { timeout: RUN_TIMEOUT_MS }
  );
  return context;
}

function call(context, method, argument = {}) {
  const expression =
    '__pircDocument.' + method + '(' + JSON.stringify(argument) + ')';
  const serialized = new vm.Script(expression).runInContext(context, {
    timeout: RUN_TIMEOUT_MS
  });
  return JSON.parse(serialized);
}

function evaluate(context, source) {
  return new vm.Script(source).runInContext(context, { timeout: RUN_TIMEOUT_MS });
}

function initialize(source) {
  const context = createRuntime();
  const initial = call(context, 'init', {
    url: 'https://example.test/docs/page.html',
    html: '<!doctype html><script>' + source + '</script>',
    now: 0
  });
  assert.deepEqual(initial.diagnostics.filter(item => item.severity === 'error'), []);
  return { context, initial };
}

function completion(id, body = '') {
  return {
    id,
    ok: true,
    status: 200,
    statusText: 'OK',
    url: 'https://example.test/docs/result',
    headers: [['content-type', 'text/plain;charset=UTF-8']],
    bodyBase64: Buffer.from(body, 'utf8').toString('base64')
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('abort after a snapshot reports the enqueued request ID once', () => {
  const { context, initial } = initialize([
    'window.controller = new AbortController();',
    'window.pending = fetch("/slow", { signal: controller.signal }).catch(() => {});'
  ].join('\n'));
  const id = initial.resourceRequests[0].id;
  assert.equal(initial.resourceRequests[0].kind, 'fetch');
  assert.deepEqual(initial.resourceCancellations, []);

  assert.deepEqual(call(context, 'snapshot').resourceCancellations, []);
  evaluate(context, 'controller.abort(); controller.abort();');

  assert.deepEqual(call(context, 'snapshot').resourceCancellations, [id]);
  assert.deepEqual(call(context, 'snapshot').resourceCancellations, []);
});

test('same-batch abort keeps the canceled request out of the HTTP dispatch batch', () => {
  const { initial } = initialize([
    'window.controller = new AbortController();',
    'window.pending = fetch("/never-dispatched", { signal: controller.signal }).catch(() => {});',
    'controller.abort();'
  ].join('\n'));

  assert.deepEqual(initial.resourceRequests, []);
  assert.deepEqual(initial.resourceCancellations, ['fetch-1']);
});

test('a signal aborted before fetch does not report a request that was never enqueued', () => {
  const { initial } = initialize([
    'window.pending = fetch("/never-enqueued", { signal: AbortSignal.abort() }).catch(() => {});'
  ].join('\n'));

  assert.deepEqual(initial.resourceRequests, []);
  assert.deepEqual(initial.resourceCancellations, []);
});

test('abort after completion does not report a cancellation', async () => {
  const { context, initial } = initialize([
    'window.controller = new AbortController();',
    'window.loaded = false;',
    'window.pending = fetch("/complete", { signal: controller.signal })',
    '  .then(() => { window.loaded = true; }, () => {});'
  ].join('\n'));
  const id = initial.resourceRequests[0].id;

  call(context, 'completeResource', completion(id, 'done'));
  await flush();
  assert.equal(evaluate(context, 'loaded'), true);
  evaluate(context, 'controller.abort();');

  assert.deepEqual(call(context, 'snapshot').resourceCancellations, []);
});

test('XHR timeout and reopen report cancellation for the request they terminate', async () => {
  const timed = initialize([
    'window.events = [];',
    'window.xhr = new XMLHttpRequest();',
    'xhr.timeout = 5;',
    'xhr.ontimeout = () => events.push("timeout");',
    'xhr.open("GET", "/timeout");',
    'xhr.send();'
  ].join('\n'));
  const timedId = timed.initial.resourceRequests[0].id;
  const afterTimeout = call(timed.context, 'pump', { now: 5 });
  await flush();
  assert.deepEqual(JSON.parse(evaluate(timed.context, 'JSON.stringify(events)')), ['timeout']);
  assert.deepEqual(afterTimeout.resourceCancellations, [timedId]);

  const reopened = initialize([
    'window.xhr = new XMLHttpRequest();',
    'xhr.open("GET", "/first");',
    'xhr.send();'
  ].join('\n'));
  const firstId = reopened.initial.resourceRequests[0].id;
  evaluate(reopened.context, [
    'xhr.open("GET", "/second");',
    'xhr.send();'
  ].join('\n'));
  const afterOpen = call(reopened.context, 'snapshot');

  assert.deepEqual(afterOpen.resourceCancellations, [firstId]);
  assert.deepEqual(afterOpen.resourceRequests.map(request => request.id), ['fetch-2']);
  assert.equal(afterOpen.resourceRequests[0].url, 'https://example.test/second');
});

test('a stale request in one document owner does not cancel another owner request with the same ID', async () => {
  const oldOwner = initialize([
    'window.controller = new AbortController();',
    'window.pending = fetch("/old-owner", { signal: controller.signal }).catch(() => {});'
  ].join('\n'));
  const currentOwner = initialize([
    'window.controller = new AbortController();',
    'window.loaded = false;',
    'window.pending = fetch("/current-owner", { signal: controller.signal })',
    '  .then(() => { window.loaded = true; }, () => {});'
  ].join('\n'));
  const oldId = oldOwner.initial.resourceRequests[0].id;
  const currentId = currentOwner.initial.resourceRequests[0].id;
  assert.equal(oldId, currentId);

  evaluate(oldOwner.context, 'controller.abort();');
  assert.deepEqual(call(oldOwner.context, 'snapshot').resourceCancellations, [oldId]);
  assert.deepEqual(call(currentOwner.context, 'snapshot').resourceCancellations, []);
  assert.equal(call(currentOwner.context, 'completeResource', completion(currentId, 'still active')).resourceKind, 'fetch');
  await flush();
  assert.equal(evaluate(currentOwner.context, 'loaded'), true);
});
