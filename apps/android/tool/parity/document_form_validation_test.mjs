import { requireTestBrowserExecutable } from './test_browser.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../../..');
const require = createRequire(import.meta.url);
const gatewayDirectory = path.join(repositoryRoot, 'apps/gateway');
const { chromium } = require(
  require.resolve('playwright-core', { paths: [gatewayDirectory] }),
);
const browserExecutable = requireTestBrowserExecutable();
assert.ok(browserExecutable, 'No local Chromium or Chrome executable is available.');

const sourcePath = path.join(
  scriptDirectory,
  'document_form_validation_source.js',
);
const validationSource = readFileSync(sourcePath, 'utf8');
let browser;

test.before(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable,
  });
});

test.after(async () => {
  await browser?.close();
});

async function createPage(markup) {
  const page = await browser.newPage();
  await page.setContent(markup);
  return page;
}

async function captureNativeValidity(page, ids) {
  return page.evaluate((controlIds) => {
    const names = [
      'badInput', 'customError', 'patternMismatch', 'rangeOverflow',
      'rangeUnderflow', 'stepMismatch', 'tooLong', 'tooShort',
      'typeMismatch', 'valueMissing', 'valid',
    ];
    return Object.fromEntries(controlIds.map((id) => {
      const control = document.getElementById(id);
      const validity = control.validity;
      return [id, {
        value: control.value,
        willValidate: control.willValidate,
        flags: Object.fromEntries(names.map((name) => [name, validity[name]])),
      }];
    }));
  }, ids);
}

async function installValidation(page) {
  await page.addScriptTag({
    content: `${validationSource}\nwindow.__validationFactory = createDocumentFormValidation;`,
  });
  await page.evaluate(() => {
    const userInputState = new WeakMap();
    const fileSelections = new WeakMap();
    const liveValues = new WeakMap();
    const reports = [];
    const diagnostics = [];
    const formOwner = (control) => control.form || null;
    const radioGroupMembers = (control) => {
      if (control.localName !== 'input' || control.type !== 'radio' || !control.name) {
        return [control];
      }
      return Array.from(control.ownerDocument.querySelectorAll('input[type="radio"]'))
        .filter((peer) => peer.name === control.name &&
          peer.form === control.form && peer.getRootNode() === control.getRootNode());
    };
    const validation = window.__validationFactory({
      Event,
      prototypes: [
        HTMLInputElement.prototype,
        HTMLTextAreaElement.prototype,
        HTMLSelectElement.prototype,
      ],
      formOwner,
      radioGroupMembers,
      isDisabled: (control) => control.matches(':disabled'),
      selectedOptions: (select) => Array.from(select.selectedOptions),
      fileSelections,
      liveValues,
      userInputState,
      diagnostic: (...args) => diagnostics.push(args),
      reportInvalid: (control, message) => reports.push({ id: control.id, message }),
    });
    validation.install();
    window.__validationTestState = {
      validation,
      userInputState,
      fileSelections,
      liveValues,
      reports,
      diagnostics,
    };
  });
}

