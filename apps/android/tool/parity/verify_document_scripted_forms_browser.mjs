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
  'apps/android/integration_test/document_scripted_forms_test.dart',
);
const fixtureSource = readFileSync(fixturePath, 'utf8');
const fixtureMatch = fixtureSource.match(
  /const scriptedFormsHtml\s*=\s*'''([\s\S]*?)''';/,
);
assert.ok(
  fixtureMatch,
  'Could not extract scriptedFormsHtml from the integration test.',
);
const html = fixtureMatch[1];
const fixtureUrl = 'https://example.test/scripted-forms';
const submissionPaths = new Set([
  '/programmatic',
  '/sync',
  '/invalid',
  '/cancel',
  '/novalidate',
  '/base',
  '/override',
  '/errors',
  '/double',
  '/button-submit',
  '/button-request',
]);
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
});

try {
  const page = await browser.newPage();
  const submissions = [];
  const blockedRequests = [];
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // Keep every request local. Form submissions are intercepted at the network
  // boundary, recorded, and fulfilled with 204 so their target iframes stay put.
  await page.route('**/*', async (route) => {
    blockedRequests.push(route.request().url());
    await route.abort();
  });
  await page.route('https://example.test/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/scripted-forms' && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: html,
      });
      return;
    }

    if (!submissionPaths.has(url.pathname)) {
      blockedRequests.push(request.url());
      await route.abort();
      return;
    }

    let frameName = '';
    try {
      frameName = request.frame().name();
    } catch {
      // The request remains recorded even if Chromium has detached its frame.
    }
    const body = request.postDataBuffer();
    submissions.push({
      path: url.pathname,
      method: request.method(),
      url: url.href,
      query: Array.from(url.searchParams.entries()),
      contentType: request.headers()['content-type'] ?? null,
      bodyText: body?.toString('utf8') ?? null,
      frameName,
    });
    await route.fulfill({ status: 204, body: '' });
  });

  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#direct-events').textContent(), 'invalid=0,submit=0');
  assert.equal(await page.locator('#sync-order').textContent(), 'idle');

  async function clickAndCapture(label, expectedPath) {
    const requestPromise = page.waitForRequest(
      (request) => new URL(request.url()).pathname === expectedPath,
    );
    await page.getByRole('button', { name: label, exact: true }).click();
    const request = await requestPromise;
    const response = await request.response();
    assert.ok(response, `${expectedPath} receives a local network response`);
    assert.equal(response.status(), 204, `${expectedPath} stays local in its target`);
    const matching = submissions.filter((submission) => submission.path === expectedPath);
    assert.equal(matching.length, 1, `${expectedPath} makes exactly one network request`);
    return matching[0];
  }

  async function clickWithoutSubmission(label, before, message) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.waitForTimeout(80);
    assert.equal(submissions.length, before, message);
  }

  const direct = await clickAndCapture('Run form.submit()', '/programmatic');
  assert.equal(direct.method, 'POST');
  assert.match(direct.contentType ?? '', /^application\/x-www-form-urlencoded/i);
  assert.equal(direct.bodyText, 'value=captured-at-call&empty=');
  assert.equal(await page.locator('#direct-result').textContent(), 'after-call');
  assert.equal(await page.locator('#direct-events').textContent(), 'invalid=0,submit=0');

  const sync = await clickAndCapture('Run requestSubmit()', '/sync');
  assert.equal(await page.locator('#sync-order').textContent(), 'before,submit,after');
  assert.equal(sync.method, 'GET');
  assert.deepEqual(sync.query, [['value', 'sync']]);

  const beforeValidation = submissions.length;
  await clickWithoutSubmission(
    'Run invalid requestSubmit',
    beforeValidation,
    'required validation must stop the network submission',
  );
  assert.equal(await page.locator('#invalid-result').textContent(), 'invalid');

  const beforeCanceled = submissions.length;
  await clickWithoutSubmission(
    'Run cancelled requestSubmit',
    beforeCanceled,
    'preventDefault must cancel the network submission',
  );
  assert.equal(await page.locator('#cancel-result').textContent(), 'submit');

  const novalidate = await clickAndCapture(
    'Run novalidate requestSubmit',
    '/novalidate',
  );
  assert.equal(await page.locator('#novalidate-result').textContent(), 'submit');
  assert.equal(novalidate.method, 'GET');
  assert.deepEqual(novalidate.query, [['value', '']]);

  const override = await clickAndCapture(
    'Run submitter requestSubmit',
    '/override',
  );
  assert.equal(await page.locator('#override-result').textContent(), 'submitter=override-submit; clicks=0');
  assert.equal(override.method, 'POST');
  assert.equal(override.contentType, 'text/plain');
  assert.equal(override.frameName, 'submit-sink');
  assert.equal(override.bodyText, 'payload=&intent=launch');

  const beforeErrors = submissions.length;
  await clickWithoutSubmission(
    'Check requestSubmit errors',
    beforeErrors,
    'invalid requestSubmit arguments must not submit',
  );
  assert.equal(await page.locator('#error-result').textContent(), 'TypeError,NotFoundError');

  const double = await clickAndCapture(
    'Run two same-form submits',
    '/double',
  );
  assert.equal(double.method, 'POST');
  assert.equal(double.bodyText, 'value=last');
  assert.equal(submissions.filter((submission) => submission.path === '/double').length, 1);

  const buttonSubmit = await clickAndCapture(
    'Submit from onclick',
    '/button-submit',
  );
  assert.equal(buttonSubmit.method, 'POST');
  assert.equal(buttonSubmit.bodyText, 'value=submit');

  const buttonRequest = await clickAndCapture(
    'requestSubmit from onclick',
    '/button-request',
  );
  assert.equal(buttonRequest.method, 'POST');
  assert.equal(buttonRequest.bodyText, 'value=request');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedRequests, [], 'No browser request escaped the local routes.');

  const result = {
    oracle: 'Chromium through local Playwright Core',
    browserVersion: browser.version(),
    checkedAt: new Date().toISOString(),
    source: 'apps/android/integration_test/document_scripted_forms_test.dart',
    fixture: 'scriptedFormsHtml (extracted directly from source)',
    assertions: {
      formSubmitCapture: {
        request: direct,
        valueAfterCall: 'after-call',
        events: 'invalid=0,submit=0',
      },
      requestSubmit: {
        order: await page.locator('#sync-order').textContent(),
        request: sync,
      },
      requiredInvalid: {
        result: await page.locator('#invalid-result').textContent(),
        submissionCount: beforeValidation,
      },
      canceledSubmit: {
        result: await page.locator('#cancel-result').textContent(),
        submissionCount: beforeCanceled,
      },
      novalidate: {
        result: await page.locator('#novalidate-result').textContent(),
        request: novalidate,
      },
      submitterOverrides: {
        result: await page.locator('#override-result').textContent(),
        request: override,
      },
      invalidArguments: await page.locator('#error-result').textContent(),
      sameFormSubmitRequests: {
        count: submissions.filter((submission) => submission.path === '/double').length,
        request: double,
      },
      submitButtonRequests: {
        formSubmit: {
          count: submissions.filter((submission) => submission.path === '/button-submit').length,
          request: buttonSubmit,
        },
        requestSubmit: {
          count: submissions.filter((submission) => submission.path === '/button-request').length,
          request: buttonRequest,
        },
      },
      actualNetworkSubmissionCount: submissions.length,
      pageErrors,
      blockedExternalRequests: blockedRequests,
    },
  };
  const outputPath = path.join(
    repositoryRoot,
    'apps/android/build/parity-acceptance/document-scripted-forms-20261015/browser-oracle.json',
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
}
