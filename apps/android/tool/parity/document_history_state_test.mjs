import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
  new URL('./document_history_state_source.js', import.meta.url),
  'utf8'
);
const RUN_TIMEOUT_MS = 3000;

function createCodec(options = {}) {
  const context = vm.createContext({
    DOMException,
    URL,
    ...(typeof Blob === 'function' ? { Blob } : {}),
    ...(typeof File === 'function' ? { File } : {})
  });
  new vm.Script(
    source + '\nthis.__historyStateCodecFactory = createHistoryStateCodec;',
    { filename: 'document_history_state_source.js' }
  ).runInContext(context, { timeout: RUN_TIMEOUT_MS });
  context.__codecOptions = options;
  const codec = vm.runInContext(
    'new __historyStateCodecFactory(__codecOptions)',
    context,
    { timeout: RUN_TIMEOUT_MS }
  );
  return { codec, context };
}

function assertDataCloneError(callback, message = undefined) {
  assert.throws(callback, error => {
    assert.equal(error?.name, 'DataCloneError');
    if (message) assert.match(error.message, message);
    return true;
  });
}

function builtinBrand(getter, value) {
  try {
    return getter.call(value);
  } catch {
    return undefined;
  }
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag
).get;
const dataViewBufferGetter = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  'buffer'
).get;
const dataViewOffsetGetter = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  'byteOffset'
).get;
const dataViewLengthGetter = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  'byteLength'
).get;
const arrayBufferLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength'
).get;

