import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const binarySource = readFileSync(new URL('./document_binary_source.js', import.meta.url), 'utf8');
const objectUrlSource = readFileSync(new URL('./document_object_url_source.js', import.meta.url), 'utf8');

function environment(nonce = 'a'.repeat(48), baseUrl = 'https://example.test/path/page.html') {
  const context = vm.createContext({ URL });
  new vm.Script(binarySource + '\nthis.__binaryFactory = createDocumentBinary;' +
    '\n' + objectUrlSource +
    '\nthis.__objectUrlFactory = createDocumentObjectUrls;', {
    filename: 'document_object_url_sources.js'
  }).runInContext(context);
  const binary = vm.runInContext('new __binaryFactory({})', context);
  context.__objectUrlDeps = { binary, baseUrl, nonce, URL };
  const objectUrls = vm.runInContext('new __objectUrlFactory(__objectUrlDeps)', context);
  return { binary, objectUrls };
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

test('creates opaque origin-scoped URLs and snapshots branded Blob bytes', () => {
  const first = environment('a'.repeat(48));
  const second = environment('b'.repeat(48));
  const payload = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff]);
  const blob = new first.binary.Blob([payload], { type: 'image/x-test' });
  const url = first.objectUrls.createObjectURL(blob);
  const otherUrl = second.objectUrls.createObjectURL(
    new second.binary.Blob([payload], { type: 'image/x-test' })
  );

  assert.match(url, /^blob:https:\/\/example\.test\//);
  assert.notEqual(url, otherUrl);
  assert.deepEqual(snapshot(first.objectUrls.read(url)), {
    url,
    type: 'image/x-test',
    size: payload.length,
    bytesBase64: payload.toString('base64')
  });
  assert.throws(() => second.objectUrls.read(url), error => error.name === 'TypeError');
  assert.throws(() => first.objectUrls.createObjectURL({ size: payload.length }),
    error => error.name === 'TypeError');
});

test('missing host nonce does not break factory creation but blocks URL creation', () => {
  const { binary, objectUrls } = environment('');
  const blob = new binary.Blob(['x']);
  assert.throws(() => objectUrls.createObjectURL(blob), error => error.name === 'TypeError');
});

test('enforces per-Blob and aggregate registry bounds without eviction', () => {
  const { binary, objectUrls } = environment();
  const tooLarge = binary.fileFromHost({ name: 'large.bin', size: 2 * 1024 * 1024 + 1 });
  assert.throws(() => objectUrls.createObjectURL(tooLarge), error => error.name === 'RangeError');

  const maxBlob = new binary.Blob([new Uint8Array(2 * 1024 * 1024)]);
  const urls = [];
  for (let index = 0; index < 8; index += 1) {
    urls.push(objectUrls.createObjectURL(maxBlob));
  }
  assert.throws(() => objectUrls.createObjectURL(maxBlob), error => error.name === 'RangeError');
  objectUrls.revokeObjectURL(urls[0]);
  assert.doesNotThrow(() => objectUrls.createObjectURL(maxBlob));

  const { binary: emptyBinary, objectUrls: countLimited } = environment('c'.repeat(48));
  const empty = new emptyBinary.Blob([]);
  for (let index = 0; index < 128; index += 1) {
    countLimited.createObjectURL(empty);
  }
  assert.throws(() => countLimited.createObjectURL(empty), error => error.name === 'RangeError');
});

test('revocation is local, exact-match, idempotent, and does not mutate held bytes', () => {
  const first = environment('d'.repeat(48));
  const second = environment('e'.repeat(48));
  const blob = new first.binary.Blob([new Uint8Array([10, 20, 30])], {
    type: 'application/octet-stream'
  });
  const url = first.objectUrls.createObjectURL(blob);

  first.objectUrls.revokeObjectURL('not a blob URL');
  first.objectUrls.revokeObjectURL(url + '#fragment');
  first.objectUrls.revokeObjectURL(second.objectUrls.createObjectURL(new second.binary.Blob([])));
  assert.equal(first.objectUrls.read(url).size, 3);

  const response = first.objectUrls.resolveFetch(url, 'GET', []);
  first.objectUrls.revokeObjectURL(url);
  first.objectUrls.revokeObjectURL(url);
  assert.deepEqual([...response.bodyBytes], [10, 20, 30]);
  assert.deepEqual(snapshot(first.objectUrls.resolveFetch(url, 'GET', [])), {
    ok: false, error: 'Failed to fetch.'
  });
  assert.throws(() => first.objectUrls.read(url), error => error.name === 'TypeError');
});

