/*
 * Host-backed HTMLImageElement loading for the native document runtime.
 *
 * Image bytes stay in the host image pipeline. This helper sends only an
 * absolute source URL and fetch policy, then exposes the host's immutable
 * decoded-image handle to Canvas. It never returns image bytes to JavaScript.
 */
const documentImageManagers = new WeakMap();
const installedImagePrototypes = new WeakMap();
let nextDocumentImageRequestSerial = 1;

function createDocumentImages(dependencies) {
  const deps = dependencies || {};
  const document = deps.document;
  const EventCtor = typeof deps.Event === 'function'
    ? deps.Event
    : (document && document.defaultView && document.defaultView.Event);
  const URLCtor = typeof deps.URL === 'function'
    ? deps.URL
    : (typeof URL === 'function' ? URL : null);
  const enqueue = typeof deps.enqueue === 'function'
    ? deps.enqueue
    : function() { throw new TypeError('The native image transport is unavailable.'); };
  const cancel = typeof deps.cancel === 'function' ? deps.cancel : null;
  const diagnostic = typeof deps.diagnostic === 'function'
    ? deps.diagnostic
    : function() {};
  const suppressMutations = typeof deps.suppressMutations === 'function'
    ? deps.suppressMutations
    : function() { return false; };
  const onEventPropertySet = typeof deps.onEventPropertySet === 'function'
    ? deps.onEventPropertySet
    : null;
  const getBaseUrl = function() {
    const value = typeof deps.baseUrl === 'function' ? deps.baseUrl() : deps.baseUrl;
    return String(value == null ? 'about:blank' : value);
  };

  // The native cache has the same image limits: 64 outstanding decodes and
  // 256 requests during one document lifetime. Its decoded pool is capped at
  // 64 images and 16 megapixels aggregate.
  const MAX_PENDING_IMAGES = 64;
  const MAX_IMAGE_REQUESTS = 256;
  const MAX_SOURCE_LENGTH = 2 * 1024 * 1024;
  const MAX_IMAGE_SIDE = 8192;
  const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
  const MAX_IMAGE_ID_LENGTH = 256;
  const CORS_VALUES = new Set(['anonymous', 'use-credentials']);
  const REFERRER_POLICIES = new Set([
    'no-referrer', 'no-referrer-when-downgrade', 'origin',
    'origin-when-cross-origin', 'same-origin', 'strict-origin',
    'strict-origin-when-cross-origin', 'unsafe-url'
  ]);

  let HTMLImageElementCtor = typeof deps.HTMLImageElement === 'function'
    ? deps.HTMLImageElement
    : (document && document.defaultView && document.defaultView.HTMLImageElement);
  const HTMLElementCtor = typeof deps.HTMLElement === 'function'
    ? deps.HTMLElement
    : (document && document.defaultView && document.defaultView.HTMLElement);
  if (!HTMLImageElementCtor && document && typeof document.createElement === 'function') {
    try {
      const sample = document.createElement('img');
      HTMLImageElementCtor = sample && sample.constructor;
    } catch (error) {
      // The constructor is checked below so the factory returns a useful error.
    }
  }
  const imagePrototype = HTMLImageElementCtor && HTMLImageElementCtor.prototype;
  if (!document || typeof document.createElement !== 'function' || !imagePrototype)
    throw new TypeError('A document with HTMLImageElement support is required.');

  const imageStates = new WeakMap();
  const pending = new Map();
  const loadedStates = new Set();
  const activeAttributeMutations = new WeakSet();
  let issuedRequestCount = 0;
  let installed = false;

  function report(code, severity, message, detail) {
    try {
      diagnostic(code, severity, message, detail);
    } catch (error) {
      // Diagnostics must not change image loading behavior.
    }
  }

  function domException(name, message) {
    const view = document && document.defaultView;
    try {
      const Ctor = view && typeof view.DOMException === 'function'
        ? view.DOMException
        : (typeof DOMException === 'function' ? DOMException : null);
      if (Ctor)
        return new Ctor(message, name);
    } catch (error) {
      // Fall through for lightweight DOM implementations.
    }
    const error = new Error(message);
    error.name = name;
    return error;
  }

  function isImage(element) {
    if (!element || typeof element !== 'object')
      return false;
    try {
      if (HTMLImageElementCtor && element instanceof HTMLImageElementCtor)
        return true;
    } catch (error) {
      // Some host DOM wrappers do not support instanceof.
    }
    const name = element.localName || element.tagName;
    if (!element.ownerDocument || element.nodeType !== 1 ||
        typeof name !== 'string' || name.toLowerCase() !== 'img')
      return false;
    if (HTMLElementCtor) {
      try {
        return element instanceof HTMLElementCtor;
      } catch (error) {
        return false;
      }
    }
    return true;
  }

  function managerFor(element) {
    const owner = element && element.ownerDocument;
    return owner ? documentImageManagers.get(owner) || null : null;
  }

  function stateFor(image) {
    let state = imageStates.get(image);
    if (state)
      return state;
    state = {
      image,
      signature: null,
      version: 0,
      requestId: null,
      request: null,
      status: 'empty',
      sourceUrl: '',
      currentSrc: '',
      imageId: null,
      width: 0,
      height: 0,
      originClean: true,
      decodePromise: null,
      decodeResolve: null,
      decodeReject: null,
      eventHandlers: { load: null, error: null }
    };
    imageStates.set(image, state);
    return state;
  }

  function rawAttribute(image, name) {
    try {
      return image.getAttribute(name);
    } catch (error) {
      return null;
    }
  }

  function corsMode(image) {
    const value = rawAttribute(image, 'crossorigin');
    if (value == null)
      return null;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'use-credentials')
      return 'use-credentials';
    // Empty and invalid crossorigin keywords use the anonymous CORS mode.
    return 'anonymous';
  }

  function referrerPolicy(image) {
    const value = rawAttribute(image, 'referrerpolicy');
    if (value == null)
      return '';
    const normalized = String(value).trim().toLowerCase();
    return REFERRER_POLICIES.has(normalized) ? normalized : '';
  }

  function sourceSignature(image) {
    const source = rawAttribute(image, 'src');
    const cors = corsMode(image);
    if (source === null)
      return JSON.stringify([false, '', cors]);
    const raw = String(source);
    if (raw === '')
      return JSON.stringify([true, 'empty', cors]);
    try {
      // Equivalent relative and absolute spellings share one pending fetch.
      // Referrer policy is sampled when each request is created, but changing
      // it alone does not restart an image load.
      return JSON.stringify([true, 'url', resolvedSource(raw), cors]);
    } catch (error) {
      // Invalid and oversized values must remain distinguishable without
      // throwing from property getters or snapshot observation.
      let base = '';
      try { base = getBaseUrl(); } catch (ignored) {}
      return JSON.stringify([true, 'invalid', raw, base, cors]);
    }
  }

  function resolvedSource(raw) {
    if (!URLCtor)
      throw new TypeError('Image URLs are unavailable.');
    if (String(raw).length > MAX_SOURCE_LENGTH)
      throw new RangeError('Image source URLs cannot exceed 2 MiB.');
    let parsed;
    try {
      parsed = new URLCtor(String(raw), getBaseUrl());
    } catch (error) {
      throw new TypeError('Image source URL is invalid.');
    }
    const protocol = String(parsed.protocol || '').toLowerCase();
    if (!['http:', 'https:', 'blob:', 'data:'].includes(protocol))
      throw new TypeError('Image source URL scheme is unavailable.');
    // Credentials belong to the page's URL policy and are never forwarded to
    // the native image transport as part of a source URL.
    if (parsed.username || parsed.password)
      throw new TypeError('Image source URLs cannot contain credentials.');
    const href = String(parsed.href || parsed.toString());
    if (!href || href.length > MAX_SOURCE_LENGTH)
      throw new RangeError('Image source URLs cannot exceed 2 MiB.');
    return href;
  }

  function schedule(callback) {
    // Promise jobs are available in the document VM and preserve async load / error
    // delivery without exposing a timer or native scheduling primitive to scripts.
    Promise.resolve().then(callback).catch(function(error) {
      report('image.event_error', 'error', 'An image event listener failed.', {
        message: String(error && error.message || error).slice(0, 160)
      });
    });
  }

  function dispatch(image, type, version) {
    schedule(function() {
      const state = imageStates.get(image);
      if (!state || state.version !== version ||
          (type === 'load' && state.status !== 'loaded') ||
          (type === 'error' && state.status !== 'error'))
        return;
      if (typeof EventCtor !== 'function') {
        report('image.event_unavailable', 'error', 'Image events are unavailable.');
        return;
      }
      try {
        image.dispatchEvent(new EventCtor(type, {
          bubbles: false,
          cancelable: false
        }));
      } catch (error) {
        report('image.event_error', 'error', 'An image event could not be dispatched.', {
          type: type
        });
      }
    });
  }

  function settleDecode(state, success) {
    const resolve = state.decodeResolve;
    const reject = state.decodeReject;
    if (!resolve && !reject)
      return;
    state.decodePromise = null;
    state.decodeResolve = null;
    state.decodeReject = null;
    if (success)
      resolve();
    else
      reject(domException('EncodingError', 'The image could not be decoded.'));
  }

  function notifyCancellation(id) {
    if (!cancel)
      return;
    try { cancel(id); } catch (error) {}
  }

  function cancelPending(state) {
    const requestId = state.requestId;
    const record = requestId && pending.get(requestId);
    if (record) {
      // A native decode may finish after its snapshot left JavaScript. Its
      // completion is ignored because its ID is no longer live.
      record.request.cancelled = true;
      record.cancelled = true;
      pending.delete(requestId);
    }
    state.requestId = null;
    state.request = null;
    settleDecode(state, false);
    if (record && record.enqueued)
      notifyCancellation(requestId);
  }

  function markError(state, version) {
    state.status = 'error';
    state.currentSrc = state.sourceUrl || readSourceProperty(state.image);
    state.imageId = null;
    state.width = 0;
    state.height = 0;
    state.originClean = true;
    loadedStates.delete(state);
    settleDecode(state, false);
    dispatch(state.image, 'error', version);
  }

  function failRequest(state, version, code, message) {
    report(code, 'error', message);
    markError(state, version);
  }

  function beginLoad(image, force) {
    const state = stateFor(image);
    const signature = sourceSignature(image);
    if (state.signature === signature &&
        (!force || state.status === 'pending'))
      return;

    const raw = rawAttribute(image, 'src');
    state.signature = signature;
    state.version += 1;
    const version = state.version;
    cancelPending(state);
    // The cancellation callback can reenter through its dependency. Keep any
    // newer source installed by that reentry instead of continuing this load.
    if (state.version !== version || state.signature !== signature)
      return;
    if (raw === null) {
      state.status = 'empty';
      state.sourceUrl = '';
      state.currentSrc = '';
      state.imageId = null;
      state.width = 0;
      state.height = 0;
      state.originClean = true;
      loadedStates.delete(state);
      return;
    }
    if (String(raw) === '') {
      // An explicitly empty src fails asynchronously without requesting the
      // document URL. Removing src remains the distinct, event-free empty state.
      state.status = 'error';
      state.sourceUrl = '';
      state.currentSrc = '';
      state.imageId = null;
      state.width = 0;
      state.height = 0;
      state.originClean = true;
      loadedStates.delete(state);
      settleDecode(state, false);
      dispatch(image, 'error', version);
      return;
    }

    // Chrome keeps the previous currentSrc and dimensions only until the next
    // microtask. Canvas draws already become no-ops as soon as replacement
    // starts, since imageId is cleared synchronously.
    state.status = 'pending';
    state.sourceUrl = readSourceProperty(image);
    state.imageId = null;
    state.originClean = true;
    loadedStates.delete(state);
    schedule(function() {
      if (state.version !== version || state.status !== 'pending')
        return;
      state.currentSrc = '';
      state.width = 0;
      state.height = 0;
    });

    let url;
    try {
      url = resolvedSource(raw);
    } catch (error) {
      state.status = 'error';
      failRequest(state, version, 'image.invalid_source',
        'The image source could not be loaded.');
      return;
    }

    if (issuedRequestCount >= MAX_IMAGE_REQUESTS) {
      state.status = 'error';
      failRequest(state, version, 'image.request_limit',
        'The document image request limit of 256 has been reached.');
      return;
    }
    if (pending.size >= MAX_PENDING_IMAGES) {
      state.status = 'error';
      failRequest(state, version, 'image.pending_limit',
        'The document can have at most 64 pending image decodes.');
      return;
    }

    const id = 'image-' + nextDocumentImageRequestSerial++;
    issuedRequestCount += 1;
    state.sourceUrl = url;
    state.requestId = id;
    const request = {
      kind: 'image',
      id: id,
      url: url,
      crossOrigin: corsMode(image),
      referrerPolicy: referrerPolicy(image),
      version: version
    };
    state.request = request;
    const record = { image, state, version, url, request, enqueued: false, cancelled: false };
    pending.set(id, record);
    try {
      enqueue(request);
      record.enqueued = true;
      // enqueue may synchronously reenter and replace this source. Defer the
      // host cancellation until enqueue confirms this request reached its queue.
      if (record.cancelled)
        notifyCancellation(id);
    } catch (error) {
      if (pending.get(id) === record)
        pending.delete(id);
      // A reentrant source replacement owns the state now. An enqueue failure
      // from the superseded request must not overwrite it or dispatch an error.
      if (state.requestId === id && state.version === version) {
        state.requestId = null;
        state.request = null;
        failRequest(state, version, 'image.enqueue_error',
          'The native image request could not be queued.');
      }
    }
  }

  function changedAttribute(image, name, operation) {
    if (suppressMutations() || !isImage(image) || image.ownerDocument !== document)
      return;
    const normalized = String(name).toLowerCase();
    if (normalized !== 'src' && normalized !== 'crossorigin' &&
        normalized !== 'referrerpolicy')
      return;
    if (activeAttributeMutations.has(image))
      return;
    activeAttributeMutations.add(image);
    try {
      operation();
    } finally {
      activeAttributeMutations.delete(image);
      beginLoad(image, normalized === 'src');
    }
  }

  function ensureObserved(image) {
    if (!isImage(image) || image.ownerDocument !== document)
      return null;
    const state = stateFor(image);
    if (state.signature !== sourceSignature(image))
      beginLoad(image, false);
    return state;
  }

  function validCompletion(completion) {
    if (!completion || typeof completion !== 'object' || completion.ok !== true ||
        typeof completion.imageId !== 'string' || completion.imageId.length === 0 ||
        completion.imageId.length > MAX_IMAGE_ID_LENGTH ||
        /[^\x21-\x7e]/.test(completion.imageId) ||
        !Number.isInteger(completion.width) || completion.width <= 0 ||
        completion.width > MAX_IMAGE_SIDE ||
        !Number.isInteger(completion.height) || completion.height <= 0 ||
        completion.height > MAX_IMAGE_SIDE ||
        completion.width * completion.height > MAX_IMAGE_PIXELS ||
        typeof completion.originClean !== 'boolean')
      return false;
    return true;
  }

  function complete(completion) {
    if (!completion || typeof completion.id !== 'string')
      return false;
    const record = pending.get(completion.id);
    if (!record)
      return false;
    pending.delete(completion.id);
    const state = record.state;
    if (state.requestId !== completion.id || state.version !== record.version)
      return false;
    state.requestId = null;
    state.request = null;

    if (completion.ok !== true || !validCompletion(completion)) {
      markError(state, record.version);
      return true;
    }
    state.status = 'loaded';
    state.currentSrc = record.url;
    state.imageId = completion.imageId;
    state.width = completion.width;
    state.height = completion.height;
    state.originClean = completion.originClean;
    loadedStates.add(state);
    settleDecode(state, true);
    dispatch(record.image, 'load', record.version);
    return true;
  }

  function imageSource(element) {
    if (!isImage(element))
      throw new TypeError('Canvas image source must be an HTMLImageElement.');
    const ownerManager = managerFor(element);
    if (ownerManager && ownerManager !== manager)
      return ownerManager.canvasSource(element);
    const state = ensureObserved(element);
    if (!state || state.status === 'empty' || state.status === 'pending')
      return null;
    if (state.status === 'error')
      throw domException('InvalidStateError', 'The image is broken or unavailable.');
    return {
      imageId: state.imageId,
      width: state.width,
      height: state.height,
      originClean: state.originClean
    };
  }

  function readSourceProperty(image) {
    if (!isImage(image) || image.ownerDocument !== document)
      return '';
    const raw = rawAttribute(image, 'src');
    if (raw === null)
      return '';
    try {
      return resolvedSource(raw);
    } catch (error) {
      return String(raw);
    }
  }

  function readCurrentSrc(image) {
    const state = ensureObserved(image);
    return state ? state.currentSrc : '';
  }

  function readCrossOrigin(image) {
    const value = rawAttribute(image, 'crossorigin');
    if (value == null)
      return null;
    const normalized = String(value).trim().toLowerCase();
    return CORS_VALUES.has(normalized) ? normalized : 'anonymous';
  }

  function readReferrerPolicy(image) {
    return referrerPolicy(image);
  }

  function readComplete(image) {
    const state = ensureObserved(image);
    return !state || state.status !== 'pending';
  }

  function readNaturalDimension(image, axis) {
    const state = ensureObserved(image);
    return state ? state[axis] : 0;
  }

  function readDimensionProperty(image, axis, descriptor) {
    if (!isImage(image) || image.ownerDocument !== document)
      return descriptor && descriptor.get ? descriptor.get.call(image) : 0;

    const originalValue = descriptor && descriptor.get
      ? descriptor.get.call(image)
      : 0;
    // Preserve reflected dimensions and any rendered CSS measurement provided
    // by the DOM implementation. LinkeDOM has no layout engine, so its zero
    // value for an un-attributed image falls back to the decoded intrinsic size.
    if (rawAttribute(image, axis) !== null ||
        (Number.isFinite(Number(originalValue)) && Number(originalValue) !== 0))
      return originalValue;
    const state = ensureObserved(image);
    return state ? state[axis] : originalValue;
  }

  function decode(image) {
    const state = ensureObserved(image);
    if (!state)
      return Promise.reject(new TypeError('Image.decode called on an incompatible receiver.'));
    if (state.status === 'loaded')
      return Promise.resolve();
    if (state.status === 'error' || state.status === 'empty')
      return Promise.reject(domException('EncodingError', 'The image could not be decoded.'));
    if (!state.decodePromise) {
      state.decodePromise = new Promise(function(resolve, reject) {
        state.decodeResolve = resolve;
        state.decodeReject = reject;
      });
    }
    return state.decodePromise;
  }

  function eventProperty(image, type, value) {
    const state = stateFor(image);
    if (onEventPropertySet) {
      try {
        onEventPropertySet(image, type);
      } catch (error) {
        report('image.event_property_error', 'error',
          'The image event property could not replace its inline handler.');
      }
    }
    const previous = state.eventHandlers[type];
    if (previous && previous.listener)
      image.removeEventListener(type, previous.listener);
    const normalizedValue = value == null ? null : value;
    const record = { value: normalizedValue, listener: null };
    if (typeof normalizedValue === 'function') {
      record.listener = function(event) {
        try {
          return normalizedValue.call(image, event);
        } catch (error) {
          report('image.event_error', 'error', 'An image event listener failed.', {
            type: type,
            message: String(error && error.message || error).slice(0, 160)
          });
          return undefined;
        }
      };
      image.addEventListener(type, record.listener);
    }
    state.eventHandlers[type] = record;
  }

  function readEventProperty(image, type) {
    const state = stateFor(image);
    const record = state.eventHandlers[type];
    return record ? record.value : null;
  }

  function installImagePrototype() {
    let record = installedImagePrototypes.get(imagePrototype);
    if (record)
      return;
    record = {
      src: Object.getOwnPropertyDescriptor(imagePrototype, 'src'),
      width: Object.getOwnPropertyDescriptor(imagePrototype, 'width'),
      height: Object.getOwnPropertyDescriptor(imagePrototype, 'height'),
      setAttribute: imagePrototype.setAttribute,
      removeAttribute: imagePrototype.removeAttribute,
      toggleAttribute: imagePrototype.toggleAttribute,
      addEventListener: imagePrototype.addEventListener
    };
    installedImagePrototypes.set(imagePrototype, record);

    function owningManager(image) {
      return managerFor(image);
    }

    try {
      Object.defineProperty(imagePrototype, 'src', {
        configurable: true,
        enumerable: record.src ? Boolean(record.src.enumerable) : true,
        get: function() {
          const manager = owningManager(this);
          if (manager)
            return manager.readSourceProperty(this);
          return record.src && record.src.get ? record.src.get.call(this) : '';
        },
        set: function(value) {
          if (typeof value === 'symbol')
            throw new TypeError('Cannot convert a Symbol value to a string.');
          const manager = owningManager(this);
          if (manager) {
            this.setAttribute('src', String(value));
            return;
          }
          if (record.src && record.src.set)
            record.src.set.call(this, value);
        }
      });
      for (const axis of ['width', 'height']) {
        const descriptor = record[axis];
        Object.defineProperty(imagePrototype, axis, {
          configurable: true,
          enumerable: descriptor ? Boolean(descriptor.enumerable) : true,
          get: function() {
            const manager = owningManager(this);
            if (manager)
              return manager.readDimensionProperty(this, axis, descriptor);
            return descriptor && descriptor.get ? descriptor.get.call(this) : 0;
          },
          set: function(value) {
            if (descriptor && descriptor.set)
              return descriptor.set.call(this, value);
          }
        });
      }
      for (const [name, getter] of [
        ['currentSrc', function(manager, image) { return manager.readCurrentSrc(image); }],
        ['complete', function(manager, image) { return manager.readComplete(image); }],
        ['naturalWidth', function(manager, image) { return manager.readNaturalDimension(image, 'width'); }],
        ['naturalHeight', function(manager, image) { return manager.readNaturalDimension(image, 'height'); }]
      ]) {
        Object.defineProperty(imagePrototype, name, {
          configurable: true,
          enumerable: true,
          get: function() {
            const manager = owningManager(this);
            if (manager)
              return getter(manager, this);
            if (name === 'complete')
              return true;
            return 0;
          }
        });
      }
      Object.defineProperty(imagePrototype, 'crossOrigin', {
        configurable: true,
        enumerable: true,
        get: function() {
          const manager = owningManager(this);
          return manager ? manager.readCrossOrigin(this) : null;
        },
        set: function(value) {
          if (typeof value === 'symbol')
            throw new TypeError('Cannot convert a Symbol value to a string.');
          if (value == null) this.removeAttribute('crossorigin');
          else this.setAttribute('crossorigin', String(value));
        }
      });
      Object.defineProperty(imagePrototype, 'referrerPolicy', {
        configurable: true,
        enumerable: true,
        get: function() {
          const manager = owningManager(this);
          return manager ? manager.readReferrerPolicy(this) : '';
        },
        set: function(value) {
          if (typeof value === 'symbol')
            throw new TypeError('Cannot convert a Symbol value to a string.');
          this.setAttribute('referrerpolicy', String(value));
        }
      });
      Object.defineProperty(imagePrototype, 'decode', {
        configurable: true,
        writable: true,
        value: function() {
          const manager = owningManager(this);
          return manager
            ? manager.decode(this)
            : Promise.reject(new TypeError('Image.decode called on an incompatible receiver.'));
        }
      });
      for (const type of ['load', 'error']) {
        const property = 'on' + type;
        Object.defineProperty(imagePrototype, property, {
          configurable: true,
          enumerable: true,
          get: function() {
            const manager = owningManager(this);
            return manager ? manager.readEventProperty(this, type) : null;
          },
          set: function(value) {
            const manager = owningManager(this);
            if (manager)
              manager.eventProperty(this, type, value);
          }
        });
      }

      function wrapAttributeMethod(name, original) {
        if (typeof original !== 'function')
          return;
        Object.defineProperty(imagePrototype, name, {
          configurable: true,
          writable: true,
          value: function(attributeName) {
            const image = this;
            const normalized = String(attributeName).toLowerCase();
            const tracked = normalized === 'src' || normalized === 'crossorigin' ||
              normalized === 'referrerpolicy';
            const nested = tracked && activeAttributeMutations.has(image);
            if (tracked && !nested)
              activeAttributeMutations.add(image);
            let result;
            let completed = false;
            try {
              result = original.apply(image, arguments);
              completed = true;
            } finally {
              if (tracked && !nested) {
                activeAttributeMutations.delete(image);
                const manager = owningManager(image);
                if (manager && completed)
                  manager.changedAttribute(image, normalized, function() {});
              }
            }
            return result;
          }
        });
      }
      wrapAttributeMethod('setAttribute', record.setAttribute);
      wrapAttributeMethod('removeAttribute', record.removeAttribute);
      wrapAttributeMethod('toggleAttribute', record.toggleAttribute);
      if (typeof record.addEventListener === 'function') {
        Object.defineProperty(imagePrototype, 'addEventListener', {
          configurable: true,
          writable: true,
          value: function(type) {
            const result = record.addEventListener.apply(this, arguments);
            const normalized = String(type).toLowerCase();
            const manager = owningManager(this);
            if (manager && (normalized === 'load' || normalized === 'error'))
              manager.observe(this);
            return result;
          }
        });
      }
    } catch (error) {
      installedImagePrototypes.delete(imagePrototype);
      throw error;
    }
  }

  const manager = {
    canvasSource: imageSource,
    complete,
    decode,
    eventProperty,
    readComplete,
    readCrossOrigin,
    readCurrentSrc,
    readEventProperty,
    readNaturalDimension,
    readDimensionProperty,
    readSourceProperty,
    readReferrerPolicy,
    changedAttribute,
    observe: ensureObserved
  };

  function Image(width, height) {
    if (!new.target)
      throw new TypeError("Failed to construct 'Image': Please use the 'new' operator.");
    const image = document.createElement('img');
    if (!isImage(image))
      throw new TypeError('The document did not create an HTMLImageElement.');
    if (arguments.length === 1) {
      image.width = width;
    } else if (arguments.length > 1) {
      image.width = width;
      image.height = height;
    }
    ensureObserved(image);
    return image;
  }
  Image.prototype = imagePrototype;

  function install() {
    if (installed)
      return Image;
    installed = true;
    documentImageManagers.set(document, manager);
    installImagePrototype();
    return Image;
  }

  function prepareTree(root) {
    const scope = root || document;
    const candidates = [];
    if (isImage(scope))
      candidates.push(scope);
    try {
      if (scope && typeof scope.querySelectorAll === 'function') {
        for (const image of scope.querySelectorAll('img'))
          candidates.push(image);
      }
    } catch (error) {
      report('image.tree_error', 'error', 'The document image tree could not be inspected.');
    }
    for (const image of candidates) {
      if (imageStates.has(image) || rawAttribute(image, 'onload') !== null ||
          rawAttribute(image, 'onerror') !== null)
        ensureObserved(image);
    }
  }

  function retainedImageIds() {
    const ids = [];
    for (const state of loadedStates) {
      if (state.imageId)
        ids.push(state.imageId);
    }
    return ids;
  }

  return {
    Image,
    install,
    prepareTree,
    complete,
    canvasSource: imageSource,
    retainedImageIds
  };
}
