/* Dynamic inline stylesheet snapshots and stylesheet load lifecycle. */
function createPircDocumentStylesheets(options) {
  'use strict';
  options = options || {};
  const document = options.document;
  const URLValue = options.URL || (typeof URL === 'function' ? URL : null);
  const getBaseURL = typeof options.getBaseURL === 'function'
    ? options.getBaseURL
    : function() { return document && (document.baseURI || document.URL) || ''; };
  const ensureElementId = typeof options.ensureElementId === 'function'
    ? options.ensureElementId
    : function(element) {
        return element.getAttribute && element.getAttribute('data-pirc-script-id') || '';
      };
  const diagnostic = typeof options.diagnostic === 'function'
    ? options.diagnostic
    : function() {};
  const getCachedSheet = typeof options.getCachedSheet === 'function'
    ? options.getCachedSheet
    : linkedomCachedSheet;
  const clearCachedSheet = typeof options.clearCachedSheet === 'function'
    ? options.clearCachedSheet
    : linkedomClearCachedSheet;
  const ownerIds = new WeakMap();
  const inlineStates = new WeakMap();
  const linkStates = new WeakMap();
  const observedSheetBaselines = new WeakMap();
  const statesByOwnerId = new Map();
  const statesByTransportId = new Map();
  const allStates = new Set();
  let nextFallbackId = 1;
  let nextTransportId = 1;
  let order = 0;
  const cancellations = [];
  let sheetGetterTracker = null;

  function report(code, message, detail) {
    try { diagnostic(code, 'warning', message, detail); } catch (_) { /* advisory */ }
  }

  // LinkeDOM 0.18.13 stores its lazy HTMLStyleElement CSSStyleSheet under this
  // pinned symbol. Reading it avoids invoking the older CSS parser for styles
  // that the page has not accessed through CSSOM.
  function linkedomCachedSheet(element) {
    try {
      for (const symbol of Object.getOwnPropertySymbols(element)) {
        if (String(symbol) === 'Symbol(sheet)') return element[symbol] || null;
      }
    } catch (_) { /* use source text when the DOM does not expose the cache */ }
    return null;
  }

  function linkedomClearCachedSheet(element) {
    for (const symbol of Object.getOwnPropertySymbols(element)) {
      if (String(symbol) === 'Symbol(sheet)') {
        element[symbol] = null;
        return;
      }
    }
  }

  function ownerId(element) {
    let id = ownerIds.get(element);
    if (id) return id;
    try { id = String(ensureElementId(element) || ''); } catch (_) { id = ''; }
    if (!id) id = 'pirc-stylesheet-' + nextFallbackId++;
    ownerIds.set(element, id);
    return id;
  }

  function installReflectedStringProperty(element, property, attribute) {
    try {
      let prototype = Object.getPrototypeOf(element);
      while (prototype) {
        if (Object.getOwnPropertyDescriptor(prototype, property)) return;
        prototype = Object.getPrototypeOf(prototype);
      }
      prototype = Object.getPrototypeOf(element);
      if (!prototype) return;
      Object.defineProperty(prototype, property, {
        configurable: true,
        enumerable: true,
        get() { return this.getAttribute(attribute) || ''; },
        set(value) { this.setAttribute(attribute, String(value)); },
      });
    } catch (_) {
      // An incomplete DOM implementation can still be represented by attributes.
    }
  }

  function installStyleProperties(element) {
    const name = String(element.localName || '').toLowerCase();
    if (name === 'style') {
      installReflectedStringProperty(element, 'media', 'media');
      installReflectedStringProperty(element, 'type', 'type');
      installReflectedStringProperty(element, 'title', 'title');
    } else if (name === 'link') {
      installReflectedStringProperty(element, 'crossOrigin', 'crossorigin');
      installReflectedStringProperty(element, 'integrity', 'integrity');
      installReflectedStringProperty(element, 'referrerPolicy', 'referrerpolicy');
      installReflectedStringProperty(element, 'title', 'title');
    }
  }

  function attr(element, name) {
    const value = element && typeof element.getAttribute === 'function'
      ? element.getAttribute(name)
      : null;
    return value == null ? null : String(value);
  }

  function baseUrl() {
    try {
      const value = String(getBaseURL() || '');
      if (!URLValue || !value) return value;
      return new URLValue(value).href;
    } catch (_) {
      report('stylesheets.base_url', 'Could not resolve the document stylesheet base URL.', {});
      return '';
    }
  }

  function resolveHref(reference, base) {
    if (!reference) return '';
    try { return URLValue ? new URLValue(reference, base || undefined).href : reference; }
    catch (_) { return reference; }
  }

  function currentTree() {
    if (!document || typeof document.querySelectorAll !== 'function') return [];
    try { return Array.from(document.querySelectorAll('style,link')); }
    catch (_) { return []; }
  }

  function serializedRules(sheet) {
    try {
      const rules = sheet && sheet.cssRules;
      if (!rules || typeof rules.length !== 'number') return null;
      const output = [];
      for (let index = 0; index < rules.length; index++) {
        const rule = rules[index];
        if (!rule || typeof rule.cssText !== 'string') return null;
        output.push(rule.cssText);
      }
      return output.join('\n');
    } catch (_) {
      report('stylesheets.cssom_read', 'Could not read an accessed inline stylesheet CSSOM.', {});
      return null;
    }
  }

  // Observe the real CSSStyleSheet object returned by HTMLStyleElement.sheet.
  // This lets snapshots distinguish a page merely reading CSSOM (which may
  // canonicalize LinkeDOM's parser output) from the page actually mutating it.
  // The getter still returns the original object, preserving sheet identity.
  function installSheetGetterTracking() {
    if (sheetGetterTracker) return sheetGetterTracker;
    try {
      const probe = document && typeof document.createElement === 'function'
        ? document.createElement('style')
        : null;
      let prototype = probe && Object.getPrototypeOf(probe);
      let descriptor = null;
      while (prototype && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(prototype, 'sheet') || null;
        if (!descriptor) prototype = Object.getPrototypeOf(prototype);
      }
      if (!prototype || !descriptor || typeof descriptor.get !== 'function') return null;

      const trackerKey = typeof Symbol === 'function' && typeof Symbol.for === 'function'
        ? Symbol.for('pirc.documentStylesheets.sheetGetterTracker')
        : '__pircDocumentStylesheetSheetGetterTracker__';
      const existing = Object.getOwnPropertyDescriptor(prototype, trackerKey);
      if (existing && existing.value && existing.value.observers &&
          typeof existing.value.observers.set === 'function') {
        sheetGetterTracker = existing.value;
        return sheetGetterTracker;
      }

      const tracker = {observers: new WeakMap()};
      const originalGet = descriptor.get;
      Object.defineProperty(prototype, 'sheet', {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get() {
          const sheet = originalGet.call(this);
          const observer = tracker.observers.get(this);
          if (observer) {
            try { observer(this, sheet); } catch (_) { /* tracking is advisory */ }
          }
          return sheet;
        },
        set: descriptor.set,
      });
      Object.defineProperty(prototype, trackerKey, {
        configurable: true,
        enumerable: false,
        value: tracker,
      });
      sheetGetterTracker = tracker;
      return tracker;
    } catch (_) {
      report('stylesheets.cssom_tracking', 'Could not track inline stylesheet CSSOM access.', {});
      return null;
    }
  }

  function watchSheetGetter(element) {
    const tracker = installSheetGetterTracking();
    if (!tracker) return;
    tracker.observers.set(element, (style, sheet) => {
      const existing = observedSheetBaselines.get(style);
      if (existing && existing.sheet === sheet) return;
      const sourceText = String(style.textContent || '');
      observedSheetBaselines.set(style, {
        sheet,
        sourceText,
        cssText: serializedRules(sheet),
      });
    });
  }

  function createState(id, ownerType, element) {
    const state = {
      id, ownerId: id, ownerType, element,
      transportId: null, revision: 0, requestId: null, signature: null,
      status: 'idle', active: false, activeBefore: false,
      baseURL: '', sourceText: undefined, ignoredSheet: null,
      lastObservedCachedSheet: null, fetchHref: '',
    };
    statesByOwnerId.set(id, state);
    allStates.add(state);
    return state;
  }

  function cancel(state, reason) {
    if (!state || state.status !== 'pending') return;
    cancellations.push({
      id: state.transportId,
      ownerId: state.ownerId,
      transportId: state.transportId,
      ownerType: state.ownerType,
      revision: state.revision,
      requestId: state.requestId,
      reason,
    });
    state.status = 'cancelled';
    if (state.transportId && statesByTransportId.get(state.transportId) === state) {
      statesByTransportId.delete(state.transportId);
    }
  }

  function transition(state, signature, request, base, fetchHref, notifyLoad) {
    const changed = !state.activeBefore || signature !== state.signature;
    if (changed) {
      cancel(state, signature == null
        ? (state.ownerType === 'link' ? 'link-no-longer-loadable' : 'style-no-longer-loadable')
        : 'source-changed');
      state.revision++;
      state.signature = signature;
      state.requestId = null;
      state.transportId = null;
      state.fetchHref = signature == null ? '' : (fetchHref || '');
      state.notifyLoad = signature != null && notifyLoad !== false;
      if (signature != null) {
        state.status = 'pending';
        state.baseURL = base;
        state.requestId = state.id + ':' + state.revision;
        state.transportId = 'stylesheet-' + nextTransportId++;
        statesByTransportId.set(state.transportId, state);
        request({
          id: state.transportId,
          transportId: state.transportId,
          ownerId: state.ownerId,
          ownerType: state.ownerType,
          kind: 'stylesheet',
          revision: state.revision,
          requestId: state.requestId,
          baseURL: state.baseURL,
          href: state.fetchHref || undefined,
          notifyLoad: state.notifyLoad,
        });
      } else {
        state.status = 'idle';
        state.baseURL = base;
      }
    }
    state.active = true;
    state.activeBefore = true;
  }

  function inlineSource(element, state) {
    const sourceText = String(element.textContent || '');
    let cached = null;
    try { cached = getCachedSheet(element) || null; } catch (_) { cached = null; }
    const sourceChanged = state.sourceText !== undefined && sourceText !== state.sourceText;
    // textContent replacement resets LinkeDOM's cached sheet. If a different
    // sheet is already cached now, page code has accessed the replacement and
    // may have made legitimate CSSOM edits; only clear the sheet we previously
    // observed, which can be stale after child text-node mutation.
    if (sourceChanged && cached && cached === state.lastObservedCachedSheet) {
      try { clearCachedSheet(element); } catch (_) { /* render the live source below */ }
      let cleared = null;
      try { cleared = getCachedSheet(element) || null; } catch (_) { cleared = cached; }
      if (cleared === cached) state.ignoredSheet = cached;
      cached = cleared;
    }
    state.sourceText = sourceText;
    state.lastObservedCachedSheet = cached;
    if (cached && cached === state.ignoredSheet) {
      return {sourceText, cssText: sourceText, sourceChanged, sheetDisabled: cached.disabled === true};
    }
    let cssText = null;
    if (cached) {
      const currentRules = serializedRules(cached);
      const baseline = observedSheetBaselines.get(element);
      cssText = baseline && baseline.sheet === cached && baseline.sourceText === sourceText &&
          baseline.cssText != null && currentRules === baseline.cssText
        ? sourceText
        : currentRules;
    }
    return {
      sourceText,
      cssText: cssText == null ? sourceText : cssText,
      sourceChanged,
      sheetDisabled: cached != null && cached.disabled === true,
    };
  }

  function inlineSheet(element, index, base, requests) {
    const id = ownerId(element);
    installStyleProperties(element);
    watchSheetGetter(element);
    let state = inlineStates.get(element);
    if (!state) {
      state = createState(id, 'style', element);
      inlineStates.set(element, state);
    }
    state.element = element;
    const source = inlineSource(element, state);
    const type = attr(element, 'type') || '';
    const typeToken = type.trim().toLowerCase();
    const supported = !typeToken || typeToken === 'text/css';
    const signature = supported ? source.cssText : null;
    const notifyLoad = !state.activeBefore || state.signature == null || source.sourceChanged;
    transition(state, signature, request => {
      requests.push({...request, order: index, type});
    }, state.signature == null || state.signature !== signature ? base : state.baseURL, '', notifyLoad);
    if (!supported) return null;
    return {
      id,
      ownerId: id,
      transportId: state.transportId,
      elementId: attr(element, 'id') || '',
      ownerType: 'style',
      kind: 'stylesheet',
      order: index,
      revision: state.revision,
      requestId: state.requestId,
      loadState: state.status,
      notifyLoad: state.notifyLoad !== false,
      cssText: source.cssText,
      baseURL: state.baseURL,
      media: String(element.media == null ? (attr(element, 'media') || '') : element.media),
      disabled: source.sheetDisabled || element.disabled === true || (typeof element.hasAttribute === 'function' && element.hasAttribute('disabled')),
      title: attr(element, 'title') || '',
      type,
    };
  }

  function linkDescriptor(element, index, base) {
    const id = ownerId(element);
    installStyleProperties(element);
    const hrefAttribute = attr(element, 'href');
    const effectiveHref = hrefAttribute == null ? '' : resolveHref(hrefAttribute.trim(), base);
    const rel = String(element.rel == null ? (attr(element, 'rel') || '') : element.rel);
    const type = attr(element, 'type') || '';
    const typeToken = type.trim().toLowerCase();
    const relTokens = rel.toLowerCase().split(/[\t\n\f\r ]+/).filter(Boolean);
    const isStylesheet = relTokens.includes('stylesheet') && (!typeToken || typeToken === 'text/css') && !!hrefAttribute;
    const alternate = relTokens.includes('alternate');
    const disabled = element.disabled === true || (typeof element.hasAttribute === 'function' && element.hasAttribute('disabled'));
    const requestable = isStylesheet && !alternate && !disabled;
    const crossorigin = attr(element, 'crossorigin');
    const integrity = attr(element, 'integrity') || '';
    const referrerpolicy = attr(element, 'referrerpolicy') || '';
    const corsMode = crossorigin == null ? 'no-cors' :
      (crossorigin.trim().toLowerCase() === 'use-credentials' ? 'use-credentials' : 'anonymous');
    const signature = JSON.stringify([
      requestable,
      hrefAttribute == null ? null : hrefAttribute.trim(),
      typeToken,
      corsMode,
      integrity.trim(),
      referrerpolicy.trim().toLowerCase(),
    ]);
    return {
      id,
      ownerId: id,
      elementId: attr(element, 'id') || '',
      ownerType: 'link',
      kind: 'stylesheet',
      order: index,
      rel,
      href: effectiveHref,
      hrefAttribute,
      baseURL: base,
      crossorigin,
      integrity,
      referrerpolicy,
      type,
      media: String(element.media == null ? (attr(element, 'media') || '') : element.media),
      disabled,
      title: attr(element, 'title') || '',
      isStylesheet,
      alternate,
      requestable,
      signature,
    };
  }

  function updateLink(element, descriptor, requests) {
    let state = linkStates.get(element);
    if (!state) {
      state = createState(descriptor.id, 'link', element);
      linkStates.set(element, state);
    }
    state.element = element;
    const targetSignature = descriptor.requestable ? descriptor.signature : null;
    const changed = !state.activeBefore || targetSignature !== state.signature;
    const fetchHref = changed && descriptor.requestable ? descriptor.href : state.fetchHref;
    transition(state, targetSignature, request => {
      requests.push({
        ...request,
        order: descriptor.order,
        href: fetchHref,
        hrefAttribute: descriptor.hrefAttribute,
        rel: descriptor.rel,
        type: descriptor.type,
        crossorigin: descriptor.crossorigin,
        integrity: descriptor.integrity,
        referrerpolicy: descriptor.referrerpolicy,
        media: descriptor.media,
        disabled: descriptor.disabled,
        title: descriptor.title,
      });
    }, changed ? descriptor.baseURL : state.baseURL, fetchHref, true);
    return {
      ...descriptor,
      transportId: state.transportId,
      revision: state.revision,
      requestId: state.requestId,
      loadState: state.status,
      notifyLoad: state.notifyLoad !== false,
      fetchHref: state.fetchHref,
    };
  }

  function linkIsCurrent(state) {
    if (!state || !state.active || !currentTree().includes(state.element)) return false;
    const descriptor = linkDescriptor(state.element, -1, baseUrl());
    return descriptor.requestable && descriptor.signature === state.signature;
  }

  function inlineIsCurrent(state) {
    if (!state || !state.active || !currentTree().includes(state.element)) return false;
    const type = (attr(state.element, 'type') || '').trim().toLowerCase();
    if (type && type !== 'text/css') return false;
    const source = inlineSource(state.element, state);
    return source.cssText === state.signature;
  }

  function dispatch(element, type) {
    try {
      const view = element.ownerDocument && element.ownerDocument.defaultView;
      const EventCtor = options.Event || (view && view.Event) || (typeof Event === 'function' ? Event : null);
      if (!EventCtor || typeof element.dispatchEvent !== 'function') return false;
      element.dispatchEvent(new EventCtor(type));
      return true;
    } catch (_) {
      return false;
    }
  }

  function deactivate(state) {
    cancel(state, 'removed');
    state.active = false;
    state.activeBefore = false;
    state.signature = null;
    state.requestId = null;
    state.fetchHref = '';
    state.status = 'idle';
  }

  function snapshot() {
    order = 0;
    const base = baseUrl();
    const sheets = [];
    const links = [];
    const requests = [];
    const seenStyles = new Set();
    const seenLinks = new Set();
    for (const element of currentTree()) {
      const currentOrder = order++;
      const name = String(element.localName || element.tagName || '').toLowerCase();
      if (name === 'style') {
        seenStyles.add(element);
        const record = inlineSheet(element, currentOrder, base, requests);
        if (record) sheets.push(record);
      } else if (name === 'link') {
        seenLinks.add(element);
        links.push(updateLink(element, linkDescriptor(element, currentOrder, base), requests));
      }
    }
    for (const state of allStates) {
      if (!state.active) continue;
      if (state.ownerType === 'style' && !seenStyles.has(state.element)) deactivate(state);
      else if (state.ownerType === 'link' && !seenLinks.has(state.element)) deactivate(state);
    }
    const drainedCancellations = cancellations.splice(0);
    const pendingLoadCount = Array.from(allStates).filter(state => state.active && state.status === 'pending').length;
    return {sheets, links, requests, cancellations: drainedCancellations, pendingLoadCount};
  }

  // Install before page scripts can create a style element and read its sheet
  // in the same turn. The probe is detached and does not force CSS parsing.
  installSheetGetterTracking();

  function complete(completion) {
    if (!completion || typeof completion !== 'object') return false;
    const id = String(completion.id == null ? '' : completion.id);
    const transportState = statesByTransportId.get(id);
    const legacyState = transportState ? null : statesByOwnerId.get(id);
    const state = transportState || legacyState;
    if (!state || state.status !== 'pending') return false;
    if (transportState) {
      if (state.transportId !== id) return false;
      if (completion.revision != null && (!Number.isSafeInteger(completion.revision) || state.revision !== completion.revision)) return false;
    } else if (!Number.isSafeInteger(completion.revision) || state.revision !== completion.revision) {
      return false;
    }
    const current = state.ownerType === 'style' ? inlineIsCurrent(state) : linkIsCurrent(state);
    if (!current) return false;
    state.status = completion.ok === true ? 'loaded' : 'failed';
    statesByTransportId.delete(state.transportId);
    if (state.notifyLoad !== false) {
      dispatch(state.element, completion.ok === true ? 'load' : 'error');
    }
    return true;
  }

  return Object.freeze({snapshot, update: snapshot, complete});
}
