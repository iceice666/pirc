import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const fixturePath = path.join(repositoryRoot, 'apps/android/integration_test/document_text_encoding_fixture.dart');
const fixtureSource = readFileSync(fixturePath, 'utf8');
const fixtureMatch = fixtureSource.match(/const documentTextEncodingFixture\s*=\s*r'''([\s\S]*?)''';/);
assert.ok(fixtureMatch, 'Could not extract documentTextEncodingFixture.');
const fixtureHtml = fixtureMatch[1];
const indexPath = path.join(repositoryRoot, 'apps/android/tool/parity/vendor/whatwg-encoding-20240918/index-big5.txt');
const indexSource = readFileSync(indexPath, 'utf8');
const browserExecutable = requireTestBrowserExecutable();
assert.ok(existsSync(browserExecutable), 'Missing Chrome executable: ' + browserExecutable);
const gatewayRequire = createRequire(path.join(repositoryRoot, 'apps/gateway/package.json'));
const {chromium} = gatewayRequire('playwright-core');

const indexEntries = new Map();
for (const line of indexSource.split('\n')) {
  const match = line.match(/^\s*(\d+)\s+0x([0-9A-Fa-f]+)/);
  if (match) indexEntries.set(Number(match[1]), [Number.parseInt(match[2], 16)]);
}
for (const [pointer, codePoints] of [
  [1133, [0x00CA, 0x0304]],
  [1135, [0x00CA, 0x030C]],
  [1164, [0x00EA, 0x0304]],
  [1166, [0x00EA, 0x030C]],
]) {
  indexEntries.set(pointer, codePoints);
}
const officialRows = [...indexEntries]
  .sort(([left], [right]) => left - right)
  .map(([pointer, codePoints]) => [pointer, codePoints]);
const pointerBytes = pointer => {
  const row = Math.floor(pointer / 157);
  const column = pointer % 157;
  return [0x81 + row, column < 63 ? 0x40 + column : 0xA1 + column - 63];
};
const textSnapshot = value => ({
  text: value,
  length: value.length,
  codeUnits: Array.from({length: value.length}, (_, index) => value.charCodeAt(index)),
  codePoints: Array.from(value, character => character.codePointAt(0)),
});
const expectedBig5Text = codePoints => String.fromCodePoint(...codePoints);
const nodeDecoder = new TextDecoder('big5');
const nodeMismatchSamples = [];
let nodeMismatchCount = 0;
for (const [pointer, codePoints] of officialRows) {
  const actual = nodeDecoder.decode(Uint8Array.from(pointerBytes(pointer)));
  const expected = expectedBig5Text(codePoints);
  if (actual !== expected) {
    nodeMismatchCount++;
    if (nodeMismatchSamples.length < 8) {
      nodeMismatchSamples.push({
        pointer,
        bytes: pointerBytes(pointer),
        expectedCodePoints: codePoints,
        actual: textSnapshot(actual),
      });
    }
  }
}
const nodeReferenceVectors = [
  {name: 'taipei', pointer: null, bytes: [0xA5, 0x78, 0xA5, 0x5F], expectedCodePoints: [0x53F0, 0x5317]},
  {name: 'taipeiTraditional', pointer: null, bytes: [0xBB, 0x4F, 0xA5, 0x5F], expectedCodePoints: [0x81FA, 0x5317]},
  {name: 'rareAstralPointer18997', pointer: 18997, bytes: pointerBytes(18997), expectedCodePoints: [0x20547]},
  {name: 'rareAstralPointer19027', pointer: 19027, bytes: pointerBytes(19027), expectedCodePoints: [0x22513]},
  {name: 'multiCodePointPointer1133', pointer: 1133, bytes: pointerBytes(1133), expectedCodePoints: [0x00CA, 0x0304]},
  {name: 'multiCodePointPointer1135', pointer: 1135, bytes: pointerBytes(1135), expectedCodePoints: [0x00CA, 0x030C]},
  {name: 'multiCodePointPointer1164', pointer: 1164, bytes: pointerBytes(1164), expectedCodePoints: [0x00EA, 0x0304]},
  {name: 'multiCodePointPointer1166', pointer: 1166, bytes: pointerBytes(1166), expectedCodePoints: [0x00EA, 0x030C]},
].map(vector => ({
  ...vector,
  expectedText: expectedBig5Text(vector.expectedCodePoints),
  nodeBuiltIn: textSnapshot(nodeDecoder.decode(Uint8Array.from(vector.bytes))),
}));

