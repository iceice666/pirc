const documentTextEncodingFixture = r'''<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'">
  <title>TextEncoder and TextDecoder parity</title>
</head>
<body>
  <h1>TextEncoder / TextDecoder parity</h1>
  <p id="visible">等待文字編碼結果</p>
  <pre id="result">WAITING</pre>
<script>
(() => {
  const resultNode = document.querySelector('#result');
  const visibleNode = document.querySelector('#visible');
  const pageErrors = [];
  const blockedExternalRequests = [];
  window.addEventListener('error', event => {
    pageErrors.push({type: 'error', message: event.message || String(event.error || '')});
  });
  window.addEventListener('unhandledrejection', event => {
    pageErrors.push({type: 'unhandledrejection', message: String(event.reason || '')});
    event.preventDefault();
  });
  window.addEventListener('securitypolicyviolation', event => {
    const blocked = String(event.blockedURI || '');
    if (blocked && blocked !== 'inline' && blocked !== 'eval') {
      try {
        if (new URL(blocked, location.href).origin !== location.origin) {
          blockedExternalRequests.push({
            blockedURI: blocked,
            directive: event.effectiveDirective || null
          });
        }
      } catch (_) {
        blockedExternalRequests.push({
          blockedURI: blocked,
          directive: event.effectiveDirective || null
        });
      }
    }
  });

  const snapshotText = text => ({
    text,
    length: text.length,
    codeUnits: Array.from({length: text.length}, (_, index) => text.charCodeAt(index)),
    codePoints: Array.from(text, character => character.codePointAt(0))
  });
  const errorName = action => {
    try {
      action();
      return null;
    } catch (error) {
      return error && error.name || 'Error';
    }
  };
  const decoderLabel = label => {
    try {
      return {label, encoding: new TextDecoder(label).encoding, errorName: null};
    } catch (error) {
      return {label, encoding: null, errorName: error && error.name || 'Error'};
    }
  };
  const readAsText = (blob, encoding) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsText(blob, encoding);
  });
  const xhrGet = (path, responseType) => new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', path);
    if (responseType) request.responseType = responseType;
    request.onload = () => {
      if (responseType) resolve(request.response);
      else resolve(request.responseText);
    };
    request.onerror = () => reject(new Error('XHR failed for ' + path));
    request.send();
  });

  const big5Examples = [
    {name: 'taipei', bytes: [0xA5, 0x78, 0xA5, 0x5F], expectedCodePoints: [0x53F0, 0x5317]},
    {name: 'taipeiTraditional', bytes: [0xBB, 0x4F, 0xA5, 0x5F], expectedCodePoints: [0x81FA, 0x5317]}
  ];
  const big5SpecialCases = [
    {name: 'rareAstralPointer18997', pointer: 18997, bytes: [0xFA, 0x40], expectedCodePoints: [0x20547]},
    {name: 'rareAstralPointer19027', pointer: 19027, bytes: [0xFA, 0x5E], expectedCodePoints: [0x22513]},
    {name: 'multiCodePointPointer1133', pointer: 1133, bytes: [0x88, 0x62], expectedCodePoints: [0x00CA, 0x0304]},
    {name: 'multiCodePointPointer1135', pointer: 1135, bytes: [0x88, 0x64], expectedCodePoints: [0x00CA, 0x030C]},
    {name: 'multiCodePointPointer1164', pointer: 1164, bytes: [0x88, 0xA3], expectedCodePoints: [0x00EA, 0x0304]},
    {name: 'multiCodePointPointer1166', pointer: 1166, bytes: [0x88, 0xA5], expectedCodePoints: [0x00EA, 0x030C]}
  ];

  const run = async () => {
    const encoder = new TextEncoder('big5');
    const encodedInput = '台北🐈\uD800X\uDC00';
    const encodedBytes = Array.from(encoder.encode(encodedInput));

    const partialBacking = new Uint8Array(8);
    partialBacking.fill(0xCC);
    const partialEncode = encoder.encodeInto('台🐈Z', partialBacking.subarray(2, 5));
    const completeBacking = new Uint8Array(12);
    completeBacking.fill(0xCC);
    const completeEncode = encoder.encodeInto('台🐈Z', new Uint8Array(completeBacking.buffer, 2, 8));
    const replacementTarget = new Uint8Array(3);
    const replacementEncode = encoder.encodeInto('\uD800', replacementTarget);

    const utf8Decoder = new TextDecoder('utf-8');
    const utf8Bytes = [0x41, 0xE5, 0xB0, 0xBE, 0xF0, 0x9F, 0x90, 0x88];
    const utf16leBytes = [0x41, 0x00, 0x3D, 0xD8, 0x08, 0xDC];
    const utf16beBytes = [0x00, 0x41, 0xD8, 0x3D, 0xDC, 0x08];
    const windows1252Bytes = [0x80, 0x93, 0x41, 0x94, 0x81, 0x9F, 0xE9];
    const big5Decoder = new TextDecoder('big5');
    const big5ExampleObservations = big5Examples.map(example => {
      const text = big5Decoder.decode(Uint8Array.from(example.bytes));
      return {
        name: example.name,
        bytes: example.bytes,
        expectedCodePoints: example.expectedCodePoints,
        expectedText: String.fromCodePoint(...example.expectedCodePoints),
        actual: snapshotText(text)
      };
    });
    const big5SpecialObservations = big5SpecialCases.map(example => {
      const text = big5Decoder.decode(Uint8Array.from(example.bytes));
      return {
        name: example.name,
        pointer: example.pointer,
        bytes: example.bytes,
        expectedCodePoints: example.expectedCodePoints,
        expectedText: String.fromCodePoint(...example.expectedCodePoints),
        actual: snapshotText(text)
      };
    });

    const utf8StreamDecoder = new TextDecoder('utf-8');
    const utf8StreamFirst = utf8StreamDecoder.decode(Uint8Array.from([0xF0, 0x9F]), {stream: true});
    const utf8StreamLast = utf8StreamDecoder.decode(Uint8Array.from([0x90, 0x88]));
    const big5StreamDecoder = new TextDecoder('big5');
    const big5StreamFirst = big5StreamDecoder.decode(Uint8Array.from([0xA5]), {stream: true});
    const big5StreamLast = big5StreamDecoder.decode(Uint8Array.from([0x78]));
    const utf16StreamDecoder = new TextDecoder('utf-16le');
    const utf16StreamFirst = utf16StreamDecoder.decode(Uint8Array.from([0x41]), {stream: true});
    const utf16StreamMiddle = utf16StreamDecoder.decode(Uint8Array.from([0x00, 0x3D, 0xD8]), {stream: true});
    const utf16StreamLast = utf16StreamDecoder.decode(Uint8Array.from([0x08, 0xDC]));
    const fatalStreamDecoder = new TextDecoder('utf-8', {fatal: true});
    const fatalStreamError = errorName(() => fatalStreamDecoder.decode(Uint8Array.from([0xFF, 0x41]), {stream: true}));
    const fatalStreamRecovery = snapshotText(fatalStreamDecoder.decode(Uint8Array.from([0x42]), {stream: true}));
    const fatalBomStreamDecoder = new TextDecoder('utf-8', {fatal: true});
    const fatalBomStreamError = errorName(() => fatalBomStreamDecoder.decode(Uint8Array.from([0xEF, 0xBB, 0xBF, 0xFF]), {stream: true}));
    const fatalBomStreamRecovery = snapshotText(fatalBomStreamDecoder.decode(Uint8Array.from([0xEF, 0xBB, 0xBF, 0x41]), {stream: true}));
    const fatalUtf16RecoveryDecoder = new TextDecoder('utf-16le', {fatal: true});
    const fatalUtf16RecoveryInputs = [
      {bytes: [125, 13, 247, 163, 30, 88, 140, 58, 26, 216], stream: true},
      {bytes: [131, 117, 44, 187, 139, 213, 184], stream: true},
      {bytes: [65, 66], stream: false}
    ];
    const fatalUtf16RecoveryObservation = {
      inputs: fatalUtf16RecoveryInputs,
      calls: fatalUtf16RecoveryInputs.map(input => {
        try {
          const value = fatalUtf16RecoveryDecoder.decode(
            Uint8Array.from(input.bytes),
            input.stream ? {stream: true} : undefined
          );
          return {value: snapshotText(value)};
        } catch (error) {
          return {errorName: error && error.name || 'Error'};
        }
      })
    };

    const viewBuffer = Uint8Array.from([0x58, 0xA5, 0x78, 0x59]).buffer;
    const offsetArray = new Uint8Array(viewBuffer, 1, 2);
    const offsetDataView = new DataView(viewBuffer, 1, 2);
    const bomBytes = Uint8Array.from([0xEF, 0xBB, 0xBF, 0x41]);
    const utf8DefaultBom = new TextDecoder('utf-8').decode(bomBytes);
    const utf8KeptBom = new TextDecoder('utf-8', {ignoreBOM: true}).decode(bomBytes);
    const utf16leBom = Uint8Array.from([0xFF, 0xFE, 0x41, 0x00]);
    const utf16beBom = Uint8Array.from([0xFE, 0xFF, 0x00, 0x41]);

    const big5Payload = [0xA5, 0x78, 0xA5, 0x5F];
    const fetchArrayResponse = await fetch('/big5.txt');
    const fetchArrayBuffer = await fetchArrayResponse.arrayBuffer();
    const fetchArrayDecoded = new TextDecoder('big5').decode(fetchArrayBuffer);
    const fetchText = await (await fetch('/big5.txt')).text();
    const blob = new Blob([Uint8Array.from(big5Payload)], {type: 'text/plain;charset=Big5'});
    const blobText = await blob.text();
    const fileReaderText = await readAsText(blob, 'Big5');
    const xhrText = await xhrGet('/big5.txt', null);

    const fetchJson = await (await fetch('/utf8.json')).json();
    const xhrJson = await xhrGet('/utf8.json', 'json');
    const uploadText = '城市 台北 🐈';
    const uploadBytes = encoder.encode(uploadText);
    const uploadResponse = await fetch('/encoded-body', {
      method: 'POST',
      headers: {'content-type': 'text/plain;charset=utf-8'},
      body: uploadBytes
    });
    const uploadEcho = await uploadResponse.json();

    const invalidUtf8Bytes = Uint8Array.from([0xE2, 0x82]);
    const invalidBig5Bytes = Uint8Array.from([0x81]);
    const canonicalLabels = [
      decoderLabel('utf8'),
      decoderLabel('unicode-1-1-utf-8'),
      decoderLabel('utf-16'),
      decoderLabel('UTF-16BE'),
      decoderLabel('latin1'),
      decoderLabel('iso-8859-1'),
      decoderLabel('ascii'),
      decoderLabel('cp1252'),
      decoderLabel('big5'),
      decoderLabel('big5-hkscs'),
      decoderLabel('cn-big5'),
      decoderLabel('csbig5'),
      decoderLabel('x-x-big5')
    ];
    const wrongDecoderGetter = Object.getOwnPropertyDescriptor(TextDecoder.prototype, 'encoding').get;
    const wrongEncoderGetter = Object.getOwnPropertyDescriptor(TextEncoder.prototype, 'encoding').get;

    const model = {
      status: 'DONE',
      visibleMessage: '中文文字編碼驗收完成',
      textEncoder: {
        encoding: encoder.encoding,
        constructorArgumentIgnoredEncoding: encoder.encoding,
        encodeInput: encodedInput,
        encodeBytes: encodedBytes,
        encodeInto: {
          partial: {
            read: partialEncode.read,
            written: partialEncode.written,
            backingBytes: Array.from(partialBacking)
          },
          complete: {
            read: completeEncode.read,
            written: completeEncode.written,
            backingBytes: Array.from(completeBacking)
          },
          loneSurrogate: {
            read: replacementEncode.read,
            written: replacementEncode.written,
            bytes: Array.from(replacementTarget)
          }
        }
      },
      textDecoder: {
        canonicalLabels,
        utf8: snapshotText(utf8Decoder.decode(Uint8Array.from(utf8Bytes))),
        utf16le: snapshotText(new TextDecoder('utf-16le').decode(Uint8Array.from(utf16leBytes))),
        utf16be: snapshotText(new TextDecoder('utf-16be').decode(Uint8Array.from(utf16beBytes))),
        windows1252: snapshotText(new TextDecoder('windows-1252').decode(Uint8Array.from(windows1252Bytes))),
        big5Common: big5ExampleObservations,
        bom: {
          utf8Default: snapshotText(utf8DefaultBom),
          utf8IgnoreBOM: snapshotText(utf8KeptBom),
          utf16leDefault: snapshotText(new TextDecoder('utf-16le').decode(utf16leBom)),
          utf16leIgnoreBOM: snapshotText(new TextDecoder('utf-16le', {ignoreBOM: true}).decode(utf16leBom)),
          utf16beDefault: snapshotText(new TextDecoder('utf-16be').decode(utf16beBom)),
          utf16beIgnoreBOM: snapshotText(new TextDecoder('utf-16be', {ignoreBOM: true}).decode(utf16beBom))
        },
        streams: {
          utf8: {parts: [utf8StreamFirst, utf8StreamLast], combined: utf8StreamFirst + utf8StreamLast},
          big5: {parts: [big5StreamFirst, big5StreamLast], combined: big5StreamFirst + big5StreamLast},
          utf16le: {
            parts: [utf16StreamFirst, utf16StreamMiddle, utf16StreamLast],
            combined: utf16StreamFirst + utf16StreamMiddle + utf16StreamLast
          },
          fatalRecovery: {
            malformedInputError: fatalStreamError,
            nextChunk: fatalStreamRecovery
          },
          fatalBOMRecovery: {
            malformedInputError: fatalBomStreamError,
            nextChunk: fatalBomStreamRecovery
          }
        },
        typedArrayOffset: snapshotText(new TextDecoder('big5').decode(offsetArray)),
        dataViewOffset: snapshotText(new TextDecoder('big5').decode(offsetDataView)),
        errors: {
          invalidLabel: errorName(() => new TextDecoder('no-such-encoding-label')),
          fatalUtf8: errorName(() => new TextDecoder('utf-8', {fatal: true}).decode(invalidUtf8Bytes)),
          fatalBig5: errorName(() => new TextDecoder('big5', {fatal: true}).decode(invalidBig5Bytes)),
          wrongSourceType: errorName(() => new TextDecoder('utf-8').decode('not a BufferSource'))
        },
        brands: {
          encoderEncode: errorName(() => TextEncoder.prototype.encode.call({}, 'x')),
          encoderEncodeInto: errorName(() => TextEncoder.prototype.encodeInto.call({}, 'x', new Uint8Array(4))),
          encoderEncodingGetter: errorName(() => wrongEncoderGetter.call({})),
          decoderDecode: errorName(() => TextDecoder.prototype.decode.call({}, new Uint8Array(0))),
          decoderEncodingGetter: errorName(() => wrongDecoderGetter.call({}))
        }
      },
      fatalUtf16RecoveryObservation,
      big5SpecialObservations,
      integrations: {
        fetchArrayBufferBig5: snapshotText(fetchArrayDecoded),
        fetchTextUtf8Control: snapshotText(fetchText),
        blobTextUtf8Control: snapshotText(blobText),
        fileReaderReadAsTextBig5: snapshotText(fileReaderText),
        xhrResponseTextBig5: snapshotText(xhrText),
        fetchJson: fetchJson,
        xhrResponseTypeJson: xhrJson,
        encodedBody: {
          text: uploadText,
          bytes: Array.from(uploadBytes),
          response: uploadEcho
        }
      },
      pageErrors,
      blockedExternalRequests
    };
    window.__documentTextEncodingResult = model;
    resultNode.textContent = JSON.stringify(model);
    visibleNode.textContent = model.visibleMessage;
  };

  run().catch(error => {
    const failure = {
      status: 'ERROR',
      message: String(error && error.stack || error),
      pageErrors,
      blockedExternalRequests
    };
    window.__documentTextEncodingResult = failure;
    resultNode.textContent = JSON.stringify(failure);
    visibleNode.textContent = '文字編碼驗收失敗';
  });
})();
</script>
</body>
</html>''';
