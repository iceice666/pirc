import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const layoutSource = fs.readFileSync(new URL('./document_layout_source.js', import.meta.url), 'utf8');
const runtimeSource = fs.readFileSync(new URL('./document_script_runtime_source.js', import.meta.url), 'utf8');

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
    FakeMutationObserver.instances.push(this);
  }

  observe() {}

  takeRecords() {
    const records = this.records;
    this.records = [];
    return records;
  }

  deliver(records) {
    this.callback(records);
  }
}

function harness() {
  const document = { contains: (node) => document.documentElement.contains(node) };
  const root = new FakeHTMLElement(document);
  document.documentElement = root;
  let nextId = 1;
  const ids = new WeakMap();
  const elements = new Map();
  const ensureElementId = (element) => {
    let id = ids.get(element);
    if (!id) {
      id = `pirc-${nextId++}`;
      ids.set(element, id);
      elements.set(id, element);
    }
    return id;
  };
  FakeMutationObserver.instances = [];
  const context = { DOMException };
  vm.runInNewContext(`${layoutSource}\nthis.createPircDocumentLayout = createPircDocumentLayout;`, context);
  const layout = context.createPircDocumentLayout({
    document,
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    MutationObserver: FakeMutationObserver,
    ensureElementId,
    resolveElementId: (id) => elements.get(id),
    enabled: true,
  });
  layout.install();
  return {
    document,
    root,
    layout,
    ensureElementId,
    elements,
    observer: FakeMutationObserver.instances.at(-1),
  };
}

function packet(revision, generation, boxes) {
  return {
    revision,
    generation,
    viewport: { scrollX: 0, scrollY: 0, width: 320, height: 640 },
    boxes,
  };
}

function box(id, computedStyle, kind = 'box') {
  const entry = { id, kind };
  if (kind === 'box') Object.assign(entry, { x: 0, y: 0, width: 20, height: 10 });
  if (computedStyle !== undefined) entry.computedStyle = computedStyle;
  return entry;
}

test('computed style uses the current native snapshot and remains separate from inline style', () => {
  const env = harness();
  const element = new FakeHTMLElement(env.document);
  element.style = { color: 'inline-color', backgroundColor: 'inline-bg' };
  env.root.append(element);
  const id = env.ensureElementId(element);
  env.layout.update(packet(1, 1, [box(id, {
    color: 'rgb(1, 2, 3)',
    'background-color': 'rgb(4, 5, 6)',
    '-webkit-line-clamp': '2',
    '--Theme': 'night',
  })]));

  const first = env.layout.getComputedStyle(element);
  const second = env.layout.getComputedStyle(element, '');
  assert.notEqual(first, second, 'each call returns a fresh CSSStyleDeclaration-like object');
  assert.equal(Object.prototype.toString.call(first), '[object CSSStyleDeclaration]');
  assert.equal(first.toString(), '[object CSSStyleDeclaration]');
  assert.equal(first.length, 4);
  assert.equal(first.item(0), 'background-color');
  assert.equal(first[1], 'color');
  assert.deepEqual([...first], ['background-color', 'color', '-webkit-line-clamp', '--Theme']);
  assert.deepEqual(Object.keys(first), ['0', '1', '2', '3']);
  assert.equal(first.getPropertyValue('color'), 'rgb(1, 2, 3)');
  assert.equal(first.getPropertyValue('COLOR'), 'rgb(1, 2, 3)');
  assert.equal(first.backgroundColor, 'rgb(4, 5, 6)');
  assert.equal(first.getPropertyValue('background-color'), 'rgb(4, 5, 6)');
  assert.equal(first.getPropertyValue('backgroundColor'), '');
  assert.equal(first.webkitLineClamp, '2');
  assert.equal(first.WebkitLineClamp, '2');
  assert.equal(first.getPropertyValue('--Theme'), 'night');
  assert.equal(first.getPropertyValue('--theme'), '');
  assert.equal(first.getPropertyPriority('color'), '');
  assert.equal(first.cssText, '');
  assert.equal(element.style.color, 'inline-color');
  assert.equal(element.style.backgroundColor, 'inline-bg');

  env.layout.update(packet(1, 2, [box(id, {
    color: 'rgb(9, 8, 7)',
    'background-color': 'transparent',
    '-webkit-line-clamp': '3',
    '--Theme': 'dawn',
  })]));
  assert.equal(first.getPropertyValue('color'), 'rgb(9, 8, 7)', 'retained declaration reads the accepted replacement packet');
  assert.equal(first.getPropertyValue('--Theme'), 'dawn');

  assert.throws(() => first.setProperty('color', 'red'), (error) => error.name === 'NoModificationAllowedError');
  assert.throws(() => first.removeProperty('color'), (error) => error.name === 'NoModificationAllowedError');
  assert.throws(() => { first.cssText = 'color: red'; }, (error) => error.name === 'NoModificationAllowedError');
  assert.throws(() => { first.color = 'red'; }, (error) => error.name === 'NoModificationAllowedError');
  assert.throws(() => { delete first.color; }, (error) => error.name === 'NoModificationAllowedError');
});

