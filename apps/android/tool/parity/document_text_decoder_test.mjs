import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./document_text_decoder_source.js', import.meta.url), 'utf8');
const encodingDataSource = readFileSync(
  new URL('./document_encoding_data.js', import.meta.url), 'utf8');

function loadDecoder() {
  const context = vm.createContext({});
  new vm.Script(encodingDataSource +
    '\nthis.__encodingDataFactory = createDocumentEncodingData;', {
      filename: 'document_encoding_data.js'
    }).runInContext(context);
  new vm.Script(source + '\nthis.__textDecoderFactory = createDocumentTextDecoder;', {
    filename: 'document_text_decoder_source.js'
  }).runInContext(context);
  const bundle = vm.runInContext(
    '(() => { const deps = __encodingDataFactory(); this.__decoderDeps = deps; ' +
      'return __textDecoderFactory(deps); })()',
    context,
    {contextCodeGeneration: {strings: true, wasm: false}}
  );
  return {TextDecoder: bundle.TextDecoder, deps: context.__decoderDeps};
}

function errorName(callback) {
  try {
    callback();
    return null;
  } catch (error) {
    return error && error.name;
  }
}

function compareSequence(CustomTextDecoder, label, constructorOptions, calls) {
  const custom = new CustomTextDecoder(label, constructorOptions);
  const native = new globalThis.TextDecoder(label, constructorOptions);
  const results = [];
  for (const [input, options] of calls) {
    const customError = errorName(() => results.push(custom.decode(input, options)));
    const nativeResult = [];
    const nativeError = errorName(() => nativeResult.push(native.decode(input, options)));
    assert.equal(customError, nativeError, `${label}: decoder error differs`);
    if (customError === null) assert.equal(results.at(-1), nativeResult[0], `${label}: output differs`);
  }
  return results;
}

function big5Pair(pointer) {
  const lead = Math.floor(pointer / 157) + 0x81;
  const trailPointer = pointer % 157;
  const trail = trailPointer + (trailPointer < 0x3f ? 0x40 : 0x62);
  return Uint8Array.of(lead, trail);
}

function officialBig5Output(deps, pointer) {
  const codePoints = BIG5_SPECIAL.get(pointer) || [deps.big5CodePoint(pointer)];
  if (codePoints[0] === null) {
    const trailPointer = pointer % 157;
    const trail = trailPointer + (trailPointer < 0x3f ? 0x40 : 0x62);
    return '\ufffd' + (trail <= 0x7f ? String.fromCharCode(trail) : '');
  }
  return String.fromCodePoint(...codePoints);
}

const BIG5_SPECIAL = new Map([
  [1133, [0x00ca, 0x0304]],
  [1135, [0x00ca, 0x030c]],
  [1164, [0x00ea, 0x0304]],
  [1166, [0x00ea, 0x030c]],
]);

test('uses the official label map and exposes readonly encoding options', () => {
  const {TextDecoder, deps} = loadDecoder();
  const supported = new Set(['utf-8', 'utf-16le', 'utf-16be', 'windows-1252', 'big5']);
  for (const [label, canonical] of Object.entries(deps.encodingLabels)) {
    if (supported.has(canonical)) {
      assert.equal(new TextDecoder(label).encoding, canonical, `label: ${label}`);
    } else {
      assert.equal(errorName(() => new TextDecoder(label)), 'RangeError', `label: ${label}`);
    }
  }

  assert.equal(new TextDecoder().encoding, 'utf-8');
  assert.equal(new TextDecoder(undefined).encoding, 'utf-8');
  assert.equal(new TextDecoder(' \tUTF8\r ').encoding, 'utf-8');
  assert.equal(new TextDecoder('unicode').encoding, 'utf-16le');
  assert.equal(new TextDecoder('ascii').encoding, 'windows-1252');
  assert.equal(new TextDecoder('big5-hkscs').encoding, 'big5');
  assert.equal(errorName(() => new TextDecoder('unknown-label')), 'RangeError');
  assert.equal(errorName(() => new TextDecoder('replacement')), 'RangeError');
  assert.equal(errorName(() => new TextDecoder('shift-jis')), 'RangeError');
  assert.equal(errorName(() => new TextDecoder(Symbol('utf-8'))), 'TypeError');
  const conversionHints = [];
  const labelObject = {
    [Symbol.toPrimitive](hint) {
      conversionHints.push(hint);
      return 'utf8';
    },
  };
  assert.equal(new TextDecoder(labelObject).encoding, 'utf-8');
  assert.deepEqual(conversionHints, ['string']);

  const decoder = new TextDecoder('utf-8', {fatal: 1, ignoreBOM: 'set'});
  assert.equal(decoder.fatal, true);
  assert.equal(decoder.ignoreBOM, true);
  assert.equal(Reflect.set(decoder, 'encoding', 'windows-1252'), false);
  assert.equal(Reflect.set(decoder, 'fatal', false), false);
  assert.equal(Reflect.set(decoder, 'ignoreBOM', false), false);
  assert.equal(Object.prototype.toString.call(decoder), '[object TextDecoder]');
  assert.equal(Object.getOwnPropertyDescriptor(TextDecoder.prototype, 'encoding').enumerable, true);
});

