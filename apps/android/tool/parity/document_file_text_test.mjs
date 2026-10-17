import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./document_file_text_source.js', import.meta.url), 'utf8');

function createFileText(deps = {}) {
  const context = vm.createContext({ __deps: deps });
  new vm.Script(source + '\nthis.__fileTextFactory = createDocumentFileText;', {
    filename: 'document_file_text_source.js'
  }).runInContext(context);
  return vm.runInContext('new __fileTextFactory(__deps)', context, {
    contextCodeGeneration: { strings: true, wasm: false }
  });
}

function bytes(...values) {
  return Uint8Array.from(values);
}

test('decodes UTF-8, UTF-16LE and UTF-16BE labels', () => {
  const text = createFileText();
  assert.equal(text.decode(bytes(0x41, 0xe5, 0xb0, 0xbe), 'utf-8'), 'A尾');
  assert.equal(text.decode(bytes(0x41, 0x00, 0x3d, 0xd8, 0x3e, 0xdc), 'utf-16le'), 'A🐾');
  assert.equal(text.decode(bytes(0x00, 0x41, 0xd8, 0x3d, 0xdc, 0x3e), 'utf-16be'), 'A🐾');
  assert.equal(text.decode(bytes(0x41, 0x00), 'utf-16'), 'A');
});

test('BOM detection takes precedence over the explicit label and is removed', () => {
  const text = createFileText();
  assert.equal(text.decode(bytes(0xef, 0xbb, 0xbf, 0x41), 'windows-1252'), 'A');
  assert.equal(text.decode(bytes(0xff, 0xfe, 0x41, 0x00, 0x42, 0x00), 'utf-8'), 'AB');
  assert.equal(text.decode(bytes(0xfe, 0xff, 0x00, 0x41, 0x00, 0x42), 'windows-1252'), 'AB');
});

test('Windows-1252 aliases use the browser mapping and MIME charset is ignored', () => {
  const text = createFileText();
  const payload = bytes(0x80, 0x93, 0x41, 0x94, 0x81, 0x9f, 0xe9);
  const expected = '€“A”\u0081Ÿé';
  for (const label of ['windows-1252', 'cp1252', 'iso-8859-1', 'latin1', 'ascii']) {
    assert.equal(text.decode(payload, label), expected);
  }
  assert.equal(text.decode(bytes(0x80, 0x93, 0x41, 0x94),
    undefined, 'text/plain;charset=windows-1252'), '��A�');
  assert.equal(text.decode(bytes(0x80), 'iso-8859-1'), '€');
  assert.equal(text.decode(bytes(0x80), 'latin-1'), '�');
});


test('all 256 Windows-1252 bytes match the platform TextDecoder table', () => {
  const text = createFileText();
  const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  assert.equal(text.decode(allBytes, 'windows-1252'), new TextDecoder('windows-1252').decode(allBytes));
});

test('unknown labels fall back to UTF-8 while recognized unsupported labels fail clearly', () => {
  const text = createFileText();
  assert.equal(text.decode(bytes(0x41, 0xe5, 0xb0, 0xbe), 'not-a-real-encoding'), 'A尾');
  assert.equal(text.decode(bytes(0x41, 0xe5, 0xb0, 0xbe), 'cp437'), 'A尾');
  assert.equal(text.decode(bytes(0x41, 0xe5, 0xb0, 0xbe), 'utf-7'), 'A尾');
  assert.throws(() => text.decode(bytes(0x41), 'shift_jis'), error => {
    assert.equal(error.name, 'NotSupportedError');
    return true;
  });
  // A BOM is an autodetection signal and wins before trying the unsupported label.
  assert.equal(text.decode(bytes(0xef, 0xbb, 0xbf, 0x41), 'shift_jis'), 'A');
});

