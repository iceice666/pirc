import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import nativeVm from 'node:vm';
import { createDocumentScriptHostVm } from './document_script_host_test_helper.mjs';
const vm = createDocumentScriptHostVm(nativeVm),
  bundle = readFileSync(
    new URL('../../assets/document-script-runtime.js', import.meta.url),
    'utf8',
  );
function runtime(
  fragment = 'one',
  source = '<div id="one"></div><div id="two"></div><a name="named"></a>',
) {
  const context = vm.createContext({});
  const run = (source) => new vm.Script(source).runInContext(context, { timeout: 3000 });
  run(bundle);
  const invoke = (method, input) =>
    JSON.parse(run(`__pircDocument.${method}(${JSON.stringify(input)})`));
  const initial = invoke('init', {
    url: 'https://gateway.example/target#' + fragment,
    html: '<!doctype html>' + source,
  });
  assert.equal(
    initial.diagnostics.filter((x) => x.severity === 'error').length,
    0,
    JSON.stringify(initial.diagnostics),
  );
  return {
    run,
    invoke,
    initial,
    target: () =>
      run('document.querySelector(":target")?.getAttribute("data-pirc-script-id")||null'),
  };
}
test('target is selected after DOMContentLoaded and before load, not while parser scripts run', () => {
  const r = runtime(
    'one',
    `<div id="one"></div><script>window.events=[['script',!!document.querySelector(':target')]];document.addEventListener('DOMContentLoaded',()=>events.push(['DOMContentLoaded',!!document.querySelector(':target')]));window.addEventListener('load',()=>events.push(['load',!!document.querySelector(':target')]));</script>`,
  );
  assert.deepEqual(JSON.parse(r.run('JSON.stringify(events)')), [
    ['script', false],
    ['DOMContentLoaded', false],
    ['load', true],
  ]);
  assert.equal(r.initial.fragmentTargetId, r.target());
});
test('target retains node identity through rename, URL rewriting, detachment and reinsertion', () => {
  const r = runtime();
  const id = r.target();
  r.run(
    "globalThis.saved=document.getElementById('one');saved.id='renamed';history.pushState({},'','#two');history.replaceState({},'','#named')",
  );
  assert.equal(r.target(), id);
  r.run('saved.remove()');
  assert.equal(r.target(), null);
  assert.equal(r.invoke('snapshot', {}).fragmentTargetId, id);
  r.run('document.body.appendChild(saved)');
  assert.equal(r.target(), id);
  assert.equal(r.run("saved.matches(':target')&&saved.closest(':target')===saved"), true);
});
test('host fragment revisions reselect even at the same URL, but duplicate acknowledgments retain identity', () => {
  const r = runtime();
  r.run("document.getElementById('one').id='renamed'");
  const sync = {
    url: 'https://gateway.example/target#one',
    entryKey: 'next',
    index: 1,
    length: 2,
    ackRevision: 0,
    targetRevision: 1,
    targetUrl: 'https://gateway.example/target#one',
  };
  r.invoke('updateHistory', sync);
  assert.equal(r.target(), null);
  r.run("document.getElementById('two').id='one'");
  r.invoke('updateHistory', sync);
  assert.equal(r.target(), null);
  r.invoke('updateHistory', { ...sync, targetRevision: 2 });
  assert.equal(
    r.target(),
    r.run("document.getElementById('one').getAttribute('data-pirc-script-id')"),
  );
});
test('literal IDs precede decoded IDs, IDs precede names, malformed UTF-8 and BOM decode without losing target', () => {
  for (const [fragment, markup, expected] of [
    [
      '%6fne',
      '<div id="one" data-key="decoded"></div><div id="%6fne" data-key="literal"></div>',
      'literal',
    ],
    ['named', '<a name="named" data-key="name"></a><div id="named" data-key="id"></div>', 'id'],
    ['%FF', '<div id="�" data-key="replacement"></div>', 'replacement'],
    ['%EF%BB%BF', '<div id="\uFEFF" data-key="bom"></div>', 'bom'],
    ['named', '<a name="named" data-key="name"></a>', 'name'],
  ]) {
    const r = runtime(fragment, markup);
    assert.equal(r.run("document.querySelector(':target')?.dataset.key"), expected);
  }
});
test('missing/top/empty fragments clear target and matching uses the first duplicate in tree order', () => {
  const r = runtime(
    'one',
    '<div id="one" data-key="first"></div><div id="one" data-key="second"></div>',
  );
  assert.equal(r.run("document.querySelector(':target').dataset.key"), 'first');
  for (const hash of ['#top', '#absent', '#', '']) {
    r.invoke('updateLocation', { url: 'https://gateway.example/target' + hash });
    assert.equal(r.target(), null);
  }
});
