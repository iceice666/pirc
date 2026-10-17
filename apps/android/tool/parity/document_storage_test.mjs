import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext, runInContext} from 'node:vm';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const sourcePath = fileURLToPath(new URL('./document_storage_source.js', import.meta.url));
const source = await readFile(sourcePath, 'utf8');
const quotaUnits = 5 * 1024 * 1024;
const quotaBytes = quotaUnits * 2;

function snapshot(overrides = {}) {
  return {
    generation: 7,
    revision: 1,
    origin: 'https://storage.example',
    sessionKey: 'tab-7',
    quotaBytes,
    local: [],
    session: [],
    ...overrides,
  };
}

function createHarness(seed = snapshot(), initialUrl = 'https://storage.example/page') {
  const context = createContext({URL, Event, EventTarget, DOMException});
  runInContext(source + '\n;globalThis.__createStorage = createPircDocumentStorage;', context, {
    filename: sourcePath,
  });
  let activeUrl = initialUrl;
  const diagnostics = [];
  const window = new EventTarget();
  const helper = context.__createStorage({
    getUrl: () => activeUrl,
    diagnostic: (...args) => diagnostics.push(args),
    Event,
    DOMException,
    URL,
    dispatchEvent: event => window.dispatchEvent(event),
  });
  helper.install(window);
  helper.sync(seed);
  return {
    window,
    helper,
    diagnostics,
    setUrl(url) { activeUrl = url; },
  };
}

function json(value) {
  return JSON.parse(JSON.stringify(value));
}

test('Storage objects keep identity across native sync and perform synchronous DOMString operations', () => {
  const harness = createHarness(snapshot({local: [['seed', 'value']]}));
  const {window, helper} = harness;
  const local = window.localStorage;
  const session = window.sessionStorage;

  assert.equal(window.localStorage, local);
  assert.equal(window.sessionStorage, session);
  assert.equal(local instanceof window.Storage, true);
  assert.equal(Object.getPrototypeOf(local), window.Storage.prototype);
  assert.equal(Object.prototype.toString.call(local), '[object Storage]');
  assert.equal(local.getItem('seed'), 'value');

  local.setItem(17, true);
  local.direct = 42;
  assert.equal(local.getItem('17'), 'true');
  assert.equal(local.direct, '42');
  assert.equal(local.length, 3);
  assert.deepEqual(json(helper.takeWrites()), [
    {area: 'local', type: 'set', key: '17', value: 'true', url: 'https://storage.example/page', generation: 7},
    {area: 'local', type: 'set', key: 'direct', value: '42', url: 'https://storage.example/page', generation: 7},
  ]);

  harness.setUrl('https://storage.example/after-push-state');
  helper.sync(snapshot({revision: 2, local: [['server', 'updated']]}));
  assert.equal(window.localStorage, local);
  assert.equal(local.getItem('seed'), null);
  assert.equal(local.getItem('server'), 'updated');
  assert.equal(session, window.sessionStorage);
  assert.throws(() => local.setItem(Symbol('key'), 'value'), {name: 'TypeError'});
  assert.throws(() => window.Storage.prototype.getItem.call({}, 'x'), {name: 'TypeError'});
});

