import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const bundlePath = process.env.PIRC_DOCUMENT_SCRIPT_RUNTIME_BUNDLE || fileURLToPath(
  new URL('../../assets/document-script-runtime.js', import.meta.url),
);
const bundle = readFileSync(bundlePath, 'utf8');

function createRuntime() {
  const context = vm.createContext({}, { microtaskMode: 'afterEvaluate' });
  new vm.Script(bundle, { filename: 'document-script-runtime.js' }).runInContext(context);
  return context;
}

function invoke(context, method, argument) {
  const expression = '__pircDocument.' + method + '(' + JSON.stringify(argument) + ')';
  return JSON.parse(new vm.Script(expression).runInContext(context));
}

function evaluate(context, expression) {
  return new vm.Script(expression).runInContext(context);
}

function elementId(context, selector) {
  return evaluate(
    context,
    'document.querySelector(' + JSON.stringify(selector) + ').getAttribute("data-pirc-script-id")',
  );
}

function nativePacket(context, response, generation, overrides = {}) {
  assert.ok(response.layout && Array.isArray(response.layout.ids));
  const boxes = response.layout.ids.map((id) => {
    if (Object.prototype.hasOwnProperty.call(overrides, id)) return { id, ...overrides[id] };
    return { id, kind: 'none' };
  });
  const packet = {
    revision: response.layout.revision,
    generation,
    viewport: { scrollX: 17, scrollY: 29, width: 390, height: 844,
      scrollRange: {minLeft: 0, maxLeft: 100, minTop: 0, maxTop: 600}, ...(overrides.viewport || {}) },
    boxes,
  };
  if (overrides.scrollActionThrough !== undefined) packet.scrollActionThrough = overrides.scrollActionThrough;
  if (Array.isArray(overrides.scrollEvents)) packet.scrollEvents = overrides.scrollEvents;
  return packet;
}

function box(x, y, width, height, scroll) {
  return { kind: 'box', x, y, width, height, ...(scroll ? { scroll } : {}) };
}

function settleLayout(context, response, generation, overrides = {}) {
  let current = response;
  let nextGeneration = generation;
  const trace = [];
  for (let attempt = 0; attempt < 16 && current.layout?.required === true; attempt += 1) {
    current = invoke(context, 'updateLayout', nativePacket(context, current, nextGeneration++, overrides));
    trace.push({ accepted: current.layoutAccepted, revision: current.layout.revision, required: current.layout.required,
      diagnostics: current.diagnostics?.map(({ code }) => code) });
  }
  assert.equal(current.layout?.required, false, JSON.stringify(trace));
  return { response: current, nextGeneration };
}

function runClassicTask(context, response) {
  assert.ok(response.classicScript, 'a classic Script task should be pending');
  const id = response.classicScript.id;
  const task = JSON.parse(evaluate(
    context,
    '__pircDocument.beginClassicScript(' + JSON.stringify({ id }) + ')',
  ));
  assert.equal(task.id, id);
  const source = task.source + '\n;__pircDocument.endClassicScriptTurn(' + id + ');void 0;';
  let error;
  try {
    new vm.Script(source).runInContext(context);
  } catch (failure) {
    error = String(failure?.stack || failure);
  }
  return invoke(context, 'finishClassicScript', { id, ...(error ? { error } : {}) });
}

test('snapshot cloning preserves revision while real mutations before and after it invalidate', () => {
  const context = createRuntime();
  let current = invoke(context, 'init', {
    url: 'https://example.test/snapshot-revision',
    hostLayout: true,
    html: '<!doctype html><html><body><div id="target">start</div></body></html>',
  });
  const initialRevision = current.layout.revision;
  for (let index = 0; index < 4; index += 1) {
    current = invoke(context, 'snapshot', {});
    assert.equal(current.layout.revision, initialRevision, 'a no-op response snapshot must not invalidate itself');
  }

  evaluate(context, 'document.body.setAttribute("style", "color: red")');
  current = invoke(context, 'snapshot', {});
  assert.equal(current.layout.revision, initialRevision + 1, 'a real style change before snapshot must invalidate');
  const afterStyleRevision = current.layout.revision;
  current = invoke(context, 'snapshot', {});
  assert.equal(current.layout.revision, afterStyleRevision, 'the following no-op snapshot must remain stable');

  evaluate(context, 'document.querySelector("#target").appendChild(document.createTextNode(" changed"))');
  current = invoke(context, 'snapshot', {});
  assert.equal(current.layout.revision, afterStyleRevision + 1, 'a real text-tree change after snapshot must invalidate');
});

