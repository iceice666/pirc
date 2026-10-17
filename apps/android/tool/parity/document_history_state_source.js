/*
 * JSON-safe structured-clone graph codec for History.state.
 *
 * The graph transports references by numeric node IDs, so aliases and cycles do
 * not rely on JSON object identity. maxBytes limits the UTF-8 size of the JSON
 * graph (including base64 expansion); maxNodes counts unique graph nodes and
 * array slots, which also bounds sparse-array allocation during decoding.
 *
 * Supported values: ordinary objects, arrays (including holes), primitive
 * values, boxed Number/String/Boolean/BigInt, Date, RegExp, Map, Set,
 * ArrayBuffer, DataView, and standard TypedArrays. This intentionally does not
 * implement transferable objects, SharedArrayBuffer, Error subclasses, Blob,
 * File, URL/fetch objects, or arbitrary native host objects. DOM host objects
 * are rejected through the injected isUnsupportedHostObject predicate.
 */
function createHistoryStateCodec(options = {}) {
  const DOMExceptionCtor =
    typeof options.DOMException === 'function' ? options.DOMException : null;
  const maxBytes = options.maxBytes === undefined ? 2 * 1024 * 1024 : options.maxBytes;
  const maxNodes = options.maxNodes === undefined ? 10000 : options.maxNodes;
  const isUnsupportedHostObject =
    typeof options.isUnsupportedHostObject === 'function'
      ? options.isUnsupportedHostObject
      : () => false;

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 0) {
    throw new TypeError('maxNodes must be a non-negative safe integer.');
  }

  const functionToString = Function.prototype.toString;
  const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  const defineProperty = Object.defineProperty;
  const getPrototypeOf = Object.getPrototypeOf;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const ownKeys = Reflect.ownKeys;
  const arrayIsArray = Array.isArray;
  const arrayBufferIsView = ArrayBuffer.isView;
  const mapForEach = Map.prototype.forEach;
  const setForEach = Set.prototype.forEach;
  const weakMapHas = WeakMap.prototype.has;
  const weakSetHas = WeakSet.prototype.has;
  const weakBrandKey = {};
  const typedArrayPrototype =
    typeof Uint8Array === 'function' ? getPrototypeOf(Uint8Array.prototype) : null;
  const typedArrayTagGetter = typedArrayPrototype &&
    getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
  const typedArrayBufferGetter = typedArrayPrototype &&
    getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
  const typedArrayByteOffsetGetter = typedArrayPrototype &&
    getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
  const typedArrayByteLengthGetter = typedArrayPrototype &&
    getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
  const typedArrayLengthGetter = typedArrayPrototype &&
    getOwnPropertyDescriptor(typedArrayPrototype, 'length')?.get;

  const arrayBufferByteLengthGetter = typeof ArrayBuffer === 'function'
    ? getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get
    : null;
  const dataViewBufferGetter = typeof DataView === 'function'
    ? getOwnPropertyDescriptor(DataView.prototype, 'buffer')?.get
    : null;
  const dataViewByteOffsetGetter = typeof DataView === 'function'
    ? getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')?.get
    : null;
  const dataViewByteLengthGetter = typeof DataView === 'function'
    ? getOwnPropertyDescriptor(DataView.prototype, 'byteLength')?.get
    : null;
  const regexpSourceGetter = typeof RegExp === 'function'
    ? getOwnPropertyDescriptor(RegExp.prototype, 'source')?.get
    : null;
  const urlHrefGetter = typeof URL === 'function'
    ? getOwnPropertyDescriptor(URL.prototype, 'href')?.get
    : null;
  const blobSizeGetter = typeof Blob === 'function'
    ? getOwnPropertyDescriptor(Blob.prototype, 'size')?.get
    : null;
  const regexpFlags = [
    ['hasIndices', 'd'],
    ['global', 'g'],
    ['ignoreCase', 'i'],
    ['multiline', 'm'],
    ['dotAll', 's'],
    ['unicode', 'u'],
    ['unicodeSets', 'v'],
    ['sticky', 'y']
  ].map(([name, flag]) => [
    flag,
    typeof RegExp === 'function'
      ? getOwnPropertyDescriptor(RegExp.prototype, name)?.get || null
      : null
  ]);

  const typedArrayByteSizes = {
    Int8Array: 1,
    Uint8Array: 1,
    Uint8ClampedArray: 1,
    Int16Array: 2,
    Uint16Array: 2,
    Int32Array: 4,
    Uint32Array: 4,
    Float32Array: 4,
    Float64Array: 8,
    BigInt64Array: 8,
    BigUint64Array: 8
  };
  const typedArrayConstructors = Object.create(null);
  for (const name of Object.keys(typedArrayByteSizes)) {
    if (typeof globalThis[name] === 'function') {
      typedArrayConstructors[name] = globalThis[name];
    }
  }

  function makeDataCloneError(message) {
    if (DOMExceptionCtor) {
      try {
        return new DOMExceptionCtor(message || 'The value cannot be cloned.', 'DataCloneError');
      } catch (ignored) {}
    }
    const error = new Error(message || 'The value cannot be cloned.');
    error.name = 'DataCloneError';
    return error;
  }

  function failClone(message) {
    throw makeDataCloneError(message);
  }

  function safeCallGetter(getter, value) {
    if (typeof getter !== 'function') return { ok: false };
    try {
      return { ok: true, value: getter.call(value) };
    } catch (ignored) {
      return { ok: false };
    }
  }

  function safeCallValueOf(method, value) {
    if (typeof method !== 'function') return { ok: false };
    try {
      return { ok: true, value: method.call(value) };
    } catch (ignored) {
      return { ok: false };
    }
  }

  function isNativeFunction(value) {
    if (typeof value !== 'function') return false;
    try {
      return /\[native code\]/.test(functionToString.call(value));
    } catch (ignored) {
      return false;
    }
  }

  function nativeConstructorName(value) {
    let prototype;
    try {
      prototype = getPrototypeOf(value);
    } catch (ignored) {
      failClone('Proxy and inaccessible host objects cannot be cloned.');
    }
    const visited = new Set();
    while (prototype !== null) {
      if (visited.has(prototype)) {
        failClone('Cyclic prototype chains cannot be cloned.');
      }
      visited.add(prototype);
      let descriptor;
      try {
        descriptor = getOwnPropertyDescriptor(prototype, 'constructor');
      } catch (ignored) {
        failClone('Inaccessible host objects cannot be cloned.');
      }
      if (descriptor && hasOwn(descriptor, 'value')) {
        const constructor = descriptor.value;
        if (isNativeFunction(constructor) && constructor.name !== 'Object') {
          return constructor.name || 'native host object';
        }
      }
      try {
        prototype = getPrototypeOf(prototype);
      } catch (ignored) {
        failClone('Inaccessible host objects cannot be cloned.');
      }
    }
    return null;
  }

  function checkHostObject(value) {
    if (blobSizeGetter && safeCallGetter(blobSizeGetter, value).ok) {
      failClone('Blob and File history.state values are unsupported.');
    }
    if (urlHrefGetter && safeCallGetter(urlHrefGetter, value).ok) {
      failClone('URL history.state values are unsupported.');
    }
    const name = nativeConstructorName(value);
    if (!name) return;
    if (name === 'Blob' || name === 'File') {
      failClone('Blob and File history.state values are unsupported.');
    }
    if (name === 'SharedArrayBuffer') {
      failClone('SharedArrayBuffer history.state values are unsupported.');
    }
    failClone(`Unsupported native host object: ${name}.`);
  }

  function jsonStringByteLength(value) {
    let length = 2;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 0x22 || code === 0x5c) {
        length += 2;
      } else if (code === 0x08 || code === 0x09 || code === 0x0a ||
                 code === 0x0c || code === 0x0d) {
        length += 2;
      } else if (code < 0x20) {
        length += 6;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          length += 4;
          index++;
        } else {
          length += 6;
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        length += 6;
      } else if (code <= 0x7f) {
        length++;
      } else if (code <= 0x7ff) {
        length += 2;
      } else {
        length += 3;
      }
    }
    return length;
  }

  function jsonByteLength(value, limit) {
    let total = 0;
    const active = new Set();
    function add(amount) {
      total += amount;
      if (total > limit) {
        failClone(`Serialized history.state exceeds the ${limit}-byte JSON limit.`);
      }
    }
    function visit(current) {
      if (current === null) {
        add(4);
      } else if (typeof current === 'string') {
        add(jsonStringByteLength(current));
      } else if (typeof current === 'boolean') {
        add(current ? 4 : 5);
      } else if (typeof current === 'number') {
        if (!Number.isFinite(current)) {
          failClone('Non-finite graph values are not JSON-safe.');
        }
        add(current === 0 ? 1 : String(current).length);
      } else if (arrayIsArray(current)) {
        if (active.has(current)) failClone('The encoded graph must not contain cycles.');
        active.add(current);
        let length;
        try {
          const descriptor = getOwnPropertyDescriptor(current, 'length');
          length = descriptor && descriptor.value;
        } catch (ignored) {
          failClone('The encoded graph contains an inaccessible array.');
        }
        if (!Number.isSafeInteger(length) || length < 0) {
          failClone('The encoded graph contains an invalid array length.');
        }
        add(2);
        for (let index = 0; index < length; index++) {
          if (index) add(1);
          let descriptor;
          try {
            descriptor = getOwnPropertyDescriptor(current, String(index));
          } catch (ignored) {
            failClone('The encoded graph contains an inaccessible array.');
          }
          if (!descriptor || !hasOwn(descriptor, 'value')) {
            failClone('The encoded graph must use dense JSON arrays.');
          }
          visit(descriptor.value);
        }
        active.delete(current);
      } else if (typeof current === 'object') {
        if (active.has(current)) failClone('The encoded graph must not contain cycles.');
        active.add(current);
        let keys;
        try {
          keys = Object.keys(current);
        } catch (ignored) {
          failClone('The encoded graph contains an inaccessible object.');
        }
        add(2);
        for (let index = 0; index < keys.length; index++) {
          if (index) add(1);
          const key = keys[index];
          let descriptor;
          try {
            descriptor = getOwnPropertyDescriptor(current, key);
          } catch (ignored) {
            failClone('The encoded graph contains an inaccessible object.');
          }
          if (!descriptor || !hasOwn(descriptor, 'value')) {
            failClone('The encoded graph must contain only data properties.');
          }
          add(jsonStringByteLength(key));
          add(1);
          visit(descriptor.value);
        }
        active.delete(current);
      } else {
        failClone('The encoded graph contains a non-JSON value.');
      }
    }
    visit(value);
    return total;
  }

  function encodeBase64(bytes) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let output = '';
    for (let index = 0; index < bytes.length; index += 3) {
      const first = bytes[index];
      const hasSecond = index + 1 < bytes.length;
      const hasThird = index + 2 < bytes.length;
      const second = hasSecond ? bytes[index + 1] : 0;
      const third = hasThird ? bytes[index + 2] : 0;
      output += alphabet[first >> 2];
      output += alphabet[((first & 3) << 4) | (second >> 4)];
      output += hasSecond ? alphabet[((second & 15) << 2) | (third >> 6)] : '=';
      output += hasThird ? alphabet[third & 63] : '=';
    }
    return output;
  }

  function decodeBase64(value) {
    if (typeof value !== 'string' || value.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      failClone('Invalid ArrayBuffer base64 payload.');
    }
    const outputLength = value.length === 0
      ? 0
      : (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
    if (outputLength > maxBytes) {
      failClone('ArrayBuffer payload exceeds the configured byte limit.');
    }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const reverse = Object.create(null);
    for (let index = 0; index < alphabet.length; index++) reverse[alphabet[index]] = index;
    const output = new Uint8Array(outputLength);
    let offset = 0;
    for (let index = 0; index < value.length; index += 4) {
      const first = reverse[value[index]];
      const second = reverse[value[index + 1]];
      const third = value[index + 2] === '=' ? 0 : reverse[value[index + 2]];
      const fourth = value[index + 3] === '=' ? 0 : reverse[value[index + 3]];
      if (offset < outputLength) output[offset++] = (first << 2) | (second >> 4);
      if (offset < outputLength) output[offset++] = ((second & 15) << 4) | (third >> 2);
      if (offset < outputLength) output[offset++] = ((third & 3) << 6) | fourth;
    }
    if (value.endsWith('==') && value.length >= 4 &&
        (reverse[value[value.length - 3]] & 15) !== 0) {
      failClone('Non-canonical ArrayBuffer base64 payload.');
    }
    if (value.endsWith('=') && !value.endsWith('==') && value.length >= 4 &&
        (reverse[value[value.length - 2]] & 3) !== 0) {
      failClone('Non-canonical ArrayBuffer base64 payload.');
    }
    return output;
  }

  function encode(value) {
    const nodes = [];
    const seen = new WeakMap();
    let nodeBudget = 0;

    function charge(amount) {
      nodeBudget += amount;
      if (nodeBudget > maxNodes) {
        failClone(`History.state graph exceeds the ${maxNodes}-node limit.`);
      }
    }

    function reserve(object, node) {
      charge(1);
      const index = nodes.length;
      nodes.push(node);
      seen.set(object, index);
      return ['r', index];
    }

    function encodeValue(current) {
      if (current === null || typeof current === 'string' || typeof current === 'boolean') {
        return current;
      }
      if (typeof current === 'number') {
        if (Number.isNaN(current)) return ['n', 'NaN'];
        if (current === Infinity) return ['n', 'Infinity'];
        if (current === -Infinity) return ['n', '-Infinity'];
        if (Object.is(current, -0)) return ['n', '-0'];
        return current;
      }
      if (typeof current === 'undefined') return ['u'];
      if (typeof current === 'bigint') return ['i', current.toString(10)];
      if (typeof current === 'symbol') failClone('Symbol values cannot be cloned.');
      if (typeof current === 'function') failClone('Function values cannot be cloned.');
      if (typeof current !== 'object') failClone('Unsupported History.state value.');

      if (seen.has(current)) return ['r', seen.get(current)];
      let isArray;
      try {
        isArray = arrayIsArray(current);
      } catch (ignored) {
        failClone('Proxy values cannot be cloned.');
      }
      if (isArray) {
        const length = current.length;
        charge(1 + length);
        const index = nodes.length;
        const node = { type: 'Array', length, items: [] };
        nodes.push(node);
        seen.set(current, index);
        let keys;
        try {
          keys = Object.keys(current);
        } catch (ignored) {
          failClone('Proxy arrays cannot be cloned.');
        }
        for (const key of keys) {
          const itemIndex = Number(key);
          if (!Number.isInteger(itemIndex) || itemIndex < 0 ||
              itemIndex >= length || String(itemIndex) !== key) {
            continue;
          }
          // Read each enumerable own element exactly once; absent indexes remain holes.
          node.items.push([itemIndex, encodeValue(current[key])]);
        }
        return ['r', index];
      }

      try {
        if (isUnsupportedHostObject(current)) {
          failClone('DOM and other injected unsupported host objects cannot be cloned.');
        }
      } catch (error) {
        if (error && error.name === 'DataCloneError') throw error;
        throw error;
      }

      const symbolBox = typeof Symbol === 'function'
        ? safeCallValueOf(Symbol.prototype.valueOf, current)
        : { ok: false };
      if (symbolBox.ok) failClone('Symbol objects cannot be cloned.');

      const numberBox = safeCallValueOf(Number.prototype.valueOf, current);
      if (numberBox.ok) {
        const ref = reserve(current, { type: 'Boxed', kind: 'Number', value: encodeValue(numberBox.value) });
        return ref;
      }
      const stringBox = safeCallValueOf(String.prototype.valueOf, current);
      if (stringBox.ok) {
        return reserve(current, { type: 'Boxed', kind: 'String', value: stringBox.value });
      }
      const booleanBox = safeCallValueOf(Boolean.prototype.valueOf, current);
      if (booleanBox.ok) {
        return reserve(current, { type: 'Boxed', kind: 'Boolean', value: booleanBox.value });
      }
      const bigintBox = typeof BigInt === 'function'
        ? safeCallValueOf(BigInt.prototype.valueOf, current)
        : { ok: false };
      if (bigintBox.ok) {
        return reserve(current, { type: 'Boxed', kind: 'BigInt', value: ['i', bigintBox.value.toString(10)] });
      }

      const dateTime = typeof Date === 'function'
        ? safeCallValueOf(Date.prototype.getTime, current)
        : { ok: false };
      if (dateTime.ok) {
        return reserve(current, {
          type: 'Date',
          time: Number.isNaN(dateTime.value) ? null : dateTime.value
        });
      }

      const regexpSource = safeCallGetter(regexpSourceGetter, current);
      if (regexpSource.ok) {
        let flags = '';
        for (const [flag, getter] of regexpFlags) {
          const result = safeCallGetter(getter, current);
          if (result.ok && result.value) flags += flag;
        }
        return reserve(current, { type: 'RegExp', source: regexpSource.value, flags });
      }

      let mapEntries = null;
      try {
        const collected = [];
        mapForEach.call(current, (entryValue, entryKey) => {
          collected.push([entryKey, entryValue]);
        });
        mapEntries = collected;
      } catch (ignored) {}
      if (mapEntries !== null) {
        const ref = reserve(current, { type: 'Map', entries: [] });
        const node = nodes[ref[1]];
        for (const entry of mapEntries) {
          node.entries.push([encodeValue(entry[0]), encodeValue(entry[1])]);
        }
        return ref;
      }

      let setValues = null;
      try {
        const collected = [];
        setForEach.call(current, entryValue => collected.push(entryValue));
        setValues = collected;
      } catch (ignored) {}
      if (setValues !== null) {
        const ref = reserve(current, { type: 'Set', values: [] });
        const node = nodes[ref[1]];
        for (const item of setValues) node.values.push(encodeValue(item));
        return ref;
      }

      const arrayBufferLength = safeCallGetter(arrayBufferByteLengthGetter, current);
      if (arrayBufferLength.ok) {
        if (arrayBufferLength.value > maxBytes) {
          failClone('ArrayBuffer payload exceeds the configured byte limit.');
        }
        let bytes;
        try {
          bytes = new Uint8Array(current);
        } catch (ignored) {
          failClone('Detached ArrayBuffers cannot be cloned.');
        }
        const ref = reserve(current, {
          type: 'ArrayBuffer',
          bytes: encodeBase64(bytes)
        });
        return ref;
      }

      if (arrayBufferIsView(current)) {
        const dataViewBuffer = safeCallGetter(dataViewBufferGetter, current);
        if (dataViewBuffer.ok) {
          const byteOffset = safeCallGetter(dataViewByteOffsetGetter, current).value;
          const byteLength = safeCallGetter(dataViewByteLengthGetter, current).value;
          const ref = reserve(current, {
            type: 'DataView',
            buffer: null,
            byteOffset,
            byteLength
          });
          nodes[ref[1]].buffer = encodeValue(dataViewBuffer.value);
          return ref;
        }
        const nameResult = safeCallGetter(typedArrayTagGetter, current);
        const name = nameResult.ok ? nameResult.value : null;
        if (typeof name === 'string' && hasOwn(typedArrayByteSizes, name)) {
          const buffer = safeCallGetter(typedArrayBufferGetter, current);
          const byteOffset = safeCallGetter(typedArrayByteOffsetGetter, current);
          const length = safeCallGetter(typedArrayLengthGetter, current);
          const byteLength = safeCallGetter(typedArrayByteLengthGetter, current);
          if (!buffer.ok || !byteOffset.ok || !length.ok || !byteLength.ok) {
            failClone('Detached TypedArrays cannot be cloned.');
          }
          const ref = reserve(current, {
            type: 'TypedArray',
            name,
            buffer: null,
            byteOffset: byteOffset.value,
            length: length.value
          });
          nodes[ref[1]].buffer = encodeValue(buffer.value);
          return ref;
        }
        failClone('Unsupported ArrayBuffer view type.');
      }

      let weakMap = false;
      try {
        weakMapHas.call(current, weakBrandKey);
        weakMap = true;
      } catch (ignored) {}
      if (weakMap) failClone('WeakMap values cannot be cloned.');
      let weakSet = false;
      try {
        weakSetHas.call(current, weakBrandKey);
        weakSet = true;
      } catch (ignored) {}
      if (weakSet) failClone('WeakSet values cannot be cloned.');

      checkHostObject(current);

      let keys;
      try {
        keys = Object.keys(current);
      } catch (ignored) {
        failClone('Proxy and inaccessible objects cannot be cloned.');
      }
      const ref = reserve(current, { type: 'Object', props: [] });
      const node = nodes[ref[1]];
      for (const key of keys) {
        // Reflective read invokes an enumerable getter exactly once. Its exception
        // deliberately escapes unchanged, as it does during structured cloning.
        node.props.push([key, encodeValue(current[key])]);
      }
      return ref;
    }

    const root = encodeValue(value);
    const graph = { version: 1, root, nodes };
    jsonByteLength(graph, maxBytes);
    return graph;
  }

  function plainRecord(value) {
    if (!value || typeof value !== 'object' || arrayIsArray(value)) return false;
    let prototype;
    try {
      prototype = getPrototypeOf(value);
    } catch (ignored) {
      return false;
    }
    if (prototype === null) return true;
    const constructorDescriptor = getOwnPropertyDescriptor(prototype, 'constructor');
    const constructor = constructorDescriptor && hasOwn(constructorDescriptor, 'value')
      ? constructorDescriptor.value
      : null;
    return typeof constructor === 'function' && constructor.name === 'Object' &&
      isNativeFunction(constructor);
  }

  function exactRecordKeys(value, expectedKeys, label) {
    if (!plainRecord(value)) failClone(`${label} must be a plain JSON object.`);
    let keys;
    try {
      keys = ownKeys(value);
    } catch (ignored) {
      failClone(`${label} has inaccessible properties.`);
    }
    if (keys.length !== expectedKeys.length ||
        expectedKeys.some(key => !keys.includes(key))) {
      failClone(`${label} has unexpected properties.`);
    }
    for (const key of expectedKeys) {
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, 'value')) {
        failClone(`${label}.${key} must be an enumerable data property.`);
      }
    }
  }

  function readData(value, key, label) {
    const descriptor = getOwnPropertyDescriptor(value, key);
    if (!descriptor || !hasOwn(descriptor, 'value')) {
      failClone(`${label}.${key} must be a data property.`);
    }
    return descriptor.value;
  }

  function denseArrayValues(value, label, expectedLength) {
    let isArray;
    try {
      isArray = arrayIsArray(value);
    } catch (ignored) {
      failClone(`${label} must be an array.`);
    }
    if (!isArray) failClone(`${label} must be an array.`);
    const lengthDescriptor = getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor && lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 ||
        (expectedLength !== undefined && length !== expectedLength)) {
      failClone(`${label} has an invalid length.`);
    }
    let keys;
    try {
      keys = ownKeys(value);
    } catch (ignored) {
      failClone(`${label} has inaccessible properties.`);
    }
    if (keys.length !== length + 1 || !keys.includes('length')) {
      failClone(`${label} must be a dense JSON array without extra properties.`);
    }
    const result = new Array(length);
    for (let index = 0; index < length; index++) {
      const descriptor = getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, 'value')) {
        failClone(`${label} must contain only dense data entries.`);
      }
      result[index] = descriptor.value;
    }
    return result;
  }

  function decodeEncoding(encoded, nodeCount, label) {
    if (encoded === null || typeof encoded === 'string' || typeof encoded === 'boolean') {
      return { kind: 'primitive', value: encoded };
    }
    if (typeof encoded === 'number') {
      if (!Number.isFinite(encoded) || Object.is(encoded, -0)) {
        failClone(`${label} contains an untagged special number.`);
      }
      return { kind: 'primitive', value: encoded };
    }
    if (!arrayIsArray(encoded)) failClone(`${label} has an invalid encoded value.`);
    const parts = denseArrayValues(encoded, label);
    const tag = parts[0];
    if (tag === 'u' && parts.length === 1) return { kind: 'undefined' };
    if (tag === 'r' && parts.length === 2) {
      const index = parts[1];
      if (!Number.isSafeInteger(index) || index < 0 || index >= nodeCount) {
        failClone(`${label} contains an out-of-range reference.`);
      }
      return { kind: 'reference', index };
    }
    if (tag === 'n' && parts.length === 2 &&
        ['NaN', 'Infinity', '-Infinity', '-0'].includes(parts[1])) {
      return { kind: 'number', value: parts[1] };
    }
    if (tag === 'i' && parts.length === 2 && typeof parts[1] === 'string' &&
        /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(parts[1])) {
      return { kind: 'bigint', value: parts[1] };
    }
    failClone(`${label} has an invalid encoding tag.`);
  }

  function deserialize(graph) {
    jsonByteLength(graph, maxBytes);
    exactRecordKeys(graph, ['version', 'root', 'nodes'], 'graph');
    const version = readData(graph, 'version', 'graph');
    if (version !== 1) failClone('Unsupported history.state graph version.');
    const rawNodes = denseArrayValues(readData(graph, 'nodes', 'graph'), 'graph.nodes');
    if (rawNodes.length > maxNodes) {
      failClone(`History.state graph exceeds the ${maxNodes}-node limit.`);
    }

    const parsedNodes = new Array(rawNodes.length);
    let nodeBudget = rawNodes.length;
    function readPairs(value, label) {
      const rawPairs = denseArrayValues(value, label);
      return rawPairs.map((rawPair, index) => {
        const pair = denseArrayValues(rawPair, `${label}[${index}]`, 2);
        return pair;
      });
    }
    function parseValue(value, label) {
      return decodeEncoding(value, rawNodes.length, label);
    }
    function checkProperties(pairs, label, arrayItems = false, arrayLength = 0) {
      const seenKeys = new Set();
      for (let index = 0; index < pairs.length; index++) {
        const [key, encoded] = pairs[index];
        if (arrayItems) {
          if (!Number.isSafeInteger(key) || key < 0 || key >= arrayLength || seenKeys.has(key)) {
            failClone(`${label} has an invalid or duplicate array index.`);
          }
          seenKeys.add(key);
        } else {
          if (typeof key !== 'string' || seenKeys.has(key)) {
            failClone(`${label} has an invalid or duplicate property key.`);
          }
          seenKeys.add(key);
        }
        parseValue(encoded, `${label}[${String(key)}]`);
      }
    }

    for (let index = 0; index < rawNodes.length; index++) {
      const raw = rawNodes[index];
      if (!plainRecord(raw)) failClone(`graph.nodes[${index}] must be a plain object.`);
      const type = readData(raw, 'type', `graph.nodes[${index}]`);
      let parsed;
      if (type === 'Object') {
        exactRecordKeys(raw, ['type', 'props'], `graph.nodes[${index}]`);
        parsed = { type, props: readPairs(readData(raw, 'props', 'node'), 'Object.props') };
        checkProperties(parsed.props, 'Object.props');
      } else if (type === 'Array') {
        exactRecordKeys(raw, ['type', 'length', 'items'], `graph.nodes[${index}]`);
        const length = readData(raw, 'length', 'Array');
        if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) {
          failClone('Array node has an invalid length.');
        }
        nodeBudget += length;
        if (nodeBudget > maxNodes) {
          failClone(`History.state graph exceeds the ${maxNodes}-node/slot limit.`);
        }
        parsed = { type, length, items: readPairs(readData(raw, 'items', 'Array'), 'Array.items') };
        checkProperties(parsed.items, 'Array.items', true, length);
      } else if (type === 'Date') {
        exactRecordKeys(raw, ['type', 'time'], `graph.nodes[${index}]`);
        const time = readData(raw, 'time', 'Date');
        if (time !== null && (typeof time !== 'number' || !Number.isFinite(time))) {
          failClone('Date node has an invalid time value.');
        }
        parsed = { type, time };
      } else if (type === 'RegExp') {
        exactRecordKeys(raw, ['type', 'source', 'flags'], `graph.nodes[${index}]`);
        const source = readData(raw, 'source', 'RegExp');
        const flags = readData(raw, 'flags', 'RegExp');
        if (typeof source !== 'string' || typeof flags !== 'string' ||
            new Set(flags).size !== flags.length || /[^dgimsuvy]/.test(flags)) {
          failClone('RegExp node has invalid source or flags.');
        }
        try {
          new RegExp(source, flags);
        } catch (ignored) {
          failClone('RegExp node cannot be constructed.');
        }
        parsed = { type, source, flags };
      } else if (type === 'Map') {
        exactRecordKeys(raw, ['type', 'entries'], `graph.nodes[${index}]`);
        parsed = { type, entries: readPairs(readData(raw, 'entries', 'Map'), 'Map.entries') };
        for (const [key, value] of parsed.entries) {
          parseValue(key, 'Map key');
          parseValue(value, 'Map value');
        }
      } else if (type === 'Set') {
        exactRecordKeys(raw, ['type', 'values'], `graph.nodes[${index}]`);
        parsed = { type, values: denseArrayValues(readData(raw, 'values', 'Set'), 'Set.values') };
        for (const value of parsed.values) parseValue(value, 'Set value');
      } else if (type === 'ArrayBuffer') {
        exactRecordKeys(raw, ['type', 'bytes'], `graph.nodes[${index}]`);
        const bytes = decodeBase64(readData(raw, 'bytes', 'ArrayBuffer'));
        parsed = { type, bytes };
      } else if (type === 'TypedArray') {
        exactRecordKeys(raw, ['type', 'name', 'buffer', 'byteOffset', 'length'], `graph.nodes[${index}]`);
        const name = readData(raw, 'name', 'TypedArray');
        const byteOffset = readData(raw, 'byteOffset', 'TypedArray');
        const length = readData(raw, 'length', 'TypedArray');
        if (typeof name !== 'string' || !hasOwn(typedArrayByteSizes, name) ||
            !Number.isSafeInteger(byteOffset) || byteOffset < 0 ||
            !Number.isSafeInteger(length) || length < 0) {
          failClone('TypedArray node has invalid metadata.');
        }
        const buffer = parseValue(readData(raw, 'buffer', 'TypedArray'), 'TypedArray.buffer');
        if (buffer.kind !== 'reference') failClone('TypedArray buffer must be a graph reference.');
        parsed = { type, name, buffer: buffer.index, byteOffset, length };
      } else if (type === 'DataView') {
        exactRecordKeys(raw, ['type', 'buffer', 'byteOffset', 'byteLength'], `graph.nodes[${index}]`);
        const byteOffset = readData(raw, 'byteOffset', 'DataView');
        const byteLength = readData(raw, 'byteLength', 'DataView');
        if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 ||
            !Number.isSafeInteger(byteLength) || byteLength < 0) {
          failClone('DataView node has invalid metadata.');
        }
        const buffer = parseValue(readData(raw, 'buffer', 'DataView'), 'DataView.buffer');
        if (buffer.kind !== 'reference') failClone('DataView buffer must be a graph reference.');
        parsed = { type, buffer: buffer.index, byteOffset, byteLength };
      } else if (type === 'Boxed') {
        exactRecordKeys(raw, ['type', 'kind', 'value'], `graph.nodes[${index}]`);
        const kind = readData(raw, 'kind', 'Boxed');
        const encoded = parseValue(readData(raw, 'value', 'Boxed'), 'Boxed.value');
        if (!['Number', 'String', 'Boolean', 'BigInt'].includes(kind)) {
          failClone('Boxed node has an unsupported primitive kind.');
        }
        const validKind = kind === 'Number'
          ? encoded.kind === 'primitive' && typeof encoded.value === 'number' || encoded.kind === 'number'
          : kind === 'String'
            ? encoded.kind === 'primitive' && typeof encoded.value === 'string'
            : kind === 'Boolean'
              ? encoded.kind === 'primitive' && typeof encoded.value === 'boolean'
              : encoded.kind === 'bigint';
        if (!validKind) failClone('Boxed node has an invalid primitive value.');
        parsed = { type, kind, value: encoded };
      } else {
        failClone('Graph contains an unknown node type.');
      }
      parsedNodes[index] = parsed;
    }

    const rootValue = parseValue(readData(graph, 'root', 'graph'), 'graph.root');
    const objects = new Array(parsedNodes.length);
    const arrayBufferLengths = new Array(parsedNodes.length);

    for (let index = 0; index < parsedNodes.length; index++) {
      const node = parsedNodes[index];
      try {
        switch (node.type) {
          case 'Object':
            objects[index] = {};
            break;
          case 'Array':
            objects[index] = new Array(node.length);
            break;
          case 'Date':
            objects[index] = new Date(node.time === null ? NaN : node.time);
            break;
          case 'RegExp':
            objects[index] = new RegExp(node.source, node.flags);
            // Structured cloning resets RegExp.lastIndex instead of copying it.
            objects[index].lastIndex = 0;
            break;
          case 'Map':
            objects[index] = new Map();
            break;
          case 'Set':
            objects[index] = new Set();
            break;
          case 'ArrayBuffer': {
            const buffer = new ArrayBuffer(node.bytes.length);
            new Uint8Array(buffer).set(node.bytes);
            objects[index] = buffer;
            arrayBufferLengths[index] = node.bytes.length;
            break;
          }
          case 'Boxed': {
            const primitive = materializeEncoding(node.value, objects);
            if (node.kind === 'Number') objects[index] = new Number(primitive);
            else if (node.kind === 'String') objects[index] = new String(primitive);
            else if (node.kind === 'Boolean') objects[index] = new Boolean(primitive);
            else objects[index] = Object(primitive);
            break;
          }
          case 'TypedArray':
          case 'DataView':
            break;
        }
      } catch (ignored) {
        failClone(`Could not allocate ${node.type} node.`);
      }
    }

    for (let index = 0; index < parsedNodes.length; index++) {
      const node = parsedNodes[index];
      if (node.type !== 'TypedArray' && node.type !== 'DataView') continue;
      const bufferNode = parsedNodes[node.buffer];
      if (!bufferNode || bufferNode.type !== 'ArrayBuffer') {
        failClone('View nodes must reference an ArrayBuffer node.');
      }
      const buffer = objects[node.buffer];
      const byteLength = arrayBufferLengths[node.buffer];
      try {
        if (node.type === 'DataView') {
          if (node.byteOffset + node.byteLength > byteLength) {
            failClone('DataView range exceeds its backing buffer.');
          }
          objects[index] = new DataView(buffer, node.byteOffset, node.byteLength);
        } else {
          const elementSize = typedArrayByteSizes[node.name];
          if (!typedArrayConstructors[node.name]) {
            failClone(`TypedArray type ${node.name} is not available.`);
          }
          if (node.byteOffset % elementSize !== 0 ||
              node.byteOffset + node.length * elementSize > byteLength) {
            failClone('TypedArray range exceeds or is misaligned with its backing buffer.');
          }
          objects[index] = new typedArrayConstructors[node.name](
            buffer,
            node.byteOffset,
            node.length
          );
        }
      } catch (error) {
        if (error && error.name === 'DataCloneError') throw error;
        failClone(`Could not allocate ${node.type} node.`);
      }
    }

    function materializeEncoding(encoded, allocated) {
      if (encoded.kind === 'primitive') return encoded.value;
      if (encoded.kind === 'undefined') return undefined;
      if (encoded.kind === 'reference') return allocated[encoded.index];
      if (encoded.kind === 'bigint') return BigInt(encoded.value);
      if (encoded.kind === 'number') {
        if (encoded.value === 'NaN') return NaN;
        if (encoded.value === 'Infinity') return Infinity;
        if (encoded.value === '-Infinity') return -Infinity;
        return -0;
      }
      failClone('Invalid decoded value.');
    }

    for (let index = 0; index < parsedNodes.length; index++) {
      const node = parsedNodes[index];
      const target = objects[index];
      if (node.type === 'Object') {
        for (const [key, encoded] of node.props) {
          defineProperty(target, key, {
            value: materializeEncoding(decodeEncoding(encoded, parsedNodes.length, 'Object property'), objects),
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      } else if (node.type === 'Array') {
        for (const [itemIndex, encoded] of node.items) {
          defineProperty(target, String(itemIndex), {
            value: materializeEncoding(decodeEncoding(encoded, parsedNodes.length, 'Array item'), objects),
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      } else if (node.type === 'Map') {
        for (const [key, value] of node.entries) {
          target.set(
            materializeEncoding(decodeEncoding(key, parsedNodes.length, 'Map key'), objects),
            materializeEncoding(decodeEncoding(value, parsedNodes.length, 'Map value'), objects)
          );
        }
      } else if (node.type === 'Set') {
        for (const value of node.values) {
          target.add(materializeEncoding(decodeEncoding(value, parsedNodes.length, 'Set value'), objects));
        }
      }
    }

    return materializeEncoding(rootValue, objects);
  }

  function clone(value) {
    return deserialize(encode(value));
  }

  return {
    serialize: encode,
    deserialize,
    clone
  };
}
