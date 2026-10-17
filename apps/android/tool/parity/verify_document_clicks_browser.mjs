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
  'apps/android/integration_test/document_clicks_test.dart',
);
const fixtureSource = readFileSync(fixturePath, 'utf8');
const fixtureMatch = fixtureSource.match(
  /const clicksHtml\s*=\s*'''([\s\S]*?)''';/,
);
assert.ok(fixtureMatch, 'Could not extract clicksHtml from the integration test.');
const html = fixtureMatch[1];
const fixtureUrl = 'https://example.test/clicks';
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
});

try {
  const page = await browser.newPage();
  const blockedRequests = [];
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__clickOracleEvents = [];
    window.__clickOracleLinks = [];
    document.addEventListener('click', (event) => {
      const target = event.target;
      const anchor = target instanceof Element ? target.closest('a') : null;
      const record = {
        targetId: target instanceof Element ? target.id : '',
        defaultPreventedByPage: event.defaultPrevented,
      };
      window.__clickOracleEvents.push(record);
      if (!anchor) return;

      const link = {
        anchorId: anchor.id,
        targetId: record.targetId,
        href: anchor.getAttribute('href'),
        target: anchor.getAttribute('target') ?? '',
        download: anchor.getAttribute('download'),
        defaultPreventedByPage: event.defaultPrevented,
      };
      // Observe the browser's normal link event, then cancel navigation so the
      // fixture stays loaded for the rest of the checks.
      if (!event.defaultPrevented) event.preventDefault();
      link.defaultPreventedAfterHarness = event.defaultPrevented;
      window.__clickOracleLinks.push(link);
    });
  });

  let fixtureRequestCount = 0;
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
  await page.locator('#inline').click();
  assert.equal(await page.locator('#inline').textContent(), 'Inline 1');

  await page.locator('#bubble-target').click();
  assert.equal(
    await page.locator('#bubble-result').textContent(),
    'Bubble 1/1 target=bubble-target',
  );

  await page.locator('#delegated').click();
  assert.equal(await page.locator('#delegated-result').textContent(), 'Delegated 1');

  await page.locator('#once').click();
  assert.equal(await page.locator('#once').textContent(), 'Once 1');
  await page.locator('#once').click();
  assert.equal(await page.locator('#once').textContent(), 'Once 1');

  await page.locator('#removed').click();
  assert.equal(await page.locator('#removed-result').textContent(), 'Removed 0');

  const originalPageUrl = page.url();
  await page.locator('#prevented').click();
  assert.equal(await page.locator('#prevented-result').textContent(), 'Prevented');
  assert.equal(page.url(), originalPageUrl);

  await page.locator('#property').click();
  assert.equal(
    await page.locator('#property-result').textContent(),
    'Property 1; inline=0',
  );
  assert.equal(page.url(), originalPageUrl);

  await page.locator('#mutating').click();
  assert.equal(page.url(), originalPageUrl);
  await page.locator('#ordinary').click();
  assert.equal(page.url(), originalPageUrl);
  await page.locator('#image-target').click();
  assert.equal(await page.locator('#image-result').textContent(), 'Image target=image-target');
  assert.equal(page.url(), originalPageUrl);

  await page.locator('#button').click();
  assert.equal(await page.locator('#button-result').textContent(), 'Button 1');

  await page.locator('#label-target').click();
  assert.equal(await page.locator('#label-check').isChecked(), true);
  assert.equal(await page.locator('#label-state').textContent(), 'Checkbox checked=true');
  assert.equal(await page.locator('#label-change').textContent(), 'Label change checked=true');

  await page.locator('#summary-target').click();
  assert.equal(await page.locator('#details').evaluate((details) => details.open), true);
  await page.locator('#summary-target').click();
  assert.equal(await page.locator('#details').evaluate((details) => details.open), false);

  await page.locator('#prevent-summary').click();
  assert.equal(await page.locator('#prevent-summary-result').textContent(), 'Summary prevented');
  assert.equal(
    await page.locator('#prevent-details').evaluate((details) => details.open),
    false,
  );

  const linkClicks = await page.evaluate(() => window.__clickOracleLinks);
  const clickEvents = await page.evaluate(() => window.__clickOracleEvents);
  const linksById = Object.fromEntries(
    linkClicks.map((link) => [link.anchorId, link]),
  );
  assert.equal(linksById.prevented.defaultPreventedByPage, true);
  assert.equal(linksById.prevented.href, '/must-not-navigate');
  assert.equal(linksById.property.defaultPreventedByPage, true);
  assert.equal(linksById.property.href, '/must-not-navigate-property');
  assert.equal(linksById.mutating.href, '/new');
  assert.equal(linksById.mutating.target, '_blank');
  assert.equal(linksById.mutating.download, 'new.txt');
  assert.equal(linksById.mutating.defaultPreventedByPage, false);
  assert.equal(linksById.mutating.defaultPreventedAfterHarness, true);
  assert.equal(linksById.ordinary.href, '/ordinary');
  assert.equal(linksById.ordinary.defaultPreventedByPage, false);
  assert.equal(linksById['image-link'].targetId, 'image-target');
  assert.equal(linksById['image-link'].href, '/image');
  for (const anchorId of ['prevented', 'property', 'mutating', 'ordinary', 'image-link']) {
    assert.equal(
      linkClicks.filter((link) => link.anchorId === anchorId).length,
      1,
      `${anchorId} should dispatch one link click.`,
    );
  }
  for (const targetId of ['inline', 'bubble-target', 'delegated', 'once', 'removed', 'property', 'button']) {
    assert.equal(
      clickEvents.filter((event) => event.targetId === targetId).length,
      targetId === 'once' ? 2 : 1,
      `${targetId} click count did not match the fixture actions.`,
    );
  }
  for (const [targetId, expectedCount] of [
    ['label-target', 1],
    ['summary-target', 2],
    ['prevent-summary', 1],
  ]) {
    assert.equal(
      clickEvents.filter((event) => event.targetId === targetId).length,
      expectedCount,
      `${targetId} click count did not match the fixture actions.`,
    );
  }
  assert.equal(await page.locator('#once').textContent(), 'Once 1');
  assert.equal(fixtureRequestCount, 1);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedRequests, [], 'No request escaped the local fixture route.');

  const result = {
    oracle: 'Chromium through local Playwright Core',
    browserVersion: browser.version(),
    checkedAt: new Date().toISOString(),
    source: 'apps/android/integration_test/document_clicks_test.dart',
    fixture: 'clicksHtml (extracted directly from source)',
    assertions: {
      inlineClick: await page.locator('#inline').textContent(),
      bubbling: await page.locator('#bubble-result').textContent(),
      documentDelegation: await page.locator('#delegated-result').textContent(),
      onceListener: await page.locator('#once').textContent(),
      removedListener: await page.locator('#removed-result').textContent(),
      preventedAnchor: {
        label: await page.locator('#prevented-result').textContent(),
        linkEvent: linksById.prevented,
      },
      onclickProperty: {
        result: await page.locator('#property-result').textContent(),
        linkEvent: linksById.property,
      },
      mutatedLink: linksById.mutating,
      ordinaryLink: linksById.ordinary,
      imageLink: {
        label: await page.locator('#image-result').textContent(),
        click: linksById['image-link'],
      },
      buttonClick: await page.locator('#button-result').textContent(),
      labelDefaultAction: {
        checked: await page.locator('#label-check').isChecked(),
        state: await page.locator('#label-state').textContent(),
        change: await page.locator('#label-change').textContent(),
      },
      summaryDefaultAction: {
        finalOpen: await page.locator('#details').evaluate((details) => details.open),
        preventedLabel: await page.locator('#prevent-summary-result').textContent(),
        preventedDetailsOpen: await page
          .locator('#prevent-details')
          .evaluate((details) => details.open),
      },
      clickEvents,
      fixtureRequestCount,
      blockedExternalRequestCount: blockedRequests.length,
      blockedRequests,
      pageErrors,
      finalUrl: page.url(),
    },
  };
  const outputPath = path.join(
    repositoryRoot,
    'apps/android/build/parity-acceptance/document-clicks-20261015/browser-oracle.json',
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
}
