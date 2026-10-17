import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import nativeVm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';
const vm=createDocumentScriptHostVm(nativeVm);

const builderPath = fileURLToPath(
  new URL('./build_document_script_runtime.py', import.meta.url),
);
const buildDirectory = mkdtempSync(
  join('/private/tmp', 'pirc-image-cancellation-'),
);
execFileSync('python3', [builderPath, '--output-dir', buildDirectory], {
  stdio: 'pipe',
});
after(() => rmSync(buildDirectory, { recursive: true, force: true }));

const bundle = readFileSync(
  join(buildDirectory, 'document-script-runtime.js'),
  'utf8',
);
const PAGE_URL = 'https://example.test/page.html';
const RUN_TIMEOUT_MS = 3000;

function createRuntime(html = '<canvas id="paint" width="16" height="16"></canvas>') {
  const context = vm.createContext({});
  new vm.Script(bundle, { filename: 'document-script-runtime.js' }).runInContext(
    context,
    { timeout: RUN_TIMEOUT_MS },
  );
  const initialized = invoke(context, 'init', { html, url: PAGE_URL });
  assert.deepEqual(
    initialized.diagnostics.filter((item) => item.severity === 'error'),
    [],
  );
  return context;
}

function invoke(context, method, argument = {}) {
  const expression =
    '__pircDocument.' + method + '(' + JSON.stringify(argument) + ')';
  const serialized = new vm.Script(expression).runInContext(context, {
    timeout: RUN_TIMEOUT_MS,
  });
  return JSON.parse(serialized);
}

function evaluate(context, source) {
  return new vm.Script(source).runInContext(context, {
    timeout: RUN_TIMEOUT_MS,
  });
}

function pageValue(context, expression) {
  return JSON.parse(evaluate(context, 'JSON.stringify(' + expression + ')'));
}

function imageCompletion(request, values = {}) {
  return {
    id: request.id,
    ok: true,
    imageId: 'native-' + request.id,
    width: 24,
    height: 12,
    originClean: true,
    ...values,
  };
}

async function flushPageMicrotasks(context) {
  for (let index = 0; index < 4; index++)
    await evaluate(context, 'Promise.resolve()');
}

test('a snapshotted replacement cancels HTTP and ignores its late decode and Canvas image', async () => {
  const context = createRuntime();
  evaluate(context, [
    'window.image = new Image();',
    'window.imageEvents = [];',
    'image.addEventListener("load", () => imageEvents.push("load"));',
    'image.addEventListener("error", () => imageEvents.push("error"));',
    'window.canvasContext = document.querySelector("#paint").getContext("2d");',
    'image.src = "/first.png";',
    'window.firstDecode = image.decode().then(() => "resolved", error => error.name);',
  ].join('\n'));

  const firstBatch = invoke(context, 'snapshot');
  const firstRequest = firstBatch.resourceRequests[0];
  assert.equal(firstRequest.url, 'https://example.test/first.png');
  assert.deepEqual(firstBatch.resourceCancellations, []);

  evaluate(context, [
    'image.src = "/next.png";',
    'window.nextDecode = image.decode();',
  ].join('\n'));
  assert.equal(await evaluate(context, 'firstDecode'), 'EncodingError');
  const replacementBatch = invoke(context, 'snapshot');
  const nextRequest = replacementBatch.resourceRequests[0];
  assert.equal(nextRequest.url, 'https://example.test/next.png');
  assert.deepEqual(replacementBatch.resourceCancellations, [firstRequest.id]);
  assert.equal(replacementBatch.canvases[0].revision, 0);

  await flushPageMicrotasks(context);
  evaluate(context, 'canvasContext.drawImage(image, 0, 0)');
  const stale = invoke(context, 'completeResource', imageCompletion(firstRequest, {
    imageId: 'late-old-image', width: 91, height: 73,
  }));
  assert.equal(stale.resourceIgnored, true);
  assert.equal(stale.canvases[0].revision, 0);
  assert.deepEqual(pageValue(context, `({
    currentSrc: image.currentSrc,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    complete: image.complete,
    events: imageEvents.slice()
  })`), {
    currentSrc: '',
    naturalWidth: 0,
    naturalHeight: 0,
    complete: false,
    events: [],
  });

  const accepted = invoke(context, 'completeResource', imageCompletion(nextRequest, {
    imageId: 'new-image', width: 20, height: 10,
  }));
  assert.equal(accepted.resourceIgnored, false);
  await evaluate(context, 'nextDecode');
  await flushPageMicrotasks(context);
  evaluate(context, 'canvasContext.drawImage(image, 0, 0)');
  const finalBatch = invoke(context, 'snapshot');
  assert.deepEqual(finalBatch.resourceCancellations, []);
  assert.equal(finalBatch.canvases[0].revision, 1);
  assert.equal(finalBatch.canvases[0].commands[0].args[0], 'new-image');
  assert.deepEqual(pageValue(context, `({
    currentSrc: image.currentSrc,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    events: imageEvents.slice()
  })`), {
    currentSrc: 'https://example.test/next.png',
    naturalWidth: 20,
    naturalHeight: 10,
    events: ['load'],
  });
});

