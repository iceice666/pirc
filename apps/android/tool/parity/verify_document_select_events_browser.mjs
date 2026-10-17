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
  'fixtures/mobile-parity/document-select-events.html',
);
const html = readFileSync(fixturePath, 'utf8');
const fixtureUrl = 'https://example.test/document-select-events';
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  const blockedRequests = [];
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
  const clearEvents = () => page.evaluate(() => window.eventOracle.clear());
  const readEvents = () => page.evaluate(() => window.eventOracle.events);
  const sequence = (events) => events.map((event) => `${event.type}:${event.phase}`);
  const trusted = (events) => events.every((event) => event.isTrusted);

  // A real pointer click on an option focuses its select before dispatching
  // the listbox's input/change and option click events.
  await clearEvents();
  await page.locator('#option-list option[value="bravo"]').click();
  const optionSelection = await page.evaluate(() => ({
    activeElement: document.activeElement.id || document.activeElement.tagName.toLowerCase(),
    value: document.querySelector('#option-list').value,
    events: window.eventOracle.events,
  }));
  assert.equal(optionSelection.activeElement, 'option-list');
  assert.equal(optionSelection.value, 'bravo');
  assert.deepEqual(sequence(optionSelection.events), [
    'focus:capture',
    'focusin:capture', 'focusin:bubble',
    'input:capture', 'input:bubble',
    'change:capture', 'change:bubble',
    'click:capture', 'click:bubble',
  ]);
  assert.ok(trusted(optionSelection.events));
  assert.ok(optionSelection.events.every(
    (event) => event.activeElement === 'option-list',
  ));
  const optionClickEvents = optionSelection.events.filter(
    (event) => event.type === 'click',
  );
  assert.ok(optionClickEvents.every((event) => event.target === 'option:bravo'));

  // Baseline: uncanceled, trusted keyboard actions select native options and
  // emit input/change between keydown and keyup.
  await page.locator('#keyboard-native option[value="charlie"]').click();
  const nativeKeyboard = [];
  for (const { key, initialValue, expectedValue } of [
    { key: 'ArrowDown', initialValue: 'alpha', expectedValue: 'bravo' },
    { key: 'Home', initialValue: 'charlie', expectedValue: 'alpha' },
    { key: 'End', initialValue: 'alpha', expectedValue: 'delta' },
    { key: 'b', initialValue: 'charlie', expectedValue: 'bravo' },
  ]) {
    await page.evaluate(({ initialValue }) => {
      document.querySelector('#keyboard-native').value = initialValue;
      window.eventOracle.clear();
    }, { initialValue });
    await page.keyboard.press(key);
    const observation = await page.evaluate(({ key, initialValue }) => ({
      key,
      initialValue,
      value: document.querySelector('#keyboard-native').value,
      events: window.eventOracle.events,
    }), { key, initialValue });
    assert.equal(observation.value, expectedValue, `${key} changes the native selection`);
    assert.deepEqual(sequence(observation.events), [
      'keydown:capture', 'keydown:bubble',
      'input:capture', 'input:bubble',
      'change:capture', 'change:bubble',
      'keyup:capture', 'keyup:bubble',
    ]);
    assert.ok(trusted(observation.events));
    assert.ok(observation.events.every(
      (event) => event.select === 'keyboard-native',
    ));
    assert.ok(observation.events.every((event) => !event.defaultPrevented));
    nativeKeyboard.push(observation);
  }

  // The same real keys are prevented at keydown. They produce keyup, but do
  // not change the selected option or dispatch input/change.
  await page.locator('#keyboard-cancel option[value="charlie"]').click();
  const canceledKeyboard = [];
  for (const { key, initialValue } of [
    { key: 'ArrowDown', initialValue: 'alpha' },
    { key: 'Home', initialValue: 'charlie' },
    { key: 'End', initialValue: 'alpha' },
    { key: 'b', initialValue: 'charlie' },
  ]) {
    await page.evaluate(({ initialValue }) => {
      document.querySelector('#keyboard-cancel').value = initialValue;
      window.eventOracle.clear();
    }, { initialValue });
    await page.keyboard.press(key);
    const observation = await page.evaluate(({ key, initialValue }) => ({
      key,
      initialValue,
      value: document.querySelector('#keyboard-cancel').value,
      activeElement: document.activeElement.id || document.activeElement.tagName.toLowerCase(),
      events: window.eventOracle.events,
    }), { key, initialValue });
    assert.equal(observation.value, initialValue, `${key} leaves selection unchanged`);
    assert.equal(observation.activeElement, 'keyboard-cancel');
    assert.deepEqual(sequence(observation.events), [
      'keydown:capture', 'keydown:bubble',
      'keyup:capture', 'keyup:bubble',
    ]);
    assert.ok(trusted(observation.events));
    assert.ok(observation.events.every(
      (event) => event.select === 'keyboard-cancel',
    ));
    assert.equal(observation.events[0].defaultPrevented, false);
    assert.equal(observation.events[1].defaultPrevented, true);
    assert.ok(observation.events.slice(2).every(
      (event) => !event.defaultPrevented,
    ));
    canceledKeyboard.push(observation);
  }

  // In Chromium's visible listbox, selection and input/change occur before
  // the option click listener can cancel its default. Cancellation does not
  // roll back that selection or remove focus from the select.
  await clearEvents();
  await page.locator('#click-cancel option[value="charlie"]').click();
  const canceledOptionClick = await page.evaluate(() => ({
    activeElement: document.activeElement.id || document.activeElement.tagName.toLowerCase(),
    value: document.querySelector('#click-cancel').value,
    events: window.eventOracle.events,
  }));
  assert.equal(canceledOptionClick.activeElement, 'click-cancel');
  assert.equal(canceledOptionClick.value, 'charlie');
  const canceledClickEvents = canceledOptionClick.events.filter(
    (event) => event.type === 'click',
  );
  assert.equal(canceledClickEvents.length, 2);
  assert.ok(canceledClickEvents.every(
    (event) => event.target === 'option:charlie' && event.isTrusted,
  ));
  assert.equal(canceledClickEvents[0].defaultPrevented, false);
  assert.equal(canceledClickEvents[1].defaultPrevented, true);
  const focusIndex = canceledOptionClick.events.findIndex(
    (event) => event.type === 'focus',
  );
  const inputIndex = canceledOptionClick.events.findIndex(
    (event) => event.type === 'input',
  );
  const changeIndex = canceledOptionClick.events.findIndex(
    (event) => event.type === 'change',
  );
  const clickIndex = canceledOptionClick.events.findIndex(
    (event) => event.type === 'click',
  );
  assert.ok(focusIndex >= 0 && focusIndex < inputIndex);
  assert.ok(inputIndex < changeIndex && changeIndex < clickIndex);
  assert.ok(canceledOptionClick.events.every((event) => event.isTrusted));

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedRequests, [], 'No browser request escaped local routes.');

  const result = {
    oracle: 'Chromium through local Playwright Core',
    browserVersion: browser.version(),
    checkedAt: new Date().toISOString(),
    source: 'fixtures/mobile-parity/document-select-events.html',
    fixture: 'Loaded as a local routed HTML fixture',
    actionProvenance: {
      optionClicks: 'Playwright locator clicks on actual option elements; observed focus, selection, input/change, and click events areTrusted=true',
      keyboard: 'Playwright keyboard.press using real browser key actions; observed keydown/input/change/keyup events areTrusted=true',
      setup: 'Between key actions the fixture value is reset with JavaScript only to establish a known starting option; those setup assignments emit no events.',
    },
    popupPlatformLimitation: 'The fixture uses visible size=4 listboxes and clicks their options directly. It does not cover a closed select dropdown, native popup opening/closing, or platform-specific popup behavior.',
    assertions: {
      optionSelection,
      uncanceledKeyboard: nativeKeyboard,
      keydownCanceledKeyboard: canceledKeyboard,
      canceledOptionClick: {
        ...canceledOptionClick,
        observedEffect: 'The option selection and input/change events occur before click; canceling the click does not roll back the selected value or select focus.',
      },
      pageErrors,
      blockedExternalRequests: blockedRequests,
    },
  };
  const outputPath = path.join(
    repositoryRoot,
    'apps/android/build/parity-acceptance/document-select-events-20261015/browser-oracle.json',
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally {
  await browser.close();
}