test('ordered enumeration exposes reserved stored keys while inherited members win reads', () => {
  const harness = createHarness(snapshot({local: [
    ['first', '1'], ['length', 'hidden-length'], ['setItem', 'hidden-method'],
    ['constructor', 'hidden-constructor'], ['toString', 'hidden-prototype'], ['last', '2'],
  ]}));
  const {localStorage: local} = harness.window;

  assert.equal(local.length, 6);
  assert.equal(local.key(0), 'first');
  assert.equal(local.key(1), 'length');
  assert.equal(local.key(2), 'setItem');
  assert.equal(local.key(99), null);
  assert.equal(local.getItem('length'), 'hidden-length');
  assert.equal(local.getItem('setItem'), 'hidden-method');
  assert.equal(local.getItem('constructor'), 'hidden-constructor');
  assert.equal(typeof local.setItem, 'function');
  assert.equal(local.constructor, harness.window.Storage);
  assert.equal(typeof local.toString, 'function');
  assert.deepEqual(Object.keys(local), [
    'first', 'setItem', 'constructor', 'toString', 'last',
  ]);
  assert.deepEqual(Object.getOwnPropertyNames(local), [
    'first', 'length', 'setItem', 'constructor', 'toString', 'last',
  ]);
  assert.equal(Object.getOwnPropertyDescriptor(local, 'length').enumerable, false);
  // Chrome exposes no descriptor for stored prototype-collision keys, despite
  // including them in Object.keys; the Storage Proxy cannot reproduce that.
  assert.equal(Object.getOwnPropertyDescriptor(local, 'setItem').enumerable, true);
  assert.equal(Reflect.set(local, 'length', 'assigned'), false);
  assert.equal(local.length, 6);
  assert.equal(Reflect.set(local, 'getItem', 'shadow'), true);
  assert.equal(local.getItem, 'shadow');
  assert.equal(harness.helper.hasWrites(), false);
  delete local.getItem;
  assert.equal(typeof local.getItem, 'function');
  assert.equal(harness.window.Storage.prototype.getItem.call(local, 'setItem'), 'hidden-method');

  delete local.first;
  assert.equal(local.key(0), 'length');
  assert.deepEqual(json(harness.helper.takeWrites()), [
    {area: 'local', type: 'remove', key: 'first', url: 'https://storage.example/page', generation: 7},
  ]);
});

test('Chrome reserved Storage names remain readable through getItem but built-ins win direct access', () => {
  const harness = createHarness(snapshot({local: [
    ['length', 'stored-length'], ['__proto__', 'stored-proto'], ['', 'stored-empty'],
    ['namedProperty', 'assigned-value'], ['getItem', 'stored-getItem'],
    ['constructor', 'stored-constructor'], ['setItem', 'stored-setItem'],
    ['toString', 'stored-toString'],
  ]}));
  const local = harness.window.localStorage;
  const prototype = Object.getPrototypeOf(local);

  for (const [key, value] of [
    ['length', 'stored-length'], ['__proto__', 'stored-proto'], ['', 'stored-empty'],
    ['namedProperty', 'assigned-value'], ['getItem', 'stored-getItem'],
    ['constructor', 'stored-constructor'], ['setItem', 'stored-setItem'],
    ['toString', 'stored-toString'],
  ]) assert.equal(local.getItem(key), value);
  assert.equal(local.__proto__, prototype);
  assert.equal(typeof local.getItem, 'function');
  assert.equal(typeof local.setItem, 'function');
  assert.equal(local.constructor, harness.window.Storage);
  assert.equal(typeof local.toString, 'function');
  assert.equal(local.length, 8);
  assert.deepEqual(Object.keys(local), [
    '__proto__', '', 'namedProperty', 'getItem', 'constructor', 'setItem', 'toString',
  ]);
  assert.ok(Object.getOwnPropertyNames(local).includes('length'));
  assert.equal(Reflect.set(local, 'length', 'assigned-length'), false);
  assert.equal(Reflect.set(local, '__proto__', 'assigned-proto'), true);
  assert.equal(Object.getPrototypeOf(local), prototype);
  assert.equal(local.getItem('__proto__'), 'stored-proto');

  assert.equal(Reflect.set(local, 'getItem', 'shadow-get'), true);
  assert.equal(Reflect.set(local, 'setItem', 'shadow-set'), true);
  assert.equal(local.getItem, 'shadow-get');
  assert.equal(local.setItem, 'shadow-set');
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(local, 'getItem'),
    {value: 'shadow-get', writable: true, enumerable: true, configurable: true},
  );
  delete local.getItem;
  delete local.setItem;
  assert.equal(typeof local.getItem, 'function');
  assert.equal(typeof local.setItem, 'function');
  assert.equal(local.getItem('getItem'), 'stored-getItem');
  assert.equal(local.getItem('setItem'), 'stored-setItem');
  assert.equal(harness.helper.hasWrites(), false);
});

