import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  path.join(scriptDirectory, 'document_text_encoder_source.js'),
  'utf8',
);
const createDocumentTextEncoder = vm.runInNewContext(
  `${source}\n;createDocumentTextEncoder`,
);
const { TextEncoder: DocumentTextEncoder } = createDocumentTextEncoder();
const oracle = new globalThis.TextEncoder();
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function bytes(value) {
  return Array.from(value);
}

function resultPair(value) {
  return { read: value.read, written: value.written };
}

function assertTypeError(callback) {
  assert.throws(callback, { name: 'TypeError' });
}

const unicodeInputs = [
  '',
  'ASCII with NUL\u0000 and newline\n',
  'café – Καλημέρα – 你好 – مرحبا',
  'e\u0301 and Å',
  'A\u{1f642}B',
  '\u{1f469}\u{1f3fd}\u200d\u{1f4bb}',
  '\u{10ffff}',
  '\ud800 alone',
  'before\udc00after',
  '\ud800\udc00 plus \ud83d\ude42',
];

test('encode returns fresh UTF-8 bytes matching Node for Unicode and scalar repair', () => {
  const encoder = new DocumentTextEncoder();
  for (const input of unicodeInputs) {
    assert.deepEqual(bytes(encoder.encode(input)), bytes(oracle.encode(input)), input);
  }
  assert.deepEqual(bytes(encoder.encode()), []);
  assert.deepEqual(bytes(encoder.encode(undefined)), []);
  assert.deepEqual(bytes(encoder.encode(null)), bytes(oracle.encode(null)));
  assert.deepEqual(bytes(encoder.encode(42)), bytes(oracle.encode(42)));
  assert.deepEqual(bytes(encoder.encode(true)), bytes(oracle.encode(true)));
  assert.deepEqual(bytes(encoder.encode(42n)), bytes(oracle.encode(42n)));
  assert.deepEqual(
    bytes(encoder.encode({ toString: () => 'object → string' })),
    bytes(oracle.encode({ toString: () => 'object → string' })),
  );
  assert.notEqual(encoder.encode('same'), encoder.encode('same'));
});

test('encodeInto matches Node at every small capacity and preserves view boundaries', () => {
  const encoder = new DocumentTextEncoder();
  for (const input of unicodeInputs) {
    const expectedSize = oracle.encode(input).length;
    for (let capacity = 0; capacity <= expectedSize + 1; capacity++) {
      const expectedBacking = new Uint8Array(capacity + 5).fill(0xa7);
      const actualBacking = new Uint8Array(capacity + 5).fill(0xa7);
      const expectedView = expectedBacking.subarray(2, 2 + capacity);
      const actualView = actualBacking.subarray(2, 2 + capacity);
      const expected = oracle.encodeInto(input, expectedView);
      const actual = encoder.encodeInto(input, actualView);
      assert.deepEqual(resultPair(actual), resultPair(expected),
        `${JSON.stringify(input)} at ${capacity} bytes`);
      assert.deepEqual(bytes(actualBacking), bytes(expectedBacking),
        `${JSON.stringify(input)} must preserve prefix and suffix guards`);
    }
  }
});

test('encodeInto accepts SharedArrayBuffer-backed Uint8Array views', (t) => {
  if (typeof SharedArrayBuffer !== 'function') {
    t.skip('SharedArrayBuffer is unavailable in this Node runtime');
    return;
  }
  const encoder = new DocumentTextEncoder();
  const expectedBacking = new SharedArrayBuffer(24);
  const actualBacking = new SharedArrayBuffer(24);
  const expectedView = new Uint8Array(expectedBacking, 4, 16);
  const actualView = new Uint8Array(actualBacking, 4, 16);
  expectedView.fill(0xcc);
  actualView.fill(0xcc);
  const expected = oracle.encodeInto('中🙂z', expectedView);
  const actual = encoder.encodeInto('中🙂z', actualView);
  assert.deepEqual(resultPair(actual), resultPair(expected));
  assert.deepEqual(bytes(new Uint8Array(actualBacking)), bytes(new Uint8Array(expectedBacking)));
});

