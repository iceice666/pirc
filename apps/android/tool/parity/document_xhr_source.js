/*
 * XMLHttpRequest over the document's bounded fetch transport.
 *
 * The host fetch bridge returns complete, bounded response bodies. This helper
 * preserves the asynchronous XHR state and event model, while representing the
 * buffered body with a single final progress notification instead of pretending
 * that the transport streams chunks.
 */
function createDocumentXHR(dependencies) {
  const deps = dependencies || {};
  const fetch = typeof deps.fetch === 'function' ? deps.fetch : null;
  const HeadersCtor = typeof deps.Headers === 'function' ? deps.Headers : null;
  const AbortControllerCtor = typeof deps.AbortController === 'function'
    ? deps.AbortController
    : null;
  const EventCtor = typeof deps.Event === 'function' ? deps.Event : null;
  const ProgressEventCtor = typeof deps.ProgressEvent === 'function'
    ? deps.ProgressEvent
    : null;
  const DOMExceptionCtor = typeof deps.DOMException === 'function'
    ? deps.DOMException
    : null;
  const EventTargetCtor = typeof deps.EventTarget === 'function'
    ? deps.EventTarget
    : null;
  const URLCtor = typeof deps.URL === 'function'
    ? deps.URL
    : (typeof URL === 'function' ? URL : null);
  const binary = deps.binary || null;
  const DOMParserCtor = typeof deps.DOMParser === 'function' ? deps.DOMParser : null;
  const decodeText = typeof deps.decodeText === 'function' ? deps.decodeText : null;
  const schedule = typeof deps.schedule === 'function'
    ? deps.schedule
    : function(callback, delay) { return setTimeout(callback, delay || 0); };
  const cancel = typeof deps.cancel === 'function'
    ? deps.cancel
    : function(id) { clearTimeout(id); };
  const now = typeof deps.now === 'function' ? deps.now : function() { return Date.now(); };
  const responseStates = new WeakMap();
  const eventTargetStates = new WeakMap();
  const EVENT_TARGET_EVENTS = [
    'loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend'
  ];
  const RESPONSE_TYPES = new Set(['', 'text', 'json', 'arraybuffer', 'blob', 'document']);
  const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);
  const METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const UNSET = {};
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  let nextGeneration = 1;

  function reportError(error) {
    try {
      if (typeof deps.reportError === 'function') {
        deps.reportError(error);
      } else if (typeof deps.diagnostic === 'function') {
        deps.diagnostic('xhr.listener_error', 'error',
          String(error && error.message || error).slice(0, 240));
      }
    } catch (ignored) {}
  }

  function makeDOMException(name, message) {
    try {
      if (DOMExceptionCtor)
        return new DOMExceptionCtor(message || '', name);
    } catch (ignored) {}
    const error = new Error(message || '');
    error.name = name;
    return error;
  }

  function eventTargetState(target) {
    const value = eventTargetStates.get(target);
    if (!value)
      throw new TypeError('Illegal invocation.');
    return value;
  }

  function optionsFor(options) {
    if (typeof options === 'boolean')
      return { capture: options, once: false, signal: null };
    const value = options != null && typeof options === 'object' ? options : {};
    return {
      capture: Boolean(value.capture),
      once: Boolean(value.once),
      signal: value.signal || null
    };
  }

  const FallbackEventTarget = class {
    addEventListener(type, listener) {
      const state = eventTargetState(this);
      const name = String(type);
      if (!state.fallbackListeners.has(name))
        state.fallbackListeners.set(name, new Set());
      state.fallbackListeners.get(name).add(listener);
    }
    removeEventListener(type, listener) {
      const state = eventTargetState(this);
      const list = state.fallbackListeners.get(String(type));
      if (list)
        list.delete(listener);
    }
    dispatchEvent(event) {
      const state = eventTargetState(this);
      const name = String(event.type);
      try { event.target = this; event.currentTarget = this; } catch (ignored) {}
      const listeners = Array.from(state.fallbackListeners.get(name) || []);
      for (const listener of listeners) {
        try {
          if (typeof listener === 'function')
            listener.call(this, event);
          else if (listener && typeof listener.handleEvent === 'function')
            listener.handleEvent(event);
        } catch (error) { reportError(error); }
      }
      return !event.defaultPrevented;
    }
  };
  const EventTargetBase = EventTargetCtor || FallbackEventTarget;

  function notifyListenerCount(target, state) {
    if (typeof state.onListenerChange !== 'function')
      return;
    try {
      state.onListenerChange(state.listeners.filter(item => item.active).length);
    } catch (error) { reportError(error); }
  }

  class XMLHttpRequestEventTarget extends EventTargetBase {
    constructor(onListenerChange) {
      super();
      eventTargetStates.set(this, {
        listeners: [],
        handlers: new Map(),
        dispatchStack: [],
        fallbackListeners: new Map(),
        onListenerChange: typeof onListenerChange === 'function' ? onListenerChange : null
      });
    }

    addEventListener(type, callback, options) {
      const state = eventTargetState(this);
      const name = String(type);
      if (callback == null)
        return;
      if (typeof callback !== 'function' && typeof callback !== 'object')
        throw new TypeError('The event listener must be a function or an object.');
      const opts = optionsFor(options);
      if (state.listeners.some(item => item.active && item.type === name &&
          item.callback === callback && item.capture === opts.capture))
        return;
      if (opts.signal && opts.signal.aborted)
        return;

      const record = {
        type: name,
        callback,
        capture: opts.capture,
        once: opts.once,
        signal: opts.signal,
        abortHandler: null,
        active: true,
        wrapper: null
      };
      record.wrapper = event => {
        const activeSnapshot = state.dispatchStack[state.dispatchStack.length - 1];
        if (!record.active || !activeSnapshot || !activeSnapshot.has(record))
          return;
        if (record.once)
          this.removeEventListener(name, record.callback, { capture: opts.capture });
        try {
          if (typeof record.callback === 'function')
            record.callback.call(this, event);
          else if (record.callback && typeof record.callback.handleEvent === 'function')
            record.callback.handleEvent.call(record.callback, event);
        } catch (error) { reportError(error); }
      };
      state.listeners.push(record);
      if (EventTargetCtor)
        EventTargetCtor.prototype.addEventListener.call(this, name, record.wrapper, false);
      else
        FallbackEventTarget.prototype.addEventListener.call(this, name, record.wrapper, false);
      if (opts.signal && typeof opts.signal.addEventListener === 'function') {
        record.abortHandler = () => this.removeEventListener(name, callback, { capture: opts.capture });
        try { opts.signal.addEventListener('abort', record.abortHandler, { once: true }); }
        catch (error) { this.removeEventListener(name, callback, { capture: opts.capture }); throw error; }
      }
      notifyListenerCount(this, state);
    }

    removeEventListener(type, callback, options) {
      const state = eventTargetState(this);
      const name = String(type);
      const capture = optionsFor(options).capture;
      const record = state.listeners.find(item => item.active && item.type === name &&
        item.callback === callback && item.capture === capture);
      if (!record)
        return;
      record.active = false;
      if (EventTargetCtor)
        EventTargetCtor.prototype.removeEventListener.call(this, name, record.wrapper, false);
      else
        FallbackEventTarget.prototype.removeEventListener.call(this, name, record.wrapper, false);
      if (record.signal && record.abortHandler &&
          typeof record.signal.removeEventListener === 'function') {
        try { record.signal.removeEventListener('abort', record.abortHandler); } catch (ignored) {}
      }
      for (const [handlerType, handlerRecord] of state.handlers) {
        if (handlerRecord === record)
          state.handlers.delete(handlerType);
      }
      notifyListenerCount(this, state);
    }

    dispatchEvent(event) {
      const state = eventTargetState(this);
      const snapshot = new Set(state.listeners.filter(item => item.active && item.type === String(event.type)));
      state.dispatchStack.push(snapshot);
      try {
        if (EventTargetCtor)
          return EventTargetCtor.prototype.dispatchEvent.call(this, event);
        return FallbackEventTarget.prototype.dispatchEvent.call(this, event);
      } finally {
        state.dispatchStack.pop();
      }
    }

    _setEventHandler(type, value) {
      const state = eventTargetState(this);
      const handler = typeof value === 'function' ? value : null;
      const previous = state.handlers.get(type);
      if (previous) {
        if (!handler) {
          this.removeEventListener(type, previous.callback);
          state.handlers.delete(type);
        } else if (previous.callback !== handler) {
          // Event handler IDL attributes occupy one listener slot. Updating the
          // callback in place preserves its registration order relative to
          // addEventListener listeners.
          previous.callback = handler;
        }
        return;
      }
      if (handler) {
        this.addEventListener(type, handler);
        const record = state.listeners.find(item => item.active && item.type === type &&
          item.callback === handler && !item.capture);
        if (record)
          state.handlers.set(type, record);
      }
    }

    _getEventHandler(type) {
      const record = eventTargetState(this).handlers.get(type);
      return record ? record.callback : null;
    }

    _hasEventListeners() {
      return eventTargetState(this).listeners.some(item => item.active);
    }
  }

  class XMLHttpRequestUpload extends XMLHttpRequestEventTarget {
    constructor(onListenerChange) {
      super(onListenerChange);
    }
    get [Symbol.toStringTag]() { return 'XMLHttpRequestUpload'; }
  }

  const states = new WeakMap();

  function xhrState(xhr) {
    const value = states.get(xhr);
    if (!value)
      throw new TypeError('Illegal invocation.');
    return value;
  }

  function isCurrent(state, generation) {
    return state.generation === generation && state.sendFlag;
  }

  function currentUrl() {
    const value = typeof deps.baseUrl === 'function' ? deps.baseUrl() : deps.baseUrl;
    return String(value == null ? 'about:blank' : value);
  }

  function urlWithoutFragment(url) {
    try {
      const parsed = new URLCtor(String(url));
      parsed.hash = '';
      return parsed.href;
    } catch (ignored) {
      return String(url || '');
    }
  }

  function clearResponse(state) {
    state.responseStatus = 0;
    state.responseStatusText = '';
    state.responseUrl = '';
    state.responseHeaders = null;
    state.responseBytes = new Uint8Array(0);
    state.responseText = '';
    state.responseTextReady = false;
    state.responseContentType = '';
    state.responseObject = UNSET;
    state.responseDocument = UNSET;
    state.responseFailed = false;
  }

  function cancelTask(state, id) {
    if (id === null || id === undefined)
      return;
    state.scheduled.delete(id);
    try { cancel(id); } catch (error) { reportError(error); }
  }

  function cancelAllTasks(state) {
    for (const id of Array.from(state.scheduled)) {
      try { cancel(id); } catch (error) { reportError(error); }
    }
    state.scheduled.clear();
    state.timeoutTask = null;
  }

  function queueTask(xhr, generation, callback, delay) {
    const state = xhrState(xhr);
    let id = null;
    try {
      id = schedule(function() {
        if (id !== null && id !== undefined)
          state.scheduled.delete(id);
        if (state.generation !== generation)
          return;
        callback();
      }, Math.max(0, Number(delay) || 0));
    } catch (error) {
      throw makeDOMException('QuotaExceededError', 'The XHR task could not be scheduled.');
    }
    if (id === null || id === undefined || id === false || id === 0)
      throw makeDOMException('QuotaExceededError', 'The XHR task limit has been reached.');
    state.scheduled.add(id);
    return id;
  }

  function makeEvent(type, init, progress) {
    const eventInit = init || { bubbles: false, cancelable: false };
    try {
      if (progress && typeof deps.createProgressEvent === 'function')
        return deps.createProgressEvent(type, eventInit);
      if (!progress && typeof deps.createEvent === 'function')
        return deps.createEvent(type);
      if (progress && ProgressEventCtor)
        return new ProgressEventCtor(type, eventInit);
      if (EventCtor)
        return new EventCtor(type, init);
    } catch (error) { reportError(error); }
    return {
      type: String(type),
      bubbles: false,
      cancelable: false,
      defaultPrevented: false,
      preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    };
  }

  function fire(target, type, loaded, total, hasProgress) {
    const event = hasProgress
      ? makeEvent(type, {
        bubbles: false,
        cancelable: false,
        lengthComputable: Number(total) > 0,
        loaded: Math.max(0, Math.trunc(Number(loaded) || 0)),
        total: Math.max(0, Math.trunc(Number(total) || 0))
      }, true)
      : makeEvent(type, { bubbles: false, cancelable: false }, false);
    try { target.dispatchEvent(event); }
    catch (error) { reportError(error); }
  }

  function toByteString(value, label) {
    if (typeof value === 'symbol')
      throw new TypeError('Cannot convert a Symbol value to a string.');
    const text = String(value);
    for (let index = 0; index < text.length; index++) {
      if (text.charCodeAt(index) > 0xff)
        throw new TypeError(label + ' must contain only byte values.');
    }
    return text;
  }

  function toDOMString(value, label) {
    if (typeof value === 'symbol')
      throw new TypeError('Cannot convert a Symbol value to a string.');
    return String(value);
  }

  function normalizeMethod(value) {
    const method = toByteString(value, 'HTTP method').toUpperCase();
    if (!METHOD_TOKEN.test(method))
      throw makeDOMException('SyntaxError', 'The HTTP method is invalid.');
    if (FORBIDDEN_METHODS.has(method))
      throw makeDOMException('SecurityError', 'The HTTP method is forbidden.');
    return method;
  }

  function bodyLength(body) {
    if (body == null)
      return 0;
    if (typeof body === 'string')
      return utf8Length(body);
    if (typeof URLSearchParams === 'function' && body instanceof URLSearchParams)
      return utf8Length(String(body));
    if (Object.prototype.toString.call(body) === '[object ArrayBuffer]')
      return body.byteLength;
    if (ArrayBuffer.isView(body))
      return body.byteLength;
    if (binary && typeof binary.encodeBody === 'function') {
      try {
        const encoded = binary.encodeBody(body);
        if (encoded && encoded.bytes && Number.isFinite(encoded.bytes.length))
          return encoded.bytes.length;
      } catch (ignored) {}
    }
    return 0;
  }

  function snapshotBody(body) {
    if (body == null) return {body:null, length:0, contentType:null};
    if (body && body.nodeType === 9)
      throw makeDOMException('NotSupportedError', 'Document request bodies require browser XML serialization.');
    const encoded = binary && typeof binary.encodeBody === 'function' ? binary.encodeBody(body) : null;
    if (encoded) return {body:encoded.bytes, length:encoded.bytes.length, contentType:encoded.contentType};
    if (Object.prototype.toString.call(body) === '[object ArrayBuffer]') {
      const bytes = new Uint8Array(body.slice(0));
      return {body:bytes, length:bytes.length, contentType:null};
    }
    if (ArrayBuffer.isView(body)) {
      const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
      return {body:bytes, length:bytes.length, contentType:null};
    }
    const params = typeof URLSearchParams === 'function' && body instanceof URLSearchParams;
    const text = toDOMString(body, 'Request body');
    return {body:text, length:utf8Length(text), contentType:params
      ? 'application/x-www-form-urlencoded;charset=UTF-8' : 'text/plain;charset=UTF-8'};
  }

  function utf8Length(value) {
    let length = 0;
    const text = String(value);
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
    }
    return length;
  }

  function uint32(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number === 0)
      return 0;
    const integer = Math.trunc(number);
    return ((integer % 0x100000000) + 0x100000000) % 0x100000000;
  }

  function responseHeaderList(headers) {
    const values = [];
    if (headers && typeof headers.forEach === 'function') {
      headers.forEach((value, name) => values.push([String(name).toLowerCase(), String(value)]));
    } else if (headers && typeof headers[Symbol.iterator] === 'function') {
      for (const pair of headers) {
        if (pair && pair.length >= 2)
          values.push([String(pair[0]).toLowerCase(), String(pair[1])]);
      }
    }
    values.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    return values;
  }

  function mimeParts(value) {
    const source = String(value || '');
    const pieces = source.split(';');
    const essence = String(pieces.shift() || '').trim().toLowerCase();
    let charset = '';
    for (const piece of pieces) {
      const match = /^\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i.exec(piece);
      if (match) {
        charset = String(match[1] || match[2] || match[3] || '').trim();
        break;
      }
    }
    return { essence, charset };
  }

  function makeBlob(bytes, type) {
    if (!binary || typeof binary.Blob !== 'function')
      throw new TypeError('Blob responses are not supported by this runtime.');
    return new binary.Blob([bytes], { type: type || '' });
  }

  function parseResponseDocument(text, mimeType, responseUrl) {
    if (!DOMParserCtor)
      return null;
    const essence = mimeParts(mimeType).essence;
    if (essence !== 'text/html') {
      // The bundled parser is a forgiving HTML parser. It does not report all
      // XML well-formedness errors, so do not expose its result as XML.
      return null;
    }
    let documentValue;
    try {
      documentValue = new DOMParserCtor().parseFromString(String(text), 'text/html');
    } catch (error) {
      reportError(error);
      return null;
    }
    if (!documentValue || typeof documentValue.createElement !== 'function')
      return null;

    // Collect nodes before touching head/body getters: those getters insert
    // nodes into the first element even when a fragment has no html root.
    try {
      const tag = node => String(node && (node.localName || node.tagName) || '').toLowerCase();
      let root = documentValue.documentElement;
      const rooted = tag(root) === 'html';
      const nodes = Array.from(rooted ? root.childNodes : documentValue.childNodes);
      if (!rooted) root = documentValue.createElement('html');
      let head = nodes.find(node => tag(node) === 'head');
      let body = nodes.find(node => tag(node) === 'body');
      if (!head) head = documentValue.createElement('head');
      if (!body) body = documentValue.createElement('body');
      const metadata = new Set(['base','basefont','bgsound','link','meta','title','noscript','noframes','style','script','template']);
      let inBody = false;
      for (const node of nodes) {
        if (node === head) continue;
        if (node === body) { inBody = true; continue; }
        if (node.nodeType === 10) continue;
        if (!rooted && node.nodeType === 8) continue;
        const destination = !inBody && (metadata.has(tag(node)) ||
          (node.nodeType === 3 && !String(node.textContent || '').trim())) ? head : body;
        if (destination === body) inBody = true;
        destination.appendChild(node);
      }
      root.insertBefore(head, root.firstChild);
      root.appendChild(body);
      if (!rooted) documentValue.appendChild(root);
      for (const key of ['URL', 'documentURI']) {
        Object.defineProperty(documentValue, key, {
          configurable: true, enumerable: true, get: () => String(responseUrl || '')
        });
      }
      Object.defineProperty(documentValue, 'baseURI', {
        configurable: true, enumerable: true, get: function() {
          const base = documentValue.querySelector('base[href]');
          if (base) {
            try { return new URLCtor(base.getAttribute('href'), responseUrl).href; } catch (ignored) {}
          }
          return String(responseUrl || '');
        }
      });
      Object.defineProperty(documentValue, 'defaultView', {value:null,configurable:true});
      Object.defineProperty(documentValue, 'contentType', {value:essence,configurable:true});
    } catch (error) {
      reportError(error);
      return null;
    }
    return documentValue;
  }

  function installEventHandlers(prototype, types) {
    for (const type of types) {
      Object.defineProperty(prototype, 'on' + type, {
        configurable: true,
        enumerable: true,
        get() { return this._getEventHandler(type); },
        set(value) { this._setEventHandler(type, value); }
      });
    }
  }

  function notifyStateChange(xhr, generation) {
    const state = xhrState(xhr);
    fire(xhr, 'readystatechange');
    return state.generation === generation;
  }

  function setReadyState(xhr, value, generation) {
    const state = xhrState(xhr);
    state.readyState = value;
    return notifyStateChange(xhr, generation);
  }

  function responseTextFor(state) {
    if (state.responseTextReady)
      return state.responseText;
    const bytes = state.responseBytes || new Uint8Array(0);
    const mimeType = state.overrideMimeType || state.responseContentType || '';
    const parts = mimeParts(mimeType);
    const charset = mimeParts(state.overrideMimeType).charset || mimeParts(state.responseContentType).charset;
    try {
      if (decodeText)
        state.responseText = String(decodeText(bytes, charset, parts.essence));
      else if (typeof TextDecoder === 'function')
        state.responseText = new TextDecoder(charset || 'utf-8').decode(bytes);
      else
        state.responseText = String.fromCharCode.apply(null, Array.from(bytes));
    } catch (error) {
      // Known unsupported legacy encodings remain an explicit difference.
      // Unknown labels use the decoder's normal UTF-8 fallback.
      if (typeof deps.diagnostic === 'function') {
        deps.diagnostic('xhr.unsupported_encoding', 'warning',
          'XHR charset is not supported; replacement UTF-8 text is shown.', {charset});
      }
      try {
        state.responseText = decodeText
          ? String(decodeText(bytes, 'utf-8', parts.essence))
          : new TextDecoder('utf-8').decode(bytes);
      } catch (fallbackError) {
        reportError(error);
        state.responseText = '';
      }
    }
    state.responseTextReady = true;
    return state.responseText;
  }

  function parsedResponseDocument(state) {
    if (state.responseDocument !== UNSET)
      return state.responseDocument;
    const mimeType = state.overrideMimeType || state.responseContentType || '';
    if (state.responseType === '' && mimeParts(mimeType).essence === 'text/html') return null;
    if (/(?:\/xml|\+xml)$/.test(mimeParts(mimeType).essence) && typeof deps.diagnostic === 'function')
      deps.diagnostic('xhr.xml_document_unsupported', 'warning', 'XML response documents require a validating XML parser.');
    state.responseDocument = parseResponseDocument(
      responseTextFor(state), mimeType, state.responseUrl
    );
    return state.responseDocument;
  }

  function progressTotal(state) {
    const value = state.responseHeaders && state.responseHeaders.get
      ? state.responseHeaders.get('content-length')
      : null;
    if (value != null && /^\s*\d+\s*$/.test(String(value))) {
      const total = Number(String(value).trim());
      if (Number.isSafeInteger(total) && total >= 0)
        return { value: total, computable: true };
    }
    return { value: 0, computable: false };
  }

  function fireProgress(target, type, loaded, total, lengthComputable) {
    const event = makeEvent(type, {
      bubbles: false,
      cancelable: false,
      lengthComputable: Boolean(lengthComputable),
      loaded: Math.max(0, Math.trunc(Number(loaded) || 0)),
      total: Math.max(0, Math.trunc(Number(total) || 0))
    }, true);
    try { target.dispatchEvent(event); }
    catch (error) { reportError(error); }
  }

  function fireUploadCompletion(xhr) {
    const state = xhrState(xhr);
    if (!state.uploadStarted)
      return;
    const upload = xhr.upload;
    const loaded = state.uploadLength;
    state.uploadStarted = false;
    fireProgress(upload, 'progress', loaded, loaded, true);
    fire(upload, 'load', loaded, loaded, true);
    fire(upload, 'loadend', loaded, loaded, true);
  }

  function fireUploadFailure(xhr, type) {
    const state = xhrState(xhr);
    if (!state.uploadStarted)
      return;
    const upload = xhr.upload;
    state.uploadStarted = false;
    fire(upload, type, 0, 0, true);
    fire(upload, 'loadend', 0, 0, true);
  }

  function setTerminalError(xhr, cause, generation) {
    const state = xhrState(xhr);
    if (!state.sendFlag || state.generation !== generation)
      return false;
    cancelTask(state, state.timeoutTask);
    state.timeoutTask = null;
    state.sendFlag = false;
    state.terminalCause = cause;
    state.controller = null;
    clearResponse(state);
    state.responseFailed = true;
    state.readyState = 4;
    fire(xhr, 'readystatechange');
    fireUploadFailure(xhr, cause);
    fire(xhr, cause, 0, 0, true);
    fire(xhr, 'loadend', 0, 0, true);
    return true;
  }

  function scheduleTimeout(xhr, generation) {
    const state = xhrState(xhr);
    cancelTask(state, state.timeoutTask);
    state.timeoutTask = null;
    if (!state.sendFlag || state.timeout === 0)
      return;
    const remaining = Math.max(0, state.sendStart + state.timeout - Number(now()));
    state.timeoutTask = queueTask(xhr, generation, function() {
      const current = xhrState(xhr);
      current.timeoutTask = null;
      if (!isCurrent(current, generation))
        return;
      const left = current.sendStart + current.timeout - Number(now());
      if (left > 0) {
        scheduleTimeout(xhr, generation);
        return;
      }
      const controller = current.controller;
      current.sendFlag = false;
      current.terminalCause = 'timeout';
      if (controller) {
        try { controller.abort(); } catch (error) { reportError(error); }
      }
      // setTerminalError checks the send flag, so restore it for the shared
      // terminal path after aborting the underlying request.
      current.sendFlag = true;
      setTerminalError(xhr, 'timeout', generation);
    }, remaining);
  }

  function pastDeadline(state, completion) {
    const completedAt = typeof deps.completedAt === 'function' ? deps.completedAt(completion) : undefined;
    const time = typeof completedAt === 'number' ? completedAt : Number(now());
    return state.timeout > 0 && time >= state.sendStart + state.timeout;
  }
  function completeFailure(xhr, generation, cause, error) {
    const state = xhrState(xhr);
    if (!isCurrent(state, generation)) return;
    setTerminalError(xhr, cause === 'error' && pastDeadline(state, error) ? 'timeout' : cause, generation);
  }

  function responseBodyBytes(response) {
    if (!response || typeof response.arrayBuffer !== 'function')
      return Promise.reject(new TypeError('The fetch transport returned an invalid response.'));
    return Promise.resolve(response.arrayBuffer()).then(value => {
      if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
        if (value.byteLength > MAX_RESPONSE_BYTES)
          throw new TypeError('XHR response bodies cannot exceed 2 MiB.');
        return new Uint8Array(value.slice(0));
      }
      if (ArrayBuffer.isView(value)) {
        if (value.byteLength > MAX_RESPONSE_BYTES)
          throw new TypeError('XHR response bodies cannot exceed 2 MiB.');
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      }
      throw new TypeError('The fetch transport returned invalid response bytes.');
    });
  }

  function finishSuccess(xhr, generation, response, bytes) {
    const state = xhrState(xhr);
    if (!isCurrent(state, generation))
      return;
    cancelTask(state, state.timeoutTask);
    state.timeoutTask = null;
    state.responseBytes = bytes;
    state.responseText = '';
    state.responseTextReady = false;
    state.responseObject = UNSET;
    state.responseDocument = UNSET;
    state.responseFailed = false;
    state.terminalCause = null;
    const methodHasNoBody = state.method === 'HEAD' || [204, 205, 304].includes(state.responseStatus);
    if (!methodHasNoBody) {
      state.readyState = 3;
      if (state.generation !== generation)
        return;
      fire(xhr, 'readystatechange');
      if (state.generation !== generation)
        return;
      if (!isCurrent(state, generation)) {
        if (state.readyState === 0 && state.terminalCause === 'abort')
          fireProgress(xhr, 'progress', 0, 0, false);
        return;
      }
      const total = progressTotal(state);
      fireProgress(xhr, 'progress', bytes.length,
        total.computable ? total.value : 0, total.computable);
      if (!isCurrent(state, generation))
        return;
    }
    const finalTotal = progressTotal(state);
    state.sendFlag = false;
    state.controller = null;
    state.readyState = 4;
    fire(xhr, 'readystatechange');
    if (state.generation !== generation || state.readyState !== 4)
      return;
    fireProgress(xhr, 'load', bytes.length, finalTotal.value, finalTotal.computable);
    fireProgress(xhr, 'loadend', bytes.length, finalTotal.value, finalTotal.computable);
  }

  function receiveResponse(xhr, generation, response) {
    const state = xhrState(xhr);
    if (!isCurrent(state, generation))
      return;
    if (pastDeadline(state, response)) {
      setTerminalError(xhr, 'timeout', generation);
      return;
    }
    try {
      state.responseStatus = Number(response.status) || 0;
      state.responseStatusText = String(response.statusText || '');
      state.responseUrl = urlWithoutFragment(response.url || state.url);
      state.responseHeaders = response.headers || (HeadersCtor ? new HeadersCtor() : null);
      state.responseContentType = state.responseHeaders && typeof state.responseHeaders.get === 'function'
        ? String(state.responseHeaders.get('content-type') || '')
        : '';
    } catch (error) {
      completeFailure(xhr, generation, 'error');
      return;
    }
    if (!setReadyState(xhr, 2, generation) || !isCurrent(state, generation))
      return;
    fireUploadCompletion(xhr);
    if (!isCurrent(state, generation))
      return;
    responseBodyBytes(response).then(bytes => {
      if (!isCurrent(state, generation))
        return;
      finishSuccess(xhr, generation, response, bytes);
    }, () => completeFailure(xhr, generation, 'error'));
  }

  function abortUnderlying(state) {
    const controller = state.controller;
    state.controller = null;
    if (controller) {
      try { controller.abort(); } catch (error) { reportError(error); }
    }
  }

  function abortActive(xhr, cause, reopen) {
    const state = xhrState(xhr);
    if (!state.sendFlag)
      return false;
    const generation = state.generation;
    abortUnderlying(state);
    const completed = setTerminalError(xhr, cause || 'abort', generation);
    if (completed && !reopen && state.generation === generation && state.readyState === 4) {
      state.readyState = 0;
      state.sendFlag = false;
      clearResponse(state);
    }
    return completed;
  }

  function terminateForOpen(state) {
    cancelAllTasks(state);
    abortUnderlying(state);
    state.generation = nextGeneration++;
    state.sendFlag = false;
    state.uploadStarted = false;
  }

  function resetForOpen(state) {
    cancelAllTasks(state);
    abortUnderlying(state);
    state.generation = nextGeneration++;
    state.sendFlag = false;
    state.method = '';
    state.url = '';
    state.async = true;
    state.readyState = 0;
    state.requestHeaders = HeadersCtor ? new HeadersCtor() : null;
    state.controller = null;
    state.sendStart = 0;
    state.uploadStarted = false;
    state.uploadHasBody = false;
    state.uploadLength = 0;
    state.uploadListenerFlag = false;
    state.terminalCause = null;
    clearResponse(state);
  }

  class XMLHttpRequest extends XMLHttpRequestEventTarget {
    constructor() {
      super();
      const state = {
        readyState: 0,
        method: '',
        url: '',
        async: true,
        sendFlag: false,
        generation: nextGeneration++,
        requestHeaders: HeadersCtor ? new HeadersCtor() : null,
        responseStatus: 0,
        responseStatusText: '',
        responseUrl: '',
        responseHeaders: null,
        responseContentType: '',
        responseBytes: new Uint8Array(0),
        responseText: '',
        responseTextReady: false,
        responseObject: UNSET,
        responseDocument: UNSET,
        responseFailed: false,
        responseType: '',
        overrideMimeType: null,
        timeout: 0,
        timeoutTask: null,
        scheduled: new Set(),
        sendStart: 0,
        controller: null,
        withCredentials: false,
        uploadStarted: false,
        uploadHasBody: false,
        uploadLength: 0,
        uploadListenerFlag: false,
        terminalCause: null,
        uploadHasListeners: false
      };
      state.upload = new XMLHttpRequestUpload(count => {
        state.uploadHasListeners = count > 0;
      });
      states.set(this, state);
    }

    open(method, url, async, username, password) {
      const state = xhrState(this);
      const normalizedMethod = normalizeMethod(method);
      let parsedUrl;
      try {
        parsedUrl = URLCtor ? new URLCtor(toDOMString(url, 'URL'), currentUrl()) : null;
      } catch (error) {
        throw makeDOMException('SyntaxError', 'The XHR URL is invalid.');
      }
      if (!parsedUrl)
        throw makeDOMException('NotSupportedError', 'URL parsing is unavailable.');
      if (parsedUrl.username || parsedUrl.password ||
          (arguments.length > 3 && username != null) ||
          (arguments.length > 4 && password != null)) {
        throw makeDOMException('NotSupportedError', 'XHR URL credentials are not supported.');
      }
      if (async === false)
        throw makeDOMException('NotSupportedError', 'Synchronous XHR is not supported.');
      parsedUrl.hash = '';

      const priorReadyState = state.readyState;
      if (state.sendFlag) {
        terminateForOpen(state);
      } else {
        cancelAllTasks(state);
        abortUnderlying(state);
        state.generation = nextGeneration++;
      }
      cancelAllTasks(state);
      abortUnderlying(state);
      state.sendFlag = false;
      state.readyState = 1;
      state.method = normalizedMethod;
      state.url = String(parsedUrl.href);
      state.async = true;
      state.requestHeaders = HeadersCtor ? new HeadersCtor() : null;
      state.controller = null;
      state.sendStart = 0;
      state.uploadStarted = false;
      state.uploadHasBody = false;
      state.uploadLength = 0;
      state.uploadListenerFlag = false;
      state.terminalCause = null;
      clearResponse(state);
      if (priorReadyState !== 1)
        notifyStateChange(this, state.generation);
    }

    setRequestHeader(name, value) {
      const state = xhrState(this);
      if (state.readyState !== 1 || state.sendFlag)
        throw makeDOMException('InvalidStateError', 'XHR is not open or the request has been sent.');
      const fieldName = toByteString(name, 'Header name');
      const fieldValue = toByteString(value, 'Header value');
      if (!state.requestHeaders)
        throw makeDOMException('NotSupportedError', 'XHR request headers are unavailable.');
      try { state.requestHeaders.append(fieldName, fieldValue); }
      catch (error) { throw error; }
    }

    send(body) {
      const state = xhrState(this);
      if (state.readyState !== 1 || state.sendFlag)
        throw makeDOMException('InvalidStateError', 'XHR must be opened and not already sending.');
      const capturedBody = snapshotBody(state.method === 'GET' || state.method === 'HEAD' ? null : body);
      const actualBody = capturedBody.body;
      if (capturedBody.contentType && !state.requestHeaders.has('content-type'))
        state.requestHeaders.set('Content-Type', capturedBody.contentType);
      if (state.requestHeaders && !state.requestHeaders.has('accept'))
        state.requestHeaders.set('Accept', '*/*');
      state.sendFlag = true;
      state.terminalCause = null;
      state.sendStart = Number(now());
      state.uploadHasBody = actualBody != null;
      state.uploadLength = capturedBody.length;
      state.uploadListenerFlag = state.uploadHasListeners;
      state.uploadStarted = false;
      const generation = state.generation;
      fire(this, 'loadstart', 0, 0, true);
      if (!isCurrent(state, generation))
        return;
      if (state.uploadHasBody && state.uploadListenerFlag) {
        state.uploadStarted = true;
        fire(this.upload, 'loadstart', 0, state.uploadLength, true);
        if (!isCurrent(state, generation))
          return;
      }
      if (state.timeout > 0)
        scheduleTimeout(this, generation);
      if (!isCurrent(state, generation))
        return;

      if (!fetch || !AbortControllerCtor) {
        queueTask(this, generation, () => completeFailure(this, generation, 'error'), 0);
        return;
      }
      let controller;
      try {
        controller = new AbortControllerCtor();
        state.controller = controller;
        const init = {
          method: state.method,
          headers: state.requestHeaders,
          body: actualBody,
          credentials: state.withCredentials ? 'include' : 'same-origin',
          mode: 'cors',
          redirect: 'follow',
          signal: controller.signal
        };
        Promise.resolve(fetch(state.url, init, {
          forcePreflight: state.uploadListenerFlag
        })).then(response => {
          if (isCurrent(state, generation))
            receiveResponse(this, generation, response);
        }, error => completeFailure(this, generation, 'error', error));
      } catch (error) {
        state.controller = null;
        Promise.resolve().then(() => completeFailure(this, generation, 'error'));
      }
    }

    abort() {
      const state = xhrState(this);
      if (!state.sendFlag) {
        if (state.readyState === 4) {
          state.generation = nextGeneration++;
          state.readyState = 0;
          clearResponse(state);
          cancelAllTasks(state);
          abortUnderlying(state);
        }
        return;
      }
      abortActive(this, 'abort', false);
    }

    getResponseHeader(name) {
      const state = xhrState(this);
      if (state.readyState < 2 || !state.responseHeaders || state.responseFailed)
        return null;
      const fieldName = toByteString(name, 'Header name').toLowerCase();
      if (!fieldName || !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(fieldName))
        return null;
      try { return state.responseHeaders.get(fieldName); }
      catch (error) { return null; }
    }

    getAllResponseHeaders() {
      const state = xhrState(this);
      if (state.readyState < 2 || !state.responseHeaders || state.responseFailed)
        return '';
      return responseHeaderList(state.responseHeaders)
        .map(pair => pair[0] + ': ' + pair[1] + '\r\n').join('');
    }

    overrideMimeType(value) {
      const state = xhrState(this);
      if (state.readyState === 3 || state.readyState === 4)
        throw makeDOMException('InvalidStateError', 'MIME type cannot be changed after loading starts.');
      const mimeType = toByteString(value, 'MIME type');
      if (/\r|\n|\0/.test(mimeType))
        throw makeDOMException('SyntaxError', 'The MIME type is invalid.');
      state.overrideMimeType = mimeType;
      state.responseTextReady = false;
      state.responseDocument = UNSET;
      state.responseObject = UNSET;
    }

    get readyState() { return xhrState(this).readyState; }
    get responseType() { return xhrState(this).responseType; }
    set responseType(value) {
      const state = xhrState(this);
      if (state.readyState === 3 || state.readyState === 4)
        throw makeDOMException('InvalidStateError', 'Response type cannot be changed after loading starts.');
      const type = toDOMString(value, 'responseType');
      if (!RESPONSE_TYPES.has(type))
        throw makeDOMException('SyntaxError', 'The response type is not supported.');
      state.responseType = type;
      state.responseObject = UNSET;
      state.responseDocument = UNSET;
    }
    get response() {
      const state = xhrState(this);
      if (state.responseType === '' || state.responseType === 'text') {
        if (state.readyState !== 3 && state.readyState !== 4)
          return '';
        return responseTextFor(state);
      }
      if (state.readyState !== 4 || state.responseFailed)
        return null;
      if (state.responseObject !== UNSET)
        return state.responseObject;
      if (state.responseType === 'json') {
        try { state.responseObject = JSON.parse(typeof deps.decodeJSONText === 'function'
          ? deps.decodeJSONText(state.responseBytes) : decodeText(state.responseBytes, 'utf-8')); }
        catch (error) { state.responseObject = null; }
      } else if (state.responseType === 'arraybuffer') {
        state.responseObject = new Uint8Array(state.responseBytes).buffer;
      } else if (state.responseType === 'blob') {
        state.responseObject = makeBlob(state.responseBytes, mimeParts(
          state.overrideMimeType || state.responseContentType
        ).essence);
      } else if (state.responseType === 'document') {
        state.responseObject = parsedResponseDocument(state);
      } else {
        state.responseObject = null;
      }
      return state.responseObject;
    }
    get responseText() {
      const state = xhrState(this);
      if (state.responseType !== '' && state.responseType !== 'text')
        throw makeDOMException('InvalidStateError', 'responseText is only available for text responses.');
      if (state.readyState !== 3 && state.readyState !== 4)
        return '';
      return responseTextFor(state);
    }
    get responseXML() {
      const state = xhrState(this);
      if (state.responseType !== '' && state.responseType !== 'document')
        throw makeDOMException('InvalidStateError', 'responseXML is unavailable for this response type.');
      if (state.readyState !== 4 || state.responseFailed)
        return null;
      return parsedResponseDocument(state);
    }
    get status() {
      const state = xhrState(this);
      return state.readyState < 2 || state.responseFailed ? 0 : state.responseStatus;
    }
    get statusText() {
      const state = xhrState(this);
      return state.readyState < 2 || state.responseFailed ? '' : state.responseStatusText;
    }
    get responseURL() {
      const state = xhrState(this);
      return state.readyState < 2 || state.responseFailed ? '' : state.responseUrl;
    }
    get timeout() { return xhrState(this).timeout; }
    set timeout(value) {
      const state = xhrState(this);
      state.timeout = uint32(value);
      if (state.sendFlag)
        scheduleTimeout(this, state.generation);
    }
    get withCredentials() { return xhrState(this).withCredentials; }
    set withCredentials(value) {
      const state = xhrState(this);
      if (state.readyState !== 0 && (state.readyState !== 1 || state.sendFlag))
        throw makeDOMException('InvalidStateError', 'withCredentials cannot change during a request.');
      state.withCredentials = Boolean(value);
    }
    get upload() { return xhrState(this).upload; }
    get [Symbol.toStringTag]() { return 'XMLHttpRequest'; }
  }

  Object.defineProperties(XMLHttpRequest, {
    UNSENT: { value: 0, enumerable: true },
    OPENED: { value: 1, enumerable: true },
    HEADERS_RECEIVED: { value: 2, enumerable: true },
    LOADING: { value: 3, enumerable: true },
    DONE: { value: 4, enumerable: true }
  });
  Object.defineProperties(XMLHttpRequest.prototype, {
    UNSENT: { value: 0, enumerable: true },
    OPENED: { value: 1, enumerable: true },
    HEADERS_RECEIVED: { value: 2, enumerable: true },
    LOADING: { value: 3, enumerable: true },
    DONE: { value: 4, enumerable: true }
  });
  installEventHandlers(XMLHttpRequestEventTarget.prototype, EVENT_TARGET_EVENTS);
  installEventHandlers(XMLHttpRequest.prototype, ['readystatechange']);

  return {
    XMLHttpRequest,
    XMLHttpRequestEventTarget,
    XMLHttpRequestUpload
  };
}