test('host layout barrier resumes classic, defer, module, and DOMContentLoaded in order', () => {
  const context = createRuntime();
  const initialized = invoke(context, 'init', {
    url: 'https://example.test/layout-barrier',
    hostLayout: true,
    html: [
      '<!doctype html><html><head>',
      '<script>window.order = ["classic"];</script>',
      '<script defer src="/defer.js"></script>',
      '<script type="module">window.order.push("module");</script>',
      '<script>document.addEventListener("DOMContentLoaded", function() { window.order.push("dcl"); });</script>',
      '</head><body><div id="probe"></div></body></html>',
    ].join(''),
  });

  assert.equal(initialized.layout.required, true);
  assert.ok(initialized.classicScript);
  assert.equal(evaluate(context, 'window.order'), undefined, 'the parser script must wait for native measurement');

  const firstUpdate = invoke(context, 'updateLayout', nativePacket(context, initialized, 1));
  assert.equal(firstUpdate.layoutAccepted, true);
  const accepted = firstUpdate.layout.required
    ? settleLayout(context, firstUpdate, 2).response
    : firstUpdate;
  assert.equal(accepted.layout.required, false);
  assert.deepEqual(JSON.parse(evaluate(context, 'JSON.stringify({window:[window.scrollX,window.scrollY,window.pageXOffset,window.pageYOffset],global:[scrollX,scrollY,pageXOffset,pageYOffset]})')),
    { window: [17, 29, 17, 29], global: [17, 29, 17, 29] });

  let current = runClassicTask(context, accepted);
  const parserRequests = [...current.resourceRequests];
  assert.deepEqual(Array.from(evaluate(context, 'window.order')), ['classic']);
  assert.ok(current.classicScript, 'the parser should continue to the listener script');
  current = runClassicTask(context, current);
  parserRequests.push(...current.resourceRequests);
  const deferRequest = parserRequests.find((request) => request.url === 'https://example.test/defer.js');
  assert.ok(deferRequest, 'the defer resource should be requested after parser scripts');
  assert.equal(current.classicScript, null);
  assert.deepEqual(Array.from(evaluate(context, 'window.order')), ['classic']);

  current = invoke(context, 'completeResource', {
    id: deferRequest.id,
    ok: true,
    source: 'window.order.push("defer");',
  });
  assert.ok(current.classicScript, 'the completed defer source must cross the native Script task barrier');
  current = runClassicTask(context, current);
  assert.deepEqual(Array.from(evaluate(context, 'window.order')), ['classic', 'defer', 'module', 'dcl']);
  assert.equal(evaluate(context, 'document.readyState'), 'complete');
  assert.equal(current.layout.required, false);
});

