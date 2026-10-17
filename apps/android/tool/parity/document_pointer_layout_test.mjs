import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const pointerSource = readFileSync(
  new URL('./document_pointer_source.js', import.meta.url),
  'utf8',
);
const layoutSource = readFileSync(
  new URL('./document_layout_source.js', import.meta.url),
  'utf8',
);
const runtimeSource = readFileSync(
  new URL('./document_script_runtime_source.js', import.meta.url),
  'utf8',
);

function extractRuntimeFunction(name, nextMarker, bindings = {}) {
  const start = runtimeSource.indexOf(`  function ${name}(`);
  const end = runtimeSource.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, `could not find runtime function ${name}`);
  const context = vm.createContext(bindings);
  vm.runInContext(`${runtimeSource.slice(start, end)}\nthis.__testedFunction = ${name};`, context);
  return context.__testedFunction;
}

function defineEventMember(event, name, value) {
  Object.defineProperty(event, name, {
    value,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

class FakeEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
}

class FakeUIEvent extends FakeEvent {
  constructor(type, init = {}) {
    super(type, init);
    defineEventMember(this, 'view', init.view ?? null);
    defineEventMember(this, 'detail', Number.isFinite(init.detail) ? init.detail : 0);
  }
}

class FakeElement {
  constructor(ownerDocument, localName = 'div') {
    this.ownerDocument = ownerDocument;
    this.localName = localName;
    this.tagName = localName.toUpperCase();
    this.parentNode = null;
    this.childNodes = [];
    this.listeners = new Map();
    this.isConnected = true;
  }

  append(child) {
    child.parentNode = this;
    this.childNodes.push(child);
  }

  contains(node) {
    return node === this || this.childNodes.some((child) => child.contains(node));
  }

  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    event.target = this;
    event.currentTarget = this;
    for (const callback of this.listeners.get(event.type) || []) callback.call(this, event);
    event.currentTarget = null;
    return !event.defaultPrevented;
  }
}

class FakeHTMLElement extends FakeElement {}
class FakeCanvas extends FakeHTMLElement {
  constructor(ownerDocument) {
    super(ownerDocument, 'canvas');
  }
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
  }

  observe() {}
  takeRecords() { return []; }
}

class FakeDocument {
  constructor() {
    this.defaultView = {
      HTMLElement: FakeHTMLElement,
      HTMLCanvasElement: FakeCanvas,
    };
    this.documentElement = new FakeHTMLElement(this, 'html');
  }

  createElement(name) {
    return String(name).toLowerCase() === 'canvas'
      ? new FakeCanvas(this)
      : new FakeHTMLElement(this, String(name).toLowerCase());
  }

  contains(node) {
    return this.documentElement.contains(node);
  }
}

function createEnvironment() {
  const pointerContext = vm.createContext({ DOMException });
  vm.runInContext(
    `${pointerSource}\nthis.__createDocumentPointer = createDocumentPointer;`,
    pointerContext,
  );
  const layoutContext = vm.createContext({ DOMException });
  vm.runInContext(
    `${layoutSource}\nthis.__createPircDocumentLayout = createPircDocumentLayout;`,
    layoutContext,
  );
  const installCanvasLayoutGeometry = extractRuntimeFunction(
    'installCanvasLayoutGeometry',
    '\n  function installDomGlobals',
  );

  const document = new FakeDocument();
  const first = document.createElement('canvas');
  const second = document.createElement('canvas');
  document.documentElement.append(first);
  document.documentElement.append(second);
  const ids = new WeakMap();
  const elements = new Map();
  let nextId = 1;
  const ensureElementId = (element) => {
    let id = ids.get(element);
    if (!id) {
      id = `pirc-${nextId++}`;
      ids.set(element, id);
      elements.set(id, element);
    }
    return id;
  };
  const resolveElementId = (id) => elements.get(id);
  const layout = layoutContext.__createPircDocumentLayout({
    document,
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    MutationObserver: FakeMutationObserver,
    ensureElementId,
    resolveElementId,
    enabled: true,
  });
  const pointer = pointerContext.__createDocumentPointer({
    document,
    HTMLElement: FakeHTMLElement,
    UIEvent: FakeUIEvent,
    defineEventMember,
  });
  pointer.install();
  layout.install();
  assert.equal(installCanvasLayoutGeometry(document, pointer, layout), true);

  const firstId = ensureElementId(first);
  const secondId = ensureElementId(second);
  function measure(revision, generation, firstBox, secondBox) {
    layout.update({
      revision,
      generation,
      viewport: { scrollX: 0, scrollY: 0, width: 320, height: 640 },
      boxes: [
        { id: firstId, kind: 'box', ...firstBox },
        { id: secondId, kind: 'box', ...secondBox },
      ],
    });
  }
  return { document, first, second, layout, pointer, measure };
}

function pointerData(pointerId, geometry) {
  return {
    pointerId,
    pointerType: 'mouse',
    isPrimary: true,
    clientX: geometry.left + 4,
    clientY: geometry.top + 5,
    offsetX: 4,
    offsetY: 5,
    button: 0,
    buttons: 1,
    geometry,
  };
}

