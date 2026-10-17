import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const sourcePath = fileURLToPath(
  new URL('./document_pointer_source.js', import.meta.url),
);
const source = readFileSync(sourcePath, 'utf8');

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
    this.eventPhase = 0;
    this._stopped = false;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation() {
    this._stopped = true;
  }
}

class FakeUIEvent extends FakeEvent {
  constructor(type, init = {}) {
    super(type, init);
    defineEventMember(this, 'view', init.view ?? null);
    defineEventMember(this, 'detail', Number.isFinite(init.detail) ? init.detail : 0);
  }
}

class FakeHTMLElement {
  constructor(ownerDocument, localName = 'div') {
    this.ownerDocument = ownerDocument;
    this.localName = localName;
    this.tagName = localName.toUpperCase();
    this.parentNode = null;
    this.isConnected = true;
    this.listeners = new Map();
  }

  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    event.target = this;
    const path = [this];
    let parent = this.parentNode;
    while (parent) {
      path.push(parent);
      parent = parent.parentNode;
    }
    for (let index = 0; index < path.length; index++) {
      const current = path[index];
      event.currentTarget = current;
      event.eventPhase = index === 0 ? 2 : 3;
      for (const callback of current.listeners.get(event.type) || [])
        callback.call(current, event);
      if (event._stopped || (!event.bubbles && index === 0)) break;
    }
    event.currentTarget = null;
    event.eventPhase = 0;
    return !event.defaultPrevented;
  }
}

class FakeCanvas extends FakeHTMLElement {
  constructor(ownerDocument) {
    super(ownerDocument, 'canvas');
  }
}

class FakeDocument {
  constructor() {
    this.defaultView = {
      HTMLElement: FakeHTMLElement,
      HTMLCanvasElement: FakeCanvas,
    };
  }

  createElement(name) {
    if (String(name).toLowerCase() === 'canvas') return new FakeCanvas(this);
    return new FakeHTMLElement(this, String(name).toLowerCase());
  }
}

function createRuntime() {
  const context = vm.createContext({});
  new vm.Script(source + '\nthis.__createDocumentPointer = createDocumentPointer;')
    .runInContext(context);
  const document = new FakeDocument();
  const diagnostics = [];
  const pointer = context.__createDocumentPointer({
    document,
    HTMLElement: FakeHTMLElement,
    UIEvent: FakeUIEvent,
    defineEventMember,
    diagnostic(...args) {
      diagnostics.push(args);
    },
  });
  pointer.install();
  return { pointer, document, diagnostics, createDocumentPointer: context.__createDocumentPointer };
}

function eventData(overrides = {}) {
  return {
    pointerId: 7,
    pointerType: 'mouse',
    isPrimary: true,
    clientX: 42.5,
    clientY: 31.25,
    screenX: 142,
    screenY: 231,
    offsetX: 12.5,
    offsetY: 11.25,
    movementX: 3,
    movementY: -2,
    button: 0,
    buttons: 1,
    pressure: 0.75,
    width: 4,
    height: 6,
    geometry: { left: 30, top: 20, width: 100, height: 50 },
    ...overrides,
  };
}

test('event constructors are reused and expose bounded readonly pointer fields', () => {
  const { pointer, createDocumentPointer } = createRuntime();
  const cached = createDocumentPointer.eventClasses({
    UIEvent: FakeUIEvent,
    defineEventMember,
  });
  assert.strictEqual(pointer.PointerEvent, cached.PointerEvent);
  assert.strictEqual(pointer.MouseEvent, cached.MouseEvent);

  const event = new pointer.PointerEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    pointerId: 11.8,
    pointerType: 'pen',
    isPrimary: true,
    clientX: 16.25,
    tiltX: 120,
    pressure: 2,
  });
  assert.equal(event.pointerId, 11);
  assert.equal(event.pointerType, 'pen');
  assert.equal(event.isPrimary, true);
  assert.equal(event.clientX, 16.25);
  assert.equal(event.tiltX, 90);
  assert.equal(event.pressure, 1);
  assert.equal(event.composed, false);
  assert.equal(Object.getOwnPropertyDescriptor(event, 'pointerId').writable, false);
});

