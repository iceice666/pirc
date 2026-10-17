/*
 * Fetch and body primitives for the native document-script runtime.
 * This file is concatenated into the runtime bundle and intentionally has no
 * imports, exports, or global side effects. Network policy and credentials
 * remain the responsibility of the host transport bound to the document.
 */
function createDocumentFetch(dependencies) {
  const deps = dependencies || {};
  const MAX_FETCH_BODY_BYTES = 2 * 1024 * 1024;
  const URLCtor = typeof deps.URL === 'function' ? deps.URL : URL;
  const URLSearchParamsCtor = typeof deps.URLSearchParams === 'function'
    ? deps.URLSearchParams
    : (typeof URLSearchParams === 'function' ? URLSearchParams : null);
  const binary = deps.binary && typeof deps.binary.encodeBody === 'function'
    ? deps.binary
    : null;
  const enqueue = typeof deps.enqueue === 'function'
    ? deps.enqueue
    : function() { throw new TypeError('The native fetch transport is unavailable.'); };
  const getBaseUrl = function() {
    const value = typeof deps.baseUrl === 'function' ? deps.baseUrl() : deps.baseUrl;
    return String(value || 'about:blank');
  };
  const requestStates = new WeakMap();
  const responseStates = new WeakMap();
  const completionTimes = new WeakMap();
  function rememberCompletion(value, completion) {
    const time = completion && completion.completedAt;
    if (typeof time === 'number' && Number.isFinite(time) && time >= 0)
      completionTimes.set(value, time);
    return value;
  }
  const headerStates = new WeakMap();
  const headerGuards = new WeakMap();
  const pending = new Map();
  const abortSignalToken = {};
  const abortSignalStates = new WeakMap();
  const requestCloneToken = {};
  let nextRequestId = 1;

  function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function utf8Encode(value) {
    const text = String(value);
    let length = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length &&
          text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
        length += 4;
        index += 1;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        length += 3;
      } else if (code < 0x80) {
        length += 1;
      } else if (code < 0x800) {
        length += 2;
      } else {
        length += 3;
      }
      if (length > MAX_FETCH_BODY_BYTES)
        throw new TypeError('Fetch request bodies cannot exceed 2 MiB.');
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (let index = 0; index < text.length; index++) {
      let code = text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        if (index + 1 < text.length) {
          const next = text.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
            index += 1;
          } else {
            code = 0xfffd;
          }
        } else {
          code = 0xfffd;
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        code = 0xfffd;
      }

      if (code < 0x80) {
        bytes[offset++] = code;
      } else if (code < 0x800) {
        bytes[offset++] = 0xc0 | (code >> 6);
        bytes[offset++] = 0x80 | (code & 0x3f);
      } else if (code < 0x10000) {
        bytes[offset++] = 0xe0 | (code >> 12);
        bytes[offset++] = 0x80 | ((code >> 6) & 0x3f);
        bytes[offset++] = 0x80 | (code & 0x3f);
      } else {
        bytes[offset++] = 0xf0 | (code >> 18);
        bytes[offset++] = 0x80 | ((code >> 12) & 0x3f);
        bytes[offset++] = 0x80 | ((code >> 6) & 0x3f);
        bytes[offset++] = 0x80 | (code & 0x3f);
      }
    }
    return bytes;
  }

  function utf8Decode(input) {
    const bytes = input || [];
    let result = '';
    for (let index = 0; index < bytes.length;) {
      const first = Number(bytes[index]) & 0xff;
      if (first < 0x80) {
        result += String.fromCharCode(first);
        index += 1;
        continue;
      }

      let count;
      let code;
      let minimum;
      if (first >= 0xc2 && first <= 0xdf) {
        count = 2;
        code = first & 0x1f;
        minimum = 0x80;
      } else if (first >= 0xe0 && first <= 0xef) {
        count = 3;
        code = first & 0x0f;
        minimum = 0x800;
      } else if (first >= 0xf0 && first <= 0xf4) {
        count = 4;
        code = first & 0x07;
        minimum = 0x10000;
      } else {
        result += '\ufffd';
        index += 1;
        continue;
      }

      if (index + count > bytes.length) {
        result += '\ufffd';
        index += 1;
        continue;
      }
      let valid = true;
      for (let offset = 1; offset < count; offset++) {
        const next = Number(bytes[index + offset]) & 0xff;
        if ((next & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        code = (code << 6) | (next & 0x3f);
      }
      if (!valid || code < minimum || code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)) {
        result += '\ufffd';
        index += 1;
        continue;
      }
      if (code <= 0xffff) {
        result += String.fromCharCode(code);
      } else {
        code -= 0x10000;
        result += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
      }
      index += count;
    }
    return result;
  }

  function bytesFromBase64(encoded) {
    const value = String(encoded).replace(/[\t\n\f\r ]/g, '');
    if (value.length > Math.ceil(MAX_FETCH_BODY_BYTES / 3) * 4 + 4)
      throw new TypeError('The native fetch response body cannot exceed 2 MiB.');
    const firstPadding = value.indexOf('=');
    const dataLength = firstPadding === -1 ? value.length : firstPadding;
    const paddingLength = value.length - dataLength;
    if (paddingLength > 2 || (firstPadding !== -1 && !/^={1,2}$/.test(value.slice(firstPadding))) ||
        (paddingLength > 0 && value.length % 4 !== 0) ||
        (paddingLength === 1 && dataLength % 4 !== 3) ||
        (paddingLength === 2 && dataLength % 4 !== 2) ||
        (paddingLength === 0 && dataLength % 4 === 1)) {
      throw new TypeError('The native fetch transport returned invalid base64 body data.');
    }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const size = Math.floor(dataLength * 6 / 8);
    if (size > MAX_FETCH_BODY_BYTES)
      throw new TypeError('The native fetch response body cannot exceed 2 MiB.');
    const bytes = new Uint8Array(size);
    let buffer = 0;
    let bits = 0;
    let offset = 0;
    for (let index = 0; index < dataLength; index++) {
      const digit = alphabet.indexOf(value.charAt(index));
      if (digit < 0)
        throw new TypeError('The native fetch transport returned invalid base64 body data.');
      buffer = (buffer << 6) | digit;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes[offset++] = (buffer >> bits) & 0xff;
      }
    }
    return bytes;
  }

  function bytesToBase64(bytes) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const chunks = [];
    const charCodes = new Uint8Array(8192);
    let charOffset = 0;
    function flush() {
      chunks.push(String.fromCharCode.apply(null, charCodes.subarray(0, charOffset)));
      charOffset = 0;
    }
    for (let index = 0; index < bytes.length; index += 3) {
      const first = Number(bytes[index]) & 0xff;
      const hasSecond = index + 1 < bytes.length;
      const hasThird = index + 2 < bytes.length;
      const second = hasSecond ? Number(bytes[index + 1]) & 0xff : 0;
      const third = hasThird ? Number(bytes[index + 2]) & 0xff : 0;
      charCodes[charOffset++] = alphabet.charCodeAt(first >> 2);
      charCodes[charOffset++] = alphabet.charCodeAt(((first & 0x03) << 4) | (second >> 4));
      charCodes[charOffset++] = hasSecond
        ? alphabet.charCodeAt(((second & 0x0f) << 2) | (third >> 6))
        : 61;
      charCodes[charOffset++] = hasThird ? alphabet.charCodeAt(third & 0x3f) : 61;
      if (charOffset === charCodes.length)
        flush();
    }
    if (charOffset > 0)
      flush();
    return chunks.join('');
  }

  function inferredContentType(body) {
    if (typeof body === 'string')
      return 'text/plain;charset=UTF-8';
    if (URLSearchParamsCtor && body instanceof URLSearchParamsCtor)
      return 'application/x-www-form-urlencoded;charset=UTF-8';
    return null;
  }

  function normalizedBody(body) {
    const encoded = binary ? binary.encodeBody(body) : null;
    if (encoded != null) {
      const value = encoded.bytes;
      let bytes;
      if (value instanceof Uint8Array) {
        // encodeBody returns a fresh snapshot so the request can own it.
        bytes = value;
      } else if (Array.isArray(value)) {
        bytes = Uint8Array.from(value, item => Number(item) & 0xff);
      } else if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      } else if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
        bytes = new Uint8Array(value.slice(0));
      } else {
        throw new TypeError('The binary body encoder returned invalid bytes.');
      }
      return { bytes, contentType: encoded.contentType || null };
    }
    return { bytes: normalizeBytes(body), contentType: inferredContentType(body) };
  }

  function normalizeBytes(value) {
    if (value == null)
      return null;
    if (typeof value === 'string')
      return utf8Encode(value);
    if (URLSearchParamsCtor && value instanceof URLSearchParamsCtor)
      return utf8Encode(String(value));

    const tag = Object.prototype.toString.call(value);
    if (tag === '[object ArrayBuffer]') {
      if (value.byteLength > MAX_FETCH_BODY_BYTES)
        throw new TypeError('Fetch request bodies cannot exceed 2 MiB.');
      return new Uint8Array(value.slice(0));
    }
    if (ArrayBuffer.isView(value)) {
      const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (view.byteLength > MAX_FETCH_BODY_BYTES)
        throw new TypeError('Fetch request bodies cannot exceed 2 MiB.');
      return view.slice();
    }

    const typeName = value && value.constructor && value.constructor.name;
    if (tag === '[object Blob]' || tag === '[object FormData]' ||
        tag === '[object ReadableStream]' || typeName === 'Blob' ||
        typeName === 'FormData' || typeName === 'ReadableStream') {
      throw new TypeError(
        'Blob, FormData, and streaming request bodies are not supported by this runtime.'
      );
    }
    throw new TypeError(
      'Request bodies must be strings, URLSearchParams, Uint8Array, or ArrayBuffer values.'
    );
  }

  function normalizeCompletionBytes(completion) {
    if (completion && own(completion, 'bodyBytes')) {
      const provided = completion.bodyBytes;
      if (provided == null)
        return null;
      if (Array.isArray(provided)) {
        if (provided.length > MAX_FETCH_BODY_BYTES)
          throw new TypeError('The native fetch response body cannot exceed 2 MiB.');
        return Uint8Array.from(provided, value => Number(value) & 0xff);
      }
      if (ArrayBuffer.isView(provided)) {
        if (provided.byteLength > MAX_FETCH_BODY_BYTES)
          throw new TypeError('The native fetch response body cannot exceed 2 MiB.');
        return new Uint8Array(provided.buffer, provided.byteOffset, provided.byteLength).slice();
      }
      if (Object.prototype.toString.call(provided) === '[object ArrayBuffer]') {
        if (provided.byteLength > MAX_FETCH_BODY_BYTES)
          throw new TypeError('The native fetch response body cannot exceed 2 MiB.');
        return new Uint8Array(provided.slice(0));
      }
      throw new TypeError('The native fetch transport returned an invalid byte array.');
    }
    if (completion && own(completion, 'bodyBase64')) {
      if (completion.bodyBase64 == null)
        return null;
      return bytesFromBase64(completion.bodyBase64);
    }
    return null;
  }

  function normalizedHeaderName(name) {
    const result = String(name).toLowerCase();
    if (!result || !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(result))
      throw new TypeError('Invalid HTTP header name.');
    return result;
  }

  function normalizedHeaderValue(value) {
    const result = String(value);
    if (/[\0\r\n]/.test(result))
      throw new TypeError('Invalid HTTP header value.');
    return result.replace(/^[\t ]+|[\t ]+$/g, '');
  }

  const forbiddenRequestHeaders = new Set([
    'accept-charset', 'accept-encoding', 'access-control-request-headers',
    'access-control-request-method', 'connection', 'content-length', 'cookie',
    'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin',
    'permissions-policy', 'referer', 'te', 'trailer', 'transfer-encoding',
    'upgrade', 'via'
  ]);
  const forbiddenResponseHeaders = new Set(['set-cookie', 'set-cookie2']);

  function headerBlocked(guard, name) {
    if (guard === 'request') {
      return forbiddenRequestHeaders.has(name) || name.indexOf('proxy-') === 0 ||
        name.indexOf('sec-') === 0;
    }
    return (guard === 'response' || guard === 'immutable') &&
      forbiddenResponseHeaders.has(name);
  }

  function assertHeadersMutable(headers) {
    if (headerGuards.get(headers) === 'immutable')
      throw new TypeError('Headers are immutable.');
  }

  function guardHeaders(headers, guard) {
    headerGuards.set(headers, guard);
    const map = headerStates.get(headers);
    for (const name of Array.from(map.keys())) {
      if (headerBlocked(guard, name))
        map.delete(name);
    }
  }

  function appendHeader(map, name, value) {
    const key = normalizedHeaderName(name);
    const item = normalizedHeaderValue(value);
    map.set(key, map.has(key) ? map.get(key) + ', ' + item : item);
  }

  function setHeader(map, name, value) {
    map.set(normalizedHeaderName(name), normalizedHeaderValue(value));
  }

  function createHeaderMap(init) {
    const map = new Map();
    if (init == null)
      return map;
    if (headerStates.has(init)) {
      const source = headerStates.get(init);
      for (const [name, value] of source)
        map.set(name, value);
      return map;
    }
    if (typeof init === 'string')
      throw new TypeError('Headers must be initialized from pairs or an object.');

    const iterator = init && typeof init[Symbol.iterator] === 'function'
      ? init[Symbol.iterator]()
      : null;
    if (iterator) {
      for (let item = iterator.next(); !item.done; item = iterator.next()) {
        const pair = item.value;
        if (pair == null || typeof pair.length !== 'number' || pair.length !== 2)
          throw new TypeError('Each header pair must contain exactly two values.');
        appendHeader(map, pair[0], pair[1]);
      }
      return map;
    }
    if (typeof init !== 'object')
      throw new TypeError('Headers must be initialized from pairs or an object.');
    for (const name of Object.keys(init))
      appendHeader(map, name, init[name]);
    return map;
  }

  function sortedHeaderEntries(map) {
    return Array.from(map.entries()).sort((left, right) =>
      left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
    );
  }

  class Headers {
    constructor(init) {
      headerStates.set(this, createHeaderMap(init));
      headerGuards.set(this, null);
    }

    append(name, value) {
      assertHeadersMutable(this);
      const key = normalizedHeaderName(name);
      const valueText = normalizedHeaderValue(value);
      if (headerBlocked(headerGuards.get(this), key))
        return;
      appendHeader(headerStates.get(this), key, valueText);
    }

    delete(name) {
      assertHeadersMutable(this);
      const key = normalizedHeaderName(name);
      if (headerBlocked(headerGuards.get(this), key))
        return;
      headerStates.get(this).delete(key);
    }

    get(name) {
      const map = headerStates.get(this);
      const key = normalizedHeaderName(name);
      return map.has(key) ? map.get(key) : null;
    }

    has(name) {
      return headerStates.get(this).has(normalizedHeaderName(name));
    }

    set(name, value) {
      assertHeadersMutable(this);
      const key = normalizedHeaderName(name);
      const valueText = normalizedHeaderValue(value);
      if (headerBlocked(headerGuards.get(this), key))
        return;
      setHeader(headerStates.get(this), key, valueText);
    }

    forEach(callback, thisArg) {
      if (typeof callback !== 'function')
        throw new TypeError('Headers.forEach requires a callback.');
      for (const [name, value] of sortedHeaderEntries(headerStates.get(this)))
        callback.call(thisArg, value, name, this);
    }

    entries() {
      return sortedHeaderEntries(headerStates.get(this))[Symbol.iterator]();
    }

    keys() {
      return sortedHeaderEntries(headerStates.get(this)).map(entry => entry[0])[Symbol.iterator]();
    }

    values() {
      return sortedHeaderEntries(headerStates.get(this)).map(entry => entry[1])[Symbol.iterator]();
    }

    [Symbol.iterator]() {
      return this.entries();
    }

    get [Symbol.toStringTag]() {
      return 'Headers';
    }
  }

  function headerPairs(headers) {
    return sortedHeaderEntries(headerStates.get(headers)).map(entry => [entry[0], entry[1]]);
  }

  function abortError() {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
  }

  function isSignal(value) {
    return value != null && typeof value.aborted === 'boolean' &&
      typeof value.addEventListener === 'function';
  }

  function getSignalReason(signal) {
    try {
      return signal.reason === undefined ? abortError() : signal.reason;
    } catch (error) {
      return abortError();
    }
  }

  function dispatchAbort(signal, state) {
    if (state.aborted)
      return;
    state.aborted = true;
    state.reason = state.pendingReason;
    const event = {
      type: 'abort',
      target: signal,
      currentTarget: signal,
      defaultPrevented: false,
      preventDefault: function() {}
    };
    const listeners = Array.from(state.listeners);
    state.listeners.clear();
    for (const item of listeners) {
      try {
        if (item.once)
          state.listeners.delete(item);
        if (typeof item.callback === 'function')
          item.callback.call(signal, event);
        else if (item.callback && typeof item.callback.handleEvent === 'function')
          item.callback.handleEvent.call(item.callback, event);
      } catch (error) {
        Promise.resolve().then(() => { throw error; });
      }
    }
    if (typeof signal.onabort === 'function') {
      try {
        signal.onabort.call(signal, event);
      } catch (error) {
        Promise.resolve().then(() => { throw error; });
      }
    }
  }

  class AbortSignal {
    constructor(token) {
      if (token !== abortSignalToken)
        throw new TypeError('Illegal constructor. Use AbortController to create an AbortSignal.');
      const state = { aborted: false, reason: undefined, pendingReason: undefined, listeners: new Set() };
      Object.defineProperty(this, 'onabort', {
        configurable: true,
        enumerable: true,
        get: function() { return state.onabort || null; },
        set: function(value) { state.onabort = typeof value === 'function' ? value : null; }
      });
      state.onabort = null;
      Object.defineProperties(this, {
        aborted: { enumerable: true, get: () => state.aborted },
        reason: { enumerable: true, get: () => state.reason }
      });
      abortSignalStates.set(this, state);
    }

    addEventListener(type, callback, options) {
      if (String(type) !== 'abort' || callback == null)
        return;
      const state = abortSignalStates.get(this);
      const once = Boolean(options && typeof options === 'object' && options.once);
      for (const item of state.listeners) {
        if (item.callback === callback)
          return;
      }
      if (!state.aborted)
        state.listeners.add({ callback, once });
    }

    removeEventListener(type, callback) {
      if (String(type) !== 'abort')
        return;
      const state = abortSignalStates.get(this);
      for (const item of Array.from(state.listeners)) {
        if (item.callback === callback)
          state.listeners.delete(item);
      }
    }

    throwIfAborted() {
      if (this.aborted)
        throw this.reason;
    }

    static abort(reason) {
      const controller = new AbortController();
      controller.abort(reason);
      return controller.signal;
    }

    get [Symbol.toStringTag]() {
      return 'AbortSignal';
    }
  }

  class AbortController {
    constructor() {
      this.signal = new AbortSignal(abortSignalToken);
    }

    abort(reason) {
      const state = abortSignalStates.get(this.signal);
      if (state.aborted)
        return;
      state.pendingReason = reason === undefined ? abortError() : reason;
      dispatchAbort(this.signal, state);
    }

    get [Symbol.toStringTag]() {
      return 'AbortController';
    }
  }

  function validateChoice(value, allowed, label) {
    const result = String(value);
    if (!allowed.includes(result))
      throw new TypeError('Invalid ' + label + ' value.');
    return result;
  }

  function requestUrl(input) {
    let raw;
    if (input != null && typeof input.href === 'string')
      raw = input.href;
    else
      raw = String(input);
    let parsed;
    try {
      parsed = new URLCtor(raw, getBaseUrl());
    } catch (error) {
      throw new TypeError('Invalid fetch URL.');
    }
    const protocol = String(parsed.protocol || '').toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:' &&
        !(protocol === 'blob:' && typeof deps.resolveObjectURL === 'function'))
      throw new TypeError('Fetch supports only HTTP and HTTPS URLs.');
    if (parsed.username || parsed.password)
      throw new TypeError('Fetch URLs cannot contain username or password credentials.');
    parsed.hash = '';
    return String(parsed.href);
  }

  class Request {
    constructor(input, init, internalToken) {
      const options = init == null ? {} : Object(init);
      const source = requestStates.get(input);
      const bodyOverridden = own(options, 'body') && options.body != null;
      if (input == null)
        throw new TypeError('Request input is required.');
      if (source && source.bodyUsed && !bodyOverridden)
        throw new TypeError('Cannot construct a Request from a used request body.');

      const url = source ? source.url : requestUrl(input);
      const methodValue = own(options, 'method') ? options.method : source ? source.method : 'GET';
      const method = String(methodValue).toUpperCase();
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Z]+$/.test(method) ||
          ['CONNECT', 'TRACE', 'TRACK'].includes(method)) {
        throw new TypeError('Invalid HTTP method.');
      }
      const headers = own(options, 'headers')
        ? new Headers(options.headers)
        : new Headers(source ? source.headers : undefined);
      guardHeaders(headers, 'request');
      let bodyBytes = source && source.bodyBytes != null ? source.bodyBytes.slice() : null;
      if (bodyOverridden) {
        const normalized = normalizedBody(options.body);
        bodyBytes = normalized.bytes;
        const contentType = normalized.contentType;
        if (bodyBytes != null && contentType && !headers.has('content-type'))
          headers.set('content-type', contentType);
      }
      if ((method === 'GET' || method === 'HEAD') && bodyBytes != null)
        throw new TypeError('Request with GET or HEAD method cannot have a body.');

      let signal = own(options, 'signal') ? options.signal : source ? source.signal : null;
      if (signal == null)
        signal = new AbortController().signal;
      if (!isSignal(signal))
        throw new TypeError('Request signal must be an AbortSignal.');

      const state = {
        url,
        method,
        headers,
        bodyBytes,
        bodyUsed: false,
        signal,
        mode: validateChoice(
          own(options, 'mode') ? options.mode : source ? source.mode : 'cors',
          ['cors', 'no-cors', 'same-origin'],
          'mode'
        ),
        credentials: validateChoice(
          own(options, 'credentials') ? options.credentials : source ? source.credentials : 'same-origin',
          ['omit', 'same-origin', 'include'],
          'credentials'
        ),
        redirect: validateChoice(
          own(options, 'redirect') ? options.redirect : source ? source.redirect : 'follow',
          ['follow', 'error', 'manual'],
          'redirect'
        ),
        referrerPolicy: validateChoice(
          own(options, 'referrerPolicy') ? options.referrerPolicy : source ? source.referrerPolicy : '',
          ['', 'no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin',
            'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url'],
          'referrer policy'
        )
      };
      requestStates.set(this, state);
      Object.defineProperties(this, {
        url: { enumerable: true, get: () => state.url },
        method: { enumerable: true, get: () => state.method },
        headers: { enumerable: true, get: () => state.headers },
        signal: { enumerable: true, get: () => state.signal },
        mode: { enumerable: true, get: () => state.mode },
        credentials: { enumerable: true, get: () => state.credentials },
        redirect: { enumerable: true, get: () => state.redirect },
        referrerPolicy: { enumerable: true, get: () => state.referrerPolicy },
        bodyUsed: { enumerable: true, get: () => state.bodyUsed },
        body: {
          enumerable: true,
          get: () => state.bodyBytes == null
            ? null
            : unsupportedStreamAccess('Request')
        }
      });
      if (source && source.bodyBytes != null && !bodyOverridden &&
          internalToken !== requestCloneToken) {
        source.bodyUsed = true;
      }
    }

    arrayBuffer() {
      return consumeRequest(this, bytes => new Uint8Array(bytes).buffer);
    }

    blob() {
      const state = requestStates.get(this);
      if (!state)
        return Promise.reject(new TypeError('Illegal invocation.'));
      return consumeRequest(this, bytes => bodyBlob(bytes, state.headers));
    }

    formData() {
      const state = requestStates.get(this);
      if (!state)
        return Promise.reject(new TypeError('Illegal invocation.'));
      return consumeRequest(this, bytes => bodyFormData(bytes, state.headers));
    }

    text() {
      return consumeRequest(this, bytes => utf8Decode(bytes));
    }

    json() {
      return this.text().then(value => JSON.parse(value));
    }

    clone() {
      const state = requestStates.get(this);
      if (!state)
        throw new TypeError('Illegal invocation.');
      if (state.bodyUsed)
        throw new TypeError('Cannot clone a used Request body.');
      return new Request(this, undefined, requestCloneToken);
    }

    get [Symbol.toStringTag]() {
      return 'Request';
    }
  }

  function unsupportedStreamAccess(name) {
    throw new TypeError(name + '.body streaming is not supported by this runtime.');
  }

  function createResponseState(instance, bodyBytes, init, metadata) {
    const options = init == null ? {} : Object(init);
    const status = metadata && own(metadata, 'status')
      ? Number(metadata.status)
      : own(options, 'status') ? Number(options.status) : 200;
    const headers = new Headers(metadata && metadata.headers != null
      ? metadata.headers
      : options.headers);
    const immutable = Boolean(metadata && metadata.immutable);
    guardHeaders(headers, immutable ? 'immutable' : 'response');
    const type = metadata && metadata.type != null ? String(metadata.type) : 'default';
    const allowsZeroStatus = metadata != null && status === 0 &&
      (type === 'opaque' || type === 'opaqueredirect');
    if (!Number.isInteger(status) || (status < 200 && !allowsZeroStatus) || status > 599)
      throw new RangeError('Response status must be between 200 and 599.');
    const state = {
      bodyBytes: bodyBytes == null ? null : bodyBytes.slice(),
      bodyUsed: false,
      status,
      statusText: String(metadata && metadata.statusText != null
        ? metadata.statusText
        : options.statusText == null ? '' : options.statusText),
      headers,
      url: metadata && metadata.url != null ? String(metadata.url) : '',
      type,
      redirected: Boolean(metadata && metadata.redirected),
      immutable
    };
    responseStates.set(instance, state);
    Object.defineProperties(instance, {
      bodyUsed: { enumerable: true, get: () => state.bodyUsed },
      status: { enumerable: true, get: () => state.status },
      statusText: { enumerable: true, get: () => state.statusText },
      headers: { enumerable: true, get: () => state.headers },
      url: { enumerable: true, get: () => state.url },
      type: { enumerable: true, get: () => state.type },
      redirected: { enumerable: true, get: () => state.redirected },
      ok: { enumerable: true, get: () => state.status >= 200 && state.status < 300 },
      body: {
        enumerable: true,
        get: () => state.bodyBytes == null
          ? null
          : unsupportedStreamAccess('Response')
      }
    });
  }

  function consumeRequest(request, converter) {
    const state = requestStates.get(request);
    if (!state)
      return Promise.reject(new TypeError('Illegal invocation.'));
    if (state.bodyUsed)
      return Promise.reject(new TypeError('Request body is already used.'));
    const bytes = state.bodyBytes == null ? [] : state.bodyBytes.slice();
    if (state.bodyBytes != null)
      state.bodyUsed = true;
    try {
      return Promise.resolve(converter(bytes));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function consumeResponse(response, converter) {
    const state = responseStates.get(response);
    if (!state)
      return Promise.reject(new TypeError('Illegal invocation.'));
    if (state.bodyUsed)
      return Promise.reject(new TypeError('Response body is already used.'));
    const bytes = state.bodyBytes == null ? [] : state.bodyBytes.slice();
    if (state.bodyBytes != null)
      state.bodyUsed = true;
    try {
      return Promise.resolve(converter(bytes));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function bodyBlob(bytes, headers) {
    if (!binary || typeof binary.Blob !== 'function')
      throw new TypeError('Blob bodies are not supported by this runtime.');
    return new binary.Blob([bytes], { type: headers.get('content-type') || '' });
  }

  function bodyFormData(bytes, headers) {
    if (!binary || typeof binary.parseFormData !== 'function')
      throw new TypeError('FormData bodies are not supported by this runtime.');
    return binary.parseFormData(bytes, headers.get('content-type'));
  }

  class Response {
    constructor(body, init) {
      const options = init == null ? {} : Object(init);
      const normalized = normalizedBody(body);
      const bytes = normalized.bytes;
      const status = options.status == null ? 200 : Number(options.status);
      if (body != null && [204, 205, 304].includes(status))
        throw new TypeError('Response with status ' + status + ' cannot have a body.');
      const headers = new Headers(options.headers);
      const contentType = normalized.contentType;
      if (body != null && contentType && !headers.has('content-type'))
        headers.set('content-type', contentType);
      const normalizedOptions = Object.assign({}, options, { headers });
      createResponseState(this, bytes, normalizedOptions, null);
    }

    arrayBuffer() {
      return consumeResponse(this, bytes => new Uint8Array(bytes).buffer);
    }

    blob() {
      const state = responseStates.get(this);
      if (!state)
        return Promise.reject(new TypeError('Illegal invocation.'));
      return consumeResponse(this, bytes => bodyBlob(bytes, state.headers));
    }

    formData() {
      const state = responseStates.get(this);
      if (!state)
        return Promise.reject(new TypeError('Illegal invocation.'));
      return consumeResponse(this, bytes => bodyFormData(bytes, state.headers));
    }

    text() {
      return consumeResponse(this, bytes => utf8Decode(bytes));
    }

    json() {
      return this.text().then(value => JSON.parse(value));
    }

    clone() {
      const state = responseStates.get(this);
      if (!state)
        throw new TypeError('Illegal invocation.');
      if (state.bodyUsed)
        throw new TypeError('Cannot clone a used Response body.');
      const clone = Object.create(Response.prototype);
      createResponseState(clone, state.bodyBytes, null, {
        status: state.status,
        statusText: state.statusText,
        headers: state.headers,
        url: state.url,
        type: state.type,
        redirected: state.redirected,
        immutable: state.immutable
      });
      return clone;
    }

    get [Symbol.toStringTag]() {
      return 'Response';
    }
  }

  function makeResponse(completion, request) {
    const response = Object.create(Response.prototype);
    const type = completion.type == null ? 'default' : String(completion.type);
    const opaque = type === 'opaque' || type === 'opaqueredirect';
    const status = completion.status == null ? (opaque ? 0 : 200) : Number(completion.status);
    if (!Number.isInteger(status) || (status < 200 && !(status === 0 && opaque)) || status > 599)
      throw new TypeError('The native fetch transport returned an invalid response status.');
    let bytes = opaque ? null : normalizeCompletionBytes(completion);
    if ([204, 205, 304].includes(status)) {
      if (bytes != null)
        throw new TypeError('The native fetch transport returned a body for status ' + status + '.');
      bytes = null;
    }
    createResponseState(response, bytes, null, {
      status,
      statusText: opaque ? '' : completion.statusText,
      headers: opaque ? [] : completion.headers,
      url: opaque ? '' : completion.url == null ? request.url : completion.url,
      type,
      redirected: completion.redirected,
      immutable: true
    });
    return rememberCompletion(response, completion);
  }

  function completionError(completion) {
    const message = completion && completion.error != null
      ? String(completion.error)
      : 'Failed to fetch.';
    const error = new TypeError(message);
    return rememberCompletion(error, completion);
  }

  function fetch(input, init) {
    return performFetch(input, init, null);
  }

  // XHR upload listeners require preflight even for otherwise safelisted
  // requests. This private entry never changes the public fetch() interface.
  function fetchForXHR(input, init, options) {
    return performFetch(input, init, options);
  }

  function performFetch(input, init, options) {
    let request;
    try {
      request = new Request(input, init);
    } catch (error) {
      return Promise.reject(error);
    }
    const requestState = requestStates.get(request);
    if (requestState.bodyBytes != null && requestState.bodyBytes.length > MAX_FETCH_BODY_BYTES)
      return Promise.reject(new TypeError('Fetch request bodies cannot exceed 2 MiB.'));

    const signal = requestState.signal;
    if (signal.aborted)
      return Promise.reject(getSignalReason(signal));

    if (requestState.url.startsWith('blob:')) {
      // Capture bytes at invocation, before the caller can revoke the URL.
      let completion;
      try {
        completion = deps.resolveObjectURL(requestState.url, requestState.method,
          headerPairs(requestState.headers));
      } catch (error) { return Promise.reject(error); }
      return Promise.resolve().then(function() {
        if (signal.aborted) throw getSignalReason(signal);
        if (!completion || completion.ok === false) throw completionError(completion);
        return makeResponse(Object.assign({}, completion, {type: 'basic'}), request);
      });
    }

    const id = 'fetch-' + nextRequestId++;
    return new Promise((resolve, reject) => {
      let settled = false;
      let abortListener = null;
      const record = {
        resolve: value => finish(false, value),
        reject: error => finish(true, error),
        signal,
        request,
        message: null,
        enqueued: false
      };
      function removeAbortListener() {
        if (abortListener && typeof signal.removeEventListener === 'function') {
          try { signal.removeEventListener('abort', abortListener); } catch (error) {}
        }
        abortListener = null;
      }
      function finish(failed, value) {
        if (settled)
          return;
        settled = true;
        pending.delete(id);
        removeAbortListener();
        if (failed)
          reject(value);
        else
          resolve(value);
      }
      record.abort = () => {
        if (record.enqueued && record.message) {
          record.message.cancelled = true;
          if (typeof deps.cancel === 'function') {
            try { deps.cancel(id); } catch (error) {}
          }
        }
        finish(true, getSignalReason(signal));
      };
      pending.set(id, record);
      abortListener = record.abort;
      try {
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) {
          record.abort();
          return;
        }
      } catch (error) {
        finish(true, error);
        return;
      }

      const message = {
        id,
        cancelled: false,
        kind: 'fetch',
        url: requestState.url,
        method: requestState.method,
        headers: headerPairs(requestState.headers),
        bodyBase64: requestState.bodyBytes == null ? null : bytesToBase64(requestState.bodyBytes),
        mode: requestState.mode,
        credentials: requestState.credentials,
        redirect: requestState.redirect,
        referrerPolicy: requestState.referrerPolicy
      };
      if (options && options.forcePreflight === true)
        message.forcePreflight = true;
      record.message = message;
      try {
        enqueue(message);
        record.enqueued = true;
      } catch (error) {
        finish(true, error);
      }
    });
  }

  function complete(completion) {
    if (!completion || typeof completion.id !== 'string')
      return false;
    const record = pending.get(completion.id);
    if (!record)
      return false;
    if (completion.ok === false) {
      record.reject(completionError(completion));
      return true;
    }
    try {
      record.resolve(makeResponse(completion, record.request));
    } catch (error) {
      record.reject(rememberCompletion(error, completion));
    }
    return true;
  }

  return { fetch, fetchForXHR, completedAtForXHR: value => completionTimes.get(value), Headers, Request, Response, AbortController, AbortSignal, complete };
}
