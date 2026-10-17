import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const bundle = readFileSync(
  new URL('../../assets/document-script-runtime.js', import.meta.url),
  'utf8',
);
function runtime({
  axes = { width: 'auto', height: 'auto' },
  size = { width: 300, height: 150 },
  attrs = '',
  legacy = false,
  scrollY = 0,
} = {}) {
  const context = vm.createContext({}, { microtaskMode: 'afterEvaluate' });
  const run = (code) => new vm.Script(code).runInContext(context);
  run(bundle);
  const invoke = (method, input = {}) =>
    JSON.parse(run(`__pircDocument.${method}(${JSON.stringify(input)})`));
  const first = invoke('init', {
    hostLayout: true,
    url: 'https://example.test/sizing',
    html: `<!doctype html><html><head></head><body><div id="parent" style="width:350px;height:240px"><canvas id="target" style="width:${axes.width};height:${axes.height}" ${attrs}></canvas></div><div id="other"></div></body></html>`,
  });
  run(
    'globalThis.target=document.getElementById("target");globalThis.parentBox=document.getElementById("parent");globalThis.declaration=getComputedStyle(target)',
  );
  const childId = run('target.getAttribute("data-pirc-script-id")'),
    parentId = run('parentBox.getAttribute("data-pirc-script-id")');
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
    viewport: { width: 390, height: 844, scrollX: 0, scrollY },
    boxes: first.layout.ids.map((id) =>
      id === childId
        ? {
            id,
            kind: 'box',
            x: 0,
            y: 0,
            ...size,
            clientWidth: size.width,
            clientHeight: size.height,
            computedStyle: {
              ...edges,
              width: size.width + 'px',
              height: size.height + 'px',
              display: 'inline',
              'box-sizing': 'content-box',
              position: 'static',
            },
            canvasSizingProjection: { parentId, ...axes },
            ...(legacy
              ? {
                  canvasBitmapSizeIndependent: true,
                  canvasEquivalentStyleWrites: true,
                  replacedBoxStyleProjection: true,
                }
              : {}),
          }
        : id === parentId
          ? {
              id,
              kind: 'box',
              x: 0,
              y: 0,
              width: 350,
              height: 240,
              clientWidth: 350,
              clientHeight: 240,
              computedStyle: {
                ...edges,
                width: '350px',
                height: '240px',
                display: 'block',
                'box-sizing': 'content-box',
              },
              resize: {
                kind: 'box',
                contentRect: { x: 0, y: 0, width: 350, height: 240 },
                borderBoxSize: { inlineSize: 350, blockSize: 240 },
              },
              stableReplacedChildId: childId,
            }
          : { id, kind: 'none' },
    ),
  };
  assert.equal(invoke('updateLayout', packet).layoutAccepted, true);
  const dimensions = () =>
    JSON.parse(run('JSON.stringify({width:declaration.width,height:declaration.height})'));
  return { run, invoke, packet, childId, parentId, dimensions };
}
test('intrinsic, one auto axis and explicit pixels compute synchronous used sizes', () => {
  const r = runtime();
  r.run('target.style.display="block";target.style.boxSizing="border-box"');
  assert.deepEqual(r.dimensions(), { width: '300px', height: '150px' });
  r.run('target.style.height="240px"');
  assert.deepEqual(r.dimensions(), { width: '480px', height: '240px' });
  r.run('target.style.width="350px"');
  assert.deepEqual(r.dimensions(), { width: '350px', height: '240px' });
  r.run(
    'globalThis.ctx=target.getContext("2d");ctx.fillStyle="red";ctx.fillRect(0,0,10,10);target.width=700;target.height=480',
  );
  assert.deepEqual(r.dimensions(), { width: '350px', height: '240px' });
  assert.equal(r.run('ctx.fillStyle'), '#000000');
  assert.deepEqual(r.invoke('snapshot').canvases[0].commands, []);
  assert.equal(r.run('parentBox.getBoundingClientRect().width'), 350);
  for (const expression of [
    'target.getBoundingClientRect()',
    'target.offsetWidth',
    'parentBox.scrollHeight',
  ])
    assert.throws(() => r.run(expression), { name: 'NotSupportedError' });
});
test('switching fixed pixels to auto revokes old bitmap independence within one batch', () => {
  const r = runtime({
    axes: { width: '350px', height: '240px' },
    size: { width: 350, height: 240 },
    legacy: true,
  });
  r.run('target.style.width="auto";target.style.height="auto";target.width=400;target.height=200');
  assert.deepEqual(r.dimensions(), { width: '400px', height: '200px' });
  r.run('target.width=600');
  assert.deepEqual(r.dimensions(), { width: '600px', height: '200px' });
  r.run('target.removeAttribute("width");target.removeAttribute("height")');
  assert.deepEqual(r.dimensions(), { width: '300px', height: '150px' });
});
test('two percentage axes use the measured parent content box', () => {
  const r = runtime({ axes: { width: '50%', height: '50%' }, size: { width: 175, height: 120 } });
  r.run('target.style.width="125%";target.style.height="25%"');
  assert.deepEqual(r.dimensions(), { width: '437.5px', height: '60px' });
});
test('a zero natural axis supplies no aspect ratio', () => {
  const r = runtime({ attrs: 'width="0" height="150"', size: { width: 0, height: 150 } });
  r.run('target.style.height="120px"');
  assert.deepEqual(r.dimensions(), { width: '0px', height: '120px' });
  r.run('target.style.width="80px";target.style.height="auto"');
  assert.deepEqual(r.dimensions(), { width: '80px', height: '150px' });
  r.run('target.width=160');
  assert.deepEqual(r.dimensions(), { width: '80px', height: '75px' });
});
for (const change of [
  'target.style.padding="1px"',
  'target.style.margin="auto"',
  'target.style.width="var(--width)"',
  'target.style.width="calc(100% - 1px)"',
  'target.style.width="1000001px"',
  'target.style.removeProperty("width")',
  'target.className="changed"',
  'parentBox.style.height="250px"',
  'parentBox.appendChild(document.createTextNode("new"))',
])
  test(`unknown or out-of-scope mutation fences CSS calculations: ${change}`, () => {
    const r = runtime();
    r.run('target.style.display="block"');
    r.run(change);
    assert.throws(() => r.dimensions(), { name: 'NotSupportedError' });
    assert.throws(() => r.run('parentBox.getBoundingClientRect()'), { name: 'NotSupportedError' });
  });
