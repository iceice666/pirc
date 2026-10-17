import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./document_layout_source.js', import.meta.url), 'utf8');
const runtimeSource = fs.readFileSync(new URL('./document_script_runtime_source.js', import.meta.url), 'utf8');
const sandbox = { DOMException };
vm.runInNewContext(`${source}\nthis.createPircDocumentLayout = createPircDocumentLayout;`, sandbox);
const createLayout = sandbox.createPircDocumentLayout;

function extractRuntimeFunction(name, nextMarker, bindings = {}) {
  const start = runtimeSource.indexOf(`  function ${name}(`);
  const end = runtimeSource.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, `could not find runtime function ${name}`);
  const context = vm.createContext(bindings);
  vm.runInContext(`${runtimeSource.slice(start, end)}\nthis.__testedFunction = ${name};`, context);
  return context.__testedFunction;
}

class FakeElement {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }

  append(child) {
    child.parentNode = this;
    this.childNodes.push(child);
  }

  remove(child) {
    this.childNodes = this.childNodes.filter((candidate) => candidate !== child);
    child.parentNode = null;
  }

  contains(node) {
    if (node === this) return true;
    return this.childNodes.some((child) => child.contains(node));
  }
}
class FakeHTMLElement extends FakeElement {}

class FakeMutationObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.records = [];
    this.target = null;
    this.options = null;
    FakeMutationObserver.instances.push(this);
  }

  observe(target, options) {
    this.target = target;
    this.options = options;
  }

  takeRecords() {
    const records = this.records;
    this.records = [];
    return records;
  }

  deliver(records) {
    this.callback(records);
  }
}

function makeDocument(HTMLElementClass = FakeHTMLElement) {
  const document = { contains: (node) => document.documentElement.contains(node) };
  const root = new HTMLElementClass(document);
  document.documentElement = root;
  return { document, root };
}

function makeRegistry() {
  let next = 1;
  const ids = new WeakMap();
  const elements = new Map();
  return {
    ensureElementId(element) {
      let id = ids.get(element);
      if (!id) {
        id = `pirc-${next++}`;
        ids.set(element, id);
        elements.set(id, element);
      }
      return id;
    },
    resolveElementId(id) {
      return elements.get(id);
    },
    ids,
    elements,
  };
}

