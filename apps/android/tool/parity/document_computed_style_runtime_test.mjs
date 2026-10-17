import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import nativeVm from 'node:vm';
import { createDocumentScriptHostVm } from './document_script_host_test_helper.mjs';

const vm = createDocumentScriptHostVm(nativeVm);
const bundlePath = process.env.PIRC_DOCUMENT_SCRIPT_RUNTIME_BUNDLE || fileURLToPath(
  new URL('../../assets/document-script-runtime.js', import.meta.url),
);
const bundle = readFileSync(bundlePath, 'utf8');

function createRuntime() {
  const context = vm.createContext({});
  new vm.Script(bundle, { filename: 'document-script-runtime.js' }).runInContext(context, { timeout: 3000 });
  return context;
}

function invoke(context, method, argument) {
  const source = '__pircDocument.' + method + '(' + JSON.stringify(argument) + ')';
  return JSON.parse(new vm.Script(source).runInContext(context, { timeout: 3000 }));
}

function evaluate(context, expression) {
  return new vm.Script(expression).runInContext(context, { timeout: 3000 });
}

function elementId(context, selector) {
  return evaluate(context,
    'document.querySelector(' + JSON.stringify(selector) + ').getAttribute("data-pirc-script-id")');
}

function nativePacket(response, generation, overrides = {}) {
  assert.ok(response.layout && Array.isArray(response.layout.ids));
  const boxes = response.layout.ids.map((id) => {
    if (Object.prototype.hasOwnProperty.call(overrides, id)) return { id, ...overrides[id] };
    return { id, kind: 'none' };
  });
  return {
    revision: response.layout.revision,
    generation,
    viewport: { scrollX: 0, scrollY: 0, width: 390, height: 844 },
    boxes,
  };
}

test('production runtime exposes live host-computed style and fences stale reads after mutation', () => {
  const context = createRuntime();
  const initialized = invoke(context, 'init', {
    url: 'https://example.test/computed-style',
    hostLayout: true,
    html: [
      '<!doctype html><html><body>',
      '<div id="target" style="color: purple"></div>',
      '<script>',
      'var target = document.querySelector("#target");',
      'window.firstDeclaration = getComputedStyle(target);',
      'window.windowAndGlobalMatch = getComputedStyle === window.getComputedStyle;',
      'window.inlineColor = target.style.color;',
      'window.freshObject = firstDeclaration !== window.getComputedStyle(target);',
      'window.readOnlyError = "none";',
      'try { window.firstDeclaration.setProperty("color", "orange"); } catch (error) { window.readOnlyError = error.name; }',
      '</script>',
      '</body></html>',
    ].join(''),
  });
  assert.equal(initialized.layout.required, true);
  const targetId = elementId(context, '#target');
  const initialUpdate = invoke(context, 'updateLayout', nativePacket(initialized, 1, {
    [targetId]: {
      kind: 'box', x: 0, y: 0, width: 40, height: 20,
      computedStyle: { color: 'rgb(10, 20, 30)', 'background-color': 'transparent', '--mode': 'native' },
    },
  }));
  assert.equal(initialUpdate.layoutAccepted, true);
  assert.equal(evaluate(context, 'window.windowAndGlobalMatch'), true);
  assert.equal(evaluate(context, 'window.firstDeclaration.color'), 'rgb(10, 20, 30)');
  assert.equal(evaluate(context, 'window.firstDeclaration.getPropertyValue("background-color")'), 'transparent');
  assert.equal(evaluate(context, 'window.inlineColor'), 'purple');
  assert.equal(evaluate(context, 'window.freshObject'), true);
  assert.equal(evaluate(context, 'window.readOnlyError'), 'NoModificationAllowedError');

  evaluate(context, 'document.querySelector("#target").setAttribute("data-phase", "changed");');
  evaluate(context, 'try { window.firstDeclaration.color; window.staleError = "none"; } catch (error) { window.staleError = error.name; }');
  assert.equal(evaluate(context, 'window.staleError'), 'NotSupportedError');
  const invalidated = invoke(context, 'snapshot', {});
  assert.equal(invalidated.layout.required, true, 'the post-measurement script mutation invalidates the native snapshot');

  const refreshed = invoke(context, 'updateLayout', nativePacket(invalidated, 2, {
    [targetId]: {
      kind: 'box', x: 0, y: 0, width: 40, height: 20,
      computedStyle: { color: 'rgb(30, 20, 10)', 'background-color': 'transparent', '--mode': 'updated' },
    },
  }));
  assert.equal(refreshed.layoutAccepted, true);
  assert.equal(evaluate(context, 'window.firstDeclaration.getPropertyValue("color")'), 'rgb(30, 20, 10)');
  assert.equal(evaluate(context, 'window.firstDeclaration.getPropertyValue("--mode")'), 'updated');
  assert.equal(evaluate(context, 'window.firstDeclaration.cssText'), '');
  assert.deepEqual(Array.from(evaluate(context, '[...window.firstDeclaration]')),
    ['background-color', 'color', '--mode']);
});