const utf8JsonPayload = {
  status: 'OK',
  message: 'UTF-8 JSON 中文 🐈',
  charset: 'big5',
};
const utf8JsonBody = Buffer.from(JSON.stringify(utf8JsonPayload), 'utf8');
const big5ResponseBytes = Buffer.from([0xA5, 0x78, 0xA5, 0x5F]);
const requests = [];
const unexpectedLocalRequests = [];
const blockedThirdPartyRequests = [];
const pageErrors = [];
const browserConsoleErrors = [];
const serverErrors = [];
const expectedPostText = '城市 台北 🐈';
let origin = '';

const server = createServer((request, response) => {
  void (async () => {
    const requestUrl = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
    const method = request.method ?? 'GET';
    if (method === 'POST' && requestUrl.pathname === '/encoded-body') {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const bodyText = new TextDecoder('utf-8', {fatal: true}).decode(body);
      requests.push({
        method,
        path: requestUrl.pathname,
        contentType: String(request.headers['content-type'] ?? ''),
        bodyByteLength: body.length,
        bodyBase64: body.toString('base64'),
        bodyText,
      });
      response.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
      response.end(JSON.stringify({bytesBase64: body.toString('base64'), bodyText}));
      return;
    }
    requests.push({method, path: requestUrl.pathname});
    if (method === 'GET' && requestUrl.pathname === '/fixture') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'",
        'cache-control': 'no-store',
      });
      response.end(fixtureHtml);
      return;
    }
    if (method === 'GET' && requestUrl.pathname === '/big5.txt') {
      response.writeHead(200, {'content-type': 'text/plain; charset=Big5', 'cache-control': 'no-store'});
      response.end(big5ResponseBytes);
      return;
    }
    if (method === 'GET' && requestUrl.pathname === '/utf8.json') {
      response.writeHead(200, {'content-type': 'application/json; charset=Big5', 'cache-control': 'no-store'});
      response.end(utf8JsonBody);
      return;
    }
    if (method === 'GET' && requestUrl.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    unexpectedLocalRequests.push({method, path: requestUrl.pathname});
    response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
    response.end('unexpected local request');
  })().catch(error => {
    serverErrors.push(String(error && error.stack || error));
    if (!response.headersSent) {
      response.writeHead(500, {'content-type': 'text/plain; charset=utf-8'});
    }
    response.end('local oracle error');
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
origin = 'http://127.0.0.1:' + address.port;

const evidenceDirectory = path.join(
  repositoryRoot,
  'apps/android/build/parity-acceptance/document-text-encoding-20261016',
);
const evidencePath = path.join(evidenceDirectory, 'browser-oracle.json');
const verificationResults = [];
const verificationFailures = [];
const verify = (name, action) => {
  try {
    action();
    verificationResults.push({name, status: 'PASS'});
  } catch (error) {
    verificationResults.push({name, status: 'FAIL', message: error.message});
    verificationFailures.push(name + ': ' + error.message);
  }
};
let browser = null;
let browserVersion = null;
let observed = null;
let fatalUtf16Probes = null;
let officialBig5Scan = null;
let runError = null;

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable,
    args: ['--disable-background-networking', '--disable-extensions', '--no-first-run'],
  });
  browserVersion = 'Google Chrome ' + browser.version();
  verify('requested Chrome 155 version', () => assert.match(browserVersion, /^Google Chrome 155\./));

  const page = await browser.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') browserConsoleErrors.push(message.text());
  });
  await page.route('**/*', async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === origin) {
      await route.continue();
    } else {
      blockedThirdPartyRequests.push(requestUrl.href);
      await route.abort();
    }
  });
  await page.goto(origin + '/fixture', {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => {
    const content = document.querySelector('#result')?.textContent ?? '';
    try {
      return JSON.parse(content).status === 'DONE';
    } catch (_) {
      return false;
    }
  }, undefined, {timeout: 30000});
  observed = JSON.parse(await page.locator('#result').textContent());
  fatalUtf16Probes = await page.evaluate(() => {
    const snapshot = value => ({
      text: value,
      length: value.length,
      codeUnits: Array.from({length: value.length}, (_, index) => value.charCodeAt(index)),
      codePoints: Array.from(value, character => character.codePointAt(0)),
    });
    const capture = (decoder, inputBytes, stream) => {
      try {
        const value = decoder.decode(Uint8Array.from(inputBytes), stream ? {stream: true} : undefined);
        return {inputBytes, stream, value: snapshot(value)};
      } catch (error) {
        return {inputBytes, stream, errorName: error.name, errorMessage: error.message};
      }
    };
    const makeDecoder = () => new TextDecoder('utf-16le', {fatal: true});
    const call = (decoder, bytes, stream) => capture(decoder, bytes, stream);
    const pendingSurrogateRecovery = makeDecoder();
    const oddTailAfterFailure = makeDecoder();
    const oddTailWithNextPair = makeDecoder();
    const multiChunk = makeDecoder();
    const completeUnreadTailDiscard = makeDecoder();
    const longEvenTailDiscard = makeDecoder();
    const longOddTailAfterError = makeDecoder();
    const longEvenTail = Array.from({length: 24}, (_, index) => index % 2 ? 0x00 : 0x41);
    return {
      pendingSurrogateRecovery: {
        calls: [
          call(pendingSurrogateRecovery, [0x00, 0xD8], true),
          call(pendingSurrogateRecovery, [0x41, 0x00], true),
          call(pendingSurrogateRecovery, [0x41, 0x42], false),
        ],
      },
      oddTailAfterFailure: {
        calls: [
          call(oddTailAfterFailure, [0x00, 0xD8], true),
          call(oddTailAfterFailure, [0x41, 0x00, 0x01], true),
          call(oddTailAfterFailure, [], false),
        ],
      },
      oddTailWithNextPair: {
        calls: [
          call(oddTailWithNextPair, [0x00, 0xD8], true),
          call(oddTailWithNextPair, [0x41, 0x00, 0x01], true),
          call(oddTailWithNextPair, [0x41, 0x42], false),
        ],
      },
      completeUnreadTailDiscard: {
        calls: [
          call(completeUnreadTailDiscard, [0x00, 0xD8], true),
          call(completeUnreadTailDiscard, [0x41, 0x00, 0x41, 0x00], true),
          call(completeUnreadTailDiscard, [], false),
        ],
      },
      longEvenTailDiscard: {
        calls: [
          call(longEvenTailDiscard, [0x00, 0xD8], true),
          call(longEvenTailDiscard, [0x41, 0x00, ...longEvenTail], true),
          call(longEvenTailDiscard, [], false),
        ],
      },
      longOddTailAfterError: {
        calls: [
          call(longOddTailAfterError, [0x00, 0xD8], true),
          call(longOddTailAfterError, [0x41, 0x00, ...longEvenTail, 0x01], true),
          call(longOddTailAfterError, [], false),
        ],
      },
      multiChunk: {
        calls: [
          call(multiChunk, [125, 13, 247, 163, 30, 88, 140, 58, 26, 216], true),
          call(multiChunk, [131, 117, 44, 187, 139, 213, 184], true),
          call(multiChunk, [65, 66], false),
        ],
      },
    };
  });
  const visibleText = await page.locator('#visible').textContent();

  officialBig5Scan = await page.evaluate(rows => {
    const decoder = new TextDecoder('big5');
    const mismatches = [];
    const codeUnits = text => Array.from({length: text.length}, (_, index) => text.charCodeAt(index));
    const codePoints = text => Array.from(text, character => character.codePointAt(0));
    for (const row of rows) {
      const pointer = row[0];
      const expectedCodePoints = row[1];
      const expectedText = String.fromCodePoint(...expectedCodePoints);
      const column = pointer % 157;
      const bytes = [0x81 + Math.floor(pointer / 157), column < 63 ? 0x40 + column : 0xA1 + column - 63];
      const actualText = decoder.decode(Uint8Array.from(bytes));
      if (actualText !== expectedText) {
        mismatches.push({
          pointer,
          bytes,
          expectedCodePoints,
          expectedText,
          actualText,
          actualCodeUnits: codeUnits(actualText),
          actualCodePoints: codePoints(actualText),
        });
      }
    }
    return {compared: rows.length, mismatchCount: mismatches.length, mismatches};
  }, officialRows);

  const expectedUtf8Bytes = [
    0xE5, 0x8F, 0xB0, 0xE5, 0x8C, 0x97, 0xF0, 0x9F, 0x90, 0x88,
    0xEF, 0xBF, 0xBD, 0x58, 0xEF, 0xBF, 0xBD,
  ];
  const expectedUploadBytes = Array.from(new TextEncoder().encode(expectedPostText));
  verify('fixture completed with visible Chinese status', () => {
    assert.equal(observed.status, 'DONE');
    assert.equal(observed.visibleMessage, '中文文字編碼驗收完成');
    assert.equal(visibleText, '中文文字編碼驗收完成');
  });
  verify('UTF-8 TextEncoder and encodeInto', () => {
    assert.equal(observed.textEncoder.encoding, 'utf-8');
    assert.deepEqual(observed.textEncoder.encodeBytes, expectedUtf8Bytes);
    assert.deepEqual(observed.textEncoder.encodeInto.partial, {
      read: 1,
      written: 3,
      backingBytes: [0xCC, 0xCC, 0xE5, 0x8F, 0xB0, 0xCC, 0xCC, 0xCC],
    });
    assert.equal(observed.textEncoder.encodeInto.complete.read, 4);
    assert.equal(observed.textEncoder.encodeInto.complete.written, 8);
    assert.deepEqual(observed.textEncoder.encodeInto.loneSurrogate, {
      read: 1,
      written: 3,
      bytes: [0xEF, 0xBF, 0xBD],
    });
  });
  verify('decoder common encodings, labels, stream chunks, BOM, typed views, errors, and brands', () => {
    assert.equal(observed.textDecoder.utf8.text, 'A尾🐈');
    assert.equal(observed.textDecoder.utf16le.text, 'A🐈');
    assert.equal(observed.textDecoder.utf16be.text, 'A🐈');
    assert.equal(observed.textDecoder.windows1252.text, '€“A”\u0081Ÿé');
    assert.equal(observed.textDecoder.big5Common[0].actual.text, '台北');
    assert.equal(observed.textDecoder.big5Common[1].actual.text, '臺北');
    assert.equal(observed.textDecoder.streams.utf8.combined, '🐈');
    assert.equal(observed.textDecoder.streams.big5.combined, '台');
    assert.equal(observed.textDecoder.streams.utf16le.combined, 'A🐈');
    assert.equal(observed.textDecoder.typedArrayOffset.text, '台');
    assert.equal(observed.textDecoder.dataViewOffset.text, '台');
    assert.equal(observed.textDecoder.bom.utf8Default.text, 'A');
    assert.equal(observed.textDecoder.bom.utf8IgnoreBOM.text, '\uFEFFA');
    assert.deepEqual(observed.textDecoder.canonicalLabels.find(item => item.label === 'utf8'), {
      label: 'utf8', encoding: 'utf-8', errorName: null,
    });
    assert.deepEqual(observed.textDecoder.canonicalLabels.find(item => item.label === 'latin1'), {
      label: 'latin1', encoding: 'windows-1252', errorName: null,
    });
    assert.deepEqual(observed.textDecoder.canonicalLabels.find(item => item.label === 'big5-hkscs'), {
      label: 'big5-hkscs', encoding: 'big5', errorName: null,
    });
    assert.equal(observed.textDecoder.errors.invalidLabel, 'RangeError');
    assert.equal(observed.textDecoder.errors.fatalUtf8, 'TypeError');
    assert.equal(observed.textDecoder.errors.fatalBig5, 'TypeError');
    assert.equal(observed.textDecoder.errors.wrongSourceType, 'TypeError');
    assert.deepEqual(observed.textDecoder.brands, {
      encoderEncode: 'TypeError',
      encoderEncodeInto: 'TypeError',
      encoderEncodingGetter: 'TypeError',
      decoderDecode: 'TypeError',
      decoderEncodingGetter: 'TypeError',
    });
  });
  verify('Chrome fatal UTF-16LE stream errors and post-error state', () => {
    const invalidError = {
      errorName: 'TypeError',
      errorMessage: "Failed to execute 'decode' on 'TextDecoder': The encoded data was not valid.",
    };
    const empty = {text: '', length: 0, codeUnits: [], codePoints: []};
    const expectedCall = (inputBytes, stream, result) => ({inputBytes, stream, ...result});
    assert.deepEqual(fatalUtf16Probes.pendingSurrogateRecovery.calls, [
      expectedCall([0x00, 0xD8], true, {value: empty}),
      expectedCall([0x41, 0x00], true, invalidError),
      expectedCall([0x41, 0x42], false, {value: {text: '䉁', length: 1, codeUnits: [16961], codePoints: [16961]}}),
    ]);
    for (const name of ['oddTailAfterFailure', 'oddTailWithNextPair']) {
      const lastInput = name === 'oddTailAfterFailure' ? [] : [0x41, 0x42];
      assert.deepEqual(fatalUtf16Probes[name].calls, [
        expectedCall([0x00, 0xD8], true, {value: empty}),
        expectedCall([0x41, 0x00, 0x01], true, invalidError),
        expectedCall(lastInput, false, invalidError),
      ]);
    }
    for (const name of ['completeUnreadTailDiscard', 'longEvenTailDiscard']) {
      const secondBytes = name === 'completeUnreadTailDiscard'
        ? [0x41, 0x00, 0x41, 0x00]
        : [0x41, 0x00, ...Array.from({length: 24}, (_, index) => index % 2 ? 0x00 : 0x41)];
      assert.deepEqual(fatalUtf16Probes[name].calls, [
        expectedCall([0x00, 0xD8], true, {value: empty}),
        expectedCall(secondBytes, true, invalidError),
        expectedCall([], false, {value: empty}),
      ]);
    }
    assert.deepEqual(fatalUtf16Probes.longOddTailAfterError.calls, [
      expectedCall([0x00, 0xD8], true, {value: empty}),
      expectedCall([0x41, 0x00, ...Array.from({length: 24}, (_, index) => index % 2 ? 0x00 : 0x41), 0x01], true, invalidError),
      expectedCall([], false, invalidError),
    ]);
    assert.deepEqual(fatalUtf16Probes.multiChunk.calls, [
      expectedCall([125, 13, 247, 163, 30, 88, 140, 58, 26, 216], true, {
        value: {text: 'ൽꏷ堞㪌', length: 4, codeUnits: [3453, 41975, 22558, 14988], codePoints: [3453, 41975, 22558, 14988]},
      }),
      expectedCall([131, 117, 44, 187, 139, 213, 184], true, invalidError),
      expectedCall([65, 66], false, invalidError),
    ]);
    assert.deepEqual(observed.fatalUtf16RecoveryObservation, {
      inputs: [
        {bytes: [125, 13, 247, 163, 30, 88, 140, 58, 26, 216], stream: true},
        {bytes: [131, 117, 44, 187, 139, 213, 184], stream: true},
        {bytes: [65, 66], stream: false},
      ],
      calls: [
        {value: {text: 'ൽꏷ堞㪌', length: 4, codeUnits: [3453, 41975, 22558, 14988], codePoints: [3453, 41975, 22558, 14988]}},
        {errorName: 'TypeError'},
        {errorName: 'TypeError'},
      ],
    });
  });
  verify('fetch, Blob, FileReader, XHR, JSON, and encoded request body integration', () => {
    assert.equal(observed.integrations.fetchArrayBufferBig5.text, '台北');
    assert.equal(observed.integrations.fileReaderReadAsTextBig5.text, '台北');
    assert.equal(observed.integrations.xhrResponseTextBig5.text, '台北');
    assert.equal(observed.integrations.fetchTextUtf8Control.text, '\uFFFDx\uFFFD_');
    assert.equal(observed.integrations.blobTextUtf8Control.text, '\uFFFDx\uFFFD_');
    assert.deepEqual(observed.integrations.fetchJson, utf8JsonPayload);
    assert.deepEqual(observed.integrations.xhrResponseTypeJson, utf8JsonPayload);
    assert.deepEqual(observed.integrations.encodedBody.bytes, expectedUploadBytes);
    assert.deepEqual(observed.integrations.encodedBody.response, {
      bytesBase64: Buffer.from(expectedUploadBytes).toString('base64'),
      bodyText: expectedPostText,
    });
  });
  verify('shared fixture has no page errors or external requests', () => {
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(observed.pageErrors, []);
    assert.deepEqual(blockedThirdPartyRequests, []);
    assert.deepEqual(observed.blockedExternalRequests, []);
    assert.deepEqual(unexpectedLocalRequests, []);
    assert.deepEqual(serverErrors, []);
  });
  verify('full browser Big5 scan covered every vendor index entry and four multi-codepoint rows', () => {
    assert.equal(officialBig5Scan.compared, officialRows.length);
    assert.equal(officialBig5Scan.mismatches.length, officialBig5Scan.mismatchCount);
    assert.equal(officialBig5Scan.compared, indexEntries.size);
  });
} catch (error) {
  runError = String(error && error.stack || error);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}