test('no-op writes enqueue no native operation and local/session areas remain separate', () => {
  const harness = createHarness(snapshot({local: [['same', 'value']]}));
  const {localStorage: local, sessionStorage: session} = harness.window;

  local.setItem('same', 'value');
  local.removeItem('missing');
  session.clear();
  assert.equal(harness.helper.hasWrites(), false);

  local.removeItem('same');
  session.setItem('same', 'value');
  session.clear();
  assert.deepEqual(json(harness.helper.takeWrites()), [
    {area: 'local', type: 'remove', key: 'same', url: 'https://storage.example/page', generation: 7},
    {area: 'session', type: 'set', key: 'same', value: 'value', url: 'https://storage.example/page', generation: 7},
    {area: 'session', type: 'clear', url: 'https://storage.example/page', generation: 7},
  ]);
});

test('the full 5 Mi UTF-16-code-unit quota can be written and drained without truncation', () => {
  const harness = createHarness(snapshot());
  const local = harness.window.localStorage;
  const value = 'x'.repeat(quotaUnits);

  local.setItem('', value);
  assert.equal(local.getItem('').length, quotaUnits);
  const operations = harness.helper.takeWrites();
  assert.equal(operations.length, 1);
  assert.equal(operations[0].value.length, quotaUnits);
  assert.equal(operations[0].value.charCodeAt(quotaUnits - 1), 120);
  assert.ok(JSON.stringify(json(operations)).length > 1024 * 1024);
  assert.throws(() => local.setItem('overflow', 'x'), {name: 'QuotaExceededError'});
  assert.equal(local.getItem('').length, quotaUnits);
  assert.equal(local.getItem('overflow'), null);
  assert.equal(harness.helper.hasWrites(), false);
  assert.ok(harness.diagnostics.some(item => item[0] === 'storage.quota_exceeded'));
});

test('a quota-rejected replacement leaves prior data and the native queue unchanged', () => {
  const harness = createHarness(snapshot({quotaBytes: 12, local: [['k', 'ab']]}));
  const local = harness.window.localStorage;

  assert.throws(() => local.setItem('k', '123456'), {name: 'QuotaExceededError'});
  assert.equal(local.getItem('k'), 'ab');
  assert.equal(harness.helper.hasWrites(), false);
  assert.equal(local.length, 1);
});

test('the entry bound rejects a new key before mirror mutation but allows overwrites', () => {
  const entries = Array.from({length: 50000}, (_, index) => ['k' + index, 'v']);
  const harness = createHarness(snapshot({local: entries}));
  const local = harness.window.localStorage;

  local.setItem('k0', 'changed');
  assert.equal(local.getItem('k0'), 'changed');
  assert.throws(() => local.setItem('another-key', 'v'), {name: 'QuotaExceededError'});
  assert.equal(local.getItem('another-key'), null);
  assert.equal(local.length, 50000);
  assert.deepEqual(json(harness.helper.takeWrites()), [
    {area: 'local', type: 'set', key: 'k0', value: 'changed', url: 'https://storage.example/page', generation: 7},
  ]);
  assert.ok(harness.diagnostics.some(item => item[0] === 'storage.entry_limit'));
});

test('the operation bound rejects the 257th mutation without changing state', () => {
  const harness = createHarness(snapshot());
  const local = harness.window.localStorage;

  for (let i = 0; i < 256; i++) local.setItem('key-' + i, 'v');
  assert.throws(() => local.setItem('key-256', 'v'), {name: 'QuotaExceededError'});
  assert.equal(local.getItem('key-255'), 'v');
  assert.equal(local.getItem('key-256'), null);
  assert.equal(harness.helper.takeWrites().length, 256);
  assert.equal(harness.helper.hasWrites(), false);
  assert.ok(harness.diagnostics.some(item => item[0] === 'storage.operation_limit'));
});

