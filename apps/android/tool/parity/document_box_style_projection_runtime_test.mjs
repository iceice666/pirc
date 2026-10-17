import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const bundle = readFileSync(
  new URL('../../assets/document-script-runtime.js', import.meta.url),
  'utf8',
);
function runtime() {
  const context = vm.createContext({}, { microtaskMode: 'afterEvaluate' });
  const run = (source) => new vm.Script(source).runInContext(context);
  run(bundle);
  const invoke = (method, value = {}) =>
    JSON.parse(run(`__pircDocument.${method}(${JSON.stringify(value)})`));
  const first = invoke('init', {
    hostLayout: true,
    url: 'https://example.test/projection',
    html: '<!doctype html><html><head></head><body><div id="parent" style="width:350px;height:240px"><canvas id="target" style="width:100%;height:240px"></canvas></div><div id="other"></div></body></html>',
  });
  run(
    'globalThis.target=document.getElementById("target");globalThis.parentBox=document.getElementById("parent");globalThis.declaration=getComputedStyle(target)',
  );
  const childId = run('target.getAttribute("data-pirc-script-id")');
  const parentId = run('parentBox.getAttribute("data-pirc-script-id")');
  const edges = Object.fromEntries(
    [
      'padding-left',
      'padding-right',
      'padding-top',
      'padding-bottom',
      'border-left-width',
      'border-right-width',
      'border-top-width',
      'border-bottom-width',
      'margin-left',
      'margin-right',
      'margin-top',
      'margin-bottom',
    ].map((name) => [name, '0px']),
  );
  const packet = {
    revision: first.layout.revision,
    generation: 1,
    viewport: { width: 390, height: 844, scrollX: 0, scrollY: 0 },
    boxes: first.layout.ids.map((id) => ({
      id,
      kind: 'box',
      x: 20,
      y: 0,
      width: 350,
      height: 240,
      clientWidth: 350,
      clientHeight: 240,
      ...(id === childId
        ? {
            canvasBitmapSizeIndependent: true,
            canvasEquivalentStyleWrites: true,
            replacedBoxStyleProjection: true,
            computedStyle: {
              ...edges,
              width: '350px',
              height: '240px',
              display: 'inline',
              'box-sizing': 'content-box',
              color: 'rgb(0, 0, 0)',
            },
          }
        : {}),
      ...(id === parentId
        ? {
            stableReplacedChildId: childId,
            computedStyle: {
              ...edges,
              width: '350px',
              height: '240px',
              display: 'block',
              'box-sizing': 'content-box',
            },
          }
        : {}),
    })),
  };
  assert.equal(invoke('updateLayout', packet).layoutAccepted, true);
  return { run, invoke, packet, childId, parentId };
}
test('unchanged-size box style projection updates a live declaration without certifying new geometry', () => {
  const r = runtime();
  r.run(
    'target.style.display="block";target.style.boxSizing="border-box";target.width=700;target.height=480;target.style.width="350px"',
  );
  assert.equal(r.run('declaration.display'), 'block');
  assert.equal(r.run('declaration.boxSizing'), 'border-box');
  assert.equal(r.run('declaration.width'), '350px');
  assert.equal(r.run('declaration.height'), '240px');
  assert.equal(r.run('declaration.color'), 'rgb(0, 0, 0)');
  assert.equal(r.run('parentBox.getBoundingClientRect().width'), 350);
  assert.equal(r.run('getComputedStyle(parentBox).width'), '350px');
  for (const expression of [
    'target.getBoundingClientRect()',
    'target.offsetWidth',
    'parentBox.scrollHeight',
    'document.body.getBoundingClientRect()',
  ])
    assert.throws(() => r.run(expression), { name: 'NotSupportedError' }, expression);
  assert.equal(r.invoke('snapshot').layout.required, true);
});
for (const change of [
  'target.style.width="351px"',
  'target.style.height="241px"',
  'target.style.display="none"',
  'target.style.padding="1px"',
  'target.style.color="red"',
  'target.className="changed"',
  'target.style.removeProperty("width")',
  'target.style.width="var(--width)"',
  'parentBox.style.width="360px"',
  'document.getElementById("other").style.width="1px"',
  'parentBox.appendChild(document.createTextNode("new"))',
]) {
  test(`a real or unproved change fences projections: ${change}`, () => {
    const r = runtime();
    r.run('target.style.display="block"');
    assert.equal(r.run('declaration.display'), 'block');
    r.run(change);
    assert.throws(() => r.run('declaration.width'), { name: 'NotSupportedError' });
    assert.throws(() => r.run('parentBox.getBoundingClientRect()'), { name: 'NotSupportedError' });
  });
}
test('unknown changes restored in a batch cannot reopen projection before native layout', () => {
  const r = runtime();
  r.run('target.style.display="block";target.style.width="351px";target.style.width="350px"');
  assert.throws(() => r.run('declaration.width'), { name: 'NotSupportedError' });
  const next = r.invoke('snapshot');
  r.invoke('updateLayout', { ...r.packet, revision: next.layout.revision, generation: 2 });
  assert.equal(r.run('declaration.display'), 'inline');
});
test('box projection metadata and child ownership fail atomically', () => {
  for (const patch of [
    (b) => (b.kind === 'box' ? { ...b, replacedBoxStyleProjection: 'true' } : b),
    (b) => (b.stableReplacedChildId ? { ...b, stableReplacedChildId: 'pirc-9999' } : b),
    (b) =>
      b.replacedBoxStyleProjection
        ? { ...b, computedStyle: { ...b.computedStyle, 'padding-left': '1px' } }
        : b,
    (b) =>
      b.stableReplacedChildId ? { ...b, computedStyle: { ...b.computedStyle, width: 'auto' } } : b,
  ]) {
    const r = runtime();
    assert.throws(
      () =>
        r.invoke('updateLayout', { ...r.packet, generation: 2, boxes: r.packet.boxes.map(patch) }),
      { name: 'TypeError' },
    );
    assert.equal(r.run('declaration.width'), '350px');
  }
});

test('restoring a projected property in one batch keeps its actual final value', () => {
  const r = runtime();
  r.run(
    'target.style.display="block";target.style.boxSizing="border-box";target.style.display="inline";target.style.boxSizing="content-box"',
  );
  assert.equal(r.run('declaration.display'), 'inline');
  assert.equal(r.run('declaration.boxSizing'), 'content-box');
  assert.equal(r.invoke('snapshot').layout.required, true);
});
