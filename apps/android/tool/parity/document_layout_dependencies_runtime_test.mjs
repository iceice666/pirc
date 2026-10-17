import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const bundle = readFileSync(
  new URL('../../assets/document-script-runtime.js', import.meta.url),
  'utf8',
);
function create(witness = true) {
  const context = vm.createContext({}, { microtaskMode: 'afterEvaluate' });
  const run = (source) => new vm.Script(source).runInContext(context);
  run(bundle);
  const invoke = (method, value = {}) =>
    JSON.parse(run(`__pircDocument.${method}(${JSON.stringify(value)})`));
  const initial = invoke('init', {
    hostLayout: true,
    url: 'https://example.test/dependencies',
    html: '<!doctype html><html><head></head><body><div id="parent" style="width:350px"><div id="child" style="width:100px;height:40px"></div><canvas id="canvas" width="100" height="40" style="width:100px;height:40px"></canvas></div><div id="sibling"></div></body></html>',
  });
  run(
    'globalThis.parentBox=document.getElementById("parent");globalThis.child=document.getElementById("child");globalThis.canvas=document.getElementById("canvas")',
  );
  const parentId = run('parentBox.getAttribute("data-pirc-script-id")');
  const packet = {
    revision: initial.layout.revision,
    generation: 1,
    viewport: { width: 390, height: 844, scrollX: 0, scrollY: 0 },
    boxes: initial.layout.ids.map((id) => ({
      id,
      kind: 'box',
      x: 0,
      y: 0,
      width: 350,
      height: 80,
      clientWidth: 350,
      clientHeight: 80,
      ...(id === parentId && witness ? { clientWidthIndependentOfDescendantSizes: true } : {}),
    })),
  };
  assert.equal(invoke('updateLayout', packet).layoutAccepted, true);
  return { run, invoke, packet, parentId };
}

test('measured parent clientWidth survives only descendant dimensional writes', () => {
  const r = create();
  r.run('child.style.width="425px";child.style.height="90px"');
  assert.equal(r.run('parentBox.clientWidth'), 350);
  for (const expr of [
    'parentBox.clientHeight',
    'parentBox.getBoundingClientRect()',
    'child.clientWidth',
    'getComputedStyle(parentBox).width',
  ]) {
    assert.throws(() => r.run(expr), { name: 'NotSupportedError' }, expr);
  }
  const out = r.invoke('snapshot');
  assert.equal(out.layout.required, true);
  assert.ok(out.layout.revision > r.packet.revision);
});

test('canvas resizing keeps native parent width without suppressing bitmap resets', () => {
  const r = create();
  r.run(
    'globalThis.ctx=canvas.getContext("2d");ctx.fillStyle="red";ctx.fillRect(0,0,10,10);canvas.style.width="425px";canvas.width=850;canvas.height=180',
  );
  assert.equal(r.run('parentBox.clientWidth'), 350);
  assert.equal(r.run('ctx.fillStyle'), '#000000');
  assert.deepEqual(r.invoke('snapshot').canvases[0].commands, []);
  assert.throws(() => r.run('canvas.getBoundingClientRect()'), { name: 'NotSupportedError' });
});

for (const change of [
  'parentBox.style.width="400px"',
  'document.body.style.width="400px"',
  'document.getElementById("sibling").style.width="400px"',
  'child.style.padding="10px"',
  'child.className="changed"',
  'child.textContent="changed"',
  'child.appendChild(document.createElement("div"))',
  'child.style.cssText="height:90px;width:425px"',
  'child.style.removeProperty("width")',
])
  test(`unproved mutation fences a retained clientWidth: ${change}`, () => {
    const r = create();
    r.run('child.style.width="425px"');
    assert.equal(r.run('parentBox.clientWidth'), 350);
    r.run(change);
    assert.throws(() => r.run('parentBox.clientWidth'), { name: 'NotSupportedError' });
  });

test('an unproved mutation cannot be hidden by a later dimensional write or restoration', () => {
  const r = create();
  r.run('child.className="changed";child.style.width="425px";child.className=""');
  assert.throws(() => r.run('parentBox.clientWidth'), { name: 'NotSupportedError' });
});

test('missing host proof and unrelated new boxes cannot borrow a parent witness', () => {
  const r = create(false);
  r.run('child.style.width="425px"');
  assert.throws(() => r.run('parentBox.clientWidth'), { name: 'NotSupportedError' });
  const other = create();
  other.run('parentBox.replaceWith(document.createElement("div"))');
  assert.equal(other.run('parentBox.clientWidth'), 0);
  assert.throws(() => other.run('document.body.lastElementChild.clientWidth'), {
    name: 'NotSupportedError',
  });
});

test('a newly accepted native layout ends the partial-read epoch', () => {
  const r = create();
  r.run('child.style.width="425px"');
  assert.equal(r.run('parentBox.clientWidth'), 350);
  const current = r.invoke('snapshot');
  r.invoke('updateLayout', {
    ...r.packet,
    revision: current.layout.revision,
    generation: 2,
    boxes: r.packet.boxes.map((b) => ({ ...b, clientWidth: 400 })),
  });
  assert.equal(r.run('parentBox.clientWidth'), 400);
  r.run('child.className="changed"');
  assert.throws(() => r.run('parentBox.clientWidth'), { name: 'NotSupportedError' });
});

test('invalid partial-read metadata rejects the entire packet atomically', () => {
  for (const bad of [false, 0, 'true', null]) {
    const r = create();
    const invalid = {
      ...r.packet,
      generation: 2,
      boxes: r.packet.boxes.map((b) =>
        b.id === r.parentId
          ? {
              ...b,
              clientWidthIndependentOfDescendantSizes: bad,
              clientWidth: bad === false ? undefined : 350,
            }
          : b,
      ),
    };
    assert.throws(() => r.invoke('updateLayout', invalid), { name: 'TypeError' });
    assert.equal(r.run('parentBox.clientWidth'), 350);
  }
});