test('pending same-URL and referrer-policy changes keep the request; later sources use the new policy', async () => {
  const context = createRuntime('<img id="image">');
  evaluate(context, 'window.image = document.querySelector("#image"); image.src = "asset.png"');
  const firstBatch = invoke(context, 'snapshot');
  const firstRequest = firstBatch.resourceRequests[0];
  assert.equal(firstRequest.url, 'https://example.test/asset.png');

  evaluate(context, [
    'window.firstDecode = image.decode().then(() => "resolved", error => error.name);',
    'image.src = "https://example.test/asset.png";',
    'image.referrerPolicy = "no-referrer";',
  ].join('\n'));
  const unchangedBatch = invoke(context, 'snapshot');
  assert.deepEqual(unchangedBatch.resourceRequests, []);
  assert.deepEqual(unchangedBatch.resourceCancellations, []);
  assert.equal(pageValue(context, 'image.complete'), false);

  evaluate(context, 'image.src = "/different.png"');
  const changedBatch = invoke(context, 'snapshot');
  const changedRequest = changedBatch.resourceRequests[0];
  assert.equal(changedRequest.url, 'https://example.test/different.png');
  assert.equal(changedRequest.referrerPolicy, 'no-referrer');
  assert.deepEqual(changedBatch.resourceCancellations, [firstRequest.id]);
  assert.equal(await evaluate(context, 'firstDecode'), 'EncodingError');

  evaluate(context, 'image.crossOrigin = "anonymous"');
  const corsBatch = invoke(context, 'snapshot');
  assert.equal(corsBatch.resourceRequests[0].url, changedRequest.url);
  assert.equal(corsBatch.resourceRequests[0].crossOrigin, 'anonymous');
  assert.equal(corsBatch.resourceRequests[0].referrerPolicy, 'no-referrer');
  assert.deepEqual(corsBatch.resourceCancellations, [changedRequest.id]);

  evaluate(context, 'image.removeAttribute("src")');
  const removedBatch = invoke(context, 'snapshot');
  assert.deepEqual(removedBatch.resourceRequests, []);
  assert.deepEqual(removedBatch.resourceCancellations, [corsBatch.resourceRequests[0].id]);
  await flushPageMicrotasks(context);
  assert.deepEqual(pageValue(context, `({
    complete: image.complete,
    currentSrc: image.currentSrc,
    naturalWidth: image.naturalWidth
  })`), { complete: true, currentSrc: '', naturalWidth: 0 });
});

test('empty src cancels pending HTTP, reports asynchronous error, and does not fetch the document URL', async () => {
  const context = createRuntime('<img id="image">');
  evaluate(context, [
    'window.image = document.querySelector("#image");',
    'window.imageEvents = [];',
    'image.addEventListener("load", () => imageEvents.push("load"));',
    'image.addEventListener("error", () => imageEvents.push("error"));',
    'image.src = "/pending.png";',
    'window.pendingDecode = image.decode().then(() => "resolved", error => error.name);',
  ].join('\n'));
  const initial = invoke(context, 'snapshot');
  const pendingRequest = initial.resourceRequests[0];

  evaluate(context, 'image.src = ""');
  assert.equal(await evaluate(context, 'pendingDecode'), 'EncodingError');
  const emptyBatch = invoke(context, 'snapshot');
  assert.deepEqual(emptyBatch.resourceRequests, []);
  assert.deepEqual(emptyBatch.resourceCancellations, [pendingRequest.id]);
  assert.equal(emptyBatch.diagnostics.some((item) =>
    item.code === 'image.invalid_source' || item.code === 'image.enqueue_error'), false);
  await flushPageMicrotasks(context);
  assert.deepEqual(pageValue(context, `({
    complete: image.complete,
    currentSrc: image.currentSrc,
    naturalWidth: image.naturalWidth,
    events: imageEvents.slice()
  })`), {
    complete: true,
    currentSrc: '',
    naturalWidth: 0,
    events: ['error'],
  });
  await assert.rejects(evaluate(context, 'image.decode()'), { name: 'EncodingError' });

  evaluate(context, [
    'image.src = "/pending-remove.png";',
    'window.removeDecode = image.decode().then(() => "resolved", error => error.name);',
  ].join('\n'));
  const removeStart = invoke(context, 'snapshot');
  const removeRequest = removeStart.resourceRequests[0];
  evaluate(context, 'image.removeAttribute("src")');
  assert.equal(await evaluate(context, 'removeDecode'), 'EncodingError');
  const removed = invoke(context, 'snapshot');
  assert.deepEqual(removed.resourceRequests, []);
  assert.deepEqual(removed.resourceCancellations, [removeRequest.id]);
  await flushPageMicrotasks(context);
  assert.deepEqual(pageValue(context, 'imageEvents.slice()'), ['error']);
  assert.equal(pageValue(context, 'image.currentSrc'), '');
});

