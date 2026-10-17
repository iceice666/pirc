import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import nativeVm from 'node:vm';
import {createDocumentScriptHostVm} from './document_script_host_test_helper.mjs';
const vm=createDocumentScriptHostVm(nativeVm);

const builderPath = fileURLToPath(new URL('./build_document_script_runtime.py', import.meta.url));
const buildDirectory = mkdtempSync(join(tmpdir(), 'pirc-document-edit-events-'));
execFileSync('python3', [builderPath, '--output-dir', buildDirectory], {
  stdio: 'pipe',
});
after(() => rmSync(buildDirectory, { recursive: true, force: true }));

const bundle = readFileSync(join(buildDirectory, 'document-script-runtime.js'), 'utf8');
const RUN_TIMEOUT_MS = 3000;

function createRuntime() {
  const context = vm.createContext({});
  new vm.Script(bundle, { filename: 'document-script-runtime.js' }).runInContext(context, {
    timeout: RUN_TIMEOUT_MS,
  });
  return context;
}

function invoke(context, method, argument) {
  const expression = '__pircDocument.' + method + '(' + JSON.stringify(argument) + ')';
  const serialized = new vm.Script(expression).runInContext(context, {
    timeout: RUN_TIMEOUT_MS,
  });
  return JSON.parse(serialized);
}

function elementId(context, selector) {
  const expression =
    'document.querySelector(' + JSON.stringify(selector) + ').getAttribute("data-pirc-script-id")';
  return new vm.Script(expression).runInContext(context, {
    timeout: RUN_TIMEOUT_MS,
  });
}

test('keyboard metadata reaches handlers and Enter keydown cancellation is preserved', () => {
  const context = createRuntime();
  const initialized = invoke(context, 'init', {
    html: [
      '<input id="editor" onkeydown="window.inlineKeys.push(event.key)" ',
      'onkeyup="window.inlineKeys.push(\'up:\' + event.key)">',
      '<script>',
      'window.inlineKeys = []; window.keyInfo = null;',
      'const editor = document.querySelector("#editor");',
      'editor.addEventListener("keydown", function(event) {',
      '  window.keyInfo = {',
      '    key: event.key, code: event.code, location: event.location,',
      '    repeat: event.repeat, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey,',
      '    altKey: event.altKey, metaKey: event.metaKey, isComposing: event.isComposing,',
      '    keyCode: event.keyCode, charCode: event.charCode, which: event.which,',
      '    bubbles: event.bubbles, cancelable: event.cancelable,',
      '    keyboardInstance: event instanceof KeyboardEvent,',
      '    uiInstance: event instanceof UIEvent, eventInstance: event instanceof Event,',
      '    modifierState: event.getModifierState("Control")',
      '  };',
      '  event.preventDefault();',
      '});',
      '</script>',
    ].join('\n'),
  });
  assert.equal(
    initialized.diagnostics.some((item) => item.severity === 'error'),
    false,
  );

  const id = elementId(context, '#editor');
  const keydown = invoke(context, 'dispatch', {
    id,
    type: 'keydown',
    eventData: {
      key: 'Enter',
      code: 'Enter',
      location: 0,
      repeat: true,
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      metaKey: false,
      isComposing: true,
      keyCode: 13,
      charCode: 0,
      which: 13,
      bubbles: false,
      cancelable: false,
      target: 'not-the-input',
      type: 'focus',
      preventDefault: 'not a method',
      defaultPrevented: false,
    },
  });
  assert.equal(keydown.defaultPrevented, true);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('window.keyInfo', context))), {
    key: 'Enter',
    code: 'Enter',
    location: 0,
    repeat: true,
    ctrlKey: true,
    shiftKey: false,
    altKey: true,
    metaKey: false,
    isComposing: true,
    keyCode: 13,
    charCode: 0,
    which: 13,
    bubbles: true,
    cancelable: true,
    keyboardInstance: true,
    uiInstance: true,
    eventInstance: true,
    modifierState: true,
  });

  invoke(context, 'dispatch', {
    id,
    type: 'keyup',
    eventData: { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 },
  });
  assert.deepEqual(Array.from(vm.runInContext('window.inlineKeys', context)), [
    'Enter',
    'up:Enter',
  ]);
});