test('supported sizes can change and restore without certifying old rectangles', () => {
  const r = runtime();
  r.run('target.style.width="425px";target.style.width="350px"');
  assert.deepEqual(r.dimensions(), { width: '350px', height: '175px' });
  assert.throws(() => r.run('target.getBoundingClientRect()'), { name: 'NotSupportedError' });
});
test('unproved changes cannot be hidden by later supported size changes', () => {
  const r = runtime();
  r.run('target.className="changed";target.style.width="350px";target.className=""');
  assert.throws(() => r.dimensions(), { name: 'NotSupportedError' });
});
test('native size acceptance ends the pending CSS calculation epoch', () => {
  const r = runtime();
  r.run('target.style.height="240px";target.style.width="350px"');
  assert.equal(r.dimensions().width, '350px');
  const pending = r.invoke('snapshot');
  const next = {
    ...r.packet,
    revision: pending.layout.revision,
    generation: 2,
    boxes: r.packet.boxes.map((b) =>
      b.id === r.childId
        ? {
            ...b,
            width: 350,
            height: 240,
            computedStyle: { ...b.computedStyle, width: '350px', height: '240px' },
            canvasSizingProjection: {
              ...b.canvasSizingProjection,
              width: '350px',
              height: '240px',
            },
          }
        : b,
    ),
  };
  assert.equal(r.invoke('updateLayout', next).layoutAccepted, true);
  assert.deepEqual(r.dimensions(), { width: '350px', height: '240px' });
});
test('malformed sizing proof, ownership and initial size mismatch reject packets atomically', () => {
  for (const patch of [
    (b) =>
      b.id === b.canvasSizingProjection?.parentId
        ? b
        : b.canvasSizingProjection
          ? { ...b, canvasSizingProjection: { ...b.canvasSizingProjection, width: 'calc(2px)' } }
          : b,
    (b) =>
      b.canvasSizingProjection
        ? { ...b, canvasSizingProjection: { ...b.canvasSizingProjection, parentId: 'pirc-9999' } }
        : b,
    (b) =>
      b.canvasSizingProjection
        ? { ...b, computedStyle: { ...b.computedStyle, width: '301px' } }
        : b,
    (b) => (b.stableReplacedChildId ? { ...b, stableReplacedChildId: undefined } : b),
    (b) =>
      b.canvasSizingProjection
        ? { ...b, computedStyle: { ...b.computedStyle, 'margin-left': '1px' } }
        : b,
  ]) {
    const r = runtime();
    assert.throws(
      () =>
        r.invoke('updateLayout', { ...r.packet, generation: 2, boxes: r.packet.boxes.map(patch) }),
      { name: 'TypeError' },
    );
    assert.equal(r.dimensions().width, '300px');
  }
});

test('a scrolled root cannot retain a parent rectangle after overflow changes', () => {
  const r = runtime({ scrollY: 80 });
  r.run('target.style.height="240px"');
  assert.deepEqual(r.dimensions(), { width: '480px', height: '240px' });
  assert.throws(() => r.run('parentBox.getBoundingClientRect()'), { name: 'NotSupportedError' });
});
