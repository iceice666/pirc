import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  'apps/android/integration_test/document_activation_fixture.dart',
);
const fixtureSource = readFileSync(fixturePath, 'utf8');
const fixtureMatch = fixtureSource.match(
  /const documentActivationFixture\s*=\s*r?'''([\s\S]*?)''';/,
);
assert.ok(
  fixtureMatch,
  'Could not extract documentActivationFixture from the integration fixture.',
);
const html = fixtureMatch[1];
const fixtureSha = createHash('sha256').update(fixtureSource).digest('hex');
const runnerSource = readFileSync(fileURLToPath(import.meta.url));
const runnerSha = createHash('sha256').update(runnerSource).digest('hex');
const fixtureUrl = 'http://127.0.0.1/document-activation';
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
});

try {
  const page = await browser.newPage();
  const requests = [];
  const blockedRequests = [];
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // Fulfill the one loopback fixture request in memory. Every other request,
  // including accidental form navigation, is stopped before network access.
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.href === fixtureUrl && request.method() === 'GET') {
      requests.push({ url: url.href, method: request.method(), fulfilled: true });
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: html,
      });
      return;
    }
    const entry = { url: request.url(), method: request.method() };
    blockedRequests.push(entry);
    if (url.pathname === '/activation-submit') requests.push({ ...entry, fulfilled: false });
    await route.abort();
  });

  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Run activation checks', exact: true }).click();
  await page.waitForFunction(() => {
    const node = document.querySelector('#result');
    if (!node) return false;
    try {
      return JSON.parse(node.textContent).status === 'DONE';
    } catch {
      return false;
    }
  });

  const activation = await page.evaluate(() => window.documentActivationResult);
  assert.equal(activation.status, 'DONE');
  assert.equal(await page.locator('#completion').textContent(), '原生控制啟用行為驗證完成。');

  const cases = activation.cases;
  const types = (events) => events.map((event) => event.type);
  const checkboxClick = cases.checkbox.events[0];
  assert.deepEqual(types(cases.checkbox.events), ['click', 'input', 'change']);
  assert.deepEqual(cases.checkbox.after, { checked: true, indeterminate: false });
  assert.deepEqual(
    {
      type: checkboxClick.type,
      bubbles: checkboxClick.bubbles,
      cancelable: checkboxClick.cancelable,
      detail: checkboxClick.detail,
      isTrusted: checkboxClick.isTrusted,
      button: checkboxClick.button,
      buttons: checkboxClick.buttons,
      isMouseEvent: checkboxClick.isMouseEvent,
      isPointerEvent: checkboxClick.isPointerEvent,
    },
    {
      type: 'click',
      bubbles: true,
      cancelable: true,
      detail: 0,
      isTrusted: false,
      button: 0,
      buttons: 0,
      isMouseEvent: true,
      isPointerEvent: true,
    },
  );

  assert.deepEqual(types(cases.cancelledCheckbox.events), ['click']);
  assert.deepEqual(cases.cancelledCheckbox.after, { checked: false, indeterminate: true });
  assert.equal(cases.cancelledCheckbox.documentObservation.defaultPrevented, true);

  assert.deepEqual(types(cases.radio.radioOneEvents), []);
  assert.deepEqual(types(cases.radio.radioTwoEvents), ['click', 'input', 'change', 'click']);
  assert.deepEqual(cases.radio.after, { radioOne: false, radioTwo: true });

  assert.deepEqual(types(cases.disabled.ownDisabledEvents), []);
  assert.deepEqual(types(cases.disabled.fieldsetDescendantEvents), []);
  assert.deepEqual(types(cases.disabled.firstLegendEvents), ['click', 'input', 'change']);
  assert.deepEqual(cases.disabled.after, {
    ownDisabled: false,
    fieldsetDescendant: false,
    firstLegend: true,
  });

  assert.deepEqual(types(cases.submitButtonChildClick.childClickEvents), ['click']);
  assert.deepEqual(types(cases.submitButtonChildClick.buttonClickEvents), ['click']);
  assert.deepEqual(types(cases.submitButtonChildClick.submitEvents), ['submit']);
  assert.equal(cases.submitButtonChildClick.buttonClickEvents[0].targetId, 'submit-button-child');
  assert.equal(cases.submitButtonChildClick.submitEvents[0].submitterId, 'submit-button');
  assert.deepEqual(cases.submitButtonChildClick.documentObservation, {
    targetId: 'submit-form',
    submitterId: 'submit-button',
    defaultPrevented: true,
  });

  assert.deepEqual(types(cases.resetButton.events), ['reset']);
  assert.equal(cases.resetButton.valueAfter, 'original');
  assert.equal(cases.resetButton.documentObservation.defaultPrevented, false);
  assert.deepEqual(types(cases.cancelledResetButton.events), ['reset']);
  assert.equal(cases.cancelledResetButton.valueAfter, 'changed');
  assert.equal(cases.cancelledResetButton.documentObservation.defaultPrevented, true);

  assert.deepEqual(types(cases.label.explicit.events), ['click', 'input', 'change']);
  assert.equal(cases.label.explicit.checked, true);
  assert.deepEqual(types(cases.label.implicit.events), ['click', 'input', 'change']);
  assert.equal(cases.label.implicit.checked, true);
  assert.deepEqual(types(cases.label.cancelled.events), []);
  assert.equal(cases.label.cancelled.checked, false);
  assert.equal(cases.label.cancelled.documentObservation.defaultPrevented, true);
  assert.deepEqual(types(cases.label.interactiveDescendant.labelControlEvents), []);
  assert.deepEqual(types(cases.label.interactiveDescendant.childEvents), ['click']);
  assert.equal(cases.label.interactiveDescendant.checked, false);
  assert.deepEqual(types(cases.label.disabledTarget.events), []);
  assert.equal(cases.label.disabledTarget.checked, false);

  assert.deepEqual(types(cases.recursiveClick.events), ['click', 'input', 'change']);
  assert.equal(cases.recursiveClick.reentryAttempts, 1);
  assert.equal(cases.recursiveClick.after, true);

  assert.deepEqual(types(cases.disabledMouseEventDispatch.events), ['click', 'input', 'change']);
  assert.equal(cases.disabledMouseEventDispatch.after, true);
  assert.deepEqual(types(cases.mouseEventDispatch.events), ['click', 'input', 'change']);
  assert.equal(cases.mouseEventDispatch.after, true);
  assert.equal(cases.mouseEventDispatch.events[0].isMouseEvent, true);
  assert.equal(cases.mouseEventDispatch.events[0].isPointerEvent, false);
  assert.deepEqual(types(cases.plainEventDispatch.events), ['click']);
  assert.equal(cases.plainEventDispatch.after, false);
  assert.equal(cases.plainEventDispatch.events[0].isMouseEvent, false);
  assert.equal(cases.plainEventDispatch.events[0].isPointerEvent, false);

  assert.deepEqual(
    types(cases.disabledSubmitMouseEventDispatch.buttonEvents),
    ['click'],
  );
  assert.deepEqual(cases.disabledSubmitMouseEventDispatch.submitEvents, []);
  assert.deepEqual(cases.disabledSubmitMouseEventDispatch.documentObservation, []);
  assert.deepEqual(
    types(cases.disabledResetMouseEventDispatch.buttonEvents),
    ['click'],
  );
  assert.deepEqual(cases.disabledResetMouseEventDispatch.resetEvents, []);
  assert.deepEqual(cases.disabledResetMouseEventDispatch.documentObservation, []);
  assert.equal(cases.disabledResetMouseEventDispatch.valueAfter, 'changed');
  assert.deepEqual(
    types(cases.disabledFieldsetChildClick.childEvents),
    ['click'],
  );
  assert.deepEqual(
    types(cases.disabledFieldsetChildClick.buttonEvents),
    ['click'],
  );
  assert.deepEqual(cases.disabledFieldsetChildClick.submitEvents, []);
  assert.deepEqual(cases.disabledFieldsetChildClick.documentObservation, []);

  assert.equal(cases.eventShapes.divClick[0].isTrusted, false);
  assert.equal(cases.eventShapes.divClick[0].isPointerEvent, true);
  assert.equal(cases.eventShapes.buttonClick[0].isTrusted, false);
  assert.equal(cases.eventShapes.buttonClick[0].isPointerEvent, true);

  await page.locator('#physical-checkbox').click();
  await page.locator('#physical-reset-value').fill('changed-by-user');
  await page.locator('#physical-reset-button').click();
  await page.waitForFunction(() => {
    const node = document.querySelector('#physical-result');
    if (!node) return false;
    try {
      const result = JSON.parse(node.textContent);
      return result.reset && result.reset.value === 'original' &&
        Array.isArray(result.reset.events) && result.reset.events.length === 1;
    } catch {
      return false;
    }
  });
  const physical = JSON.parse(await page.locator('#physical-result').textContent());
  const physicalLive = await page.evaluate(() => ({
    checkbox: {
      events: window.getDocumentActivationEventLog().filter(
        (event) => event.control === 'physicalCheckbox',
      ),
      checked: document.querySelector('#physical-checkbox').checked,
    },
    reset: {
      events: window.getDocumentActivationEventLog().filter(
        (event) => event.control === 'physicalResetForm',
      ),
      formObservation: window.getDocumentActivationFormObservations().filter(
        (event) => event.targetId === 'physical-reset-form',
      ),
      value: document.querySelector('#physical-reset-value').value,
    },
  }));
  const physicalWindow = await page.evaluate(
    () => window.documentPhysicalActivationResult,
  );
  assert.deepEqual(physical, physicalWindow, 'The DOM export matches its window value.');
  assert.deepEqual(physical, physicalLive, 'The DOM export matches live event and control state.');
  assert.deepEqual(types(physical.checkbox.events), ['click', 'input', 'change']);
  assert.ok(physical.checkbox.events.every((event) => event.isTrusted));
  assert.equal(physical.checkbox.checked, true);
  assert.deepEqual(types(physical.reset.events), ['reset']);
  assert.equal(physical.reset.events[0].isTrusted, true);
  assert.deepEqual(physical.reset.formObservation, [
    { targetId: 'physical-reset-form', defaultPrevented: false },
  ]);
  assert.equal(physical.reset.value, 'original');

  assert.equal(requests.length, 1, 'Only the in-memory loopback fixture request ran.');
  assert.deepEqual(blockedRequests, [], 'No browser request escaped the loopback route.');
  assert.deepEqual(pageErrors, []);
  assert.equal(page.url(), fixtureUrl);

  const result = {
    oracle: 'Google Chrome 155 through local Playwright Core',
    browserVersion: browser.version(),
    checkedAt: new Date().toISOString(),
    source: 'apps/android/integration_test/document_activation_fixture.dart',
    fixture: 'documentActivationFixture (raw Dart const extracted directly from source)',
    oracleMetadata: {
      browser: 'Google Chrome through local Playwright Core',
      sourceHash: {
        algorithm: 'sha256',
        fixtureSha,
        runnerSha,
      },
    },
    assertions: {
      programmatic: activation,
      physical,
      actualHttpRequests: requests,
      blockedRequests,
      pageErrors,
      finalUrl: page.url(),
    },
  };
  assert.match(result.browserVersion, /^155\./, 'The browser oracle must use local Chrome 155.');

  const outputPath = path.join(
    repositoryRoot,
    'apps/android/build/parity-acceptance/document-activation-20261016/browser-oracle.json',
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
}