test('enforces TextDecoder brand checks and BufferSource input conversion', () => {
  const {TextDecoder} = loadDecoder();
  const decoder = new TextDecoder('windows-1252');
  assert.equal(decoder.decode(), '');
  assert.equal(decoder.decode(undefined), '');
  assert.equal(decoder.decode(new DataView(Uint8Array.of(0x78, 0x80, 0x79).buffer, 1, 1)), '€');
  assert.equal(decoder.decode(Uint8Array.of(0x78, 0x41, 0x79).subarray(1, 2)), 'A');
  assert.equal(decoder.decode(Uint8Array.of(0x41, 0x42).buffer), 'AB');
  const shadowedView = Uint8Array.of(0x45);
  Object.defineProperties(shadowedView, {
    buffer: {value: new ArrayBuffer(0)},
    byteLength: {value: 2 * 1024 * 1024 + 1},
    byteOffset: {value: 0},
  });
  assert.equal(decoder.decode(shadowedView), 'E');
  if (typeof SharedArrayBuffer !== 'undefined') {
    const shared = new SharedArrayBuffer(2);
    new Uint8Array(shared).set([0x43, 0x44]);
    assert.equal(decoder.decode(shared), 'CD');
  }

  assert.equal(errorName(() => decoder.decode(null)), 'TypeError');
  assert.equal(errorName(() => decoder.decode([])), 'TypeError');
  assert.equal(errorName(() => decoder.decode('bytes')), 'TypeError');
  assert.equal(errorName(() => decoder.decode({buffer: new ArrayBuffer(1)})), 'TypeError');
  assert.equal(errorName(() => new TextDecoder('utf-8', false)), 'TypeError');
  assert.equal(errorName(() => decoder.decode(Uint8Array.of(0x41), false)), 'TypeError');
  assert.equal(new TextDecoder('utf-8', null).encoding, 'utf-8');
  assert.equal(decoder.decode(Uint8Array.of(0x41), null), 'A');
  assert.equal(errorName(() => TextDecoder.prototype.decode.call({}, Uint8Array.of(0))), 'TypeError');
  const encodingGetter = Object.getOwnPropertyDescriptor(TextDecoder.prototype, 'encoding').get;
  assert.equal(errorName(() => encodingGetter.call({})), 'TypeError');
});