test('validity flags cover common controls, authored constraints, and user edits', async (t) => {
  const page = await createPage(`<!doctype html><form id="form">
    <input id="required" required>
    <input id="email" type="email" value="not-an-email">
    <input id="multiple-email" type="email" multiple value="a@example.test, b@example.test">
    <input id="url" type="url" value="/relative/path">
    <input id="number" type="number" min="1" max="5" step="2" value="4">
    <input id="underflow" type="number" min="3" value="2">
    <input id="overflow" type="number" max="4" value="5">
    <input id="range" type="range" min="1" max="5" step="2" value="4">
    <input id="date" type="date" min="2025-01-01" step="2" value="2025-01-02">
    <input id="pattern" pattern="[A-Z]{2,}" value="ab">
    <input id="length" minlength="4" maxlength="6" value="abc">
    <input id="readonly" required readonly>
    <input id="checkbox" type="checkbox" required>
    <input id="radio-a" type="radio" name="choice" required>
    <input id="radio-b" type="radio" name="choice" checked>
    <select id="select" required><option value="">Choose</option><option value="x">X</option></select>
    <input id="file" type="file" required>
    <fieldset disabled><legend><input id="legend" required></legend><input id="disabled" required></fieldset>
    <input id="custom" value="ok">
  </form>`);
  t.after(() => page.close());

  const native = await captureNativeValidity(page, [
    'required', 'email', 'multiple-email', 'url', 'number', 'underflow',
    'overflow', 'range', 'date', 'pattern', 'length', 'readonly', 'checkbox',
    'radio-a', 'select', 'file', 'legend', 'disabled',
  ]);
  await installValidation(page);

  const result = await page.evaluate(() => {
    const state = window.__validationTestState;
    const flags = (id) => {
      const control = document.getElementById(id);
      const result = state.validation.validate(control);
      return {
        valid: result.valid,
        willValidate: result.willValidate,
        message: result.message,
        flags: result.flags,
      };
    };
    const values = {
      required: flags('required'),
      email: flags('email'),
      multipleEmail: flags('multiple-email'),
      url: flags('url'),
      number: flags('number'),
      underflow: flags('underflow'),
      overflow: flags('overflow'),
      range: flags('range'),
      date: flags('date'),
      pattern: flags('pattern'),
      lengthBeforeEdit: flags('length'),
      readonly: flags('readonly'),
      checkbox: flags('checkbox'),
      radioInitiallySelected: flags('radio-a'),
      selectPlaceholder: flags('select'),
      fileRequired: flags('file'),
      legend: flags('legend'),
      disabled: flags('disabled'),
    };
    const length = document.getElementById('length');
    state.userInputState.set(length, { userEdited: true, badInput: false });
    values.lengthAfterEdit = flags('length');
    state.userInputState.set(length, { userEdited: false, badInput: false });
    length.value = 'toolongvalue';
    values.programmaticLongValue = flags('length');
    document.getElementById('radio-b').checked = false;
    values.radioEmpty = flags('radio-a');
    document.getElementById('select').selectedIndex = 1;
    values.selectChosen = flags('select');
    state.fileSelections.set(document.getElementById('file'), [{ name: 'one.txt' }]);
    values.fileChosen = flags('file');
    const custom = document.getElementById('custom');
    custom.setCustomValidity('Use the approved value.');
    values.custom = flags('custom');
    custom.setCustomValidity('');
    values.customCleared = flags('custom');
    return values;
  });

  assert.equal(result.required.flags.valueMissing, true);
  assert.equal(result.required.valid, false);
  assert.equal(result.email.flags.typeMismatch, true);
  assert.equal(result.multipleEmail.valid, true);
  assert.equal(result.url.flags.typeMismatch, true);
  assert.equal(result.number.flags.stepMismatch, true);
  assert.equal(result.underflow.flags.rangeUnderflow, true);
  assert.equal(result.overflow.flags.rangeOverflow, true);
  assert.equal(result.range.willValidate, true);
  assert.equal(result.range.valid, true);
  assert.equal(result.date.flags.stepMismatch, true);
  assert.equal(result.pattern.flags.patternMismatch, true);
  assert.equal(result.lengthBeforeEdit.valid, true);
  assert.equal(result.lengthAfterEdit.flags.tooShort, true);
  assert.equal(result.programmaticLongValue.flags.tooLong, false);
  assert.equal(result.readonly.willValidate, false);
  assert.equal(result.readonly.valid, true);
  assert.equal(result.checkbox.flags.valueMissing, true);
  assert.equal(result.radioInitiallySelected.valid, true);
  assert.equal(result.radioEmpty.flags.valueMissing, true);
  assert.equal(result.selectPlaceholder.flags.valueMissing, true);
  assert.equal(result.selectChosen.valid, true);
  assert.equal(result.fileRequired.flags.valueMissing, true);
  assert.equal(result.fileChosen.valid, true);
  assert.equal(result.legend.flags.valueMissing, true);
  assert.equal(result.disabled.willValidate, false);
  assert.equal(result.disabled.valid, true);
  assert.equal(result.custom.flags.customError, true);
  assert.equal(result.custom.message, 'Use the approved value.');
  assert.equal(result.customCleared.valid, true);

  const nativeParity = [
    ['required', 'required'], ['email', 'email'], ['multipleEmail', 'multiple-email'],
    ['url', 'url'], ['number', 'number'], ['underflow', 'underflow'],
    ['overflow', 'overflow'], ['range', 'range'], ['date', 'date'],
    ['pattern', 'pattern'], ['lengthBeforeEdit', 'length'], ['readonly', 'readonly'],
    ['checkbox', 'checkbox'], ['radioInitiallySelected', 'radio-a'],
    ['selectPlaceholder', 'select'], ['fileRequired', 'file'],
    ['legend', 'legend'], ['disabled', 'disabled'],
  ];
  for (const [resultKey, id] of nativeParity) {
    assert.equal(result[resultKey].willValidate, native[id].willValidate,
      `${id}: willValidate should match Chromium in the same fixture`);
    for (const [name, value] of Object.entries(native[id].flags)) {
      assert.equal(result[resultKey].flags[name], value,
        `${id}: validity.${name} should match Chromium in the same fixture`);
    }
  }
});