test('computed style works for none and unsupported geometry kinds, and detached elements read empty', () => {
  const env = harness();
  const noBox = new FakeHTMLElement(env.document);
  const unsupported = new FakeHTMLElement(env.document);
  const detached = new FakeHTMLElement(env.document);
  env.root.append(noBox);
  env.root.append(unsupported);
  const noBoxId = env.ensureElementId(noBox);
  const unsupportedId = env.ensureElementId(unsupported);
  env.layout.update(packet(1, 1, [
    box(noBoxId, { display: 'none', color: 'rgb(0, 0, 0)' }, 'none'),
    box(unsupportedId, { display: 'inline', color: 'rgb(5, 6, 7)' }, 'unsupported'),
  ]));
  assert.equal(env.layout.getComputedStyle(noBox).display, 'none');
  assert.equal(env.layout.getComputedStyle(unsupported).color, 'rgb(5, 6, 7)');

  const detachedStyle = env.layout.getComputedStyle(detached);
  assert.equal(detachedStyle.length, 0);
  assert.equal(detachedStyle.getPropertyValue('color'), '');
  assert.equal(detachedStyle.color, '');
  assert.equal('color' in detachedStyle, true);
  env.root.remove(noBox);
  assert.equal(env.layout.getComputedStyle(noBox).length, 0);
  assert.equal(env.layout.getComputedStyle(noBox).color, '');
});

test('stale, missing and omitted computed-style snapshots are explicit errors', () => {
  const env = harness();
  const element = new FakeHTMLElement(env.document);
  env.root.append(element);
  const id = env.ensureElementId(element);
  env.layout.update(packet(1, 1, [box(id, { color: 'red' })]));
  const style = env.layout.getComputedStyle(element);
  env.observer.deliver([{ type: 'attributes', attributeName: 'class' }]);
  assert.throws(() => style.color, (error) => error.name === 'NotSupportedError');

  env.layout.update(packet(2, 2, [box(id, undefined)]));
  assert.throws(() => env.layout.getComputedStyle(element).length, (error) => error.name === 'NotSupportedError');

  const unmeasured = new FakeHTMLElement(env.document);
  env.root.append(unmeasured);
  assert.throws(() => env.layout.getComputedStyle(unmeasured).getPropertyValue('color'), (error) => error.name === 'NotSupportedError');
  assert.throws(() => env.layout.getComputedStyle(element, '::before'), (error) => error.name === 'NotSupportedError');
  assert.throws(() => env.layout.getComputedStyle({ ownerDocument: env.document }), (error) => error.name === 'TypeError');
  assert.throws(() => env.layout.getComputedStyle(new FakeHTMLElement({})), (error) => error.name === 'TypeError');
});

