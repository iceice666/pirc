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
  'apps/android/integration_test/document_checkable_clicks_test.dart',
);
const fixtureSource = readFileSync(fixturePath, 'utf8');
const fixtureMatch = fixtureSource.match(
  /const checkableClicksHtml\s*=\s*'''([\s\S]*?)''';/,
);
assert.ok(
  fixtureMatch,
  'Could not extract checkableClicksHtml from the integration test.',
);
const html = fixtureMatch[1];
const fixtureUrl = 'https://example.test/checkable-clicks';
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
});

try {
  const page = await browser.newPage();
  const blockedRequests = [];
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (request.url() === fixtureUrl && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: html,
      });
      return;
    }
    blockedRequests.push(request.url());
    await route.abort();
  });

  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#normal').click();
  assert.match(
    await page.locator('#result').textContent(),
    /normal=\[click:true,input:true,change:true\]/,
  );
  assert.equal(await page.locator('#normal').isChecked(), true);

  await page.locator('#cancelled').click();
  assert.match(
    await page.locator('#result').textContent(),
    /cancelled=\[click:true\]/,
  );
  assert.equal(await page.locator('#cancelled').isChecked(), false);

  await page.locator('#mutated').click();
  assert.match(
    await page.locator('#result').textContent(),
    /mutated=\[click:true,input:false,change:false\]/,
  );
  assert.equal(await page.locator('#mutated').isChecked(), false);

  await page.locator('#radio-two').click();
  assert.match(
    await page.locator('#result').textContent(),
    /radio-two=\[click:true,input:true,change:true\]/,
  );
  assert.equal(await page.locator('#radio-one').isChecked(), false);
  assert.equal(await page.locator('#radio-two').isChecked(), true);
  await page.locator('#radio-two').click();
  assert.match(
    await page.locator('#result').textContent(),
    /radio-two=\[click:true,input:true,change:true,click:true\]/,
  );

  await page.locator('#radio-cancel-two').click();
  assert.match(
    await page.locator('#result').textContent(),
    /cancel-radio-two=\[click:true\]/,
  );
  assert.equal(await page.locator('#radio-cancel-one').isChecked(), true);
  assert.equal(await page.locator('#radio-cancel-two').isChecked(), false);

  await page.locator('#label-target').click();
  assert.match(
    await page.locator('#result').textContent(),
    /label=\[click:span,click:true,input:true,change:true\]/,
  );
  assert.equal(await page.locator('#label-check').isChecked(), true);

  await page.locator('#disabled').evaluate((input) => input.click());
  assert.match(
    await page.locator('#result').textContent(),
    /disabled=\[\]/,
  );
  assert.equal(await page.locator('#disabled').isChecked(), false);

  await page.locator('#rapid').click();
  await page.locator('#rapid').click();
  assert.match(
    await page.locator('#result').textContent(),
    /rapid=\[click:true,input:true,change:true,click:false,input:false,change:false\]/,
  );
  assert.equal(await page.locator('#rapid').isChecked(), false);

  const resultText = await page.locator('#result').textContent();
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedRequests, [], 'No browser request escaped the local fixture route.');

  const result = {
    oracle: 'Chromium through local Playwright Core',
    browserVersion: browser.version(),
    checkedAt: new Date().toISOString(),
    source: 'apps/android/integration_test/document_checkable_clicks_test.dart',
    fixture: 'checkableClicksHtml (extracted directly from source)',
    assertions: {
      resultText,
      checkedness: {
        normal: await page.locator('#normal').isChecked(),
        cancelled: await page.locator('#cancelled').isChecked(),
        mutated: await page.locator('#mutated').isChecked(),
        radioOne: await page.locator('#radio-one').isChecked(),
        radioTwo: await page.locator('#radio-two').isChecked(),
        cancelRadioOne: await page.locator('#radio-cancel-one').isChecked(),
        cancelRadioTwo: await page.locator('#radio-cancel-two').isChecked(),
        label: await page.locator('#label-check').isChecked(),
        disabled: await page.locator('#disabled').isChecked(),
        rapid: await page.locator('#rapid').isChecked(),
      },
      pageErrors,
      blockedExternalRequestCount: blockedRequests.length,
      blockedRequests,
      finalUrl: page.url(),
    },
  };
  const outputPath = path.join(
    repositoryRoot,
    'apps/android/build/parity-acceptance/document-checkable-clicks-20261015/browser-oracle.json',
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
}
