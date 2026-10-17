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
  'apps/android/integration_test/document_form_events_test.dart',
);
const fixtureSource = readFileSync(fixturePath, 'utf8');
const fixtureMatch = fixtureSource.match(
  /const formEventsHtml\s*=\s*'''([\s\S]*?)''';/,
);
assert.ok(fixtureMatch, 'Could not extract formEventsHtml from the integration test.');
const html = fixtureMatch[1];
const fixtureUrl = 'https://example.test/form';
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
});

try {
  const page = await browser.newPage();
  const submittedRequests = [];
  const blockedRequests = [];

  // All browser traffic is fulfilled locally or aborted; the fixture never
  // reaches the public network.
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
  await page.route(/^https:\/\/example\.test\/changed(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const params = url.searchParams;
    submittedRequests.push({
      method: request.method(),
      url: url.href,
      query: params.get('query'),
      intent: params.get('intent'),
      entries: Array.from(params.entries()),
    });
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>Submitted</title><p>Request received</p>',
    });
  });

  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#echo').textContent(), 'Waiting');
  assert.equal(await page.locator('#committed').textContent(), 'No change');
  assert.equal(await page.locator('#submitted').textContent(), 'No submit');

  // Required validation blocks submission before the submit listener runs.
  await page.getByRole('button', { name: 'Preview' }).click();
  assert.equal(await page.locator('#query').evaluate((field) => field.validity.valueMissing), true);
  assert.equal(await page.locator('#submitted').textContent(), 'No submit');
  assert.equal(submittedRequests.length, 0);

  await page.locator('#query').fill('ab漢');
  const inputLabel = await page.locator('#echo').textContent();
  assert.equal(inputLabel, 'Input: ab漢 / false');

  await page.locator('#query').blur();
  const textChangeLabel = await page.locator('#committed').textContent();
  assert.equal(textChangeLabel, 'Changed: query');

  await page.locator('#enabled').check();
  const checkboxInputLabel = await page.locator('#echo').textContent();
  const checkboxChangeLabel = await page.locator('#committed').textContent();
  assert.equal(checkboxInputLabel, 'Input: ab漢 / true');
  assert.equal(checkboxChangeLabel, 'Changed: enabled');

  await page.getByRole('button', { name: 'Preview' }).click();
  const previewLabel = await page.locator('#submitted').textContent();
  assert.equal(previewLabel, 'Preview: ab漢');
  assert.equal(submittedRequests.length, 0, 'Preview must prevent the default form submission.');

  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForURL((url) => url.pathname === '/changed');
  assert.equal(submittedRequests.length, 1, 'Send must produce exactly one request.');
  assert.equal(submittedRequests[0].method, 'GET');
  assert.equal(submittedRequests[0].query, 'server:ab漢');
  assert.equal(submittedRequests[0].intent, 'send');
  assert.equal(blockedRequests.length, 0, 'No browser request escaped the local routes.');

  const result = {
    oracle: 'Chromium through local Playwright Core',
    browserVersion: browser.version(),
    checkedAt: new Date().toISOString(),
    source: 'apps/android/integration_test/document_form_events_test.dart',
    fixture: 'formEventsHtml (extracted directly from source)',
    assertions: {
      requiredEmptySubmit: {
        valueMissing: true,
        submittedLabel: 'No submit',
        interceptedSubmissionCount: 0,
      },
      inputLabel,
      textChangeLabel,
      checkboxInputLabel,
      checkboxChangeLabel,
      preview: {
        label: previewLabel,
        interceptedSubmissionCountBeforeSend: 0,
      },
      send: {
        interceptedSubmissionCount: submittedRequests.length,
        request: submittedRequests[0],
      },
      blockedExternalRequestCount: blockedRequests.length,
    },
  };
  const outputPath = path.join(
    repositoryRoot,
    'apps/android/build/parity-acceptance/document-form-events-20261015/browser-oracle.json',
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
}