test('checkForm dispatches every invalid event and reports first uncanceled control', async (t) => {
  const page = await createPage(`<!doctype html>
    <form id="form">
      <input id="first" required>
      <input id="second" type="email" value="bad">
      <fieldset disabled><input id="disabled" required></fieldset>
    </form>
    <input id="external" form="form" required>`);
  t.after(() => page.close());
  await installValidation(page);

  const result = await page.evaluate(() => {
    const state = window.__validationTestState;
    const events = [];
    const first = document.getElementById('first');
    const second = document.getElementById('second');
    const external = document.getElementById('external');
    first.addEventListener('invalid', (event) => {
      events.push({ id: event.target.id, bubbles: event.bubbles, cancelable: event.cancelable });
      event.preventDefault();
    });
    for (const control of [second, external]) {
      control.addEventListener('invalid', (event) => {
        events.push({ id: event.target.id, bubbles: event.bubbles, cancelable: event.cancelable });
      });
    }
    const valid = state.validation.checkForm(document.getElementById('form'), true);
    const firstElementResult = state.validation.checkElement(first, true);
    const secondElementResult = state.validation.checkElement(second, true);
    return {
      valid,
      firstElementResult,
      secondElementResult,
      events,
      reports: state.reports.map(({ id, message }) => ({ id, message })),
    };
  });

  assert.equal(result.valid, false);
  assert.equal(result.firstElementResult, false);
  assert.equal(result.secondElementResult, false);
  assert.deepEqual(result.events.slice(0, 3).map((event) => event.id), [
    'first', 'second', 'external',
  ]);
  assert.ok(result.events.every((event) => event.bubbles === false && event.cancelable === true));
  assert.deepEqual(result.reports.map((report) => report.id), ['second', 'second']);
  assert.ok(result.reports.every((report) => report.message.length > 0));
});

