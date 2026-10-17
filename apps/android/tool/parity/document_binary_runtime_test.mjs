import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { URL, URLSearchParams } from 'node:url';

const directory = new URL('.', import.meta.url);
const binarySource = readFileSync(new URL('./document_binary_source.js', directory), 'utf8');
const fetchSource = readFileSync(new URL('./document_fetch_source.js', directory), 'utf8');

function createBinaryRuntime(dependencies = {}) {
  const context = vm.createContext({ URL, URLSearchParams });
  new vm.Script(binarySource + '\nthis.__binaryFactory = createDocumentBinary;', {
    filename: 'document_binary_source.js'
  }).runInContext(context);
  context.__deps = dependencies;
  const binary = vm.runInContext('new __binaryFactory(__deps)', context, {
    contextCodeGeneration: { strings: true, wasm: false }
  });
  return { binary, context };
}

function createFetchRuntime() {
  const context = vm.createContext({ URL, URLSearchParams });
  new vm.Script(
    binarySource + '\n' + fetchSource +
      '\nthis.__binaryFactory = createDocumentBinary; this.__fetchFactory = createDocumentFetch;',
    { filename: 'document_binary_fetch_runtime.js' }
  ).runInContext(context);
  const requests = [];
  context.__enqueue = request => requests.push(JSON.parse(JSON.stringify(request)));
  context.__deps = {
    URL,
    URLSearchParams,
    baseUrl: 'https://example.test/forms/page.html',
    binary: vm.runInContext('new __binaryFactory({})', context),
    enqueue: context.__enqueue
  };
  const api = vm.runInContext('new __fetchFactory(__deps)', context);
  return { api, binary: context.__deps.binary, context, requests };
}

function entries(formData) {
  return Array.from(formData, ([name, value]) => [
    name,
    value && typeof value.arrayBuffer === 'function'
      ? { name: value.name, type: value.type, size: value.size }
      : value
  ]);
}

test('Blob/File copy and bound string, ArrayBuffer, view, and nested Blob parts', async () => {
  const { binary } = createBinaryRuntime();
  const source = new Uint8Array([90, 1, 2, 3, 91]);
  const nested = new binary.Blob([source.subarray(1, 4)], { type: 'Application/Octet-Stream' });
  source.fill(0);
  const buffer = new Uint8Array([10, 11, 12, 13]).buffer;
  const blob = new binary.Blob(['猫', buffer, nested], { type: 'text/plain' });
  new Uint8Array(buffer).fill(99);

  const expected = Buffer.concat([
    Buffer.from('猫', 'utf8'), Buffer.from([10, 11, 12, 13]), Buffer.from([1, 2, 3])
  ]);
  assert.equal(blob.size, expected.length);
  assert.equal(blob.type, 'text/plain');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), expected);
  assert.deepEqual(Buffer.from(await blob.bytes()), expected);
  const returnedBytes = await blob.bytes();
  returnedBytes.fill(0);
  assert.deepEqual(Buffer.from(await blob.bytes()), expected);
  assert.equal(await blob.slice(3, 7, 'application/test').text(), '\n\x0b\x0c\r');
  assert.equal(blob.slice(0, 1, 'APPLICATION/TEST').type, 'application/test');

  assert.throws(() => new binary.Blob('primitive string'), /iterable object/i);
  assert.throws(() => new binary.Blob(null), /iterable object/i);
  assert.equal(new binary.Blob(undefined).size, 0);
  assert.throws(() => new binary.File([blob]), /name is required/i);
  const undefinedNameFile = new binary.File([], undefined, { lastModified: 1234 });
  assert.equal(undefinedNameFile.name, 'undefined');

  const file = new binary.File([blob], 'notes-猫.txt', {
    type: 'Text/Plain', lastModified: 1234
  });
  assert.equal(file.name, 'notes-猫.txt');
  assert.equal(file.lastModified, 1234);
  assert.equal(file[Symbol.toStringTag], 'File');
  assert.equal(file.type, 'text/plain');
  assert.deepEqual(Buffer.from(await file.bytes()), expected);

  assert.throws(
    () => new binary.Blob([new Uint8Array(2 * 1024 * 1024 + 1)]),
    /cannot exceed 2 MiB/i
  );
});