test('known standard omissions fail explicitly while unknown custom and unknown standard names return empty', () => {
  const env = harness();
  const element = new FakeHTMLElement(env.document);
  env.root.append(element);
  const id = env.ensureElementId(element);
  env.layout.update(packet(1, 1, [box(id, { color: 'blue' })]));
  const style = env.layout.getComputedStyle(element);
  assert.equal(style.getPropertyValue('--not-defined'), '');
  assert.equal(style.getPropertyValue('made-up-property'), '');
  assert.throws(() => style.getPropertyValue('display'), (error) => error.name === 'NotSupportedError');
  assert.throws(() => style.getPropertyValue('animation-range-end'), (error) => error.name === 'NotSupportedError');
  assert.throws(() => style.display, (error) => error.name === 'NotSupportedError');
});

test('computed-style packet validation is strict and a rejected packet preserves the prior snapshot', () => {
  const env = harness();
  const element = new FakeHTMLElement(env.document);
  env.root.append(element);
  const id = env.ensureElementId(element);
  env.layout.update(packet(1, 1, [box(id, { color: 'green' })]));

  const invalidStyles = [
    [],
    new Date(),
    Object.assign(Object.create({ inherited: 'bad' }), { color: 'red' }),
    { color: 5 },
    { 'bad name': 'red' },
    { ['x'.repeat(129)]: 'bad' },
    { color: 'x'.repeat(4097) },
    Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`--p${index}`, 'x'])),
    { color: 'bad\u0000value' },
  ];
  for (const computedStyle of invalidStyles) {
    assert.throws(() => env.layout.update(packet(1, 2, [box(id, computedStyle)])), (error) => ['TypeError', 'RangeError'].includes(error.name));
    assert.equal(env.layout.getComputedStyle(element).color, 'green');
  }

  const symbolStyle = { color: 'red' };
  symbolStyle[Symbol('untrusted')] = 'bad';
  assert.throws(() => env.layout.update(packet(1, 2, [box(id, symbolStyle)])), (error) => error.name === 'TypeError');

  const accessorStyle = {};
  Object.defineProperty(accessorStyle, 'color', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.throws(() => env.layout.update(packet(1, 2, [box(id, accessorStyle)])), (error) => error.name === 'TypeError');

  const badField = { id, kind: 'box', x: 0, y: 0, width: 1, height: 1 };
  Object.defineProperty(badField, 'computedStyle', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.throws(() => env.layout.update(packet(1, 2, [badField])), (error) => error.name === 'TypeError');

  assert.throws(() => env.layout.update(packet(1, 2, [box(id, { color: 'x'.repeat(16380) })])), (error) => error.name === 'RangeError');
  assert.equal(env.layout.getComputedStyle(element).color, 'green');
});

test('packet-wide computed-style budget rejects the complete replacement atomically', () => {
  const env = harness();
  const original = new FakeHTMLElement(env.document);
  env.root.append(original);
  const originalId = env.ensureElementId(original);
  env.layout.update(packet(1, 1, [box(originalId, { color: 'stable' })]));

  const oversized = [];
  const value = 'x'.repeat(3900);
  for (let index = 0; index < 135; index += 1) {
    const element = new FakeHTMLElement(env.document);
    env.root.append(element);
    oversized.push(box(env.ensureElementId(element), {
      '--p0': value,
      '--p1': value,
      '--p2': value,
      '--p3': value,
    }));
  }
  assert.throws(() => env.layout.update(packet(1, 2, oversized)), (error) => error.name === 'RangeError');
  assert.equal(env.layout.getComputedStyle(original).color, 'stable');
});

test('runtime installs the same computed-style function on window and the sandbox global', () => {
  const installed = [];
  const installComputedStyleGlobal = extractRuntimeFunction(
    'installComputedStyleGlobal',
    '  function installDomGlobals(',
  );
  const marker = {};
  const element = {};
  const view = {};
  const layout = {
    getComputedStyle(receivedElement, pseudo) {
      assert.equal(receivedElement, element);
      assert.equal(pseudo, '');
      return marker;
    },
  };
  const getter = installComputedStyleGlobal(view, layout, (...args) => {
    installed.push(args);
    return true;
  });
  assert.equal(view.getComputedStyle, getter);
  assert.equal(getter(element, ''), marker);
  assert.equal(installed.length, 1);
  assert.equal(installed[0][0], 'getComputedStyle');
  assert.equal(installed[0][1], getter);
  assert.equal(installed[0][2], false);
});