test('composition and input events retain order and editing metadata', () => {
  const context = createRuntime();
  const initialized = invoke(context, 'init', {
    html: [
      '<textarea id="editor" ',
      'oncompositionstart="window.inlineComposition.push(\'start\')" ',
      'oncompositionupdate="window.inlineComposition.push(\'update\')" ',
      'oncompositionend="window.inlineComposition.push(\'end\')"></textarea>',
      '<script>',
      'window.events = []; window.inlineComposition = [];',
      'const editor = document.querySelector("#editor");',
      'for (const type of ["compositionstart", "compositionupdate", "input", "compositionend"]) {',
      '  editor.addEventListener(type, function(event) {',
      '    window.events.push({',
      '      type: event.type, data: event.data, inputType: event.inputType,',
      '      isComposing: event.isComposing, bubbles: event.bubbles,',
      '      cancelable: event.cancelable,',
      '      compositionInstance: event instanceof CompositionEvent,',
      '      inputInstance: event instanceof InputEvent',
      '    });',
      '  });',
      '}',
      '</script>',
    ].join('\n'),
  });
  assert.equal(
    initialized.diagnostics.some((item) => item.severity === 'error'),
    false,
  );

  const id = elementId(context, '#editor');
  for (const [type, eventData] of [
    ['compositionstart', { data: '' }],
    ['compositionupdate', { data: 'に' }],
    ['input', { data: '日', inputType: 'insertCompositionText', isComposing: true }],
    ['compositionend', { data: '日' }],
  ]) {
    invoke(context, 'dispatch', { id, type, eventData });
  }

  const events = JSON.parse(JSON.stringify(vm.runInContext('window.events', context)));
  assert.deepEqual(
    events.map((event) => event.type),
    ['compositionstart', 'compositionupdate', 'input', 'compositionend'],
  );
  assert.deepEqual(
    events.map((event) => event.data),
    ['', 'に', '日', '日'],
  );
  assert.equal(events[0].bubbles, true);
  assert.equal(events[0].cancelable, false);
  assert.equal(events[0].compositionInstance, true);
  assert.equal(events[1].compositionInstance, true);
  assert.equal(events[2].inputType, 'insertCompositionText');
  assert.equal(events[2].isComposing, true);
  assert.equal(events[2].inputInstance, true);
  assert.equal(events[3].cancelable, false);
  assert.deepEqual(Array.from(vm.runInContext('window.inlineComposition', context)), [
    'start',
    'update',
    'end',
  ]);

  invoke(context, 'dispatch', {
    id,
    type: 'input',
    data: 'legacy data',
    inputType: 'insertText',
    isComposing: false,
  });
  const legacyInput = JSON.parse(JSON.stringify(vm.runInContext('window.events', context))).at(-1);
  assert.equal(legacyInput.data, 'legacy data');
  assert.equal(legacyInput.inputType, 'insertText');
  assert.equal(legacyInput.isComposing, false);
});

test('focus state and bubbling match focus, blur, focusin, and focusout behavior', () => {
  const context = createRuntime();
  const initialized = invoke(context, 'init', {
    html: [
      '<div id="parent" onfocusin="window.inlineFocus.push(\'focusin\')" ',
      'onfocusout="window.inlineFocus.push(\'focusout\')">',
      '<input id="editor" onfocus="window.inlineFocus.push(\'focus\')" ',
      'onblur="window.inlineFocus.push(\'blur\')">',
      '</div><input id="other">',
      '<script>',
      'window.inlineFocus = []; window.propagatedFocus = []; window.focusInfo = null;',
      'const editor = document.querySelector("#editor");',
      'window.blurActiveElement = null; window.focusoutActiveElement = null;',
      'editor.addEventListener("blur", function() {',
      '  window.blurActiveElement = document.activeElement.id || document.activeElement.localName;',
      '});',
      'editor.addEventListener("focusout", function() {',
      '  window.focusoutActiveElement = document.activeElement.id || document.activeElement.localName;',
      '});',
      'document.addEventListener("focus", function() { window.propagatedFocus.push("focus"); });',
      'document.addEventListener("blur", function() { window.propagatedFocus.push("blur"); });',
      'document.addEventListener("focusin", function(event) {',
      '  window.propagatedFocus.push("focusin:" + event.relatedTarget.id);',
      '});',
      'document.addEventListener("focusout", function(event) {',
      '  window.propagatedFocus.push("focusout:" + event.relatedTarget.id);',
      '});',
      'editor.addEventListener("focus", function(event) {',
      '  window.focusInfo = {',
      '    activeElement: document.activeElement.id, relatedTarget: event.relatedTarget,',
      '    bubbles: event.bubbles, cancelable: event.cancelable,',
      '    focusInstance: event instanceof FocusEvent',
      '  };',
      '});',
      '</script>',
    ].join('\n'),
  });
  assert.equal(
    initialized.diagnostics.some((item) => item.severity === 'error'),
    false,
  );

  const editorId = elementId(context, '#editor');
  const otherId = elementId(context, '#other');
  invoke(context, 'dispatch', {
    id: editorId,
    type: 'focus',
    eventData: { relatedTarget: null },
  });
  assert.equal(vm.runInContext('document.activeElement.id', context), 'editor');
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('window.focusInfo', context))), {
    activeElement: 'editor',
    relatedTarget: null,
    bubbles: false,
    cancelable: false,
    focusInstance: true,
  });
  assert.deepEqual(Array.from(vm.runInContext('window.propagatedFocus', context)), []);

  invoke(context, 'dispatch', {
    id: editorId,
    type: 'focusin',
    eventData: { relatedTarget: otherId },
  });
  assert.deepEqual(Array.from(vm.runInContext('window.propagatedFocus', context)), [
    'focusin:other',
  ]);
  assert.equal(vm.runInContext('document.activeElement.id', context), 'editor');

  invoke(context, 'dispatch', { id: editorId, type: 'blur' });
  assert.equal(vm.runInContext('document.activeElement.localName', context), 'body');
  assert.equal(vm.runInContext('window.blurActiveElement', context), 'body');
  assert.deepEqual(Array.from(vm.runInContext('window.propagatedFocus', context)), [
    'focusin:other',
  ]);
  invoke(context, 'dispatch', {
    id: editorId,
    type: 'focusout',
    eventData: { relatedTarget: otherId },
  });
  assert.equal(vm.runInContext('window.focusoutActiveElement', context), 'body');
  assert.deepEqual(Array.from(vm.runInContext('window.propagatedFocus', context)), [
    'focusin:other',
    'focusout:other',
  ]);
  assert.deepEqual(Array.from(vm.runInContext('window.inlineFocus', context)), [
    'focus',
    'focusin',
    'blur',
    'focusout',
  ]);
});
