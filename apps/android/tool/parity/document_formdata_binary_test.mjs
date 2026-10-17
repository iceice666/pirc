import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const binarySource = readFileSync(new URL('./document_binary_source.js', import.meta.url), 'utf8');

function createBinary() {
  const context = vm.createContext({});
  new vm.Script(binarySource + '\nthis.__binaryFactory = createDocumentBinary;', {
    filename: 'document_binary_source.js'
  }).runInContext(context);
  return vm.runInContext('new __binaryFactory({})', context, {
    contextCodeGeneration: { strings: true, wasm: false }
  });
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

test('native-backed FormData files preserve refs and rename metadata while keeping native bytes', async () => {
  const binary = createBinary();
  const bytes = Buffer.from([0, 1, 127, 128, 255]);
  const reference = { controlId: 'upload-control', resetVersion: '4', index: 0 };
  const file = binary.fileFromHost({
    name: '原始.bin', type: 'Application/X-Binary', size: bytes.length,
    lastModified: 1700000000000, bytesBase64: bytes.toString('base64')
  }, reference);
  const form = new binary.FormData();
  form.append('original', file);
  form.append('renamed', file, '資料 "/猫.bin');

  const original = form.get('original');
  const renamed = form.get('renamed');
  assert.notEqual(original, renamed);
  assert.deepEqual(snapshot(binary.submissionFile(original)), {
    file: { controlId: 'upload-control', resetVersion: '4', index: 0 }, byteLength: 0
  });
  assert.deepEqual(snapshot(binary.submissionFile(renamed)), {
    file: {
      controlId: 'upload-control', resetVersion: '4', index: 0,
      name: '資料 "/猫.bin'
    },
    byteLength: 0
  });
  assert.deepEqual(Buffer.from(await original.bytes()), bytes);
  assert.deepEqual(Buffer.from(await renamed.bytes()), bytes);
});

test('large metadata-only host files use native refs without reading unavailable bytes', () => {
  const binary = createBinary();
  const file = binary.fileFromHost({
    name: 'large.bin', type: 'application/octet-stream', size: 9000000
  }, { controlId: 'upload-large', resetVersion: 9, index: 2 });
  assert.deepEqual(snapshot(binary.submissionFile(file)), {
    file: { controlId: 'upload-large', resetVersion: 9, index: 2 }, byteLength: 0
  });
});

test('new File and sliced Blob FormData entries inline their rebuilt bytes without borrowing refs', async () => {
  const binary = createBinary();
  const sourceBytes = Buffer.from([0, 10, 127, 128, 255]);
  const source = binary.fileFromHost({
    name: 'source.bin', type: 'application/x-source', size: sourceBytes.length,
    lastModified: 12, bytesBase64: sourceBytes.toString('base64')
  }, { controlId: 'source-control', resetVersion: '2', index: 0 });
  const copied = new binary.File([source], 'copied.bin', {
    type: 'application/x-copy', lastModified: 34
  });
  const sliced = source.slice(1, 4, 'application/x-slice');
  const form = new binary.FormData();
  form.append('copy', copied);
  form.append('slice', sliced);

  assert.deepEqual(snapshot(binary.submissionFile(form.get('copy'))), {
    inlineFile: {
      name: 'copied.bin', type: 'application/x-copy', lastModified: 34,
      bytesBase64: sourceBytes.toString('base64')
    },
    byteLength: sourceBytes.length
  });
  assert.deepEqual(snapshot(binary.submissionFile(form.get('slice'))), {
    inlineFile: {
      name: 'blob', type: 'application/x-slice', lastModified: form.get('slice').lastModified,
      bytesBase64: sourceBytes.subarray(1, 4).toString('base64')
    },
    byteLength: 3
  });
  assert.deepEqual(Buffer.from(await form.get('copy').bytes()), sourceBytes);
  assert.deepEqual(Buffer.from(await form.get('slice').bytes()), sourceBytes.subarray(1, 4));
});

test('programmatic files preserve exact binary bytes and Unicode or special filenames', () => {
  const binary = createBinary();
  const bytes = Buffer.from([0, 255, 128, 1, 10, 13]);
  const file = new binary.File([bytes], '資料 "猫" \\ upload.bin', {
    type: 'Application/Octet-Stream', lastModified: 1700000000123
  });
  Object.defineProperties(file, {
    name: { value: 'shadowed-name.txt' },
    type: { value: 'text/plain' },
    lastModified: { value: -1 }
  });
  const form = new binary.FormData();
  form.append('upload', file);
  assert.deepEqual(snapshot(binary.submissionFile(form.get('upload'))), {
    inlineFile: {
      name: '資料 "猫" \\ upload.bin', type: 'application/octet-stream',
      lastModified: 1700000000123, bytesBase64: bytes.toString('base64')
    },
    byteLength: bytes.length
  });
});

test('metadata-only files without refs fail clearly when content is unavailable or over budget', () => {
  const binary = createBinary();
  const unavailable = binary.fileFromHost({
    name: 'missing.bin', type: 'application/octet-stream', size: 3
  });
  assert.throws(() => binary.submissionFile(unavailable), /unavailable/i);

  const largeBytes = Buffer.alloc(2 * 1024 * 1024 + 1);
  const oversized = binary.fileFromHost({
    name: 'oversized.bin', type: 'application/octet-stream', size: largeBytes.length,
    bytesBase64: largeBytes.toString('base64')
  });
  assert.throws(() => binary.submissionFile(oversized), /cannot exceed 2 MiB/i);
});

test('native refs are copied, cannot be forged through metadata, and are validated', () => {
  const binary = createBinary();
  const reference = { controlId: 'trusted-control', resetVersion: '3', index: 1 };
  const metadata = {
    name: 'native.bin', type: 'application/octet-stream', size: 1,
    bytesBase64: Buffer.from([42]).toString('base64'), nativeReference: reference
  };
  const file = binary.fileFromHost(metadata, reference);
  reference.controlId = 'mutated-input';
  metadata.nativeReference.index = 99;
  Object.defineProperty(file, 'name', { value: 'shadowed.bin' });
  const first = binary.submissionFile(file);
  assert.deepEqual(snapshot(first), {
    file: { controlId: 'trusted-control', resetVersion: '3', index: 1 }, byteLength: 0
  });
  first.file.controlId = 'mutated-output';
  assert.deepEqual(snapshot(binary.submissionFile(file)), {
    file: { controlId: 'trusted-control', resetVersion: '3', index: 1 }, byteLength: 0
  });

  const forged = binary.fileFromHost(metadata);
  assert.deepEqual(snapshot(binary.submissionFile(forged)), {
    inlineFile: {
      name: 'native.bin', type: 'application/octet-stream', lastModified: forged.lastModified,
      bytesBase64: Buffer.from([42]).toString('base64')
    },
    byteLength: 1
  });
  assert.throws(() => binary.fileFromHost(metadata, {
    controlId: 'bad-control', resetVersion: '3', index: '1'
  }), /native file reference/i);
});

test('the empty form file keeps its null wire shape while other empty files stay inline', () => {
  const binary = createBinary();
  const emptyFormFile = binary.fileFromHost({
    name: '', type: 'application/octet-stream', size: 0
  });
  assert.deepEqual(snapshot(binary.submissionFile(emptyFormFile)), {
    file: null, byteLength: 0
  });

  const emptyTextFile = new binary.File([], 'empty.txt', {
    type: 'text/plain', lastModified: 7
  });
  assert.deepEqual(snapshot(binary.submissionFile(emptyTextFile)), {
    inlineFile: {
      name: 'empty.txt', type: 'text/plain', lastModified: 7, bytesBase64: ''
    },
    byteLength: 0
  });
});