test('host File metadata is retained and unavailable bytes never become an empty upload', async () => {
  const { binary } = createBinaryRuntime();
  const content = Buffer.from([0, 127, 128, 255]);
  const file = binary.fileFromHost({
    name: '資料.bin', type: 'application/octet-stream', size: content.length,
    lastModified: 1700000000000, bytesBase64: content.toString('base64')
  });
  assert.equal(file.name, '資料.bin');
  assert.equal(file.size, 4);
  assert.equal(file.lastModified, 1700000000000);
  assert.deepEqual(Buffer.from(await file.bytes()), content);

  const oldMetadataOnly = binary.fileFromHost({
    name: 'oversized.bin', type: 'application/octet-stream', size: 9000000
  });
  assert.equal(oldMetadataOnly.name, 'oversized.bin');
  assert.equal(oldMetadataOnly.type, 'application/octet-stream');
  assert.equal(oldMetadataOnly.size, 9000000);
  assert.throws(() => binary.getBytes(oldMetadataOnly), /unavailable/i);
  await assert.rejects(oldMetadataOnly.text(), /unavailable/i);
  await assert.rejects(oldMetadataOnly.arrayBuffer(), /unavailable/i);
  await assert.rejects(oldMetadataOnly.bytes(), /unavailable/i);
  assert.throws(() => oldMetadataOnly.slice(0, 1), /unavailable/i);
  assert.throws(() => binary.encodeBody(oldMetadataOnly), /unavailable/i);

  const unavailable = binary.fileFromHost({
    name: 'large.bin', type: 'application/octet-stream', size: 3000000,
    contentError: 'Selected file contents exceed the upload budget.'
  });
  const metadataForm = new binary.FormData();
  metadataForm.append('file', unavailable);
  assert.equal(metadataForm.get('file').name, 'large.bin');
  assert.equal(metadataForm.get('file').size, 3000000);
  assert.throws(() => binary.encodeBody(metadataForm), /upload budget/i);

  const empty = binary.fileFromHost({ name: 'empty.txt', type: 'text/plain', size: 0 });
  assert.equal(empty.size, 0);
  assert.deepEqual(Array.from(await empty.bytes()), []);
});

test('FormData form callback, event mutation, ordering, duplicate names, and multipart round trip', async () => {
  const form = { tag: 'form' }, submitter = { name: 'send' };
  const noDomBinary = createBinaryRuntime().binary;
  assert.equal(Array.from(new noDomBinary.FormData()).length, 0);
  assert.equal(Array.from(new noDomBinary.FormData(undefined)).length, 0);
  assert.throws(() => new noDomBinary.FormData(form, submitter), /DOM form runtime/i);
  let callbackForm, callbackSubmitter, callbackData;
  const { binary } = createBinaryRuntime({
    entriesForForm(actualForm, actualSubmitter) {
      callbackForm = actualForm;
      callbackSubmitter = actualSubmitter;
      return [['label', 'first'], ['label', 'second']];
    },
    formDataCreated(actualForm, result) {
      callbackData = result;
      assert.equal(actualForm, form);
      result.append('event-field', 'from event');
    }
  });
  const fromForm = new binary.FormData(form, submitter);
  assert.equal(callbackForm, form);
  assert.equal(callbackSubmitter, submitter);
  assert.equal(callbackData, fromForm);
  assert.deepEqual(entries(fromForm), [
    ['label', 'first'], ['label', 'second'], ['event-field', 'from event']
  ]);
  assert.equal(new binary.FormData(undefined).has('label'), false);

  const data = new binary.FormData();
  const fileBytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const upload = new binary.Blob([fileBytes], { type: 'application/x-binary' });
  fileBytes.fill(18);
  const originalFile = new binary.File(['identity'], 'original.txt');
  data.append('same-file', originalFile);
  assert.equal(data.get('same-file'), originalFile);
  data.append('null-filename', originalFile, null);
  assert.equal(data.get('null-filename').name, 'null');
  data.append('blob-null-filename', upload, null);
  assert.equal(data.get('blob-null-filename').name, 'null');
  data.append('duplicate', 'line 1\nline 2');
  data.append('upload', upload, 'mémo-猫.bin');
  data.append('duplicate', 'tail');
  assert.throws(() => data.append('missing-value'), /requires a name and value/i);
  assert.throws(() => data.set('missing-value'), /requires a name and value/i);
  data.append('explicit-undefined', undefined);
  assert.equal(data.get('explicit-undefined'), 'undefined');
  data.set('explicit-undefined', undefined);
  assert.equal(data.get('explicit-undefined'), 'undefined');
  data.delete('same-file');
  data.delete('null-filename');
  data.delete('blob-null-filename');
  data.delete('explicit-undefined');
  assert.deepEqual(Array.from(data.getAll('duplicate')), ['line 1\nline 2', 'tail']);
  assert.equal(data.get('upload').name, 'mémo-猫.bin');
  data.set('duplicate', 'replacement');
  assert.deepEqual(entries(data), [
    ['duplicate', 'replacement'],
    ['upload', { name: 'mémo-猫.bin', type: 'application/x-binary', size: 6 }]
  ]);
  data.append('duplicate', 'last');
  assert.deepEqual(Array.from(data.keys()), ['duplicate', 'upload', 'duplicate']);
  assert.equal(data.has('upload'), true);

  const encoded = binary.encodeBody(data);
  assert.match(encoded.contentType, /^multipart\/form-data; boundary=.+$/);
  const boundary = encoded.contentType.split('boundary=')[1];
  const text = Buffer.from(encoded.bytes).toString('utf8');
  assert.ok(text.includes('--' + boundary + '\r\n'));
  assert.ok(text.includes('filename="mémo-猫.bin"'));
  assert.ok(text.endsWith('--' + boundary + '--\r\n'));

  const roundTrip = binary.parseFormData(encoded.bytes, encoded.contentType);
  assert.deepEqual(Array.from(roundTrip.keys()), ['duplicate', 'upload', 'duplicate']);
  assert.deepEqual(Array.from(roundTrip.getAll('duplicate')), ['replacement', 'last']);
  const roundTripFile = roundTrip.get('upload');
  assert.equal(roundTripFile.name, 'mémo-猫.bin');
  assert.equal(roundTripFile.type, 'application/x-binary');
  assert.deepEqual(Array.from(await roundTripFile.bytes()), [0, 1, 2, 253, 254, 255]);
});

