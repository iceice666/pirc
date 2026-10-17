/* Synchronous document Storage objects backed by bounded native snapshots. */
function createPircDocumentStorage(options) {
  'use strict';
  options = options || {};

  // Keep the primitives used by the store stable after page code starts.
  const ObjectValue = Object;
  const ReflectValue = Reflect;
  const StringValue = String;
  const NumberValue = Number;
  const BooleanValue = Boolean;
  const MathTrunc = Math.trunc;
  const ArrayValue = Array;
  const ArrayIsArray = Array.isArray;
  const MapValue = Map;
  const WeakMapValue = WeakMap;
  const ProxyValue = Proxy;
  const SymbolValue = Symbol;
  const arraySpliceMethod = ArrayValue.prototype.splice;
  const objectCreate = ObjectValue.create;
  const symbolToStringTag = SymbolValue.toStringTag;
  const URLValue = options.URL || (typeof URL === 'function' ? URL : null);
  const EventValue = options.Event || (typeof Event === 'function' ? Event : null);
  const DOMExceptionValue = options.DOMException ||
    (typeof DOMException === 'function' ? DOMException : null);
  const apply = ReflectValue.apply;
  const mapGetMethod = MapValue.prototype.get;
  const mapSetMethod = MapValue.prototype.set;
  const mapHasMethod = MapValue.prototype.has;
  const mapDeleteMethod = MapValue.prototype.delete;
  const weakGetMethod = WeakMapValue.prototype.get;
  const weakSetMethod = WeakMapValue.prototype.set;
  const arrayPushMethod = ArrayValue.prototype.push;
  const defineProperty = ObjectValue.defineProperty;
  const getOwnPropertyDescriptor = ObjectValue.getOwnPropertyDescriptor;
  const ownKeys = ReflectValue.ownKeys;
  const reflectHas = ReflectValue.has;
  const reflectGet = ReflectValue.get;
  const reflectSet = ReflectValue.set;
  const reflectDelete = ReflectValue.deleteProperty;
  const reflectDefine = ReflectValue.defineProperty;
  const isSafeInteger = NumberValue.isSafeInteger;
  const isFiniteNumber = NumberValue.isFinite;
  const splice = (array, start, count) => apply(arraySpliceMethod, array, [start, count]);
  const MAX_OPERATIONS = 256;
  const MAX_ENTRIES = 50000;
  const MAX_QUEUED_CODE_UNITS = 16 * 1024 * 1024;
  const callMapGet = (map, key) => apply(mapGetMethod, map, [key]);
  const callMapSet = (map, key, value) => apply(mapSetMethod, map, [key, value]);
  const callMapHas = (map, key) => apply(mapHasMethod, map, [key]);
  const callMapDelete = (map, key) => apply(mapDeleteMethod, map, [key]);
  const callWeakGet = (map, key) => apply(weakGetMethod, map, [key]);
  const callWeakSet = (map, key, value) => apply(weakSetMethod, map, [key, value]);
  const push = (array, value) => apply(arrayPushMethod, array, [value]);
  const diagnostic = typeof options.diagnostic === 'function' ? options.diagnostic : function() {};
  const getUrl = typeof options.getUrl === 'function' ? options.getUrl : function() { return ''; };
  const nativeDispatch = typeof options.dispatchEvent === 'function' ? options.dispatchEvent : function() { return false; };
  const areas = {local: makeArea(), session: makeArea()};
  const storageStates = new WeakMapValue();
  const storageEventStates = new WeakMapValue();
  let snapshot = null;
  let writes = [];
  let queuedCodeUnits = 0;
  let installedWindow = null;
  let localStorageObject = null;
  let sessionStorageObject = null;
  let invalidStateReported = false;

  function makeArea() {
    return {values: new MapValue(), order: []};
  }

  function emitDiagnostic(code, message) {
    try { diagnostic(code, 'error', message); } catch (_) { /* diagnostics are advisory */ }
  }

  function domString(value) {
    if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string.');
    return StringValue(value);
  }

  function makeException(name, message) {
    if (DOMExceptionValue) {
      try { return new DOMExceptionValue(message, name); } catch (_) { /* use fallback */ }
    }
    const error = new Error(message);
    error.name = name;
    return error;
  }

  function unavailable(message) {
    if (!invalidStateReported) {
      invalidStateReported = true;
      emitDiagnostic('storage.state_unavailable', message);
    }
    return makeException('SecurityError', message);
  }

  function activeState() {
    if (!snapshot || !URLValue) {
      throw unavailable('Storage is unavailable for this document origin.');
    }
    let current;
    try { current = new URLValue(getUrl()); } catch (_) {
      throw unavailable('Storage is unavailable for this document origin.');
    }
    const inheritedBlobOrigin = current.protocol === 'blob:' && current.origin !== 'null';
    if ((current.protocol !== 'http:' && current.protocol !== 'https:' && !inheritedBlobOrigin) ||
        current.origin === 'null' || current.origin !== snapshot.origin) {
      throw unavailable('Storage is unavailable for this document origin.');
    }
    return {url: current.href, origin: current.origin, snapshot};
  }

  function stateFor(storage) {
    const state = callWeakGet(storageStates, storage);
    if (!state) throw new TypeError('Illegal invocation.');
    activeState();
    return state;
  }

  function cloneArea(input) {
    if (!ArrayIsArray(input)) throw new TypeError('Invalid Storage snapshot.');
    const area = makeArea();
    for (let i = 0; i < input.length; i++) {
      const pair = input[i];
      if (!ArrayIsArray(pair) || pair.length !== 2 ||
          typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
        throw new TypeError('Invalid Storage snapshot entry.');
      }
      const key = pair[0], value = pair[1];
      if (!callMapHas(area.values, key)) {
        if (area.order.length >= MAX_ENTRIES) throw new TypeError('The native Storage snapshot exceeds the entry limit.');
        push(area.order, key);
      }
      callMapSet(area.values, key, value);
    }
    return area;
  }

  function usedBytes(area) {
    let total = 0;
    for (let i = 0; i < area.order.length; i++) {
      const key = area.order[i];
      const value = callMapGet(area.values, key);
      total += (key.length + value.length) * 2;
    }
    return total;
  }

  function makeOperation(area, type, key, value, url, generation) {
    const operation = objectCreate(null);
    operation.area = area;
    operation.type = type;
    if (key !== undefined) operation.key = key;
    if (value !== undefined) operation.value = value;
    operation.url = url;
    operation.generation = generation;
    return operation;
  }

  function operationCodeUnits(operation) {
    return operation.area.length + operation.type.length + operation.url.length +
      (operation.key === undefined ? 0 : operation.key.length) +
      (operation.value === undefined ? 0 : operation.value.length);
  }

  function queueOperation(operation) {
    // reserveWrite checks both bounds before mutating the private store.
    queuedCodeUnits += operationCodeUnits(operation);
    push(writes, operation);
  }

  function reserveWrite(areaName, type, key, value) {
    const current = activeState();
    const operation = makeOperation(areaName, type, key, value, current.url, current.snapshot.generation);
    if (writes.length >= MAX_OPERATIONS) {
      const message = 'The document Storage operation limit has been reached (maximum 256 per turn).';
      emitDiagnostic('storage.operation_limit', message);
      throw makeException('QuotaExceededError', message);
    }
    if (queuedCodeUnits + operationCodeUnits(operation) > MAX_QUEUED_CODE_UNITS) {
      const message = 'The document Storage write payload limit has been reached (maximum 16 Mi UTF-16 code units per turn).';
      emitDiagnostic('storage.operation_payload_limit', message);
      throw makeException('QuotaExceededError', message);
    }
    return operation;
  }

  function quotaError() {
    const message = 'The document Storage quota has been exceeded.';
    emitDiagnostic('storage.quota_exceeded', message);
    return makeException('QuotaExceededError', message);
  }

  function entryLimitError() {
    const message = 'The document Storage entry limit has been reached (maximum 50000 entries per area).';
    emitDiagnostic('storage.entry_limit', message);
    return makeException('QuotaExceededError', message);
  }

  function setEntry(storage, keyValue, valueValue) {
    const state = stateFor(storage);
    const key = domString(keyValue);
    const value = domString(valueValue);
    const currentValue = callMapGet(state.area.values, key);
    const exists = callMapHas(state.area.values, key);
    if (currentValue === value && exists) return;
    if (!exists && state.area.order.length >= MAX_ENTRIES) throw entryLimitError();

    const current = activeState();
    const previousBytes = callMapHas(state.area.values, key)
      ? (key.length + currentValue.length) * 2 : 0;
    const nextBytes = (key.length + value.length) * 2;
    if (usedBytes(state.area) - previousBytes + nextBytes > current.snapshot.quotaBytes) {
      throw quotaError();
    }
    const operation = reserveWrite(state.name, 'set', key, value);
    if (!callMapHas(state.area.values, key)) push(state.area.order, key);
    callMapSet(state.area.values, key, value);
    queueOperation(operation);
  }

  function removeEntry(storage, keyValue) {
    const state = stateFor(storage);
    const key = domString(keyValue);
    if (!callMapHas(state.area.values, key)) return;
    const operation = reserveWrite(state.name, 'remove', key, undefined);
    callMapDelete(state.area.values, key);
    for (let i = 0; i < state.area.order.length; i++) {
      if (state.area.order[i] === key) {
        splice(state.area.order, i, 1);
        break;
      }
    }
    queueOperation(operation);
  }

  function clearEntries(storage) {
    const state = stateFor(storage);
    if (state.area.order.length === 0) return;
    const operation = reserveWrite(state.name, 'clear', undefined, undefined);
    state.area.values = new MapValue();
    state.area.order = [];
    queueOperation(operation);
  }

  function unsignedLong(value) {
    const number = NumberValue(value);
    if (!isFiniteNumber(number) || number === 0) return 0;
    const integer = MathTrunc(number);
    return ((integer % 4294967296) + 4294967296) % 4294967296;
  }

  class Storage {
    constructor() { throw new TypeError('Illegal constructor.'); }
    get length() { return stateFor(this).area.order.length; }
    key(index) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'key' on 'Storage': 1 argument required.");
      const state = stateFor(this);
      const position = unsignedLong(index);
      return position < state.area.order.length ? state.area.order[position] : null;
    }
    getItem(key) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'getItem' on 'Storage': 1 argument required.");
      const state = stateFor(this);
      const name = domString(key);
      return callMapHas(state.area.values, name) ? callMapGet(state.area.values, name) : null;
    }
    setItem(key, value) {
      if (arguments.length < 2) throw new TypeError("Failed to execute 'setItem' on 'Storage': 2 arguments required.");
      setEntry(this, key, value);
    }
    removeItem(key) {
      if (arguments.length < 1) throw new TypeError("Failed to execute 'removeItem' on 'Storage': 1 argument required.");
      removeEntry(this, key);
    }
    clear() { clearEntries(this); }
  }
  defineProperty(Storage.prototype, symbolToStringTag, {value: 'Storage', configurable: true});

  function makeStorage(name) {
    const target = objectCreate(Storage.prototype);
    const state = {name, area: name === 'local' ? areas.local : areas.session, target};
    const proxy = new ProxyValue(target, {
      get(object, property, receiver) {
        if (reflectHas(object, property)) return reflectGet(object, property, receiver);
        if (typeof property !== 'string') return undefined;
        const currentState = stateFor(receiver);
        return callMapHas(currentState.area.values, property)
          ? callMapGet(currentState.area.values, property) : undefined;
      },
      set(object, property, value, receiver) {
        if (typeof property !== 'string') {
          return reflectSet(object, property, value, object);
        }
        if (reflectHas(object, property)) {
          // Prototype members (including Storage methods) shadow named Storage
          // items on direct assignment. Use the target as receiver so Proxy
          // virtual descriptors cannot turn the new expando non-configurable.
          return reflectSet(object, property, value, object);
        }
        setEntry(receiver, property, value);
        return true;
      },
      deleteProperty(object, property) {
        if (typeof property !== 'string' || reflectHas(object, property)) {
          return reflectDelete(object, property);
        }
        const currentState = stateFor(proxy);
        if (callMapHas(currentState.area.values, property)) removeEntry(proxy, property);
        return true;
      },
      has(object, property) {
        if (reflectHas(object, property)) return true;
        if (typeof property !== 'string') return false;
        const currentState = stateFor(proxy);
        return callMapHas(currentState.area.values, property);
      },
      ownKeys(object) {
        const currentState = stateFor(proxy);
        const keys = ownKeys(object);
        for (let i = 0; i < currentState.area.order.length; i++) {
          const key = currentState.area.order[i];
          // Storage's named keys remain enumerable even when a prototype
          // member wins ordinary property reads for the same name.
          if (!getOwnPropertyDescriptor(object, key)) push(keys, key);
        }
        return keys;
      },
      getOwnPropertyDescriptor(object, property) {
        const own = getOwnPropertyDescriptor(object, property);
        if (own) return own;
        if (typeof property !== 'string') return undefined;
        const currentState = stateFor(proxy);
        if (!callMapHas(currentState.area.values, property)) return undefined;
        // Proxy descriptors are needed for Object.keys/Object.getOwnPropertyNames.
        // Chrome enumerates named keys that collide with prototype members while
        // reporting no descriptor for them; Proxy cannot express that combination.
        return {
          value: callMapGet(currentState.area.values, property),
          writable: true,
          enumerable: property !== 'length',
          configurable: true,
        };
      },
      defineProperty(object, property, descriptor) {
        return reflectDefine(object, property, descriptor);
      },
      preventExtensions() { return false; },
      isExtensible() { return true; },
    });
    callWeakSet(storageStates, proxy, state);
    return proxy;
  }

  localStorageObject = makeStorage('local');
  sessionStorageObject = makeStorage('session');

  function storageAreaFrom(value) {
    if (value == null) return null;
    if (!callWeakGet(storageStates, value)) throw new TypeError("The 'storageArea' property is not a Storage object.");
    return value;
  }

  class StorageEvent extends (EventValue || class {}) {
    constructor(type, init) {
      if (arguments.length < 1) throw new TypeError("Failed to construct 'StorageEvent': 1 argument required.");
      const dictionary = init == null ? {} : ObjectValue(init);
      const eventInit = {
        bubbles: BooleanValue(dictionary.bubbles),
        cancelable: BooleanValue(dictionary.cancelable),
        composed: BooleanValue(dictionary.composed),
      };
      super(domString(type), eventInit);
      const fields = {
        key: dictionary.key == null ? null : domString(dictionary.key),
        oldValue: dictionary.oldValue == null ? null : domString(dictionary.oldValue),
        newValue: dictionary.newValue == null ? null : domString(dictionary.newValue),
        url: dictionary.url == null ? '' : domString(dictionary.url),
        storageArea: storageAreaFrom(dictionary.storageArea),
      };
      callWeakSet(storageEventStates, this, fields);
    }
    get key() { return storageEventState(this).key; }
    get oldValue() { return storageEventState(this).oldValue; }
    get newValue() { return storageEventState(this).newValue; }
    get url() { return storageEventState(this).url; }
    get storageArea() { return storageEventState(this).storageArea; }
  }
  function storageEventState(event) {
    const state = callWeakGet(storageEventStates, event);
    if (!state) throw new TypeError('Illegal invocation.');
    return state;
  }
  defineProperty(StorageEvent.prototype, symbolToStringTag, {value: 'StorageEvent', configurable: true});

  function invalidSnapshot(message) {
    snapshot = null;
    areas.local.values = new MapValue();
    areas.local.order = [];
    areas.session.values = new MapValue();
    areas.session.order = [];
    invalidStateReported = false;
    emitDiagnostic('storage.state_unavailable', message);
    return false;
  }

  function sync(input) {
    if (!input || typeof input !== 'object' || !isSafeInteger(input.generation) || input.generation < 0 ||
        !isSafeInteger(input.revision) || input.revision < 0 || typeof input.origin !== 'string' ||
        !(input.sessionKey == null || typeof input.sessionKey === 'string') ||
        !isSafeInteger(input.quotaBytes) || input.quotaBytes < 0 || !URLValue) {
      return invalidSnapshot('The native Storage snapshot is invalid.');
    }
    let parsedOrigin;
    try { parsedOrigin = new URLValue(input.origin); } catch (_) {
      return invalidSnapshot('The native Storage snapshot has an invalid origin.');
    }
    if ((parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') ||
        parsedOrigin.origin !== input.origin) {
      return invalidSnapshot('Storage is unavailable for opaque or non-HTTP document origins.');
    }
    let local, session;
    try {
      local = cloneArea(input.local);
      session = cloneArea(input.session);
    } catch (error) {
      return invalidSnapshot(StringValue(error && error.message || 'The native Storage snapshot is invalid.'));
    }
    if (usedBytes(local) > input.quotaBytes || usedBytes(session) > input.quotaBytes) {
      return invalidSnapshot('The native Storage snapshot exceeds its quota.');
    }
    if (snapshot) {
      if (input.generation === snapshot.generation &&
          (input.origin !== snapshot.origin || input.sessionKey !== snapshot.sessionKey)) {
        return invalidSnapshot('The native Storage identity changed within a document generation.');
      }
      if (input.generation === snapshot.generation && input.revision <= snapshot.revision) return false;
      if (writes.length) {
        emitDiagnostic('storage.pending_writes', 'A Storage snapshot arrived before pending writes were drained.');
        return false;
      }
    }
    snapshot = {
      generation: input.generation,
      revision: input.revision,
      origin: input.origin,
      sessionKey: input.sessionKey == null ? null : input.sessionKey,
      quotaBytes: input.quotaBytes,
    };
    areas.local.values = local.values;
    areas.local.order = local.order;
    areas.session.values = session.values;
    areas.session.order = session.order;
    invalidStateReported = false;
    return true;
  }

  function markTrusted(event) {
    try {
      defineProperty(event, 'isTrusted', {value: true, enumerable: true, configurable: true});
    } catch (_) { /* some host Event implementations expose an unforgeable slot */ }
  }

  function dispatchStorageEvent(payload) {
    const current = activeState();
    if (!payload || typeof payload !== 'object') return false;
    if (payload.generation != null && payload.generation !== current.snapshot.generation) return false;
    if (payload.origin != null && payload.origin !== current.origin) return false;
    if (payload.area === 'session' && payload.sessionKey != null && payload.sessionKey !== current.snapshot.sessionKey) return false;
    const areaName = payload.area;
    const storageArea = areaName === 'local' ? localStorageObject :
      areaName === 'session' ? sessionStorageObject : null;
    if (!storageArea) {
      emitDiagnostic('storage.event_invalid', 'A native Storage event had an unknown area.');
      return false;
    }
    const event = new StorageEvent('storage', {
      key: payload.key,
      oldValue: payload.oldValue,
      newValue: payload.newValue,
      url: payload.url,
      storageArea,
    });
    markTrusted(event);
    return nativeDispatch(event);
  }

  function takeWrites() {
    const result = [];
    for (let i = 0; i < writes.length; i++) {
      const source = writes[i];
      const copy = objectCreate(null);
      const names = ['area', 'type', 'key', 'value', 'url', 'generation'];
      for (let j = 0; j < names.length; j++) {
        const key = names[j];
        if (source[key] !== undefined) copy[key] = source[key];
      }
      push(result, copy);
    }
    writes = [];
    queuedCodeUnits = 0;
    return result;
  }

  function install(window) {
    if (!window || (typeof window !== 'object' && typeof window !== 'function')) {
      throw new TypeError('A document window is required.');
    }
    if (installedWindow) {
      if (installedWindow === window) return api;
      throw new TypeError('Document Storage is already installed on another window.');
    }
    installedWindow = window;
    defineProperty(window, 'Storage', {
      value: Storage, writable: true, configurable: true, enumerable: false,
    });
    defineProperty(window, 'StorageEvent', {
      value: StorageEvent, writable: true, configurable: true, enumerable: false,
    });
    defineProperty(window, 'localStorage', {
      get() { activeState(); return localStorageObject; },
      configurable: true,
      enumerable: true,
    });
    defineProperty(window, 'sessionStorage', {
      get() { activeState(); return sessionStorageObject; },
      configurable: true,
      enumerable: true,
    });
    return api;
  }

  const api = ObjectValue.freeze({
    install,
    sync,
    takeWrites,
    hasWrites() { return writes.length > 0; },
    dispatchEvent: dispatchStorageEvent,
  });
  return api;
}
