import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const fixturePath = path.join(repositoryRoot, 'apps/android/integration_test/document_file_reader_fixture.dart');
const fixtureSource = readFileSync(fixturePath, 'utf8');
const htmlMatch = fixtureSource.match(/const fileReaderHtml\s*=\s*r'''([\s\S]*?)''';/);
assert.ok(htmlMatch, 'Could not extract fileReaderHtml from the shared fixture.');
const html = htmlMatch[1];
const expectedMatch = fixtureSource.match(/const fileReaderExpectedJson\s*=\s*r'''([\s\S]*?)''';/);
assert.ok(expectedMatch, 'Could not extract fileReaderExpectedJson.');
const expected = JSON.parse(expectedMatch[1]);
const browserExecutable = requireTestBrowserExecutable();
assert.ok(existsSync(browserExecutable), 'Missing Chrome executable: ' + browserExecutable);
assert.ok(expected.programmatic?.busyRead && expected.selected?.reads, 'Shared Chrome expectations must be frozen before verification.');

const requests = [];
const unexpectedLocalRequests = [];
const blockedThirdPartyRequests = [];
const serverErrors = [];
let origin = '';
const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
  requests.push({method: request.method, path: requestUrl.pathname});
  if (request.method === 'GET' && requestUrl.pathname === '/fixture') {
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
    response.end(html);
    return;
  }
  if (request.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  unexpectedLocalRequests.push({method: request.method, path: requestUrl.pathname});
  response.writeHead(404, {'content-type': 'text/plain'});
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

const evidenceDirectory = path.join(
  repositoryRoot,
  'apps/android/build/parity-acceptance/document-file-reader-20261015',
);
const evidencePath = path.join(evidenceDirectory, 'browser-oracle.json');

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
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
  await page.locator('#selected-file').setInputFiles({
    name: 'selected.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([0, 127, 128, 255, 13, 10]),
  });
  await page.getByRole('button', {name: 'Read selected file'}).click();
  await page.waitForFunction(() => {
    const text = document.querySelector('#file-reader-result')?.textContent ?? '';
    try { return !!JSON.parse(text).reads && !JSON.parse(text).busyRead; } catch (_) { return false; }
  }, undefined, {timeout: 15000});
  const selected = JSON.parse(await page.locator('#file-reader-result').textContent());

  await page.getByRole('button', {name: 'Read programmatic files'}).click();
  await page.waitForFunction(() => {
    const text = document.querySelector('#file-reader-result')?.textContent ?? '';
    try { return !!JSON.parse(text).busyRead; } catch (_) { return false; }
  }, undefined, {timeout: 20000});
  const programmatic = JSON.parse(await page.locator('#file-reader-result').textContent());
  const observed = {programmatic, selected};

  assert.deepEqual(pageErrors, [], 'Fixture reported browser page errors.');
  assert.deepEqual(blockedThirdPartyRequests, [], 'Fixture attempted a third-party request.');
  assert.deepEqual(unexpectedLocalRequests, [], 'Fixture attempted an unexpected loopback request.');
  assert.deepEqual(requests.filter(item => item.path === '/fixture').length, 1);

  assert.deepEqual(observed, expected, 'Chrome observation differs from frozen shared expected JSON.');
  const assertions = 'PASS: Chrome observed JSON exactly matches shared expected JSON';
  const evidence = {
    browser: 'Google Chrome ' + browser.version(),
    date: '2026-10-15',
    origin,
    network: {
      allowedRequests: requests,
      unexpectedLocalRequests,
      blockedThirdPartyRequests,
    },
    selectedFile: {
      name: 'selected.bin',
      mimeType: 'application/octet-stream',
      bytes: [0, 127, 128, 255, 13, 10],
    },
    assertions,
    expected,
    observed,
    pageErrors,
    serverErrors,
  };
  await mkdir(evidenceDirectory, {recursive: true});
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({assertions, evidencePath, browser: evidence.browser}));
} catch (error) {
  serverErrors.push(String(error && error.stack || error));
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