test('FormData(urlencoded) preserves duplicate order and decodes UTF-8 and plus signs', () => {
  const { binary } = createBinaryRuntime();
  const form = binary.parseFormData(
    new TextEncoder().encode('q=a+b&q=%E7%8C%AB&emoji=%F0%9F%90%88'),
    'application/x-www-form-urlencoded;charset=UTF-8'
  );
  assert.deepEqual(entries(form), [
    ['q', 'a b'], ['q', '猫'], ['emoji', '🐈']
  ]);
  assert.throws(
    () => binary.parseFormData(new Uint8Array([0]), 'text/plain'),
    /not supported form data/i
  );
});

test('in-memory binary multipart bodies use a consistent fetch boundary and preserve clone/bodyUsed rules', async () => {
  const { api, binary, requests } = createFetchRuntime();
  const form = new binary.FormData();
  form.append('q', '猫');
  form.append('file', new binary.File([new Uint8Array([1, 2, 3])], '猫.txt', {
    type: 'text/plain', lastModified: 42
  }));
  const request = new api.Request('/upload', { method: 'POST', body: form });
  const requestType = request.headers.get('content-type');
  const boundary = /boundary=([^;]+)/.exec(requestType)?.[1];
  assert.ok(boundary);
  const explicitTypeRequest = new api.Request('/upload-explicit-type', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: form
  });
  assert.equal(explicitTypeRequest.headers.get('content-type'), 'application/json');
  const explicitRequestBytes = new Uint8Array(await explicitTypeRequest.arrayBuffer());
  assert.match(new TextDecoder().decode(explicitRequestBytes), /^--.+\r\n/);
  const explicitTypeResponse = new api.Response(form, {
    headers: { 'content-type': 'application/json' }
  });
  assert.equal(explicitTypeResponse.headers.get('content-type'), 'application/json');
  const generatedTypeResponse = new api.Response(form);
  const generatedResponseType = generatedTypeResponse.headers.get('content-type');
  const generatedResponseBoundary = /boundary=([^;]+)/.exec(generatedResponseType)?.[1];
  assert.ok(generatedResponseBoundary);
  const generatedResponseBytes = Buffer.from(await generatedTypeResponse.arrayBuffer());
  assert.ok(generatedResponseBytes.includes(Buffer.from('--' + generatedResponseBoundary)));

  const snapshotForm = new binary.FormData();
  snapshotForm.append('value', 'before');
  const snapshotRequest = new api.Request('/snapshot', { method: 'POST', body: snapshotForm });
  snapshotForm.set('value', 'after');
  assert.equal((await snapshotRequest.formData()).get('value'), 'before');

  const responseFile = new binary.File(['reply'], 'reply.txt', { type: 'text/plain' });
  const fileResponse = new api.Response(responseFile);
  assert.equal(fileResponse.headers.get('content-type'), 'text/plain');
  assert.equal(await (await fileResponse.blob()).text(), 'reply');
  const clone = request.clone();
  const parsedRequest = await clone.formData();
  assert.equal(parsedRequest.get('q'), '猫');
  assert.equal(parsedRequest.get('file').name, '猫.txt');
  assert.equal(clone.bodyUsed, true);
  assert.equal(request.bodyUsed, false);

  const pending = api.fetch(request);
  assert.equal(request.bodyUsed, true);
  const outgoing = requests[0];
  const outgoingType = outgoing.headers.find(([name]) => name === 'content-type')[1];
  assert.equal(outgoingType, requestType);
  const outgoingBytes = Buffer.from(outgoing.bodyBase64, 'base64');
  assert.ok(outgoingBytes.includes(Buffer.from('--' + boundary)));
  assert.deepEqual(
    entries(binary.parseFormData(new Uint8Array(outgoingBytes), outgoingType)),
    [
      ['q', '猫'],
      ['file', { name: '猫.txt', type: 'text/plain', size: 3 }]
    ]
  );

  const responseBody = binary.encodeBody(form);
  api.complete({
    id: 'fetch-1', ok: true, status: 200,
    headers: [['content-type', responseBody.contentType]],
    bodyBytes: responseBody.bytes
  });
  const response = await pending;
  const responseClone = response.clone();
  const returned = await responseClone.formData();
  assert.deepEqual(Array.from(returned.keys()), ['q', 'file']);
  assert.equal(returned.get('file').name, '猫.txt');
  assert.equal(responseClone.bodyUsed, true);
  assert.equal(response.bodyUsed, false);
  const responseBlob = await response.blob();
  assert.equal(responseBlob.type, responseBody.contentType.toLowerCase());
  assert.equal(response.bodyUsed, true);
  await assert.rejects(response.text(), /already used/i);

  const blobRequest = new api.Request('/blob', {
    method: 'POST',
    body: new binary.Blob(['payload'], { type: 'text/plain' })
  });
  assert.equal(blobRequest.headers.get('content-type'), 'text/plain');
  assert.equal(await (await blobRequest.blob()).text(), 'payload');
});