test('same-batch replacement filters old work and replacing a completed request does not cancel it', () => {
  const context = createRuntime('<img id="image">');
  evaluate(context, [
    'window.image = document.querySelector("#image");',
    'image.src = "/same-batch-old.png";',
    'image.src = "/same-batch-new.png";',
  ].join('\n'));
  const sameBatch = invoke(context, 'snapshot');
  assert.equal(sameBatch.resourceRequests.length, 1);
  assert.equal(sameBatch.resourceRequests[0].url,
    'https://example.test/same-batch-new.png');
  assert.deepEqual(sameBatch.resourceCancellations, ['image-1']);

  invoke(context, 'completeResource', imageCompletion(sameBatch.resourceRequests[0], {
    imageId: 'completed-image',
  }));
  evaluate(context, 'image.src = "/after-complete.png"');
  const afterComplete = invoke(context, 'snapshot');
  assert.equal(afterComplete.resourceRequests.length, 1);
  assert.equal(afterComplete.resourceRequests[0].url,
    'https://example.test/after-complete.png');
  assert.deepEqual(afterComplete.resourceCancellations, []);
});

test('cancellation stays with its image and runtime owner', () => {
  const firstOwner = createRuntime('<img id="first"><img id="second">');
  evaluate(firstOwner, [
    'window.first = document.querySelector("#first");',
    'window.second = document.querySelector("#second");',
    'first.src = "/first.png";',
    'second.src = "/second.png";',
  ].join('\n'));
  const ownerBatch = invoke(firstOwner, 'snapshot');
  const firstRequest = ownerBatch.resourceRequests[0];
  const secondRequest = ownerBatch.resourceRequests[1];
  evaluate(firstOwner, 'first.src = "/first-next.png"');
  const firstReplacement = invoke(firstOwner, 'snapshot');
  assert.deepEqual(firstReplacement.resourceCancellations, [firstRequest.id]);
  assert.deepEqual(firstReplacement.resourceRequests.map((item) => item.url), [
    'https://example.test/first-next.png',
  ]);
  assert.equal(pageValue(firstOwner, 'second.complete'), false);

  const secondOwner = createRuntime('<img id="image">');
  evaluate(secondOwner, [
    'window.image = document.querySelector("#image");',
    'image.src = "/other-owner.png";',
  ].join('\n'));
  const secondOwnerInitial = invoke(secondOwner, 'snapshot');
  assert.equal(secondRequest.id, 'image-2');
  assert.equal(secondOwnerInitial.resourceRequests[0].id, 'image-1');
  evaluate(firstOwner, 'first.src = "/first-latest.png"');
  const firstOwnerAgain = invoke(firstOwner, 'snapshot');
  const untouchedOwner = invoke(secondOwner, 'snapshot');
  assert.deepEqual(firstOwnerAgain.resourceCancellations, ['image-3']);
  assert.deepEqual(untouchedOwner.resourceCancellations, []);
  assert.deepEqual(untouchedOwner.resourceRequests, []);
});

function installReentrantEnqueue(context, throwAfterReplacement) {
  evaluate(context, `
    window.image = document.querySelector('#image');
    window.savedPush = Array.prototype.push;
    window.interceptImageEnqueue = true;
    window.failImageEnqueueAfterReplacement = ${Boolean(throwAfterReplacement)};
    Array.prototype.push = function(...items) {
      if (window.interceptImageEnqueue &&
          items.some(item => item && item.kind === 'image')) {
        window.interceptImageEnqueue = false;
        document.querySelector('#image').src = '/reentrant-next.png';
        if (window.failImageEnqueueAfterReplacement)
          throw new Error('simulated synchronous enqueue failure');
      }
      return window.savedPush.apply(this, items);
    };
    document.querySelector('#image').src = '/reentrant-first.png';
    Array.prototype.push = window.savedPush;
  `);
}

test('synchronous enqueue reentry cancels only after success and cannot overwrite a newer source on failure', () => {
  const successful = createRuntime('<img id="image">');
  installReentrantEnqueue(successful, false);
  const successfulBatch = invoke(successful, 'snapshot');
  assert.deepEqual(successfulBatch.resourceRequests.map((item) => item.id), ['image-2']);
  assert.equal(successfulBatch.resourceRequests[0].url,
    'https://example.test/reentrant-next.png');
  assert.deepEqual(successfulBatch.resourceCancellations, ['image-1']);
  assert.equal(pageValue(successful, 'image.src'),
    'https://example.test/reentrant-next.png');

  const failed = createRuntime('<img id="image">');
  installReentrantEnqueue(failed, true);
  const failedBatch = invoke(failed, 'snapshot');
  assert.deepEqual(failedBatch.resourceRequests.map((item) => item.id), ['image-2']);
  assert.equal(failedBatch.resourceRequests[0].url,
    'https://example.test/reentrant-next.png');
  assert.deepEqual(failedBatch.resourceCancellations, []);
  assert.equal(pageValue(failed, 'image.src'),
    'https://example.test/reentrant-next.png');
  assert.equal(failedBatch.diagnostics.some((item) => item.code === 'image.enqueue_error'), false);
});