test('native canvas rect remains available through pointer and compatibility handlers only for its event scope', () => {
  const { first: canvas, layout, pointer, measure } = createEnvironment();
  const hostRect = { left: 24, top: 32, width: 300, height: 150 };
  const nextEventRect = { left: 36, top: 48, width: 300, height: 150 };
  measure(1, 1, { x: 24, y: 32, width: 300, height: 150 }, { x: 400, y: 20, width: 80, height: 60 });
  const reads = [];
  canvas.addEventListener('pointerdown', () => {
    reads.push(canvas.getBoundingClientRect().toJSON());
    layout.invalidate();
    // The native event's fresh rect remains valid for the remainder of this
    // synchronous event even though its handler has made the layout stale.
    reads.push(canvas.getBoundingClientRect().toJSON());
  });
  canvas.addEventListener('mousedown', () => {
    reads.push(canvas.getBoundingClientRect().toJSON());
  });
  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
  });
  let captureRect;
  canvas.addEventListener('gotpointercapture', () => {
    captureRect = canvas.getBoundingClientRect();
  });

  pointer.dispatch(canvas, 'pointerdown', pointerData(1, hostRect));
  assert.deepEqual(JSON.parse(JSON.stringify(reads)), [
    { x: 24, y: 32, width: 300, height: 150, top: 32, right: 324, bottom: 182, left: 24 },
    { x: 24, y: 32, width: 300, height: 150, top: 32, right: 324, bottom: 182, left: 24 },
    { x: 24, y: 32, width: 300, height: 150, top: 32, right: 324, bottom: 182, left: 24 },
  ]);
  assert.equal(pointer.nativeCanvasRect(canvas), null);
  assert.throws(() => canvas.getBoundingClientRect(), { name: 'NotSupportedError' });

  pointer.dispatch(canvas, 'pointermove', pointerData(1, nextEventRect));
  assert.equal(captureRect.x, nextEventRect.left, 'capture events use the current native event rect');
  assert.throws(() => canvas.getBoundingClientRect(), { name: 'NotSupportedError' });

  measure(2, 3, { x: 90, y: 100, width: 77, height: 66 }, { x: 400, y: 20, width: 80, height: 60 });
  assert.deepEqual(JSON.parse(JSON.stringify(canvas.getBoundingClientRect().toJSON())), {
    x: 90, y: 100, width: 77, height: 66,
    top: 100, right: 167, bottom: 166, left: 90,
  });
});

test('nested pointer scopes are LIFO, canvas-owned, and revoked after exceptions', () => {
  const { first, second, layout, pointer, measure } = createEnvironment();
  const firstRect = { left: 10, top: 20, width: 100, height: 80 };
  const secondRect = { left: 200, top: 220, width: 70, height: 60 };
  measure(1, 1, { x: 10, y: 20, width: 100, height: 80 }, { x: 200, y: 220, width: 70, height: 60 });
  let nestedRead;
  first.addEventListener('pointerdown', () => {
    assert.equal(first.getBoundingClientRect().x, 10);
    layout.invalidate();
    assert.throws(() => second.getBoundingClientRect(), { name: 'NotSupportedError' });
    pointer.dispatch(second, 'pointermove', pointerData(2, secondRect));
    assert.equal(first.getBoundingClientRect().x, 10, 'outer scope resumes after nested dispatch');
    assert.throws(() => second.getBoundingClientRect(), { name: 'NotSupportedError' });
  });
  second.addEventListener('pointermove', () => {
    assert.equal(first.getBoundingClientRect().x, 10, 'another canvas never borrows the inner rect');
    const secondX = second.getBoundingClientRect().x;
    assert.equal(secondX, 200);
    nestedRead = { first: first.getBoundingClientRect().x, second: secondX };
  });
  pointer.dispatch(first, 'pointerdown', pointerData(1, firstRect));
  assert.deepEqual(nestedRead, { first: 10, second: 200 });
  assert.throws(() => first.getBoundingClientRect(), { name: 'NotSupportedError' });
  assert.throws(() => second.getBoundingClientRect(), { name: 'NotSupportedError' });

  assert.throws(() => pointer.withNativeDispatchGeometry(first, pointerData(3, firstRect), () => {
    assert.equal(first.getBoundingClientRect().x, 10);
    throw new Error('handler failure');
  }), /handler failure/);
  assert.throws(() => first.getBoundingClientRect(), { name: 'NotSupportedError' });
});

test('native click scope covers delegated canvas handlers and expires immediately', () => {
  const { first: canvas, layout, pointer, measure } = createEnvironment();
  const hostRect = { left: 40, top: 50, width: 90, height: 80 };
  measure(1, 1, { x: 40, y: 50, width: 90, height: 80 }, { x: 400, y: 20, width: 80, height: 60 });
  let clickRect;
  canvas.addEventListener('click', () => {
    clickRect = canvas.getBoundingClientRect();
    layout.invalidate();
    assert.equal(canvas.getBoundingClientRect().width, 90);
  });
  const event = pointer.createClickEvent(pointerData(4, hostRect), { bubbles: true, cancelable: true }, canvas);
  pointer.withNativeDispatchGeometry(canvas, pointerData(4, hostRect), () => canvas.dispatchEvent(event));
  assert.equal(clickRect.width, 90);
  assert.throws(() => canvas.getBoundingClientRect(), { name: 'NotSupportedError' });
});
