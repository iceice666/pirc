import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import nativeVm from 'node:vm';
import test from 'node:test';
import { createDocumentScriptHostVm } from './document_script_host_test_helper.mjs';

const vm = createDocumentScriptHostVm(nativeVm);
const bundle = readFileSync(
  new URL('../../assets/document-script-runtime.js', import.meta.url),
  'utf8',
);
const markup =
  '<button id="outside">Outside</button><dialog id="first"><button id="first-control">First</button></dialog><dialog id="second"><button id="second-control">Second</button></dialog>';
function setup() {
  const context = vm.createContext({});
  vm.runInContext(bundle, context, { timeout: 3000 });
  JSON.parse(
    vm.runInContext(
      `__pircDocument.init(${JSON.stringify({ html: markup, url: 'https://dialog-modal.example/test' })})`,
      context,
      { timeout: 3000 },
    ),
  );
  return context;
}
function read(context, expression) {
  return JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context, { timeout: 3000 }));
}
function run(context, source) {
  return vm.runInContext(source, context, { timeout: 3000 });
}
function snapshot(context) {
  return JSON.parse(run(context, '__pircDocument.snapshot({})'));
}

test('showModal has browser-compatible state, focus and top-layer snapshot markers', () => {
  const c = setup();
  run(c, 'document.getElementById("outside").focus();document.getElementById("first").showModal()');
  assert.equal(read(c, 'document.activeElement.id'), 'first-control');
  assert.equal(read(c, 'document.getElementById("first").open'), true);
  assert.match(snapshot(c).html, /<dialog[^>]*data-pirc-dialog-modal/);
  run(c, 'document.getElementById("outside").focus()');
  assert.equal(read(c, 'document.activeElement.id'), 'first-control');
  run(c, 'document.getElementById("second").showModal()');
  assert.equal(read(c, 'document.activeElement.id'), 'second-control');
  run(c, 'document.getElementById("first-control").focus()');
  assert.equal(read(c, 'document.activeElement.id'), 'second-control');
  run(c, 'document.getElementById("second").close()');
  assert.equal(read(c, 'document.activeElement.id'), 'first-control');
  run(c, 'document.getElementById("first").close()');
  assert.equal(read(c, 'document.activeElement.id'), 'outside');
  assert.doesNotMatch(snapshot(c).html, /data-pirc-dialog-modal/);
});

test('showModal rejects detached and nonmodal dialogs, and repeat modal is a no-op', () => {
  const c = setup();
  assert.equal(read(c, 'typeof HTMLDialogElement.prototype.showModal'), 'function');
  assert.throws(
    () => run(c, 'HTMLDialogElement.prototype.showModal.call(document.body)'),
    /Illegal invocation/,
  );
  assert.throws(() => run(c, 'document.createElement("dialog").showModal()'), /not in a Document/);
  run(c, 'document.getElementById("first").show()');
  assert.throws(
    () => run(c, 'document.getElementById("first").showModal()'),
    /already open as a non-modal dialog/,
  );
  run(c, 'document.getElementById("first").close()');
  run(c, 'document.getElementById("first").showModal()');
  assert.equal(run(c, 'document.getElementById("first").showModal()'), undefined);
  assert.throws(
    () => run(c, 'document.getElementById("first").show()'),
    /already open as a modal dialog/,
  );
  run(c, 'document.getElementById("first").removeAttribute("open")');
  assert.doesNotMatch(snapshot(c).html, /data-pirc-dialog-modal/);
});

test('platform close request targets only the top modal and respects cancellation', () => {
  const c = setup();
  run(
    c,
    'document.getElementById("first").showModal();document.getElementById("second").showModal()',
  );
  assert.equal(snapshot(c).modalDialogIds.length, 2);
  run(
    c,
    'document.getElementById("second").addEventListener("cancel",event=>event.preventDefault(),{once:true})',
  );
  assert.equal(
    JSON.parse(run(c, '__pircDocument.requestTopModalClose()')).modalCloseRequested,
    true,
  );
  assert.equal(read(c, 'document.getElementById("second").open'), true);
  assert.equal(
    JSON.parse(run(c, '__pircDocument.requestTopModalClose()')).modalCloseRequested,
    true,
  );
  assert.equal(read(c, 'document.getElementById("second").open'), false);
  assert.equal(snapshot(c).modalDialogIds.length, 1);
  assert.equal(
    JSON.parse(run(c, '__pircDocument.requestTopModalClose()')).modalCloseRequested,
    true,
  );
  assert.equal(read(c, 'document.getElementById("first").open'), false);
  assert.equal(
    JSON.parse(run(c, '__pircDocument.requestTopModalClose()')).modalCloseRequested,
    false,
  );
});

test('closedby=none blocks the platform request without a cancel event', () => {
  const c = setup();
  run(
    c,
    'window.cancelCount=0;const d=document.getElementById("first");d.setAttribute("closedby","none");d.addEventListener("cancel",()=>cancelCount++);d.showModal()',
  );
  assert.equal(
    JSON.parse(run(c, '__pircDocument.requestTopModalClose()')).modalCloseRequested,
    true,
  );
  assert.equal(read(c, 'document.getElementById("first").open'), true);
  assert.equal(read(c, 'cancelCount'), 0);
  run(c, 'document.getElementById("first").requestClose()');
  assert.equal(read(c, 'document.getElementById("first").open'), false);
  assert.equal(read(c, 'cancelCount'), 1);
});

test('author markup cannot forge a native modal top-layer marker', () => {
  const c = setup();
  run(c, 'document.getElementById("first").setAttribute("data-pirc-dialog-modal","99")');
  assert.doesNotMatch(snapshot(c).html, /data-pirc-dialog-modal/);
  run(c, 'document.getElementById("first").showModal()');
  assert.match(snapshot(c).html, /data-pirc-dialog-modal="1"/);
  run(c, 'document.getElementById("first").close()');
  assert.doesNotMatch(snapshot(c).html, /data-pirc-dialog-modal/);
});

test('removal during beforetoggle does not leave a modal focus lock', () => {
  const c = setup();
  run(
    c,
    'document.getElementById("outside").focus();const d=document.getElementById("first");d.addEventListener("beforetoggle",()=>d.remove());d.showModal()',
  );
  assert.equal(read(c, 'document.activeElement.id'), 'outside');
  assert.equal(snapshot(c).modalDialogIds.length, 0);
  assert.doesNotMatch(snapshot(c).html, /data-pirc-dialog-modal/);
  run(c, 'document.getElementById("second").showModal()');
  assert.equal(read(c, 'document.activeElement.id'), 'second-control');
});