const evidence = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  browser: browserVersion,
  origin,
  sourceHash: {
    algorithm: 'sha256',
    fixturePath: path.relative(repositoryRoot, fixturePath),
    fixtureSha256: createHash('sha256').update(fixtureSource).digest('hex'),
    runnerPath: path.relative(repositoryRoot, fileURLToPath(import.meta.url)),
    runnerSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  },
  officialBig5Index: {
    path: path.relative(repositoryRoot, indexPath),
    identifier: (indexSource.match(/^# Identifier: ([0-9a-f]+)/m) || [])[1] || null,
    date: (indexSource.match(/^# Date: (.+)$/m) || [])[1] || null,
    indexEntries: indexEntries.size,
    comparedRows: officialBig5Scan && officialBig5Scan.compared || 0,
    chromeMismatchCount: officialBig5Scan && officialBig5Scan.mismatchCount || null,
    chromeMismatches: officialBig5Scan && officialBig5Scan.mismatches || [],
    node: {
      version: process.version,
      mismatchCount: nodeMismatchCount,
      mismatchExamples: nodeMismatchSamples,
      fixedVectors: nodeReferenceVectors,
    },
  },
  network: {
    allowedRequests: requests,
    unexpectedLocalRequests,
    blockedThirdPartyRequests,
    policy: 'Loopback HTTP only; Playwright aborts every non-loopback page request and the fixture CSP restricts resources to self.',
  },
  assertions: {
    results: verificationResults,
    failures: verificationFailures,
    browserProcessError: runError,
    browserConsoleErrors,
    serverErrors,
  },
  observations: observed,
  supplementalObservations: {fatalUtf16Probes},
  pageErrors,
};
await mkdir(evidenceDirectory, {recursive: true});
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
const utf16Evidence = {
  schemaVersion: 1,
  createdAt: evidence.createdAt,
  browser: browserVersion,
  origin,
  sourceHash: evidence.sourceHash,
  networkPolicy: 'Local page.evaluate probes only; no request is issued by the probe. The browser context blocks all non-loopback requests.',
  observations: fatalUtf16Probes,
  pageErrors,
};
await writeFile(path.join(evidenceDirectory, 'utf16-fatal-browser.json'), JSON.stringify(utf16Evidence, null, 2) + '\n');
console.log(JSON.stringify({
  status: runError || verificationFailures.length ? 'FAIL' : 'PASS',
  browser: browserVersion,
  evidencePath,
  sourceHash: evidence.sourceHash.fixtureSha256,
  indexRows: evidence.officialBig5Index.comparedRows,
  chromeBig5MismatchCount: evidence.officialBig5Index.chromeMismatchCount,
  nodeBig5MismatchCount: nodeMismatchCount,
  failedAssertions: verificationFailures,
}, null, 2));
if (runError) throw new Error(runError);
if (verificationFailures.length) throw new Error(verificationFailures.join('\n'));
