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
  'apps/android/integration_test/document_script_navigation_test.dart',
);
const fixtureSource = readFileSync(fixturePath, 'utf8');
const fixtureMatch = fixtureSource.match(
  /const scriptNavigationHtml\s*=\s*'''([\s\S]*?)''';/,
);
assert.ok(
  fixtureMatch,
  'Could not extract scriptNavigationHtml from the integration test.',
);
const html = fixtureMatch[1];
const origin = 'https://example.test';
const fixtureUrl = `${origin}/script-navigation`;
const localPaths = new Set([
  '/script-navigation',
  '/nav-href',
  '/nav-assigned',
  '/nav-replaced',
  '/post-response',
  '/blank-child',
]);
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
  ignoreDefaultArgs: ['--disable-popup-blocking'],
});

try {
  const context = await browser.newContext();
  const requests = [];
  const blockedRequests = [];
  const pageErrors = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      blockedRequests.push(request.url());
      await route.abort();
      return;
    }
    if (url.pathname === '/favicon.ico') {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (!localPaths.has(url.pathname)) {
      blockedRequests.push(request.url());
      await route.abort();
      return;
    }
    requests.push({
      path: url.pathname,
      method: request.method(),
      url: request.url(),
      body: request.postData(),
    });
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: html,
    });
  });

  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (expected) => document.querySelector('#where')?.textContent === `loaded:${expected}`,
    fixtureUrl,
  );
  await page.waitForTimeout(80);
  assert.equal(context.pages().length, 1, 'startup popup is blocked');
  assert.equal(
    requests.some((request) => request.path === '/startup-popup'),
    false,
    'startup window.open produces no document request',
  );

  const initialHistoryLength = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: 'Navigate with href', exact: true }).click();
  await page.waitForURL(`${origin}/nav-href`);
  assert.equal(
    await page.evaluate(() => history.length),
    initialHistoryLength + 1,
    'href assignment appends a history entry',
  );

  const hrefHistoryLength = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: 'Navigate with assign', exact: true }).click();
  await page.waitForURL(`${origin}/nav-assigned`);
  assert.equal(
    await page.evaluate(() => history.length),
    hrefHistoryLength + 1,
    'location.assign appends a history entry',
  );

  const assignedHistoryLength = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: 'Replace current page', exact: true }).click();
  await page.waitForURL(`${origin}/nav-replaced`);
  assert.equal(
    await page.evaluate(() => history.length),
    assignedHistoryLength,
    'location.replace reuses the current history entry',
  );

  await page.getByRole('button', { name: 'Set fragment', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#fragment');
  await page.waitForFunction(
    (expected) => document.querySelector('#where')?.textContent === expected,
    `hashchange:${origin}/nav-replaced#fragment|#fragment`,
  );
  assert.equal(
    await page.locator('#where').textContent(),
    `hashchange:${origin}/nav-replaced#fragment|#fragment`,
    'hashchange observes the new location getters',
  );
  const hashHistoryLength = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: 'Set fragment', exact: true }).click();
  await page.waitForTimeout(80);
  assert.equal(
    await page.evaluate(() => history.length),
    hashHistoryLength,
    'assigning the same hash does not create duplicate history',
  );

  await page.getByRole('button', { name: 'Clear fragment', exact: true }).click();
  await page.waitForFunction(() => location.hash === '');
  await page.waitForFunction(
    (expected) => document.querySelector('#where')?.textContent === expected,
    `hashchange:${origin}/nav-replaced#|`,
  );
  assert.equal(
    await page.locator('#where').textContent(),
    `hashchange:${origin}/nav-replaced#|`,
    'clearing the hash synchronizes URL getters before hashchange',
  );
  const fragmentHistoryLength = await page.evaluate(() => history.length);
  assert.equal(fragmentHistoryLength, hashHistoryLength + 1);

  await page.evaluate(() => history.back());
  await page.waitForFunction(() => location.hash === '#fragment');
  await page.waitForFunction(
    (expected) => document.querySelector('#where')?.textContent === expected,
    `hashchange:${origin}/nav-replaced#fragment|#fragment`,
  );
  assert.equal(
    await page.locator('#where').textContent(),
    `hashchange:${origin}/nav-replaced#fragment|#fragment`,
  );
  await page.evaluate(() => history.back());
  await page.waitForFunction(() => location.hash === '');
  await page.waitForFunction(
    (expected) => document.querySelector('#where')?.textContent === expected,
    `hashchange:${origin}/nav-replaced|`,
  );
  assert.equal(page.url(), `${origin}/nav-replaced`);
  assert.equal(
    await page.locator('#where').textContent(),
    `hashchange:${origin}/nav-replaced|`,
    'back updates the location getter before hashchange',
  );
  assert.equal(await page.evaluate(() => history.length), fragmentHistoryLength);

  const beforeReloadCount = requests.filter(
    (request) => request.path === '/nav-replaced' && request.method === 'GET',
  ).length;
  const beforeReloadHistoryLength = await page.evaluate(() => history.length);
  const reloadNavigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Reload from script', exact: true }).click();
  await reloadNavigation;
  assert.equal(page.url(), `${origin}/nav-replaced`);
  assert.equal(
    requests.filter(
      (request) => request.path === '/nav-replaced' && request.method === 'GET',
    ).length,
    beforeReloadCount + 1,
    'location.reload performs a fresh local request',
  );
  assert.equal(
    await page.evaluate(() => history.length),
    beforeReloadHistoryLength,
    'location.reload does not append history',
  );

  const postNavigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Submit POST response', exact: true }).click();
  await postNavigation;
  assert.equal(page.url(), `${origin}/post-response`);
  const postRequest = requests.find(
    (request) => request.path === '/post-response' && request.method === 'POST',
  );
  assert.ok(postRequest, 'native form control makes one real browser POST');
  assert.equal(postRequest.body, 'value=posted');

  const popupPromise = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open new window', exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  assert.equal(popup.url(), `${origin}/blank-child`);
  assert.equal(context.pages().length, 2, 'trusted _blank opens its own page');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedRequests, [], 'no browser request escaped local routes');

  const result = {
    oracle: 'Chromium through local Playwright Core',
    browserVersion: browser.version(),
    checkedAt: new Date().toISOString(),
    source: 'apps/android/integration_test/document_script_navigation_test.dart',
    fixture: 'scriptNavigationHtml (extracted directly from source)',
    assertions: {
      startupPopupBlocked: {
        pageCountBeforeTrustedClick: 1,
        startupPopupRequests: requests.filter(
          (request) => request.path === '/startup-popup',
        ).length,
      },
      hrefAssignment: {
        url: `${origin}/nav-href`,
        historyLength: hrefHistoryLength,
      },
      locationAssign: {
        url: `${origin}/nav-assigned`,
        historyLength: assignedHistoryLength,
      },
      locationReplace: {
        url: `${origin}/nav-replaced`,
        historyLength: assignedHistoryLength,
      },
      hashAndBack: {
        fragmentText: `hashchange:${origin}/nav-replaced#fragment|#fragment`,
        backText: `hashchange:${origin}/nav-replaced|`,
        sameHashHistoryLength: hashHistoryLength,
        historyLength: fragmentHistoryLength,
      },
      reload: {
        path: '/nav-replaced',
        requestCount: requests.filter(
          (request) => request.path === '/nav-replaced' && request.method === 'GET',
        ).length,
        historyLength: beforeReloadHistoryLength,
      },
      postForm: postRequest,
      trustedBlankWindow: {
        url: popup.url(),
        pageCount: context.pages().length,
      },
      documentRequests: requests,
      pageErrors,
      blockedExternalRequests: blockedRequests,
    },
  };
  const outputPath = path.join(
    repositoryRoot,
    'apps/android/build/parity-acceptance/document-script-navigation-20261015/browser-oracle.json',
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  await context.close();
} finally {
  await browser.close();
}