test('constructor, encoding, methods, and DOM-like prototype descriptors match the interface', () => {
  assertTypeError(() => DocumentTextEncoder());
  const encoder = new DocumentTextEncoder('utf-16le', { ignored: true });
  const prototype = DocumentTextEncoder.prototype;
  assert.equal(encoder.encoding, 'utf-8');
  assert.equal(Object.prototype.toString.call(encoder), '[object TextEncoder]');
  assert.equal(Object.hasOwn(encoder, 'encoding'), false);
  assert.deepEqual(Object.keys(prototype), ['encoding', 'encode', 'encodeInto']);

  const encoding = Object.getOwnPropertyDescriptor(prototype, 'encoding');
  assert.equal(typeof encoding.get, 'function');
  assert.equal(encoding.set, undefined);
  assert.equal(encoding.enumerable, true);
  assert.equal(encoding.configurable, true);
  assert.equal(Reflect.set(encoder, 'encoding', 'windows-1252'), false);
  assert.equal(encoder.encoding, 'utf-8');

  for (const name of ['encode', 'encodeInto']) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    assert.equal(typeof descriptor.value, 'function');
    assert.equal(descriptor.writable, true);
    assert.equal(descriptor.enumerable, true);
    assert.equal(descriptor.configurable, true);
  }
  assert.equal(prototype.encode.length, 0);
  assert.equal(prototype.encodeInto.length, 2);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag),
    {
      value: 'TextEncoder', writable: false, enumerable: false, configurable: true,
    },
  );
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(DocumentTextEncoder, 'prototype'),
    { value: prototype, writable: false, enumerable: false, configurable: false },
  );
});

test('USVString conversion repairs surrogates and rejects Symbols', () => {
  const encoder = new DocumentTextEncoder();
  assertTypeError(() => encoder.encode(Symbol('text')));
  assertTypeError(() => encoder.encode(Object(Symbol('wrapped'))));
  assertTypeError(() => encoder.encode({ [Symbol.toPrimitive]: () => Symbol('text') }));
  assert.deepEqual(bytes(encoder.encode('\ud800\udc00\ud800\udfff\ud800')),
    bytes(oracle.encode('\ud800\udc00\ud800\udfff\ud800')));

  const destination = new Uint8Array(16);
  const undefinedSource = encoder.encodeInto(undefined, destination);
  assert.deepEqual(resultPair(undefinedSource), { read: 9, written: 9 });
  assert.deepEqual(bytes(destination.subarray(0, 9)), bytes(oracle.encode('undefined')));
  const nullDestination = new Uint8Array(4);
  assert.deepEqual(resultPair(encoder.encodeInto(null, nullDestination)), { read: 4, written: 4 });
  assert.deepEqual(bytes(nullDestination), bytes(oracle.encode('null')));
});

test('encodeInto requires a Uint8Array and both required arguments', () => {
  const encoder = new DocumentTextEncoder();
  for (const invalid of [
    undefined,
    null,
    {},
    new DataView(new ArrayBuffer(4)),
    new Uint8ClampedArray(4),
    new Int8Array(4),
    new Uint16Array(4),
    new Proxy(new Uint8Array(4), {}),
  ]) {
    assertTypeError(() => encoder.encodeInto('x', invalid));
  }
  assertTypeError(() => encoder.encodeInto());
  assertTypeError(() => encoder.encodeInto('x'));
  assertTypeError(() => encoder.encodeInto.call({}, 'x', new Uint8Array(4)));
  assertTypeError(() => encoder.encode.call({}, 'x'));
  assertTypeError(() => Object.getOwnPropertyDescriptor(
    DocumentTextEncoder.prototype, 'encoding'
  ).get.call({}));

  const destination = new Uint8Array(4);
  assert.deepEqual(resultPair(encoder.encodeInto('é', destination, 'ignored extra argument')), {
    read: 1, written: 2,
  });
});

test('detached destination views agree with Node when transfer is available', (t) => {
  if (typeof structuredClone !== 'function') {
    t.skip('structuredClone transfer is unavailable in this Node runtime');
    return;
  }
  const encoder = new DocumentTextEncoder();
  const expectedBuffer = new ArrayBuffer(4);
  const actualBuffer = new ArrayBuffer(4);
  const expectedView = new Uint8Array(expectedBuffer);
  const actualView = new Uint8Array(actualBuffer);
  structuredClone(expectedBuffer, { transfer: [expectedBuffer] });
  structuredClone(actualBuffer, { transfer: [actualBuffer] });
  assert.deepEqual(resultPair(encoder.encodeInto('x', actualView)),
    resultPair(oracle.encodeInto('x', expectedView)));
});

test('2 MiB output cap avoids large encode allocations and permits small prefixes', () => {
  const encoder = new DocumentTextEncoder();
  const oversized = 'a'.repeat(MAX_OUTPUT_BYTES + 1);
  assert.throws(() => encoder.encode(oversized), { name: 'RangeError' });

  const smallDestination = new Uint8Array(3).fill(0x55);
  assert.deepEqual(resultPair(encoder.encodeInto(oversized, smallDestination)), {
    read: 3, written: 3,
  });
  assert.deepEqual(bytes(smallDestination), [0x61, 0x61, 0x61]);

  const largeDestination = new Uint8Array(MAX_OUTPUT_BYTES + 1).fill(0x5a);
  assert.throws(() => encoder.encodeInto(oversized, largeDestination), {
    name: 'RangeError',
  });
  assert.equal(largeDestination.every((value) => value === 0x5a), true,
    'a cap error must happen before the destination is modified');
});
