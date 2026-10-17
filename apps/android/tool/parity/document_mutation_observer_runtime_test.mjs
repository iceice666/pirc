import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const here = new URL('.', import.meta.url);
const workerPath = fileURLToPath(new URL('./vendor/linkedom-0.18.13/worker.js', here));
const patchesPath = fileURLToPath(new URL('./document_linkedom_mutation_patches.json', here));
const runtimePath = fileURLToPath(new URL('./document_mutation_observer_source.js', here));

function createPatchedLinkedomContext() {
  let worker = readFileSync(workerPath, 'utf8');
  const patchManifest = JSON.parse(readFileSync(patchesPath, 'utf8'));
  for (const patch of patchManifest.patches) {
    assert.equal(
      worker.split(patch.before).length - 1,
      1,
      `LinkeDOM patch ${patch.name} must match exactly once`,
    );
    worker = worker.replace(patch.before, patch.after);
  }
  worker = worker.replace(/\nexport \{[\s\S]*?\};\s*$/, '\n');
  worker = worker.replace(/^export\s+/gm, '');
  assert.doesNotMatch(worker, /^export\s/m);

  const context = vm.createContext({ Buffer });
  new vm.Script(worker, { filename: 'linkedom-0.18.13-worker.js' }).runInContext(context);
  new vm.Script(readFileSync(runtimePath, 'utf8'), {
    filename: 'document_mutation_observer_source.js',
  }).runInContext(context);
  vm.runInContext(`
    globalThis.guestWindow = parseHTML(
      '<!doctype html><html><body><main id="root"><i id="before"></i><i id="after"></i></main></body></html>'
    );
    globalThis.document = guestWindow.document;
    globalThis.diagnostics = [];
    globalThis.mutationRuntime = createDocumentMutationObserverRuntime({
      document,
      NativeMutationObserver: guestWindow.MutationObserver,
      Node: guestWindow.Node,
      NodeList: guestWindow.NodeList,
      onDiagnostic: (code, severity, message, detail) =>
        diagnostics.push({code, severity, message, detail}),
    });
    globalThis.GuestMutationObserver = mutationRuntime.MutationObserver;
    globalThis.GuestMutationRecord = mutationRuntime.MutationRecord;
  `, context);
  return context;
}

