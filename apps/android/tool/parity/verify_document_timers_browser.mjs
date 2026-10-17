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
  'apps/android/integration_test/document_timers_test.dart',
);
const fixtureSource = readFileSync(fixturePath, 'utf8');
const fixtureMatch = fixtureSource.match(
  /const timersHtml\s*=\s*'''([\s\S]*?)''';/,
);
assert.ok(
  fixtureMatch,
  'Could not extract timersHtml from the integration test.',
);
const html = fixtureMatch[1];
const fixtureUrl = 'https://example.test/timers';
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
});

try {
  const page = await browser.newPage();
  const blockedRequests = [];
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let fixtureRequestCount = 0;

  // The page is served from the extracted fixture; every other request is blocked.
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (request.url() === fixtureUrl && request.method() === 'GET') {
      fixtureRequestCount++;
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
  await page.waitForFunction(
    () =>
      document.querySelector('#timeout')?.textContent === 'Timeout done' &&
      document.querySelector('#interval')?.textContent === 'Interval 3' &&
      document.querySelector('#frames')?.textContent === 'Frames 3' &&
      document.querySelector('#microtask')?.textContent ===
        'Microtask timer done' &&
      document.querySelector('#clock')?.textContent === 'Clock monotonic',
    null,
    { timeout: 10_000 },
  );

  const startup = {
    timeout: await page.locator('#timeout').textContent(),
    interval: await page.locator('#interval').textContent(),
    frames: await page.locator('#frames').textContent(),
    microtask: await page.locator('#microtask').textContent(),
    clock: await page.locator('#clock').textContent(),
    canceled: await page.locator('#canceled').textContent(),
  };
  assert.deepEqual(startup, {
    timeout: 'Timeout done',
    interval: 'Interval 3',
    frames: 'Frames 3',
    microtask: 'Microtask timer done',
    clock: 'Clock monotonic',
    canceled: 'Canceled work stayed canceled',
  });

  await page.locator('#entry').fill('原生輸入');
  const nativeInput = await page.locator('#entry').inputValue();
  assert.equal(nativeInput, '原生輸入');
  await page.getByRole('button', { name: 'Start delayed update' }).click();
  await page.waitForFunction(
    () => document.querySelector('#result')?.textContent === 'Delayed: 原生輸入',
    null,
    { timeout: 5_000 },
  );
  const delayedResult = await page.locator('#result').textContent();

  await page.waitForTimeout(200);
  const settled = {
    interval: await page.locator('#interval').textContent(),
    frames: await page.locator('#frames').textContent(),
    canceled: await page.locator('#canceled').textContent(),
  };
  assert.deepEqual(settled, {
    interval: 'Interval 3',
    frames: 'Frames 3',
    canceled: 'Canceled work stayed canceled',
  });
  assert.equal(fixtureRequestCount, 1);
  assert.deepEqual(blockedRequests, [], 'No request escaped the local fixture route.');
  assert.deepEqual(pageErrors, []);

  const result = {
    oracle: 'Chromium through local Playwright Core',
    browserVersion: browser.version(),
    checkedAt: new Date().toISOString(),
    source: 'apps/android/integration_test/document_timers_test.dart',
    fixture: 'timersHtml (extracted directly from source)',
    assertions: {
      startup,
      nativeInput,
      delayedResult,
      settledAfter200ms: settled,
      fixtureRequestCount,
      blockedExternalRequestCount: blockedRequests.length,
      blockedRequests,
      pageErrors,
    },
  };
  const outputPath = path.join(
    repositoryRoot,
    'apps/android/build/parity-acceptance/document-timers-20261015/browser-oracle.json',
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
}