test('a mutation makes geometry stale, stale captures recover, and the next script sees fresh bounds', () => {
  const context = createRuntime();
  const initialized = invoke(context, 'init', {
    url: 'https://example.test/stale-layout',
    hostLayout: true,
    html: [
      '<!doctype html><html><body>',
      '<div id="probe"></div>',
      '<script>',
      'var target = document.querySelector("#probe");',
      'window.firstReadX = target.getBoundingClientRect().x;',
      'target.setAttribute("data-shape", "changed");',
      'try { target.getBoundingClientRect(); window.staleError = "none"; }',
      'catch (error) { window.staleError = error.name; }',
      '</script>',
      '<script>window.nextReadX = document.querySelector("#probe").getBoundingClientRect().x;</script>',
      '</body></html>',
    ].join(''),
  });
  assert.equal(initialized.layout.required, true);
  const probeId = elementId(context, '#probe');
  const initialPacket = nativePacket(context, initialized, 1, { [probeId]: box(100, 120, 40, 30) });
  const firstUpdate = invoke(context, 'updateLayout', initialPacket);
  assert.equal(firstUpdate.layoutAccepted, true);
  const firstAccepted = firstUpdate.layout.required
    ? settleLayout(context, firstUpdate, 2, { [probeId]: box(100, 120, 40, 30) }).response
    : firstUpdate;

  const staleAfterScript = runClassicTask(context, firstAccepted);
  assert.equal(evaluate(context, 'window.firstReadX'), 83);
  assert.equal(evaluate(context, 'window.staleError'), 'NotSupportedError');
  assert.equal(evaluate(context, 'window.nextReadX'), undefined);
  assert.equal(staleAfterScript.layout.required, true);
  assert.ok(staleAfterScript.classicScript);

  const staleResponse = invoke(context, 'updateLayout', {
    ...initialPacket,
    generation: 2,
  });
  assert.equal(staleResponse.layoutAccepted, false);
  assert.equal(staleResponse.layout.required, true);
  assert.ok(staleResponse.layout.revision > initialPacket.revision);

  const freshPacket = nativePacket(context, staleResponse, 3, { [probeId]: box(240, 300, 50, 35) });
  const freshUpdate = invoke(context, 'updateLayout', freshPacket);
  assert.equal(freshUpdate.layoutAccepted, true);
  const freshResponse = freshUpdate.layout.required
    ? settleLayout(context, freshUpdate, 4, { [probeId]: box(240, 300, 50, 35) }).response
    : freshUpdate;
  assert.equal(freshResponse.layout.required, false);
  const finished = runClassicTask(context, freshResponse);
  assert.equal(evaluate(context, 'window.nextReadX'), 223);
  assert.equal(finished.layout.required, false);
});

test('native viewport scroll feedback targets Document, bubbles through Window, and reports clamped offsets', () => {
  const context = createRuntime();
  const initialized = invoke(context, 'init', {
    url: 'https://example.test/native-scroll',
    hostLayout: true,
    html: [
      '<!doctype html><html><body>',
      '<script>',
      'window.scrollTrace = [];',
      'function recordScroll(label, event) { window.scrollTrace.push([label, event.target === document, event.currentTarget === window ? "window" : event.currentTarget === document ? "document" : "other", event.eventPhase, window.scrollX, window.scrollY]); }',
      'window.addEventListener("scroll", function(event) { recordScroll("window-capture", event); }, true);',
      'document.addEventListener("scroll", function(event) { recordScroll("document-capture", event); }, true);',
      'document.addEventListener("scroll", function(event) { recordScroll("document-target", event); });',
      'document.onscroll = function(event) { recordScroll("document-handler", event); };',
      'window.addEventListener("scroll", function(event) { recordScroll("window-bubble", event); });',
      'window.onscroll = function(event) { recordScroll("window-handler", event); };',
      'window.scrollTo({ top: 999, behavior: "smooth" });',
      'window.scrollBy({ top: 25 });',
      'window.scrollAtScriptTime = window.scrollY;',
      '</script>',
      '</body></html>',
    ].join(''),
  });
  assert.equal(initialized.layout.required, true);
  const initialBaseline = invoke(context, 'updateLayout', nativePacket(context, initialized, 1));
  assert.equal(initialBaseline.layoutAccepted, true);
  const acceptedBaseline = initialBaseline.layout.required
    ? settleLayout(context, initialBaseline, 2).response
    : initialBaseline;
  const scriptResponse = runClassicTask(context, acceptedBaseline);
  assert.equal(evaluate(context, 'window.scrollAtScriptTime'), 54,
    'an instant relative command uses the measured current position, not a smooth destination');
  assert.deepEqual(scriptResponse.scrollActions, [
    { actionId: 1, kind: 'to', x: null, y: 999, behavior: 'smooth' },
    { actionId: 2, kind: 'by', x: 0, y: 25, behavior: 'auto' },
  ]);
  assert.deepEqual(JSON.parse(evaluate(context, 'JSON.stringify(window.scrollTrace)')), [],
    'the first accepted position establishes the baseline without a scroll event');

  // Accepted native measurements are authoritative even when user scrolling
  // or a later extent change moves the viewport beyond a projected command.
  const clamped = invoke(context, 'updateLayout', nativePacket(context, scriptResponse, 3, {
    viewport: { scrollX: 0, scrollY: 600 },
    scrollActionThrough: 2,
    [elementId(context, 'html')]: box(0, 0, 390, 1500),
  }));
  assert.equal(clamped.layoutAccepted, true);
  assert.deepEqual(JSON.parse(evaluate(context, 'JSON.stringify(window.scrollTrace)')), [
    ['window-capture', true, 'window', 1, 0, 600],
    ['document-capture', true, 'document', 2, 0, 600],
    ['document-target', true, 'document', 2, 0, 600],
    ['document-handler', true, 'document', 2, 0, 600],
    ['window-bubble', true, 'window', 3, 0, 600],
    ['window-handler', true, 'window', 3, 0, 600],
  ], 'one bubbling Document event reports the accepted native position in browser listener order');

  const traceBeforeNoOp = evaluate(context, 'JSON.stringify(window.scrollTrace)');
  const unchanged = invoke(context, 'updateLayout', nativePacket(context, clamped, 4, {
    viewport: { scrollX: 0, scrollY: 600 },
    [elementId(context, 'html')]: box(0, 0, 390, 1500),
  }));
  assert.equal(unchanged.layoutAccepted, true);
  assert.equal(evaluate(context, 'JSON.stringify(window.scrollTrace)'), traceBeforeNoOp,
    'same-position packets coalesce and do not dispatch duplicate scroll events');
});

