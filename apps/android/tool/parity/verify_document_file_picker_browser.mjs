import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {existsSync, readFileSync} from 'node:fs';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const require = createRequire(import.meta.url);
const {chromium} = require(require.resolve('playwright-core', {
  paths: [path.join(repositoryRoot, 'apps/gateway')],
}));
const fixturePath = path.join(
  repositoryRoot,
  'apps/android/integration_test/document_file_picker_fixture.dart',
);
const fixtureSource = readFileSync(fixturePath, 'utf8');
const fixtureMatch = fixtureSource.match(
  /const documentFilePickerFixture\s*=\s*r'''([\s\S]*?)''';/,
);
assert.ok(fixtureMatch, 'Could not extract documentFilePickerFixture.');
const fixtureHtml = fixtureMatch[1];
const sourceHash = source => createHash('sha256').update(source).digest('hex');
const fixtureSha256 = sourceHash(fixtureSource);
const runnerSha256 = sourceHash(readFileSync(fileURLToPath(import.meta.url)));
const browserExecutable = [
  requireTestBrowserExecutable(),
  chromium.executablePath(),
].find(existsSync);
assert.ok(browserExecutable, 'No local Chrome or Chromium executable was found.');

const firstFile = {
  name: 'picked-雪.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('PICKED_SNOW_✅', 'utf8'),
};
const secondFile = {
  name: 'picked-binary.bin',
  mimeType: 'application/macbinary',
  buffer: Buffer.from([0, 127, 128, 255, 13, 10]),
};
const syntheticFilesDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'pirc-file-picker-oracle-'),
);
const syntheticFilePaths = [
  path.join(syntheticFilesDirectory, firstFile.name),
  path.join(syntheticFilesDirectory, secondFile.name),
];
await Promise.all([
  writeFile(syntheticFilePaths[0], firstFile.buffer),
  writeFile(syntheticFilePaths[1], secondFile.buffer),
]);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const requests = [];
const unexpectedLocalRequests = [];
const blockedExternalRequests = [];
let origin = '';
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
  requests.push({
    method: request.method ?? '',
    path: url.pathname,
    query: url.search,
    referer: request.headers.referer ?? '',
  });
  if (request.method === 'GET' && url.pathname === '/fixture') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(fixtureHtml);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  unexpectedLocalRequests.push({method: request.method ?? '', path: url.pathname});
  response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
  response.end('unexpected local request');
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
origin = 'http://127.0.0.1:' + address.port;
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
  args: ['--disable-gpu'],
});

const caseIds = [
  'connected-click',
  'hidden-click',
  'detached-click',
  'showPicker',
  'hidden-showPicker',
  'readonly-showPicker',
  'explicit-label-click',
  'implicit-label-click',
  'mouse-dispatch',
  'plain-event-dispatch',
  'prevent-default',
  'disabled-click',
  'disabled-showPicker',
  'fieldset-disabled-click',
  'fieldset-legend-click',
  'mutate-accept-multiple',
  'microtask-click',
  'timer-click',
  'repeated-clicks',
  'startup-click',
  'startup-showPicker',
  'physical-file',
  'physical-label-explicit',
  'physical-label-implicit',
];
const startupCases = new Set(['startup-click', 'startup-showPicker']);
const physicalSelectors = new Map([
  ['physical-file', '#file-input'],
  ['physical-label-explicit', '#file-label-text'],
  ['physical-label-implicit', '#file-label-text'],
]);

async function guard(context) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if ((url.protocol === 'http:' && url.port === String(address.port) &&
         (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) ||
        url.protocol === 'blob:' || url.protocol === 'data:') {
      await route.continue();
    } else {
      blockedExternalRequests.push(url.href);
      await route.abort();
    }
  });
}

function payloadsFor(isMultiple) {
  return isMultiple ? [firstFile, secondFile] : [firstFile];
}

async function readResult(page) {
  if (page.isClosed()) return null;
  try {
    return await page.evaluate(() => window.documentFilePickerResult ?? null);
  } catch (_) {
    return null;
  }
}

