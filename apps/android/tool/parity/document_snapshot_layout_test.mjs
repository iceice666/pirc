import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const runtimeSource = readFileSync(
  new URL('./document_script_runtime_source.js', import.meta.url),
  'utf8',
);
const layoutSource = readFileSync(
  new URL('./document_layout_source.js', import.meta.url),
  'utf8',
);

const syncStart = runtimeSource.indexOf('  function synchronizeFormState(');
const syncEnd = runtimeSource.indexOf('\n  function snapshotHtml()', syncStart);
assert.ok(syncStart >= 0 && syncEnd > syncStart, 'snapshot helpers must exist in the runtime source');
const snapshotContext = vm.createContext({
  MARKER_ATTRIBUTE: 'data-pirc-script-id',
  fileResetVersions: new WeakMap(),
});
vm.runInContext(
  `${runtimeSource.slice(syncStart, syncEnd)}\nthis.__snapshotDocumentHtml = snapshotDocumentHtml;`,
  snapshotContext,
);
const snapshotDocumentHtml = snapshotContext.__snapshotDocumentHtml;

class FakeMutationObserver {
  static latest;

  constructor(callback) {
    this.callback = callback;
    this.records = [];
    FakeMutationObserver.latest = this;
  }

  observe() {}

  takeRecords() {
    const pending = this.records;
    this.records = [];
    return pending;
  }
}

class FakeElement {
  constructor(ownerDocument, localName, attributes = {}) {
    this.ownerDocument = ownerDocument;
    this.localName = localName;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map(Object.entries(attributes));
    this.defaultValue = '';
    this.value = '';
    this.checked = false;
    this.selected = false;
    this._textContent = '';
  }

  append(child) {
    child.parentNode = this;
    this.childNodes.push(child);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
    if (String(name) === 'checked') this.checked = true;
    this._record({ type: 'attributes', attributeName: String(name) });
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
    if (String(name) === 'checked') this.checked = false;
    this._record({ type: 'attributes', attributeName: String(name) });
  }

  get options() {
    return this.querySelectorAll('option');
  }

  get textContent() {
    return this._textContent + this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    this._textContent = String(value);
    this._record({ type: 'characterData', attributeName: null });
  }

  querySelectorAll(selector) {
    const all = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        all.push(child);
        visit(child);
      }
    };
    visit(this);
    return selector === '*'
      ? all
      : all.filter((element) => element.localName === selector.toLowerCase());
  }

  cloneNode(deep) {
    // This intentionally models the observed LinkeDOM behavior: clone-side
    // mutations can be reported against the source document's observer.
    this.ownerDocument?._record({ type: 'childList', attributeName: null });
    const copy = new FakeElement(this.ownerDocument, this.localName);
    copy.attributes = new Map(this.attributes);
    copy.defaultValue = this.defaultValue;
    copy.value = this.value;
    copy.checked = this.checked;
    copy.selected = this.selected;
    copy._textContent = this._textContent;
    if (deep) {
      for (const child of this.childNodes) copy.append(child.cloneNode(true));
    }
    return copy;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.childNodes = this.parentNode.childNodes.filter((child) => child !== this);
    this.parentNode = null;
    this._record({ type: 'childList', attributeName: null });
  }

  toString() {
    const attrs = [...this.attributes]
      .map(([name, value]) => ` ${name}="${String(value).replaceAll('"', '&quot;')}"`)
      .join('');
    const start = `<${this.localName}${attrs}>`;
    if (['input', 'meta', 'link', 'img', 'br', 'hr'].includes(this.localName)) return start;
    return `${start}${this._textContent}${this.childNodes.map(String).join('')}</${this.localName}>`;
  }

  _record(record) {
    this.ownerDocument?._record(record);
  }
}

class FakeDocument {
  constructor() {
    this.observer = null;
    this.documentElement = new FakeElement(this, 'html');
  }

  querySelectorAll(selector) {
    const descendants = [this.documentElement, ...this.documentElement.querySelectorAll('*')];
    return selector === '*'
      ? descendants
      : descendants.filter((element) => element.localName === selector.toLowerCase());
  }

  cloneNode(deep) {
    const copy = Object.create(FakeDocument.prototype);
    copy.observer = null;
    copy.documentElement = this.documentElement.cloneNode(Boolean(deep));
    return copy;
  }

  toString() {
    return this.documentElement.toString();
  }

  _record(record) {
    this.observer?.records.push(record);
  }
}

test('form synchronization and script removal stay inside the private snapshot mutation guard', () => {
  const document = new FakeDocument();
  const body = new FakeElement(document, 'body');
  document.documentElement.append(body);
  const checkbox = new FakeElement(document, 'input', {
    'data-pirc-script-id': 'pirc-1',
    type: 'checkbox',
    checked: '',
  });
  checkbox.checked = true;
  checkbox.defaultValue = 'default-check';
  checkbox.value = 'live-check';
  body.append(checkbox);

  const input = new FakeElement(document, 'input', {
    'data-pirc-script-id': 'pirc-2',
    type: 'text',
  });
  input.defaultValue = 'initial';
  input.value = 'edited';
  body.append(input);

  const textarea = new FakeElement(document, 'textarea', {
    'data-pirc-script-id': 'pirc-3',
  });
  textarea.defaultValue = 'original text';
  textarea.value = 'typed text';
  textarea.textContent = 'original text';
  body.append(textarea);

  const select = new FakeElement(document, 'select', {
    'data-pirc-script-id': 'pirc-4',
  });
  const option = new FakeElement(document, 'option', {
    'data-pirc-script-id': 'pirc-5',
    selected: '',
  });
  option.selected = false;
  option.textContent = 'option';
  select.append(option);
  body.append(select);
  body.append(new FakeElement(document, 'script', { 'data-pirc-script-id': 'pirc-6' }));

  const layoutContext = vm.createContext({ DOMException });
  vm.runInContext(`${layoutSource}\nthis.__createLayout = createPircDocumentLayout;`, layoutContext);
  const layout = layoutContext.__createLayout({
    document,
    Element: FakeElement,
    HTMLElement: FakeElement,
    MutationObserver: FakeMutationObserver,
    ensureElementId(element) { return element.getAttribute('data-pirc-script-id'); },
    resolveElementId(id) { return document.querySelectorAll('*').find((node) => node.getAttribute('data-pirc-script-id') === id); },
    enabled: true,
  });
  layout.install();
  document.observer = FakeMutationObserver.latest;

  const state = { document, layout };
  const initialRevision = layout.revision();
  const first = snapshotDocumentHtml(state);
  const second = snapshotDocumentHtml(state);
  assert.equal(layout.revision(), initialRevision, 'clone annotations/removal must not invalidate the source tree');
  assert.equal(first, second);
  assert.doesNotMatch(first, /<script\b/);
  assert.match(first, /data-pirc-history-default-value="default-check"/);
  assert.match(first, /value="live-check"/);
  assert.match(first, /data-pirc-history-default-value="initial"/);
  assert.match(first, /typed text/);
  assert.doesNotMatch(first, /<option[^>]* selected=/, 'the live unselected state is synchronized');

  checkbox.setAttribute('class', 'real-form-change');
  const afterRealMutation = snapshotDocumentHtml(state);
  assert.equal(layout.revision(), initialRevision + 1, 'a real source-form mutation still invalidates layout');
  assert.match(afterRealMutation, /class="real-form-change"/);
});