test('blob fetch supports GET and valid single byte ranges with Chrome response metadata', () => {
  const { binary, objectUrls } = environment();
  const payload = Uint8Array.from({ length: 10 }, (_, index) => index + 1);
  const url = objectUrls.createObjectURL(new binary.Blob([payload], { type: 'image/png' }));

  const full = objectUrls.resolveFetch(url, 'GET', []);
  assert.equal(full.status, 200);
  assert.equal(full.statusText, 'OK');
  assert.equal(full.url, url);
  assert.deepEqual(snapshot(full.headers), [
    ['content-type', 'image/png'],
    ['content-length', '10']
  ]);
  assert.deepEqual([...full.bodyBytes], [...payload]);

  const firstRange = objectUrls.resolveFetch(url, 'GET', [['range', 'bytes=0-3']]);
  assert.equal(firstRange.status, 206);
  assert.equal(firstRange.statusText, 'OK');
  assert.deepEqual(snapshot(firstRange.headers), [
    ['content-type', 'image/png'],
    ['content-length', '4'],
    ['content-range', 'bytes 0-3/10']
  ]);
  assert.deepEqual([...firstRange.bodyBytes], [1, 2, 3, 4]);

  const suffix = objectUrls.resolveFetch(url, 'GET', { Range: 'bytes=-4' });
  assert.deepEqual([...suffix.bodyBytes], [7, 8, 9, 10]);
  assert.equal(suffix.headers.at(-1)[1], 'bytes 6-9/10');

  const openEnded = objectUrls.resolveFetch(url, 'GET', [['range', 'bytes=0-']]);
  assert.equal(openEnded.status, 206);
  assert.deepEqual([...openEnded.bodyBytes], [...payload]);

  const clampedEnd = objectUrls.resolveFetch(url, 'GET', [['range', 'bytes=0-999']]);
  assert.equal(clampedEnd.status, 206);
  assert.equal(clampedEnd.headers.at(-1)[1], 'bytes 0-9/10');
  assert.deepEqual([...clampedEnd.bodyBytes], [...payload]);
});

test('blob fetch strips fragments, rejects queries, unsupported methods, and invalid ranges', () => {
  const { binary, objectUrls } = environment();
  const url = objectUrls.createObjectURL(new binary.Blob(['abc'], { type: 'text/plain' }));

  const fragment = objectUrls.resolveFetch(url + '#frag', 'GET', []);
  assert.equal(fragment.url, url);
  assert.deepEqual([...fragment.bodyBytes], [97, 98, 99]);
  assert.deepEqual(snapshot(objectUrls.resolveFetch(url + '?q=1', 'GET', [])), {
    ok: false, error: 'Failed to fetch.'
  });
  for (const method of ['HEAD', 'POST']) {
    assert.deepEqual(snapshot(objectUrls.resolveFetch(url, method, [])), {
      ok: false, error: 'Failed to fetch.'
    });
  }
  for (const range of [
    'items=0-2', 'bytes=abc', 'bytes=3-1', 'bytes=0-0,4-5', 'bytes=9-'
  ]) {
    assert.deepEqual(snapshot(objectUrls.resolveFetch(url, 'GET', [['Range', range]])), {
      ok: false, error: 'Failed to fetch.'
    });
  }
});

test('empty Blob GET keeps type and zero content length; any byte range fails', () => {
  const { binary, objectUrls } = environment();
  const url = objectUrls.createObjectURL(new binary.Blob([], { type: 'application/x-empty' }));
  const response = objectUrls.resolveFetch(url, 'GET', []);
  assert.equal(response.status, 200);
  assert.equal(response.statusText, 'OK');
  assert.deepEqual(snapshot(response.headers), [
    ['content-type', 'application/x-empty'],
    ['content-length', '0']
  ]);
  assert.equal(response.bodyBytes.length, 0);
  assert.deepEqual(snapshot(objectUrls.resolveFetch(url, 'GET', [['range', 'bytes=0-0']])), {
    ok: false, error: 'Failed to fetch.'
  });
});