test('matches Node for UTF-8 replacement, stream boundaries, and BOM handling', () => {
  const {TextDecoder} = loadDecoder();
  const cases = [
    [0x41, 0xe5, 0xb0, 0xbe],
    [0xf0, 0x9f, 0x90, 0xbe],
    [0xe2, 0x41, 0x42],
    [0xe0, 0x80, 0x41],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xc0, 0xaf, 0x80],
    [0xef, 0xbb, 0xbf, 0x41],
    [0xff, 0xef, 0xbb, 0xbf, 0x41],
  ];
  for (const values of cases) {
    for (let split = 0; split <= values.length; split += 1) {
      compareSequence(TextDecoder, 'utf-8', {}, [
        [Uint8Array.from(values.slice(0, split)), {stream: true}],
        [Uint8Array.from(values.slice(split)), {}],
      ]);
    }
  }

  const bom = Uint8Array.of(0xef, 0xbb, 0xbf, 0x41, 0xef, 0xbb, 0xbf);
  assert.equal(new TextDecoder('utf-8').decode(bom), 'A\ufeff');
  assert.equal(new TextDecoder('utf-8', {ignoreBOM: true}).decode(bom), '\ufeffA\ufeff');
  assert.equal(new TextDecoder('utf-8').decode(Uint8Array.of(0xff, 0xef, 0xbb, 0xbf, 0x41)), '\ufffd\ufeffA');
  assert.equal(new TextDecoder('utf-8').decode(Uint8Array.of(0xe2, 0x82, 0x41)), '\ufffdA');
  assert.equal(new TextDecoder('utf-8').decode(Uint8Array.of(0xc0, 0xaf)), '\ufffd\ufffd');
});

test('matches Node for UTF-16 code units, split surrogates, and fixed byte order', () => {
  const {TextDecoder} = loadDecoder();
  const cases = [
    ['utf-16le', [0x41, 0x00, 0x3d, 0xd8, 0x3e, 0xdc]],
    ['utf-16be', [0x00, 0x41, 0xd8, 0x3d, 0xdc, 0x3e]],
    ['utf-16le', [0x00, 0xd8, 0x41, 0x00, 0x00]],
    ['utf-16be', [0xd8, 0x00, 0x00, 0x41, 0x00]],
    ['utf-16le', [0x00, 0xdc, 0xff, 0xfe, 0x41, 0x00]],
    ['utf-16le', [0xff, 0xfe, 0x41, 0x00]],
    ['utf-16le', [0xfe, 0xff, 0x00, 0x41]],
    ['utf-16be', [0xfe, 0xff, 0x00, 0x41]],
    ['utf-16be', [0xff, 0xfe, 0x41, 0x00]],
    ['utf-16le', [0x00, 0xdc]],
  ];
  for (const [label, values] of cases) {
    for (let split = 0; split <= values.length; split += 1) {
      compareSequence(TextDecoder, label, {}, [
        [Uint8Array.from(values.slice(0, split)), {stream: true}],
        [Uint8Array.from(values.slice(split)), {}],
      ]);
    }
  }

  assert.equal(new TextDecoder('utf-16le').decode(Uint8Array.of(0xff, 0xfe, 0x41, 0x00)), 'A');
  assert.equal(new TextDecoder('utf-16be').decode(Uint8Array.of(0xff, 0xfe, 0x41, 0x00)), '\ufffe\u4100');
  assert.equal(new TextDecoder('utf-16le').decode(Uint8Array.of(0xfe, 0xff, 0x00, 0x41)), '\ufffe\u4100');
});

test('all Windows-1252 bytes match Node', () => {
  const {TextDecoder} = loadDecoder();
  const allBytes = Uint8Array.from({length: 256}, (_, index) => index);
  assert.equal(new TextDecoder('windows-1252').decode(allBytes),
    new globalThis.TextDecoder('windows-1252').decode(allBytes));
});

test('all valid Big5 pointers follow the official index and special mappings', () => {
  const {TextDecoder, deps} = loadDecoder();
  const decoder = new TextDecoder('big5');
  let astralPointerCount = 0;
  for (let pointer = 0; pointer < 126 * 157; pointer += 1) {
    const actual = decoder.decode(big5Pair(pointer));
    const expected = officialBig5Output(deps, pointer);
    assert.equal(actual, expected, `Big5 pointer ${pointer}`);
    const codePoint = deps.big5CodePoint(pointer);
    if (codePoint !== null && codePoint > 0xffff) astralPointerCount += 1;
  }
  assert.ok(astralPointerCount > 0, 'the official Big5 table includes astral mappings');
  assert.equal(decoder.decode(Uint8Array.of(0x81, 0x7f)), '\ufffd\u007f');
  assert.equal(decoder.decode(Uint8Array.of(0x81)), '\ufffd');
});