test('malformed UTF-8 uses maximal-subpart replacement for invalid and truncated input', () => {
  const text = createFileText();
  assert.equal(text.decode(bytes(0xe2, 0x82), 'utf-8'), '�');
  assert.equal(text.decode(bytes(0xe2, 0x82, 0x41), 'utf-8'), '�A');
  assert.equal(text.decode(bytes(0xc0, 0xaf, 0xed, 0xa0, 0x80), 'utf-8'), '�����');
  assert.equal(text.decode(bytes(0xf0, 0x9f, 0x92), 'utf-8'), '�');
});

test('UTF-16 replaces malformed code units and a trailing odd byte', () => {
  const text = createFileText();
  assert.equal(text.decode(bytes(0x00, 0xd8, 0x41, 0x00, 0x00), 'utf-16le'), '�A�');
  assert.equal(text.decode(bytes(0x00, 0xdc), 'utf-16le'), '�');
});

test('valid UTF-8 may use the injected native decoder; malformed UTF-8 bypasses it', () => {
  const calls = [];
  const text = createFileText({
    utf8Decode(input) {
      calls.push([...input]);
      return new TextDecoder('utf-8').decode(input);
    }
  });
  assert.equal(text.decode(bytes(0x41, 0xe5, 0xb0, 0xbe), 'utf-8'), 'A尾');
  assert.equal(text.decode(bytes(0xe2, 0x82), 'utf-8'), '�');
  assert.deepEqual(calls, [[0x41, 0xe5, 0xb0, 0xbe]]);
});

test('enforces the 2 MiB input limit and rejects non-byte input', () => {
  const text = createFileText();
  assert.equal(text.decode(new Uint8Array(2 * 1024 * 1024), 'utf-8').length, 2 * 1024 * 1024);
  assert.throws(() => text.decode(new Uint8Array(2 * 1024 * 1024 + 1), 'utf-8'), error => error.name === 'RangeError');
  assert.throws(() => text.decode('not bytes', 'utf-8'), error => error.name === 'TypeError');
});

// The document wrapper supplies the public decoder and the complete official
// alias table. Keep File API BOM sniffing distinct from TextDecoder semantics.
function createIntegratedFileText() {
  const sources = ['document_encoding_data.js', 'document_text_decoder_source.js',
    'document_file_text_source.js'].map(name => readFileSync(new URL(name, import.meta.url), 'utf8'));
  return vm.runInNewContext(sources.join('\n') + `
    const data = createDocumentEncodingData();
    createDocumentFileText({ ...data, ...createDocumentTextDecoder(data) });`);
}

test('integrated FileReader/XHR text decoding supports complete Big5 aliases and scalars', () => {
  const text = createIntegratedFileText();
  for (const label of ['big5', 'Big5-HKSCS', 'cn-big5', 'csbig5', 'x-x-big5']) {
    assert.equal(text.decode(bytes(0xa5, 0x78, 0xa5, 0x5f), label), '台北');
    assert.equal(text.decode(bytes(0xfa, 0x40, 0x88, 0x62), label), '\u{20547}Ê\u0304');
    assert.equal(text.decode(bytes(0xa5, 0x20, 0x41), label), '� A');
  }
});

test('integrated File API sniffs BOM once, retains a second BOM, and resolves official aliases', () => {
  const text = createIntegratedFileText();
  assert.equal(text.decode(bytes(0xff, 0xfe, 0x41, 0), 'big5'), 'A');
  assert.equal(text.decode(bytes(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x41), 'big5'), '\ufeffA');
  assert.equal(text.decode(bytes(0x80), 'iso_8859-1:1987'), '€');
  assert.equal(text.decode(bytes(0xe5, 0xb0, 0xbe), 'unknown-encoding'), '尾');
  assert.equal(text.decodeUtf8(bytes(0xa5, 0x78)), '�x');
  assert.throws(() => text.decode(bytes(65), 'Shift_JIS'), {name: 'NotSupportedError'});
  assert.equal(text.decode(bytes(0xef, 0xbb, 0xbf, 65), 'Shift_JIS'), 'A');
});