test('payload bound rejects before changing the mirror while allowing an individual full-quota value', () => {
  const harness = createHarness(snapshot());
  const local = harness.window.localStorage;
  const fullValue = 'v'.repeat(quotaUnits);

  for (let i = 0; i < 3; i++) {
    local.setItem('', fullValue);
    local.removeItem('');
  }
  assert.equal(local.length, 0);
  assert.throws(() => local.setItem('', fullValue), {name: 'QuotaExceededError'});
  assert.equal(local.getItem(''), null);
  assert.equal(harness.helper.takeWrites().length, 6);
  assert.ok(harness.diagnostics.some(item => item[0] === 'storage.operation_payload_limit'));
});

test('opaque, file, and missing snapshots throw SecurityError instead of exposing empty storage', () => {
  const harness = createHarness(snapshot({origin: 'null'}), 'data:text/html,opaque');
  assert.throws(() => harness.window.localStorage, {name: 'SecurityError'});
  assert.throws(() => harness.window.sessionStorage, {name: 'SecurityError'});
  assert.ok(harness.diagnostics.some(item => item[0] === 'storage.state_unavailable'));

  const missing = createHarness(null);
  assert.throws(() => missing.window.localStorage, {name: 'SecurityError'});
});

test('blob documents can use Storage only when the native snapshot supplies their inherited HTTP origin', () => {
  const blobUrl = 'blob:https://storage.example/owned-token';
  const harness = createHarness(snapshot({local: [['seed', 'ok']]}), blobUrl);
  const local = harness.window.localStorage;

  assert.equal(local.getItem('seed'), 'ok');
  local.setItem('fromBlob', 'yes');
  assert.deepEqual(json(harness.helper.takeWrites()), [
    {area: 'local', type: 'set', key: 'fromBlob', value: 'yes', url: blobUrl, generation: 7},
  ]);
  assert.throws(
    () => createHarness(snapshot(), 'blob:null/opaque-token').window.localStorage,
    {name: 'SecurityError'},
  );
});

test('host storage events use the local/session object and trusted event metadata without self-events', () => {
  const harness = createHarness(snapshot());
  const {window, helper} = harness;
  const received = [];
  window.addEventListener('storage', event => received.push(event));
  const local = window.localStorage;
  const session = window.sessionStorage;

  local.setItem('own', 'change');
  assert.equal(received.length, 0);
  helper.takeWrites();

  assert.equal(helper.dispatchEvent({
    area: 'local', key: 'name', oldValue: 'before', newValue: 'after',
    url: 'https://other.example/page', generation: 7, origin: 'https://storage.example', sessionKey: 'other-window',
  }), true);
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'storage');
  assert.equal(received[0].storageArea, local);
  assert.equal(received[0].key, 'name');
  assert.equal(received[0].oldValue, 'before');
  assert.equal(received[0].newValue, 'after');
  assert.equal(received[0].url, 'https://other.example/page');
  assert.equal(received[0].isTrusted, true);
  assert.equal(received[0].bubbles, false);
  assert.equal(received[0].cancelable, false);

  helper.dispatchEvent({area: 'session', key: null, url: 'https://storage.example/', generation: 7});
  assert.equal(received[1].storageArea, session);
  assert.equal(received[1].key, null);
  assert.equal(received[1].oldValue, null);
  assert.equal(received[1].newValue, null);
  assert.equal(received[1].isTrusted, true);

  const synthetic = new window.StorageEvent('storage', {key: 1, storageArea: local});
  assert.equal(synthetic.key, '1');
  assert.equal(synthetic.storageArea, local);
  assert.equal(synthetic.isTrusted, false);
  assert.throws(() => new window.StorageEvent('storage', {storageArea: {}}), {name: 'TypeError'});
});