async function runCase(caseId) {
  const requestStart = requests.length;
  const context = await browser.newContext();
  await guard(context);
  const page = await context.newPage();
  const pageErrors = [];
  const chooserObservations = [];
  const chooserOperations = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('filechooser', chooser => {
    const observation = {
      index: chooserObservations.length + 1,
      isMultiple: chooser.isMultiple(),
      input: null,
      selectedPayloadNames: [],
      setFilesSucceeded: false,
      setFilesErrorName: null,
    };
    chooserObservations.push(observation);
    const operation = (async () => {
      try {
        observation.input = await chooser.element().evaluate(element => ({
          id: element.id,
          type: element.type,
          connected: element.isConnected,
          disabledProperty: element.disabled,
          disabledByFieldset: element.matches(':disabled'),
          readOnly: element.readOnly,
          accept: element.accept,
          multiple: element.multiple,
          display: getComputedStyle(element).display,
        }));
        const files = payloadsFor(observation.isMultiple);
        observation.selectedPayloadNames = files.map(file => file.name);
        await chooser.setFiles(syntheticFilePaths.slice(0, files.length));
        observation.setFilesSucceeded = true;
      } catch (error) {
        observation.setFilesErrorName = error && error.name ? error.name : 'Error';
        observation.setFilesError = String(error);
      }
    })();
    chooserOperations.push(operation);
  });

  try {
    const fixtureUrl = origin + '/fixture?case=' + encodeURIComponent(caseId);
    await page.goto(fixtureUrl, {waitUntil: 'domcontentloaded'});
    const physicalSelector = physicalSelectors.get(caseId);
    if (physicalSelector) {
      await page.locator(physicalSelector).click();
    } else if (!startupCases.has(caseId)) {
      await page.locator('[data-case="' + caseId + '"]').click();
    }

    // The filechooser event is emitted by Chrome; setFiles supplies deterministic oracle files.
    // A brief quiet period also lets zero-delay timers and a possible second open reach Playwright.
    await page.waitForTimeout(400);
    let completedOperations = 0;
    while (completedOperations < chooserOperations.length) {
      const pending = chooserOperations.slice(completedOperations);
      await Promise.all(pending);
      completedOperations = chooserOperations.length;
    }
    if (chooserOperations.length > 0) {
      await page.waitForFunction(() => {
        try {
          const result = JSON.parse(document.querySelector('#result').textContent);
          return result.events.some(event => event.type === 'change') &&
              result.files.length > 0;
        } catch (_) { return false; }
      }, undefined, {timeout: 4000}).catch(() => {});
    }
    await page.waitForTimeout(80);

    const fixtureResult = await readResult(page);
    const caseRequests = requests.slice(requestStart);
    return {
      caseId,
      invocation: startupCases.has(caseId) ? 'parser-startup' :
        physicalSelector ? 'trusted-physical-control-click' : 'trusted-visible-button',
      fixtureResult,
      filechoosers: chooserObservations,
      requests: caseRequests,
      pageErrors,
    };
  } finally {
    await context.close();
  }
}

try {
  const cases = [];
  for (const caseId of caseIds) cases.push(await runCase(caseId));

  const byId = Object.fromEntries(cases.map(item => [item.caseId, item]));
  assert.ok(byId['connected-click'].filechoosers.length >= 1,
    'Chrome should expose a filechooser for connected input.click().');
  assert.ok(byId.showPicker.filechoosers.length >= 1,
    'Chrome should expose a filechooser for input.showPicker().');
  assert.ok(byId['connected-click'].fixtureResult?.files?.length === 1,
    'The connected input case should receive the oracle file.');
  assert.deepEqual(byId['connected-click'].fixtureResult.files[0].bytes,
    Array.from(firstFile.buffer), 'The selected UTF-8 file bytes must remain exact.');
  assert.deepEqual(unexpectedLocalRequests, []);
  assert.deepEqual(blockedExternalRequests, []);
  assert.deepEqual(cases.flatMap(item => item.pageErrors), []);

  const evidence = {
    oracle: 'Local Google Chrome through Playwright Core filechooser events; loopback fixture only',
    browserVersion: browser.version(),
    browserExecutable,
    checkedAt: new Date().toISOString(),
    fixture: 'apps/android/integration_test/document_file_picker_fixture.dart#documentFilePickerFixture',
    fixtureSha256,
    runner: 'apps/android/tool/parity/verify_document_file_picker_browser.mjs',
    runnerSha256,
    loopbackOrigin: origin,
    payloads: [firstFile, secondFile].map(file => ({
      name: file.name,
      mimeType: file.mimeType,
      size: file.buffer.length,
      bytes: Array.from(file.buffer),
      sha256: sha256(file.buffer),
    })),
    lastModified: 'Not asserted: Playwright FileChooser.setFiles payloads do not expose a deterministic lastModified field.',
    cases,
    requests,
    unexpectedLocalRequests,
    blockedExternalRequests,
    knownDifferences: [
      'Selection is injected with Playwright FileChooser.setFiles after Chrome emits its real filechooser event; this is not a physical OS chooser dismissal or a user-cancel observation.',
      'The shared fixture records only authored inline display values because the Native runtime does not expose getComputedStyle; this runner separately observes Chrome computed display on each chooser control.',
      'Chrome 155 on this macOS host reports the .bin synthetic file as application/macbinary.',
    ],
  };
  const evidenceDirectory = path.join(
    repositoryRoot,
    'apps/android/build/parity-acceptance/document-file-picker-20261016',
  );
  await mkdir(evidenceDirectory, {recursive: true});
  const evidencePath = path.join(evidenceDirectory, 'browser-oracle.json');
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify({
    browserVersion: browser.version(),
    caseCount: cases.length,
    evidencePath,
    fixtureSha256,
    runnerSha256,
    cases: cases.map(item => ({
      caseId: item.caseId,
      invocation: item.invocation,
      chooserCount: item.filechoosers.length,
      chooserMultiple: item.filechoosers.map(chooser => chooser.isMultiple),
      setFilesSucceeded: item.filechoosers.map(chooser => chooser.setFilesSucceeded),
      eventTypes: item.fixtureResult?.events?.map(event => event.type) ?? [],
      eventTrusted: item.fixtureResult?.events?.filter(event => event.type === 'click')
        .map(event => event.isTrusted) ?? [],
      files: item.fixtureResult?.files?.map(file => ({name: file.name, type: file.type, size: file.size})) ?? [],
      attempts: item.fixtureResult?.attempts?.map(attempt => ({method: attempt.method, thrownName: attempt.thrownName})) ?? [],
    })),
  }, null, 2) + '\n');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(syntheticFilesDirectory, {recursive: true, force: true});
}
