import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const require = createRequire(import.meta.url);
const gatewayDirectory = path.join(repositoryRoot, 'apps/gateway');
const { chromium } = require(
  require.resolve('playwright-core', { paths: [gatewayDirectory] }),
);
const browserExecutable = [
  requireTestBrowserExecutable(),
  chromium.executablePath(),
].find(existsSync);
if (browserExecutable == null) {
  throw new Error('No local Chromium or Chrome executable is available.');
}

const fixturePath = path.join(
  repositoryRoot,
  'apps/android/integration_test/document_reset_files_test.dart',
);
const fixtureSource = readFileSync(fixturePath, 'utf8');
const fixtureMatch = fixtureSource.match(
  /const resetFilesHtml\s*=\s*'''([\s\S]*?)''';/,
);
assert.ok(
  fixtureMatch,
  'Could not extract resetFilesHtml from the integration test.',
);
const html = fixtureMatch[1];
const fixtureUrl = 'https://example.test/reset';
const sendUrl = 'https://example.test/send';
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
});

try {
  const page = await browser.newPage();
  const blockedRequests = [];
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let submittedRequest;
  let resolveSendCapture;
  const sendCaptured = new Promise((resolve) => {
    resolveSendCapture = resolve;
  });

  // All traffic is local. The intercepted POST is fulfilled with 204 so the
  // browser keeps the document alive for the reset checks that follow.
  await page.route('**/*', async (route) => {
    blockedRequests.push(route.request().url());
    await route.abort();
  });
  await page.route(fixtureUrl, async (route) => {
    assert.equal(route.request().method(), 'GET');
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: html,
    });
  });
  await page.route(/^https:\/\/example\.test\/send(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const body = request.postDataBuffer();
    submittedRequest = {
      method: request.method(),
      url: request.url(),
      contentType: request.headers()['content-type'],
      bodyBase64: body?.toString('base64') ?? null,
      bodyText: body?.toString('latin1') ?? null,
    };
    resolveSendCapture(submittedRequest);
    await route.fulfill({ status: 204, body: '' });
  });

  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  const formResetPropertyType = await page
    .locator('#form')
    .evaluate((form) => typeof form.reset);
  assert.equal(formResetPropertyType, 'function');
  assert.equal(await page.locator('#query').inputValue(), 'Initial');
  assert.equal(await page.locator('#upload').evaluate((field) => field.files.length), 0);

  await page.locator('#query').fill('Edited');
  await page.locator('#upload').setInputFiles({
    name: 'report.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('ABC'),
  });
  const selectionLabel = await page.locator('#selection').textContent();
  assert.equal(selectionLabel, 'Selected: report.txt / 3');

  await page.getByRole('button', { name: 'Update page' }).click();
  const revisionLabel = await page.locator('#revision').textContent();
  const valueAfterUpdate = await page.locator('#query').inputValue();
  const fileCountAfterUpdate = await page
    .locator('#upload')
    .evaluate((field) => field.files.length);
  assert.equal(revisionLabel, 'Revision 1');
  assert.equal(valueAfterUpdate, 'Edited');
  assert.equal(fileCountAfterUpdate, 1);

  const sendRequestObserved = page.waitForRequest((request) => request.url() === sendUrl);
  await page.getByRole('button', { name: 'Send' }).click({ noWaitAfter: true });
  await sendRequestObserved;
  await sendCaptured;
  assert.ok(
    submittedRequest,
    `Send must produce an intercepted request; blocked=${blockedRequests.join(', ')}`,
  );
  assert.equal(submittedRequest.method, 'POST');
  assert.match(submittedRequest.contentType ?? '', /^multipart\/form-data;\s*boundary=/i);
  const body = Buffer.from(submittedRequest.bodyBase64 ?? '', 'base64');
  const bodyText = body.toString('latin1');
  assert.match(bodyText, /Content-Disposition: form-data; name="query"\r\n\r\nEdited\r\n/);
  assert.match(
    bodyText,
    /Content-Disposition: form-data; name="upload"; filename="report\.txt"\r\nContent-Type: text\/plain\r\n\r\nABC\r\n/,
  );
  assert.equal(await page.locator('#query').inputValue(), 'Edited');

  await page.getByRole('button', { name: 'Cancel next reset' }).click();
  const cancelLabel = await page.locator('#resetResult').textContent();
  assert.equal(cancelLabel, 'Will cancel');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  const canceledResetLabel = await page.locator('#resetResult').textContent();
  const valueAfterCanceledReset = await page.locator('#query').inputValue();
  const fileCountAfterCanceledReset = await page
    .locator('#upload')
    .evaluate((field) => field.files.length);
  assert.equal(canceledResetLabel, 'Canceled: Edited');
  assert.equal(valueAfterCanceledReset, 'Edited');
  assert.equal(fileCountAfterCanceledReset, 1);

  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  const nativeResetLabel = await page.locator('#resetResult').textContent();
  const valueAfterNativeReset = await page.locator('#query').inputValue();
  const fileCountAfterNativeReset = await page
    .locator('#upload')
    .evaluate((field) => field.files.length);
  assert.equal(nativeResetLabel, 'Reset from: Edited');
  assert.equal(valueAfterNativeReset, 'Initial');
  assert.equal(fileCountAfterNativeReset, 0);

  await page.locator('#query').fill('Second');
  await page.locator('#upload').setInputFiles({
    name: 'report.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('ABC'),
  });
  await page.getByRole('button', { name: 'Script reset' }).click();
  const scriptedResetLabel = await page.locator('#resetResult').textContent();
  const valueAfterScriptReset = await page.locator('#query').inputValue();
  const fileCountAfterScriptReset = await page
    .locator('#upload')
    .evaluate((field) => field.files.length);
  assert.equal(scriptedResetLabel, 'Reset from: Second');
  assert.equal(valueAfterScriptReset, 'Initial');
  assert.equal(fileCountAfterScriptReset, 0);
  assert.deepEqual(pageErrors, []);

  await page.locator('#upload').setInputFiles({
    name: 'report.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('ABC'),
  });
  await page.getByRole('button', { name: 'Clear file' }).click();
  const fileCountAfterClear = await page
    .locator('#upload')
    .evaluate((field) => field.files.length);
  assert.equal(fileCountAfterClear, 0);
  assert.deepEqual(blockedRequests, [], 'No browser request escaped the local routes.');

  const result = {
    oracle: 'Chromium through local Playwright Core',
    browserVersion: browser.version(),
    checkedAt: new Date().toISOString(),
    source: 'apps/android/integration_test/document_reset_files_test.dart',
    fixture: 'resetFilesHtml (extracted directly from source)',
    assertions: {
      selectedFile: selectionLabel,
      dynamicUpdate: {
        revision: revisionLabel,
        value: valueAfterUpdate,
        fileCount: fileCountAfterUpdate,
      },
      multipartSend: {
        ...submittedRequest,
        includesQueryEdited: bodyText.includes('name="query"\r\n\r\nEdited'),
        includesReportFile: bodyText.includes('filename="report.txt"'),
        includesTextPlain: bodyText.includes('Content-Type: text/plain'),
        fileBytes: 'ABC',
      },
      canceledReset: {
        label: canceledResetLabel,
        value: valueAfterCanceledReset,
        fileCount: fileCountAfterCanceledReset,
      },
      nativeReset: {
        label: nativeResetLabel,
        value: valueAfterNativeReset,
        fileCount: fileCountAfterNativeReset,
      },
      scriptReset: {
        formResetPropertyType,
        pageErrors,
        label: scriptedResetLabel,
        value: valueAfterScriptReset,
        fileCount: fileCountAfterScriptReset,
        fixtureNote:
          'The oracle initially exposed that id="reset" shadows HTMLFormElement.reset in Chromium; the fixture now uses id="reset-button".',
      },
      clearFileCount: fileCountAfterClear,
      blockedExternalRequestCount: blockedRequests.length,
    },
  };
  const outputPath = path.join(
    repositoryRoot,
    'apps/android/build/parity-acceptance/document-reset-files-20261015/browser-oracle.json',
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
}
