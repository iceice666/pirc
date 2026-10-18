import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const bundle = readFileSync(
  new URL('../../assets/document-script-runtime.js', import.meta.url),
  'utf8',
);
function create({
  proof = true,
  kind = 'box',
  html = '<div id="target">before</div><pre id="report" style="display:none">WAIT</pre>',
} = {}) {
  const context = vm.createContext({}, { microtaskMode: 'afterEvaluate' });
  const run = (source) => new vm.Script(source).runInContext(context);
  run(bundle);
  const invoke = (method, value = {}) =>
    JSON.parse(run(`__pircDocument.${method}(${JSON.stringify(value)})`));
  const initial = invoke('init', {
    hostLayout: true,
    url: 'https://example.test/text-style',
    html: `<!doctype html><html><head></head><body>${html}</body></html>`,
  });
  run(
    'globalThis.target=document.getElementById("target");globalThis.report=document.getElementById("report");globalThis.live=getComputedStyle(target)',
  );
  const styles = {
    color: 'rgb(1, 2, 3)',
    'pointer-events': 'none',
    'font-family': 'monospace',
    '--Theme': 'night',
    width: '100px',
    height: '20px',
  };
  const packet = {
    revision: initial.layout.revision,
    generation: 1,
    viewport: { width: 390, height: 844, scrollX: 0, scrollY: 0 },
    boxes: initial.layout.ids.map((id) => ({
      id,
      kind,
      ...(kind === 'box'
        ? { x: 0, y: 0, width: 100, height: 20, clientWidth: 100, clientHeight: 20 }
        : {}),
      computedStyle: styles,
      ...(proof
        ? { textIndependentStyleProperties: ['color', 'pointer-events', 'font-family', '--Theme'] }
        : {}),
    })),
  };
  assert.equal(invoke('updateLayout', packet).layoutAccepted, true);
  return { run, invoke, packet };
}
for (const change of [
  'target.textContent="after"',
  'target.firstChild.data="after"',
  'target.firstChild.nodeValue="after"',
  'target.appendChild(document.createTextNode("more"))',
  'target.removeChild(target.firstChild)',
  'target.replaceChildren("new", " text")',
  'report.textContent="updated"',
])
  test(`text-only updates preserve cascade style and keep geometry fenced: ${change}`, () => {
    const r = create();
    assert.equal(r.run(`${change};live.getPropertyValue('pointer-events')`), 'none');
    assert.equal(r.run('live.color'), 'rgb(1, 2, 3)');
    assert.equal(r.run('live.fontFamily'), 'monospace');
    assert.equal(r.run('live.getPropertyValue("--Theme")'), 'night');
    assert.equal(r.run('live.getPropertyValue("--absent")'), '');
    assert.equal(r.run('live.getPropertyValue("made-up-property")'), '');
    assert.equal(r.run('live.getPropertyPriority("color")'), '');
    assert.equal(r.run('live.cssText'), '');
    assert.equal(r.run('live.length'), 6);
    assert.equal(r.run('Object.keys(live).length'), 6);
    assert.deepEqual(JSON.parse(r.run('JSON.stringify([...live])')), [
      'color',
      'font-family',
      'height',
      'pointer-events',
      'width',
      '--Theme',
    ]);
    assert.equal(r.run('"width" in live'), true);
    for (const expression of [
      'live.width',
      'live.getPropertyValue("height")',
      'live.getPropertyPriority("width")',
      'target.clientWidth',
      'target.getBoundingClientRect()',
    ]) {
      assert.throws(() => r.run(expression), { name: 'NotSupportedError' }, expression);
    }
    assert.equal(r.invoke('snapshot').layout.required, true);
  });
for (const kind of ['none', 'unsupported'])
  test(`text-only style proof also applies to ${kind} entries`, () => {
    const r = create({ kind });
    assert.equal(r.run('report.textContent="new";live.color'), 'rgb(1, 2, 3)');
  });
test('missing native selector proof preserves the full style fence', () => {
  const r = create({ proof: false });
  assert.throws(() => r.run('target.textContent="after";live.color'), {
    name: 'NotSupportedError',
  });
});
for (const change of [
  'target.className="changed"',
  'target.style.color="red"',
  'target.setAttribute("data-color","red")',
  'target.appendChild(document.createElement("span"))',
  'target.innerHTML="<b>new</b>"',
  'target.setAttribute("dir","auto")',
  'target.className="new";target.className=""',
])
  test(`mixed mutations cannot borrow text-only styles: ${change}`, () => {
    const r = create();
    r.run('target.textContent="text"');
    assert.throws(() => r.run(`${change};live.color`), { name: 'NotSupportedError' });
  });
for (const markup of [
  '<style id="report">div{color:red}</style>',
  '<script type="application/json" id="report">{}</script>',
  '<title id="report">old</title>',
  '<textarea id="report">old</textarea>',
  '<select><option id="report">old</option></select>',
  '<div dir="auto"><span id="report">old</span></div>',
  '<bdi><span id="report">old</span></bdi>',
  '<svg><text id="report">old</text></svg>',
])
  test(`text with additional semantics stays fenced: ${markup}`, () => {
    const r = create({ html: `<div id="target">old</div>${markup}` });
    assert.throws(() => r.run('report.textContent="new";live.color'), {
      name: 'NotSupportedError',
    });
  });
test('new native frame restores geometry and replaces a retained declaration', () => {
  const r = create();
  r.run('target.textContent="after"');
  const revision = r.invoke('snapshot').layout.revision;
  const next = {
    ...r.packet,
    revision,
    generation: 2,
    boxes: r.packet.boxes.map((b) => ({
      ...b,
      computedStyle: { ...b.computedStyle, color: 'rgb(9, 8, 7)', width: '140px' },
      width: 140,
      clientWidth: 140,
    })),
  };
  assert.equal(r.invoke('updateLayout', next).layoutAccepted, true);
  assert.equal(r.run('live.color'), 'rgb(9, 8, 7)');
  assert.equal(r.run('live.width'), '140px');
});
test('rejected metadata is atomic and cannot expand a host proof', () => {
  const r = create();
  for (const value of [
    null,
    {},
    ['color', 'color'],
    ['width', 'missing'],
    [null],
    ['COLOR'],
    Array(257).fill('color'),
  ]) {
    const next = {
      ...r.packet,
      generation: 2,
      boxes: r.packet.boxes.map((b) => ({ ...b, textIndependentStyleProperties: value })),
    };
    assert.throws(() => r.invoke('updateLayout', next));
  }
  assert.equal(r.run('target.textContent="new";live.color'), 'rgb(1, 2, 3)');
  assert.throws(() => r.run('live.width'), { name: 'NotSupportedError' });
});

test('property-name coercion cannot bypass mutation fences or illegal receivers', () => {
  const r = create();
  assert.equal(
    r.run(`live.getPropertyValue({toString(){target.textContent='new';return 'color';}})`),
    'rgb(1, 2, 3)',
  );
  assert.throws(
    () => r.run(`live.getPropertyValue({toString(){target.style.color='red';return 'color';}})`),
    { name: 'NotSupportedError' },
  );
  assert.equal(
    r.run(
      `globalThis.converted=false;try{live.getPropertyValue.call({}, {toString(){converted=true;return 'color';}})}catch(e){};converted`,
    ),
    false,
  );
});
