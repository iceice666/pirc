// Native DOM MutationObserver wrapper for the private LinkeDOM implementation.
// Keep the raw observer private: public records and option conversion are
// normalized here, and private document serialization can suppress only its
// own raw records through runWithoutMutations(). LinkeDOM's record hooks do
// not model transient registrations in removed subtrees or browser coalescing
// of bulk child-list operations; those differences are not synthesized here.
function createDocumentMutationObserverRuntime(options) {
  const config = options && typeof options === 'object' ? options : {};
  const document = config.document;
  const NativeMutationObserver = config.NativeMutationObserver;
  const NodeConstructor = config.Node || (document && document.defaultView && document.defaultView.Node);
  const diagnose = typeof config.onDiagnostic === 'function'
    ? config.onDiagnostic
    : (typeof config.diagnostic === 'function' ? config.diagnostic : () => {});
  const limits = config.limits || {};
  const MAX_OBSERVERS = positiveLimit(limits.maxObservers, 128);
  const MAX_RECORDS = positiveLimit(limits.maxRecords, 5000);
  const MAX_TARGETS = positiveLimit(limits.maxTargets, 1000);
  const stateByObserver = new WeakMap();
  const activeObservers = new Set();
  const deliveryOrder = [];
  let activeTargetCount = 0;
  let pendingRecordCount = 0;
  let nextSequence = 0;
  let deliveryScheduled = false;
  let suppressionDepth = 0;
  let closed = false;

  if (!document || document.nodeType !== 9 || typeof NativeMutationObserver !== 'function')
    throw new TypeError('MutationObserver runtime requires a document and private MutationObserver constructor');

  function positiveLimit(value, fallback) {
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1)
      throw new RangeError('MutationObserver runtime limits must be positive safe integers');
    return number;
  }

  function diagnostic(code, severity, message, detail) {
    try {
      diagnose(code, severity, message, detail);
    } catch (_) {
      // Diagnostics must not alter document mutation behavior.
    }
  }

  function unsupported(message) {
    const error = new Error(message);
    error.name = 'NotSupportedError';
    return error;
  }

  function stateFor(observer) {
    const state = stateByObserver.get(observer);
    if (!state) throw new TypeError('Illegal MutationObserver invocation');
    return state;
  }

  function stringForDomString(value) {
    if (typeof value === 'symbol')
      throw new TypeError('Cannot convert a Symbol value to a string');
    return String(value);
  }

  function normalizeOptions(input) {
    // Web IDL dictionaries treat null and undefined as empty. Other primitive
    // values are boxed, and each member is read once so getters behave like
    // normal dictionary conversion.
    const source = input === undefined || input === null ? {} : Object(input);
    const childList = Boolean(source.childList);
    const subtree = Boolean(source.subtree);
    const attributesValue = source.attributes;
    const attributeOldValueValue = source.attributeOldValue;
    const attributeFilterValue = source.attributeFilter;
    const characterDataValue = source.characterData;
    const characterDataOldValueValue = source.characterDataOldValue;

    const hasAttributes = attributesValue !== undefined;
    const hasAttributeOldValue = attributeOldValueValue !== undefined;
    const hasAttributeFilter = attributeFilterValue !== undefined;
    const hasCharacterData = characterDataValue !== undefined;
    const hasCharacterDataOldValue = characterDataOldValueValue !== undefined;
    const attributeOldValue = Boolean(attributeOldValueValue);
    const characterDataOldValue = Boolean(characterDataOldValueValue);
    let attributeFilter;
    if (hasAttributeFilter) {
      if (attributeFilterValue === null ||
          (typeof attributeFilterValue !== 'object' && typeof attributeFilterValue !== 'function') ||
          typeof attributeFilterValue[Symbol.iterator] !== 'function')
        throw new TypeError('MutationObserver attributeFilter must be a sequence');
      attributeFilter = Array.from(attributeFilterValue, stringForDomString);
    }

    // A defined old-value dictionary member implies its observation type
    // when that type was omitted, even when the old-value request is false.
    // Explicit false observation types remain valid with false old-value flags.
    const attributes = hasAttributes
      ? Boolean(attributesValue)
      : (hasAttributeOldValue || hasAttributeFilter);
    const characterData = hasCharacterData
      ? Boolean(characterDataValue)
      : hasCharacterDataOldValue;

    if (!attributes && (attributeOldValue || hasAttributeFilter))
      throw new TypeError('attributeOldValue or attributeFilter requires attributes to be true');
    if (!characterData && characterDataOldValue)
      throw new TypeError('characterDataOldValue requires characterData to be true');
    if (!childList && !attributes && !characterData)
      throw new TypeError('At least one of childList, attributes, or characterData must be true');

    const normalized = {
      childList,
      subtree,
      attributes,
      attributeOldValue,
      characterData,
      characterDataOldValue,
      attributeFilter,
    };
    const raw = { childList, subtree, attributes, characterData };
    if (attributes) {
      raw.attributeOldValue = attributeOldValue;
      if (hasAttributeFilter) raw.attributeFilter = attributeFilter.slice();
    }
    if (characterData) raw.characterDataOldValue = characterDataOldValue;
    normalized.raw = raw;
    return normalized;
  }

  function validateTarget(target) {
    if (!NodeConstructor || !(target instanceof NodeConstructor))
      throw new TypeError('MutationObserver target must be a Node');
    if (target !== document && target.ownerDocument !== document)
      throw unsupported('MutationObserver cannot observe a node from another document');
  }

  const recordStates = new WeakMap();
  const recordFields = [
    'type', 'target', 'addedNodes', 'removedNodes', 'previousSibling', 'nextSibling',
    'attributeName', 'attributeNamespace', 'oldValue'
  ];
  const nodeListPrototype = config.NodeList && config.NodeList.prototype
    ? config.NodeList.prototype
    : Object.prototype;

  function makeNodeList(values) {
    const nodes = Array.from(values || []);
    const list = Object.create(nodeListPrototype);
    Object.defineProperty(list, 'length', {
      value: nodes.length,
      enumerable: false,
      configurable: true,
    });
    for (let index = 0; index < nodes.length; index++) {
      Object.defineProperty(list, index, {
        value: nodes[index],
        enumerable: true,
        configurable: true,
      });
    }
    Object.defineProperty(list, 'item', {
      value(index) {
        const number = +index;
        const converted = Number.isFinite(number) ? Math.trunc(number) >>> 0 : 0;
        return converted < nodes.length ? nodes[converted] : null;
      },
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(list, Symbol.toStringTag, {
      value: 'NodeList',
      configurable: true,
    });
    if (!config.NodeList) {
      Object.defineProperty(list, Symbol.iterator, {
        value: function* iterator() { yield* nodes; },
        configurable: true,
      });
    }
    return list;
  }

  class MutationRecord {
    constructor(secret, raw) {
      if (secret !== recordStates)
        throw new TypeError('Illegal MutationRecord constructor');
      const fields = {
        type: raw.type,
        target: raw.target,
        addedNodes: makeNodeList(raw.addedNodes),
        removedNodes: makeNodeList(raw.removedNodes),
        previousSibling: raw.previousSibling || null,
        nextSibling: raw.nextSibling || null,
        attributeName: raw.attributeName == null ? null : String(raw.attributeName),
        attributeNamespace: raw.attributeNamespace == null ? null : String(raw.attributeNamespace),
        oldValue: raw.oldValue == null ? null : String(raw.oldValue),
      };
      recordStates.set(this, fields);
    }
  }
  for (const field of recordFields) {
    Object.defineProperty(MutationRecord.prototype, field, {
      configurable: true,
      enumerable: true,
      get() {
        const fields = recordStates.get(this);
        if (!fields) throw new TypeError('Illegal MutationRecord receiver');
        return fields[field];
      },
    });
  }
  Object.defineProperty(MutationRecord.prototype, Symbol.toStringTag, {
    value: 'MutationRecord',
    configurable: true,
  });

  function removeFromDeliveryOrder(state) {
    const index = deliveryOrder.indexOf(state);
    if (index !== -1) deliveryOrder.splice(index, 1);
  }

  function clearPendingRecords(state) {
    pendingRecordCount -= state.pendingRecords.length;
    state.pendingRecords.length = 0;
    removeFromDeliveryOrder(state);
  }

  function failCapacity(state, message) {
    if (state.capacityError) return;
    state.capacityError = new RangeError(message);
    clearPendingRecords(state);
    diagnostic(
      'mutation_observer.capacity_exceeded',
      'error',
      message,
      { observerSequence: state.sequence },
    );
  }

  function enqueueRawRecords(state, records) {
    if (!state.active || !records || !records.length || suppressionDepth) return;
    if (state.capacityError) return;
    const converted = [];
    for (const record of records) {
      if (record.type === 'attributes' &&
          (record.attributeName === 'data-pirc-script-id' ||
           record.attributeName === 'data-pirc-script-click'))
        continue;
      if (pendingRecordCount + converted.length >= MAX_RECORDS) {
        failCapacity(state, 'Native MutationObserver pending record limit exceeded.');
        return;
      }
      converted.push(new MutationRecord(recordStates, record));
    }
    if (!converted.length) return;
    if (!state.pendingRecords.length) deliveryOrder.push(state);
    state.pendingRecords.push(...converted);
    pendingRecordCount += converted.length;
    scheduleDelivery();
  }

  function scheduleDelivery() {
    if (deliveryScheduled || suppressionDepth || closed) return;
    deliveryScheduled = true;
    Promise.resolve().then(deliver);
  }

  function deliver() {
    deliveryScheduled = false;
    if (closed || suppressionDepth) return;
    const ordered = deliveryOrder.splice(0).sort(
      (first, second) => first.sequence - second.sequence,
    );
    // Visit observers one at a time. An earlier callback may call another
    // observer's takeRecords()/disconnect(), or add records for an observer
    // that has not yet been visited in this notification.
    for (const state of ordered) {
      if (!state.active || state.capacityError || !state.pendingRecords.length) continue;
      const records = state.pendingRecords.splice(0);
      pendingRecordCount -= records.length;
      try {
        Reflect.apply(state.callback, state.observer, [records, state.observer]);
      } catch (error) {
        diagnostic(
          'mutation_observer.callback_error',
          'error',
          String(error && error.stack ? error.stack : error),
          { observerSequence: state.sequence },
        );
      }
    }
    if (deliveryOrder.length) scheduleDelivery();
  }

  function drainRaw(state, discard) {
    if (!state.active) return [];
    const rawRecords = state.native.takeRecords();
    if (!discard) enqueueRawRecords(state, rawRecords);
    return rawRecords;
  }

  function drainEveryRaw(discard) {
    for (const state of activeObservers)
      drainRaw(state, discard);
  }

  class MutationObserver {
    constructor(callback) {
      if (closed) throw new TypeError('MutationObserver runtime is closed');
      if (typeof callback !== 'function')
        throw new TypeError('MutationObserver callback must be a function');
      const observer = this;
      const state = {
        observer,
        callback,
        native: new NativeMutationObserver(records => enqueueRawRecords(state, records)),
        sequence: nextSequence++,
        targets: new Map(),
        pendingRecords: [],
        active: false,
        capacityError: null,
      };
      // The patched private observer calls this immediately after recording a
      // mutation. Capturing synchronously preserves native MutationObserver
      // ordering relative to guest Promise jobs.
      state.native.__pircOnMutationQueued = () => {
        enqueueRawRecords(state, state.native.takeRecords());
      };
      stateByObserver.set(observer, state);
    }

    observe(target, options) {
      if (closed) throw new TypeError('MutationObserver runtime is closed');
      const state = stateFor(this);
      if (state.capacityError) throw state.capacityError;
      validateTarget(target);
      const normalized = normalizeOptions(options);
      const existed = state.targets.has(target);
      if (!state.active && activeObservers.size >= MAX_OBSERVERS)
        throw new RangeError('Native MutationObserver observer limit exceeded.');
      if (!existed && activeTargetCount >= MAX_TARGETS)
        throw new RangeError('Native MutationObserver target limit exceeded.');
      // Pass a fresh dictionary: LinkeDOM mutates init dictionaries while
      // applying WebIDL defaults, which must not mutate guest-owned objects.
      state.native.observe(target, normalized.raw);
      state.targets.set(target, normalized);
      if (!existed) activeTargetCount++;
      if (!state.active) {
        state.active = true;
        activeObservers.add(state);
      }
    }

    disconnect() {
      const state = stateFor(this);
      state.native.disconnect();
      clearPendingRecords(state);
      if (state.active) {
        activeTargetCount -= state.targets.size;
        activeObservers.delete(state);
        state.active = false;
      }
      state.targets.clear();
      state.capacityError = null;
    }

    takeRecords() {
      const state = stateFor(this);
      if (state.active) drainRaw(state, false);
      if (state.capacityError) throw state.capacityError;
      const records = state.pendingRecords.splice(0);
      pendingRecordCount -= records.length;
      removeFromDeliveryOrder(state);
      return records;
    }
  }
  Object.defineProperty(MutationObserver.prototype, Symbol.toStringTag, {
    value: 'MutationObserver',
    configurable: true,
  });

  function runWithoutMutations(callback) {
    if (closed) throw new TypeError('MutationObserver runtime is closed');
    if (typeof callback !== 'function')
      throw new TypeError('runWithoutMutations requires a function');
    const outermost = suppressionDepth === 0;
    if (outermost) drainEveryRaw(false);
    suppressionDepth++;
    try {
      const result = callback();
      if (result && typeof result.then === 'function')
        throw new TypeError('runWithoutMutations requires a synchronous callback');
      return result;
    } finally {
      suppressionDepth--;
      if (outermost) {
        // Preserve everything collected before the scope, then drop only raw
        // LinkeDOM records produced by private cloning/serialization inside it.
        drainEveryRaw(true);
        if (deliveryOrder.length) scheduleDelivery();
      }
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const state of Array.from(activeObservers)) {
      state.native.disconnect();
      clearPendingRecords(state);
      state.targets.clear();
      state.active = false;
      state.capacityError = null;
    }
    activeObservers.clear();
    activeTargetCount = 0;
    deliveryOrder.length = 0;
  }

  return { MutationObserver, MutationRecord, runWithoutMutations, close };
}