test('document layout helper', async (t) => {
  const diagnostics = [];
  const { document, root } = makeDocument();
  const registry = makeRegistry();
  const layout = createLayout({
    document,
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    MutationObserver: FakeMutationObserver,
    ensureElementId: registry.ensureElementId,
    resolveElementId: registry.resolveElementId,
    diagnostic: (code, details) => diagnostics.push({ code, details }),
    enabled: true,
  });
  layout.install();
  const observer = FakeMutationObserver.instances.at(-1);
  let measured;
  let measuredId;
  let firstPacket;
  let unmeasured;
  let unmeasuredId;
  let noBox;
  let noBoxId;
  let unsupported;
  let unsupportedId;
  let refreshedPacket;

  await t.test('installs observation and accepts a current layout packet', () => {
    assert.equal(observer.target, document);
    assert.equal(JSON.stringify(observer.options), JSON.stringify({
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    }));
    assert.equal(layout.revision(), 1);
    assert.equal(layout.status().required, true);
    assert.throws(() => layout.viewport(), (error) => error.name === 'NotSupportedError');

    measured = new FakeHTMLElement(document);
    root.append(measured);
    measuredId = registry.ensureElementId(measured);
    firstPacket = {
      revision: 1,
      generation: 1,
      viewport: { scrollX: 2, scrollY: 3, width: 320, height: 640 },
      boxes: [{
        id: measuredId,
        kind: 'box',
        x: 12,
        y: 23,
        width: 40,
        height: 50,
        clientLeft: 1,
        clientTop: 2,
        clientWidth: 38,
        clientHeight: 47,
        offsetWidth: 42,
        offsetHeight: 53,
      }],
    };
    const update = layout.update(firstPacket);
    assert.equal(update.ok, true);
    assert.equal(update.revision, 1);
    assert.equal(update.generation, 1);
    assert.equal(layout.needsLayout(), false);
    assert.equal(layout.status().required, false);
    assert.equal(layout.hasCurrentBox(measured), true);
    assert.equal(JSON.stringify(layout.viewport()), JSON.stringify(firstPacket.viewport));
  });

  await t.test('returns viewport rects, array-like client rects, and cached metrics', () => {
    const rect = measured.getBoundingClientRect();
    assert.equal(rect.x, 10);
    assert.equal(rect.y, 20);
    assert.equal(rect.width, 40);
    assert.equal(rect.height, 50);
    assert.equal(rect.left, 10);
    assert.equal(rect.top, 20);
    assert.equal(rect.right, 50);
    assert.equal(rect.bottom, 70);
    assert.equal(JSON.stringify(rect.toJSON()), JSON.stringify({
      x: 10,
      y: 20,
      width: 40,
      height: 50,
      top: 20,
      right: 50,
      bottom: 70,
      left: 10,
    }));
    rect.x = 999;
    assert.equal(measured.getBoundingClientRect().x, 10, 'rect snapshots must not mutate the cached measurement');

    const clientRects = measured.getClientRects();
    assert.equal(clientRects.length, 1);
    assert.equal(clientRects.item(0).x, 10);
    assert.equal(clientRects.item(1), null);
    assert.equal([...clientRects].length, 1);
    assert.equal(measured.clientLeft, 1);
    assert.equal(measured.clientTop, 2);
    assert.equal(measured.clientWidth, 38);
    assert.equal(measured.clientHeight, 47);
    assert.equal(measured.offsetWidth, 42);
    assert.equal(measured.offsetHeight, 53);
    assert.equal(layout.DOMRect.name, 'DOMRect');
    assert.equal(layout.DOMRectReadOnly.name, 'DOMRectReadOnly');
  });

  await t.test('filters internal attributes and reports stale and unmeasured geometry', () => {
    observer.deliver([{ type: 'attributes', attributeName: 'data-pirc-script-id' }]);
    assert.equal(layout.revision(), 1, 'internal bridge attributes must not invalidate layout');
    observer.deliver([
      { type: 'attributes', attributeName: 'style' },
      { type: 'characterData', attributeName: null },
    ]);
    assert.equal(layout.revision(), 2, 'one observer batch advances one revision');
    assert.equal(layout.needsLayout(), true);
    assert.throws(() => measured.getBoundingClientRect(), (error) => error.name === 'NotSupportedError');
    assert.equal(diagnostics.at(-1).code, 'layout.stale');

    observer.records.push({ type: 'childList', attributeName: null });
    assert.equal(layout.revision(), 3, 'revision() must synchronously consume pending observer records');
    assert.equal(observer.records.length, 0);

    unmeasured = new FakeHTMLElement(document);
    root.append(unmeasured);
    unmeasuredId = registry.ensureElementId(unmeasured);
    layout.update({
      revision: 3,
      generation: 2,
      viewport: { scrollX: 2, scrollY: 3, width: 320, height: 640 },
      boxes: [{ ...firstPacket.boxes[0] }],
    });
    assert.throws(() => unmeasured.getBoundingClientRect(), (error) => error.name === 'NotSupportedError');
    assert.equal(diagnostics.at(-1).code, 'layout.unmeasured');
  });

  await t.test('returns empty geometry for none and rejects unsupported geometry', () => {
    noBox = new FakeHTMLElement(document);
    root.append(noBox);
    noBoxId = registry.ensureElementId(noBox);
    unsupported = new FakeHTMLElement(document);
    root.append(unsupported);
    unsupportedId = registry.ensureElementId(unsupported);
    refreshedPacket = {
      revision: 3,
      generation: 3,
      viewport: { scrollX: 10, scrollY: 20, width: 320, height: 640 },
      boxes: [
        { ...firstPacket.boxes[0] },
        { id: unmeasuredId, kind: 'box', x: 5, y: 6, width: 7, height: 8 },
        { id: noBoxId, kind: 'none' },
        { id: unsupportedId, kind: 'unsupported' },
      ],
    };
    assert.equal(layout.update(refreshedPacket).generation, 3);
    assert.equal(noBox.getBoundingClientRect().width, 0);
    assert.equal(noBox.getClientRects().length, 0);
    assert.equal(noBox.clientWidth, 0);
    assert.equal(noBox.offsetHeight, 0);
    assert.equal(layout.hasCurrentBox(noBox), true);
    assert.throws(() => unsupported.getBoundingClientRect(), (error) => error.name === 'NotSupportedError');
    assert.equal(diagnostics.at(-1).code, 'layout.unavailable');
  });

  await t.test('validates packets atomically, including identity, revisions, generations, and bounds', () => {
    const cacheBeforeReject = measured.getBoundingClientRect().x;
    assert.throws(
      () => layout.update({ ...refreshedPacket, generation: 3, boxes: [refreshedPacket.boxes[0], refreshedPacket.boxes[0]] }),
      (error) => error.name === 'TypeError',
      'duplicate IDs must reject the entire packet',
    );
    assert.equal(measured.getBoundingClientRect().x, cacheBeforeReject, 'rejected packets must leave the snapshot intact');
    assert.throws(() => layout.update({ ...refreshedPacket, revision: 2, generation: 3 }), (error) =>
      error.name === 'RangeError' && error.code === 'PIRC_LAYOUT_STALE_REVISION',
    'stale revisions must reject with a marker the runtime can recover from');
    assert.throws(() => layout.update({ ...refreshedPacket, generation: 2 }), (error) => error.name === 'RangeError', 'generations must increase');
    assert.throws(() => layout.update({ ...refreshedPacket, generation: 3, boxes: new Array(5001) }), (error) => error.name === 'RangeError', 'packets are capped at 5000 boxes');
    assert.throws(
      () => layout.update({ ...refreshedPacket, generation: 3, boxes: [{ id: 'pirc-9000', kind: 'box', x: 0, y: 0, width: 1, height: 1 }] }),
      (error) => error.name === 'TypeError',
      'unknown IDs must not be looked up from DOM id attributes',
    );
    assert.throws(
      () => layout.update({ ...refreshedPacket, generation: 3, boxes: [{ ...refreshedPacket.boxes[0], width: -1 }] }),
      (error) => error.name === 'RangeError',
      'negative sizes must be rejected',
    );
    assert.throws(
      () => layout.update({ ...refreshedPacket, generation: 3, boxes: [{ ...refreshedPacket.boxes[0], x: Infinity }] }),
      (error) => error.name === 'TypeError',
      'non-finite coordinates must be rejected',
    );
    assert.throws(
      () => layout.update({ ...refreshedPacket, generation: 3, boxes: [{ id: noBoxId, kind: 'none', width: -1 }] }),
      (error) => error.name === 'RangeError',
      'provided bounds must be validated for every box kind',
    );

    const foreignDoc = makeDocument();
    const foreignElement = new FakeHTMLElement(foreignDoc.document);
    const foreignId = 'pirc-9001';
    registry.ids.set(foreignElement, foreignId);
    registry.elements.set(foreignId, foreignElement);
    assert.throws(
      () => layout.update({ ...refreshedPacket, generation: 3, boxes: [{ id: foreignId, kind: 'box', x: 0, y: 0, width: 1, height: 1 }] }),
      (error) => error.name === 'TypeError',
      'IDs resolving to foreign document elements must be rejected',
    );
  });

  await t.test('binds native scroll coordinates to global and window aliases', () => {
    const installScroll = extractRuntimeFunction(
      'installNativeScrollPositionGlobals',
      '  function installDomGlobals(',
      { Element$1: FakeElement },
    );
    const windowObject = {};
    const globalObject = {};
    installScroll(windowObject, globalObject, {
      viewport: () => ({ scrollX: 12.5, scrollY: 31, width: 390, height: 844 }),
      setScrollActionQueue() {},
      queueElementScrollAction() {},
    });
    for (const [object, expected] of [[windowObject, [12.5, 31, 12.5, 31]], [globalObject, [12.5, 31, 12.5, 31]]]) {
      assert.deepEqual(
        ['scrollX', 'scrollY', 'pageXOffset', 'pageYOffset'].map((name) => object[name]),
        expected,
      );
    }
  });

  await t.test('queues native scroll actions with CSSOM overload and default-axis behavior', () => {
    const diagnostics = [];
    const state = { scrollActions: [], nextScrollActionId: 1 };
    const installScroll = extractRuntimeFunction(
      'installNativeScrollPositionGlobals',
      '  function installDomGlobals(',
      {
        activeState: state,
        Element$1: FakeElement,
        MAX_PENDING_SCROLL_ACTIONS: 128,
        diagnostic: (code, severity, message, detail) => diagnostics.push({ code, severity, message, detail }),
      },
    );
    const windowObject = {};
    const globalObject = {};
    let scrollQueue;
    const element = Object.assign(Object.create(FakeElement.prototype), { id: 'pirc-9' });
    const layout = {
      viewport: () => ({ scrollX: 12.5, scrollY: 31, width: 390, height: 844 }),
      setScrollActionQueue(callback) { scrollQueue = callback; },
      queueElementScrollAction(target, kind, x, y, behavior) {
        scrollQueue({ id: target.id }, kind, x, y, behavior);
      },
    };
    installScroll(windowObject, globalObject, layout);

    assert.equal(typeof windowObject.scroll, 'function');
    assert.equal(windowObject.scroll, windowObject.scrollTo);
    assert.equal(typeof windowObject.scrollBy, 'function');
    assert.equal(element.scroll, element.scrollTo);
    windowObject.scroll({ top: 45.5, behavior: 'smooth' });
    globalObject.scrollBy({ left: 7 });
    windowObject.scrollBy(2, 3);
    windowObject.scrollTo(NaN, Infinity);
    windowObject.scrollTo(20);
    element.scrollTo({ top: 12 });
    element.scrollBy({ left: 3 });
    assert.deepEqual(JSON.parse(JSON.stringify(state.scrollActions)), [
      { actionId: 1, kind: 'to', x: null, y: 45.5, behavior: 'smooth' },
      { actionId: 2, kind: 'by', x: 7, y: 0, behavior: 'auto' },
      { actionId: 3, kind: 'by', x: 2, y: 3, behavior: 'auto' },
      { actionId: 4, kind: 'to', x: 0, y: 0, behavior: 'auto' },
      { actionId: 5, kind: 'to', x: null, y: 12, behavior: 'auto', elementId: 'pirc-9' },
      { actionId: 6, kind: 'by', x: 3, y: 0, behavior: 'auto', elementId: 'pirc-9' },
    ], 'viewport and target-owned actions preserve omitted axes and use monotonic IDs');
    assert.throws(() => windowObject.scrollTo({ top: 1, behavior: 'instantaneous' }), (error) => error.name === 'TypeError');
    assert.throws(() => windowObject.scrollBy(1n, 0), (error) => error.name === 'TypeError');

    while (state.scrollActions.length < 128) windowObject.scrollBy(1, 0);
    windowObject.scrollBy(1, 0);
    assert.equal(state.scrollActions.length, 128, 'pending native scroll actions are bounded');
    assert.equal(diagnostics.filter(({ code }) => code === 'layout.scroll_action_limit').length, 1);
  });

  await t.test('returns a fresh response for stale layout packets without resuming scripts', () => {
    const trace = [];
    const state = {
      hostLayout: true,
      layout: {
        update: () => { throw Object.assign(new RangeError('stale'), { code: 'PIRC_LAYOUT_STALE_REVISION' }); },
        revision: () => 8,
      },
      classicScriptTasks: [],
      readyModuleScripts: [],
    };
    const update = extractRuntimeFunction('updateLayout', '  const api = Object.freeze({', {
      activeState: state,
      response: (extra) => {
        trace.push('response');
        return { layout: { revision: 8, required: true }, ...extra };
      },
      continueDeferredScripts: () => trace.push('deferred'),
      dispatchDOMContentLoadedIfReady: () => trace.push('dcl'),
      layoutNeedsUpdate: () => { throw new Error('stale packet should return before layout barriers'); },
      executeModuleScript: () => trace.push('module'),
      dispatchDocumentLoadIfReady: () => trace.push('load'),
    });
    const result = update({ revision: 7, generation: 1 });
    assert.equal(result.layoutAccepted, false);
    assert.deepEqual(result.layout, { revision: 8, required: true });
    assert.deepEqual(trace, ['response']);
  });

  await t.test('invalidates an image layout before completion dispatches its callback', () => {
    const trace = [];
    const completeImage = extractRuntimeFunction('completeImageResource', '  function completeResource(', {
      response: (extra) => extra,
    });
    const state = {
      pendingImageRequests: new Set(['image-1']),
      layout: { invalidate: () => trace.push('invalidate') },
      images: {
        complete: () => { trace.push('callback'); return true; },
      },
    };
    const result = completeImage(state, 'image-1', { id: 'image-1', ok: true });
    assert.deepEqual(trace, ['invalidate', 'callback']);
    assert.equal(result.resourceId, 'image-1');
    assert.equal(result.resourceKind, 'image');
    assert.equal(result.resourceIgnored, false);
  });

  await t.test('uses the native viewport for standards-mode documentElement client metrics', () => {
    class StandardsElement extends FakeElement {}
    class StandardsHTMLElement extends StandardsElement {}
    const standardsDoc = makeDocument(StandardsHTMLElement);
    standardsDoc.document.doctype = { name: 'html', publicId: '', systemId: '' };
    const standardsRegistry = makeRegistry();
    const standardsLayout = createLayout({
      document: standardsDoc.document,
      Element: StandardsElement,
      HTMLElement: StandardsHTMLElement,
      MutationObserver: FakeMutationObserver,
      ensureElementId: standardsRegistry.ensureElementId,
      resolveElementId: standardsRegistry.resolveElementId,
      diagnostic: (code, details) => diagnostics.push({ code, details }),
      enabled: true,
    });
    standardsLayout.install();
    const rootId = standardsRegistry.ensureElementId(standardsDoc.root);
    standardsLayout.update({
      revision: 1,
      generation: 1,
      viewport: { scrollX: 0, scrollY: 0, width: 390, height: 844 },
      boxes: [{
        id: rootId,
        kind: 'box',
        x: 0,
        y: 0,
        width: 390,
        height: 8,
        clientLeft: 4,
        clientTop: 5,
        clientWidth: 384,
        clientHeight: 6,
        offsetWidth: 398,
        offsetHeight: 16,
      }],
    });
    assert.equal(standardsDoc.root.clientLeft, 0);
    assert.equal(standardsDoc.root.clientTop, 0);
    assert.equal(standardsDoc.root.clientWidth, 390);
    assert.equal(standardsDoc.root.clientHeight, 844);
    const rect = standardsDoc.root.getBoundingClientRect();
    assert.equal(rect.height, 8, 'root bounding rect must remain the measured element box');
    assert.equal(standardsDoc.root.offsetWidth, 398, 'offset metrics remain native element metrics');
  });

  await t.test('reports quirks root viewport metrics without inventing them', () => {
    class QuirksElement extends FakeElement {}
    class QuirksHTMLElement extends QuirksElement {}
    const quirksDoc = makeDocument(QuirksHTMLElement);
    const quirksRegistry = makeRegistry();
    const quirksDiagnostics = [];
    const quirksLayout = createLayout({
      document: quirksDoc.document,
      Element: QuirksElement,
      HTMLElement: QuirksHTMLElement,
      MutationObserver: FakeMutationObserver,
      ensureElementId: quirksRegistry.ensureElementId,
      resolveElementId: quirksRegistry.resolveElementId,
      diagnostic: (code, details) => quirksDiagnostics.push({ code, details }),
      enabled: true,
    });
    quirksLayout.install();
    const rootId = quirksRegistry.ensureElementId(quirksDoc.root);
    quirksLayout.update({
      revision: 1,
      generation: 1,
      viewport: { scrollX: 0, scrollY: 0, width: 390, height: 844 },
      boxes: [{ id: rootId, kind: 'box', x: 0, y: 0, width: 390, height: 8, clientWidth: 384, clientHeight: 6 }],
    });
    assert.equal(quirksDoc.root.clientWidth, 384);
    assert.equal(quirksDoc.root.clientHeight, 6);
    assert.equal(quirksDiagnostics.filter(({ code }) => code === 'layout.quirks_root_viewport_unavailable').length, 2);
  });

  await t.test('uses native scrolling-area extents only for a standards-mode root', () => {
    class ExtentElement extends FakeElement {}
    class ExtentHTMLElement extends ExtentElement {}
    const extentDoc = makeDocument(ExtentHTMLElement);
    extentDoc.document.doctype = { name: 'html', publicId: '', systemId: '' };
    const extentRegistry = makeRegistry();
    const extentLayout = createLayout({
      document: extentDoc.document,
      Element: ExtentElement,
      HTMLElement: ExtentHTMLElement,
      MutationObserver: FakeMutationObserver,
      ensureElementId: extentRegistry.ensureElementId,
      resolveElementId: extentRegistry.resolveElementId,
      enabled: true,
    });
    extentLayout.install();
    const child = new ExtentHTMLElement(extentDoc.document);
    extentDoc.root.append(child);
    const rootId = extentRegistry.ensureElementId(extentDoc.root);
    const childId = extentRegistry.ensureElementId(child);
    const packet = {
      revision: 1,
      generation: 1,
      viewport: { scrollX: 0, scrollY: 0, width: 390, height: 844, contentWidth: 500.75, contentHeight: 1000.75 },
      boxes: [
        { id: rootId, kind: 'box', x: 0, y: 0, width: 390, height: 844 },
        { id: childId, kind: 'box', x: 0, y: 844, width: 20, height: 20 },
      ],
    };
    extentLayout.update(packet);
    assert.equal(extentDoc.root.scrollWidth, 501);
    assert.equal(extentDoc.root.scrollHeight, 1001);
    assert.throws(() => child.scrollHeight, (error) => error.name === 'NotSupportedError',
      'native viewport extents cannot stand in for an arbitrary element scroll area');
    assert.throws(() => extentLayout.update({
      ...packet,
      generation: 2,
      viewport: { ...packet.viewport, contentHeight: NaN },
    }), (error) => error.name === 'TypeError', 'native content extents must be finite');
    assert.equal(extentDoc.root.scrollHeight, 1001, 'a rejected extent packet must leave the accepted snapshot intact');

    extentLayout.update({
      revision: 1,
      generation: 2,
      viewport: { scrollX: 0, scrollY: 0, width: 390, height: 844 },
      boxes: packet.boxes,
    });
    assert.throws(() => extentDoc.root.scrollHeight, (error) => error.name === 'NotSupportedError',
      'root scroll extents stay unavailable when the host did not provide them');
  });

  await t.test('validates native element scroll metadata, event sequence, and atomicity', () => {
    class ScrollElement extends FakeElement {}
    class ScrollHTMLElement extends ScrollElement {}
    const scrollDoc = makeDocument(ScrollHTMLElement);
    const scrollRegistry = makeRegistry();
    const scrollLayout = createLayout({
      document: scrollDoc.document,
      Element: ScrollElement,
      HTMLElement: ScrollHTMLElement,
      MutationObserver: FakeMutationObserver,
      ensureElementId: scrollRegistry.ensureElementId,
      resolveElementId: scrollRegistry.resolveElementId,
      enabled: true,
    });
    scrollLayout.install();
    const observer = FakeMutationObserver.instances.at(-1);
    const outer = new ScrollHTMLElement(scrollDoc.document);
    const inner = new ScrollHTMLElement(scrollDoc.document);
    scrollDoc.root.append(outer);
    outer.append(inner);
    const outerId = scrollRegistry.ensureElementId(outer);
    const innerId = scrollRegistry.ensureElementId(inner);
    const packet = (generation, outerTop, innerTop, scrollEvents) => ({
      revision: 1,
      generation,
      viewport: { scrollX: 0, scrollY: 0, width: 390, height: 844 },
      boxes: [
        { id: outerId, kind: 'box', x: 0, y: 0, width: 100, height: 100,
          scroll: { left: 0, top: outerTop, width: 100, height: 500 } },
        { id: innerId, kind: 'box', x: 0, y: 0, width: 50, height: 50,
          scroll: { left: 0, top: innerTop, width: 50, height: 250 } },
      ],
      ...(scrollEvents === undefined ? {} : { scrollEvents }),
    });

    scrollLayout.update(packet(1, 0, 0));
    assert.equal(outer.scrollTop, 0);
    assert.equal(inner.scrollHeight, 250);
    const accepted = scrollLayout.update(packet(2, 60, 25, [
      { id: innerId, sequence: 1 },
      { id: outerId, sequence: 2 },
      { id: innerId, sequence: 3 },
    ]));
    assert.deepEqual(JSON.parse(JSON.stringify(accepted.scrollEvents.map(({ id, sequence }) => [id, sequence]))), [
      [innerId, 1], [outerId, 2], [innerId, 3],
    ], 'native target ordering is retained in the accepted packet');
    assert.deepEqual(JSON.parse(JSON.stringify(accepted.scrollChanges.map(({ id, top }) => [id, top]))), [
      [outerId, 60], [innerId, 25],
    ], 'position fallback exposes native changed offsets without fabricating geometry');
    assert.equal(inner.scrollTop, 25);
    assert.equal(outer.scrollTop, 60);

    assert.throws(() => scrollLayout.update(packet(3, 65, 30, [
      { id: innerId, sequence: 4 }, { id: outerId, sequence: 4 },
    ])), (error) => error.name === 'RangeError', 'sequences inside a packet must strictly increase');
    assert.throws(() => scrollLayout.update({
      ...packet(3, 65, 30), scrollEvents: [{ id: 'pirc-9000', sequence: 4 }],
    }), (error) => error.name === 'TypeError', 'events cannot target unknown IDs');
    assert.equal(inner.scrollTop, 25, 'rejected event packets cannot replace the accepted snapshot');
    const replay = scrollLayout.update(packet(3, 60, 25, [
      { id: innerId, sequence: 1 },
    ]));
    assert.equal(replay.scrollEvents[0].sequence, 1,
      'fresh native view counters may restart while the script context survives');
    assert.equal(replay.scrollChanges.length, 0, 'replayed event metadata at unchanged offsets is idempotent');
    const resetCounterMovement = scrollLayout.update(packet(4, 70, 35, [
      { id: innerId, sequence: 1 },
    ]));
    assert.deepEqual(JSON.parse(JSON.stringify(resetCounterMovement.scrollChanges.map(({ id, top }) => [id, top]))), [
      [outerId, 70], [innerId, 35],
    ], 'position changes still dispatch when a remounted native view resets its sequence');

    const detached = new ScrollHTMLElement(scrollDoc.document);
    scrollDoc.root.append(detached);
    const detachedId = scrollRegistry.ensureElementId(detached);
    scrollDoc.root.remove(detached);
    assert.throws(() => scrollLayout.update({
      revision: 1,
      generation: 5,
      viewport: { scrollX: 0, scrollY: 0, width: 390, height: 844 },
      boxes: [
        { id: detachedId, kind: 'box', x: 0, y: 0, width: 1, height: 1,
          scroll: { left: 0, top: 1, width: 1, height: 2 } },
      ],
      scrollEvents: [{ id: detachedId, sequence: 4 }],
    }), (error) => error.name === 'TypeError',
    'native scroll events cannot target detached nodes even if the packet includes their ID');

    outer.remove(inner);
    observer.deliver([{ type: 'childList', attributeName: null }]);
    assert.throws(() => scrollLayout.update(packet(5, 60, 25, [
      { id: innerId, sequence: 1 },
    ])), (error) => error.code === 'PIRC_LAYOUT_STALE_REVISION',
    'a packet raced by a tree mutation returns the stale-revision marker before detached event validation');
    assert.equal(scrollLayout.status().required, true);
  });

  await t.test('queues connected element scroll intents without requiring current geometry', () => {
    class ActionElement extends FakeElement {}
    class ActionHTMLElement extends ActionElement {}
    const actionDoc = makeDocument(ActionHTMLElement);
    const actionRegistry = makeRegistry();
    const actionLayout = createLayout({
      document: actionDoc.document,
      Element: ActionElement,
      HTMLElement: ActionHTMLElement,
      MutationObserver: FakeMutationObserver,
      ensureElementId: actionRegistry.ensureElementId,
      resolveElementId: actionRegistry.resolveElementId,
      enabled: true,
    });
    actionLayout.install();
    const observer = FakeMutationObserver.instances.at(-1);
    const target = new ActionHTMLElement(actionDoc.document);
    const none = new ActionHTMLElement(actionDoc.document);
    actionDoc.root.append(target);
    actionDoc.root.append(none);
    const targetId = actionRegistry.ensureElementId(target);
    const noneId = actionRegistry.ensureElementId(none);
    actionLayout.update({
      revision: 1,
      generation: 1,
      viewport: { scrollX: 0, scrollY: 0, width: 390, height: 844 },
      boxes: [
        { id: targetId, kind: 'box', x: 0, y: 0, width: 20, height: 20 },
        { id: noneId, kind: 'none' },
      ],
    });
    const queued = [];
    actionLayout.setScrollActionQueue((...values) => queued.push(values));
    assert.equal(actionLayout.queueElementScrollAction(target, 'to', null, 24, 'auto'), true);
    assert.deepEqual(JSON.parse(JSON.stringify(queued.at(-1))), [{ id: targetId }, 'to', null, 24, 'auto']);
    assert.equal(actionLayout.queueElementScrollAction(none, 'to', null, 5, 'auto'), false,
      'a current native-confirmed no-box target is a no-op');

    observer.deliver([{ type: 'attributes', attributeName: 'style' }]);
    assert.equal(actionLayout.queueElementScrollAction(none, 'to', null, 5, 'auto'), true,
      'a stale no-box result does not suppress mutation-then-scroll intent');
    const added = new ActionHTMLElement(actionDoc.document);
    actionDoc.root.append(added);
    observer.deliver([{ type: 'childList', attributeName: null }]);
    assert.equal(actionLayout.queueElementScrollAction(added, 'by', 2, 7, 'smooth'), true,
      'newly appended unmeasured nodes can queue a scroll for their first native frame');
    const addedId = actionRegistry.ensureElementId(added);
    assert.deepEqual(JSON.parse(JSON.stringify(queued.at(-1))), [{ id: addedId }, 'by', 2, 7, 'smooth']);

    actionDoc.root.remove(target);
    assert.equal(actionLayout.queueElementScrollAction(target, 'to', 0, 0, 'auto'), false,
      'detached same-document nodes do not create host actions');
    const foreign = new ActionHTMLElement(makeDocument(ActionHTMLElement).document);
    assert.throws(() => actionLayout.queueElementScrollAction(foreign, 'to', 0, 0, 'auto'),
      (error) => error.name === 'TypeError');
  });

  await t.test('preserves guest invalidations around repeated internal document snapshots', () => {
    observer.records.push({ type: 'attributes', attributeName: 'style' });
    layout.runWithoutMutationInvalidation(() => {
      observer.records.push({ type: 'childList', attributeName: null });
      return 'snapshot';
    });
    assert.equal(layout.revision(), 4, 'the guest mutation before snapshot must invalidate once');
    assert.equal(observer.records.length, 0, 'internal clone records must not leak to a later observer callback');

    for (let index = 0; index < 3; index += 1) {
      layout.runWithoutMutationInvalidation(() => {
        observer.records.push({ type: 'childList', attributeName: null });
      });
    }
    assert.equal(layout.revision(), 4, 'no-op snapshots must keep the revision stable');
    observer.deliver([{ type: 'characterData', attributeName: null }]);
    assert.equal(layout.revision(), 5, 'a guest text mutation after snapshot must still invalidate');
  });

  await t.test('returns zero geometry for detached nodes and throws when parity is disabled', () => {
    root.remove(measured);
    assert.equal(measured.getBoundingClientRect().x, 0, 'detached elements use browser zero geometry');
    assert.equal(measured.getClientRects().length, 0);
    assert.equal(measured.clientWidth, 0);
    assert.equal(measured.offsetWidth, 0);

    class DisabledElement extends FakeElement {}
    class DisabledHTMLElement extends DisabledElement {}
    const disabledDoc = makeDocument(DisabledHTMLElement);
    const disabledRegistry = makeRegistry();
    const disabledLayout = createLayout({
      document: disabledDoc.document,
      Element: DisabledElement,
      HTMLElement: DisabledHTMLElement,
      MutationObserver: FakeMutationObserver,
      ensureElementId: disabledRegistry.ensureElementId,
      resolveElementId: disabledRegistry.resolveElementId,
      enabled: false,
    });
    disabledLayout.install();
    const disabledConnected = new DisabledHTMLElement(disabledDoc.document);
    disabledDoc.root.append(disabledConnected);
    assert.throws(() => disabledConnected.getBoundingClientRect(), (error) => error.name === 'NotSupportedError');
    assert.throws(() => disabledConnected.clientWidth, (error) => error.name === 'NotSupportedError');
  });
});