test('native pointer dispatch preserves CSS coordinates and measured canvas rectangles', () => {
  const { pointer, document } = createRuntime();
  const canvas = document.createElement('canvas');
  let observed;
  let eventRect;
  canvas.addEventListener('pointermove', (event) => {
    observed = event;
    eventRect = canvas.getBoundingClientRect();
  });

  const result = pointer.dispatch(canvas, 'pointermove', eventData({ buttons: 0 }));
  assert.equal(result.defaultPrevented, false);
  assert.equal(observed.pointerId, 7);
  assert.equal(observed.pointerType, 'mouse');
  assert.equal(observed.clientX, 42.5);
  assert.equal(observed.offsetX, 12.5);
  assert.equal(observed.movementX, 3);
  assert.equal(observed.button, 0);
  assert.equal(observed.buttons, 0);
  assert.equal(observed.composed, true);

  const rect = eventRect;
  assert.deepEqual(JSON.parse(JSON.stringify(rect.toJSON())), {
    x: 30,
    y: 20,
    left: 30,
    top: 20,
    right: 130,
    bottom: 70,
    width: 100,
    height: 50,
  });
  assert.ok(Object.isFrozen(rect));
  assert.notEqual(rect.width, 300);
  const legacyRect = canvas.getBoundingClientRect();
  assert.equal(legacyRect.width, 100, 'the layout-disabled pointer shim retains its prior geometry API');
  assert.notEqual(legacyRect, rect, 'rect results remain fresh snapshots');

  const otherCanvas = document.createElement('canvas');
  assert.throws(() => otherCanvas.getBoundingClientRect(), { name: 'NotSupportedError' });
});

test('capture retargeting emits got and lost events and rejects inactive pointers', () => {
  const { pointer, document } = createRuntime();
  const canvas = document.createElement('canvas');
  const capture = document.createElement('div');
  const nextCapture = document.createElement('div');
  const disconnected = document.createElement('div');
  disconnected.isConnected = false;
  const log = [];
  canvas.addEventListener('pointerdown', (event) => {
    assert.throws(() => disconnected.setPointerCapture(event.pointerId), { name: 'InvalidStateError' });
    capture.setPointerCapture(event.pointerId);
    log.push('down:' + (event.target === canvas));
  });
  for (const type of ['gotpointercapture', 'pointermove', 'lostpointercapture']) {
    capture.addEventListener(type, (event) => {
      log.push(type + ':' + (event.target === capture));
      if (type === 'pointermove') nextCapture.setPointerCapture(event.pointerId);
    });
  }
  for (const type of ['gotpointercapture', 'pointermove', 'lostpointercapture']) {
    nextCapture.addEventListener(type, (event) => {
      log.push(type + '-next:' + (event.target === nextCapture));
      if (type === 'gotpointercapture') log.push('capture-coord:' + event.clientX);
      if (type === 'pointermove') nextCapture.releasePointerCapture(event.pointerId);
    });
  }
  canvas.addEventListener('pointerup', (event) => {
    log.push('pointerup:' + (event.target === capture));
  });

  pointer.dispatch(canvas, 'pointerdown', eventData());
  assert.equal(capture.hasPointerCapture(7), true);
  assert.ok(!log.includes('gotpointercapture:true'));
  assert.ok(log.includes('down:true'));
  pointer.dispatch(canvas, 'pointermove', eventData({ clientX: 48, offsetX: 18 }));
  assert.ok(log.includes('pointermove:true'));
  assert.ok(log.includes('gotpointercapture:true'));
  assert.ok(nextCapture.hasPointerCapture(7));
  assert.ok(!log.includes('gotpointercapture-next:true'));
  pointer.dispatch(canvas, 'pointermove', eventData({ clientX: 50, offsetX: 20 }));
  assert.ok(log.includes('lostpointercapture:true'));
  assert.ok(log.includes('gotpointercapture-next:true'));
  assert.ok(log.includes('capture-coord:48'));
  assert.ok(log.includes('pointermove-next:true'));
  assert.ok(!log.includes('lostpointercapture-next:true'));
  assert.equal(capture.hasPointerCapture(7), false);
  assert.equal(nextCapture.hasPointerCapture(7), false);
  pointer.dispatch(canvas, 'pointerup', eventData({ buttons: 0 }));
  assert.ok(log.includes('lostpointercapture-next:true'));
  assert.ok(log.includes('pointerup:false'));
  assert.throws(() => canvas.setPointerCapture(7), { name: 'NotFoundError' });
});

