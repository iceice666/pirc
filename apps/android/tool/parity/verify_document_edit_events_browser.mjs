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
  'fixtures/mobile-parity/document-edit-events.html',
);
const html = readFileSync(fixturePath, 'utf8');
const fixtureUrl = 'https://example.test/document-edit-events';
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable,
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  const blockedRequests = [];
  const submissions = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.href === fixtureUrl && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: html,
      });
      return;
    }
    if (url.origin === 'https://example.test' &&
        url.pathname === '/allowed-submit' &&
        request.method() === 'GET') {
      submissions.push({
        method: request.method(),
        url: url.href,
        query: Array.from(url.searchParams.entries()),
        frameName: request.frame().name(),
      });
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    blockedRequests.push(request.url());
    await route.abort();
  });

  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });

  const compactEvent = (event) => ({
    type: event.type,
    phase: event.phase,
    target: event.target,
    ...(event.key !== null ? {
      key: event.key,
      code: event.code,
      repeat: event.repeat,
      modifiers: event.modifiers,
    } : {}),
    isTrusted: event.isTrusted,
    defaultPrevented: event.defaultPrevented,
    ...(event.activeElement !== null ? { activeElement: event.activeElement } : {}),
    ...(event.data !== null ? { data: event.data } : {}),
    ...(event.inputType !== null ? {
      inputType: event.inputType,
      isComposing: event.isComposing,
    } : {}),
    ...(event.value !== null ? { value: event.value } : {}),
  });
  // These are browser-routed focus, text insertion, and key actions.
  await page.locator('#cancel-input').click();
  await page.keyboard.type('cancel-me');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(30);
  const canceledSubmit = await page.evaluate(() => ({
    inputValue: document.querySelector('#cancel-input').value,
    submitCount: window.eventOracle.events.filter(
      (event) => event.type === 'submit' && event.target === 'cancel-form',
    ).length,
    submitEvents: window.eventOracle.events.filter(
      (event) => event.type === 'submit' && event.target === 'cancel-form',
    ),
    documentUrl: location.href,
  }));
  canceledSubmit.submitEvents = canceledSubmit.submitEvents.map(compactEvent);
  assert.equal(canceledSubmit.inputValue, 'cancel-me');
  assert.equal(canceledSubmit.submitCount, 2, 'capture and bubble observe one canceled submit');
  assert.equal(canceledSubmit.submitEvents[0].defaultPrevented, false);
  assert.equal(canceledSubmit.submitEvents[1].defaultPrevented, true);
  assert.equal(canceledSubmit.documentUrl, fixtureUrl);
  assert.equal(submissions.length, 0);

  // This is a distinct cancellation point: a trusted Enter keydown is
  // prevented before the browser can dispatch form submit.
  await page.locator('#keydown-cancel-input').click();
  await page.keyboard.type('prevent-me');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(30);
  const keydownPreventedEnter = await page.evaluate(() => ({
    inputValue: document.querySelector('#keydown-cancel-input').value,
    keydownEvents: window.eventOracle.events.filter(
      (event) =>
        event.type === 'keydown' &&
        event.target === 'keydown-cancel-input' &&
        event.key === 'Enter',
    ),
    keyupEvents: window.eventOracle.events.filter(
      (event) =>
        event.type === 'keyup' &&
        event.target === 'keydown-cancel-input' &&
        event.key === 'Enter',
    ),
    submitEvents: window.eventOracle.events.filter(
      (event) =>
        event.type === 'submit' &&
        event.target === 'keydown-cancel-form',
    ),
    documentUrl: location.href,
  }));
  keydownPreventedEnter.keydownEvents =
    keydownPreventedEnter.keydownEvents.map(compactEvent);
  keydownPreventedEnter.keyupEvents =
    keydownPreventedEnter.keyupEvents.map(compactEvent);
  keydownPreventedEnter.submitEvents =
    keydownPreventedEnter.submitEvents.map(compactEvent);
  assert.equal(keydownPreventedEnter.inputValue, 'prevent-me');
  assert.equal(keydownPreventedEnter.keydownEvents.length, 2);
  assert.equal(keydownPreventedEnter.keydownEvents[0].phase, 'capture');
  assert.equal(keydownPreventedEnter.keydownEvents[0].defaultPrevented, false);
  assert.equal(keydownPreventedEnter.keydownEvents[1].phase, 'bubble');
  assert.equal(keydownPreventedEnter.keydownEvents[1].defaultPrevented, true);
  assert.ok(keydownPreventedEnter.keydownEvents.every((event) => event.isTrusted));
  assert.equal(keydownPreventedEnter.keyupEvents.length, 2);
  assert.deepEqual(keydownPreventedEnter.submitEvents, []);
  assert.equal(keydownPreventedEnter.documentUrl, fixtureUrl);
  assert.equal(submissions.length, 0);

  const allowedRequestPromise = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/allowed-submit',
  );
  await page.locator('#allowed-input').click();
  await page.keyboard.type('allow-me');
  await page.keyboard.press('Enter');
  await allowedRequestPromise;
  await page.waitForTimeout(30);
  const allowedSubmit = await page.evaluate(() => ({
    inputValue: document.querySelector('#allowed-input').value,
    submitEvents: window.eventOracle.events.filter(
      (event) => event.type === 'submit' && event.target === 'allowed-form',
    ),
  }));
  allowedSubmit.submitEvents = allowedSubmit.submitEvents.map(compactEvent);
  assert.equal(allowedSubmit.inputValue, 'allow-me');
  assert.equal(allowedSubmit.submitEvents.length, 2, 'capture and bubble observe one allowed submit');
  assert.equal(allowedSubmit.submitEvents[0].defaultPrevented, false);
  assert.equal(allowedSubmit.submitEvents[1].defaultPrevented, false);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].method, 'GET');
  assert.deepEqual(submissions[0].query, [['value', 'allow-me']]);
  assert.equal(submissions[0].frameName, 'submit-sink');

  // Canceling click default runs after the browser's pointer focus action.
  await page.locator('#allowed-input').click();
  await page.locator('#click-cancel-input').click();
  const canceledTextClick = await page.evaluate(() => ({
    activeElement: document.activeElement.id || document.activeElement.tagName.toLowerCase(),
    events: window.eventOracle.events.filter(
      (event) => event.type === 'click' && event.target === 'click-cancel-input',
    ),
  }));
  canceledTextClick.events = canceledTextClick.events.map(compactEvent);
  assert.equal(canceledTextClick.events.length, 2);
  assert.equal(canceledTextClick.events[0].defaultPrevented, false);
  assert.equal(canceledTextClick.events[1].defaultPrevented, true);
  assert.equal(canceledTextClick.activeElement, 'click-cancel-input');

  // Exercise an ordinary select click and a click whose default is canceled.
  await page.locator('#select-normal').click();
  const normalSelectClick = await page.evaluate(() => ({
    activeElement: document.activeElement.id || document.activeElement.tagName.toLowerCase(),
    events: window.eventOracle.events.filter(
      (event) => event.type === 'click' && event.target === 'select-normal',
    ),
    value: document.querySelector('#select-normal').value,
  }));
  normalSelectClick.events = normalSelectClick.events.map(compactEvent);
  assert.equal(normalSelectClick.events.length, 2);
  assert.equal(normalSelectClick.events[0].defaultPrevented, false);
  assert.equal(normalSelectClick.events[1].defaultPrevented, false);
  assert.equal(normalSelectClick.activeElement, 'select-normal');

  await page.locator('#allowed-input').click();
  await page.locator('#select-cancel').click();
  const canceledSelectClick = await page.evaluate(() => ({
    activeElement: document.activeElement.id || document.activeElement.tagName.toLowerCase(),
    events: window.eventOracle.events.filter(
      (event) => event.type === 'click' && event.target === 'select-cancel',
    ),
    value: document.querySelector('#select-cancel').value,
  }));
  canceledSelectClick.events = canceledSelectClick.events.map(compactEvent);
  assert.equal(canceledSelectClick.events.length, 2);
  assert.equal(canceledSelectClick.events[0].defaultPrevented, false);
  assert.equal(canceledSelectClick.events[1].defaultPrevented, true);
  assert.equal(canceledSelectClick.activeElement, 'select-cancel');
  assert.equal(canceledSelectClick.value, 'one');

  // Use Chrome's DevTools IME input path; this is not a synthetic DOM event
  // and is not a claim about physical OS IME behavior.
  const composition = {
    driver: 'Chrome DevTools Protocol Input.imeSetComposition + Input.insertText',
    isPhysicalOsIme: false,
    attempted: false,
    supported: false,
    commands: [],
    events: [],
    value: null,
    limitation: null,
  };
  await page.locator('#composition-field').focus();
  const compositionStartIndex = await page.evaluate(
    () => window.eventOracle.events.length,
  );
  try {
    const cdp = await page.context().newCDPSession(page);
    composition.attempted = true;
    await cdp.send('Input.imeSetComposition', {
      text: 'に',
      selectionStart: 1,
      selectionEnd: 1,
    });
    composition.commands.push('Input.imeSetComposition');
    await cdp.send('Input.insertText', { text: '日' });
    composition.commands.push('Input.insertText');
    composition.supported = true;
    composition.events = await page.evaluate((startIndex) =>
      window.eventOracle.events.slice(startIndex).filter((event) =>
        event.target === 'composition-field',
      ), compositionStartIndex);
    composition.value = await page.locator('#composition-field').inputValue();
    await cdp.detach();
  } catch (error) {
    composition.limitation = error.name + ': ' + error.message;
    composition.events = await page.evaluate((startIndex) =>
      window.eventOracle.events.slice(startIndex).filter((event) =>
        event.target === 'composition-field',
      ), compositionStartIndex);
    composition.value = await page.locator('#composition-field').inputValue();
  }

  composition.events = composition.events.map(compactEvent);
  const eventLog = await page.evaluate(() => window.eventOracle.events);
  const trustedKeyboardEvents = eventLog.filter(
    (event) => ['keydown', 'keyup'].includes(event.type) &&
      ['Enter', 'c', 'a', 'n', 'e', 'l', '-', 'm'].includes(event.key),
  );
  const textInputEvents = eventLog.filter(
    (event) => event.type === 'input' &&
      ['cancel-input', 'allowed-input'].includes(event.target),
  );
  assert.ok(trustedKeyboardEvents.length > 0);
  assert.ok(trustedKeyboardEvents.every((event) => event.isTrusted));
  assert.ok(textInputEvents.length > 0);
  assert.ok(textInputEvents.every((event) => event.isTrusted));
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedRequests, [], 'No browser request escaped local routes.');

  const result = {
    oracle: 'Chromium through local Playwright Core',
    browserVersion: browser.version(),
    checkedAt: new Date().toISOString(),
    source: 'fixtures/mobile-parity/document-edit-events.html',
    fixture: 'Loaded as a local routed HTML fixture',
    actionProvenance: {
      focusClickTypingAndEnter: 'Playwright locator clicks and keyboard.type/keyboard.press; observed DOM events areTrusted=true',
      composition: composition.driver,
      compositionCaveat: 'CDP IME commands exercise Chromium input plumbing, not a physical operating-system IME.',
    },
    assertions: {
      canceledEnterSubmission: canceledSubmit,
      keydownPreventedEnter,
      allowedEnterSubmission: {
        ...allowedSubmit,
        capturedRequest: submissions[0],
      },
      clickCancellationFocus: {
        textInput: canceledTextClick,
        select: canceledSelectClick,
        observedEffect: 'In Chromium, focus moved to both click targets before the click listener canceled the event; the select retained its original option.',
      },
      selectClicks: {
        normal: normalSelectClick,
        prevented: canceledSelectClick,
      },
      composition,
      keyboardAndInputMetadata: {
        trustedKeyboardEventCount: trustedKeyboardEvents.length,
        trustedInputEventCount: textInputEvents.length,
        enterSubmissionOrder: eventLog.filter(
          (event) => event.key === 'Enter' || event.type === 'submit',
        ).map(compactEvent),
        textInputByTarget: Object.fromEntries(
          ['cancel-input', 'allowed-input'].map((target) => {
            const targetEvents = eventLog.filter(
              (event) => event.type === 'input' && event.target === target,
            );
            return [target, {
              observedEventCount: targetEvents.length,
              firstInputEventPhases: targetEvents.slice(0, 2).map(compactEvent),
            }];
          }),
        ),
        focusTransitions: eventLog.filter((event) =>
          ['focus', 'blur', 'focusin', 'focusout'].includes(event.type),
        ).map(compactEvent),
      },
      pageErrors,
      blockedExternalRequests: blockedRequests,
    },
  };
  const outputPath = path.join(
    repositoryRoot,
    'apps/android/build/parity-acceptance/document-edit-events-20261015/browser-oracle.json',
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally {
  await browser.close();
}