test('Chromium sanitizes numeric/date values and clamps range values before validation', async (t) => {
  const page = await createPage(`<!doctype html><form>
    <input id="number-oops" type="number" required value="oops">
    <input id="number-plus" type="number" required value="+">
    <input id="number-trailing-dot" type="number" required value="1.">
    <input id="date-invalid" type="date" required value="2025-02-30">
    <input id="number-script" type="number" required value="3">
    <input id="date-script" type="date" required value="2025-01-01">
    <input id="range-default" type="range">
    <input id="range-midpoint" type="range" min="2" max="8" step="3">
    <input id="range-snap" type="range" min="1" max="5" step="2" value="4">
  </form><form id="unsupported-form">
    <input id="month" type="month" required pattern="X+" minlength="12" value="2025-10">
    <input id="time" type="time" required pattern="X+" minlength="12" value="12:30">
    <input id="color" type="color" required pattern="X+" value="#aabbcc">
    <input id="month-readonly" type="month" required readonly value="2025-10">
  </form>`);
  t.after(() => page.close());

  await page.evaluate(() => {
    document.getElementById('number-script').value = 'oops';
    document.getElementById('date-script').value = '2025-02-30';
    document.getElementById('range-snap').value = '4';
  });
  const ids = [
    'number-oops', 'number-plus', 'number-trailing-dot', 'date-invalid',
    'number-script', 'date-script', 'range-default', 'range-midpoint',
    'range-snap', 'month', 'time', 'color', 'month-readonly',
  ];
  const native = await captureNativeValidity(page, ids);
  await installValidation(page);

  const result = await page.evaluate((controlIds) => {
    const state = window.__validationTestState;
    const values = Object.fromEntries(controlIds.map((id) => {
      const control = document.getElementById(id);
      const validation = state.validation.validate(control);
      return [id, {
        value: control.value,
        valid: validation.valid,
        willValidate: validation.willValidate,
        supported: validation.supported,
        unsupportedType: validation.unsupportedType,
        flags: validation.flags,
      }];
    }));
    return {
      values,
      monthCheckValid: state.validation.checkElement(
        document.getElementById('month'), false,
      ),
      formValid: state.validation.checkForm(
        document.getElementById('unsupported-form'), true,
      ),
      timeCheckValid: state.validation.checkElement(
        document.getElementById('time'), true,
      ),
      diagnostics: state.diagnostics.map(([code, level, message, details]) => ({
        code, level, message, details,
      })),
      reports: state.reports.map(({ id, message }) => ({ id, message })),
    };
  }, ids);

  for (const id of ['number-oops', 'number-plus', 'number-trailing-dot', 'date-invalid',
    'number-script', 'date-script']) {
    assert.equal(native[id].value, '', `${id}: Chromium should sanitize invalid values`);
    assert.equal(result.values[id].value, '');
    assert.equal(result.values[id].flags.valueMissing, true);
    assert.equal(result.values[id].valid, native[id].flags.valid);
  }
  assert.equal(native['range-default'].value, '50');
  assert.equal(native['range-midpoint'].value, '5');
  assert.equal(native['range-snap'].value, '5');
  for (const id of ['range-default', 'range-midpoint', 'range-snap']) {
    assert.equal(result.values[id].value, native[id].value,
      `${id}: helper must observe Chromium's normalized value`);
    assert.equal(result.values[id].valid, native[id].flags.valid);
    assert.equal(result.values[id].flags.stepMismatch, native[id].flags.stepMismatch);
  }
  for (const id of ['month', 'time']) {
    assert.equal(result.values[id].supported, false,
      `${id}: valid non-text input types need an explicit unsupported marker`);
    assert.equal(result.values[id].willValidate, native[id].willValidate);
    assert.equal(result.values[id].valid, native[id].flags.valid);
    assert.equal(result.values[id].flags.patternMismatch, false,
      `${id}: don't apply text pattern rules`);
    assert.equal(result.values[id].flags.tooShort, false,
      `${id}: don't apply text length rules`);
  }
  assert.equal(result.values.color.supported, true,
    'color has no text constraints and can be handled without rejecting the form');
  assert.equal(result.values.color.willValidate, native.color.willValidate);
  assert.equal(result.values.color.valid, native.color.flags.valid);
  assert.equal(result.values['month-readonly'].willValidate, false);
  assert.equal(result.monthCheckValid, false,
    'checkElement must fail closed when validation semantics are unsupported');
  assert.equal(result.formValid, false,
    'checkForm must fail closed when an enabled unsupported control is present');
  assert.equal(result.timeCheckValid, false);
  assert.deepEqual(result.reports, [
    { id: 'month', message: 'This form control is not yet supported.' },
    { id: 'time', message: 'This form control is not yet supported.' },
  ]);
  assert.deepEqual(result.diagnostics.map(({ code, details }) => [code, details.inputType]), [
    ['validation.input_type_unsupported', 'month'],
    ['validation.input_type_unsupported', 'time'],
  ]);
});