test('Element scroll commands queue target-owned actions through mutation and first layout', () => {
  const context = createRuntime();
  const initialized = invoke(context, 'init', {
    url: 'https://example.test/element-scroll-actions',
    hostLayout: true,
    html: '<!doctype html><html><body><div id="outer"></div></body></html>',
  });
  const outerId = elementId(context, '#outer');
  const measured = invoke(context, 'updateLayout', nativePacket(context, initialized, 1, {
    [outerId]: box(0, 0, 120, 80, { left: 0, top: 0, width: 120, height: 500 }),
  }));
  assert.equal(measured.layout.required, false);

  evaluate(context, [
    'var outer = document.querySelector("#outer");',
    'outer.setAttribute("data-mutated", "1");',
    'outer.scrollTo({ top: 24, behavior: "smooth" });',
    'var added = document.createElement("div"); added.id = "added"; document.body.appendChild(added);',
    'added.scrollBy({ left: 3, top: 8 });',
  ].join(''));
  const pending = invoke(context, 'snapshot', {});
  const addedId = elementId(context, '#added');
  assert.equal(pending.layout.required, true);
  assert.deepEqual(pending.scrollActions, [
    { actionId: 1, kind: 'to', x: null, y: 24, behavior: 'smooth', elementId: outerId },
    { actionId: 2, kind: 'by', x: 3, y: 8, behavior: 'auto', elementId: addedId },
  ], 'stale and newly appended targets queue intent without requiring a fresh box or exact layout revision');
  assert.ok(pending.scrollActions.every((action) => !Object.hasOwn(action, 'layoutRevision')));

  const fresh = invoke(context, 'updateLayout', nativePacket(context, pending, 2, {
    scrollActionThrough: 2,
    [outerId]: box(0, 0, 120, 80, { left: 0, top: 24, width: 120, height: 500 }),
    [addedId]: box(0, 100, 20, 20, { left: 3, top: 8, width: 20, height: 200 }),
  }));
  assert.equal(fresh.layoutAccepted, true);
  assert.equal(fresh.layout.required, false);
  assert.equal(evaluate(context, 'outer.scrollTop'), 24);
  assert.equal(evaluate(context, 'added.scrollLeft'), 3);
});

test('scroll actions and generated element IDs are scoped to a fresh document lifecycle', () => {
  function makePendingAction() {
    const context = createRuntime();
    const initialized = invoke(context, 'init', {
      url: 'https://example.test/element-scroll-lifecycle',
      hostLayout: true,
      html: '<!doctype html><html><body><div id="target"></div></body></html>',
    });
    const id = elementId(context, '#target');
    evaluate(context, 'document.querySelector("#target").scroll({top: 11})');
    const pending = invoke(context, 'snapshot', {});
    return { initialized, id, pending };
  }
  const first = makePendingAction();
  const second = makePendingAction();
  assert.equal(first.pending.scrollActions[0].actionId, 1);
  assert.equal(second.pending.scrollActions[0].actionId, 1,
    'a new isolated runtime starts a fresh monotonic action sequence under its own lifecycle');
  assert.equal(first.pending.scrollActions[0].elementId, first.id);
  assert.equal(second.pending.scrollActions[0].elementId, second.id);
  assert.equal(first.initialized.layout.required, true);
  assert.equal(second.initialized.layout.required, true);
});

