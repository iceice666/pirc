/*
 * Runtime wrapper for the vendored LinkeDOM 0.18.13 worker bundle.
 * This file is concatenated into the bundle's outer IIFE so it can access
 * LinkeDOM's lexical DOM constructors without exposing module imports.
 */
(function documentScriptRuntimeWrapper() {
  'use strict';
  const nativeCanvasTextEngine = globalThis.__pircNativeCanvasText;
  delete globalThis.__pircNativeCanvasText;
  delete globalThis.__pircInitializeCanvasText;
  const MAX_INPUT_BYTES = 4 * 1024 * 1024;
  const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
  const MAX_DOM_NODES = 5000;
  const MAX_DIAGNOSTICS = 100;
  const MAX_PENDING_CALLBACKS = 256;
  const MAX_PENDING_SCROLL_ACTIONS = 128;
  const MARKER_ATTRIBUTE = 'data-pirc-script-id';
  const CLICK_MARKER_ATTRIBUTE = 'data-pirc-script-click';

  let activeState = null;
  const storageBridge = createPircDocumentStorageBridge({
    getStorage: () => activeState && activeState.storage,
    response: () => response()
  });
  let originalOnclickDescriptor = null;

  // LinkeDOM's HTML Attr serializer leaves ampersands literal. A second HTML
  // parser would interpret entity-like user input (e.g. &copy;) as new data.
  Attr.prototype.toString = function() {
    const escaped = String(this.value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return String(this.name) + '="' + escaped + '"';
  };

  function utf8ByteLength(value) {
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 0x80) {
        bytes += 1;
      } else if (code < 0x800) {
        bytes += 2;
      } else if (code >= 0xd800 && code <= 0xdbff &&
                 i + 1 < value.length &&
                 value.charCodeAt(i + 1) >= 0xdc00 &&
                 value.charCodeAt(i + 1) <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  function diagnostic(code, severity, message, detail) {
    const state = activeState;
    if (!state)
      return;
    if (state.diagnostics.length >= MAX_DIAGNOSTICS) {
      if (!state.diagnosticsOmitted) {
        state.diagnosticsOmitted = true;
        state.diagnostics[MAX_DIAGNOSTICS - 1] = {
          code: 'runtime.diagnostics_truncated',
          severity: 'warning',
          message: 'Additional diagnostics were omitted.'
        };
      }
      return;
    }
    const item = {
      code: String(code),
      severity: String(severity),
      message: String(message).slice(0, 1200)
    };
    if (detail && typeof detail === 'object') {
      for (const key of Object.keys(detail))
        item[key] = detail[key];
    }
    state.diagnostics.push(item);
  }

  function exceptionMessage(error) {
    if (error && typeof error.message === 'string')
      return error.message;
    return String(error);
  }

  function nextActionOrder() {
    const state = activeState;
    if (!state)
      return 0;
    const order = state.nextActionOrder;
    state.nextActionOrder += 1;
    return order;
  }

  function currentLocationUrl() {
    const raw = activeState ? activeState.url : 'about:blank';
    try {
      return new pircUrlPolyfill.URL(String(raw || 'about:blank'));
    } catch (error) {
      return null;
    }
  }

  const DEFAULT_DOCUMENT_REFERRER_POLICY = 'strict-origin-when-cross-origin';
  const REFERRER_POLICIES = new Set([
    'no-referrer',
    'no-referrer-when-downgrade',
    'origin',
    'origin-when-cross-origin',
    'same-origin',
    'strict-origin',
    'strict-origin-when-cross-origin',
    'unsafe-url'
  ]);

  function asciiLower(value) {
    return String(value).replace(/[A-Z]/g, character =>
      String.fromCharCode(character.charCodeAt(0) + 0x20)
    );
  }

  function trimAsciiWhitespace(value) {
    return String(value).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  }

  function normalizeReferrerPolicy(value) {
    if (typeof value !== 'string')
      return null;
    const normalized = asciiLower(trimAsciiWhitespace(value));
    return REFERRER_POLICIES.has(normalized) ? normalized : null;
  }

  function parseReferrerPolicyHeader(value) {
    let policy = DEFAULT_DOCUMENT_REFERRER_POLICY;
    if (typeof value !== 'string')
      return policy;
    for (const candidate of value.split(',')) {
      const normalized = normalizeReferrerPolicy(candidate);
      if (normalized)
        policy = normalized;
    }
    return policy;
  }

  function currentDocumentReferrerPolicy() {
    const state = activeState;
    let policy = state && REFERRER_POLICIES.has(state.documentReferrerPolicy)
      ? state.documentReferrerPolicy
      : DEFAULT_DOCUMENT_REFERRER_POLICY;
    if (!state || !state.document)
      return policy;

    for (const meta of state.document.querySelectorAll('meta[name]')) {
      if (asciiLower(trimAsciiWhitespace(meta.getAttribute('name') || '')) !== 'referrer')
        continue;
      const candidate = normalizeReferrerPolicy(meta.getAttribute('content') || '');
      if (candidate)
        policy = candidate;
    }
    return policy;
  }

  function currentDocumentBaseUrl() {
    const state = activeState;
    const fallback = state ? String(state.url || 'about:blank') : 'about:blank';
    if (!state || !state.document)
      return fallback;
    const baseElements = state.document.querySelectorAll('base[href]');
    for (const element of baseElements) {
      try {
        return new pircUrlPolyfill.URL(
          String(element.getAttribute('href') || ''),
          fallback
        ).href;
      } catch (error) {
        // An invalid base element does not replace the current document base.
      }
    }
    return fallback;
  }

  function navigationDiagnostic(reason, source) {
    const detail = { reason: reason };
    if (source)
      detail.source = source;
    diagnostic(
      'navigation.invalid_url',
      'warning',
      'Navigation requires a valid HTTP, HTTPS or document-owned blob URL.',
      detail
    );
  }

  function resolveNavigationUrl(value, useDocumentBase) {
    const state = activeState;
    let raw;
    try {
      raw = String(value);
    } catch (error) {
      navigationDiagnostic('url_conversion_failed');
      return null;
    }

    let base = state ? String(state.url || 'about:blank') : 'about:blank';
    if (useDocumentBase && state && state.document) {
      const baseElement = state.document.querySelector('base[href]');
      if (baseElement) {
        try {
          const baseUrl = new pircUrlPolyfill.URL(
            String(baseElement.getAttribute('href') || ''),
            base
          );
          if (!['http:', 'https:'].includes(baseUrl.protocol.toLowerCase())) {
            navigationDiagnostic('unsupported_scheme', 'base');
            return null;
          }
          base = baseUrl.href;
        } catch (error) {
          navigationDiagnostic('invalid_base', 'base');
          return null;
        }
      }
    }

    let resolved;
    try {
      resolved = new pircUrlPolyfill.URL(raw, base);
    } catch (error) {
      navigationDiagnostic('invalid_url');
      return null;
    }
    if (!['http:', 'https:', 'blob:'].includes(resolved.protocol.toLowerCase())) {
      navigationDiagnostic('unsupported_scheme');
      return null;
    }
    return resolved.href;
  }

  function hasNativeSameWindowLinkDefault(targetElement) {
    const state = activeState;
    if (!state || !state.document || !targetElement ||
        targetElement.ownerDocument !== state.document || !targetElement.isConnected) {
      return false;
    }

    let anchor = targetElement;
    while (anchor && anchor !== state.document) {
      if (String(anchor.localName || '').toLowerCase() === 'a' &&
          anchor.hasAttribute('href')) {
        break;
      }
      anchor = anchor.parentNode;
    }
    if (!anchor || anchor === state.document ||
        !anchor.isConnected || anchor.hasAttribute('download')) {
      return false;
    }

    let target = anchor.getAttribute('target');
    if (target == null || String(target).trim() === '') {
      const baseTarget = state.document.querySelector('base[target]');
      target = baseTarget ? baseTarget.getAttribute('target') : '';
    }
    target = String(target || '').trim().toLowerCase();
    if (!['', '_self', '_parent', '_top'].includes(target))
      return false;

    let base = String(state.url || 'about:blank');
    const baseElement = state.document.querySelector('base[href]');
    try {
      if (baseElement)
        base = new pircUrlPolyfill.URL(String(baseElement.getAttribute('href') || ''), base).href;
      const href = new pircUrlPolyfill.URL(String(anchor.getAttribute('href') || ''), base);
      return ['http:', 'https:', 'blob:'].includes(href.protocol.toLowerCase());
    } catch (error) {
      return false;
    }
  }

  function removePendingSameWindowNavigation() {
    const state = activeState;
    state.navigationActions = state.navigationActions.filter(action =>
      action.kind === 'history' ||
      (action.kind === 'anchor' && action.download != null) ||
      action.target !== '_self' && action.kind !== 'reload'
    );
  }

  function queueNavigation(value, replace, target, useDocumentBase, metadata) {
    const state = activeState;
    if (!state)
      return false;
    if (target === '_blank' && state.userActivationDepth < 1) {
      diagnostic(
        'navigation.popup_blocked',
        'warning',
        'A new-window navigation requires a host-dispatched user event.',
        { target: target }
      );
      return false;
    }

    const url = resolveNavigationUrl(value, useDocumentBase !== false);
    if (!url)
      return false;
    const actionValue = {
      kind: 'navigate',
      url: url,
      replace: Boolean(replace),
      target: target,
      actionOrder: nextActionOrder()
    };
    if (metadata && metadata.sameDocument === true)
      actionValue.sameDocument = true;
    const action = Object.freeze(actionValue);
    if (target === '_self')
      removePendingSameWindowNavigation();
    state.navigationActions.push(action);
    return true;
  }

  function patchAnchorProperties() {
    Object.defineProperties(HTMLBaseElement.prototype, {
      href: {
        configurable: true, enumerable: true,
        get: function() {
          const value = this.getAttribute('href');
          if (value == null) return '';
          try { return new pircUrlPolyfill.URL(value, activeState?.url || 'about:blank').href; }
          catch (_) { return value; }
        },
        set: function(value) { this.setAttribute('href', String(value)); }
      },
      target: {
        configurable: true, enumerable: true,
        get: function() { return this.getAttribute('target') || ''; },
        set: function(value) { this.setAttribute('target', String(value)); }
      }
    });
    for (const ctor of [HTMLAnchorElement, HTMLAreaElement]) {
      const descriptors = {
        href: {
          configurable: true, enumerable: true,
          get: function() {
            const value = this.getAttribute('href');
            if (value == null) return '';
            try {
              const base = this.ownerDocument === activeState?.document ?
                currentDocumentBaseUrl() : (this.ownerDocument?.baseURI || 'about:blank');
              return new pircUrlPolyfill.URL(value, base).href;
            }
            catch (_) { return value; }
          },
          set: function(value) { this.setAttribute('href', String(value)); }
        },
        referrerPolicy: {
          configurable: true, enumerable: true,
          get: function() {
            const value = asciiLower(this.getAttribute('referrerpolicy') || '');
            return REFERRER_POLICIES.has(value) ? value : '';
          },
          set: function(value) { this.setAttribute('referrerpolicy', String(value)); }
        }
      };
      for (const property of ['download', 'target', 'rel', 'type']) {
        descriptors[property] = {
          configurable: true, enumerable: true,
          get: function() { return this.getAttribute(property) || ''; },
          set: function(value) { this.setAttribute(property, String(value)); }
        };
      }
      Object.defineProperties(ctor.prototype, descriptors);
    }
  }

  function queueAnchorActivation(anchor) {
    const state = activeState;
    // Detached <a> is a deliberate browser compatibility exception. Other
    // hyperlink elements must remain connected to their active document.
    if (!state || anchor.ownerDocument !== state.document ||
        (anchor.localName !== 'a' && !anchor.isConnected) ||
        !anchor.hasAttribute('href')) return;
    let url;
    try { url = new pircUrlPolyfill.URL(anchor.getAttribute('href'), currentDocumentBaseUrl()); }
    catch (_) { navigationDiagnostic('invalid_anchor_url'); return; }
    const protocol = asciiLower(url.protocol);
    let download = anchor.hasAttribute('download') ? anchor.getAttribute('download') : null;
    if (download != null && ['http:', 'https:'].includes(protocol)) {
      let origin = 'null';
      try { origin = new pircUrlPolyfill.URL(state.url).origin; } catch (_) {}
      if (origin === 'null' || origin !== url.origin) download = null;
    }
    if (!['http:', 'https:', 'blob:'].includes(protocol) &&
        !(protocol === 'data:' && download != null)) {
      navigationDiagnostic('unsupported_anchor_scheme'); return;
    }
    let target = anchor.getAttribute('target');
    if (target == null) {
      const base = state.document.querySelector('base[target]');
      target = base ? base.getAttribute('target') : '';
    }
    target = String(target || '');
    if (/[\t\n\r<]/.test(target)) target = '_blank';
    if (['', '_self', '_parent', '_top'].includes(asciiLower(target))) target = '_self';
    if (asciiLower(target) === '_blank') target = '_blank';
    const rel = asciiLower(anchor.getAttribute('rel') || '').split(/[\t\n\f\r ]+/);
    const noreferrer = rel.includes('noreferrer');
    const noopener = noreferrer || rel.includes('noopener') ||
      (target === '_blank' && !rel.includes('opener'));
    if (noopener && target !== '_self') target = '_blank';
    // A download does not choose a browsing context. Native saving still goes
    // through the existing per-file system destination picker, also after await.
    if (download != null) target = '_self';
    if (target !== '_self' && state.userActivationDepth < 1) {
      diagnostic('navigation.popup_blocked', 'warning',
        'A new-window navigation requires a host-dispatched user event.', { target });
      return;
    }
    const action = {
      kind: 'anchor', url: url.href, target, download, replace: false,
      referrerPolicy: noreferrer ? 'no-referrer' :
        (anchor.referrerPolicy || currentDocumentReferrerPolicy()),
      noreferrer, noopener, actionOrder: nextActionOrder()
    };
    if (protocol === 'blob:') {
      try {
        action.capturedBlob = Object.freeze(Object.assign({ ok: true }, state.objectUrls.read(url.href)));
      } catch (_) {
        // Preserve the ordinary unavailable-URL failure in the native consumer.
      }
    }
    if (target === '_self' && download == null) removePendingSameWindowNavigation();
    state.navigationActions.push(Object.freeze(action));
  }

  function queueReload() {
    const state = activeState;
    if (!state)
      return false;
    removePendingSameWindowNavigation();
    state.navigationActions.push(Object.freeze({
      kind: 'reload',
      actionOrder: nextActionOrder()
    }));
    return true;
  }

  function locationValue(property) {
    const parsed = currentLocationUrl();
    if (!parsed) {
      if (property === 'href')
        return activeState ? String(activeState.url || 'about:blank') : 'about:blank';
      if (property === 'origin')
        return 'null';
      return '';
    }
    return property === 'origin' && parsed.origin === 'null'
      ? 'null'
      : parsed[property];
  }

  function setLocationComponent(property, value) {
    const parsed = currentLocationUrl();
    if (!parsed) {
      navigationDiagnostic('invalid_current_url');
      return;
    }
    try {
      const text = String(value);
      // Location.hash retains an empty fragment marker, unlike URL.hash.
      parsed[property] = property === 'hash' && text === '' ? '#' : text;
    } catch (error) {
      navigationDiagnostic('invalid_url');
      return;
    }
    queueNavigation(
      parsed.href,
      false,
      '_self',
      false,
      property === 'hash' ? { sameDocument: true } : null
    );
  }

  function createLocationObject() {
    const location = Object.create(null);
    const properties = {
      href: 'href',
      origin: 'origin',
      protocol: 'protocol',
      host: 'host',
      hostname: 'hostname',
      port: 'port',
      pathname: 'pathname',
      search: 'search',
      hash: 'hash'
    };
    const descriptors = {};
    for (const name of Object.keys(properties)) {
      descriptors[name] = {
        get: function() { return locationValue(properties[name]); },
        enumerable: true
      };
      if (name !== 'origin') {
        descriptors[name].set = name === 'href'
          ? function(value) { queueNavigation(value, false, '_self', true); }
          : function(value) { setLocationComponent(properties[name], value); };
      }
    }
    descriptors.toString = {
      value: function() { return locationValue('href'); }
    };
    descriptors.valueOf = {
      value: function() { return locationValue('href'); }
    };
    descriptors.assign = {
      value: function(value) { queueNavigation(value, false, '_self', true); }
    };
    descriptors.replace = {
      value: function(value) { queueNavigation(value, true, '_self', true); }
    };
    descriptors.reload = { value: queueReload };
    if (typeof Symbol === 'function' && Symbol.toPrimitive) {
      descriptors[Symbol.toPrimitive] = {
        value: function() { return locationValue('href'); }
      };
    }
    Object.defineProperties(location, descriptors);
    return Object.freeze(location);
  }

  function windowOpen(url, target) {
    const hasUrl = arguments.length > 0;
    let requestedTarget;
    try {
      requestedTarget = target == null || String(target).trim() === ''
        ? '_blank'
        : String(target).trim().toLowerCase();
    } catch (error) {
      requestedTarget = '';
    }
    if (requestedTarget !== '_self' && requestedTarget !== '_blank') {
      diagnostic(
        'navigation.window_open_target_unsupported',
        'warning',
        'window.open supports only _self and _blank targets.',
        { target: requestedTarget }
      );
    } else {
      queueNavigation(
        hasUrl ? url : 'about:blank',
        false,
        requestedTarget,
        true
      );
    }
    diagnostic(
      'navigation.window_proxy_unsupported',
      'warning',
      'window.open returns null because WindowProxy objects are unsupported.',
      { target: requestedTarget }
    );
    return null;
  }

  function installGlobalAccessor(name, getter, setter) {
    try {
      Object.defineProperty(globalThis, name, {
        get: getter,
        set: setter,
        configurable: false,
        enumerable: true
      });
      return true;
    } catch (error) {
      diagnostic(
        'runtime.global_install_error',
        'error',
        'Could not install DOM global ' + name + ': ' + exceptionMessage(error),
        { global: name }
      );
      return false;
    }
  }

  function installNavigationGlobals(document) {
    const location = createLocationObject();
    activeState.location = location;
    installGlobalAccessor(
      'location',
      function() { return location; },
      function(value) { queueNavigation(value, false, '_self', true); }
    );
    defineGlobal('open', windowOpen, false);

    try {
      Object.defineProperties(document, {
        location: {
          get: function() { return location; },
          set: function(value) { queueNavigation(value, false, '_self', true); },
          configurable: false,
          enumerable: true
        },
        referrer: {
          get: function() { return activeState.documentReferrer; },
          configurable: false, enumerable: true
        },
        URL: {
          get: function() { return locationValue('href'); },
          configurable: false,
          enumerable: true
        },
        documentURI: {
          get: function() { return locationValue('href'); },
          configurable: false,
          enumerable: true
        }
      });
    } catch (error) {
      diagnostic(
        'navigation.location_install_error',
        'warning',
        'Document location getters could not be installed: ' + exceptionMessage(error)
      );
    }
  }

  function isOwnedNode(node, state) {
    return node === state.document || node.ownerDocument === state.document;
  }

  function ensureElementId(element) {
    const state = activeState;
    let id = state.elementIds.get(element);
    if (!id) {
      id = 'pirc-' + String(state.nextElementId++);
      state.elementIds.set(element, id);
      state.elementsById.set(id, element);
    }
    if (element.getAttribute(MARKER_ATTRIBUTE) !== id)
      element.setAttribute(MARKER_ATTRIBUTE, id);
    return id;
  }

  function clickListenersFor(target) {
    const state = activeState;
    if (state && target === state.window && state.document)
      target = state.document._getParent();
    return state && target ? state.clickListeners.get(target) : null;
  }

  function hasClickListener(target) {
    const listeners = clickListenersFor(target);
    return Boolean(listeners && listeners.size);
  }

  function removeTrackedClickListener(target, listener, record) {
    const listeners = clickListenersFor(target);
    if (!listeners || listeners.get(listener) !== record)
      return;
    listeners.delete(listener);
    if (!listeners.size)
      activeState.clickListeners.delete(target);
  }

  function trackableClickListener(listener) {
    return typeof listener === 'function' ||
      (listener !== null && typeof listener === 'object');
  }

  function listenerIsOnce(options) {
    return Boolean(options && typeof options === 'object' && options.once);
  }

  function patchClickEventHooks() {
    const prototype = DOMEventTarget.prototype;
    const originalAdd = prototype.addEventListener;
    const originalRemove = prototype.removeEventListener;

    prototype.addEventListener = function(type, listener, options) {
      if (type !== 'click' || !trackableClickListener(listener))
        return originalAdd.call(this, type, listener, options);

      const state = activeState;
      if (!state)
        return originalAdd.call(this, type, listener, options);

      let listeners = state.clickListeners.get(this);
      if (!listeners) {
        listeners = new Map();
        state.clickListeners.set(this, listeners);
      }

      let record = listeners.get(listener);
      if (!record) {
        record = { once: listenerIsOnce(options), wrapper: null };
        record.wrapper = function(event) {
          if (record.once)
            removeTrackedClickListener(this, listener, record);
          try {
            if (typeof listener === 'function')
              return listener.call(this, event);
            return listener.handleEvent(event);
          } catch (error) {
            // Listener exceptions are reported, not returned to dispatchEvent;
            // later listeners and the uncanceled activation still run.
            diagnostic('script.click_listener_error', 'error', exceptionMessage(error));
          }
        };
        listeners.set(listener, record);
      }

      // LinkeDOM keys listeners by callback. Reuse the same wrapper for duplicate
      // registrations so removeEventListener and onclick replacement stay exact.
      record.once = listenerIsOnce(options);
      return originalAdd.call(this, type, record.wrapper, options);
    };

    prototype.removeEventListener = function(type, listener) {
      if (type === 'click') {
        const listeners = clickListenersFor(this);
        const record = listeners && listeners.get(listener);
        if (record) {
          const result = originalRemove.call(this, type, record.wrapper);
          removeTrackedClickListener(this, listener, record);
          return result;
        }
      }
      return originalRemove.call(this, type, listener);
    };
  }

  function refreshClickMarker(element) {
    let interactive = hasClickListener(element);
    let ancestor = element.parentNode;
    while (!interactive && ancestor && ancestor !== activeState.document) {
      interactive = hasClickListener(ancestor);
      ancestor = ancestor.parentNode;
    }
    if (!interactive) {
      interactive = hasClickListener(activeState.document) ||
        hasClickListener(activeState.window);
    }
    if (!interactive)
      interactive = isDefaultSummaryTapTarget(element);

    if (interactive) {
      if (!element.hasAttribute(CLICK_MARKER_ATTRIBUTE))
        element.setAttribute(CLICK_MARKER_ATTRIBUTE, '');
    } else if (element.hasAttribute(CLICK_MARKER_ATTRIBUTE)) {
      element.removeAttribute(CLICK_MARKER_ATTRIBUTE);
    }
  }

  function isInteractiveClickElement(element) {
    if (!element || element.nodeType !== 1)
      return false;
    const tag = String(element.localName || '').toLowerCase();
    if (tag === 'a')
      return element.hasAttribute('href');
    return tag === 'button' || tag === 'input' || tag === 'select' ||
      tag === 'textarea' || tag === 'label' ||
      ((tag === 'audio' || tag === 'video') && element.hasAttribute('controls'));
  }

  function defaultSummaryFor(element) {
    let summary = element;
    while (summary && summary !== activeState.document &&
           String(summary.localName || '').toLowerCase() !== 'summary') {
      summary = summary.parentNode;
    }
    if (!summary || summary === activeState.document)
      return null;

    const details = summary.parentNode;
    if (!details || String(details.localName || '').toLowerCase() !== 'details')
      return null;

    let firstSummary = null;
    for (const child of details.children || []) {
      if (String(child.localName || '').toLowerCase() === 'summary') {
        firstSummary = child;
        break;
      }
    }
    return firstSummary === summary ? summary : null;
  }

  function isDefaultSummaryTapTarget(element) {
    const summary = defaultSummaryFor(element);
    if (!summary)
      return false;
    let current = element;
    while (current && current !== summary) {
      if (isInteractiveClickElement(current))
        return false;
      current = current.parentNode;
    }
    return current === summary;
  }

  function toggleDetailsForClickTarget(element) {
    let summary = element;
    while (summary && summary !== activeState.document &&
           String(summary.localName || '').toLowerCase() !== 'summary') {
      if (isInteractiveClickElement(summary))
        return;
      summary = summary.parentNode;
    }
    if (!summary || summary === activeState.document)
      return;

    const details = summary.parentNode;
    if (!details || String(details.localName || '').toLowerCase() !== 'details' ||
        defaultSummaryFor(element) !== summary)
      return;

    let current = element;
    while (current && current !== summary) {
      if (isInteractiveClickElement(current))
        return;
      current = current.parentNode;
    }
    if (current !== summary)
      return;

    if (details.hasAttribute('open')) {
      details.removeAttribute('open');
      return;
    }

    details.setAttribute('open', '');
  }

  // Low-level Attr/insertion reactions run after mutation records are queued,
  // including setAttributeNode, Attr.value, fragments and parser insertions.
  const detailsSeen = new WeakSet();
  const detailsToggleTasks = new WeakMap();
  const dialogEventHandlerTypes = new Set(['toggle', 'beforetoggle', 'cancel', 'close']);
  const dialogEventHandlers = new WeakMap();

  class PircToggleEvent extends GlobalEvent {
    constructor(type, init) {
      const options = init == null ? {} : Object(init);
      super(type, options);
      for (const key of ['oldState', 'newState']) {
        if (typeof options[key] === 'symbol') throw new TypeError('Cannot convert a Symbol to a string');
        defineEventMember(this, key, options[key] === undefined ? '' : String(options[key]));
      }
      defineEventMember(this, 'source', options.source == null ? null : options.source);
    }
    preventDefault() { if (this.cancelable) super.preventDefault(); }
  }

  function isOwnedDetails(element) {
    return activeState && activeState.document && !activeState.cloningSnapshot && element &&
      element.ownerDocument === activeState.document && element.localName === 'details';
  }

  function queueDetailsToggle(element, oldState, newState) {
    const state = activeState;
    const previous = detailsToggleTasks.get(element);
    if (previous) {
      oldState = previous.oldState;
      state.timers.delete(previous.id);
    }
    const task = {oldState, newState, id: 0};
    task.id = scheduleTimer('timeout', function() {
      if (activeState !== state) return;
      // Author writes in a toggle handler begin a new notification task.
      if (detailsToggleTasks.get(element) === task) detailsToggleTasks.delete(element);
      const event = new PircToggleEvent('toggle', {oldState: task.oldState, newState: task.newState});
      defineEventMember(event, 'isTrusted', true);
      element.dispatchEvent(event);
    }, 0, []);
    if (task.id) detailsToggleTasks.set(element, task);
    else detailsToggleTasks.delete(element);
  }

  function detailsGroupPeers(element) {
    const name = element.getAttribute('name');
    if (!name) return [];
    const root = element.getRootNode();
    const candidates = Array.from(root.querySelectorAll('details[name]'));
    if (root.localName === 'details') candidates.unshift(root);
    return candidates.filter(candidate => candidate !== element &&
      candidate.getAttribute('name') === name && candidate.hasAttribute('open'));
  }

  function closeInsertedDetailsIfNeeded(element) {
    if (element.hasAttribute('open') && detailsGroupPeers(element).length)
      element.removeAttribute('open');
  }

  function detailsAttributeChanged(element, name, oldValue, newValue) {
    if (!isOwnedDetails(element)) return;
    detailsSeen.add(element);
    if (name === 'open' && (oldValue === null) !== (newValue === null)) {
      queueDetailsToggle(element, oldValue === null ? 'closed' : 'open', newValue === null ? 'closed' : 'open');
      if (newValue !== null) {
        for (const peer of detailsGroupPeers(element)) peer.removeAttribute('open');
      }
    } else if (name === 'name') closeInsertedDetailsIfNeeded(element);
  }

  function initializeDetails(root, initialDocument) {
    const nodes = Array.from(root.querySelectorAll?.('details') || []);
    if (root.localName === 'details') nodes.unshift(root);
    const initialGroups = new Map();
    for (const element of nodes) {
      if (!isOwnedDetails(element)) continue;
      if (!detailsSeen.has(element)) {
        detailsSeen.add(element);
        if (element.hasAttribute('open')) queueDetailsToggle(element, 'closed', 'open');
      }
      if (!element.hasAttribute('open')) continue;
      if (initialDocument) {
        const name = element.getAttribute('name');
        if (name && initialGroups.has(name)) element.removeAttribute('open');
        else if (name) initialGroups.set(name, element);
      } else closeInsertedDetailsIfNeeded(element);
    }
  }

  // Event-handler attributes and IDL properties share one listener slot. Replacing
  // its callback preserves registration order, including during event dispatch.
  function setDialogEventHandler(element, type, callback) {
    let handlers = dialogEventHandlers.get(element);
    if (!handlers) {
      handlers = new Map();
      dialogEventHandlers.set(element, handlers);
    }
    const previous = handlers.get(type);
    if (typeof callback !== 'function') {
      if (previous) element.removeEventListener(type, previous.listener);
      handlers.delete(type);
      return;
    }
    if (previous) {
      previous.callback = callback;
      return;
    }
    const record = {callback, listener: null};
    record.listener = function(event) {
      try {
        if (record.callback.call(element, event) === false && event.cancelable)
          event.preventDefault();
      } catch (error) {
        diagnostic('script.' + type + '_handler_error', 'error', exceptionMessage(error));
      }
    };
    handlers.set(type, record);
    element.addEventListener(type, record.listener);
  }

  Object.defineProperties(HTMLDetailsElement.prototype, {
    open: {configurable: true, enumerable: true,
      get() { return this.hasAttribute('open'); },
      set(value) { this.toggleAttribute('open', Boolean(value)); }},
    name: {configurable: true, enumerable: true,
      get() { return this.getAttribute('name') || ''; },
      set(value) {
        if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol to a string');
        this.setAttribute('name', String(value));
      }}
  });
  for (const type of dialogEventHandlerTypes) {
    Object.defineProperty(HTMLElement.prototype, 'on' + type, {
      configurable: true, enumerable: true,
      get() { return dialogEventHandlers.get(this)?.get(type)?.callback || null; },
      set(value) { setDialogEventHandler(this, type, value); }
    });
  }
  pircDetailsReactions = {
    attributeChanged(element, name, oldValue, newValue) {
      detailsAttributeChanged(element, name, oldValue, newValue);
      if (activeState && !activeState.cloningSnapshot &&
          element.ownerDocument === activeState.document &&
          String(name).startsWith('on') &&
          dialogEventHandlerTypes.has(String(name).slice(2))) {
        if (newValue === null) removeInlineHandler(element, name);
        else installInlineHandler(element, name, newValue, true);
      }
      if (name === 'open' && oldValue !== null && newValue === null)
        cleanupDocumentDialog(element);
    },
    inserted: root => initializeDetails(root, false),
    removed: root => documentDialogTreeRemoved(root)
  };

  // Dialog closing is local DOM state, never a navigation request. Modal display
  // still requires a native top layer; do not emulate it as a div.
  const dialogReturnValues = new WeakMap();
  const closingDialogs = new WeakSet();
  const dialogCloseRequests = new WeakMap();
  const dialogCloseEpochs = new WeakMap();
  const dialogPreviousFocus = new WeakMap();
  class PircHTMLDialogElement extends HTMLElement {
    constructor(ownerDocument, localName = 'dialog') {
      if (!ownerDocument) throw new TypeError('Illegal constructor');
      super(ownerDocument, localName);
    }
    get open() { return this.hasAttribute('open'); }
    set open(value) { this.toggleAttribute('open', Boolean(value)); }
    get returnValue() { return dialogReturnValues.get(this) || ''; }
    set returnValue(value) {
      if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol to a string');
      dialogReturnValues.set(this, String(value));
    }
    show() { return showDocumentDialog(this); }
    showModal() { return showModalDocumentDialog(this); }
    close(value) { return closeDocumentDialog(this, value); }
    requestClose(value) { return requestCloseDocumentDialog(this, value); }
  }

  function showDocumentDialog(element) {
    if (!(element instanceof PircHTMLDialogElement)) throw new TypeError('Illegal invocation');
    if (activeState?.modalDialogs.includes(element)) {
      throw pickerException('InvalidStateError',
        "The dialog is already open as a modal dialog, and therefore cannot be opened as a non-modal dialog.");
    }
    if (element.hasAttribute('open')) return;
    openDocumentDialog(element, false);
  }

  function showModalDocumentDialog(element) {
    if (!(element instanceof PircHTMLDialogElement)) throw new TypeError('Illegal invocation');
    const state = activeState;
    if (!state || !element.isConnected || element.ownerDocument !== state.document) {
      throw pickerException('InvalidStateError', 'The element is not in a Document.');
    }
    if (element.hasAttribute('open')) {
      if (state.modalDialogs.includes(element)) return;
      throw pickerException('InvalidStateError',
        "The dialog is already open as a non-modal dialog, and therefore cannot be opened as a modal dialog.");
    }
    openDocumentDialog(element, true);
  }

  function openDocumentDialog(element, modal) {
    const before = new PircToggleEvent('beforetoggle', {
      oldState: 'closed', newState: 'open', cancelable: true
    });
    defineEventMember(before, 'isTrusted', true);
    if (!element.dispatchEvent(before) || element.hasAttribute('open')) return;
    if (modal && (!activeState || !element.isConnected ||
        element.ownerDocument !== activeState.document)) return;
    queueDetailsToggle(element, 'closed', 'open');
    const state = activeState;
    if (modal && state) state.modalDialogs.push(element);
    element.setAttribute('open', '');
    dialogPreviousFocus.set(element, state ? state.activeElement : null);
    if (!state || !element.isConnected || element.ownerDocument !== state.document) return;
    // Chromium 153 delegates to an eligible autofocus descendant first, then
    // the first focusable descendant, and finally to the dialog itself.
    const candidates = Array.from(element.querySelectorAll('*'))
      .filter(candidate => isFocusableHTMLElement(candidate, state));
    const control = candidates.find(candidate => candidate.hasAttribute('autofocus')) ||
      candidates[0] || element;
    if (isFocusableHTMLElement(control, state)) focusElement(control);
    else if (state.activeElement) blurElement(state.activeElement);
  }

  function isOwnedDialog(element) {
    const state = activeState;
    return state && !state.cloningSnapshot && element instanceof PircHTMLDialogElement &&
      element.ownerDocument === state.document;
  }

  function cleanupDocumentDialog(element) {
    if (!isOwnedDialog(element)) return;
    const state = activeState;
    const modalIndex = state.modalDialogs.indexOf(element);
    if (modalIndex >= 0) state.modalDialogs.splice(modalIndex, 1);
    dialogCloseEpochs.set(element, (dialogCloseEpochs.get(element) || 0) + 1);
    if (closingDialogs.has(element)) return;
    dialogPreviousFocus.delete(element);
    const focused = state.activeElement;
    if (focused && isInside(focused, element)) {
      // As with close(), hidden focus is dropped at a later rendering opportunity.
      scheduleTimer('timeout', () => {
        if (activeState === state && state.activeElement === focused &&
            !isFocusableHTMLElement(focused, state)) blurElement(focused);
      }, 0, []);
    }
  }

  function documentDialogTreeRemoved(root) {
    const state = activeState;
    if (!state || state.cloningSnapshot || !isOwnedNode(root, state)) return;
    for (const dialog of [root, ...Array.from(root.querySelectorAll?.('dialog') || [])]) {
      if (!isOwnedDialog(dialog)) continue;
      const modalIndex = state.modalDialogs.indexOf(dialog);
      if (modalIndex >= 0) state.modalDialogs.splice(modalIndex, 1);
      dialogCloseEpochs.set(dialog, (dialogCloseEpochs.get(dialog) || 0) + 1);
      dialogPreviousFocus.delete(dialog);
    }
    // A removed focus target must not regain focus just because its DOM subtree
    // is synchronously reinserted. Native widgets also retire their old target.
    const focused = state.activeElement;
    if (focused && isInside(focused, root)) {
      state.activeElement = null;
      state.focusTransitionVersion++;
      emitScriptFocusAction('blur', focused, false);
    }
  }

  function requestCloseDocumentDialog(element, value) {
    if (!(element instanceof PircHTMLDialogElement)) throw new TypeError('Illegal invocation');
    let converted;
    if (value !== undefined) {
      if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol to a string');
      converted = String(value);
    }
    const state = activeState;
    if (!element.hasAttribute('open') || !element.isConnected || !state ||
        element.ownerDocument !== state.document) return;
    let request = dialogCloseRequests.get(element);
    if (!request) {
      request = {dispatching: false, enabled: false, value: undefined};
      dialogCloseRequests.set(element, request);
    }
    request.value = converted;
    request.enabled = true;
    if (request.dispatching) {
      // The nested method's force-enable lifetime ends before the outer watcher
      // resumes. Nonmodal closedby=none then disables its close action again.
      request.enabled = false;
      return;
    }
    request.dispatching = true;
    const epoch = dialogCloseEpochs.get(element) || 0;
    try {
      const cancel = new GlobalEvent('cancel', {bubbles: false, cancelable: true});
      defineEventMember(cancel, 'isTrusted', true);
      const accepted = element.dispatchEvent(cancel);
      const closedBy = String(element.getAttribute('closedby') || '').toLowerCase();
      if (accepted && activeState === state && element.isConnected &&
          (dialogCloseEpochs.get(element) || 0) === epoch &&
          (request.enabled || closedBy === 'any' || closedBy === 'closerequest'))
        closeDocumentDialog(element, request.value);
    } finally {
      request.dispatching = false;
      request.enabled = false;
      dialogCloseRequests.delete(element);
    }
  }

  function closeDocumentDialog(element, value) {
    if (!(element instanceof PircHTMLDialogElement)) throw new TypeError('Illegal invocation');
    let converted;
    if (value !== undefined) {
      if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol to a string');
      converted = String(value);
    }
    if (!element.hasAttribute('open') || closingDialogs.has(element)) return;
    const state = activeState;
    closingDialogs.add(element);
    try {
      const before = new PircToggleEvent('beforetoggle', {oldState: 'open', newState: 'closed'});
      defineEventMember(before, 'isTrusted', true);
      element.dispatchEvent(before);
      if (!element.hasAttribute('open')) return;
      element.removeAttribute('open');
      if (state) {
        const modalIndex = state.modalDialogs.indexOf(element);
        if (modalIndex >= 0) state.modalDialogs.splice(modalIndex, 1);
      }
      if (converted !== undefined) dialogReturnValues.set(element, converted);
      queueDetailsToggle(element, 'open', 'closed');
      const previouslyFocused = dialogPreviousFocus.get(element);
      dialogPreviousFocus.delete(element);
      if (previouslyFocused && state && state.activeElement && isInside(state.activeElement, element)) {
        // Call the internal focusing algorithm, never an author-replaced .focus.
        focusElement(previouslyFocused, {preventScroll: true});
      }
      const hiddenFocus = state && state.activeElement;
      scheduleTimer('timeout', () => {
        if (activeState !== state) return;
        const event = new GlobalEvent('close', {bubbles: false, cancelable: false});
        defineEventMember(event, 'isTrusted', true);
        element.dispatchEvent(event);
        // With no eligible restoration target, Chromium drops hidden focus at
        // a later rendering opportunity, after the close notification.
        if (activeState === state && state.activeElement === hiddenFocus &&
            hiddenFocus && !isFocusableHTMLElement(hiddenFocus, state)) {
          blurElement(hiddenFocus);
        }
      }, 0, []);
    } finally {
      closingDialogs.delete(element);
    }
  }

  function HTMLDialogElement() { throw new TypeError('Illegal constructor'); }
  Object.defineProperty(HTMLDialogElement, 'prototype', {value: PircHTMLDialogElement.prototype, writable: false});
  Object.defineProperty(PircHTMLDialogElement.prototype, 'constructor', {value: HTMLDialogElement, writable: true, configurable: true});

  function registerTree(root) {
    const state = activeState;
    if (!state || !state.document || !root || !isOwnedNode(root, state))
      return;

    const stack = [root];
    const fresh = [];
    while (stack.length) {
      const node = stack.pop();
      if (!node || !isOwnedNode(node, state))
        continue;
      if (!state.trackedNodes.has(node))
        fresh.push(node);
      const children = node.childNodes;
      if (children) {
        for (let index = children.length - 1; index >= 0; index--)
          stack.push(children[index]);
      }
    }

    if (state.trackedNodeCount + fresh.length > MAX_DOM_NODES) {
      diagnostic(
        'runtime.node_limit',
        'error',
        'The document script runtime supports at most ' + MAX_DOM_NODES + ' DOM nodes.'
      );
      throw new Error('document script runtime node limit exceeded');
    }

    for (const node of fresh) {
      state.trackedNodes.add(node);
      state.trackedNodeCount += 1;
    }
  }

  function removeInlineHandler(element, attributeName) {
    const state = activeState;
    if (!state)
      return;
    const handlers = state.inlineHandlers.get(element);
    if (!handlers)
      return;
    const key = String(attributeName).toLowerCase();
    const previous = handlers.get(key);
    if (key === 'onformdata')
      setFormDataHandler(element, null);
    if (dialogEventHandlerTypes.has(key.slice(2)))
      setDialogEventHandler(element, key.slice(2), null);
    if (previous) {
      if (previous.listener)
        element.removeEventListener(previous.type, previous.listener);
      handlers.delete(key);
    }
  }

  function installInlineHandler(element, attributeName, source, attributeChanged) {
    const state = activeState;
    if (!state || !isOwnedNode(element, state))
      return;

    const key = String(attributeName).toLowerCase();
    if (key.slice(0, 2) !== 'on' || key.length < 3)
      return;
    if (key === 'onclick' && state.onclickPropertyOverrides.has(element))
      return;
    if (state.pointerPropertyHandlers.get(element)?.has(key) ||
        state.imagePropertyOverrides.get(element)?.has(key))
      return;

    const eventType = key.slice(2);
    const code = String(source);
    let handlers = state.inlineHandlers.get(element);
    if (!handlers) {
      handlers = new Map();
      state.inlineHandlers.set(element, handlers);
    }
    const previous = handlers.get(key);
    if (previous && previous.code === code &&
        (!(key === 'onformdata' || dialogEventHandlerTypes.has(eventType)) || !attributeChanged))
      return;
    if (previous && previous.listener)
      element.removeEventListener(previous.type, previous.listener);

    let handler;
    try {
      handler = new Function('event', rewriteClassicImports(code, null, true));
    } catch (error) {
      diagnostic(
        'script.inline_handler_compile_error',
        'error',
        exceptionMessage(error),
        { attribute: key }
      );
      handlers.delete(key);
      if (key === 'onformdata')
        setFormDataHandler(element, null);
      if (dialogEventHandlerTypes.has(eventType))
        setDialogEventHandler(element, eventType, null);
      return;
    }

    if (dialogEventHandlerTypes.has(eventType)) {
      setDialogEventHandler(element, eventType, handler);
      handlers.set(key, {type: eventType, code: code, listener: null});
      return;
    }

    if (key === 'onformdata') {
      setFormDataHandler(element, handler);
      // Retain the attribute source so a later tree decoration does not
      // overwrite a handler assigned through the IDL property.
      handlers.set(key, { type: eventType, code: code, listener: null });
      return;
    }

    const listener = function(event) {
      try {
        const result = handler.call(element, event);
        if (result === false && event && event.cancelable)
          event.preventDefault();
      } catch (error) {
        diagnostic(
          'script.inline_handler_runtime_error',
          'error',
          exceptionMessage(error),
          { attribute: key }
        );
      }
    };
    element.addEventListener(eventType, listener);
    handlers.set(key, { type: eventType, code: code, listener: listener });
  }

  function setFormDataHandler(element, callback) {
    const state = activeState;
    if (!state || element.ownerDocument !== state.document)
      return;
    const previous = state.formDataHandlers.get(element);
    if (typeof callback !== 'function') {
      if (previous)
        element.removeEventListener('formdata', previous.listener);
      state.formDataHandlers.delete(element);
      return;
    }
    if (previous) {
      // Replacing a non-null property keeps the existing listener position.
      previous.callback = callback;
      return;
    }
    const record = { callback: callback, listener: null };
    record.listener = function(event) {
      try {
        record.callback.call(element, event);
      } catch (error) {
        diagnostic('script.event_handler_runtime_error', 'error',
          exceptionMessage(error), { attribute: 'onformdata' });
      }
    };
    state.formDataHandlers.set(element, record);
    element.addEventListener('formdata', record.listener);
  }

  function patchFormDataProperty() {
    Object.defineProperty(HTMLElement.prototype, 'onformdata', {
      configurable: true,
      enumerable: true,
      get: function() {
        const record = activeState && activeState.formDataHandlers.get(this);
        return record ? record.callback : null;
      },
      set: function(value) { setFormDataHandler(this, value); }
    });
  }

  function clearOnclickPropertyOverride(element) {
    const state = activeState;
    if (!state || !state.onclickPropertyOverrides.has(element))
      return;
    state.onclickPropertyOverrides.delete(element);
    state.onclickPropertyHandlers.delete(element);
    if (originalOnclickDescriptor && originalOnclickDescriptor.set)
      originalOnclickDescriptor.set.call(element, null);
  }

  function patchOnclickProperty() {
    originalOnclickDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'onclick'
    );
    if (!originalOnclickDescriptor || !originalOnclickDescriptor.get ||
        !originalOnclickDescriptor.set)
      return;

    Object.defineProperty(HTMLElement.prototype, 'onclick', {
      configurable: originalOnclickDescriptor.configurable,
      enumerable: originalOnclickDescriptor.enumerable,
      get: function() {
        const state = activeState;
        if (state && this.ownerDocument === state.document &&
            state.onclickPropertyOverrides.has(this)) {
          return state.onclickPropertyHandlers.get(this) || null;
        }
        return originalOnclickDescriptor.get.call(this);
      },
      set: function(value) {
        const state = activeState;
        if (!state || this.ownerDocument !== state.document) {
          originalOnclickDescriptor.set.call(this, value);
          return;
        }

        removeInlineHandler(this, 'onclick');
        state.onclickPropertyOverrides.add(this);
        if (value)
          state.onclickPropertyHandlers.set(this, value);
        else
          state.onclickPropertyHandlers.delete(this);

        let linkedomHandler = value;
        if (typeof value === 'function') {
          linkedomHandler = function(event) {
            const result = value.call(this, event);
            if (result === false && event && event.cancelable)
              event.preventDefault();
            return result;
          };
        }
        originalOnclickDescriptor.set.call(this, linkedomHandler);
      }
    });
  }

  const pointerHandlerNames = [
    'onpointerdown', 'onpointermove', 'onpointerup', 'onpointercancel',
    'onpointerover', 'onpointerout', 'onpointerenter', 'onpointerleave',
    'ongotpointercapture', 'onlostpointercapture',
    'onmousedown', 'onmousemove', 'onmouseup', 'onmouseover', 'onmouseout',
    'onmouseenter', 'onmouseleave'
  ];

  function clearPointerPropertyOverride(element, name) {
    const records = activeState?.pointerPropertyHandlers.get(element);
    const record = records?.get(name);
    if (!record) return;
    if (record.listener) element.removeEventListener(name.slice(2), record.listener);
    records.delete(name);
  }

  function patchPointerHandlerProperties() {
    for (const name of pointerHandlerNames) {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        enumerable: true,
        get: function() {
          const state = activeState;
          const records = state?.pointerPropertyHandlers.get(this);
          return records?.get(name)?.value ?? original?.get?.call(this) ?? null;
        },
        set: function(value) {
          const state = activeState;
          if (!state || this.ownerDocument !== state.document) {
            original?.set?.call(this, value);
            return;
          }
          removeInlineHandler(this, name);
          clearPointerPropertyOverride(this, name);
          original?.set?.call(this, null);
          let records = state.pointerPropertyHandlers.get(this);
          if (!records) {
            records = new Map();
            state.pointerPropertyHandlers.set(this, records);
          }
          const callback = typeof value === 'function' ? value : null;
          const listener = callback && function(event) {
            try {
              if (callback.call(this, event) === false && event.cancelable)
                event.preventDefault();
            } catch (error) {
              diagnostic('script.pointer_handler_error', 'error', exceptionMessage(error));
            }
          };
          records.set(name, {value: callback, listener: listener});
          if (listener) this.addEventListener(name.slice(2), listener);
        }
      });
    }
  }

  function decorateTree(root) {
    const state = activeState;
    if (!state || !root || !isOwnedNode(root, state))
      return;
    registerTree(root);

    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || !isOwnedNode(node, state))
        continue;
      if (node.nodeType === 1) {
        ensureElementId(node);
        refreshClickMarker(node);
        const attributes = node.attributes || [];
        for (let index = 0; index < attributes.length; index++) {
          const attribute = attributes[index];
          if (attribute && attribute.name &&
              attribute.name.toLowerCase().slice(0, 2) === 'on') {
            installInlineHandler(node, attribute.name, attribute.value);
          }
        }
      }
      const children = node.childNodes;
      if (children) {
        for (let index = children.length - 1; index >= 0; index--)
          stack.push(children[index]);
      }
    }
  }

  function defineGlobal(name, value, writable) {
    try {
      Object.defineProperty(globalThis, name, {
        value: value,
        writable: writable === true,
        configurable: false,
        enumerable: true
      });
      return true;
    } catch (error) {
      try {
        globalThis[name] = value;
        return globalThis[name] === value;
      } catch (ignored) {
        diagnostic(
          'runtime.global_install_error',
          'error',
          'Could not install DOM global ' + name + ': ' + exceptionMessage(error),
          { global: name }
        );
        return false;
      }
    }
  }

  function unavailableFunction(api, category) {
    return function() {
      const message = api + ' is unavailable in the document script runtime.';
      diagnostic(
        'runtime.api_unavailable',
        'error',
        message,
        { api: api, category: category }
      );
      throw new Error(message);
    };
  }

  function unavailableObject(api, category) {
    const fail = unavailableFunction(api, category);
    return new Proxy(Object.create(null), {
      get: function() { return fail(); },
      set: function() { return fail(); },
      has: function() { return fail(); },
      ownKeys: function() { return fail(); },
      getOwnPropertyDescriptor: function() { return fail(); }
    });
  }

  function schedulerSnapshot() {
    const state = activeState;
    if (!state)
      return { timerDelayMs: null, animationFrame: false };

    let earliest = (state.classicScriptTasks.length || state.nativeAnimationFrame || layoutNeedsUpdate()) ? state.now :
      state.modulePreparations > 0 ? state.now + 16 : Infinity;
    for (const timer of state.timers.values())
      if (timer.due < earliest) earliest = timer.due;

    return {
      timerDelayMs: earliest === Infinity ? null : Math.max(0, earliest - state.now),
      animationFrame: state.animationFrames.size > 0 || Boolean(state.resizeObservers?.pending())
    };
  }

  function advanceClock(value) {
    const state = activeState;
    if (!state || typeof value !== 'number' || !Number.isFinite(value))
      return state ? state.now : 0;
    state.now = Math.max(state.now, Math.max(0, value));
    return state.now;
  }

  function pendingCallbackCount(state) {
    return state.timers.size + state.animationFrames.size;
  }

  function callbackLimitReached(state) {
    if (pendingCallbackCount(state) < MAX_PENDING_CALLBACKS)
      return false;
    diagnostic(
      'scheduler.pending_limit',
      'error',
      'The document script runtime supports at most ' + MAX_PENDING_CALLBACKS + ' pending timer and animation callbacks.',
      { limit: MAX_PENDING_CALLBACKS }
    );
    return true;
  }

  function normalizedTimerDelay(delayValue) {
    const number = Number(delayValue);
    if (!Number.isFinite(number) || number === 0)
      return 0;
    const integer = Math.trunc(number);
    const modulo = ((integer % 4294967296) + 4294967296) % 4294967296;
    const signedLong = modulo >= 2147483648 ? modulo - 4294967296 : modulo;
    return Math.max(0, signedLong);
  }

  function timerDelay(baseDelay, currentNesting) {
    return currentNesting > 5 ? Math.max(4, baseDelay) : baseDelay;
  }

  function scheduleTimer(kind, callback, delayValue, args) {
    const state = activeState;
    if (!state)
      return 0;

    const currentNesting = state.currentTimerNesting == null
      ? 0
      : state.currentTimerNesting;
    if (callbackLimitReached(state))
      return 0;

    const baseDelay = normalizedTimerDelay(delayValue);
    const delay = timerDelay(baseDelay, currentNesting);
    const nesting = currentNesting + 1;
    const id = state.nextTaskId++;
    const timer = {
      id: id,
      kind: kind,
      callback: callback,
      args: args,
      baseDelay: baseDelay,
      delay: delay,
      due: state.now + delay,
      nesting: nesting
    };
    state.timers.set(id, timer);
    return id;
  }

  function scheduleAnimationFrame(callback) {
    const state = activeState;
    if (!state)
      return 0;
    if (typeof callback !== 'function') {
      diagnostic(
        'scheduler.invalid_animation_callback',
        'error',
        'requestAnimationFrame requires a function callback.'
      );
      return 0;
    }
    if (callbackLimitReached(state))
      return 0;

    const id = state.nextTaskId++;
    state.animationFrames.set(id, { id: id, callback: callback });
    return id;
  }

  function cancelTask(collection, handle) {
    const numericHandle = Number(handle);
    if (!Number.isFinite(numericHandle))
      return;
    collection.delete(numericHandle);
  }

  function invokeScheduledCallback(callback, args, detail, thisValue) {
    try {
      if (typeof callback === 'function') {
        Reflect.apply(callback, thisValue, args);
      } else {
        (0, eval)(String(callback));
      }
    } catch (error) {
      const fields = detail && typeof detail === 'object' ? detail : {};
      diagnostic(
        'scheduler.callback_error',
        'error',
        exceptionMessage(error),
        fields
      );
    }
  }

  function installSchedulerGlobals(view) {
    const setTimeoutFunction = function(callback, delay) {
      return scheduleTimer(
        'timeout',
        callback,
        delay,
        Array.prototype.slice.call(arguments, 2)
      );
    };
    const clearTimeoutFunction = function(handle) {
      if (activeState) cancelTask(activeState.timers, handle);
    };
    const setIntervalFunction = function(callback, delay) {
      return scheduleTimer(
        'interval',
        callback,
        delay,
        Array.prototype.slice.call(arguments, 2)
      );
    };
    const clearIntervalFunction = clearTimeoutFunction;
    const requestAnimationFrameFunction = function(callback) {
      return scheduleAnimationFrame(callback);
    };
    const cancelAnimationFrameFunction = function(handle) {
      if (activeState) cancelTask(activeState.animationFrames, handle);
    };
    const performanceObject = Object.freeze({
      now: function() { return activeState ? activeState.now : 0; },
      get timeOrigin() { return activeState ? activeState.timeOrigin : 0; }
    });
    const globals = [
      ['setTimeout', setTimeoutFunction],
      ['clearTimeout', clearTimeoutFunction],
      ['setInterval', setIntervalFunction],
      ['clearInterval', clearIntervalFunction],
      ['requestAnimationFrame', requestAnimationFrameFunction],
      ['cancelAnimationFrame', cancelAnimationFrameFunction],
      ['performance', performanceObject]
    ];
    for (const entry of globals) {
      defineGlobal(entry[0], entry[1], false);
      try {
        Object.defineProperty(view, entry[0], {
          value: entry[1],
          writable: false,
          configurable: false,
          enumerable: true
        });
      } catch (error) {
        try {
          view[entry[0]] = entry[1];
        } catch (ignored) {
          diagnostic(
            'runtime.global_install_error',
            'error',
            'Could not install DOM global ' + entry[0] + ': ' + exceptionMessage(error),
            { global: entry[0] }
          );
        }
      }
    }
  }

  function installUnavailableGlobals(document) {
    const functionApis = [
      ['WebSocket', 'network'],
      ['EventSource', 'network'],
      ['Worker', 'workers'],
      ['SharedWorker', 'workers'],
      ['importScripts', 'workers'],
      ['alert', 'dialogs'],
      ['confirm', 'dialogs'],
      ['prompt', 'dialogs'],
      ['print', 'navigation'],
      ['showOpenFilePicker', 'files'],
      ['showSaveFilePicker', 'files'],
      ['showDirectoryPicker', 'files']
    ];
    for (const entry of functionApis)
      defineGlobal(entry[0], unavailableFunction(entry[0], entry[1]), false);

    const objectApis = [
      ['indexedDB', 'storage'],
      ['caches', 'storage']
    ];
    for (const entry of objectApis)
      defineGlobal(entry[0], unavailableObject(entry[0], entry[1]), false);

    installNavigationGlobals(document);
    defineGlobal('navigator', Object.freeze({
      userAgent: 'PIRC document script runtime'
    }), false);

    activeState.cookies = createPircDocumentCookies({
      getUrl: () => activeState.url,
      utf8ByteLength,
      diagnostic
    });
    activeState.cookies.install(document, activeState.initialCookieState);

    for (const method of ['write', 'writeln', 'open', 'close']) {
      try {
        Object.defineProperty(document, method, {
          value: unavailableFunction('document.' + method, 'document-stream'),
          writable: false,
          configurable: false
        });
      } catch (ignored) {
        // LinkeDOM does not implement these methods by default.
      }
    }
  }

  // Live values are separate from content attributes: native edits must not
  // overwrite the defaults later consumed by the browser's reset algorithm.
  const liveValues = new WeakMap();
  const liveChecked = new WeakMap();
  const liveIndeterminate = new WeakMap();
  const liveSelected = new WeakMap();
  const emptySelects = new WeakSet();
  const fileSelections = new WeakMap();
  const fileHostSnapshots = new WeakMap();
  const constructingFormData = new WeakSet();
  const fileResetVersions = new WeakMap();
  const resettingForms = new WeakSet();
  const firingSubmissionEvents = new WeakSet();
  const userInputState = new WeakMap();
  let documentFormValidation = null;

  function formOwner(control) {
    if (control.hasAttribute('form')) {
      const owner = control.ownerDocument.getElementById(control.getAttribute('form'));
      return owner && owner.localName === 'form' ? owner : null;
    }
    return control.parentElement ? control.parentElement.closest('form') : null;
  }

  function queueInvalidAction(control, message) {
    if (!activeState || !control)
      return;
    const form = formOwner(control);
    activeState.formActions.push({
      kind: 'invalid',
      formId: form ? ensureElementId(form) : '',
      controlId: ensureElementId(control),
      message: String(message || '')
    });
  }

  function queueSubmissionAction(form, submitter) {
    const resolved = submitterForForm(form, submitter);
    const method = resolved !== form && resolved.hasAttribute('formmethod')
      ? resolved.getAttribute('formmethod') : form.getAttribute('method');
    if (normalizedMethod(method) === 'dialog') {
      const dialog = form.closest('dialog');
      if (dialog instanceof PircHTMLDialogElement) {
        const value = resolved === form ? '' :
          resolved.localName === 'input' && normalizedInputType(resolved) === 'image' ? '0,0' : String(resolved.value || '');
        closeDocumentDialog(dialog, value);
      }
      return true;
    }
    const command = createSubmissionAction(form, submitter);
    if (!command)
      return false;
    command.actionOrder = nextActionOrder();
    // HTML keeps one planned navigation per form. The host receives the same
    // last accepted command after it coalesces commands from microtask snapshots.
    activeState.formActions = activeState.formActions.filter(action =>
      action.kind !== 'submit' || action.formId !== command.formId
    );
    activeState.formActions.push(command);
    return true;
  }

  function normalizedInputType(input) {
    const type = String(input.getAttribute('type') || 'text').trim().toLowerCase();
    const supported = new Set([
      'hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date',
      'month', 'week', 'time', 'datetime-local', 'number', 'range', 'color',
      'checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button'
    ]);
    return supported.has(type) ? type : 'text';
  }

  function normalizedButtonType(button) {
    const type = String(button.getAttribute('type') || 'submit').trim().toLowerCase();
    return type === 'reset' || type === 'button' ? type : 'submit';
  }

  function isSubmitButton(element) {
    if (!element || element.nodeType !== 1)
      return false;
    const tag = String(element.localName || '').toLowerCase();
    return (tag === 'button' && normalizedButtonType(element) === 'submit') ||
      (tag === 'input' && ['submit', 'image'].includes(normalizedInputType(element)));
  }

  function isResetButton(element) {
    if (!element || element.nodeType !== 1)
      return false;
    const tag = String(element.localName || '').toLowerCase();
    return (tag === 'button' && normalizedButtonType(element) === 'reset') ||
      (tag === 'input' && normalizedInputType(element) === 'reset');
  }

  function isSubmittableControl(element) {
    if (!element || element.nodeType !== 1)
      return false;
    const tag = String(element.localName || '').toLowerCase();
    return tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button';
  }

  function submitterForForm(form, submitter) {
    return submitter || form;
  }

  function isDisabledFormControl(element) {
    return isDisabledCheckableInput(element);
  }

  function captureSubmissionEntries(form, submitter) {
    const entries = [];
    const controls = Array.from(form.elements || []);
    for (const control of controls) {
      if (!isSubmittableControl(control) || formOwner(control) !== form ||
          isDisabledFormControl(control))
        continue;
      const tag = String(control.localName || '').toLowerCase();
      const type = tag === 'input' ? normalizedInputType(control) :
        tag === 'button' ? normalizedButtonType(control) : tag;
      if (['button', 'reset'].includes(type) ||
          (['submit', 'image'].includes(type) && control !== submitter))
        continue;

      const name = String(control.getAttribute('name') || '');
      if (control.hasAttribute('dirname') && name) {
        diagnostic(
          'form.dirname_unsupported',
          'error',
          'The dirname form entry is not yet supported.',
          { id: ensureElementId(control) }
        );
        return null;
      }

      if (type === 'checkbox' || type === 'radio') {
        if (!control.checked || !name)
          continue;
        entries.push({ name: name, value: String(control.value) });
        continue;
      }

      if (type === 'file') {
        if (!name)
          continue;
        const files = fileSelections.get(control) || [];
        if (!files.length) {
          entries.push({ name: name, file: null });
        } else {
          const controlId = ensureElementId(control);
          const resetVersion = fileResetVersions.get(control) || 0;
          for (let index = 0; index < files.length; index++) {
            entries.push({
              name: name,
              file: {
                controlId: controlId,
                resetVersion: String(resetVersion),
                index: index
              }
            });
          }
        }
        continue;
      }

      if (type === 'image' && control === submitter) {
        const prefix = name ? name + '.' : '';
        entries.push({ name: prefix + 'x', value: '0' });
        entries.push({ name: prefix + 'y', value: '0' });
        continue;
      }

      if (!name)
        continue;
      if (tag === 'select') {
        for (const option of selectedOptions(control)) {
          if (option.hasAttribute('disabled') ||
              (option.parentElement && option.parentElement.localName === 'optgroup' &&
               option.parentElement.hasAttribute('disabled')))
            continue;
          entries.push({ name: name, value: String(option.value) });
        }
        continue;
      }
      const value = type === 'hidden' && name === '_charset_'
        ? 'UTF-8'
        : tag === 'button'
        ? String(control.getAttribute('value') || '')
        : String(control.value == null ? '' : control.value);
      entries.push({ name: name, value: value });
    }
    return entries;
  }

  function rawAction(form, submitter) {
    if (submitter && submitter !== form && submitter.hasAttribute('formaction'))
      return String(submitter.getAttribute('formaction') || '');
    return String(form.getAttribute('action') || '');
  }

  function normalizedMethod(value) {
    const method = String(value || 'get').trim().toLowerCase();
    return method === 'post' || method === 'dialog' ? method : 'get';
  }

  function normalizedEnctype(value) {
    const enctype = String(value || '').trim().toLowerCase();
    return enctype === 'multipart/form-data' || enctype === 'text/plain'
      ? enctype
      : 'application/x-www-form-urlencoded';
  }

  function createSubmissionAction(form, submitter) {
    const resolvedSubmitter = submitterForForm(form, submitter);
    const hasSubmitterOverride = resolvedSubmitter !== form;
    const methodAttribute = hasSubmitterOverride && resolvedSubmitter.hasAttribute('formmethod')
      ? resolvedSubmitter.getAttribute('formmethod')
      : form.getAttribute('method');
    const enctypeAttribute = hasSubmitterOverride && resolvedSubmitter.hasAttribute('formenctype')
      ? resolvedSubmitter.getAttribute('formenctype')
      : form.getAttribute('enctype');
    const targetSpecified = (hasSubmitterOverride && resolvedSubmitter.hasAttribute('formtarget')) ||
      form.hasAttribute('target');
    // Navigation attributes are fixed before constructing the entry list;
    // formdata handlers may alter entries, but only affect a later navigation.
    const command = {
      kind: 'submit',
      formId: ensureElementId(form),
      action: rawAction(form, resolvedSubmitter),
      method: normalizedMethod(methodAttribute),
      enctype: normalizedEnctype(enctypeAttribute),
      target: hasSubmitterOverride && resolvedSubmitter.hasAttribute('formtarget')
        ? String(resolvedSubmitter.getAttribute('formtarget') || '')
        : String(form.getAttribute('target') || ''),
      targetSpecified: targetSpecified,
      ...(/(?:^|\s)(?:noopener|noreferrer)(?:\s|$)/i.test(form.getAttribute('rel') || '') ? {noopener: true} :
        /(?:^|\s)opener(?:\s|$)/i.test(form.getAttribute('rel') || '') ? {noopener: false} : {}),
      submitterId: hasSubmitterOverride
        ? String(resolvedSubmitter.getAttribute('id') || '') || null
        : null,
      entries: []
    };
    const binary = activeState.documentBinary;
    const data = new binary.FormData(form,
      resolvedSubmitter === form ? undefined : resolvedSubmitter);
    const entries = [];
    let inlineByteLength = 0;
    for (const pair of data) {
      const name = pair[0];
      const value = pair[1];
      if (typeof value === 'string') {
        entries.push({ name: name, value: value });
      } else {
        const encoded = binary.submissionFile(value);
        inlineByteLength += encoded.byteLength;
        if (inlineByteLength > 2 * 1024 * 1024)
          throw new RangeError('Inline form files cannot exceed 2 MiB in total.');
        entries.push(Object.prototype.hasOwnProperty.call(encoded, 'file')
          ? { name: name, file: encoded.file }
          : { name: name, inlineFile: encoded.inlineFile });
      }
    }
    command.entries = entries;
    return command;
  }

  function requestFormSubmission(form, submitter, options) {
    if (!form || String(form.localName || '').toLowerCase() !== 'form')
      throw new TypeError('The receiver is not a form element.');
    if (!form.isConnected || constructingFormData.has(form))
      return { submitted: false, defaultPrevented: false };
    const settings = options || {};
    const fireSubmit = settings.fireSubmit === true;
    const shouldValidate = settings.validate === true;
    if (fireSubmit && firingSubmissionEvents.has(form))
      return { submitted: false, defaultPrevented: false };

    if (fireSubmit)
      firingSubmissionEvents.add(form);
    try {
      if (shouldValidate && documentFormValidation &&
          !documentFormValidation.checkForm(form, true))
        return { submitted: false, defaultPrevented: false };

      let defaultPrevented = false;
      if (fireSubmit) {
        const actualSubmitter = submitterForForm(form, submitter);
        const event = new PircSubmitEvent('submit', {
          bubbles: true,
          cancelable: true,
          submitter: actualSubmitter === form ? null : actualSubmitter
        });
        defineEventMember(event, 'isTrusted', true);
        form.dispatchEvent(event);
        defaultPrevented = event.defaultPrevented;
        if (defaultPrevented)
          return { submitted: false, defaultPrevented: true };
      }
      return {
        submitted: queueSubmissionAction(form, submitter),
        defaultPrevented: defaultPrevented
      };
    } finally {
      if (fireSubmit)
        firingSubmissionEvents.delete(form);
    }
  }

  function formActionUrl(form, overrideElement, overrideAttribute) {
    if (overrideElement && overrideElement.hasAttribute(overrideAttribute)) {
      const override = String(overrideElement.getAttribute(overrideAttribute) || '');
      if (override === '') return activeState ? activeState.url : '';
      try {
        const base = activeState.document.querySelector('base[href]');
        const baseUrl = base
          ? new URL(String(base.getAttribute('href') || ''), activeState.url).href
          : activeState.url;
        return new URL(override, baseUrl).href;
      } catch (error) {
        return override;
      }
    }
    if (form && form.localName === 'form') {
      const raw = form.getAttribute('action');
      if (raw == null || raw === '') return activeState ? activeState.url : '';
      try {
        const base = activeState.document.querySelector('base[href]');
        const baseUrl = base
          ? new URL(String(base.getAttribute('href') || ''), activeState.url).href
          : activeState.url;
        return new URL(raw, baseUrl).href;
      } catch (error) {
        return raw;
      }
    }
    return activeState ? activeState.url : '';
  }

  function radioGroupMembers(input) {
    const name = input.getAttribute('name') || '';
    if (!name)
      return [input];
    const owner = formOwner(input);
    const root = input.getRootNode();
    const candidates = Array.from(root.querySelectorAll ? root.querySelectorAll('input') : []);
    if (root === input) candidates.push(input);
    return candidates.filter(peer =>
      peer.getRootNode() === root &&
      String(peer.type || '').toLowerCase() === 'radio' &&
      (peer.getAttribute('name') || '') === name &&
      formOwner(peer) === owner
    );
  }

  function isInside(node, ancestor) {
    let current = node;
    while (current) {
      if (current === ancestor)
        return true;
      current = current.parentNode;
    }
    return false;
  }

  function firstLegendChild(fieldset) {
    for (const child of fieldset.children || []) {
      if (String(child.localName || '').toLowerCase() === 'legend')
        return child;
    }
    return null;
  }

  function isDisabledCheckableInput(input) {
    if (input.hasAttribute('disabled'))
      return true;
    let ancestor = input.parentElement;
    while (ancestor) {
      if (String(ancestor.localName || '').toLowerCase() === 'fieldset' &&
          ancestor.hasAttribute('disabled')) {
        const legend = firstLegendChild(ancestor);
        if (!legend || !isInside(input, legend))
          return true;
      }
      ancestor = ancestor.parentElement;
    }
    return false;
  }

  function beginCheckableActivation(input) {
    const type = String(input.type || '').toLowerCase();
    if (type === 'checkbox') {
      const checked = input.checked;
      const indeterminate = input.indeterminate;
      input.checked = !checked;
      input.indeterminate = false;
      return {
        kind: 'checkbox',
        changed: input.checked !== checked,
        previous: [{ input: input, checked: checked, indeterminate: indeterminate }]
      };
    }
    if (type === 'radio') {
      const previous = radioGroupMembers(input).map(member => ({
        input: member,
        checked: member.checked
      }));
      const changed = !input.checked;
      if (changed)
        input.checked = true;
      return { kind: 'radio', changed: changed, previous: previous };
    }
    return null;
  }

  function restoreCheckableActivation(activation) {
    if (!activation)
      return;
    if (activation.kind === 'checkbox') {
      const previous = activation.previous[0];
      previous.input.checked = previous.checked;
      previous.input.indeterminate = previous.indeterminate;
      return;
    }

    // Clear the group before restoring its saved member, because assigning a
    // checked radio correctly clears all other radios in the same group.
    for (const previous of activation.previous) {
      if (previous.input.checked)
        previous.input.checked = false;
    }
    for (const previous of activation.previous) {
      if (previous.checked)
        previous.input.checked = true;
    }
  }

  function dispatchCheckableFollowupEvents(input) {
    for (const type of ['input', 'change']) {
      const event = new GlobalEvent(type, { bubbles: true, cancelable: false });
      defineEventMember(event, 'isTrusted', true);
      input.dispatchEvent(event);
    }
  }

  Object.defineProperty(GlobalEvent.prototype, 'composed', {
    configurable: true, enumerable: true, get: function() { return false; }
  });
  const PublicEvent = new Proxy(GlobalEvent, {
    construct: function(target, args, newTarget) {
      const event = Reflect.construct(target, args, newTarget);
      defineEventMember(event, 'composed', Boolean(args[1]?.composed));
      return event;
    }
  });

  Object.defineProperty(GlobalEvent.prototype, 'isTrusted', {
    configurable: true, enumerable: true, get: function() { return false; }
  });
  const originalDispatchEvent = DOMEventTarget.prototype.dispatchEvent;
  const activeClickEvents = new WeakSet();
  const programmaticClicks = new WeakSet();

  function clickActivationTarget(element) {
    for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
      if (['a', 'area'].includes(current.localName) ||
          isInteractiveClickElement(current) || defaultSummaryFor(current) === current)
        return current;
    }
    return null;
  }

  function labelControl(label) {
    function labelable(element) {
      if (!element || element.nodeType !== 1) return false;
      return ['button', 'select', 'textarea', 'meter', 'output', 'progress'].includes(element.localName) ||
        (element.localName === 'input' && normalizedInputType(element) !== 'hidden');
    }
    if (label.hasAttribute('for')) {
      const candidate = label.ownerDocument.getElementById(label.getAttribute('for'));
      return labelable(candidate) ? candidate : null;
    }
    return Array.from(label.querySelectorAll('*')).find(labelable) || null;
  }

  function labelForwardsClick(label, target) {
    for (let current = target; current && current !== label; current = current.parentElement) {
      if (isInteractiveClickElement(current)) return false;
    }
    return true;
  }

  function pickerException(name, message) {
    const error = typeof DOMException === 'function' ? new DOMException(message, name) : new Error(message);
    if (error.name !== name) error.name = name;
    return error;
  }

  function queueFilePicker(element, explicit) {
    const state = activeState;
    if (!state || element.ownerDocument !== state.document) return;
    if (isDisabledFormControl(element)) {
      if (explicit) throw pickerException('InvalidStateError', 'The input is not mutable.');
      return;
    }
    if (state.pickerActivationUntil <= state.now) {
      if (explicit) throw pickerException('NotAllowedError', 'File selection requires transient user activation.');
      return;
    }
    if (normalizedInputType(element) !== 'file') {
      throw pickerException('NotSupportedError', 'This native picker currently supports file inputs.');
    }
    state.pickerActivationUntil = -1;
    const id = state.nextFilePickerId++;
    const action = Object.freeze({
      kind: 'file', id, controlId: ensureElementId(element),
      accept: element.getAttribute('accept') || '', multiple: element.hasAttribute('multiple'),
      resetVersion: String(fileResetVersions.get(element) || 0), actionOrder: nextActionOrder()
    });
    // Bounded retained references support detached inputs and separately
    // authorized requests awaiting the platform's one-at-a-time chooser.
    if (state.pendingFilePickers.size >= 32)
      state.pendingFilePickers.delete(state.pendingFilePickers.keys().next().value);
    state.pendingFilePickers.set(id, { element, action });
    state.filePickerActions.push(action);
  }

  function filePickerResult(input) {
    const state = activeState;
    const request = input && typeof input === 'object' ? input : {};
    const pending = state?.pendingFilePickers.get(request.id);
    if (!pending) return response();
    state.pendingFilePickers.delete(request.id);
    const element = pending.element;
    if (element.ownerDocument !== state.document || normalizedInputType(element) !== 'file' ||
        isDisabledFormControl(element) ||
        String(fileResetVersions.get(element) || 0) !== pending.action.resetVersion) return response();
    function fire(type, composed) {
      const event = new GlobalEvent(type, { bubbles: true, composed, cancelable: false });
      defineEventMember(event, 'isTrusted', true);
      defineEventMember(event, 'composed', composed);
      element.dispatchEvent(event);
    }
    if (request.error != null) {
      diagnostic('picker.file_error', 'warning', String(request.error).slice(0, 500));
      fire('cancel', false);
      return response();
    }
    if (request.cancelled === true) {
      fire('cancel', false);
      return response();
    }
    const raw = Array.isArray(request.files) ? request.files : [];
    const selected = pending.action.multiple ? raw : raw.slice(0, 1);
    const previous = fileHostSnapshots.get(element) || [];
    const keys = ['name', 'type', 'size', 'bytesBase64', 'contentError'];
    if (previous.length === selected.length &&
        previous.every((file, index) => keys.every(key => file[key] === selected[index][key]))) {
      fire('cancel', false);
      return response();
    }
    fileSelections.set(element, selected.map((file, index) =>
      state.documentBinary.fileFromHost(file, {
        controlId: pending.action.controlId, resetVersion: pending.action.resetVersion, index
      })));
    fileHostSnapshots.set(element, selected.map(file => Object.assign({}, file)));
    fire('input', true);
    fire('change', false);
    return response();
  }

  function ownsHostClickDefault(element) {
    const target = clickActivationTarget(element);
    if (target?.localName === 'input' && normalizedInputType(target) === 'file') return true;
    if (target?.localName === 'label' && labelForwardsClick(target, element)) {
      const control = labelControl(target);
      if (control?.localName === 'input' && normalizedInputType(control) === 'file') return true;
    }
    return Boolean(target && (isSubmitButton(target) || isResetButton(target)) && formOwner(target));
  }

  function dispatchActivationClick(element, event, deferLabel) {
    if (activeClickEvents.has(event)) {
      const error = new Error('The event is already being dispatched.');
      error.name = 'InvalidStateError';
      throw error;
    }
    const target = clickActivationTarget(element);
    const activation = target && target.localName === 'input'
      ? beginCheckableActivation(target) : null;
    activeClickEvents.add(event);
    try {
      const result = originalDispatchEvent.call(element, event);
      if (event.defaultPrevented) {
        restoreCheckableActivation(activation);
      } else if (target) {
        if (target.localName === 'input' &&
            ['checkbox', 'radio'].includes(normalizedInputType(target))) {
          if (activation && activation.changed && target.isConnected)
            dispatchCheckableFollowupEvents(target);
        } else if (target.localName === 'label' && labelForwardsClick(target, element)) {
          // Physical labels retain the host's focus/picker and activation path.
          // Programmatic labels forward synchronously inside the current script.
          const control = labelControl(target);
          if (deferLabel && control?.localName === 'input' && normalizedInputType(control) === 'file') {
            if (!isDisabledFormControl(control)) {
              const forwarded = new activeState.pointer.PointerEvent('click', {
                bubbles: true, cancelable: true, composed: true, detail: event.detail || 1, pointerId: -1
              });
              defineEventMember(forwarded, 'isTrusted', event.isTrusted === true);
              dispatchActivationClick(control, forwarded, false);
            }
          } else if (!deferLabel && control && !isDisabledFormControl(control)) control.click();
        } else if (target.localName === 'input' && normalizedInputType(target) === 'file') {
          queueFilePicker(target, false);
        } else if (['a', 'area'].includes(target.localName)) {
          // Physical anchors retain Dart's native default, after the click's
          // microtasks. Programmatic anchors capture their own default now.
          if (!deferLabel) queueAnchorActivation(target);
        } else if (target.isConnected && !isDisabledFormControl(target)) {
          if (isResetButton(target)) {
            const form = formOwner(target);
            if (form) runFormReset(form);
          } else if (isSubmitButton(target)) {
            const form = formOwner(target);
            if (form) requestFormSubmission(form, target, {
              validate: !form.hasAttribute('novalidate') && !target.hasAttribute('formnovalidate'),
              fireSubmit: true
            });
          }
        }
        toggleDetailsForClickTarget(element);
      }
      return result;
    } catch (error) {
      if (event.defaultPrevented) restoreCheckableActivation(activation);
      throw error;
    } finally {
      activeClickEvents.delete(event);
    }
  }

  function patchClickActivation() {
    DOMEventTarget.prototype.dispatchEvent = function(event) {
      const state = activeState;
      if (state && this instanceof HTMLElement && this.ownerDocument === state.document &&
          event instanceof state.pointer.MouseEvent && event.type === 'click')
        return dispatchActivationClick(this, event);
      return originalDispatchEvent.call(this, event);
    };
    Object.defineProperty(HTMLElement.prototype, 'click', {
      configurable: true, enumerable: true, writable: true,
      value: function() {
        if (!(this instanceof HTMLElement)) throw new TypeError('Illegal invocation.');
        const state = activeState;
        if (!state || this.ownerDocument !== state.document) return;
        if (programmaticClicks.has(this) ||
            (isSubmittableControl(this) && isDisabledFormControl(this))) return;
        programmaticClicks.add(this);
        try {
          const event = new state.pointer.PointerEvent('click', {
            bubbles: true, cancelable: true, composed: true, detail: 0, pointerId: -1
          });
          defineEventMember(event, 'isTrusted', false);
          this.dispatchEvent(event);
        } finally {
          programmaticClicks.delete(this);
        }
      }
    });
  }

  function selectedOptions(select) {
    const options = Array.from(select.options).filter(option => option.localName === 'option');
    let selected = options.filter(option => liveSelected.has(option)
      ? liveSelected.get(option) : option.hasAttribute('selected'));
    if (select.hasAttribute('multiple')) return selected;
    if (selected.length) return [selected[selected.length - 1]];
    if (emptySelects.has(select) || Number(select.getAttribute('size')) > 1) return [];
    const first = options.find(option => !option.hasAttribute('disabled') &&
      !(option.parentElement.localName === 'optgroup' && option.parentElement.hasAttribute('disabled')));
    return first ? [first] : [];
  }

  function clearFiles(input) {
    fileSelections.set(input, []);
    fileHostSnapshots.delete(input);
    fileResetVersions.set(input, (fileResetVersions.get(input) || 0) + 1);
  }

  function resetFormDefaults(form) {
    for (const control of form.elements) {
      const tag = control.localName;
      userInputState.delete(control);
      if (tag === 'input') {
        liveValues.delete(control);
        liveChecked.delete(control);
        if ((control.type || '').toLowerCase() === 'file') clearFiles(control);
      } else if (tag === 'textarea') {
        liveValues.delete(control);
      } else if (tag === 'select') {
        emptySelects.delete(control);
        for (const option of control.options) liveSelected.delete(option);
      } else if (tag === 'output' && control.defaultValue != null) {
        control.value = control.defaultValue;
      }
    }
  }

  function runFormReset(form) {
    if (form.localName !== 'form') throw new TypeError('reset requires a form');
    if (resettingForms.has(form)) return false;
    resettingForms.add(form);
    try {
      const event = new GlobalEvent('reset', {bubbles: true, cancelable: true});
      defineEventMember(event, 'isTrusted', true);
      form.dispatchEvent(event);
      if (!event.defaultPrevented) resetFormDefaults(form);
      return event.defaultPrevented;
    } finally {
      resettingForms.delete(form);
    }
  }

  const validNumberInputValue = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

  function sanitizeNumberInputValue(value) {
    const text = String(value == null ? '' : value);
    return text !== '' && validNumberInputValue.test(text) && Number.isFinite(Number(text))
      ? text
      : '';
  }

  function sanitizeDateInputValue(value) {
    const text = String(value == null ? '' : value);
    if (text === '') return '';
    const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return '';
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isSafeInteger(year) || year <= 0 || month < 1 || month > 12 || day < 1)
      return '';
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthDays = month === 2 ? (leap ? 29 : 28) :
      ([4, 6, 9, 11].includes(month) ? 30 : 31);
    return day <= monthDays ? text : '';
  }

  function rangeAttributeNumber(input, name) {
    const raw = input.getAttribute(name);
    if (raw == null || !validNumberInputValue.test(raw)) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  function sanitizeRangeInputValue(input, value) {
    let min = rangeAttributeNumber(input, 'min');
    let max = rangeAttributeNumber(input, 'max');
    if (min == null) min = 0;
    if (max == null) max = 100;
    if (max < min) max = min;

    const hasUsableValue = value != null && String(value) !== '' &&
      validNumberInputValue.test(String(value)) && Number.isFinite(Number(value));
    const defaultValue = min + (max - min) / 2;
    let current = hasUsableValue ? Number(value) : defaultValue;
    current = Math.min(max, Math.max(min, current));

    const rawStep = String(input.getAttribute('step') || '').trim().toLowerCase();
    if (rawStep !== 'any') {
      const parsedStep = rawStep === '' ? 1 : rangeAttributeNumber(input, 'step');
      const step = parsedStep != null && parsedStep > 0 ? parsedStep : 1;
      const valueAttribute = input.getAttribute('value');
      const valueBase = valueAttribute != null && validNumberInputValue.test(valueAttribute)
        ? Number(valueAttribute)
        : 0;
      const base = rangeAttributeNumber(input, 'min') ?? valueBase;
      current = base + Math.floor((current - base) / step + 0.5) * step;
      current = Math.min(max, Math.max(min, current));
    }
    return String(Object.is(current, -0) ? 0 : current);
  }

  function selectFragmentTarget(url, deferReveal) {
    const state = activeState;
    const marker = String(url).indexOf('#');
    const raw = marker < 0 ? '' : String(url).slice(marker + 1);
    let target = null;
    if (raw) {
      const find = name => Array.from(state.document.querySelectorAll('*')).find(e => e.id === name) ||
        Array.from(state.document.querySelectorAll('a')).find(e => e.getAttribute('name') === name) || null;
      const bytes = [];
      for (let i = 0; i < raw.length;) {
        const pair = raw.slice(i + 1, i + 3);
        if (raw[i] === '%' && /^[0-9a-fA-F]{2}$/.test(pair)) {bytes.push(parseInt(pair, 16)); i += 3;}
        else {
          const point = String.fromCodePoint(raw.codePointAt(i));
          bytes.push(...new TextEncoder().encode(point)); i += point.length;
        }
      }
      const decoded = new TextDecoder('utf-8', {ignoreBOM: true}).decode(new Uint8Array(bytes));
      target = find(raw) || find(decoded);
    }
    if (state.fragmentTarget !== target) {
      state.fragmentTarget = target;
      state.layout?.invalidate();
    }
    if (state.fragmentAncestorTask) state.timers.delete(state.fragmentAncestorTask);
    state.fragmentAncestorTask = null;
    state.fragmentAncestorsRevealed = false;
    function closedAncestors() {
      const result = [];
      for (let child = target, parent = target?.parentElement; parent; child = parent, parent = parent.parentElement) {
        if (parent.localName !== 'details' || parent.hasAttribute('open')) continue;
        const summary = Array.from(parent.children).find(e => e.localName === 'summary');
        if (child !== summary) result.push(parent);
      }
      return result;
    }
    function reveal() {
      if (activeState !== state || state.fragmentTarget !== target || !target?.isConnected) return;
      for (const parent of closedAncestors()) {
        state.fragmentAncestorsRevealed = true;
        parent.setAttribute('open', '');
      }
    }
    if (deferReveal && closedAncestors().length) {
      // Initial parser notifications precede the browser's fragment reveal.
      state.fragmentAncestorTask = scheduleTimer('timeout', () => {
        state.fragmentAncestorTask = null;
        reveal();
      }, 0, []);
    } else reveal();
  }

  function installFormProperties() {
    // LinkeDOM's selector alias omits controls under a disabled fieldset.
    // Share the actual disabledness algorithm across matches and DOM queries,
    // including nested fieldsets and the first-legend exception.
    delete aliases.target;
    pseudos.target = element => element === activeState.fragmentTarget && element.isConnected;
    delete aliases.disabled;
    pseudos.disabled = function(element) {
      if (['input', 'button', 'select', 'textarea'].includes(element.localName))
        return isDisabledFormControl(element);
      if (element.localName === 'option')
        return element.hasAttribute('disabled') ||
          (element.parentElement?.localName === 'optgroup' && element.parentElement.hasAttribute('disabled'));
      return ['fieldset', 'optgroup'].includes(element.localName) && element.hasAttribute('disabled');
    };
    Object.defineProperty(HTMLLabelElement.prototype, 'htmlFor', {
      configurable: true, get: function() { return this.getAttribute('for') || ''; },
      set: function(value) { this.setAttribute('for', String(value)); }
    });
    Object.defineProperty(HTMLFieldSetElement.prototype, 'disabled', {
      configurable: true, get: function() { return this.hasAttribute('disabled'); },
      set: function(value) { this.toggleAttribute('disabled', Boolean(value)); }
    });
    Object.defineProperties(HTMLInputElement.prototype, {
      accept: { configurable: true, get: function() { return this.getAttribute('accept') || ''; },
        set: function(value) { this.setAttribute('accept', String(value)); } },
      multiple: { configurable: true, get: function() { return this.hasAttribute('multiple'); },
        set: function(value) { this.toggleAttribute('multiple', Boolean(value)); } },
      readOnly: { configurable: true, get: function() { return this.hasAttribute('readonly'); },
        set: function(value) { this.toggleAttribute('readonly', Boolean(value)); } },
      showPicker: { configurable: true, writable: true, value: function() {
        if (!(this instanceof HTMLInputElement)) throw new TypeError('Illegal invocation.');
        queueFilePicker(this, true);
      } },
      value: { configurable: true, get: function() {
        const type = (this.type || '').toLowerCase();
        if (type === 'file') {
          const files = fileSelections.get(this) || [];
          return files.length ? 'C:\\fakepath\\' + files[0].name : '';
        }
        if (type === 'range') {
          const current = liveValues.has(this) ? liveValues.get(this) : this.getAttribute('value');
          return sanitizeRangeInputValue(this, current);
        }
        const current = liveValues.has(this)
          ? liveValues.get(this)
          : this.getAttribute('value') ?? (type === 'checkbox' || type === 'radio' ? 'on' : '');
        if (type === 'number') return sanitizeNumberInputValue(current);
        if (type === 'date') return sanitizeDateInputValue(current);
        return current;
      }, set: function(value) {
        const text = value == null ? '' : String(value);
        userInputState.delete(this);
        if ((this.type || '').toLowerCase() === 'file') {
          if (text !== '') throw new Error('A file input value can only be cleared');
          clearFiles(this);
        } else if ((this.type || '').toLowerCase() === 'number') {
          liveValues.set(this, sanitizeNumberInputValue(text));
        } else if ((this.type || '').toLowerCase() === 'date') {
          liveValues.set(this, sanitizeDateInputValue(text));
        } else if ((this.type || '').toLowerCase() === 'range') {
          liveValues.set(this, sanitizeRangeInputValue(this, text));
        } else {
          liveValues.set(this, text);
        }
      } },
      defaultValue: { configurable: true, get: function() { return this.getAttribute('value') || ''; },
        set: function(value) { this.setAttribute('value', String(value)); } },
      checked: { configurable: true, get: function() {
        return liveChecked.has(this) ? liveChecked.get(this) : this.hasAttribute('checked');
      }, set: function(value) {
        liveChecked.set(this, Boolean(value));
        if (value && String(this.type || '').toLowerCase() === 'radio') {
          for (const peer of radioGroupMembers(this)) {
            if (peer !== this)
              liveChecked.set(peer, false);
          }
        }
      } },
      indeterminate: { configurable: true, get: function() { return liveIndeterminate.get(this) || false; },
        set: function(value) { liveIndeterminate.set(this, Boolean(value)); } },
      defaultChecked: { configurable: true, get: function() { return this.hasAttribute('checked'); },
        set: function(value) { this.toggleAttribute('checked', Boolean(value)); } },
      files: { configurable: true, get: function() {
        if ((this.type || '').toLowerCase() !== 'file') return null;
        const files = [...(fileSelections.get(this) || [])];
        Object.defineProperty(files, 'item', {value: index => files[index] || null});
        return Object.freeze(files);
      } }
    });
    Object.defineProperties(HTMLTextAreaElement.prototype, {
      value: { configurable: true, get: function() {
        return liveValues.has(this) ? liveValues.get(this) : this.textContent || '';
      }, set: function(value) {
        userInputState.delete(this);
        liveValues.set(this, value == null ? '' : String(value));
      } },
      defaultValue: { configurable: true, get: function() { return this.textContent || ''; },
        set: function(value) { this.textContent = String(value); } }
    });
    Object.defineProperties(HTMLOptionElement.prototype, {
      value: { configurable: true, get: function() {
        return this.hasAttribute('value') ? this.getAttribute('value') : (this.textContent || '').trim().replace(/\s+/g, ' ');
      }, set: function(value) { this.setAttribute('value', String(value)); } },
      defaultSelected: { configurable: true, get: function() { return this.hasAttribute('selected'); },
        set: function(value) { this.toggleAttribute('selected', Boolean(value)); } },
      selected: { configurable: true, get: function() {
        const select = this.closest('select');
        return select ? selectedOptions(select).includes(this)
          : liveSelected.has(this) ? liveSelected.get(this) : this.hasAttribute('selected');
      }, set: function(value) {
        liveSelected.set(this, Boolean(value));
        const select = this.closest('select');
        if (select && value) {
          emptySelects.delete(select);
          if (!select.hasAttribute('multiple')) {
            for (const peer of select.options) if (peer !== this) liveSelected.set(peer, false);
          }
        }
      } }
    });
    Object.defineProperties(HTMLSelectElement.prototype, {
      value: { configurable: true, get: function() { return selectedOptions(this)[0]?.value || ''; },
        set: function(value) {
          userInputState.delete(this);
          const wanted = String(value);
          let matched = false;
          for (const option of this.options) {
            const match = !matched && option.value === wanted;
            liveSelected.set(option, match);
            if (match) matched = true;
          }
          if (matched) emptySelects.delete(this); else emptySelects.add(this);
        } },
      selectedIndex: { configurable: true, get: function() {
        const option = selectedOptions(this)[0];
        return option ? Array.from(this.options).indexOf(option) : -1;
      }, set: function(value) {
        const index = Number(value);
        for (let i = 0; i < this.options.length; i++) liveSelected.set(this.options[i], i === index);
        if (index >= 0 && index < this.options.length) emptySelects.delete(this); else emptySelects.add(this);
      } }
    });

    const stringReflector = (attribute, defaultValue, normalize) => ({
      configurable: true,
      get: function() {
        const raw = this.getAttribute(attribute);
        return normalize ? normalize(raw, this) : raw == null ? defaultValue : raw;
      },
      set: function(value) { this.setAttribute(attribute, String(value)); }
    });
    const booleanReflector = attribute => ({
      configurable: true,
      get: function() { return this.hasAttribute(attribute); },
      set: function(value) { this.toggleAttribute(attribute, Boolean(value)); }
    });
    const methodState = raw => normalizedMethod(raw);
    const enctypeState = raw => normalizedEnctype(raw);

    Object.defineProperties(HTMLFormElement.prototype, {
      action: {
        configurable: true,
        get: function() { return formActionUrl(this, null, ''); },
        set: function(value) { this.setAttribute('action', String(value)); }
      },
      method: stringReflector('method', 'get', methodState),
      enctype: stringReflector('enctype', 'application/x-www-form-urlencoded', enctypeState),
      encoding: stringReflector('enctype', 'application/x-www-form-urlencoded', enctypeState),
      target: stringReflector('target', ''),
      noValidate: booleanReflector('novalidate'),
      submit: {
        configurable: true,
        writable: true,
        value: function() {
          requestFormSubmission(this, this, { validate: false, fireSubmit: false });
        }
      },
      requestSubmit: {
        configurable: true,
        writable: true,
        value: function(submitter) {
          if (!this || String(this.localName || '').toLowerCase() !== 'form')
            throw new TypeError('The receiver is not a form element.');
          let candidate = arguments.length === 0 || submitter === undefined
            ? this
            : submitter;
          if (candidate !== this) {
            if (!isSubmitButton(candidate))
              throw new TypeError('The submitter is not a submit button.');
            if (formOwner(candidate) !== this) {
              const error = typeof DOMException === 'function'
                ? new DOMException('The submitter does not belong to this form.', 'NotFoundError')
                : new Error('The submitter does not belong to this form.');
              if (error.name !== 'NotFoundError') error.name = 'NotFoundError';
              throw error;
            }
          }
          const validate = !this.hasAttribute('novalidate') &&
            !(candidate !== this && candidate.hasAttribute('formnovalidate'));
          requestFormSubmission(this, candidate, { validate: validate, fireSubmit: true });
        }
      },
      checkValidity: {
        configurable: true,
        writable: true,
        value: function() {
          if (String(this.localName || '').toLowerCase() !== 'form')
            throw new TypeError('checkValidity requires a form element.');
          return Boolean(documentFormValidation && documentFormValidation.checkForm(this, false));
        }
      },
      reportValidity: {
        configurable: true,
        writable: true,
        value: function() {
          if (String(this.localName || '').toLowerCase() !== 'form')
            throw new TypeError('reportValidity requires a form element.');
          return Boolean(documentFormValidation && documentFormValidation.checkForm(this, true));
        }
      }
    });

    const submitterProperties = {
      form: {
        configurable: true,
        get: function() { return formOwner(this); }
      },
      formAction: {
        configurable: true,
        get: function() { return formActionUrl(formOwner(this), this, 'formaction'); },
        set: function(value) { this.setAttribute('formaction', String(value)); }
      },
      formMethod: {
        configurable: true,
        get: function() {
          const form = formOwner(this);
          return normalizedMethod(this.hasAttribute('formmethod')
            ? this.getAttribute('formmethod')
            : form ? form.getAttribute('method') : null);
        },
        set: function(value) { this.setAttribute('formmethod', String(value)); }
      },
      formEnctype: {
        configurable: true,
        get: function() {
          const form = formOwner(this);
          return normalizedEnctype(this.hasAttribute('formenctype')
            ? this.getAttribute('formenctype')
            : form ? form.getAttribute('enctype') : null);
        },
        set: function(value) { this.setAttribute('formenctype', String(value)); }
      },
      formNoValidate: booleanReflector('formnovalidate'),
      formTarget: {
        configurable: true,
        get: function() {
          const form = formOwner(this);
          return this.hasAttribute('formtarget')
            ? String(this.getAttribute('formtarget') || '')
            : form ? String(form.getAttribute('target') || '') : '';
        },
        set: function(value) { this.setAttribute('formtarget', String(value)); }
      }
    };
    for (const prototype of [
      HTMLButtonElement.prototype,
      HTMLInputElement.prototype
    ]) {
      Object.defineProperties(prototype, submitterProperties);
    }
    for (const prototype of [
      HTMLButtonElement.prototype,
      HTMLInputElement.prototype,
      HTMLSelectElement.prototype,
      HTMLTextAreaElement.prototype
    ]) {
      Object.defineProperty(prototype, 'form', {
        configurable: true,
        get: function() { return formOwner(this); }
      });
    }
    Object.defineProperties(HTMLButtonElement.prototype, {
      type: {
        configurable: true,
        get: function() { return normalizedButtonType(this); },
        set: function(value) { this.setAttribute('type', String(value)); }
      },
      name: stringReflector('name', ''),
      value: stringReflector('value', '')
    });
    Object.defineProperties(HTMLInputElement.prototype, {
      type: {
        configurable: true,
        get: function() { return normalizedInputType(this); },
        set: function(value) { this.setAttribute('type', String(value)); }
      },
      name: stringReflector('name', '')
    });

    const originalPreventDefault = GlobalEvent.prototype.preventDefault;
    GlobalEvent.prototype.preventDefault = function() {
      if (this.cancelable)
        originalPreventDefault.call(this);
    };

    Object.defineProperty(HTMLElement.prototype, 'elements', {
      get: function() {
        const form = this;
        if (String(form.localName || '').toLowerCase() !== 'form')
          return undefined;
        const document = form.ownerDocument;
        const controls = new NodeList();
        const candidates = document.querySelectorAll(
          'button,input,select,textarea,fieldset,object,output'
        );
        for (const control of candidates) {
          let owner = null;
          if (control.hasAttribute('form')) {
            owner = document.getElementById(control.getAttribute('form'));
          } else {
            let ancestor = control.parentNode;
            while (ancestor) {
              if (ancestor.nodeType === 1 &&
                  String(ancestor.localName).toLowerCase() === 'form') {
                owner = ancestor;
                break;
              }
              ancestor = ancestor.parentNode;
            }
          }
          if (owner === form)
            controls.push(control);
        }
        return controls;
      },
      configurable: true,
      enumerable: true
    });
    Object.defineProperty(HTMLElement.prototype, 'reset', {
      configurable: true,
      value: function() { runFormReset(this); }
    });

    documentFormValidation = createDocumentFormValidation({
      formOwner: formOwner,
      radioGroupMembers: radioGroupMembers,
      isDisabled: isDisabledCheckableInput,
      selectedOptions: selectedOptions,
      fileSelections: fileSelections,
      liveValues: liveValues,
      diagnostic: diagnostic,
      Event: PublicEvent,
      createInvalidEvent: () => {
        const event = new GlobalEvent('invalid', {bubbles: false, cancelable: true});
        defineEventMember(event, 'isTrusted', true);
        return event;
      },
      prototypes: [
        HTMLInputElement.prototype,
        HTMLTextAreaElement.prototype,
        HTMLSelectElement.prototype
      ],
      reportInvalid: queueInvalidAction,
      userInputState: userInputState
    });
    documentFormValidation.install();

  }

  function installNativeScrollPositionGlobals(view, globalObject, layout) {
    const ScrollPromise=Promise, resolveScroll=Promise.resolve.bind(Promise), rejectScroll=Promise.reject.bind(Promise);
    const aliases = [
      ['scrollX', 'scrollX'],
      ['scrollY', 'scrollY'],
      ['pageXOffset', 'scrollX'],
      ['pageYOffset', 'scrollY']
    ];
    const targets = globalObject === view ? [view] : [view, globalObject];
    for (const [name, coordinate] of aliases) {
      const descriptor = {
        configurable: true,
        enumerable: true,
        get: function() {return layout.viewport()[coordinate];}
      };
      for (const target of targets) Object.defineProperty(target, name, descriptor);
    }

    function normalizeScrollCoordinate(value) {
      // CSSOM View normalizes NaN and infinities to zero before scrolling.
      const number = +value;
      return Number.isFinite(number) ? number : 0;
    }

    function normalizeScrollBehavior(value) {
      if (value === undefined) return 'auto';
      const behavior = '' + value;
      if (behavior !== 'auto' && behavior !== 'instant' && behavior !== 'smooth')
        throw new TypeError('The scroll behavior must be auto, instant, or smooth.');
      return behavior;
    }

    const pendingScrollReveals=new Set();
    const scrollTargetKey=target=>target?.id ?? null;
    function queueScrollAction(kind, x, y, behavior, target) {
      const state = activeState;
      if (!state) return;
      if (state.scrollActions.length >= MAX_PENDING_SCROLL_ACTIONS ||
          layout.pendingScrollActionCount() >= MAX_PENDING_SCROLL_ACTIONS) {
        diagnostic(
          'layout.scroll_action_limit',
          'warning',
          'The native scroll action queue is full; additional actions were omitted.',
          { limit: MAX_PENDING_SCROLL_ACTIONS }
        );
        return;
      }
      if (!Number.isSafeInteger(state.nextScrollActionId) || state.nextScrollActionId <= 0)
        throw new RangeError('Native scroll action id overflow');
      const action = {
        actionId: state.nextScrollActionId++,
        kind: kind,
        x: x,
        y: y,
        behavior: behavior
      };
      if (target && target.viewport !== true) action.elementId = target.id;
      const effectiveBehavior = layout.resolveScrollBehavior(target, behavior);
      if (behavior === 'auto' && ['instant', 'smooth'].includes(effectiveBehavior))
        action.resolvedBehavior = effectiveBehavior;
      for(const pending of pendingScrollReveals) {
        if(pending.targets.has(scrollTargetKey(target))) {
          pendingScrollReveals.delete(pending);
          pending.resolve({interrupted:true});
        }
      }
      layout.recordScrollAction(action, target, effectiveBehavior);
      if (state.initialFragmentSelected && action.elementId == null && kind === 'to' && y != null)
        state.initialRootScrollOverride = true;
      state.scrollActions.push(Object.freeze(action));
    }

    layout.setScrollActionQueue(function(target, kind, x, y, behavior) {
      queueScrollAction(kind, x, y, behavior, target);
    });

    function scrollMethod(kind, elementScoped) {
      return function scrollToOrBy(first, second) {
        let x;
        let y;
        let behavior = 'auto';
        if (arguments.length >= 2) {
          x = normalizeScrollCoordinate(first);
          y = normalizeScrollCoordinate(second);
        } else {
          const options = arguments.length ? first : undefined;
          // Chromium ignores a lone primitive, but null/undefined are empty
          // dictionaries and still cancel an existing smooth scroll.
          if (options != null && typeof options !== 'object' && typeof options !== 'function') return;
          let left;
          let top;
          let requestedBehavior;
          if (options != null) {
            requestedBehavior = options.behavior;
            left = options.left;
            top = options.top;
          }
          behavior = normalizeScrollBehavior(requestedBehavior);
          if (kind === 'to') {
            // An omitted coordinate preserves that native viewport axis.
            x = left === undefined ? null : normalizeScrollCoordinate(left);
            y = top === undefined ? null : normalizeScrollCoordinate(top);
          } else {
            // ScrollByOptions uses zero for omitted delta coordinates.
            x = left === undefined ? 0 : normalizeScrollCoordinate(left);
            y = top === undefined ? 0 : normalizeScrollCoordinate(top);
          }
        }
        // Zero/omitted coordinates still abort a prior smooth scroll.
        if (elementScoped) {
          layout.queueElementScrollAction(this, kind, x, y, behavior);
        } else {
          queueScrollAction(kind, x, y, behavior);
        }
      };
    }

    const windowScrollTo = scrollMethod('to', false);
    const scrollMethods = [
      ['scroll', windowScrollTo],
      ['scrollTo', windowScrollTo],
      ['scrollBy', scrollMethod('by', false)]
    ];
    for (const target of targets) {
      for (const [name, method] of scrollMethods) {
        Object.defineProperty(target, name, {
          configurable: true,
          enumerable: false,
          writable: true,
          value: method
        });
      }
    }

    Object.defineProperty(Element$1.prototype,'scrollIntoView',{
      configurable:true,enumerable:true,writable:true,
      value:function scrollIntoView(arg=undefined) {
        const element=this;
        try {
          if(!(element instanceof Element$1)) throw new TypeError('scrollIntoView requires an Element');
          const options={behavior:'auto',block:'start',container:'all',inline:'nearest'};
          if(arg==null || typeof arg==='object' || typeof arg==='function') {
            if(arg!=null) {
              options.behavior=normalizeScrollBehavior(arg.behavior);
              for(const key of ['block','container','inline']) {
                const raw=arg[key];if(raw===undefined) continue;
                const value=''+raw,allowed=key==='container'?['all','nearest']:['start','center','end','nearest'];
                if(!allowed.includes(value)) throw new TypeError(`Invalid scrollIntoView ${key}`);
                options[key]=value;
              }
            }
          } else if(!arg) options.block='end';
          if(element.ownerDocument!==activeState.document || !element.isConnected)
            return resolveScroll({interrupted:false});
          const execute=()=>{
            const plan=layout.scrollIntoViewPlan(element,options),state=activeState;
            if(state.scrollActions.length+plan.length>MAX_PENDING_SCROLL_ACTIONS || layout.pendingScrollActionCount()+plan.length>MAX_PENDING_SCROLL_ACTIONS)
              throw new RangeError('Native scrollIntoView action queue is full');
            if(!Number.isSafeInteger(state.nextScrollActionId+plan.length-1)) throw new RangeError('Native scroll action id overflow');
            const first=state.scrollActions.length;
            for(const request of plan) queueScrollAction('to',request.x,request.y,options.behavior,request.target);
            const animated=state.scrollActions.slice(first).some(action=>(action.resolvedBehavior ?? action.behavior)==='smooth');
            if(!animated) return {interrupted:false};
            const through=state.nextScrollActionId-1;
            return new ScrollPromise((resolve,reject)=>{
              const pending={targets:new Set(plan.map(request=>scrollTargetKey(request.target))),resolve};
              pendingScrollReveals.add(pending);
              const poll=()=>{
                if(!pendingScrollReveals.has(pending)) return;
                try {
                  const result=layout.scrollIntoViewCompletion(plan,through);
                  if(result) {pendingScrollReveals.delete(pending);resolve(result);}
                  else view.requestAnimationFrame(poll);
                } catch(error) {pendingScrollReveals.delete(pending);reject(error);}
              };
              view.requestAnimationFrame(poll);
            });
          };
          if(!layout.hasCurrentBox(element) && layout.needsLayout()) {
            return new ScrollPromise((resolve,reject)=>view.requestAnimationFrame(()=>{
              try {resolve(execute());} catch(error) {reject(error);}
            }));
          }
          return resolveScroll(execute());
        } catch(error) {return rejectScroll(error);}
      }
    });

    const elementScrollTo = scrollMethod('to', true);
    const elementScrollMethods = [
      ['scroll', elementScrollTo],
      ['scrollTo', elementScrollTo],
      ['scrollBy', scrollMethod('by', true)]
    ];
    for (const [name, method] of elementScrollMethods) {
      Object.defineProperty(Element$1.prototype, name, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: method
      });
    }
  }

  function installCanvasLayoutGeometry(document, pointer, layout) {
    if (!document || typeof document.createElement !== 'function' ||
        !pointer || typeof pointer.nativeCanvasRect !== 'function' ||
        !layout || typeof layout.getBoundingClientRect !== 'function' ||
        typeof layout.DOMRect !== 'function') return false;
    let prototype = null;
    try {
      const canvas = document.createElement('canvas');
      prototype = canvas && Object.getPrototypeOf(canvas);
    } catch (_) {
      return false;
    }
    if (!prototype) return false;
    Object.defineProperty(prototype, 'getBoundingClientRect', {
      value: function() {
        const measured = pointer.nativeCanvasRect(this);
        if (measured && !layout.hasPendingScrollActions())
          return new layout.DOMRect(measured.x, measured.y, measured.width, measured.height);
        return layout.getBoundingClientRect(this);
      },
      configurable: true,
      writable: true
    });
    return true;
  }

  function installComputedStyleGlobal(view, layout, installGlobal) {
    if (!view || !layout || typeof layout.getComputedStyle !== 'function') {
      throw new TypeError('Computed-style installation requires a window and document layout');
    }
    const getter = function getComputedStyle(element, pseudoElement) {
      return layout.getComputedStyle(element, pseudoElement);
    };
    let installedOnWindow = false;
    try {
      Object.defineProperty(view, 'getComputedStyle', {
        value: getter,
        enumerable: true,
        configurable: false,
        writable: false,
      });
      installedOnWindow = view.getComputedStyle === getter;
    } catch (_) {
      try {
        view.getComputedStyle = getter;
        installedOnWindow = view.getComputedStyle === getter;
      } catch (ignored) {
        installedOnWindow = false;
      }
    }
    if (!installedOnWindow) throw new TypeError('Could not install window.getComputedStyle');
    if (typeof installGlobal === 'function' && installGlobal('getComputedStyle', getter, false) === false) {
      throw new TypeError('Could not install the getComputedStyle global');
    }
    return getter;
  }

  function installDomGlobals(view, document) {
    defineGlobal('window', view, false);
    defineGlobal('self', view, false);
    defineGlobal('document', document, false);
    defineGlobal('Node', Node, false);
    defineGlobal('Element', Element, false);
    defineGlobal('HTMLElement', HTMLElement, false);
    defineGlobal('Event', PublicEvent, false);
    defineGlobal('CustomEvent', CustomEvent, false);
    defineGlobal('UIEvent', PircUIEvent, false);
    const pointer = createDocumentPointer({
      document: document, HTMLElement: HTMLElement, UIEvent: PircUIEvent,
      defineEventMember: defineEventMember, diagnostic: diagnostic
    });
    pointer.install();
    activeState.pointer = pointer;
    activeState.layout = createPircDocumentLayout({
      document, Element: Element$1, HTMLElement,
      MutationObserver: view.MutationObserver,
      ensureElementId, resolveElementId: id => activeState.elementsById.get(id),
      enabled: activeState.hostLayout,
      documentMode: activeState.documentMode,
      diagnostic: (code, detail) => diagnostic(code, 'warning',
        'Native document geometry is unavailable until the matching layout is measured.', detail)
    });
    activeState.layout.install();
    activeState.mutationObservers = createDocumentMutationObserverRuntime({
      document, NativeMutationObserver: view.MutationObserver, Node, NodeList,
      onDiagnostic: diagnostic
    });
    defineGlobal('MutationObserver', activeState.mutationObservers.MutationObserver, false);
    if (activeState.mutationObservers.MutationRecord)
      defineGlobal('MutationRecord', activeState.mutationObservers.MutationRecord, false);
    activeState.resizeObservers = createDocumentResizeObservers({
      document, Element: Element$1, layout: activeState.layout, diagnostic
    });
    for (const name of ['ResizeObserver', 'ResizeObserverEntry', 'ResizeObserverSize']) {
      defineGlobal(name, activeState.resizeObservers[name], false);
    }
    if (activeState.hostLayout)
      installNativeScrollPositionGlobals(view, globalThis, activeState.layout);
    defineGlobal('DOMRect', activeState.layout.DOMRect, false);
    defineGlobal('DOMRectReadOnly', activeState.layout.DOMRectReadOnly, false);
    installComputedStyleGlobal(view, activeState.layout, defineGlobal);
    // A trusted native pointer callback may use its exact host-measured canvas
    // rect for the synchronous event scope (including compatibility events).
    // All other reads use the same revisioned layout source as other elements.
    if (activeState.hostLayout)
      installCanvasLayoutGeometry(document, activeState.pointer, activeState.layout);
    defineGlobal('MouseEvent', pointer.MouseEvent, false);
    defineGlobal('PointerEvent', pointer.PointerEvent, false);
    defineGlobal('InputEvent', PircInputEvent, false);
    defineGlobal('CompositionEvent', PircCompositionEvent, false);
    defineGlobal('KeyboardEvent', PircKeyboardEvent, false);
    defineGlobal('FocusEvent', PircFocusEvent, false);
    defineGlobal('URL', pircUrlPolyfill.URL, false);
    defineGlobal('URLSearchParams', pircUrlPolyfill.URLSearchParams, false);
    defineGlobal('Document', Document, false);
    defineGlobal('DOMParser', DOMParser, false);
    defineGlobal('Text', Text, false);
    defineGlobal('Comment', Comment, false);
    defineGlobal('DocumentFragment', DocumentFragment, false);
    defineGlobal('NodeList', NodeList, false);
    defineGlobal('HTMLInputElement', HTMLInputElement, false);
    defineGlobal('HTMLAnchorElement', HTMLAnchorElement, false);
    defineGlobal('HTMLAreaElement', HTMLAreaElement, false);
    defineGlobal('HTMLBaseElement', HTMLBaseElement, false);
    defineGlobal('HTMLButtonElement', HTMLButtonElement, false);
    defineGlobal('HTMLFormElement', HTMLFormElement, false);
    defineGlobal('HTMLDetailsElement', HTMLDetailsElement, false);
    defineGlobal('HTMLDialogElement', HTMLDialogElement, false);
    defineGlobal('ToggleEvent', PircToggleEvent, false);
    defineGlobal('SubmitEvent', PircSubmitEvent, false);
    defineGlobal('FormDataEvent', PircFormDataEvent, false);
    defineGlobal('HTMLTextAreaElement', HTMLTextAreaElement, false);
    defineGlobal('HTMLSelectElement', HTMLSelectElement, false);
    installDocumentScriptProperties(document);
    for (const [name, value] of [
      ['MouseEvent', pointer.MouseEvent],
      ['PointerEvent', pointer.PointerEvent],
      ['URL', pircUrlPolyfill.URL],
      ['URLSearchParams', pircUrlPolyfill.URLSearchParams]
    ]) {
      try {
        Object.defineProperty(view, name, {
          value: value,
          writable: false,
          configurable: false,
          enumerable: true
        });
      } catch (error) {
        try {
          view[name] = value;
        } catch (ignored) {
          diagnostic(
            'runtime.global_install_error',
            'error',
            'Could not install DOM global ' + name + ': ' + exceptionMessage(error),
            { global: name }
          );
        }
      }
    }
    installUnavailableGlobals(document);
    installSchedulerGlobals(view);
    installDocumentFetchGlobals(view);
    activeState.storage = createPircDocumentStorage({
      getUrl: () => activeState.url, diagnostic,
      URL: pircUrlPolyfill.URL, Event: PublicEvent, DOMException: globalThis.DOMException,
      dispatchEvent: event => view.dispatchEvent(event)
    });
    activeState.storage.install(globalThis);
    const storageSeed = storageBridge.takeInitialState();
    if (storageSeed) activeState.storage.sync(storageSeed);
    installDocumentHistory(view);
  }

  function installWindowResizeHandler(view) {
    const originalAdd = view.addEventListener.bind(view);
    const originalRemove = view.removeEventListener.bind(view);
    const originalDispatch = view.dispatchEvent.bind(view);
    const records = new Map();
    const captureOf = value => typeof value === 'boolean' ? value : Boolean(value && value.capture);
    function remove(listener, capture) {
      const variants = records.get(listener);
      const record = variants && variants.get(capture);
      if (!record) return;
      originalRemove('resize', record.wrapper, capture);
      if (record.signal && record.abort) record.signal.removeEventListener('abort',record.abort);
      variants.delete(capture);
      if (!variants.size) records.delete(listener);
    }
    view.addEventListener = function(type, listener, options) {
      if (String(type) !== 'resize') return originalAdd(type, listener, options);
      if (listener == null) return;
      if (typeof listener !== 'function' && typeof listener !== 'object')
        throw new TypeError('Event listener must be a function or object.');
      const capture = captureOf(options);
      const signal = options && typeof options === 'object' ? options.signal : null;
      if (signal && signal.aborted) return;
      let variants = records.get(listener);
      if (!variants) {variants = new Map();records.set(listener,variants);}
      if (variants.has(capture)) return;
      const record = {wrapper:null,signal,abort:null};
      record.wrapper = event => {
        if (options && options.once) remove(listener,capture);
        try {
          if (typeof listener === 'function') listener.call(view,event);
          else if (typeof listener.handleEvent === 'function') listener.handleEvent(event);
        } catch (error) {diagnostic('script.resize_listener_error','error',exceptionMessage(error));}
      };
      variants.set(capture,record);
      originalAdd('resize',record.wrapper,options);
      if (signal && typeof signal.addEventListener === 'function') {
        record.abort = () => remove(listener,capture);
        signal.addEventListener('abort',record.abort,{once:true});
      }
    };
    view.removeEventListener = function(type,listener,options) {
      if (String(type) === 'resize') return remove(listener,captureOf(options));
      return originalRemove(type,listener,options);
    };
    view.dispatchEvent = function(event) {
      if (!event || event.type !== 'resize') return originalDispatch(event);
      if (event._dispatching) throw pickerException('InvalidStateError','The event is already being dispatched.');
      event._dispatching = true;
      // LinkeDOM's window uses a private EventTarget; expose the actual window.
      for (const key of ['target','currentTarget']) Object.defineProperty(event,key,{
        configurable:true,enumerable:true,get:()=>view,set:()=>{}
      });
      Object.defineProperty(event,'composedPath',{configurable:true,value:()=>event._dispatching?[view]:[]});
      try {return originalDispatch(event);}
      finally {
        event._dispatching = false;
        Object.defineProperty(event,'target',{configurable:true,enumerable:true,value:view});
        Object.defineProperty(event,'currentTarget',{configurable:true,enumerable:true,value:null});
      }
    };
    let handler = null, installed = false;
    const listener = event => { if (handler) handler.call(view, event); };
    Object.defineProperty(globalThis, 'onresize', {configurable:true,enumerable:true,
      get: () => handler,
      set: value => {
        handler = typeof value === 'function' ? value : null;
        if (handler && !installed) {view.addEventListener('resize',listener);installed=true;}
        else if (!handler && installed) {view.removeEventListener('resize',listener);installed=false;}
      }
    });
  }

  function installDocumentScrollHandler(view, document) {
    let windowHandler = null;
    let windowHandlerInstalled = false;
    const windowListener = event => {
      if (windowHandler) windowHandler.call(view, event);
    };
    function setWindowHandler(value) {
      windowHandler = typeof value === 'function' ? value : null;
      if (windowHandler && !windowHandlerInstalled) {
        view.addEventListener('scroll', windowListener);
        windowHandlerInstalled = true;
      } else if (!windowHandler && windowHandlerInstalled) {
        view.removeEventListener('scroll', windowListener);
        windowHandlerInstalled = false;
      }
    }
    const windowDescriptor = {
      configurable: true,
      enumerable: true,
      get: () => windowHandler,
      set: setWindowHandler
    };
    Object.defineProperty(view, 'onscroll', windowDescriptor);
    Object.defineProperty(globalThis, 'onscroll', windowDescriptor);

    let documentHandler = null;
    let documentHandlerInstalled = false;
    const documentListener = event => {
      if (documentHandler) documentHandler.call(document, event);
    };
    Object.defineProperty(document, 'onscroll', {
      configurable: true,
      enumerable: true,
      get: () => documentHandler,
      set: value => {
        documentHandler = typeof value === 'function' ? value : null;
        if (documentHandler && !documentHandlerInstalled) {
          document.addEventListener('scroll', documentListener);
          documentHandlerInstalled = true;
        } else if (!documentHandler && documentHandlerInstalled) {
          document.removeEventListener('scroll', documentListener);
          documentHandlerInstalled = false;
        }
      }
    });
  }

  function installDocumentVisibility(document) {
    const state = activeState;
    Object.defineProperties(document, {
      hidden: {enumerable: true, configurable: true, get: () => state.hidden},
      visibilityState: {enumerable: true, configurable: true,
        get: () => state.hidden ? 'hidden' : 'visible'}
    });
    let handler = null;
    const listener = event => { if (handler) handler.call(document, event); };
    Object.defineProperty(document, 'onvisibilitychange', {
      enumerable: true, configurable: true, get: () => handler,
      set: value => {
        const next = typeof value === 'function' ? value : null;
        if (!handler && next) document.addEventListener('visibilitychange', listener);
        if (handler && !next) document.removeEventListener('visibilitychange', listener);
        handler = next;
      }
    });
  }

  function updateVisibility(input) {
    const state = activeState;
    if (!state?.document) return response();
    advanceClock(input?.now);
    const hidden = input?.hidden === true;
    if (hidden) state.layout?.discardScrollFeedback();
    if (hidden !== state.hidden) {
      state.hidden = hidden;
      const event = new GlobalEvent('visibilitychange', {
        bubbles: true, cancelable: false, composed: false
      });
      defineEventMember(event, 'isTrusted', true);
      state.document.dispatchEvent(event);
    }
    if (hidden) state.layout?.discardScrollFeedback();
    return response();
  }

  function installDocumentStorageHandler(view) {
    let storageHandler = null, storageHandlerInstalled = false;
    const storageListener = event => {
      if (storageHandler) storageHandler.call(view, event);
    };
    const storageAddListener = view.addEventListener.bind(view);
    const storageRemoveListener = view.removeEventListener.bind(view);
    const storageHandlerDescriptor = {enumerable: true, configurable: true,
      get: () => storageHandler, set: value => {
        storageHandler = typeof value === 'function' ? value : null;
        if (storageHandler && !storageHandlerInstalled) {
          storageAddListener('storage', storageListener);
          storageHandlerInstalled = true;
        } else if (!storageHandler && storageHandlerInstalled) {
          storageRemoveListener('storage', storageListener);
          storageHandlerInstalled = false;
        }
      }};
    Object.defineProperty(view, 'onstorage', storageHandlerDescriptor);
    if (view !== globalThis) Object.defineProperty(globalThis, 'onstorage', storageHandlerDescriptor);
  }

  function installDocumentHistory(view) {
    const state = activeState;
    class PopStateEvent extends GlobalEvent {
      constructor(type, init) {
        if (arguments.length < 1) throw new TypeError('An event type is required.');
        const value = init == null ? {} : init;
        super(`${type}`, value);
        defineEventMember(this, 'state', value.state === undefined ? null : value.state);
        defineEventMember(this, 'isTrusted', false);
      }
    }
    const dispatch = function(event) {
      try { view.dispatchEvent(event); }
      catch (failure) { diagnostic('history.listener_error', 'warning', exceptionMessage(failure)); }
    };
    state.history = createDocumentHistory({
      URL: pircUrlPolyfill.URL, DOMException: globalThis.DOMException,
      codec: createHistoryStateCodec({DOMException: globalThis.DOMException,
        isUnsupportedHostObject: value => value instanceof Node ||
          ['Blob', 'File', 'Request', 'Response', 'Headers', 'FormData', 'Event', 'EventTarget']
            .some(name => typeof globalThis[name] === 'function' && value instanceof globalThis[name])}),
      initial: state.initialHistory, scope: state.objectUrlNonce,
      getURL: () => state.url, setURL: url => { state.url = url; },
      updateTarget: snapshot => {
        if (snapshot.initialFragmentRevealPending === false) state.initialFragmentObservationPending = false;
        if (Number.isSafeInteger(snapshot.targetRevision) && snapshot.targetRevision >= 0 &&
            typeof snapshot.targetUrl === 'string' && snapshot.targetRevision !== state.fragmentTargetRevision) {
          state.fragmentTargetRevision = snapshot.targetRevision;
          selectFragmentTarget(snapshot.targetUrl);
        }
      },
      getBaseURL: currentDocumentBaseUrl, nextActionOrder: nextActionOrder,
      enqueue: action => {
        let captured = action;
        if (state.hostLayout && ['push','replace'].includes(action.method)) {
          captured = {...action, initialScrollSnapshotPending: !state.loadDispatched || state.loadEventDispatching ||
            (state.initialFragmentObservationPending && !state.initialRootScrollOverride)};
          try { captured.sourceScrollTop = state.layout.viewport().scrollY; }
          catch (error) { diagnostic('history.initial_scroll_unmeasured', 'info', exceptionMessage(error)); }
          Object.freeze(captured);
        }
        const pending = state.navigationActions.filter(value => value.kind === 'history');
        if (pending.length >= 128 || utf8ByteLength(JSON.stringify(pending.concat(captured))) > 2 * 1024 * 1024)
          throw new globalThis.DOMException('Pending history changes exceed the document limit.', 'QuotaExceededError');
        state.navigationActions.push(captured);
      },
      dispatchPopState: value => {
        const event = new GlobalEvent('popstate', {bubbles: false, cancelable: false});
        Object.setPrototypeOf(event, PopStateEvent.prototype);
        defineEventMember(event, 'state', value);
        defineEventMember(event, 'isTrusted', true);
        dispatch(event);
      },
      dispatchHashChange: (oldURL, newURL) => {
        const event = new GlobalEvent('hashchange', {bubbles: false, cancelable: false});
        defineEventMember(event, 'oldURL', oldURL); defineEventMember(event, 'newURL', newURL);
        defineEventMember(event, 'isTrusted', true); dispatch(event);
      }
    });
    for (const [name, value] of [['history', state.history.history],
      ['History', state.history.History], ['PopStateEvent', PopStateEvent]]) {
      defineGlobal(name, value, false);
      Object.defineProperty(view, name, {value, enumerable: true, configurable: false});
    }
    for (const type of ['popstate', 'hashchange']) {
      let handler = null, installed = false;
      const listener = event => { if (typeof handler === 'function') handler.call(view, event); };
      const descriptor = {enumerable: true, configurable: true,
        get: () => handler, set: value => {
          handler = typeof value === 'function' ? value : null;
          if (!installed && handler) { view.addEventListener(type, listener); installed = true; }
        }};
      Object.defineProperty(view, 'on' + type, descriptor);
      if (view !== globalThis) Object.defineProperty(globalThis, 'on' + type, descriptor);
    }
  }

  function installDocumentScriptProperties(document) {
    const state = activeState;
    const descriptors = {
      readyState: {
        get: function() { return state ? state.readyState : 'loading'; },
        enumerable: true
      },
      currentScript: {
        get: function() { return state ? state.currentScript : null; },
        enumerable: true
      },
      baseURI: {
        get: currentDocumentBaseUrl,
        enumerable: true
      },
      activeElement: {
        get: function() {
          const focused = state && state.activeElement;
          if (focused && focused.ownerDocument === document && focused.isConnected)
            return focused;
          return document.body || document.documentElement || null;
        },
        enumerable: true
      }
    };
    for (const name of Object.keys(descriptors)) {
      try {
        Object.defineProperty(document, name, {
          get: descriptors[name].get,
          configurable: true,
          enumerable: descriptors[name].enumerable
        });
      } catch (error) {
        diagnostic(
          'script.document_property_error',
          'warning',
          'Could not expose document.' + name + ': ' + exceptionMessage(error),
          { property: name }
        );
      }
    }
  }

  function installDocumentFetchGlobals(view) {
    const state = activeState;
    if (typeof createDocumentFetch !== 'function') {
      defineGlobal('fetch', unavailableFunction('fetch', 'network'), false);
      return;
    }

    try {
      const binary = createDocumentBinary({
        entriesForForm: function(form, submitter) {
          if (!(form instanceof HTMLFormElement))
            throw new TypeError('FormData requires a form element.');
          if (constructingFormData.has(form)) {
            const error = new Error('The form entry list is already being constructed.');
            error.name = 'InvalidStateError';
            throw error;
          }
          if (submitter != null) {
            if (!isSubmitButton(submitter))
              throw new TypeError('The submitter is not a submit button.');
            if (formOwner(submitter) !== form) {
              const error = new Error('The submitter does not belong to this form.');
              error.name = 'NotFoundError';
              throw error;
            }
          }
          const captured = captureSubmissionEntries(form, submitter || form);
          if (!captured)
            throw new TypeError('This form contains an unsupported entry.');
          return captured.map(function(entry) {
            if (!Object.prototype.hasOwnProperty.call(entry, 'file'))
              return [entry.name, entry.value];
            if (entry.file === null)
              return [entry.name, new binary.File([], '', { type: 'application/octet-stream' })];
            const control = state.elementsById.get(entry.file.controlId);
            const file = control && (fileSelections.get(control) || [])[entry.file.index];
            if (!file)
              throw new TypeError('The selected form file is no longer available.');
            return [entry.name, file];
          });
        },
        formDataCreated: function(form, data) {
          constructingFormData.add(form);
          try {
            form.dispatchEvent(new PircFormDataEvent('formdata', {
              formData: data, bubbles: true, cancelable: false
            }, internalFormDataEventToken));
          } finally {
            constructingFormData.delete(form);
          }
        }
      });
      state.documentBinary = binary;
      const objectUrls = createDocumentObjectUrls({
        binary: binary, baseUrl: function() { return state.url; },
        nonce: state.objectUrlNonce, URL: pircUrlPolyfill.URL
      });
      state.objectUrls = objectUrls;
      Object.defineProperty(pircUrlPolyfill.URL, 'createObjectURL', {
        value: objectUrls.createObjectURL, configurable: true, writable: true
      });
      Object.defineProperty(pircUrlPolyfill.URL, 'revokeObjectURL', {
        value: objectUrls.revokeObjectURL, configurable: true, writable: true
      });
      const fetchRuntime = createDocumentFetch({
        resolveObjectURL: objectUrls.resolveFetch,
        binary: binary,
        enqueue: function(request) {
          if (!state)
            return;
          if (request && request.kind === 'fetch' &&
              (typeof request.referrerPolicy !== 'string' || request.referrerPolicy === '')) {
            request.referrerPolicy = currentDocumentReferrerPolicy();
          }
          state.resourceRequests.push(request);
        },
        cancel: function(id) {
          if (state)
            state.resourceCancellations.push(String(id));
        },
        baseUrl: currentDocumentBaseUrl,
        URL: pircUrlPolyfill.URL,
        URLSearchParams: pircUrlPolyfill.URLSearchParams
      });
      state.documentFetch = fetchRuntime;
      const encodingData = createDocumentEncodingData();
      const textEncoderRuntime = createDocumentTextEncoder();
      const textDecoderRuntime = createDocumentTextDecoder(encodingData);
      const fileTextRuntime = createDocumentFileText({
        encodingLabels: encodingData.encodingLabels,
        TextDecoder: textDecoderRuntime.TextDecoder
      });
      const fileReaderRuntime = createDocumentFileReader({
        binary: binary, Event: GlobalEvent, EventTarget: DOMEventTarget,
        decodeText: fileTextRuntime.decode,
        schedule: function(callback) { return scheduleTimer('timeout', callback, 0, []); },
        cancel: function(id) { cancelTask(state.timers, id); },
        reportError: function(error) {
          diagnostic('script.file_reader_listener_error', 'error', exceptionMessage(error));
        }
      });
      const xhrRuntime = createDocumentXHR({
        fetch: fetchRuntime.fetchForXHR, completedAt: fetchRuntime.completedAtForXHR,
        Headers: fetchRuntime.Headers,
        AbortController: fetchRuntime.AbortController, binary,
        Event: GlobalEvent, EventTarget: DOMEventTarget,
        ProgressEvent: fileReaderRuntime.ProgressEvent,
        createProgressEvent: fileReaderRuntime.createProgressEvent,
        createEvent: function(type) {
          const event = new GlobalEvent(type);
          Object.defineProperty(event, 'isTrusted', {value: true, enumerable: true});
          return event;
        },
        DOMException: fileReaderRuntime.DOMException, DOMParser,
        URL: pircUrlPolyfill.URL, baseUrl: currentDocumentBaseUrl,
        decodeText: fileTextRuntime.decode, decodeJSONText: fileTextRuntime.decodeUtf8,
        schedule: function(callback, delay) { return scheduleTimer('timeout', callback, delay, []); },
        cancel: function(id) { cancelTask(state.timers, id); },
        now: function() { return state.now; },
        reportError: function(error) {
          diagnostic('script.xhr_listener_error', 'error', exceptionMessage(error));
        },
        diagnostic
      });
      for (const name of [
        'fetch', 'Headers', 'Request', 'Response', 'AbortController', 'AbortSignal',
        'Blob', 'File', 'FormData', 'FormDataEvent', 'TextEncoder', 'TextDecoder',
        'FileReader', 'ProgressEvent', 'DOMException', 'EventTarget',
        'XMLHttpRequest', 'XMLHttpRequestEventTarget', 'XMLHttpRequestUpload'
      ]) {
        const value = name === 'FormDataEvent' ? PircFormDataEvent :
          name === 'EventTarget' ? DOMEventTarget :
          (binary[name] || fetchRuntime[name] || fileReaderRuntime[name] || xhrRuntime[name] ||
           textEncoderRuntime[name] || textDecoderRuntime[name]);
        defineGlobal(name, value, false);
        try {
          Object.defineProperty(view, name, {
            value: value,
            writable: false,
            configurable: false,
            enumerable: true
          });
        } catch (error) {
          try {
            view[name] = value;
          } catch (ignored) {
            diagnostic(
              'runtime.global_install_error',
              'warning',
              'Could not install fetch global ' + name + ': ' + exceptionMessage(error),
              { global: name }
            );
          }
        }
      }
    } catch (error) {
      diagnostic('runtime.fetch_install_error', 'error', exceptionMessage(error));
      defineGlobal('fetch', unavailableFunction('fetch', 'network'), false);
    }
  }

  function eventOptions(value) {
    return value && typeof value === 'object' ? value : {};
  }

  function defineEventMember(event, name, value) {
    Object.defineProperty(event, name, {
      value: value,
      enumerable: true,
      configurable: false,
      writable: false
    });
  }

  function eventStringOption(options, name, fallback) {
    const value = options[name];
    return value == null ? fallback : String(value);
  }

  function eventNumberOption(options, name, fallback, minimum, maximum) {
    const value = Number(options[name]);
    if (!Number.isFinite(value))
      return fallback;
    return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
  }

  class PircUIEvent extends GlobalEvent {
    constructor(type, init) {
      const options = eventOptions(init);
      super(type, options);
      defineEventMember(this, 'view', options.view == null ? null : options.view);
      defineEventMember(this, 'detail', eventNumberOption(options, 'detail', 0, -2147483648, 2147483647));
    }
  }

  class PircInputEvent extends PircUIEvent {
    constructor(type, init) {
      const options = eventOptions(init);
      super(type, options);
      defineEventMember(this, 'data', options.data == null ? null : String(options.data));
      defineEventMember(this, 'composed', Boolean(options.composed));
      defineEventMember(this, 'inputType', eventStringOption(options, 'inputType', ''));
      defineEventMember(this, 'isComposing', Boolean(options.isComposing));
      defineEventMember(this, 'dataTransfer', options.dataTransfer == null ? null : options.dataTransfer);
    }

    getTargetRanges() {
      return [];
    }
  }

  class PircCompositionEvent extends PircUIEvent {
    constructor(type, init) {
      const options = eventOptions(init);
      super(type, options);
      defineEventMember(this, 'data', eventStringOption(options, 'data', ''));
    }
  }

  class PircKeyboardEvent extends PircUIEvent {
    constructor(type, init) {
      const options = eventOptions(init);
      super(type, options);
      defineEventMember(this, 'key', eventStringOption(options, 'key', 'Unidentified'));
      defineEventMember(this, 'code', eventStringOption(options, 'code', ''));
      defineEventMember(this, 'location', eventNumberOption(options, 'location', 0, 0, 3));
      defineEventMember(this, 'ctrlKey', Boolean(options.ctrlKey));
      defineEventMember(this, 'shiftKey', Boolean(options.shiftKey));
      defineEventMember(this, 'altKey', Boolean(options.altKey));
      defineEventMember(this, 'metaKey', Boolean(options.metaKey));
      defineEventMember(this, 'repeat', Boolean(options.repeat));
      defineEventMember(this, 'isComposing', Boolean(options.isComposing));
      defineEventMember(this, 'charCode', eventNumberOption(options, 'charCode', 0, 0, 4294967295));
      defineEventMember(this, 'keyCode', eventNumberOption(options, 'keyCode', 0, 0, 4294967295));
      defineEventMember(this, 'which', eventNumberOption(options, 'which', 0, 0, 4294967295));
    }

    getModifierState(keyArg) {
      switch (String(keyArg)) {
        case 'Alt': return this.altKey;
        case 'Control': return this.ctrlKey;
        case 'Meta': return this.metaKey;
        case 'Shift': return this.shiftKey;
        default: return false;
      }
    }
  }

  class PircFocusEvent extends PircUIEvent {
    constructor(type, init) {
      const options = eventOptions(init);
      super(type, options);
      defineEventMember(this, 'relatedTarget', options.relatedTarget == null ? null : options.relatedTarget);
      defineEventMember(this, 'composed', Boolean(options.composed));
    }

    preventDefault() {
      // FocusEvent is never cancelable in browsers. LinkeDOM's base Event
      // implementation ignores the cancelable flag, so preserve the platform
      // behavior here for both trusted and script-created focus events.
      if (this.cancelable)
        super.preventDefault();
    }
  }

  const TEXT_INPUT_TYPES_WITH_BLUR_CHANGE = new Set([
    'text', 'search', 'tel', 'url', 'email', 'password', 'number', 'date',
    'month', 'week', 'time', 'datetime-local'
  ]);

  function isTextInputForBlurChange(element) {
    const tag = String(element && element.localName || '').toLowerCase();
    if (tag === 'textarea')
      return true;
    return tag === 'input' &&
      TEXT_INPUT_TYPES_WITH_BLUR_CHANGE.has(String(element.type || 'text').toLowerCase());
  }

  function inlineStyleValue(element, property) {
    const style = element && element.getAttribute && element.getAttribute('style');
    if (!style)
      return '';
    for (const declaration of String(style).split(';')) {
      const separator = declaration.indexOf(':');
      if (separator < 0 || declaration.slice(0, separator).trim().toLowerCase() !== property)
        continue;
      return declaration.slice(separator + 1).trim().replace(/\s*!important\s*$/i, '').toLowerCase();
    }
    return '';
  }

  function hasHiddenOrInertAncestor(element) {
    for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
      if (current.hasAttribute('hidden') || current.hasAttribute('inert'))
        return true;
      if (current !== element && current.localName === 'details' && !current.hasAttribute('open')) {
        const summary = Array.from(current.children).find(child => child.localName === 'summary');
        if (!summary || !isInside(element, summary)) return true;
      }
      if (current.localName === 'dialog' && !current.hasAttribute('open') &&
          !inlineStyleValue(current, 'display')) return true;
      if (inlineStyleValue(current, 'display') === 'none')
        return true;
      const visibility = inlineStyleValue(current, 'visibility');
      if (visibility === 'hidden' || visibility === 'collapse')
        return true;
    }
    return false;
  }

  function hasValidTabIndex(element) {
    if (!element.hasAttribute('tabindex'))
      return false;
    const value = String(element.getAttribute('tabindex') || '').trim();
    return /^[+-]?\d+$/.test(value) && Number.isFinite(Number(value));
  }

  function isFocusableHTMLElement(element, state) {
    if (!(element instanceof HTMLElement) || !state || !state.document ||
        element.ownerDocument !== state.document || !element.isConnected ||
        hasHiddenOrInertAncestor(element)) {
      return false;
    }
    const topModal = state.modalDialogs[state.modalDialogs.length - 1];
    if (topModal && !isInside(element, topModal)) return false;

    const tag = String(element.localName || '').toLowerCase();
    if (tag === 'input') {
      if (String(element.type || 'text').toLowerCase() === 'hidden' || isDisabledFormControl(element))
        return false;
      return true;
    }
    if (tag === 'dialog') return true;
    if (['textarea', 'select', 'button'].includes(tag))
      return !isDisabledFormControl(element);
    if ((tag === 'a' || tag === 'area') && element.hasAttribute('href'))
      return true;
    return defaultSummaryFor(element) === element || hasValidTabIndex(element);
  }

  function dispatchTrustedChangeForBlur(element) {
    const event = new GlobalEvent('change', {
      bubbles: true,
      cancelable: false,
      composed: false
    });
    defineEventMember(event, 'isTrusted', true);
    element.dispatchEvent(event);
  }

  function dispatchTrustedFocusEvent(element, type, relatedTarget) {
    const state = activeState;
    const event = new PircFocusEvent(type, {
      bubbles: type === 'focusin' || type === 'focusout',
      cancelable: false,
      composed: true,
      view: state ? state.window : null,
      relatedTarget: relatedTarget
    });
    defineEventMember(event, 'isTrusted', true);
    element.dispatchEvent(event);
  }

  function pendingChangeState(element) {
    return userInputState.get(element) || {};
  }

  function clearPendingChange(element) {
    const previous = pendingChangeState(element);
    if (!previous.pendingChange)
      return false;
    userInputState.set(element, Object.assign({}, previous, { pendingChange: false }));
    return true;
  }

  // These events need an explicit Window/Document path because LinkeDOM's
  // generic EventTarget path does not model Window capture for a Document.
  const focusEventTypes = new Set(['focus', 'blur', 'focusin', 'focusout', 'input', 'change', 'scroll', 'visibilitychange', 'toggle', 'beforetoggle', 'close', 'cancel', 'invalid']);
  const focusEventListeners = new WeakMap();
  const focusEventHandlerProperties = new WeakMap();
  const focusEventPatchedWindows = new WeakSet();
  let focusEventHooksInstalled = false;

  function focusListenerCapture(options) {
    if (typeof options === 'boolean')
      return options;
    if (!options || typeof options !== 'object')
      return false;
    return Boolean(options.capture);
  }

  function focusListenerRecords(target, type, create) {
    let byType = focusEventListeners.get(target);
    if (!byType && create) {
      byType = new Map();
      focusEventListeners.set(target, byType);
    }
    if (!byType)
      return null;
    let records = byType.get(type);
    if (!records && create) {
      records = [];
      byType.set(type, records);
    }
    return records || null;
  }

  function addFocusListener(target, type, listener, options) {
    if (listener == null ||
        (typeof listener !== 'function' && typeof listener !== 'object'))
      return;
    const capture = focusListenerCapture(options);
    const signal = options && typeof options === 'object' ? options.signal : null;
    if (signal && signal.aborted)
      return;
    const records = focusListenerRecords(target, type, true);
    if (records.some(record => !record.removed &&
        record.listener === listener && record.capture === capture))
      return;
    const record = {
      listener: listener,
      capture: capture,
      once: Boolean(options && typeof options === 'object' && options.once),
      removed: false,
      signal: signal,
      abortListener: null
    };
    if (signal && typeof signal.addEventListener === 'function') {
      record.abortListener = function() {
        removeFocusListener(target, type, listener, capture);
      };
      signal.addEventListener('abort', record.abortListener, { once: true });
    }
    records.push(record);
  }

  function removeFocusListener(target, type, listener, capture) {
    const records = focusListenerRecords(target, type, false);
    if (!records)
      return;
    const record = records.find(candidate => !candidate.removed &&
      candidate.listener === listener && candidate.capture === capture);
    if (!record)
      return;
    record.removed = true;
    if (record.signal && record.abortListener &&
        typeof record.signal.removeEventListener === 'function') {
      record.signal.removeEventListener('abort', record.abortListener);
    }
  }

  function invokeFocusListeners(target, type, event, capture, phase) {
    const records = focusListenerRecords(target, type, false);
    if (!records)
      return;
    // Listener additions during this invocation start on the next event.
    for (const record of records.slice()) {
      if (record.removed || record.capture !== capture)
        continue;
      if (record.once)
        removeFocusListener(target, type, record.listener, record.capture);
      event.currentTarget = target;
      event.eventPhase = phase;
      try {
        if (typeof record.listener === 'function')
          record.listener.call(target, event);
        else if (record.listener && typeof record.listener.handleEvent === 'function')
          record.listener.handleEvent.call(record.listener, event);
      } catch (error) {
        diagnostic(type === 'visibilitychange' ? 'script.visibility_listener_error' :
          type === 'scroll' ? 'script.scroll_listener_error' :
          type === 'toggle' ? 'script.toggle_listener_error' : 'script.focus_listener_error',
          'error', exceptionMessage(error));
      }
      if (event._stopImmediatePropagationFlag)
        break;
    }
  }

  function focusEventParent(target, state) {
    // LinkeDOM's Document._getParent() exposes an internal node rather than
    // the Window. Keep this correction local to focus dispatch so unrelated
    // pointer/click event paths retain their existing behavior.
    if (state && target === state.document)
      return state.window;
    return target && typeof target._getParent === 'function'
      ? target._getParent()
      : null;
  }

  function dispatchFocusEvent(target, event) {
    const state = activeState;
    const path = [];
    for (let current = target; current; current = focusEventParent(current, state)) {
      if (path.includes(current))
        break;
      path.push(current);
    }
    event._path = path.map(currentTarget => ({ currentTarget: currentTarget, target: target }));
    event.target = target;
    event.srcElement = target;
    event.cancelBubble = false;
    event._stopImmediatePropagationFlag = false;
    event._dispatching = true;
    const ancestors = path.slice(1);
    try {
      for (let index = ancestors.length - 1; index >= 0; index--) {
        invokeFocusListeners(ancestors[index], event.type, event, true, event.CAPTURING_PHASE);
        if (event.cancelBubble)
          return !event.defaultPrevented;
      }

      invokeFocusListeners(target, event.type, event, true, event.AT_TARGET);
      if (!event._stopImmediatePropagationFlag)
        invokeFocusListeners(target, event.type, event, false, event.AT_TARGET);

      if (event.bubbles && !event.cancelBubble) {
        for (const currentTarget of ancestors) {
          invokeFocusListeners(currentTarget, event.type, event, false, event.BUBBLING_PHASE);
          if (event.cancelBubble)
            break;
        }
      }
      return !event.defaultPrevented;
    } finally {
      event.currentTarget = null;
      event.eventPhase = event.NONE;
      event._dispatching = false;
      event._path = [];
    }
  }

  function patchFocusWindowHooks(view) {
    if (!view || focusEventPatchedWindows.has(view))
      return;
    focusEventPatchedWindows.add(view);
    const viewAdd = view.addEventListener;
    const viewRemove = view.removeEventListener;
    const viewDispatch = view.dispatchEvent;
    view.addEventListener = function(type, listener, options) {
      const normalizedType = String(type);
      if (focusEventTypes.has(normalizedType)) {
        addFocusListener(this, normalizedType, listener, options);
        return;
      }
      if (typeof viewAdd === 'function')
        return viewAdd.call(this, type, listener, options);
    };
    view.removeEventListener = function(type, listener, options) {
      const normalizedType = String(type);
      if (focusEventTypes.has(normalizedType)) {
        removeFocusListener(this, normalizedType, listener, focusListenerCapture(options));
        return;
      }
      if (typeof viewRemove === 'function')
        return viewRemove.call(this, type, listener, options);
    };
    view.dispatchEvent = function(event) {
      if (event && focusEventTypes.has(String(event.type))) {
        if (event._dispatching)
          throw pickerException('InvalidStateError', 'The event is already being dispatched.');
        return dispatchFocusEvent(this, event);
      }
      if (typeof viewDispatch === 'function')
        return viewDispatch.call(this, event);
      return true;
    };
  }

  function patchFocusEventHooks() {
    if (focusEventHooksInstalled) {
      patchFocusWindowHooks(activeState && activeState.window);
      return;
    }
    focusEventHooksInstalled = true;
    const prototype = DOMEventTarget.prototype;
    const originalAdd = prototype.addEventListener;
    const originalRemove = prototype.removeEventListener;
    const previousDispatch = prototype.dispatchEvent;

    prototype.addEventListener = function(type, listener, options) {
      const normalizedType = String(type);
      if (focusEventTypes.has(normalizedType)) {
        addFocusListener(this, normalizedType, listener, options);
        return;
      }
      return originalAdd.call(this, type, listener, options);
    };
    prototype.removeEventListener = function(type, listener, options) {
      const normalizedType = String(type);
      if (focusEventTypes.has(normalizedType)) {
        removeFocusListener(this, normalizedType, listener, focusListenerCapture(options));
        return;
      }
      return originalRemove.call(this, type, listener, options);
    };
    prototype.dispatchEvent = function(event) {
      if (event && focusEventTypes.has(String(event.type))) {
        if (event._dispatching)
          throw pickerException('InvalidStateError', 'The event is already being dispatched.');
        return dispatchFocusEvent(this, event);
      }
      return previousDispatch.call(this, event);
    };

    // LinkeDOM's Window is a plain view object with its own EventTarget
    // methods, rather than a DOMEventTarget instance. Patch just this view so
    // Window capture/bubble listeners join focus/input/change propagation.
    patchFocusWindowHooks(activeState && activeState.window);

    for (const type of focusEventTypes) {
      if (type === 'visibilitychange' || dialogEventHandlerTypes.has(type)) continue;
      const property = 'on' + type;
      Object.defineProperty(HTMLElement.prototype, property, {
        configurable: true,
        enumerable: true,
        get: function() {
          const handlers = focusEventHandlerProperties.get(this);
          return handlers && handlers.has(type) ? handlers.get(type).handler : null;
        },
        set: function(value) {
          let handlers = focusEventHandlerProperties.get(this);
          if (!handlers) {
            handlers = new Map();
            focusEventHandlerProperties.set(this, handlers);
          }
          const previous = handlers.get(type);
          if (previous)
            this.removeEventListener(type, previous.handler);
          if (typeof value === 'function') {
            handlers.set(type, { handler: value });
            this.addEventListener(type, value);
          } else {
            handlers.delete(type);
          }
        }
      });
    }
  }

  function emitScriptFocusAction(kind, element, preventScroll) {
    const state = activeState;
    if (!state || !state.focusActions)
      return;
    state.focusActions.push({
      kind: kind,
      controlId: ensureElementId(element),
      preventScroll: preventScroll === true,
      actionOrder: nextActionOrder()
    });
  }

  function rememberHostFocusCounterpart(state, kind, element) {
    const pending = kind === 'focusin'
      ? state.pendingHostFocusIns
      : state.pendingHostFocusOuts;
    pending.push({ element: element, transitionVersion: state.focusTransitionVersion });
    if (pending.length > 256)
      pending.shift();
  }

  function takeHostFocusCounterpart(state, kind, element) {
    const pending = kind === 'focusin'
      ? state.pendingHostFocusIns
      : state.pendingHostFocusOuts;
    for (let index = pending.length - 1; index >= 0; index--) {
      if (pending[index].element !== element)
        continue;
      return pending.splice(index, 1)[0];
    }
    return null;
  }

  function focusElement(element, options) {
    const state = activeState;
    if (!(element instanceof HTMLElement))
      throw new TypeError('Illegal invocation.');
    const preventScroll = options == null ? false : Boolean(options.preventScroll);
    if (!isFocusableHTMLElement(element, state))
      return;

    let previous = state.activeElement;
    if (previous && (previous.ownerDocument !== state.document || !previous.isConnected)) {
      state.activeElement = null;
      previous = null;
    }
    if (previous === element)
      return;

    const transition = ++state.focusTransitionVersion;
    if (previous && isTextInputForBlurChange(previous) && clearPendingChange(previous)) {
      // Chrome reports body as activeElement during the change-before-blur
      // sequence. Clearing first also lets a change handler reenter focus().
      state.activeElement = null;
      dispatchTrustedChangeForBlur(previous);
      if (state.focusTransitionVersion !== transition)
        return;
    }

    if (previous) {
      // Chromium exposes body as activeElement throughout blur/focusout.
      state.activeElement = null;
      dispatchTrustedFocusEvent(previous, 'blur', element);
      if (state.focusTransitionVersion !== transition) {
        // A blur listener may synchronously focus a third element. Chromium
        // still completes the old focusout, but with no related target.
        dispatchTrustedFocusEvent(previous, 'focusout', null);
        return;
      }
      dispatchTrustedFocusEvent(previous, 'focusout', element);
      if (state.focusTransitionVersion !== transition)
        return;
    }

    if (!element.isConnected || element.ownerDocument !== state.document)
      return;
    state.activeElement = element;
    dispatchTrustedFocusEvent(element, 'focus', previous);
    if (state.focusTransitionVersion !== transition)
      return;
    dispatchTrustedFocusEvent(element, 'focusin', previous);
    if (state.focusTransitionVersion !== transition || state.activeElement !== element)
      return;
    emitScriptFocusAction('focus', element, preventScroll);
  }

  function blurElement(element) {
    const state = activeState;
    if (!(element instanceof HTMLElement))
      throw new TypeError('Illegal invocation.');
    if (!state || !state.document || element.ownerDocument !== state.document ||
        !element.isConnected || state.activeElement !== element) {
      return;
    }

    const transition = ++state.focusTransitionVersion;
    if (isTextInputForBlurChange(element) && clearPendingChange(element)) {
      state.activeElement = null;
      dispatchTrustedChangeForBlur(element);
      if (state.focusTransitionVersion !== transition)
        return;
    }

    state.activeElement = null;
    dispatchTrustedFocusEvent(element, 'blur', null);
    if (state.focusTransitionVersion !== transition)
      return;
    dispatchTrustedFocusEvent(element, 'focusout', null);
    if (state.focusTransitionVersion !== transition || state.activeElement !== null)
      return;
    emitScriptFocusAction('blur', element, false);
  }

  function installHTMLElementFocusMethods() {
    Object.defineProperty(HTMLElement.prototype, 'focus', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: function(options) { focusElement(this, options); }
    });
    Object.defineProperty(HTMLElement.prototype, 'blur', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: function() { blurElement(this); }
    });
    Object.defineProperty(HTMLElement.prototype, 'tabIndex', {
      configurable: true,
      enumerable: true,
      get: function() {
        if (hasValidTabIndex(this))
          return Number.parseInt(String(this.getAttribute('tabindex')).trim(), 10);
        const tag = String(this.localName || '').toLowerCase();
        if (tag === 'input' && String(this.type || 'text').toLowerCase() !== 'hidden')
          return 0;
        if (['textarea', 'select', 'button'].includes(tag))
          return 0;
        if (defaultSummaryFor(this) === this)
          return 0;
        if ((tag === 'a' || tag === 'area') && this.hasAttribute('href'))
          return 0;
        return -1;
      },
      set: function(value) {
        const number = Number(value);
        const integer = Number.isFinite(number) ? Math.trunc(number) : 0;
        this.setAttribute('tabindex', String(integer));
      }
    });
    Object.defineProperties(HTMLTextAreaElement.prototype, {
      type: {
        configurable: true,
        enumerable: true,
        get: function() { return 'textarea'; }
      },
      readOnly: {
        configurable: true,
        enumerable: true,
        get: function() { return this.hasAttribute('readonly'); },
        set: function(value) { this.toggleAttribute('readonly', Boolean(value)); }
      }
    });
    Object.defineProperty(HTMLSelectElement.prototype, 'type', {
      configurable: true,
      enumerable: true,
      get: function() { return this.hasAttribute('multiple') ? 'select-multiple' : 'select-one'; }
    });
  }

  const EVENT_DATA_STRING_LIMITS = Object.freeze({
    data: 4096,
    inputType: 128,
    key: 64,
    code: 64,
    relatedTarget: 128
  });
  const EVENT_DATA_BOOLEAN_FIELDS = new Set([
    'isComposing', 'repeat', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'focusLeaving'
  ]);
  const EVENT_DATA_NUMBER_FIELDS = new Set([
    'location', 'charCode', 'keyCode', 'which'
  ]);

  function boundedRequestEventData(request) {
    const source = request && request.eventData;
    const result = Object.create(null);
    if (!source || typeof source !== 'object' || Array.isArray(source))
      return result;

    for (const name of Object.keys(EVENT_DATA_STRING_LIMITS)) {
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(source, name);
      } catch (error) {
        continue;
      }
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
        continue;
      const value = descriptor.value;
      if (name === 'data' && value === null) {
        result.data = null;
      } else if (name === 'relatedTarget' && value === null) {
        result.relatedTarget = null;
      } else if (typeof value === 'string') {
        result[name] = value.slice(0, EVENT_DATA_STRING_LIMITS[name]);
      }
    }

    for (const name of EVENT_DATA_BOOLEAN_FIELDS) {
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(source, name);
      } catch (error) {
        continue;
      }
      if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
          typeof descriptor.value === 'boolean') {
        result[name] = descriptor.value;
      }
    }

    for (const name of EVENT_DATA_NUMBER_FIELDS) {
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(source, name);
      } catch (error) {
        continue;
      }
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          typeof descriptor.value !== 'number' || !Number.isFinite(descriptor.value)) {
        continue;
      }
      const maximum = name === 'location' ? 3 : 4294967295;
      result[name] = Math.max(0, Math.min(maximum, Math.trunc(descriptor.value)));
    }
    return result;
  }

  function hasOwnValue(object, name) {
    return Object.prototype.hasOwnProperty.call(object, name);
  }

  function legacyInputEventValue(request, name) {
    if (!hasOwnValue(request, name))
      return { present: false };
    const value = request[name];
    if (name === 'data')
      return { present: true, value: value == null ? null : String(value) };
    if (name === 'isComposing')
      return { present: true, value: Boolean(value) };
    return { present: true, value: value == null ? '' : String(value) };
  }

  function resolveEventRelatedTarget(state, eventData) {
    if (typeof eventData.relatedTarget !== 'string')
      return null;
    const target = state.elementsById.get(eventData.relatedTarget);
    return target && target.ownerDocument === state.document && target.isConnected
      ? target
      : null;
  }

  const internalFormDataEventToken = {};

  class PircFormDataEvent extends GlobalEvent {
    constructor(type, init, internalToken) {
      const options = eventOptions(init);
      if (!options.formData || !activeState || !activeState.documentBinary ||
          !(options.formData instanceof activeState.documentBinary.FormData))
        throw new TypeError('FormDataEvent requires a FormData value.');
      super(type, options);
      defineEventMember(this, 'formData', options.formData);
      defineEventMember(this, 'composed', Boolean(options.composed));
      // Entry-list construction emits an implementation event. Public script
      // constructors remain untrusted; this flag grants no host user activation.
      defineEventMember(this, 'isTrusted', internalToken === internalFormDataEventToken);
    }
    preventDefault() {
      if (this.cancelable)
        super.preventDefault();
    }
  }

  class PircSubmitEvent extends GlobalEvent {
    constructor(type, init) {
      const options = init && typeof init === 'object' ? init : {};
      super(type, { bubbles: Boolean(options.bubbles), cancelable: Boolean(options.cancelable) });
      Object.defineProperty(this, 'submitter', {
        value: options.submitter == null ? null : options.submitter,
        enumerable: true,
        configurable: false,
        writable: false
      });
    }
  }

  function clearImagePropertyOverride(element, name) {
    const overrides = activeState?.imagePropertyOverrides.get(element);
    if (!overrides?.has(name)) return;
    element[name] = null;
    overrides.delete(name);
  }

  function PircDocumentImage() {
    if (!new.target) throw new TypeError('Image requires new.');
    return new activeState.images.Image(...arguments);
  }
  PircDocumentImage.prototype = HTMLImageElement.prototype;

  function installDocumentImages(view, document) {
    const state = activeState;
    state.images = createDocumentImages({
      document, HTMLElement, HTMLImageElement, Event: GlobalEvent,
      URL: pircUrlPolyfill.URL,
      baseUrl: currentDocumentBaseUrl,
      diagnostic,
      suppressMutations: () => state.cloningSnapshot === true,
      onEventPropertySet: function(image, type) {
        const name = 'on' + type;
        removeInlineHandler(image, name);
        let overrides = state.imagePropertyOverrides.get(image);
        if (!overrides) { overrides = new Set(); state.imagePropertyOverrides.set(image, overrides); }
        overrides.add(name);
      },
      enqueue: function(request) {
        if (!request.referrerPolicy) request.referrerPolicy = currentDocumentReferrerPolicy();
        if (request.kind === 'image' && typeof request.id === 'string')
          state.pendingImageRequests.add(request.id);
        state.resourceRequests.push(request);
      },
      cancel: function(id) {
        if (state) {
          const requestId = String(id);
          state.pendingImageRequests.delete(requestId);
          state.resourceCancellations.push(requestId);
        }
      }
    });
    state.images.install();
    defineGlobal('Image', PircDocumentImage, false);
    defineGlobal('HTMLImageElement', HTMLImageElement, false);
    Object.defineProperty(view, 'Image', {value:PircDocumentImage,writable:false,configurable:false});
  }

  function patchDomMutationHooks() {
    patchClickEventHooks();
    patchAnchorProperties();
    patchClickActivation();
    patchFocusEventHooks();
    patchOnclickProperty();
    patchPointerHandlerProperties();
    patchFormDataProperty();
    const originalSetAttribute = Element$1.prototype.setAttribute;
    Element$1.prototype.setAttribute = function(name, value) {
      const result = originalSetAttribute.call(this, name, value);
      const state = activeState;
      const normalized = String(name).toLowerCase();
      if (state && this.ownerDocument === state.document &&
          normalized.slice(0, 2) === 'on') {
        if (normalized === 'onclick')
          clearOnclickPropertyOverride(this);
        clearPointerPropertyOverride(this, normalized);
        clearImagePropertyOverride(this, normalized);
        installInlineHandler(this, normalized, String(value), true);
      }
      if (state && this.ownerDocument === state.document &&
          String(this.localName || '').toLowerCase() === 'script' &&
          normalized === 'src') {
        prepareDynamicScript(this);
      }
      return result;
    };

    const originalRemoveAttribute = Element$1.prototype.removeAttribute;
    Element$1.prototype.removeAttribute = function(name) {
      const normalized = String(name).toLowerCase();
      const hadAttribute = this.hasAttribute(name);
      const result = originalRemoveAttribute.call(this, name);
      const state = activeState;
      if (state && this.ownerDocument === state.document &&
          normalized.slice(0, 2) === 'on') {
        if (normalized === 'onclick')
          clearOnclickPropertyOverride(this);
        clearPointerPropertyOverride(this, normalized);
        if (hadAttribute) clearImagePropertyOverride(this, normalized);
        if (!(normalized === 'onformdata' || dialogEventHandlerTypes.has(normalized.slice(2))) || hadAttribute)
          removeInlineHandler(this, normalized);
      }
      return result;
    };

    const originalInnerHtml = Object.getOwnPropertyDescriptor(Element$1.prototype, 'innerHTML');
    if (originalInnerHtml && originalInnerHtml.set) {
      Object.defineProperty(Element$1.prototype, 'innerHTML', {
        get: originalInnerHtml.get,
        set: function(value) {
          const state = activeState;
          const owned = state && this.ownerDocument === state.document;
          const wasInertInsertion = owned && state.insertingInertScripts;
          if (owned)
            state.insertingInertScripts = true;
          try {
            originalInnerHtml.set.call(this, value);
          } finally {
            if (owned)
              state.insertingInertScripts = wasInertInsertion;
          }
          if (owned) {
            markInertScripts(this);
            decorateTree(this);
          }
        },
        configurable: true,
        enumerable: originalInnerHtml.enumerable
      });
    }

    const originalInsertBefore = ParentNode.prototype.insertBefore;
    ParentNode.prototype.insertBefore = function(node, before) {
      const state = activeState;
      if (state && (this === state.document || this.ownerDocument === state.document))
        registerTree(node);
      const inserted = originalInsertBefore.call(this, node, before);
      if (state && (this === state.document || this.ownerDocument === state.document))
        decorateTree(node);
      if (state && (this === state.document || this.ownerDocument === state.document))
        prepareDynamicScripts(node);
      return inserted;
    };
  }

  function markInitialDocument(document) {
    const state = activeState;
    registerTree(document);
    initializeDetails(document, true);
    decorateTree(document);
    const elements = document.querySelectorAll('*');
    for (const element of elements)
      ensureElementId(element);
  }

  function applyControl(control) {
    const state = activeState;
    if (!control || typeof control !== 'object')
      return;
    const id = String(control.id == null ? '' : control.id);
    const element = state.elementsById.get(id);
    if (!element || element.ownerDocument !== state.document || !element.isConnected) {
      diagnostic(
        'dispatch.unknown_control',
        'warning',
        'Control state referenced an unknown or detached DOM element.',
        { id: id }
      );
      return;
    }

    const tag = String(element.localName || '').toLowerCase();
    if (tag === 'input' && (element.type || '').toLowerCase() === 'file' && Array.isArray(control.files)) {
      const currentVersion = fileResetVersions.get(element) || 0;
      if (String(control.fileResetVersion ?? '0') === String(currentVersion)) {
        const previous = fileHostSnapshots.get(element);
        const keys = ['name', 'type', 'size', 'lastModified', 'bytesBase64', 'contentError'];
        const unchanged = previous && previous.length === control.files.length &&
          previous.every((file, index) => keys.every(key => file[key] === control.files[index][key]));
        if (!unchanged) {
          const imported = control.files.map((file, index) =>
            state.documentBinary.fileFromHost(file, {
              controlId: id, resetVersion: String(currentVersion), index: index
            })
          );
          fileSelections.set(element, imported);
          fileHostSnapshots.set(element, control.files.map(file => {
            const copy = {};
            for (const key of keys) copy[key] = file[key];
            return copy;
          }));
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(control, 'value')) {
      const value = String(control.value == null ? '' : control.value);
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        element.value = value;
      } else {
        diagnostic(
          'dispatch.control_value_unsupported',
          'warning',
          'The value state was ignored because this element is not a supported form control.',
          { id: id, tag: tag }
        );
      }
    }

    if (Object.prototype.hasOwnProperty.call(control, 'userEdited') ||
        Object.prototype.hasOwnProperty.call(control, 'badInput')) {
      const previous = userInputState.get(element) || {};
      userInputState.set(element, {
        userEdited: Object.prototype.hasOwnProperty.call(control, 'userEdited')
          ? Boolean(control.userEdited)
          : Boolean(previous.userEdited),
        badInput: Object.prototype.hasOwnProperty.call(control, 'badInput')
          ? Boolean(control.badInput)
          : Boolean(previous.badInput)
      });
    }

    if (Object.prototype.hasOwnProperty.call(control, 'checked')) {
      if (tag === 'input') {
        element.checked = Boolean(control.checked);
      } else {
        diagnostic(
          'dispatch.control_checked_unsupported',
          'warning',
          'The checked state was ignored because this element is not an input.',
          { id: id, tag: tag }
        );
      }
    }

    if (Object.prototype.hasOwnProperty.call(control, 'selectedValues')) {
      if (tag !== 'select' || !Array.isArray(control.selectedValues)) {
        diagnostic(
          'dispatch.control_selection_unsupported',
          'warning',
          'selectedValues requires a select element and an array.',
          { id: id, tag: tag }
        );
      } else {
        const selected = new Set(control.selectedValues.map(String));
        const indices = Array.isArray(control.selectedIndices) ? new Set(control.selectedIndices.map(Number)) : null;
        let any = false;
        for (let index = 0; index < element.options.length; index++) {
          const option = element.options[index];
          const match = indices ? indices.has(index) : selected.has(option.value);
          liveSelected.set(option, match);
          any = any || match;
        }
        if (any) emptySelects.delete(element); else emptySelects.add(element);
      }
    }
  }

  function synchronizeFormState(originalDocument, snapshotDocument) {
    const copies = new Map();
    for (const copy of snapshotDocument.querySelectorAll('*')) {
      const id = copy.getAttribute(MARKER_ATTRIBUTE);
      if (id)
        copies.set(id, copy);
    }

    for (const original of originalDocument.querySelectorAll('*')) {
      const id = original.getAttribute(MARKER_ATTRIBUTE);
      const copy = id && copies.get(id);
      if (!copy)
        continue;
      const tag = String(original.localName || '').toLowerCase();
      if (tag === 'input') {
        if ((original.type || '').toLowerCase() === 'file') {
          copy.setAttribute('data-pirc-file-reset-version', String(fileResetVersions.get(original) || 0));
        }
        copy.setAttribute('data-pirc-history-default-value', String(original.defaultValue == null ? '' : original.defaultValue));
        copy.setAttribute('value', String(original.value == null ? '' : original.value));
        if (original.checked)
          copy.setAttribute('checked', '');
        else
          copy.removeAttribute('checked');
      } else if (tag === 'textarea') {
        copy.setAttribute('data-pirc-history-default-value', String(original.defaultValue == null ? '' : original.defaultValue));
        copy.textContent = String(original.value == null ? '' : original.value);
      } else if (tag === 'option') {
        if (original.selected)
          copy.setAttribute('selected', '');
        else
          copy.removeAttribute('selected');
      }
    }
  }

  function snapshotDocumentHtml(state) {
    const cloneAndSerialize = function() {
      const snapshotDocument = state.document.cloneNode(true);
      synchronizeFormState(state.document, snapshotDocument);
      for (const element of snapshotDocument.querySelectorAll('[data-pirc-dialog-modal]'))
        element.removeAttribute('data-pirc-dialog-modal');
      for (const dialog of state.modalDialogs) {
        if (!dialog.isConnected || !dialog.hasAttribute('open')) continue;
        const id = ensureElementId(dialog);
        const copy = snapshotDocument.querySelector('[data-pirc-script-id="' + id + '"]');
        if (copy) copy.setAttribute('data-pirc-dialog-modal', String(state.modalDialogs.indexOf(dialog) + 1));
      }
      const scripts = snapshotDocument.querySelectorAll('script');
      for (const script of scripts)
        script.remove();
      return snapshotDocument.toString();
    };
    // LinkeDOM may report clone-side form-state annotations and removals to
    // the source document's observer. Keep every private-snapshot mutation in
    // one suppression scope, while callers still decorate and prepare images
    // on the real document before entering this helper.
    const serializeWithoutLayoutMutations = () =>
      state.layout && typeof state.layout.runWithoutMutationInvalidation === 'function'
        ? state.layout.runWithoutMutationInvalidation(cloneAndSerialize)
        : cloneAndSerialize();
    return state.mutationObservers
      ? state.mutationObservers.runWithoutMutations(serializeWithoutLayoutMutations)
      : serializeWithoutLayoutMutations();
  }

  function snapshotHtml() {
    const state = activeState;
    if (!state || !state.document)
      return '';

    try {
      decorateTree(state.document);
      state.images?.prepareTree(state.document);
      let html;
      state.cloningSnapshot = true;
      try { html = snapshotDocumentHtml(state); }
      finally { state.cloningSnapshot = false; }
      if (utf8ByteLength(html) > MAX_OUTPUT_BYTES) {
        diagnostic(
          'runtime.output_limit',
          'error',
          'The serialized document exceeds the ' + MAX_OUTPUT_BYTES + ' byte output limit.'
        );
        return '';
      }
      return html;
    } catch (error) {
      diagnostic('runtime.snapshot_error', 'error', exceptionMessage(error));
      return '';
    }
  }

  function syncDocumentStylesheets() {
    const state = activeState;
    if (!state || !state.stylesheets) return null;
    const snapshot = state.stylesheets.snapshot();
    state.stylesheetSnapshot = {sheets: snapshot.sheets, links: snapshot.links};
    const layoutStylesSignature = JSON.stringify(state.stylesheetSnapshot);
    if (state.layoutStylesSignature != null &&
        state.layoutStylesSignature !== layoutStylesSignature) state.layout?.invalidate();
    state.layoutStylesSignature = layoutStylesSignature;
    state.pendingStylesheetLoads = snapshot.pendingLoadCount;
    const descriptors = new Map(snapshot.sheets.concat(snapshot.links).map(item => [item.ownerId, item]));
    for (const request of snapshot.requests) {
      const descriptor = descriptors.get(request.ownerId);
      if (!descriptor) continue;
      const rawCrossOrigin = descriptor.crossorigin;
      const crossOrigin = rawCrossOrigin == null ? null :
        String(rawCrossOrigin).trim().toLowerCase() === 'use-credentials' ? 'use-credentials' : 'anonymous';
      const fetchOptions = {crossOrigin, integrity: descriptor.integrity || null,
        referrerPolicy: normalizeReferrerPolicy(descriptor.referrerpolicy || '') || currentDocumentReferrerPolicy(),
        stylesheetReferrerUrl: state.url};
      state.stylesheetRequestOptions.set(request.id, fetchOptions);
      state.resourceRequests.push(Object.assign({}, request, fetchOptions, {
        url: descriptor.fetchHref || undefined,
        // Inline source is already owned by JS; external response bytes never
        // cross into the isolate, including in resource completions.
        cssText: descriptor.ownerType === 'style' ? descriptor.cssText : undefined
      }));
    }
    const currentIds = new Set();
    for (const descriptor of descriptors.values()) {
      currentIds.add(descriptor.transportId);
      const fetchOptions = state.stylesheetRequestOptions.get(descriptor.transportId);
      if (fetchOptions) Object.assign(descriptor, fetchOptions);
    }
    for (const id of state.stylesheetRequestOptions.keys())
      if (!currentIds.has(id)) state.stylesheetRequestOptions.delete(id);
    for (const cancellation of snapshot.cancellations)
      state.resourceCancellations.push(cancellation.id);
    return state.stylesheetSnapshot;
  }

  function response(extra) {
    syncDocumentStylesheets();
    if (activeState && activeState.document) dispatchDocumentLoadIfReady();
    const value = {
      html: snapshotHtml(),
      layout: activeState?.layout ? Object.assign(activeState.layout.status(), {
        ids: activeState.hostLayout ? Array.from(activeState.elementsById, ([id, element]) =>
          element.isConnected ? id : null).filter(Boolean) : []
      }) : null,
      documentBaseURL: activeState && activeState.document ? currentDocumentBaseUrl() : null,
      fragmentTargetId: activeState?.fragmentTarget ? ensureElementId(activeState.fragmentTarget) : null,
      modalDialogIds: activeState ? activeState.modalDialogs
        .filter(dialog => dialog.isConnected && dialog.hasAttribute('open'))
        .map(ensureElementId) : [],
      fragmentTargetReady: activeState?.domContentLoaded === true && !activeState.fragmentAncestorTask,
      fragmentAncestorsRevealed: activeState?.fragmentAncestorsRevealed === true,
      initialRootScrollOverride: activeState?.initialRootScrollOverride === true,
      stylesheets: activeState ? activeState.stylesheetSnapshot : null,
      environment: activeState && activeState.media ? activeState.media.snapshot() : null,
      canvases: activeState && activeState.canvas ? activeState.canvas.snapshots() : [],
      imageReferences: activeState?.images?.retainedImageIds() || [],
      htmlImages: activeState?.images
        ? Array.from(activeState.document.querySelectorAll('img')).flatMap(image => {
          const state = activeState.images.renderState(image);
          return state ? [{id: ensureElementId(image), ...state}] : [];
        }) : [],
      diagnostics: activeState ? activeState.diagnostics.slice() : [],
      now: activeState ? activeState.now : 0,
      scheduler: schedulerSnapshot(),
      frameContinuation: activeState?.nativeAnimationFrame
        ? {id: activeState.nativeAnimationFrame.id} : null,
      classicScript: activeState && activeState.classicScriptTasks.length
        ? {id: activeState.classicScriptTasks[0].id} : null,
      cookieWrites: activeState && activeState.cookies ? activeState.cookies.drain() : [],
      storageWritesPending: activeState && activeState.storage ? activeState.storage.hasWrites() : false,
      resourceRequests: activeState
        ? activeState.resourceRequests.splice(0).filter(request =>
            !(request && ['fetch', 'image'].includes(request.kind) && request.cancelled === true)
          )
        : [],
      resourceCancellations: activeState
        ? Array.from(new Set(activeState.resourceCancellations.splice(0)))
        : [],
      filePickerActions: activeState ? activeState.filePickerActions.splice(0) : [],
      formActions: activeState ? activeState.formActions.splice(0) : [],
      focusActions: activeState ? activeState.focusActions.splice(0) : [],
      navigationActions: activeState
        ? Object.freeze(activeState.navigationActions.splice(0))
        : [],
      scrollActions: activeState ? activeState.scrollActions.splice(0) : []
    };
    if (extra && typeof extra === 'object') {
      for (const key of Object.keys(extra))
        value[key] = extra[key];
    }
    let serialized = JSON.stringify(value);
    if (utf8ByteLength(serialized) > MAX_OUTPUT_BYTES) {
      diagnostic(
        'runtime.output_limit',
        'error',
        'The serialized runtime response exceeds the ' + MAX_OUTPUT_BYTES + ' byte output limit.'
      );
      value.html = '';
      value.canvases = [];
      value.diagnostics = activeState ? activeState.diagnostics.slice() : [];
      serialized = JSON.stringify(value);
    }
    return serialized;
  }

  function runScripts() {
    const state = activeState;
    const scripts = Array.from(state.document.querySelectorAll('script'));
    state.initialScripts = new WeakSet(scripts);
    state.initialScriptIndexes = new WeakMap();
    for (let index = 0; index < scripts.length; index++)
      state.initialScriptIndexes.set(scripts[index], index);
    state.parserScripts = scripts;
    state.parserIndex = 0;
    state.deferScripts = [];
    state.deferIndex = 0;
    state.parserPaused = false;
    state.parserExecuting = false;
    state.parserDone = false;
    state.deferExecuting = false;
    state.domContentLoaded = false;
    state.loadDispatched = false;
    state.readyState = 'loading';
    state.currentScript = null;
    state.processedScripts = new WeakSet();
    state.importMaps = createPircDocumentImportMaps({URL: pircUrlPolyfill.URL,
      diagnostic: function(level, message) {diagnostic('script.import_map_warning', level, message);}
    });
    state.moduleGraph = createPircDocumentModules({
      resolve: function(specifier, base) {return state.importMaps.resolve(specifier, base);},
      integrityFor: function(url) {return state.importMaps.integrityFor(url);},
      compiler: createPircDocumentModuleCompiler(pircModuleParser),
      URL: pircUrlPolyfill.URL,
      documentUrl: state.sourceDocumentUrl,
      pending: function(delta) {state.modulePreparations += delta;},
      fetch: function(url, options) {
        return new Promise(function(resolve, reject) {
          const id = 'script-' + state.nextScriptRequestId++;
          state.scriptResources.set(id, {moduleFetch: true, resolve, reject});
          state.resourceRequests.push({id, kind: 'script', type: 'module', url,
            crossOrigin: options.crossOrigin || null,
            integrity: options.integrity || null,
            moduleReferrerUrl: options.moduleReferrerUrl || state.sourceDocumentUrl,
            referrerPolicy: options.referrerPolicy || currentDocumentReferrerPolicy()});
        });
      },
      limitation: function(message, url) {
        diagnostic('script.module_semantics_limit', 'warning', message, {url});
      }
    });
    rewriteClassicImports('', null);
    continueParserScripts();
  }

  function isImportMap(script) {
    return String(script.getAttribute('type') || '').trim().toLowerCase() === 'importmap';
  }

  function prepareImportMap(script) {
    const state = activeState;
    state.processedScripts.add(script);
    if (script.hasAttribute('src')) {
      diagnostic('script.import_map_external', 'warning', 'External import maps are rejected by browsers.');
      dispatchScriptEvent(script, 'error');
      return;
    }
    try {state.importMaps.add(String(script.textContent || ''), currentDocumentBaseUrl());}
    catch (error) {diagnostic('script.import_map_error', 'error', exceptionMessage(error));}
  }

  function isModuleScript(script) {
    return String(script.getAttribute('type') || '').trim().toLowerCase() === 'module';
  }

  function queueModuleScript(script, mode) {
    const state = activeState;
    state.processedScripts.add(script);
    const record = {module: true, script, scriptIndex: scriptIndexOf(script), mode, done: false, root: null, error: null};
    state.pendingScriptLoads++;
    state.modulePreparations++;
    const rawCrossOrigin = script.hasAttribute('crossorigin')
      ? asciiLower(trimAsciiWhitespace(script.getAttribute('crossorigin') || '')) : null;
    const fetchOptions = {
      crossOrigin: rawCrossOrigin === 'use-credentials' ? 'use-credentials' : 'anonymous',
      integrity: script.getAttribute('integrity') || null,
      referrerPolicy: normalizeReferrerPolicy(script.getAttribute('referrerpolicy') || '') || currentDocumentReferrerPolicy(),
      moduleReferrerUrl: state.sourceDocumentUrl
    };
    let prepared;
    try {
      prepared = script.hasAttribute('src')
        ? state.moduleGraph.external(resolveScriptUrl(script), fetchOptions)
        : state.moduleGraph.inline(String(script.textContent || ''), currentDocumentBaseUrl(), fetchOptions);
    } catch (error) {prepared = Promise.reject(error);}
    Promise.resolve(prepared).then(function(root) {
      record.root = root;
    }, function(error) {
      record.error = error;
    }).then(function() {
      record.done = true;
      state.modulePreparations--;
      if (record.mode === 'defer') continueDeferredScripts();
      else executeModuleScript(record);
    });
    return record;
  }

  function executeModuleScript(record) {
    const state = activeState;
    if (record.executed) return;
    // Native Script execution crosses an IPC boundary. Module preparation may
    // settle at that boundary, but its body must not run with a classic script's
    // currentScript or before the preceding Script has actually been evaluated.
    if (state.classicScriptTasks.length || layoutNeedsUpdate()) {
      if (!state.readyModuleScripts.includes(record)) state.readyModuleScripts.push(record);
      return;
    }
    record.executed = true;
    state.pendingScriptLoads = Math.max(0, state.pendingScriptLoads - 1);
    if (record.error) {
      diagnostic('script.module_load_error', 'error', exceptionMessage(record.error), {scriptIndex: record.scriptIndex});
      dispatchScriptEvent(record.script, 'error');
    } else {
      try {
        // Evaluation starts synchronously; TLA completion does not block DCL or window load.
        state.moduleGraph.execute(record.root).catch(function(error) {
          diagnostic('script.module_runtime_error', 'error', exceptionMessage(error), {scriptIndex: record.scriptIndex});
        });
        dispatchScriptEvent(record.script, 'load');
      } catch (error) {
        diagnostic('script.module_runtime_error', 'error', exceptionMessage(error), {scriptIndex: record.scriptIndex});
      }
    }
    dispatchDocumentLoadIfReady();
  }

  function isClassicScript(script, scriptIndex) {
    const type = String(script.getAttribute('type') || '').trim().toLowerCase();
    if ([
      '',
      'text/javascript',
      'application/javascript',
      'application/ecmascript',
      'text/ecmascript',
      'text/jscript',
      'text/livescript'
    ].includes(type)) {
      return !script.hasAttribute('nomodule');
    }
    diagnostic(
      'script.non_classic_skipped',
      'info',
      'Non-classic script data blocks are not executed and are removed from the rendered snapshot.',
      { scriptIndex: scriptIndex, type: type.slice(0, 120) }
    );
    return false;
  }

  function dispatchScriptEvent(script, type) {
    try {
      script.dispatchEvent(new GlobalEvent(type, {
        bubbles: false,
        cancelable: false
      }));
    } catch (error) {
      diagnostic(
        'script.event_error',
        'warning',
        exceptionMessage(error),
        { event: type, id: ensureElementId(script) }
      );
    }
  }

  function rewriteClassicImports(source, context, allowReturnOutsideFunction) {
    const state = activeState;
    if (!state.classicImports) state.classicImports = createPircDocumentClassicImports({
      parser: pircModuleParser, global: globalThis, globalEval: eval, nonce: state.objectUrlNonce,
      importModule: function(specifier, attributes, sourceContext) {
        const base = typeof sourceContext.baseURL === 'function' ? sourceContext.baseURL() : sourceContext.baseURL;
        return state.moduleGraph.import(specifier, base, attributes, sourceContext.fetchOptions);
      }
    });
    return state.classicImports.rewrite(source, context || {
      baseURL: function() {return state.url;},
      fetchOptions: {moduleReferrerUrl: state.sourceDocumentUrl, crossOrigin: 'anonymous',
        referrerPolicy: currentDocumentReferrerPolicy()}
    }, {allowReturnOutsideFunction: allowReturnOutsideFunction === true});
  }

  function classicSourceContext(script, sourceContext) {
    const state = activeState;
    return sourceContext || {baseURL: currentDocumentBaseUrl(), fetchOptions: {
      moduleReferrerUrl: state.sourceDocumentUrl, crossOrigin: 'anonymous',
      referrerPolicy: normalizeReferrerPolicy(script.getAttribute('referrerpolicy') || '') || currentDocumentReferrerPolicy()
    }};
  }

  function decorateAfterScript(scriptIndex) {
    try {decorateTree(activeState.document);}
    catch (error) {
      diagnostic('runtime.dom_update_error', 'error', exceptionMessage(error), {scriptIndex});
    }
  }

  function reportClassicError(error, scriptIndex) {
    diagnostic('script.runtime_error', 'error', exceptionMessage(error), {
      scriptIndex, stack: String(error && error.stack ? error.stack : '').slice(0, 1200)
    });
  }

  function executeScriptSource(script, source, scriptIndex, sourceContext, onComplete) {
    const state = activeState;
    source = String(source || '');
    if (!source.trim()) {
      if (onComplete) onComplete();
      return false;
    }
    // This source is evaluated as a real Script by the native persistent realm.
    // Do not wrap it in eval/Function: doing so loses global lexical bindings and
    // strict-mode var/function declarations between script elements.
    state.classicScriptTasks.push({id: state.nextClassicScriptId++, script,
      source, scriptIndex, sourceContext: classicSourceContext(script, sourceContext),
      onComplete, begun: false, ended: false, preparationError: null,
      previousCurrentScript: null});
    return true;
  }

  function currentClassicTask(input, requireBegun) {
    const state = activeState;
    const task = state && state.classicScriptTasks[0];
    if (!task || !input || input.id !== task.id ||
        (requireBegun && !task.begun))
      throw new Error('Invalid or stale native classic Script task.');
    return task;
  }

  function beginClassicScript(input) {
    const task = currentClassicTask(input, false);
    if (task.begun) return JSON.stringify({id: task.id, source: task.rewrittenSource});
    let source;
    try {source = rewriteClassicImports(task.source, task.sourceContext);}
    catch (error) {task.preparationError = error; source = '';}
    task.rewrittenSource = source;
    task.begun = true;
    task.previousCurrentScript = activeState.currentScript;
    activeState.currentScript = task.script;
    // No response() here: requests, cookies and actions must remain pending for
    // finishClassicScript, rather than being drained by this source-only reply.
    return JSON.stringify({id: task.id, source});
  }

  function endClassicScriptTurn(id) {
    const task = currentClassicTask({id}, true);
    // Chromium keeps currentScript during the Script's microtask checkpoint.
    // The native engine performs that checkpoint before returning across IPC;
    // finishClassicScript restores currentScript afterward, including on throw.
    task.ended = true;
  }

  function finishClassicScript(input) {
    const state = activeState;
    const task = currentClassicTask(input, true);
    endClassicScriptTurn(task.id);
    state.currentScript = task.previousCurrentScript;
    state.classicScriptTasks.shift();
    if (task.preparationError) reportClassicError(task.preparationError, task.scriptIndex);
    else if (typeof input.error === 'string') reportClassicError(input.error, task.scriptIndex);
    decorateAfterScript(task.scriptIndex);
    // Resume the parser/deferred chain before releasing ready async modules.
    // IPC checkpoints must not turn module-preparation microtasks into an
    // opportunity to interrupt consecutive parser classic scripts or early DCL.
    if (task.onComplete) task.onComplete();
    continueDeferredScripts();
    dispatchDOMContentLoadedIfReady();
    while (!state.classicScriptTasks.length && !layoutNeedsUpdate() && state.readyModuleScripts.length)
      executeModuleScript(state.readyModuleScripts.shift());
    return response();
  }

  function executeDynamicInlineScript(script, source) {
    const state = activeState;
    const previousCurrentScript = state.currentScript;
    state.currentScript = script;
    try {
      // DOM insertion is synchronous, including insertion inside another guest
      // script/callback. AndroidX has no reentrant host evaluation callback.
      // Keep synchronous effects here and explicitly expose the remaining
      // lexical-declaration limitation rather than silently deferring insertion.
      const ast = pircModuleParser.parse(source, {ecmaVersion: 'latest', sourceType: 'script'});
      const strict = ast.body.some(node => node.type === 'ExpressionStatement' && node.directive === 'use strict');
      if (ast.body.some(node => node.type === 'ClassDeclaration' ||
          node.type === 'VariableDeclaration' && (node.kind !== 'var' || strict) ||
          strict && node.type === 'FunctionDeclaration'))
        diagnostic('script.dynamic_inline_global_scope_limit', 'warning',
          'Synchronous DOM-inserted inline scripts cannot retain global lexical or strict declarations across scripts in the native engine.');
      (0, eval)(rewriteClassicImports(source, classicSourceContext(script)));
    } catch (error) {reportClassicError(error, null);}
    finally {state.currentScript = previousCurrentScript;}
    decorateAfterScript(null);
  }

  function scriptIndexOf(script) {
    const state = activeState;
    return state.initialScriptIndexes && state.initialScriptIndexes.has(script)
      ? state.initialScriptIndexes.get(script)
      : null;
  }

  function resolveScriptUrl(script) {
    const src = String(script.getAttribute('src') || '');
    try {
      return new pircUrlPolyfill.URL(src, currentDocumentBaseUrl()).href;
    } catch (error) {
      diagnostic(
        'script.invalid_url',
        'warning',
        'The external script URL could not be resolved.',
        { src: src.slice(0, 500), id: ensureElementId(script) }
      );
      return null;
    }
  }

  function queueExternalScript(script, mode) {
    const state = activeState;
    const url = resolveScriptUrl(script);
    if (!url) {
      state.processedScripts.add(script);
      dispatchScriptEvent(script, 'error');
      return null;
    }
    const id = 'script-' + state.nextScriptRequestId++;
    const record = {
      id: id,
      script: script,
      url: url,
      mode: mode,
      scriptIndex: scriptIndexOf(script),
      done: false,
      ok: false,
      source: '',
      error: '',
      blocksLoad: mode !== 'dynamic' || !state.loadDispatched
    };
    state.processedScripts.add(script);
    state.scriptResources.set(id, record);
    if (record.blocksLoad)
      state.pendingScriptLoads += 1;
    const rawCrossOrigin = script.hasAttribute('crossorigin')
      ? asciiLower(trimAsciiWhitespace(script.getAttribute('crossorigin') || ''))
      : null;
    const crossOrigin = rawCrossOrigin == null
      ? null
      : rawCrossOrigin === '' || rawCrossOrigin === 'anonymous' ||
          rawCrossOrigin === 'use-credentials'
        ? rawCrossOrigin
        : 'anonymous';
    const scriptReferrerPolicy = script.hasAttribute('referrerpolicy')
      ? normalizeReferrerPolicy(script.getAttribute('referrerpolicy') || '')
      : null;
    record.fetchOptions = {crossOrigin: crossOrigin === 'use-credentials' ? 'use-credentials' : 'anonymous',
      referrerPolicy: scriptReferrerPolicy || currentDocumentReferrerPolicy()};
    state.resourceRequests.push({
      id: id,
      kind: 'script',
      url: url,
      type: String(script.getAttribute('type') || ''),
      crossOrigin: crossOrigin,
      integrity: script.hasAttribute('integrity')
        ? String(script.getAttribute('integrity') || '')
        : null,
      referrerPolicy: scriptReferrerPolicy || currentDocumentReferrerPolicy()
    });
    return record;
  }

  function executeExternalScript(record, onComplete) {
    if (record.ok) {
      return executeScriptSource(record.script, record.source, record.scriptIndex, {
        baseURL: record.url, fetchOptions: {...record.fetchOptions, moduleReferrerUrl: record.url}
      }, function() {
        dispatchScriptEvent(record.script, 'load');
        if (onComplete) onComplete();
      });
    }
    diagnostic(
      'script.external_load_error',
      'warning',
      record.error || 'The external classic script could not be loaded.',
      {
        scriptIndex: record.scriptIndex,
        id: ensureElementId(record.script)
      }
    );
    dispatchScriptEvent(record.script, 'error');
    if (onComplete) onComplete();
    return false;
  }

  function dispatchDocumentLoadIfReady() {
    const state = activeState;
    syncDocumentStylesheets();
    if (!state.domContentLoaded || state.loadDispatched ||
        state.pendingScriptLoads > 0 || state.pendingStylesheetLoads > 0 ||
        state.classicScriptTasks.length > 0 || layoutNeedsUpdate())
      return;
    state.readyState = 'complete';
    state.loadDispatched = true;
    state.loadEventDispatching = true;
    try {
      state.window.dispatchEvent(
        new GlobalEvent('load', { bubbles: false, cancelable: false })
      );
    } catch (error) {
      diagnostic(
        'event.lifecycle_error',
        'error',
        exceptionMessage(error),
        { event: 'load' }
      );
    } finally { state.loadEventDispatching = false; }
  }

  function dispatchDOMContentLoadedIfReady() {
    const state = activeState;
    if (!state.parserDone || state.deferIndex < state.deferScripts.length ||
        state.domContentLoaded || state.classicScriptTasks.length > 0 || layoutNeedsUpdate())
      return;
    state.readyState = 'interactive';
    state.domContentLoaded = true;
    try {
      state.document.dispatchEvent(
        new GlobalEvent('DOMContentLoaded', { bubbles: false, cancelable: false })
      );
    } catch (error) {
      diagnostic(
        'event.lifecycle_error',
        'error',
        exceptionMessage(error),
        { event: 'DOMContentLoaded' }
      );
    }
    selectFragmentTarget(state.url, true);
    state.initialFragmentSelected = true;
    dispatchDocumentLoadIfReady();
  }

  function continueDeferredScripts() {
    const state = activeState;
    if (!state.parserDone || state.deferExecuting || state.classicScriptTasks.length || layoutNeedsUpdate())
      return;
    state.deferExecuting = true;
    try {
      while (state.deferIndex < state.deferScripts.length) {
        const record = state.deferScripts[state.deferIndex];
        if (!record.done)
          return;
        state.deferIndex += 1;
        if (record.module) executeModuleScript(record);
        else if (executeExternalScript(record, continueDeferredScripts)) return;
      }
    } finally {
      state.deferExecuting = false;
    }
    dispatchDOMContentLoadedIfReady();
  }

  function continueParserScripts() {
    const state = activeState;
    if (state.parserPaused || state.parserExecuting || state.parserDone)
      return;
    state.parserExecuting = true;
    try {
      while (state.parserIndex < state.parserScripts.length) {
        const script = state.parserScripts[state.parserIndex];
        const scriptIndex = state.parserIndex;
        state.parserIndex += 1;
        if (!script.isConnected)
          continue;
        if (isImportMap(script)) {
          prepareImportMap(script);
          continue;
        }
        if (isModuleScript(script)) {
          const mode = script.hasAttribute('async') ? 'async' : 'defer';
          const module = queueModuleScript(script, mode);
          if (mode === 'defer') state.deferScripts.push(module);
          continue;
        }
        if (!isClassicScript(script, scriptIndex))
          continue;
        if (script.hasAttribute('src')) {
          if (script.hasAttribute('async')) {
            queueExternalScript(script, 'async');
          } else if (script.hasAttribute('defer')) {
            const deferred = queueExternalScript(script, 'defer');
            if (deferred)
              state.deferScripts.push(deferred);
          } else {
            const blocking = queueExternalScript(script, 'parser');
            if (blocking) {
              state.parserPaused = true;
              return;
            }
          }
          continue;
        }
        state.processedScripts.add(script);
        state.parserPaused = true;
        if (executeScriptSource(script, String(script.textContent || ''), scriptIndex, null, function() {
          state.parserPaused = false;
          continueParserScripts();
        })) return;
      }
      state.parserDone = true;
      state.readyState = 'interactive';
    } finally {
      state.parserExecuting = false;
    }
    continueDeferredScripts();
  }

  function prepareDynamicScript(script) {
    const state = activeState;
    if (!state || !script || script.ownerDocument !== state.document ||
        !script.isConnected || state.insertingInertScripts ||
        state.inertScripts.has(script) || state.initialScripts.has(script) ||
        state.processedScripts.has(script))
      return;

    if (isImportMap(script)) {
      prepareImportMap(script);
      return;
    }
    if (isModuleScript(script)) {
      queueModuleScript(script, 'dynamic');
      return;
    }
    if (!isClassicScript(script, null)) {
      state.processedScripts.add(script);
      return;
    }
    if (script.hasAttribute('src')) {
      queueExternalScript(script, 'dynamic');
      return;
    }
    const source = String(script.textContent || '');
    if (!source.trim())
      return;
    state.processedScripts.add(script);
    executeDynamicInlineScript(script, source);
  }

  function prepareDynamicScripts(root) {
    if (!root)
      return;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node)
        continue;
      if (node.nodeType === 1 &&
          String(node.localName || '').toLowerCase() === 'script') {
        prepareDynamicScript(node);
      }
      const children = node.childNodes;
      if (children) {
        for (let index = children.length - 1; index >= 0; index--)
          stack.push(children[index]);
      }
    }
  }

  function markInertScripts(root) {
    const state = activeState;
    if (!state || !root)
      return;
    const scripts = [];
    if (root.nodeType === 1 &&
        String(root.localName || '').toLowerCase() === 'script') {
      scripts.push(root);
    }
    if (root.querySelectorAll) {
      for (const script of root.querySelectorAll('script'))
        scripts.push(script);
    }
    for (const script of scripts) {
      state.inertScripts.add(script);
      if (state.processedScripts)
        state.processedScripts.add(script);
    }
  }

  function settleScriptResource(record, completion) {
    const state = activeState;
    if (!record || record.done)
      return;
    record.done = true;
    record.ok = completion.ok === true;
    record.source = typeof completion.source === 'string' ? completion.source : '';
    if (typeof completion.url === 'string') record.url = completion.url;
    if (completion.referrerPolicy) record.fetchOptions.referrerPolicy = completion.referrerPolicy;
    record.error = typeof completion.error === 'string' ? completion.error : '';
    state.scriptResources.delete(record.id);
    if (record.blocksLoad)
      state.pendingScriptLoads = Math.max(0, state.pendingScriptLoads - 1);

    if (record.mode === 'parser') {
      executeExternalScript(record, function() {
        state.parserPaused = false;
        continueParserScripts();
      });
    } else if (record.mode === 'defer') {
      continueDeferredScripts();
    } else {
      executeExternalScript(record);
    }
    dispatchDocumentLoadIfReady();
  }

  function normalizeHostDocumentTree(document) {
    const existingRoot = document.documentElement?.localName === 'html'
      ? document.documentElement : null;
    if (existingRoot && ['head', 'body'].every(name =>
      Array.from(existingRoot.children).some(child => child.localName === name))) return;
    const root = existingRoot || document.createElement('html');
    let head = document.createElement('head');
    let body = document.createElement('body');
    let bodyStarted = false;
    const headElements = new Set([
      'base', 'basefont', 'bgsound', 'link', 'meta', 'noframes',
      'script', 'style', 'template', 'title'
    ]);
    for (const node of Array.from(existingRoot ? root.childNodes : document.childNodes)) {
      if (node.nodeType === 10) continue; // Preserve the authored doctype.
      const name = node.localName;
      if (name === 'head' && !bodyStarted) {
        for (const child of Array.from(head.childNodes).reverse()) node.insertBefore(child, node.firstChild);
        head = node;
        continue;
      }
      if (name === 'body') {
        for (const child of Array.from(body.childNodes).reverse()) node.insertBefore(child, node.firstChild);
        body = node;
        bodyStarted = true;
        continue;
      }
      if (!bodyStarted &&
          (headElements.has(name) || node.nodeType === 8 ||
           node.nodeType === 3 && !String(node.textContent || '').trim())) {
        head.appendChild(node);
      } else {
        bodyStarted = true;
        body.appendChild(node);
      }
    }
    root.appendChild(head);
    root.appendChild(body);
    if (!existingRoot) document.appendChild(root);
  }

  function init(options) {
    if (activeState) {
      return JSON.stringify({
        html: '',
        diagnostics: [{
          code: 'runtime.fresh_context_required',
          severity: 'error',
          message: 'init can run once per JavaScript context; create a fresh isolated context for another document.'
        }],
        now: activeState.now,
        scheduler: schedulerSnapshot(),
        formActions: [],
        focusActions: [],
        navigationActions: [],
        scrollActions: []
      });
    }

    const input = options && typeof options === 'object' ? options : {};
    const html = typeof input.html === 'string' ? input.html : '';
    const url = typeof input.url === 'string' ? input.url : 'about:blank';
    const initialNow = typeof input.now === 'number' && Number.isFinite(input.now)
      ? Math.max(0, input.now)
      : 0;
    activeState = {
      diagnostics: [],
      diagnosticsOmitted: false,
      url: url,
      sourceDocumentUrl: url,
      fragmentTarget: null,
      fragmentAncestorTask: null,
      fragmentAncestorsRevealed: false,
      initialFragmentSelected: false,
      initialRootScrollOverride: false,
      initialFragmentObservationPending: input.history?.initialFragmentRevealPending === true,
      loadEventDispatching: false,
      fragmentTargetRevision: Number.isSafeInteger(input.history?.targetRevision) ? input.history.targetRevision : 0,
      initialCookieState: input.cookieState,
      initialHistory: input.history && typeof input.history === 'object' ? input.history : {},
      documentReferrer: typeof input.referrer === 'string' ? input.referrer : '',
      objectUrlNonce: typeof input.objectUrlNonce === 'string' ? input.objectUrlNonce : '',
      documentReferrerPolicy: parseReferrerPolicyHeader(input.referrerPolicy),
      navigationActions: [],
      scrollActions: [],
      nextScrollActionId: 1,
      nativeScrollPosition: null,
      nextActionOrder: 1,
      userActivationDepth: 0,
      pickerActivationUntil: -1,
      nextFilePickerId: 1,
      pendingFilePickers: new Map(),
      filePickerActions: [],
      focusActions: [],
      focusTransitionVersion: 0,
      pendingHostFocusIns: [],
      pendingHostFocusOuts: [],
      initializing: true,
      now: initialNow,
      timeOrigin: Date.now() - initialNow,
      nextTaskId: 1,
      timers: new Map(),
      animationFrames: new Map(),
      nativeAnimationFrame: null,
      nextNativeAnimationFrameId: 1,
      currentTimerNesting: null,
      pumping: false,
      document: null,
      window: null,
      activeElement: null,
      modalDialogs: [],
      elementIds: new WeakMap(),
      elementsById: new Map(),
      inlineHandlers: new WeakMap(),
      formDataHandlers: new WeakMap(),
      pointerPropertyHandlers: new WeakMap(),
      imagePropertyOverrides: new WeakMap(),
      cloningSnapshot: false,
      onclickPropertyOverrides: new WeakSet(),
      onclickPropertyHandlers: new WeakMap(),
      clickListeners: new WeakMap(),
      trackedNodes: new WeakSet(),
      trackedNodeCount: 0,
      nextElementId: 1,
      initialScripts: null,
      formActions: [],
      resourceRequests: [],
      resourceCancellations: [],
      pendingImageRequests: new Set(),
      inertScripts: new WeakSet(),
      insertingInertScripts: false,
      scriptResources: new Map(),
      nextScriptRequestId: 1,
      pendingScriptLoads: 0,
      classicScriptTasks: [],
      nextClassicScriptId: 1,
      readyModuleScripts: [],
      modulePreparations: 0,
      moduleGraph: null,
      hostLayout: input.hostLayout === true,
      documentMode: input.documentMode,
      layout: null,
      layoutStylesSignature: null,
      pendingStylesheetLoads: 0,
      stylesheets: null,
      stylesheetSnapshot: null,
      initialEnvironment: input.environment,
      media: null,
      stylesheetRequestOptions: new Map(),
      documentFetch: null,
      hidden: input.hidden === true,
      readyState: 'loading',
      currentScript: null,
      initialScriptIndexes: null,
      parserScripts: [],
      parserIndex: 0,
      deferScripts: [],
      deferIndex: 0,
      parserPaused: false,
      parserExecuting: false,
      parserDone: false,
      deferExecuting: false,
      domContentLoaded: false,
      loadDispatched: false,
      initialScripts: new WeakSet(),
      processedScripts: new WeakSet()
    };

    if (typeof input.html !== 'string') {
      diagnostic('runtime.invalid_input', 'error', 'init requires html to be a string.');
      return response();
    }
    if (utf8ByteLength(html) > MAX_INPUT_BYTES) {
      diagnostic(
        'runtime.input_limit',
        'error',
        'The source document exceeds the ' + MAX_INPUT_BYTES + ' byte input limit.'
      );
      return response();
    }

    diagnostic(
      'runtime.capability_limit',
      'info',
      'This runtime supports a LinkeDOM-backed document scripting subset with host-pumped timers and animation frames. Bounded scripts and fetch requests use host HTTP transport. File system access, IndexedDB, CacheStorage, workers, and full browser APIs are unavailable. Native cookies and localStorage use account scopes; sessionStorage uses native window scopes. Navigation requests are returned to the host as one-shot actions.'
    );

    try {
      installHTMLElementFocusMethods();
      // LinkeDOM defines the form interface but its worker build omits the
      // registration that makes parsed and createElement('form') nodes use it.
      registerHTMLClass('form', HTMLFormElement);
      registerHTMLClass('base', HTMLBaseElement);
      registerHTMLClass('area', HTMLAreaElement);
      registerHTMLClass('label', HTMLLabelElement);
      registerHTMLClass('fieldset', HTMLFieldSetElement);
      registerHTMLClass('details', HTMLDetailsElement);
      registerHTMLClass('dialog', PircHTMLDialogElement);
      const view = parseHTML(html);
      const document = view.document;
      if (input.hostLayout === true) normalizeHostDocumentTree(document);
      activeState.window = view;
      activeState.document = document;
      installFormProperties();
      installDomGlobals(view, document);
      patchDomMutationHooks();
      activeState.media = createPircDocumentMedia({
        environment: activeState.initialEnvironment,
        Event: PublicEvent, EventTarget: DOMEventTarget, diagnostic,
        dispatchResize: () => {
          const event = new GlobalEvent('resize', {bubbles:false,cancelable:false});
          defineEventMember(event, 'isTrusted', true);
          view.dispatchEvent(event);
        }
      });
      activeState.media.install(globalThis);
      installWindowResizeHandler(view);
      installDocumentScrollHandler(view, document);
      installDocumentStorageHandler(view);
      installDocumentVisibility(document);
      // Initialize the window target only after listener tracking is installed.
      const windowEventMethods = ['addEventListener', 'removeEventListener', 'dispatchEvent']
        .map(name => [name, view[name].bind(view)]);
      for (const [name, method] of windowEventMethods) defineGlobal(name, method, true);
      installDocumentImages(view, document);
      markInitialDocument(document);
      activeState.canvas = createDocumentCanvas({document, ensureElementId, diagnostic,
        textMetricError: input && input.canvasTextError,
        measureText: nativeCanvasTextEngine && nativeCanvasTextEngine.measureText,
        measureInk: nativeCanvasTextEngine && nativeCanvasTextEngine.measureInk,
        fontBaselineOffset: nativeCanvasTextEngine && nativeCanvasTextEngine.fontBaselineOffset,
        resolveImage: source => activeState.images.canvasSource(source)});
      activeState.canvas.install();
      defineGlobal('TextMetrics',activeState.canvas.TextMetrics,false);
      activeState.stylesheets = createPircDocumentStylesheets({
        document, URL: pircUrlPolyfill.URL, Event: PublicEvent,
        getBaseURL: currentDocumentBaseUrl, ensureElementId, diagnostic,
        getCachedSheet: element => element[SHEET],
        clearCachedSheet: element => {element[SHEET] = null;}
      });
      syncDocumentStylesheets();
    } catch (error) {
      diagnostic('runtime.init_error', 'error', exceptionMessage(error));
      return response();
    }

    runScripts();
    activeState.initializing = false;
    try {
      decorateTree(activeState.document);
    } catch (error) {
      diagnostic('runtime.dom_update_error', 'error', exceptionMessage(error));
    }
    return response();
  }

  function resolveSubmitter(request) {
    const hasSubmitter = Object.prototype.hasOwnProperty.call(request, 'submitter');
    const hasSubmitterId = Object.prototype.hasOwnProperty.call(request, 'submitterId');
    const reference = hasSubmitter ? request.submitter :
      hasSubmitterId ? request.submitterId : null;
    if (reference == null)
      return null;

    const rawId = reference && typeof reference === 'object'
      ? reference.id
      : reference;
    if (rawId == null || rawId === '')
      return null;

    const id = String(rawId);
    const submitter = activeState.elementsById.get(id);
    if (!submitter || submitter.ownerDocument !== activeState.document ||
        !submitter.isConnected) {
      diagnostic(
        'dispatch.unknown_submitter',
        'warning',
        'The submitter reference did not identify a connected element.',
        { id: id }
      );
      return null;
    }
    return submitter;
  }

  // Native evaluations finish between callbacks, providing a real engine
  // microtask checkpoint and allowing Flutter to measure any resulting writes.
  // The selected handles and timestamp stay frozen for the whole browser frame.
  function advanceNativeAnimationFrame(state) {
    const batch = state.nativeAnimationFrame;
    while (batch.index < batch.callbacks.length) {
      const frame = batch.callbacks[batch.index++];
      if (state.animationFrames.get(frame.id) !== frame) continue;
      state.animationFrames.delete(frame.id);
      invokeScheduledCallback(frame.callback, [batch.timestamp],
        {id: frame.id, kind: 'animationFrame'}, state.window);
      // Keep a final continuation even after the last callback, so its Promise
      // jobs and layout finish before delivering ResizeObserver notifications.
      return;
    }
    state.nativeAnimationFrame = null;
    state.resizeObservers?.deliver();
  }

  function continueAnimationFrame(input) {
    const state = activeState;
    if (!state?.nativeAnimationFrame || input?.id !== state.nativeAnimationFrame.id)
      throw new TypeError('No matching native animation frame continuation');
    if (state.pumping) throw new TypeError('Cannot resume a running animation frame');
    if (layoutNeedsUpdate()) return response({now: state.now});
    state.pumping = true;
    try {
      advanceNativeAnimationFrame(state);
    } finally {
      state.pumping = false;
    }
    decorateTree(state.document);
    return response({now: state.now});
  }

  function pump(input) {
    const state = activeState;
    if (!state || !state.document) {
      return JSON.stringify({
        html: '',
        diagnostics: [{
          code: 'runtime.not_initialized',
          severity: 'error',
          message: 'Call init before pump.'
        }],
        now: state ? state.now : 0,
        scheduler: schedulerSnapshot(),
        formActions: [],
        navigationActions: []
      });
    }

    const request = input && typeof input === 'object' ? input : {};
    advanceClock(request.now);
    if (state.pumping) {
      diagnostic(
        'scheduler.reentrant_pump',
        'warning',
        'A nested scheduler pump was ignored.'
      );
      return response({ now: state.now });
    }
    // A budget/lifecycle yield cannot start a new frame or interleave a timer
    // with the still-selected callbacks of the current frame.
    if (state.nativeAnimationFrame) return response({now: state.now});
    state.pumping = true;
    try {
      if (request.animationFrame === true && request.nativeFrameSteps === true) {
        state.nativeAnimationFrame = {
          id: state.nextNativeAnimationFrameId++, timestamp: state.now,
          callbacks: Array.from(state.animationFrames.values()), index: 0,
        };
        advanceNativeAnimationFrame(state);
      } else if (request.animationFrame === true && state.animationFrames.size > 0) {
        const frameBatch = Array.from(state.animationFrames.values());
        for (const frame of frameBatch) {
          if (state.animationFrames.get(frame.id) !== frame)
            continue;
          state.animationFrames.delete(frame.id);
          invokeScheduledCallback(
            frame.callback,
            [state.now],
            { id: frame.id, kind: 'animationFrame' },
            state.window
          );
        }
      } else {
        let nextTimer = null;
        for (const timer of state.timers.values()) {
          if (timer.due <= state.now &&
              (!nextTimer || timer.due < nextTimer.due ||
               (timer.due === nextTimer.due && timer.id < nextTimer.id))) {
            nextTimer = timer;
          }
        }

        if (nextTimer) {
          if (nextTimer.kind === 'timeout')
            state.timers.delete(nextTimer.id);
          const previousNesting = state.currentTimerNesting;
          state.currentTimerNesting = nextTimer.nesting;
          try {
            invokeScheduledCallback(
              nextTimer.callback,
              nextTimer.args,
              { id: nextTimer.id, kind: nextTimer.kind },
              state.window
            );
          } finally {
            state.currentTimerNesting = previousNesting;
          }
          if (nextTimer.kind === 'interval' &&
              state.timers.get(nextTimer.id) === nextTimer) {
            nextTimer.delay = timerDelay(nextTimer.baseDelay, nextTimer.nesting);
            nextTimer.nesting += 1;
            nextTimer.due = state.now + nextTimer.delay;
          }
        }
      }
      if (request.animationFrame === true && request.nativeFrameSteps !== true) state.resizeObservers?.deliver();
    } finally {
      state.pumping = false;
    }

    try {
      decorateTree(state.document);
    } catch (error) {
      diagnostic('runtime.dom_update_error', 'error', exceptionMessage(error));
    }
    return response({ now: state.now });
  }

  function snapshot(input) {
    const state = activeState;
    if (!state || !state.document) {
      return JSON.stringify({
        html: '',
        diagnostics: [{
          code: 'runtime.not_initialized',
          severity: 'error',
          message: 'Call init before snapshot.'
        }],
        now: state ? state.now : 0,
        scheduler: schedulerSnapshot(),
        formActions: [],
        navigationActions: []
      });
    }
    const request = input && typeof input === 'object' ? input : {};
    advanceClock(request.now);
    return response({ now: state.now });
  }

  function requestTopModalClose() {
    const state = activeState;
    const top = state?.modalDialogs[state.modalDialogs.length - 1];
    if (!top || !top.isConnected || !top.hasAttribute('open'))
      return response({modalCloseRequested: false});
    // A platform close request obeys closedby. The IDL requestClose() method
    // separately force-enables its own request, including closedby=none.
    if (String(top.getAttribute('closedby') || '').toLowerCase() !== 'none')
      requestCloseDocumentDialog(top);
    return response({modalCloseRequested: true});
  }

  function dispatchModalBackdropPointerDown(input) {
    const state = activeState;
    const top = state?.modalDialogs[state.modalDialogs.length - 1];
    const request = input && typeof input === 'object' ? input : {};
    if (!top || !top.isConnected || !top.hasAttribute('open') ||
        String(request.type) !== 'pointerdown' ||
        String(request.id) !== top.getAttribute(MARKER_ATTRIBUTE)) {
      return response({defaultPrevented: true, error: 'stale_modal_backdrop'});
    }
    return dispatchCore(request, () => {
      // A backdrop pointerdown first reaches the dialog. Light dismissal then
      // sends cancel regardless of pointerdown.preventDefault(), while a
      // canceled cancel event keeps the dialog open.
      if (activeState === state && top.isConnected && top.hasAttribute('open') &&
          state.modalDialogs[state.modalDialogs.length - 1] === top &&
          String(top.getAttribute('closedby') || '').toLowerCase() === 'any' &&
          Number(request.eventData?.button ?? 0) === 0) {
        requestCloseDocumentDialog(top);
      }
    });
  }

  function completeImageResource(state, id, completion) {
    if (state.pendingImageRequests.delete(id)) state.layout?.invalidate();
    const accepted = state.images.complete(completion);
    return response({resourceId:id,resourceKind:'image',resourceIgnored:!accepted});
  }

  function completeResource(input) {
    const state = activeState;
    if (!state || !state.document) {
      return JSON.stringify({
        html: '',
        diagnostics: [{
          code: 'runtime.not_initialized',
          severity: 'error',
          message: 'Call init before completeResource.'
        }],
        now: state ? state.now : 0,
        scheduler: schedulerSnapshot(),
        resourceRequests: [],
        formActions: [],
        navigationActions: []
      });
    }

    const completion = input && typeof input === 'object' ? input : {};
    advanceClock(completion.now);
    const id = String(completion.id == null ? '' : completion.id);
    if (id.slice(0, 11) === 'stylesheet-' && state.stylesheets) {
      const accepted = state.stylesheets.complete(completion);
      syncDocumentStylesheets();
      dispatchDocumentLoadIfReady();
      return response({resourceId:id,resourceKind:'stylesheet',resourceIgnored:!accepted});
    }
    if (id.slice(0, 6) === 'image-' && state.images)
      return completeImageResource(state, id, completion);
    if (id.slice(0, 6) === 'fetch-' && state.documentFetch) {
      try {
        state.documentFetch.complete(completion);
      } catch (error) {
        diagnostic('fetch.completion_error', 'error', exceptionMessage(error), {
          id: id
        });
      }
      return response({ resourceId: id, resourceKind: 'fetch' });
    }

    const record = state.scriptResources.get(id);
    if (!record) {
      return response({
        resourceIgnored: true,
        resourceId: id
      });
    }

    if (record.moduleFetch) {
      state.scriptResources.delete(id);
      if (completion.ok === true) record.resolve({source: completion.source, url: completion.url,
        referrerPolicy: completion.referrerPolicy});
      else record.reject(new TypeError(completion.error || 'Module resource failed'));
      return response({resourceId:id,resourceKind:'script'});
    }
    try {
      settleScriptResource(record, completion);
    } catch (error) {
      diagnostic('script.completion_error', 'error', exceptionMessage(error), {
        id: id
      });
      if (!record.done) {
        record.done = true;
        state.scriptResources.delete(id);
        if (record.blocksLoad)
          state.pendingScriptLoads = Math.max(0, state.pendingScriptLoads - 1);
        if (record.mode === 'parser') {
          state.parserPaused = false;
          continueParserScripts();
        } else if (record.mode === 'defer') {
          continueDeferredScripts();
        }
      }
      dispatchDocumentLoadIfReady();
    }
    return response({ resourceId: id, resourceKind: 'script' });
  }

  function updateLocation(input) {
    const state = activeState;
    if (!state) {
      return JSON.stringify({
        html: '',
        diagnostics: [{
          code: 'runtime.not_initialized',
          severity: 'error',
          message: 'Call init before updateLocation.'
        }],
        now: 0,
        scheduler: { timerDelayMs: null, animationFrame: false },
        formActions: [],
        focusActions: [],
        navigationActions: []
      });
    }

    const request = input && typeof input === 'object' ? input : {};
    if (typeof request.url !== 'string') {
      navigationDiagnostic('missing_host_url', 'host');
      return response();
    }
    const oldUrl = state.url;
    const nextUrl = resolveNavigationUrl(request.url, false);
    if (!nextUrl)
      return response();

    let fireHashChange = false;
    let oldHash = '';
    let newHash = '';
    try {
      const previous = new pircUrlPolyfill.URL(String(oldUrl || 'about:blank'));
      const next = new pircUrlPolyfill.URL(nextUrl);
      const sameDocument = previous.origin === next.origin &&
        previous.pathname === next.pathname &&
        previous.search === next.search;
      oldHash = previous.hash;
      newHash = next.hash;
      fireHashChange = sameDocument && (oldHash !== newHash ||
        previous.href.includes('#') !== next.href.includes('#'));
    } catch (error) {
      fireHashChange = false;
    }
    state.url = nextUrl;
    selectFragmentTarget(nextUrl);

    if (fireHashChange && state.window) {
      try {
        const event = new GlobalEvent('hashchange', {
          bubbles: false,
          cancelable: false
        });
        Object.defineProperties(event, {
          oldURL: { value: String(oldUrl), enumerable: true },
          newURL: { value: nextUrl, enumerable: true }
        });
        state.window.dispatchEvent(event);
      } catch (error) {
        diagnostic(
          'navigation.hashchange_error',
          'warning',
          exceptionMessage(error)
        );
      }
    }
    return response();
  }

  function dispatch(input) {
    const state = activeState;
    const request = input && typeof input === 'object' ? input : {};
    const eventType = String(request.type == null ? '' : request.type).trim();
    const grantsUserActivation = Boolean(state && state.document &&
      !state.initializing && !state.pumping &&
      ['click', 'input', 'change'].includes(eventType));
    if (grantsUserActivation)
      state.userActivationDepth += 1;
    if (state && eventType === 'click' && !state.initializing && !state.pumping) {
      state.pickerActivationUntil = Math.max(state.now, Number(request.now) || 0) + 5000;
    }
    try {
      return dispatchCore(input);
    } finally {
      if (grantsUserActivation)
        state.userActivationDepth -= 1;
    }
  }

  function dispatchCore(input, afterDispatch) {
    const state = activeState;
    if (!state || !state.document) {
      return JSON.stringify({
        html: '',
        defaultPrevented: false,
        error: 'not_initialized',
        diagnostics: [{
          code: 'runtime.not_initialized',
          severity: 'error',
          message: 'Call init before dispatch.'
        }],
        now: 0,
        scheduler: { timerDelayMs: null, animationFrame: false },
        formActions: [],
        focusActions: [],
        navigationActions: []
      });
    }

    const request = input && typeof input === 'object' ? input : {};
    advanceClock(request.now);
    const id = String(request.id == null ? '' : request.id);
    const element = state.elementsById.get(id);
    if (!element || element.ownerDocument !== state.document || !element.isConnected) {
      return response({
        defaultPrevented: String(request.type == null ? '' : request.type).trim() === 'click',
        error: 'unknown_element',
        id: id
      });
    }

    const type = String(request.type == null ? '' : request.type).trim();
    const ownsSubmitDefault = type === 'click' && ownsHostClickDefault(element);
    if (ownsSubmitDefault && isDisabledFormControl(element)) {
      return response({
        defaultPrevented: false,
        defaultHandled: true,
        id: id,
        type: type
      });
    }

    const controls = Array.isArray(request.controls) ? request.controls : [];
    for (const control of controls)
      applyControl(control);

    if (!type) {
      return response({
        defaultPrevented: false,
        defaultHandled: false,
        error: 'invalid_event_type',
        id: id
      });
    }

    if (type === 'input' && (element.localName === 'input' || element.localName === 'textarea')) {
      const previous = userInputState.get(element) || {};
      userInputState.set(element, {
        userEdited: true,
        badInput: Boolean(previous.badInput),
        pendingChange: isTextInputForBlurChange(element) ? true : Boolean(previous.pendingChange)
      });
    }

    let staleHostFocusOut = false;
    if (type === 'focusin') {
      const pending = takeHostFocusCounterpart(state, 'focusin', element);
      if (pending && pending.transitionVersion !== state.focusTransitionVersion) {
        // A script focus() in the host's preceding focus listener replaced this
        // focus target, so Chromium does not deliver the queued focusin.
        return response({
          defaultPrevented: false,
          defaultHandled: false,
          focusEventSuppressed: true,
          id: id,
          type: type
        });
      }
    } else if (type === 'focusout') {
      const pending = takeHostFocusCounterpart(state, 'focusout', element);
      staleHostFocusOut = Boolean(pending &&
        pending.transitionVersion !== state.focusTransitionVersion);
    }

    if (type === 'click' && isSubmittableControl(element) && isDisabledFormControl(element))
      return response({ defaultPrevented: false, defaultHandled: ownsSubmitDefault, id: id, type: type });

    let event;
    let syntheticDefaultPrevented = false;
    const formTarget = String(element.localName || '').toLowerCase() === 'form';
    const hostRequestSubmit = type === 'requestSubmit';
    const hostSubmitEvent = type === 'submit' && formTarget;
    const defaultHandled = ownsSubmitDefault || hostRequestSubmit || hostSubmitEvent;
    let nativeLinkDefaultOrder = null;
    try {
      if (type.startsWith('pointer')) {
        const result = state.pointer.dispatch(element, type, request.eventData);
        if (!result)
          throw new TypeError('Invalid native pointer event metadata.');
        event = result.event;
      } else if (hostRequestSubmit || hostSubmitEvent) {
        if (!formTarget) {
          diagnostic(
            'dispatch.form_target_invalid',
            'error',
            'A host form submission event must target a form element.',
            { id: id, type: type }
          );
        } else {
          const submitter = resolveSubmitter(request);
          const validate = hostRequestSubmit &&
            !element.hasAttribute('novalidate') &&
            !(submitter && submitter.hasAttribute('formnovalidate'));
          const result = requestFormSubmission(element, submitter || element, {
            validate: validate,
            fireSubmit: true
          });
          syntheticDefaultPrevented = result.defaultPrevented;
        }
      } else {
      const eventData = boundedRequestEventData(request);
      const compositionEvent = ['compositionstart', 'compositionupdate', 'compositionend'].includes(type);
      const keyboardEvent = type === 'keydown' || type === 'keyup';
      const focusEvent = type === 'focus' || type === 'blur' ||
        type === 'focusin' || type === 'focusout';
      const eventInit = {
        bubbles: focusEvent ? type === 'focusin' || type === 'focusout' : true,
        cancelable: type === 'click' || type === 'submit' || type === 'reset' || keyboardEvent,
        composed: focusEvent || type === 'input',
        view: focusEvent ? state.window : null
      };
      if (type === 'input') {
        const inputInit = Object.assign({}, eventInit);
        for (const name of ['data', 'inputType', 'isComposing']) {
          if (hasOwnValue(eventData, name)) {
            inputInit[name] = eventData[name];
          } else {
            const legacyValue = legacyInputEventValue(request, name);
            if (legacyValue.present)
              inputInit[name] = legacyValue.value;
          }
        }
        event = new PircInputEvent(type, inputInit);
      } else if (compositionEvent) {
        const compositionInit = Object.assign({}, eventInit);
        if (hasOwnValue(eventData, 'data'))
          compositionInit.data = eventData.data == null ? '' : eventData.data;
        event = new PircCompositionEvent(type, compositionInit);
      } else if (keyboardEvent) {
        const keyboardInit = Object.assign({}, eventInit);
        for (const name of [
          'key', 'code', 'location', 'repeat', 'ctrlKey', 'shiftKey', 'altKey',
          'metaKey', 'isComposing', 'keyCode', 'charCode', 'which'
        ]) {
          if (hasOwnValue(eventData, name))
            keyboardInit[name] = eventData[name];
        }
        event = new PircKeyboardEvent(type, keyboardInit);
      } else if (focusEvent) {
        event = new PircFocusEvent(type, Object.assign({}, eventInit, {
          relatedTarget: staleHostFocusOut ? null : resolveEventRelatedTarget(state, eventData)
        }));
      } else if (['mouseover', 'mouseout', 'mouseenter', 'mouseleave'].includes(type)) {
        event = state.pointer.createMouseBoundaryEvent(
          type, request.eventData, resolveEventRelatedTarget(state, eventData)
        );
        if (!event)
          throw new TypeError('Invalid native mouse boundary coordinates.');
      } else if (type === 'click') {
        event = state.pointer.createClickEvent(request.eventData, eventInit, element) ||
          new state.pointer.PointerEvent(type, Object.assign({}, eventInit, { composed: true, detail: 1, pointerId: -1 }));
      } else if (type === 'submit') {
        event = new PircSubmitEvent(type, {
          bubbles: eventInit.bubbles,
          cancelable: eventInit.cancelable,
          submitter: resolveSubmitter(request)
        });
      } else {
        event = new GlobalEvent(type, eventInit);
      }
      defineEventMember(event, 'isTrusted', true);
      if (type === 'reset' && element.localName === 'form') {
        // runFormReset dispatches exactly once and applies the default only
        // after listeners have had an opportunity to cancel it.
        const prevented = runFormReset(element);
        if (prevented) event.preventDefault();
      } else {
        if (type === 'change') {
          if (eventData.focusLeaving === true && state.activeElement === element)
            state.activeElement = null;
          clearPendingChange(element);
        }
        const clearsActiveElement = type === 'blur' || type === 'focusout';
        if (type === 'focus' || type === 'focusin') {
          if (type === 'focus')
            state.focusTransitionVersion += 1;
          state.activeElement = element;
          if (type === 'focus')
            rememberHostFocusCounterpart(state, 'focusin', element);
        } else if (type === 'blur') {
          state.focusTransitionVersion += 1;
          if (state.activeElement === element)
            state.activeElement = null;
          rememberHostFocusCounterpart(state, 'focusout', element);
        } else if (clearsActiveElement && !staleHostFocusOut && state.activeElement === element) {
          // Chromium exposes the body as activeElement during blur and
          // focusout, before focus moves to the next target.
          state.activeElement = null;
        }
        if (type === 'click') {
          state.pointer.withNativeDispatchGeometry(element, request.eventData, function() {
            dispatchActivationClick(element, event, true);
            if (!event.defaultPrevented && hasNativeSameWindowLinkDefault(element))
              nativeLinkDefaultOrder = nextActionOrder();
          });
        } else {
          element.dispatchEvent(event);
        }
      }
      }
    } catch (error) {
      diagnostic('dispatch.event_error', 'error', exceptionMessage(error), {
        id: id,
        type: type
      });
      if (afterDispatch) afterDispatch();
      return response({
        defaultPrevented: Boolean(event && event.defaultPrevented),
        defaultHandled: defaultHandled,
        error: 'event_dispatch_failed',
        id: id,
        type: type
      });
    }

    try {
      decorateTree(state.document);
    } catch (error) {
      diagnostic('runtime.dom_update_error', 'error', exceptionMessage(error));
    }

    if (afterDispatch) afterDispatch();

    const result = {
      defaultPrevented: Boolean(event ? event.defaultPrevented : syntheticDefaultPrevented),
      defaultHandled: defaultHandled,
      id: id,
      type: type
    };
    if (nativeLinkDefaultOrder != null)
      result.nativeLinkDefaultOrder = nativeLinkDefaultOrder;
    return response(result);
  }

  function layoutNeedsUpdate() {
    return Boolean(activeState?.hostLayout && activeState.layout?.needsLayout());
  }

  function dispatchNativeViewportScrollIfChanged(state) {
    const viewport = state.layout.nativeViewport();
    const previous = state.nativeScrollPosition;
    state.nativeScrollPosition = { scrollX: viewport.scrollX, scrollY: viewport.scrollY };
    // The first accepted measurement establishes the native starting point;
    // loading a document at a restored position is not itself a scroll event.
    if (!previous ||
        previous.scrollX === viewport.scrollX && previous.scrollY === viewport.scrollY) return;
    const event = new GlobalEvent('scroll', {
      bubbles: true,
      cancelable: false,
      composed: false
    });
    defineEventMember(event, 'isTrusted', true);
    // CSSOM View targets viewport scroll events at Document; bubbling reaches
    // Window after Document target listeners, including capture listeners.
    state.document.dispatchEvent(event);
  }

  function compareDocumentOrder(left, right) {
    if (left === right) return 0;
    if (!left || !right || typeof left.compareDocumentPosition !== 'function') return 0;
    const position = left.compareDocumentPosition(right);
    if ((position & 4) !== 0) return -1; // DOCUMENT_POSITION_FOLLOWING
    if ((position & 2) !== 0) return 1;  // DOCUMENT_POSITION_PRECEDING
    return 0;
  }

  function dispatchNativeElementScrollEvents(state, accepted) {
    const ordered = [];
    const seen = new Set();
    const positionChanges = accepted.scrollChanges || [];
    const changedById = new Map(positionChanges.map(change => [change.id, change]));
    for (const nativeEvent of accepted.scrollEvents || []) {
      // Event records can be replayed when a native view remount delays its
      // acknowledgement. The accepted offset baseline makes those records
      // idempotent; only a measured position transition dispatches an event.
      const change = changedById.get(nativeEvent.id);
      if (change && !seen.has(nativeEvent.id)) {
        seen.add(nativeEvent.id);
        ordered.push(change.element);
      }
    }

    // Hosts may report only accepted per-element positions. Preserve a
    // deterministic DOM order for position changes not ordered by native events.
    const sortedPositionChanges = positionChanges.slice().sort((left, right) =>
      compareDocumentOrder(left.element, right.element));
    for (const change of sortedPositionChanges) {
      if (seen.has(change.id)) continue;
      seen.add(change.id);
      ordered.push(change.element);
    }

    for (const element of ordered) {
      if (!element || element.ownerDocument !== state.document || element.isConnected !== true) continue;
      const event = new GlobalEvent('scroll', {
        bubbles: false,
        cancelable: false,
        composed: false
      });
      defineEventMember(event, 'isTrusted', true);
      // Element scroll events capture through ancestors and run at the target,
      // but CSSOM View does not bubble them to Document or Window.
      element.dispatchEvent(event);
    }
  }

  function updateLayout(input) {
    const state = activeState;
    if (!state?.layout || !state.hostLayout)
      throw new Error('No native document layout source is attached.');
    let accepted;
    try {
      accepted = state.layout.update(input);
    } catch (error) {
      const packetRevision = input && typeof input === 'object' ? input.revision : null;
      const currentRevision = state.layout.revision();
      if (error && error.code === 'PIRC_LAYOUT_STALE_REVISION' &&
          Number.isSafeInteger(packetRevision) && packetRevision < currentRevision)
        return response({layoutAccepted:false});
      throw error;
    }
    state.resizeObservers?.changed();
    dispatchNativeViewportScrollIfChanged(state);
    dispatchNativeElementScrollEvents(state, accepted);
    // These guest callbacks were paused when their preceding DOM had not yet
    // reached Flutter. Do not execute them against an earlier layout snapshot.
    continueDeferredScripts();
    dispatchDOMContentLoadedIfReady();
    while (!state.classicScriptTasks.length && !layoutNeedsUpdate() && state.readyModuleScripts.length)
      executeModuleScript(state.readyModuleScripts.shift());
    dispatchDocumentLoadIfReady();
    return response({layoutAccepted: accepted.ok === true});
  }

  const api = Object.freeze({
    updateLayout: updateLayout,
    updateVisibility: updateVisibility,
    readObjectURL: function(url) {
      try {
        const value = activeState && activeState.objectUrls && activeState.objectUrls.read(url);
        return JSON.stringify(value ? Object.assign({ok: true}, value) :
          {ok: false, error: 'Object URL is unavailable.'});
      } catch (error) {
        return JSON.stringify({ok: false, error: exceptionMessage(error)});
      }
    },
    updateEnvironment: function(input) {
      if (activeState && activeState.media) {
        const value = input && typeof input === 'object' ? input : {};
        advanceClock(value.now);
        activeState.media.update(value.environment || value);
      }
      return response();
    },
    init: init,
    beginClassicScript: beginClassicScript,
    endClassicScriptTurn: endClassicScriptTurn,
    finishClassicScript: finishClassicScript,
    dispatch: dispatch,
    pump: pump,
    continueAnimationFrame: continueAnimationFrame,
    snapshot: snapshot,
    requestTopModalClose: requestTopModalClose,
    dispatchModalBackdropPointerDown: dispatchModalBackdropPointerDown,
    filePickerResult: filePickerResult,
    completeResource: completeResource,
    restoreControls: function(input) {
      if (activeState && input && Array.isArray(input.controls)) {
        for (const control of input.controls) applyControl(control);
      }
      return response();
    },
    updateHistory: function(input) {
      if (activeState && activeState.history) activeState.history.update(input);
      return response();
    },
    storageSyncBegin: storageBridge.syncBegin,
    storageEntryBegin: storageBridge.entryBegin,
    storageEntryPart: storageBridge.entryPart,
    storageEntryEnd: storageBridge.entryEnd,
    storageSyncFinish: storageBridge.syncFinish,
    storageWritesBegin: storageBridge.writesBegin,
    storageWriteInfo: storageBridge.writeInfo,
    storageWritePart: storageBridge.writePart,
    storageWritesEnd: storageBridge.writesEnd,
    storageEventBegin: storageBridge.eventBegin,
    storageEventPart: storageBridge.eventPart,
    storageEventFinish: storageBridge.eventFinish,
    syncCookies: function(input) {
      if (activeState && activeState.cookies) activeState.cookies.sync(input);
      return JSON.stringify({ok: true});
    },
    updateLocation: updateLocation
  });
  Object.defineProperty(globalThis, '__pircDocument', {
    value: api,
    writable: false,
    configurable: false,
    enumerable: false
  });
})();