function assertEquivalent(actual, expected, path = '$', pairs = {
  expectedToActual: new WeakMap(),
  actualToExpected: new WeakMap()
}) {
  if (expected === null || (typeof expected !== 'object' && typeof expected !== 'function')) {
    assert.ok(Object.is(actual, expected), `${path}: ${String(actual)} !== ${String(expected)}`);
    return;
  }
  assert.equal(typeof actual, 'object', `${path}: expected an object`);
  assert.notEqual(actual, null, `${path}: expected a non-null object`);
  if (pairs.expectedToActual.has(expected)) {
    assert.equal(actual, pairs.expectedToActual.get(expected), `${path}: alias mismatch`);
    return;
  }
  if (pairs.actualToExpected.has(actual)) {
    assert.equal(expected, pairs.actualToExpected.get(actual), `${path}: unexpected alias`);
    return;
  }
  pairs.expectedToActual.set(expected, actual);
  pairs.actualToExpected.set(actual, expected);

  if (Array.isArray(expected)) {
    assert.equal(Array.isArray(actual), true, `${path}: expected an Array`);
    assert.equal(actual.length, expected.length, `${path}.length`);
    for (let index = 0; index < expected.length; index++) {
      const expectedOwn = Object.hasOwn(expected, index);
      assert.equal(Object.hasOwn(actual, index), expectedOwn, `${path}[${index}] hole`);
      if (expectedOwn) assertEquivalent(actual[index], expected[index], `${path}[${index}]`, pairs);
    }
    return;
  }

  const expectedDate = builtinBrand(Date.prototype.getTime, expected);
  if (expectedDate !== undefined) {
    assert.ok(Number.isNaN(builtinBrand(Date.prototype.getTime, actual))
      ? Number.isNaN(expectedDate)
      : Object.is(builtinBrand(Date.prototype.getTime, actual), expectedDate), `${path}: Date time`);
    return;
  }

  const expectedRegExpSource = builtinBrand(
    Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get,
    expected
  );
  if (expectedRegExpSource !== undefined) {
    const actualSource = builtinBrand(
      Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get,
      actual
    );
    assert.equal(actualSource, expectedRegExpSource, `${path}: RegExp source`);
    assert.equal(actual.flags, expected.flags, `${path}: RegExp flags`);
    assert.equal(actual.lastIndex, expected.lastIndex, `${path}: RegExp lastIndex`);
    return;
  }

  let expectedMapEntries;
  try {
    expectedMapEntries = [];
    Map.prototype.forEach.call(expected, (value, key) => expectedMapEntries.push([key, value]));
  } catch {
    expectedMapEntries = null;
  }
  if (expectedMapEntries !== null) {
    const actualMapEntries = [];
    Map.prototype.forEach.call(actual, (value, key) => actualMapEntries.push([key, value]));
    assert.equal(actualMapEntries.length, expectedMapEntries.length, `${path}: Map size`);
    for (let index = 0; index < expectedMapEntries.length; index++) {
      assertEquivalent(actualMapEntries[index][0], expectedMapEntries[index][0], `${path}.key${index}`, pairs);
      assertEquivalent(actualMapEntries[index][1], expectedMapEntries[index][1], `${path}.value${index}`, pairs);
    }
    return;
  }

  let expectedSetValues;
  try {
    expectedSetValues = [];
    Set.prototype.forEach.call(expected, value => expectedSetValues.push(value));
  } catch {
    expectedSetValues = null;
  }
  if (expectedSetValues !== null) {
    const actualSetValues = [];
    Set.prototype.forEach.call(actual, value => actualSetValues.push(value));
    assert.equal(actualSetValues.length, expectedSetValues.length, `${path}: Set size`);
    for (let index = 0; index < expectedSetValues.length; index++) {
      assertEquivalent(actualSetValues[index], expectedSetValues[index], `${path}.value${index}`, pairs);
    }
    return;
  }

  const expectedArrayBufferLength = builtinBrand(arrayBufferLengthGetter, expected);
  if (expectedArrayBufferLength !== undefined) {
    const actualArrayBufferLength = builtinBrand(arrayBufferLengthGetter, actual);
    assert.equal(actualArrayBufferLength, expectedArrayBufferLength, `${path}: ArrayBuffer length`);
    assert.deepEqual(
      Array.from(new Uint8Array(actual)),
      Array.from(new Uint8Array(expected)),
      `${path}: ArrayBuffer bytes`
    );
    return;
  }

  const expectedDataViewBuffer = builtinBrand(dataViewBufferGetter, expected);
  if (expectedDataViewBuffer !== undefined) {
    assert.equal(builtinBrand(dataViewBufferGetter, actual)?.byteLength, expectedDataViewBuffer.byteLength, `${path}: DataView buffer`);
    assert.equal(builtinBrand(dataViewOffsetGetter, actual), builtinBrand(dataViewOffsetGetter, expected), `${path}: DataView offset`);
    assert.equal(builtinBrand(dataViewLengthGetter, actual), builtinBrand(dataViewLengthGetter, expected), `${path}: DataView byteLength`);
    assertEquivalent(builtinBrand(dataViewBufferGetter, actual), expectedDataViewBuffer, `${path}.buffer`, pairs);
    return;
  }

  const expectedTypedArrayName = builtinBrand(typedArrayTagGetter, expected);
  if (typeof expectedTypedArrayName === 'string') {
    assert.equal(builtinBrand(typedArrayTagGetter, actual), expectedTypedArrayName, `${path}: TypedArray kind`);
    assert.equal(actual.byteOffset, expected.byteOffset, `${path}: TypedArray byteOffset`);
    assert.equal(actual.length, expected.length, `${path}: TypedArray length`);
    assertEquivalent(actual.buffer, expected.buffer, `${path}.buffer`, pairs);
    assert.deepEqual(Array.from(actual), Array.from(expected), `${path}: TypedArray values`);
    return;
  }

  const boxedKinds = [
    ['Number', Number.prototype.valueOf],
    ['String', String.prototype.valueOf],
    ['Boolean', Boolean.prototype.valueOf],
    ...(typeof BigInt === 'function' ? [['BigInt', BigInt.prototype.valueOf]] : [])
  ];
  for (const [kind, valueOf] of boxedKinds) {
    const expectedValue = builtinBrand(valueOf, expected);
    if (expectedValue !== undefined) {
      assert.equal(builtinBrand(valueOf, actual), expectedValue, `${path}: boxed ${kind}`);
      return;
    }
  }

  const expectedTag = Object.prototype.toString.call(expected);
  assert.equal(Object.prototype.toString.call(actual), expectedTag, `${path}: object kind`);
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  assert.deepEqual(actualKeys, expectedKeys, `${path}: enumerable string keys`);
  for (const key of expectedKeys) {
    assertEquivalent(actual[key], expected[key], `${path}.${key}`, pairs);
  }
}

function compareWithStructuredClone(codec, input) {
  const expected = structuredClone(input);
  const actual = codec.clone(input);
  assertEquivalent(actual, expected);
  return { actual, expected };
}