test('multipart output and host-file reads fail within the bounded fetch budget', async () => {
  const { api, binary, requests } = createFetchRuntime();
  const huge = new binary.FormData();
  huge.append('x', 'x'.repeat(2 * 1024 * 1024 - 1));
  assert.throws(() => binary.encodeBody(huge), /cannot exceed 2 MiB/i);

  const largeBytes = new Uint8Array(1_100_000);
  for (let index = 0; index < largeBytes.length; index++)
    largeBytes[index] = index & 0xff;
  const largeFile = binary.fileFromHost({
    name: 'large.bin', size: largeBytes.length,
    bytesBase64: Buffer.from(largeBytes).toString('base64')
  });
  const form = new binary.FormData();
  form.append('upload', largeFile);
  const encoded = binary.encodeBody(form);
  assert.ok(encoded.bytes.length > 1024 * 1024);
  const decoded = binary.parseFormData(encoded.bytes, encoded.contentType).get('upload');
  assert.equal(decoded.size, largeBytes.length);
  const decodedBytes = binary.getBytes(decoded);
  assert.deepEqual(Array.from(decodedBytes.slice(0, 8)), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(decodedBytes[decodedBytes.length - 1], largeBytes[largeBytes.length - 1]);

  const pending = api.fetch('/large-file', { method: 'POST', body: form });
  const fetchedBytes = Buffer.from(requests[0].bodyBase64, 'base64');
  const fetchedType = requests[0].headers.find(([name]) => name === 'content-type')[1];
  const fetchedFile = binary.parseFormData(new Uint8Array(fetchedBytes), fetchedType).get('upload');
  assert.deepEqual(Buffer.from(await fetchedFile.bytes()), Buffer.from(largeBytes));
  api.complete({ id: 'fetch-1', ok: true, status: 204, bodyBase64: null });
  await pending;
});