test('touch capture is implicit and pointercancel is non-cancelable', () => {
  const { pointer, document } = createRuntime();
  const canvas = document.createElement('canvas');
  const log = [];
  canvas.addEventListener('pointerdown', (event) => {
    log.push('pointerdown:' + canvas.hasPointerCapture(event.pointerId));
  });
  for (const type of ['pointercancel', 'gotpointercapture', 'lostpointercapture']) {
    canvas.addEventListener(type, (event) => {
      log.push(type);
      if (type === 'pointercancel') event.preventDefault();
    });
  }

  pointer.dispatch(canvas, 'pointerdown', eventData({ pointerType: 'touch', pointerId: 22 }));
  assert.equal(canvas.hasPointerCapture(22), true);
  assert.deepEqual(log, ['pointerdown:true']);
  const result = pointer.dispatch(canvas, 'pointercancel', eventData({
    pointerType: 'touch',
    pointerId: 22,
    buttons: 0,
  }));
  assert.equal(result.defaultPrevented, false);
  assert.deepEqual(log, [
    'pointerdown:true',
    'gotpointercapture',
    'pointercancel',
    'lostpointercapture',
  ]);
});

test('prevented pointerdown suppresses compatibility mouse events and host data ignores accessors', () => {
  const { pointer, document } = createRuntime();
  const target = document.createElement('div');
  const log = [];
  target.addEventListener('pointerdown', (event) => {
    log.push(event.type);
    event.preventDefault();
  });
  target.addEventListener('mousedown', (event) => log.push(event.type));
  target.addEventListener('mousemove', (event) => log.push(event.type));
  target.addEventListener('mouseup', (event) => log.push(event.type));

  const result = pointer.dispatch(target, 'pointerdown', eventData());
  assert.equal(result.defaultPrevented, true);
  pointer.dispatch(target, 'pointermove', eventData());
  pointer.dispatch(target, 'pointerup', eventData({ buttons: 0 }));
  assert.deepEqual(log, ['pointerdown']);

  let getterCalled = false;
  const hostile = {
    pointerType: 'mouse',
  };
  Object.defineProperty(hostile, 'pointerId', {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error('host data getter ran');
    },
  });
  assert.equal(pointer.dispatch(target, 'pointermove', hostile), null);
  assert.equal(getterCalled, false);
});

test('active pointer tracking is bounded and hover pointers are not retained', () => {
  const { pointer, document, diagnostics } = createRuntime();
  const target = document.createElement('div');
  for (let id = 100; id < 300; id++)
    pointer.dispatch(target, 'pointermove', eventData({ pointerId: id, buttons: 0 }));
  assert.ok(!diagnostics.some(([code]) => code === 'pointer.active_pointer_limit'));

  for (let id = 1; id <= 33; id++)
    pointer.dispatch(target, 'pointerdown', eventData({ pointerId: id, pointerType: 'touch' }));
  assert.ok(diagnostics.some(([code]) => code === 'pointer.active_pointer_limit'));
  assert.throws(() => target.setPointerCapture(33), { name: 'NotFoundError' });

  for (let id = 1; id <= 32; id++)
    pointer.dispatch(target, 'pointerup', eventData({ pointerId: id, pointerType: 'touch', buttons: 0 }));
});

test('click helper only constructs PointerEvent clicks when pointer metadata exists', () => {
  const { pointer, document } = createRuntime();
  const canvas = document.createElement('canvas');
  assert.equal(pointer.createClickEvent({ clientX: 1 }, { detail: 1 }, canvas), null);

  const click = pointer.createClickEvent(eventData({ buttons: 0 }), { detail: 2 }, canvas);
  assert.ok(click instanceof pointer.PointerEvent);
  assert.equal(click.type, 'click');
  assert.equal(click.detail, 2);
  assert.equal(click.pointerId, 7);
  assert.equal(click.pointerType, 'mouse');
  assert.equal(click.clientX, 42.5);
  assert.equal(click.buttons, 0);
});