test('special primitives, aliases, cycles, object keys, and sparse array holes match structuredClone', () => {
  const { codec } = createCodec();
  const shared = { value: -0, big: 12345678901234567890n };
  const array = new Array(5);
  array[1] = undefined;
  array[4] = shared;
  const input = {
    shared,
    again: shared,
    array,
    undefinedValue: undefined,
    nan: NaN,
    infinity: Infinity,
    negativeInfinity: -Infinity,
    negativeZero: -0
  };
  input.self = input;
  array[3] = input;

  const { actual } = compareWithStructuredClone(codec, input);
  assert.equal(actual.shared, actual.again);
  assert.equal(actual.self, actual);
  assert.equal(actual.array[3], actual);
  assert.equal(Object.hasOwn(actual.array, 0), false);
  assert.equal(Object.hasOwn(actual.array, 1), true);
  assert.equal(actual.array[1], undefined);
  assert.equal(Object.hasOwn(actual.array, 2), false);
  assert.ok(Object.is(actual.negativeZero, -0));

  const graph = codec.serialize(input);
  assert.doesNotThrow(() => JSON.stringify(graph));
  assert.deepEqual(JSON.parse(JSON.stringify(codec.serialize(undefined))), {
    version: 1,
    root: ['u'],
    nodes: []
  });
});

test('enumerable getters run once; exceptions escape; symbols and prototypes are not cloned', () => {
  const { codec } = createCodec();
  const nativeCounter = { reads: 0 };
  const codecCounter = { reads: 0 };
  function getterObject(counter) {
    const value = {};
    Object.defineProperty(value, 'answer', {
      enumerable: true,
      get() {
        counter.reads++;
        return { number: counter.reads };
      }
    });
    Object.defineProperty(value, 'ignored', {
      enumerable: false,
      get() {
        throw new Error('non-enumerable getter must not run');
      }
    });
    value[Symbol('ignored')] = () => {};
    return value;
  }
  const expected = structuredClone(getterObject(nativeCounter));
  const actual = codec.clone(getterObject(codecCounter));
  assert.equal(nativeCounter.reads, 1);
  assert.equal(codecCounter.reads, 1);
  assertEquivalent(actual, expected);

  const marker = new Error('getter marker');
  const throwing = {};
  Object.defineProperty(throwing, 'value', {
    enumerable: true,
    get() { throw marker; }
  });
  assert.throws(() => codec.clone(throwing), error => error === marker);

  let toJSONCalls = 0;
  const withToJSON = {
    toJSON() {
      toJSONCalls++;
      return { changed: true };
    }
  };
  assertDataCloneError(() => codec.clone(withToJSON));
  assert.equal(toJSONCalls, 0, 'serialization never invokes input toJSON');

  class CustomRecord {
    constructor() { this.value = 'own enumerable data'; }
    method() { return 'not copied'; }
  }
  const customClone = codec.clone(new CustomRecord());
  assert.equal(customClone.value, 'own enumerable data');
  assert.equal(Object.getPrototypeOf(customClone).constructor.name, 'Object');
  assert.equal(customClone instanceof CustomRecord, false);
});

test('Date, RegExp, Map, Set, and boxed primitives preserve their cloneable state', () => {
  const { codec } = createCodec();
  const date = new Date('2024-02-29T12:34:56.789Z');
  const invalidDate = new Date(NaN);
  const regexp = /ab+c/giu;
  regexp.lastIndex = 7;
  const key = { id: 1 };
  const map = new Map();
  const set = new Set();
  const input = {
    date,
    invalidDate,
    regexp,
    map,
    set,
    numberBox: new Number(-0),
    stringBox: new String('boxed'),
    booleanBox: new Boolean(false),
    bigintBox: Object(987654321n)
  };
  map.set(key, input);
  map.set(map, key);
  set.add(key);
  set.add(set);

  const { actual, expected } = compareWithStructuredClone(codec, input);
  assert.equal(actual.map.get(actual.map.keys().next().value), actual);
  assert.equal(actual.set.has(actual.set), true);
  assert.equal(actual.regexp.lastIndex, 0);
  assert.equal(actual.invalidDate.getTime(), expected.invalidDate.getTime());
  assert.ok(Object.is(Number.prototype.valueOf.call(actual.numberBox), -0));
});