function evaluate(context, source) {
  return vm.runInContext(source, context);
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('childList subtree records use the actual nested target and preserve sibling context', async () => {
  const context = createPatchedLinkedomContext();
  evaluate(context, `
    globalThis.received = [];
    globalThis.observer = new GuestMutationObserver(function(records, self) {
      received.push(...records.map(record => ({record, self, receiver: this})));
    });
    observer.observe(document, { childList: true, subtree: true });
    const root = document.querySelector('#root');
    const inserted = document.createElement('b');
    inserted.id = 'inserted';
    root.insertBefore(inserted, document.querySelector('#after'));
  `);
  assert.equal(evaluate(context, 'received.length'), 0, 'delivery must wait for a microtask');
  await flushMicrotasks();

  assert.equal(evaluate(context, 'received.length'), 1);
  assert.equal(evaluate(context, 'received[0].record.type'), 'childList');
  assert.equal(evaluate(context, 'received[0].record.target.id'), 'root');
  assert.equal(evaluate(context, 'received[0].record.addedNodes.length'), 1);
  assert.equal(evaluate(context, 'received[0].record.addedNodes[0].id'), 'inserted');
  assert.equal(evaluate(context, 'received[0].record.previousSibling.id'), 'before');
  assert.equal(evaluate(context, 'received[0].record.nextSibling.id'), 'after');
  assert.equal(evaluate(context, 'received[0].self === observer'), true);
  assert.equal(evaluate(context, 'received[0].receiver === observer'), true);
  assert.equal(evaluate(context, 'Object.isExtensible(received[0].record)'), true);
  assert.equal(evaluate(context, 'Object.prototype.toString.call(received[0].record)'), '[object MutationRecord]');
  assert.equal(evaluate(context, 'received[0].record instanceof GuestMutationRecord'), true);
  assert.equal(evaluate(context, 'Object.prototype.toString.call(received[0].record.addedNodes)'), '[object NodeList]');
  assert.equal(evaluate(context, 'received[0].record.addedNodes.item(0).id'), 'inserted');
  assert.equal(evaluate(context, 'received[0].record.addedNodes.item(4)'), null);
  assert.equal(evaluate(context, 'Array.from(received[0].record.addedNodes).length'), 1);
  assert.equal(evaluate(context, 'received[0].record.addedNodes instanceof guestWindow.NodeList'), true);
  assert.equal(evaluate(context, `(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(received[0].record), 'type');
    return descriptor.enumerable && descriptor.configurable && !descriptor.set;
  })()`), true);
  evaluate(context, `received[0].record.type = 'corrupted'`);
  assert.equal(evaluate(context, 'received[0].record.type'), 'childList');

  evaluate(context, `document.querySelector('#inserted').remove();`);
  await flushMicrotasks();
  assert.equal(evaluate(context, 'received.length'), 2);
  assert.equal(evaluate(context, 'received[1].record.target.id'), 'root');
  assert.equal(evaluate(context, 'received[1].record.removedNodes[0].id'), 'inserted');
  assert.equal(evaluate(context, 'received[1].record.previousSibling.id'), 'before');
  assert.equal(evaluate(context, 'received[1].record.nextSibling.id'), 'after');
});

test('attribute filters retain same-value writes and hide runtime marker attributes', async () => {
  const context = createPatchedLinkedomContext();
  evaluate(context, `
    globalThis.attributeBatches = [];
    const root = document.querySelector('#root');
    globalThis.attributeObserver = new GuestMutationObserver(records => {
      attributeBatches.push(records);
    });
    attributeObserver.observe(root, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-chart', 'data-pirc-script-id'],
    });
    root.setAttribute('data-chart', 'ready');
    root.setAttribute('data-chart', 'ready');
    root.setAttribute('data-pirc-script-id', 'pirc-1');
    root.setAttribute('title', 'filtered');
  `);
  await flushMicrotasks();

  assert.equal(evaluate(context, 'attributeBatches.length'), 1);
  assert.equal(evaluate(context, 'attributeBatches[0].length'), 2);
  assert.equal(evaluate(context, 'attributeBatches[0][0].type'), 'attributes');
  assert.equal(evaluate(context, 'attributeBatches[0][0].attributeName'), 'data-chart');
  assert.equal(evaluate(context, 'attributeBatches[0][0].oldValue'), null);
  assert.equal(evaluate(context, 'attributeBatches[0][1].oldValue'), 'ready');
  assert.equal(evaluate(context, 'attributeBatches[0][0].target.id'), 'root');
  assert.equal(evaluate(context, 'attributeBatches[0][0].attributeNamespace'), null);
});

test('characterData records are distinct from childList and retain requested old values', async () => {
  const context = createPatchedLinkedomContext();
  evaluate(context, `
    globalThis.characterRecords = [];
    const text = document.createTextNode('first');
    document.querySelector('#root').appendChild(text);
    globalThis.characterObserver = new GuestMutationObserver(records => {
      characterRecords.push(...records);
    });
    characterObserver.observe(text, { characterDataOldValue: true });
    text.data = 'second';
    text.nodeValue = 'third';
  `);
  await flushMicrotasks();

  assert.equal(evaluate(context, 'characterRecords.length'), 2);
  assert.equal(evaluate(context, 'characterRecords[0].type'), 'characterData');
  assert.equal(evaluate(context, 'characterRecords[0].target.data'), 'third');
  assert.equal(evaluate(context, 'characterRecords[0].oldValue'), 'first');
  assert.equal(evaluate(context, 'characterRecords[1].oldValue'), 'second');
  assert.equal(evaluate(context, 'characterRecords[0].addedNodes.length'), 0);
  assert.equal(evaluate(context, 'characterRecords[0].attributeName'), null);
});

test('defined false old-value options imply observation and produce null oldValue', async () => {
  const context = createPatchedLinkedomContext();
  evaluate(context, `
    globalThis.falseOldValueRecords = [];
    const root = document.querySelector('#root');
    globalThis.falseAttributeObserver = new GuestMutationObserver(records => falseOldValueRecords.push(...records));
    falseAttributeObserver.observe(root, {attributeOldValue: false});
    const text = document.createTextNode('old text');
    root.appendChild(text);
    globalThis.falseCharacterObserver = new GuestMutationObserver(records => falseOldValueRecords.push(...records));
    falseCharacterObserver.observe(text, {characterDataOldValue: false});
    root.setAttribute('data-false-old', 'new');
    text.data = 'new text';
  `);
  await flushMicrotasks();
  assert.equal(evaluate(context, 'falseOldValueRecords.length'), 2);
  assert.equal(evaluate(context, 'falseOldValueRecords[0].type'), 'attributes');
  assert.equal(evaluate(context, 'falseOldValueRecords[0].oldValue'), null);
  assert.equal(evaluate(context, 'falseOldValueRecords[1].type'), 'characterData');
  assert.equal(evaluate(context, 'falseOldValueRecords[1].oldValue'), null);
});

test('options validate dictionary dependencies, target ownership, and re-observation replacement', async () => {
  const context = createPatchedLinkedomContext();
  assert.equal(evaluate(context, `(() => {
    const observer = new GuestMutationObserver(() => {});
    const root = document.querySelector('#root');
    const otherDocument = parseHTML('<p></p>').document;
    const cases = [
      () => observer.observe(root, {}),
      () => observer.observe(root, {childList: true, attributes: false, attributeOldValue: true}),
      () => observer.observe(root, {childList: true, characterData: false, characterDataOldValue: true}),
      () => observer.observe(root, {childList: true, attributes: false, attributeFilter: []}),
      () => observer.observe(root, {childList: true, attributeFilter: 'data-x'}),
      () => observer.observe({}, {childList: true}),
      () => observer.observe(otherDocument.querySelector('p'), {childList: true}),
    ];
    return cases.map(run => {
      try { run(); return null; } catch (error) { return error.name; }
    }).join(',');
  })()`), 'TypeError,TypeError,TypeError,TypeError,TypeError,TypeError,NotSupportedError');
  assert.equal(evaluate(context, `(() => {
    const observer = new GuestMutationObserver(() => {});
    const root = document.querySelector('#root');
    try {
      observer.observe(root, {
        childList: true,
        attributes: false,
        attributeOldValue: false,
        characterData: false,
        characterDataOldValue: false,
      });
      observer.disconnect();
      observer.observe(root, {childList: true, attributeOldValue: undefined, characterDataOldValue: undefined});
      return 'accepted';
    } catch (error) { return error.name; }
  })()`), 'accepted');

  evaluate(context, `
    globalThis.reobserved = [];
    const root = document.querySelector('#root');
    globalThis.reobserveObserver = new GuestMutationObserver(records => reobserved.push(...records));
    reobserveObserver.observe(root, {attributes: true});
    reobserveObserver.observe(root, {childList: true});
    root.setAttribute('data-replaced', 'ignored');
    root.appendChild(document.createElement('small'));
  `);
  await flushMicrotasks();
  assert.equal(evaluate(context, 'reobserved.length'), 1);
  assert.equal(evaluate(context, 'reobserved[0].type'), 'childList');
});

test('takeRecords, disconnect, and private serialization suppression preserve the right records', async () => {
  const context = createPatchedLinkedomContext();
  evaluate(context, `
    globalThis.delivered = [];
    const root = document.querySelector('#root');
    globalThis.lifecycleObserver = new GuestMutationObserver(records => delivered.push(...records));
    lifecycleObserver.observe(document, {attributes: true, childList: true, subtree: true});
    root.setAttribute('data-taken', 'yes');
    globalThis.taken = lifecycleObserver.takeRecords();
  `);
  assert.equal(evaluate(context, 'taken.length'), 1);
  await flushMicrotasks();
  assert.equal(evaluate(context, 'delivered.length'), 0);

  evaluate(context, `root.setAttribute('data-disconnected', 'yes'); lifecycleObserver.disconnect();`);
  await flushMicrotasks();
  assert.equal(evaluate(context, 'delivered.length'), 0);
  assert.equal(evaluate(context, 'lifecycleObserver.takeRecords().length'), 0);

  evaluate(context, `
    lifecycleObserver.observe(document, {attributes: true, childList: true, subtree: true});
    root.setAttribute('data-real-before-snapshot', 'yes');
    mutationRuntime.runWithoutMutations(() => {
      root.setAttribute('data-private-serialization', 'yes');
      root.setAttribute('data-pirc-script-click', 'pirc-2');
      const clone = root.cloneNode(true);
      clone.appendChild(document.createElement('em'));
    });
  `);
  await flushMicrotasks();
  assert.equal(evaluate(context, 'delivered.length'), 1);
  assert.equal(evaluate(context, 'delivered.map(record => record.attributeName).join(",")'), 'data-real-before-snapshot');
});

test('mutation delivery precedes later Promise jobs and earlier callbacks can drain later observers', async () => {
  const context = createPatchedLinkedomContext();
  evaluate(context, `
    globalThis.promiseOrder = [];
    const root = document.querySelector('#root');
    let later;
    const earlier = new GuestMutationObserver(() => {
      promiseOrder.push('earlier');
      globalThis.drained = later.takeRecords();
    });
    later = new GuestMutationObserver(() => promiseOrder.push('later'));
    earlier.observe(root, {attributes: true});
    later.observe(root, {attributes: true});
    root.setAttribute('data-microtask-order', 'yes');
    Promise.resolve().then(() => promiseOrder.push('promise'));
  `);
  await flushMicrotasks();
  assert.equal(evaluate(context, 'promiseOrder.join(",")'), 'earlier,promise');
  assert.equal(evaluate(context, 'drained.length'), 1);
});

test('callback order follows observer construction order and callback errors are diagnostic', async () => {
  const context = createPatchedLinkedomContext();
  evaluate(context, `
    globalThis.order = [];
    const root = document.querySelector('#root');
    let first;
    let second;
    first = new GuestMutationObserver(() => { order.push('first'); });
    second = new GuestMutationObserver(() => { order.push('second'); });
    second.observe(root, {attributes: true});
    first.observe(root, {attributes: true});
    root.setAttribute('data-order', 'one');
  `);
  await flushMicrotasks();
  assert.equal(evaluate(context, 'order.join(",")'), 'first,second');

  evaluate(context, `
    globalThis.throwingObserver = new GuestMutationObserver(() => { throw new Error('observer callback failed'); });
    throwingObserver.observe(document.querySelector('#root'), {attributes: true});
    document.querySelector('#root').setAttribute('data-error', 'yes');
  `);
  await flushMicrotasks();
  assert.equal(evaluate(context, `diagnostics.some(item => item.code === 'mutation_observer.callback_error' && item.message.includes('observer callback failed'))`), true);
});

test('observer, target, and pending-record bounds fail explicitly', async () => {
  const context = createPatchedLinkedomContext();
  evaluate(context, `
    globalThis.limited = createDocumentMutationObserverRuntime({
      document,
      NativeMutationObserver: guestWindow.MutationObserver,
      Node: guestWindow.Node,
      NodeList: guestWindow.NodeList,
      limits: {maxObservers: 1, maxTargets: 1, maxRecords: 10},
      onDiagnostic: (code, severity, message) => diagnostics.push({code, severity, message}),
    });
  `);
  assert.equal(evaluate(context, `(() => {
    const root = document.querySelector('#root');
    const first = new limited.MutationObserver(() => {});
    const second = new limited.MutationObserver(() => {});
    first.observe(root, {attributes: true});
    let observerError;
    try { second.observe(root, {attributes: true}); } catch (error) { observerError = error.name; }
    let targetError;
    try { first.observe(document.body, {attributes: true}); } catch (error) { targetError = error.name; }
    first.disconnect();
    const afterDisconnect = new limited.MutationObserver(() => {});
    let reuse;
    try { afterDisconnect.observe(root, {attributes: true}); afterDisconnect.disconnect(); reuse = 'accepted'; }
    catch (error) { reuse = error.name; }
    return observerError + ',' + targetError + ',' + reuse;
  })()`), 'RangeError,RangeError,accepted');

  evaluate(context, `
    globalThis.limitedRecords = createDocumentMutationObserverRuntime({
      document,
      NativeMutationObserver: guestWindow.MutationObserver,
      Node: guestWindow.Node,
      NodeList: guestWindow.NodeList,
      limits: {maxObservers: 1, maxTargets: 1, maxRecords: 1},
      onDiagnostic: (code, severity, message) => diagnostics.push({code, severity, message}),
    });
  `);
  evaluate(context, `(() => {
    const root = document.querySelector('#root');
    const observer = new limitedRecords.MutationObserver(() => {});
    observer.observe(root, {attributes: true});
    root.setAttribute('data-overflow-one', '1');
    root.setAttribute('data-overflow-two', '2');
    try { observer.takeRecords(); } catch (error) { globalThis.capacityTakeRecords = error.name; }
    try { observer.observe(root, {attributes: true}); } catch (error) { globalThis.capacityReobserve = error.name; }
    observer.disconnect();
    observer.observe(root, {attributes: true});
    observer.disconnect();
  })()`);
  await flushMicrotasks();
  assert.equal(evaluate(context, 'capacityTakeRecords'), 'RangeError');
  assert.equal(evaluate(context, 'capacityReobserve'), 'RangeError');
  assert.equal(evaluate(context, `diagnostics.some(item => item.code === 'mutation_observer.capacity_exceeded')`), true);
});