test('fatal errors throw TypeError and clear the failed stream like Node', () => {
  const {TextDecoder} = loadDecoder();
  const sequences = [
    ['utf-8', [0xff, 0x41, 0x42]],
    ['utf-8', [0xe2, 0x41, 0x42]],
    ['utf-16le', [0x00, 0xd8, 0x41, 0x00]],
    ['big5', [0x81, 0x7f, 0x42]],
  ];
  for (const [label, values] of sequences) {
    compareSequence(TextDecoder, label, {fatal: true}, [
      [Uint8Array.from(values), {stream: true}],
      [Uint8Array.of(0x43), {stream: true}],
      [undefined, {}],
    ]);
  }

  const decoder = new TextDecoder('utf-8', {fatal: true});
  assert.equal(errorName(() => decoder.decode(Uint8Array.of(0xff, 0x41), {stream: true})), 'TypeError');
  assert.equal(decoder.decode(Uint8Array.of(0x42), {stream: true}), 'B');

  const bomDecoder = new TextDecoder('utf-8', {fatal: true});
  assert.equal(errorName(() => bomDecoder.decode(
    Uint8Array.of(0xef, 0xbb, 0xbf, 0xff), {stream: true})), 'TypeError');
  assert.equal(bomDecoder.decode(
    Uint8Array.of(0xef, 0xbb, 0xbf, 0x41), {stream: true}), 'A');
});

test('fixed-seed UTF streaming vectors match Node replacement and UTF-8 fatal behavior', () => {
  const {TextDecoder} = loadDecoder();
  let state = 0x4917b;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };

  for (const encoding of ['utf-8', 'utf-16le', 'utf-16be']) {
    for (let vector = 0; vector < 1200; vector += 1) {
      const bytes = Uint8Array.from({length: random() % 19}, () => random() & 0xff);
      const split = random() % (bytes.length + 1);
      const calls = [
        [bytes.subarray(0, split), {stream: true}],
        [bytes.subarray(split), {stream: true}],
        [Uint8Array.of(0x41, 0x42), {}],
      ];

      for (const ignoreBOM of [false, true]) {
        compareSequence(TextDecoder, encoding, {fatal: false, ignoreBOM}, calls);
        if (encoding === 'utf-8') {
          compareSequence(TextDecoder, encoding, {fatal: true, ignoreBOM}, calls);
        }
      }
    }
  }
});

test('documents the UTF-16 fatal recovery reset difference from native TextDecoder', () => {
  const {TextDecoder} = loadDecoder();
  const chunks = [
    [Uint8Array.of(0x00, 0xd8), {stream: true}],
    [Uint8Array.of(0x41, 0x00, 0x01), {stream: true}],
    [Uint8Array.of(0x41, 0x42), {}],
  ];
  const custom = new TextDecoder('utf-16le', {fatal: true});
  const native = new globalThis.TextDecoder('utf-16le', {fatal: true});

  assert.equal(custom.decode(...chunks[0]), '');
  assert.equal(native.decode(...chunks[0]), '');
  assert.equal(errorName(() => custom.decode(...chunks[1])), 'TypeError');
  assert.equal(errorName(() => native.decode(...chunks[1])), 'TypeError');
  assert.equal(custom.decode(...chunks[2]), '\u4241');
  assert.equal(errorName(() => native.decode(...chunks[2])), 'TypeError');
});

test('enforces per-call input limits and resets the active stream after overflow', () => {
  const {TextDecoder} = loadDecoder();
  const decoder = new TextDecoder('utf-8');
  assert.equal(decoder.decode(new Uint8Array(2 * 1024 * 1024)).length, 2 * 1024 * 1024);
  decoder.decode(Uint8Array.of(0xe2), {stream: true});
  assert.equal(errorName(() => decoder.decode(new Uint8Array(2 * 1024 * 1024 + 1), {stream: true})), 'RangeError');
  assert.equal(decoder.decode(Uint8Array.of(0x82, 0xac)), '\ufffd\ufffd');

  const spoofedOversize = new Uint8Array(2 * 1024 * 1024 + 1);
  Object.defineProperty(spoofedOversize, 'byteLength', {value: 0});
  assert.equal(errorName(() => decoder.decode(spoofedOversize)), 'RangeError');
});