test('ArrayBuffer, DataView, and typed arrays keep shared backing-buffer identity', () => {
  const { codec } = createCodec();
  const buffer = new ArrayBuffer(24);
  new Uint8Array(buffer).set(Array.from({ length: 24 }, (_, index) => index * 7));
  const input = {
    buffer,
    bytes: new Uint8Array(buffer, 2, 12),
    words: new Uint16Array(buffer, 4, 6),
    floats: new Float32Array(buffer, 8, 3),
    view: new DataView(buffer, 1, 20)
  };
  const { actual } = compareWithStructuredClone(codec, input);
  assert.equal(actual.bytes.buffer, actual.buffer);
  assert.equal(actual.words.buffer, actual.buffer);
  assert.equal(actual.floats.buffer, actual.buffer);
  assert.equal(actual.view.buffer, actual.buffer);
  assert.notEqual(actual.buffer, buffer);
});

test('unsupported values raise DataCloneError without confusing cross-realm plain objects', () => {
  const { codec, context } = createCodec();
  const otherRealm = vm.runInNewContext('({ nested: { value: 3 } })');
  const { actual } = compareWithStructuredClone(codec, otherRealm);
  assert.equal(actual.nested.value, 3);

  const unsupportedValues = [
    () => {},
    Symbol('value'),
    new WeakMap(),
    new WeakSet(),
    Promise.resolve(1),
    new URL('https://example.test/path')
  ];
  if (typeof Blob === 'function') unsupportedValues.push(new Blob(['x']));
  if (typeof File === 'function') unsupportedValues.push(new File(['x'], 'x.txt'));
  for (const [index, value] of unsupportedValues.entries()) {
    let error;
    try { codec.clone(value); } catch (caught) { error = caught; }
    assert.equal(error?.name, 'DataCloneError', `unsupported value ${index}`);
  }

  const domObjects = new WeakSet();
  const domLike = { nodeType: 1, nodeName: 'DIV' };
  domObjects.add(domLike);
  const domCodec = createCodec({ isUnsupportedHostObject: value => domObjects.has(value) }).codec;
  assertDataCloneError(() => domCodec.clone(domLike), /DOM/);
  assert.equal(domCodec.clone({ nodeType: 1, value: 'ordinary data' }).value, 'ordinary data');
});

test('dangerous keys, invalid references, and native limits are handled safely', () => {
  const { codec } = createCodec();
  const source = Object.create(null);
  Object.defineProperty(source, '__proto__', {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true
  });
  const clone = codec.clone(source);
  assert.equal(Object.getPrototypeOf(clone).constructor.name, 'Object');
  assert.equal(Object.hasOwn(clone, '__proto__'), true);
  assert.equal(clone.__proto__.polluted, true);
  assert.equal(Object.prototype.polluted, undefined);

  const malformed = JSON.parse(JSON.stringify(codec.serialize({ value: 1 })));
  malformed.nodes[0].props[0][1] = ['r', 99];
  assertDataCloneError(() => codec.deserialize(malformed), /reference/i);

  const wrongViewBuffer = JSON.parse(JSON.stringify(codec.serialize({
    object: {},
    view: new Uint8Array(new ArrayBuffer(4))
  })));
  const viewNodeIndex = wrongViewBuffer.root[1];
  const viewRef = wrongViewBuffer.nodes[viewNodeIndex].props.find(([key]) => key === 'view')[1];
  wrongViewBuffer.nodes[viewRef[1]].buffer = ['r', wrongViewBuffer.root[1]];
  assertDataCloneError(() => codec.deserialize(wrongViewBuffer), /ArrayBuffer/i);

  const byteLimited = createCodec({ maxBytes: 128 }).codec;
  assertDataCloneError(() => byteLimited.serialize({ value: 'x'.repeat(256) }), /limit/i);
  const nodeLimited = createCodec({ maxNodes: 2 }).codec;
  assertDataCloneError(() => nodeLimited.serialize({ a: { b: {} } }), /node limit/i);
  assertDataCloneError(() => nodeLimited.deserialize({
    version: 1,
    root: ['r', 0],
    nodes: [{ type: 'Array', length: 3, items: [] }]
  }), /node\/slot limit/i);

  // A failed operation leaves the codec usable; it retains no partial graph state.
  assert.equal(codec.clone({ ok: true }).ok, true);
});