test('native Element scroll events honor native order, capture, trust, and non-bubbling semantics', () => {
  const context = createRuntime();
  const initialized = invoke(context, 'init', {
    url: 'https://example.test/native-element-scroll',
    hostLayout: true,
    html: '<!doctype html><html><body><div id="outer"><div id="inner"></div></div></body></html>',
  });
  const outerId = elementId(context, '#outer');
  const innerId = elementId(context, '#inner');
  evaluate(context, [
    'var outer = document.querySelector("#outer"), inner = document.querySelector("#inner");',
    'window.scrollTrace = []; window.didMutateOnElementScroll = false;',
    'function record(label, event) { window.scrollTrace.push([label, event.target === inner ? "inner" : "outer", event.isTrusted, event.bubbles]); }',
    'window.addEventListener("scroll", function(event) { record("window-capture", event); }, true);',
    'document.addEventListener("scroll", function(event) { record("document-capture", event); }, true);',
    'outer.addEventListener("scroll", function(event) { record("outer-capture", event); }, true);',
    'outer.addEventListener("scroll", function(event) { record("outer-bubble", event); }, false);',
    'outer.addEventListener("scroll", function(event) { record("outer-target", event); }, false);',
    'inner.addEventListener("scroll", function(event) { record("inner-target", event); if (!window.didMutateOnElementScroll) { window.didMutateOnElementScroll = true; inner.setAttribute("data-from-scroll-listener", "yes"); } }, false);',
  ].join(''));

  const baseline = invoke(context, 'updateLayout', nativePacket(context, initialized, 1, {
    [outerId]: box(0, 0, 120, 80, { left: 0, top: 0, width: 120, height: 600 }),
    [innerId]: box(0, 0, 60, 40, { left: 0, top: 0, width: 60, height: 300 }),
  }));
  assert.equal(baseline.layoutAccepted, true);
  assert.deepEqual(JSON.parse(evaluate(context, 'JSON.stringify(window.scrollTrace)')), [],
    'the first nested native positions establish a baseline without scroll events');

  const nested = invoke(context, 'updateLayout', nativePacket(context, baseline, 2, {
    [outerId]: box(0, 0, 120, 80, { left: 0, top: 60, width: 120, height: 600 }),
    [innerId]: box(0, 0, 60, 40, { left: 0, top: 25, width: 60, height: 300 }),
    scrollEvents: [
      { id: innerId, sequence: 1 },
      { id: outerId, sequence: 2 },
      { id: innerId, sequence: 3 },
    ],
  }));
  assert.equal(nested.layoutAccepted, true);
  assert.equal(nested.layout.required, true,
    'a DOM mutation from the accepted scroll callback requires a fresh native layout');
  assert.deepEqual(JSON.parse(evaluate(context, 'JSON.stringify(window.scrollTrace)')), [
    ['window-capture', 'inner', true, false],
    ['document-capture', 'inner', true, false],
    ['outer-capture', 'inner', true, false],
    ['inner-target', 'inner', true, false],
    ['window-capture', 'outer', true, false],
    ['document-capture', 'outer', true, false],
    ['outer-capture', 'outer', true, false],
    ['outer-bubble', 'outer', true, false],
    ['outer-target', 'outer', true, false],
  ], 'native sequence order wins over outer-first box order, duplicate targets coalesce, and Element scroll does not bubble');

  const stable = invoke(context, 'updateLayout', nativePacket(context, nested, 3, {
    [outerId]: box(0, 0, 120, 80, { left: 0, top: 60, width: 120, height: 600 }),
    [innerId]: box(0, 0, 60, 40, { left: 0, top: 25, width: 60, height: 300 }),
  }));
  assert.equal(stable.layoutAccepted, true);
  assert.equal(stable.layout.required, false);
  assert.equal(evaluate(context, 'window.scrollTrace.length'), 9,
    'the listener-induced revision does not repeat events when native offsets remain unchanged');

  const replayedMetadata = invoke(context, 'updateLayout', nativePacket(context, stable, 4, {
    [outerId]: box(0, 0, 120, 80, { left: 0, top: 60, width: 120, height: 600 }),
    [innerId]: box(0, 0, 60, 40, { left: 0, top: 25, width: 60, height: 300 }),
    scrollEvents: [
      { id: innerId, sequence: 1 },
      { id: outerId, sequence: 2 },
      { id: innerId, sequence: 3 },
    ],
  }));
  assert.equal(replayedMetadata.layoutAccepted, true,
    'a new native frame may replay event metadata while its previous acknowledgement is pending');
  assert.equal(evaluate(context, 'window.scrollTrace.length'), 9,
    'replayed metadata at unchanged positions does not repeat scroll events');

  const resetCounter = invoke(context, 'updateLayout', nativePacket(context, replayedMetadata, 5, {
    [outerId]: box(0, 0, 120, 80, { left: 0, top: 70, width: 120, height: 600 }),
    [innerId]: box(0, 0, 60, 40, { left: 0, top: 35, width: 60, height: 300 }),
    scrollEvents: [
      { id: outerId, sequence: 1 },
      { id: innerId, sequence: 2 },
    ],
  }));
  assert.equal(resetCounter.layoutAccepted, true,
    'native view remounts may restart event sequence numbers');
  const resetCounterTrace = JSON.parse(evaluate(context, 'JSON.stringify(window.scrollTrace)')).slice(9);
  assert.deepEqual(resetCounterTrace.map((entry) => entry[0] + ':' + entry[1]), [
    'window-capture:outer', 'document-capture:outer', 'outer-capture:outer', 'outer-bubble:outer', 'outer-target:outer',
    'window-capture:inner', 'document-capture:inner', 'outer-capture:inner', 'inner-target:inner',
  ], 'a position change with a reset sequence dispatches in the supplied native order');

  const fallback = invoke(context, 'updateLayout', nativePacket(context, resetCounter, 6, {
    [outerId]: box(0, 0, 120, 80, { left: 0, top: 80, width: 120, height: 600 }),
    [innerId]: box(0, 0, 60, 40, { left: 0, top: 45, width: 60, height: 300 }),
  }));
  assert.equal(fallback.layoutAccepted, true);
  const fallbackTrace = JSON.parse(evaluate(context, 'JSON.stringify(window.scrollTrace)')).slice(18);
  assert.deepEqual(fallbackTrace.map((entry) => entry[0] + ':' + entry[1]), [
    'window-capture:outer', 'document-capture:outer', 'outer-capture:outer', 'outer-bubble:outer', 'outer-target:outer',
    'window-capture:inner', 'document-capture:inner', 'outer-capture:inner', 'inner-target:inner',
  ], 'position-difference fallback dispatches targets in document tree order');
});

test('native content extents expose root scroll dimensions and reject inferred element metrics', () => {
  const context = createRuntime();
  const initialized = invoke(context, 'init', {
    url: 'https://example.test/root-scroll-extents',
    hostLayout: true,
    html: '<!doctype html><html><body><div id="child"></div></body></html>',
  });
  const htmlId = elementId(context, 'html');
  const updated = invoke(context, 'updateLayout', nativePacket(context, initialized, 1, {
    viewport: { contentWidth: 500.75, contentHeight: 1000.75 },
    [htmlId]: box(0, 0, 390, 1000.75),
  }));
  assert.equal(updated.layoutAccepted, true);
  assert.deepEqual(JSON.parse(evaluate(context, `JSON.stringify({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,body:(()=>{try{return document.body.scrollHeight}catch(error){return error.name}})(),child:(()=>{try{return document.querySelector("#child").scrollHeight}catch(error){return error.name}})()})`)), {
    width: 501,
    height: 1001,
    body: 'NotSupportedError',
    child: 'NotSupportedError',
  });
});
