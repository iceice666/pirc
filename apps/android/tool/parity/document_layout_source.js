// Private document-layout bridge used by the mobile JavaScriptSandbox runtime.
// This file deliberately has no imports or exports so it can be loaded as a
// plain script in the isolated JavaScriptSandbox context.
function createPircDocumentLayout(options) {
  const config = options || {};
  const documentRef = config.document;
  const ElementCtor = config.Element;
  const HTMLElementCtor = config.HTMLElement;
  const MutationObserverCtor = config.MutationObserver;
  const ensureElementId = config.ensureElementId;
  const resolveElementId = config.resolveElementId;
  const diagnostic = config.diagnostic;
  const enabled = config.enabled === true;

  if (!documentRef || typeof ElementCtor !== 'function' || typeof HTMLElementCtor !== 'function') {
    throw new TypeError('createPircDocumentLayout requires document, Element, and HTMLElement');
  }
  if (typeof ensureElementId !== 'function' || typeof resolveElementId !== 'function') {
    throw new TypeError('createPircDocumentLayout requires ensureElementId and resolveElementId');
  }

  const internalAttributes = new Set(['data-pirc-script-id', 'data-pirc-script-click']);
  const validId = /^pirc-[1-9][0-9]*$/;
  const metricNames = [
    'clientLeft',
    'clientTop',
    'clientWidth',
    'clientHeight',
    'offsetWidth',
    'offsetHeight',
  ];
  const scrollMetricNames = ['scrollLeft', 'scrollTop', 'scrollWidth', 'scrollHeight'];
  const MAX_SCROLL_EVENTS = 5000;
  let revisionValue = 1;
  let lastGeneration = 0;
  let layoutSnapshot = null;
  let installed = false;
  let observer = null;
  let scrollActionQueue = null;
  let internalMutationDepth = 0;
  const knownElements = new Map();

  const rectState = new WeakMap();
  class DOMRectReadOnly {
    constructor(x, y, width, height) {
      rectState.set(this, {
        x: Number(x ?? 0),
        y: Number(y ?? 0),
        width: Number(width ?? 0),
        height: Number(height ?? 0),
      });
    }
    get x() { return rectState.get(this).x; }
    get y() { return rectState.get(this).y; }
    get width() { return rectState.get(this).width; }
    get height() { return rectState.get(this).height; }
    get top() { return Math.min(this.y, this.y + this.height); }
    get right() { return Math.max(this.x, this.x + this.width); }
    get bottom() { return Math.max(this.y, this.y + this.height); }
    get left() { return Math.min(this.x, this.x + this.width); }
    toJSON() {
      return {
        x: this.x,
        y: this.y,
        width: this.width,
        height: this.height,
        top: this.top,
        right: this.right,
        bottom: this.bottom,
        left: this.left,
      };
    }
    static fromRect(other) {
      const value = other || {};
      return new DOMRectReadOnly(value.x ?? 0, value.y ?? 0, value.width ?? 0, value.height ?? 0);
    }
  }
  class DOMRect extends DOMRectReadOnly {
    set x(value) { rectState.get(this).x = Number(value); }
    get x() { return rectState.get(this).x; }
    set y(value) { rectState.get(this).y = Number(value); }
    get y() { return rectState.get(this).y; }
    set width(value) { rectState.get(this).width = Number(value); }
    get width() { return rectState.get(this).width; }
    set height(value) { rectState.get(this).height = Number(value); }
    get height() { return rectState.get(this).height; }
    static fromRect(other) {
      const value = other || {};
      return new DOMRect(value.x ?? 0, value.y ?? 0, value.width ?? 0, value.height ?? 0);
    }
  }

  function emitDiagnostic(code, details) {
    if (typeof diagnostic !== 'function') return;
    try {
      diagnostic(code, details || {});
    } catch (_) {
      // Diagnostics must not alter DOM geometry behavior.
    }
  }

  function notSupported(code, message, details) {
    emitDiagnostic(`layout.${code}`, details);
    if (typeof DOMException === 'function') return new DOMException(message, 'NotSupportedError');
    const error = new Error(message);
    error.name = 'NotSupportedError';
    return error;
  }

  function validateElement(element) {
    if (!(element instanceof ElementCtor)) throw new TypeError('Expected an Element owned by this document');
    if (element.ownerDocument !== documentRef) throw new TypeError('Element belongs to a different document');
  }

  function isConnected(element) {
    const root = documentRef.documentElement;
    if (root && typeof root.contains === 'function') return root.contains(element);
    if (typeof documentRef.contains === 'function') return documentRef.contains(element);
    return element.isConnected === true;
  }

  function isSafeId(id) {
    return typeof id === 'string' && validId.test(id);
  }

  function ownIdForElement(element) {
    const id = ensureElementId(element);
    if (!isSafeId(id)) throw new TypeError('ensureElementId returned an invalid element id');
    let resolved;
    try {
      resolved = resolveElementId(id);
    } catch (_) {
      throw new TypeError('Element id could not be resolved');
    }
    if (resolved !== element) throw new TypeError('Element id does not resolve to the same element');
    const known = knownElements.get(id);
    if (known && known !== element) throw new TypeError('Element id is already owned by another element');
    knownElements.set(id, element);
    return id;
  }

  function consumeMutationRecords(records) {
    if (internalMutationDepth > 0 || !records || records.length === 0) return;
    let relevant = false;
    for (const record of records) {
      if (record && record.type === 'attributes' && internalAttributes.has(record.attributeName)) continue;
      relevant = true;
      break;
    }
    if (relevant) advanceRevision();
  }

  function advanceRevision() {
    if (revisionValue >= Number.MAX_SAFE_INTEGER) throw new RangeError('Document layout revision overflow');
    revisionValue += 1;
    return revisionValue;
  }

  function runWithoutMutationInvalidation(callback) {
    if (typeof callback !== 'function') throw new TypeError('Expected an internal mutation callback');
    // Preserve mutations that happened before entering this internal operation.
    currentRevision();
    internalMutationDepth += 1;
    try {
      return callback();
    } finally {
      internalMutationDepth -= 1;
      // LinkeDOM can report mutations made while cloning a Document against its
      // source Document. The clone is private snapshot work, so discard only
      // those records after all guest mutations have been synchronously drained.
      if (observer && typeof observer.takeRecords === 'function') observer.takeRecords();
    }
  }

  function currentRevision() {
    if (observer && typeof observer.takeRecords === 'function') consumeMutationRecords(observer.takeRecords());
    return revisionValue;
  }

  function layoutIsNeeded() {
    if (!enabled) return false;
    const current = currentRevision();
    if (!layoutSnapshot || layoutSnapshot.revision !== current) return true;
    for (const [id, element] of knownElements) {
      if (element.ownerDocument !== documentRef || !isConnected(element)) continue;
      const box = layoutSnapshot.boxes.get(id);
      if (!box || box.element !== element) return true;
    }
    return false;
  }

  function status() {
    const current = currentRevision();
    return { revision: current, required: enabled && layoutIsNeeded() };
  }

  function viewport() {
    if (!layoutSnapshot) {
      throw notSupported('unmeasured', 'Native viewport geometry has not been measured', {
        revision: currentRevision(),
      });
    }
    return layoutSnapshot.viewport;
  }

  function requireBox(element) {
    validateElement(element);
    if (!isConnected(element)) return { detached: true };
    if (!enabled) {
      throw notSupported('unavailable', 'Document geometry is unavailable because layout parity is disabled', {
        revision: currentRevision(),
      });
    }
    const id = ownIdForElement(element);
    const current = currentRevision();
    if (!layoutSnapshot) {
      throw notSupported('unmeasured', 'Document geometry has not been measured', { id, revision: current });
    }
    if (layoutSnapshot.revision !== current) {
      throw notSupported('stale', 'Document geometry is stale after a document mutation', {
        id,
        revision: current,
        measuredRevision: layoutSnapshot.revision,
      });
    }
    const box = layoutSnapshot.boxes.get(id);
    if (!box || box.element !== element) {
      throw notSupported('unmeasured', 'Document geometry has not been measured for this element', { id, revision: current });
    }
    if (box.kind === 'unsupported') {
      throw notSupported('unavailable', 'Document geometry for this element is not supported by the native layout bridge', {
        id,
        revision: current,
        kind: box.kind,
      });
    }
    return { detached: false, box, viewport: layoutSnapshot.viewport };
  }

  function zeroRect() {
    return new DOMRect(0, 0, 0, 0);
  }

  function createRectList(rects) {
    const list = {
      length: rects.length,
      item(index) {
        const number = Number(index);
        if (!Number.isInteger(number) || number < 0 || number >= rects.length) return null;
        return rects[number];
      },
      [Symbol.iterator]() { return rects[Symbol.iterator](); },
    };
    for (let i = 0; i < rects.length; i += 1) {
      Object.defineProperty(list, i, { value: rects[i], enumerable: true, configurable: false, writable: false });
    }
    Object.defineProperty(list, Symbol.toStringTag, { value: 'DOMRectList' });
    return list;
  }

  function boundingClientRect(element) {
    const result = requireBox(element);
    if (result.detached || result.box.kind === 'none') return zeroRect();
    const box = result.box;
    return new DOMRect(
      box.x - result.viewport.scrollX,
      box.y - result.viewport.scrollY,
      box.width,
      box.height,
    );
  }

  function clientRects(element) {
    const result = requireBox(element);
    if (result.detached || result.box.kind === 'none') return createRectList([]);
    const box = result.box;
    return createRectList([new DOMRect(
      box.x - result.viewport.scrollX,
      box.y - result.viewport.scrollY,
      box.width,
      box.height,
    )]);
  }

  function isStandardsModeDocument() {
    const doctype = documentRef.doctype;
    if (!doctype) return false;
    const name = typeof doctype === 'string' ? doctype.split(/\s+/, 1)[0] : doctype.name;
    if (typeof name !== 'string' || name.toLowerCase() !== 'html') return false;
    if (typeof doctype === 'object' && doctype !== null &&
        ((doctype.publicId && String(doctype.publicId).length > 0) ||
         (doctype.systemId && String(doctype.systemId).length > 0))) return false;
    return true;
  }

  function metric(element, name) {
    const result = requireBox(element);
    if (result.detached || result.box.kind === 'none') return 0;
    if (element === documentRef.documentElement) {
      if (isStandardsModeDocument()) {
        if (name === 'clientLeft' || name === 'clientTop') return 0;
        if (name === 'clientWidth') return result.viewport.width;
        if (name === 'clientHeight') return result.viewport.height;
      } else if (name === 'clientWidth' || name === 'clientHeight') {
        emitDiagnostic('layout.quirks_root_viewport_unavailable', {
          id: result.box.id,
          revision: result.box.revision,
          metric: name,
          reason: 'A standards-mode <!doctype html> was not present.',
        });
      }
    }
    if (!Object.prototype.hasOwnProperty.call(result.box.metrics, name)) {
      throw notSupported('unavailable', `Native layout did not provide ${name}`, {
        id: result.box.id,
        revision: result.box.revision,
        metric: name,
      });
    }
    return result.box.metrics[name];
  }

  function scrollMetric(element, name) {
    const result = requireBox(element);
    if (result.detached || result.box.kind === 'none') return 0;
    if (element === documentRef.documentElement && isStandardsModeDocument()) {
      if (name === 'scrollLeft') return result.viewport.scrollX;
      if (name === 'scrollTop') return result.viewport.scrollY;
      return documentScrollExtent(element, name);
    }
    const scroll = result.box.scroll;
    if (!scroll) {
      throw notSupported('unavailable', `Native layout did not provide ${name} for this element`, {
        id: result.box.id,
        revision: result.box.revision,
        metric: name,
      });
    }
    if (name === 'scrollLeft') return scroll.left;
    if (name === 'scrollTop') return scroll.top;
    return Math.ceil(name === 'scrollWidth' ? scroll.width : scroll.height);
  }

  function documentScrollExtent(element, name) {
    validateElement(element);
    if (!isConnected(element)) return 0;
    if (!enabled) {
      throw notSupported('unavailable', 'Document scroll extents are unavailable because layout parity is disabled', {
        metric: name,
        revision: currentRevision(),
      });
    }
    if (element !== documentRef.documentElement || !isStandardsModeDocument()) {
      throw notSupported('unavailable', `Native layout did not provide ${name} for this element`, {
        metric: name,
        revision: currentRevision(),
      });
    }
    const current = currentRevision();
    if (!layoutSnapshot) {
      throw notSupported('unmeasured', 'Document scroll extents have not been measured', {
        metric: name,
        revision: current,
      });
    }
    if (layoutSnapshot.revision !== current) {
      throw notSupported('stale', 'Document scroll extents are stale after a document mutation', {
        metric: name,
        revision: current,
        measuredRevision: layoutSnapshot.revision,
      });
    }
    const viewportName = name === 'scrollHeight' ? 'height' : 'width';
    const contentName = name === 'scrollHeight' ? 'contentHeight' : 'contentWidth';
    if (!Object.prototype.hasOwnProperty.call(layoutSnapshot.viewport, contentName)) {
      throw notSupported('unavailable', `Native layout did not provide ${name} for the document scrolling area`, {
        metric: name,
        revision: current,
      });
    }
    // CSSOM View defines root scroll extents as the larger of the native
    // scrolling area and viewport dimensions. These are host-measured content
    // extents, never inferred from element boxes.
    // Chromium's integer scroll metrics round fractional CSS-pixel extents up.
    return Math.ceil(Math.max(layoutSnapshot.viewport[viewportName], layoutSnapshot.viewport[contentName]));
  }

  function elementScrollTarget(element) {
    validateElement(element);
    if (!isConnected(element)) return null;
    if (!enabled) {
      throw notSupported('unavailable', 'Element scrolling is unavailable because layout parity is disabled', {
        revision: currentRevision(),
      });
    }
    const id = ownIdForElement(element);
    const current = currentRevision();
    // A clean, native-confirmed no-box element cannot own a scroll container.
    // A stale snapshot is not evidence: mutation-then-scroll must still queue.
    if (layoutSnapshot && layoutSnapshot.revision === current) {
      const box = layoutSnapshot.boxes.get(id);
      if (box && box.element === element && box.kind === 'none') return null;
    }
    if (element === documentRef.documentElement && isStandardsModeDocument()) {
      return { viewport: true };
    }
    return { id };
  }

  function queueElementScrollAction(element, kind, x, y, behavior) {
    const target = elementScrollTarget(element);
    if (!target) return false;
    if (typeof scrollActionQueue !== 'function') {
      throw notSupported('unavailable', 'Native element scrolling is unavailable', {
        id: target.id,
        revision: currentRevision(),
      });
    }
    scrollActionQueue(target, kind, x, y, behavior);
    return true;
  }

  function setElementScrollOffset(element, name, value) {
    const number = +value;
    const coordinate = Number.isFinite(number) ? number : 0;
    queueElementScrollAction(
      element,
      'to',
      name === 'scrollLeft' ? coordinate : null,
      name === 'scrollTop' ? coordinate : null,
      'auto',
    );
  }

  function requireFiniteNumber(value, label, nonnegative) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
    if (nonnegative && value < 0) throw new RangeError(`${label} must be nonnegative`);
    return value;
  }

  function requirePositiveSafeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
    return value;
  }

  function validatePacket(packet) {
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new TypeError('Layout packet must be an object');
    const revision = requirePositiveSafeInteger(packet.revision, 'packet.revision');
    const generation = requirePositiveSafeInteger(packet.generation, 'packet.generation');
    if (!packet.viewport || typeof packet.viewport !== 'object' || Array.isArray(packet.viewport)) {
      throw new TypeError('packet.viewport must be an object');
    }
    const viewportValue = {
      scrollX: requireFiniteNumber(packet.viewport.scrollX, 'viewport.scrollX', false),
      scrollY: requireFiniteNumber(packet.viewport.scrollY, 'viewport.scrollY', false),
      width: requireFiniteNumber(packet.viewport.width, 'viewport.width', true),
      height: requireFiniteNumber(packet.viewport.height, 'viewport.height', true),
    };
    const hasContentWidth = Object.prototype.hasOwnProperty.call(packet.viewport, 'contentWidth');
    const hasContentHeight = Object.prototype.hasOwnProperty.call(packet.viewport, 'contentHeight');
    if (hasContentWidth !== hasContentHeight) {
      throw new TypeError('packet.viewport.contentWidth and contentHeight must be supplied together');
    }
    if (hasContentWidth) {
      viewportValue.contentWidth = requireFiniteNumber(packet.viewport.contentWidth, 'viewport.contentWidth', true);
      viewportValue.contentHeight = requireFiniteNumber(packet.viewport.contentHeight, 'viewport.contentHeight', true);
    }
    const viewport = Object.freeze(viewportValue);
    if (!Array.isArray(packet.boxes)) throw new TypeError('packet.boxes must be an array');
    if (packet.boxes.length > 5000) throw new RangeError('packet.boxes may contain at most 5000 entries');

    const stagedBoxes = new Map();
    const stagedElements = new Map();
    for (const source of packet.boxes) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('Each layout box must be an object');
      const id = source.id;
      if (!isSafeId(id)) throw new TypeError('Layout box id is invalid');
      if (stagedBoxes.has(id)) throw new TypeError(`Duplicate layout box id: ${id}`);
      if (source.kind !== 'box' && source.kind !== 'none' && source.kind !== 'unsupported') {
        throw new TypeError(`Unsupported layout box kind for ${id}`);
      }

      let element;
      try {
        element = resolveElementId(id);
      } catch (_) {
        throw new TypeError(`Unknown layout box id: ${id}`);
      }
      if (!element) throw new TypeError(`Unknown layout box id: ${id}`);
      if (!(element instanceof ElementCtor) || element.ownerDocument !== documentRef) {
        throw new TypeError(`Layout box id resolves to a foreign element: ${id}`);
      }
      let ensuredId;
      try {
        ensuredId = ensureElementId(element);
      } catch (_) {
        throw new TypeError(`Layout box id could not be verified: ${id}`);
      }
      if (ensuredId !== id) throw new TypeError(`Layout box id does not own its resolved element: ${id}`);
      const known = knownElements.get(id);
      if (known && known !== element) throw new TypeError(`Layout box id is already owned by another element: ${id}`);

      const bounds = {};
      for (const name of ['x', 'y', 'width', 'height']) {
        if (Object.prototype.hasOwnProperty.call(source, name) || source.kind === 'box') {
          bounds[name] = requireFiniteNumber(source[name], `${id}.${name}`, name === 'width' || name === 'height');
        }
      }
      const metrics = {};
      let scroll = null;
      if (source.kind === 'box') {
        const { x, y, width, height } = bounds;
        for (const name of metricNames) {
          if (Object.prototype.hasOwnProperty.call(source, name)) {
            metrics[name] = requireFiniteNumber(source[name], `${id}.${name}`, true);
          }
        }
        if (Object.prototype.hasOwnProperty.call(source, 'scroll')) {
          const rawScroll = source.scroll;
          if (!rawScroll || typeof rawScroll !== 'object' || Array.isArray(rawScroll)) {
            throw new TypeError(`${id}.scroll must be an object`);
          }
          scroll = Object.freeze({
            left: requireFiniteNumber(rawScroll.left, `${id}.scroll.left`, false),
            top: requireFiniteNumber(rawScroll.top, `${id}.scroll.top`, false),
            width: requireFiniteNumber(rawScroll.width, `${id}.scroll.width`, true),
            height: requireFiniteNumber(rawScroll.height, `${id}.scroll.height`, true),
          });
        }
        stagedBoxes.set(id, Object.freeze({ id, kind: source.kind, x, y, width, height, metrics: Object.freeze(metrics), scroll, element, revision }));
      } else {
        if (Object.prototype.hasOwnProperty.call(source, 'scroll')) {
          throw new TypeError(`${id}.scroll requires a box entry`);
        }
        for (const name of metricNames) {
          if (Object.prototype.hasOwnProperty.call(source, name)) {
            metrics[name] = requireFiniteNumber(source[name], `${id}.${name}`, true);
          }
        }
        stagedBoxes.set(id, Object.freeze({
          id,
          kind: source.kind,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          metrics: Object.freeze(metrics),
          scroll: null,
          element,
          revision,
        }));
      }
      stagedElements.set(id, element);
    }
    const stagedScrollEvents = [];
    if (Object.prototype.hasOwnProperty.call(packet, 'scrollEvents')) {
      if (!Array.isArray(packet.scrollEvents)) throw new TypeError('packet.scrollEvents must be an array');
      if (packet.scrollEvents.length > MAX_SCROLL_EVENTS) {
        throw new RangeError(`packet.scrollEvents may contain at most ${MAX_SCROLL_EVENTS} entries`);
      }
      let previousSequence = 0;
      for (const source of packet.scrollEvents) {
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
          throw new TypeError('Each native scroll event must be an object');
        }
        const id = source.id;
        if (!isSafeId(id)) throw new TypeError('Native scroll event id is invalid');
        const sequence = requirePositiveSafeInteger(source.sequence, `${id}.scrollEvent.sequence`);
        if (sequence <= previousSequence) {
          throw new RangeError('packet.scrollEvents sequences must be strictly increasing');
        }
        previousSequence = sequence;
        const element = stagedElements.get(id);
        const box = stagedBoxes.get(id);
        if (!element || !box || box.element !== element || box.kind !== 'box' || !box.scroll ||
            element.ownerDocument !== documentRef || !isConnected(element)) {
          throw new TypeError(`Native scroll event id is not a connected measured scroll owner: ${id}`);
        }
        stagedScrollEvents.push(Object.freeze({ id, sequence, element }));
      }
    }
    return {
      revision, generation, viewport, boxes: stagedBoxes, elements: stagedElements,
      scrollEvents: stagedScrollEvents,
    };
  }

  function update(packet) {
    const current = currentRevision();
    const candidateRevision = packet && typeof packet === 'object' ? packet.revision : null;
    if (Number.isSafeInteger(candidateRevision) && candidateRevision > 0 && candidateRevision < current) {
      const error = new RangeError(`Layout packet revision ${candidateRevision} is stale; current revision is ${current}`);
      error.code = 'PIRC_LAYOUT_STALE_REVISION';
      throw error;
    }
    const staged = validatePacket(packet);
    if (staged.revision !== current) {
      throw new RangeError(`Layout packet revision ${staged.revision} is ahead of current revision ${current}`);
    }
    if (staged.generation <= lastGeneration) {
      throw new RangeError(`Layout generation ${staged.generation} is not newer than ${lastGeneration}`);
    }
    const scrollChanges = [];
    if (layoutSnapshot) {
      for (const [id, box] of staged.boxes) {
        if (box.kind !== 'box' || !box.scroll || !isConnected(box.element)) continue;
        const previous = layoutSnapshot.boxes.get(id);
        if (!previous || previous.element !== box.element || previous.kind !== 'box' || !previous.scroll) continue;
        if (previous.scroll.left !== box.scroll.left || previous.scroll.top !== box.scroll.top) {
          scrollChanges.push({ id, element: box.element, left: box.scroll.left, top: box.scroll.top });
        }
      }
    }
    layoutSnapshot = Object.freeze({
      revision: staged.revision,
      generation: staged.generation,
      viewport: staged.viewport,
      boxes: staged.boxes,
    });
    for (const [id, element] of staged.elements) knownElements.set(id, element);
    lastGeneration = staged.generation;
    return {
      ok: true, revision: staged.revision, generation: staged.generation,
      scrollEvents: staged.scrollEvents.slice(), scrollChanges,
    };
  }

  function hasCurrentBox(element) {
    if (!(element instanceof ElementCtor) || element.ownerDocument !== documentRef || !isConnected(element) || !enabled) return false;
    const id = ownIdForElement(element);
    const current = currentRevision();
    return Boolean(layoutSnapshot && layoutSnapshot.revision === current && layoutSnapshot.boxes.has(id) && layoutSnapshot.boxes.get(id).element === element);
  }

  function install() {
    if (installed) return api;
    Object.defineProperty(ElementCtor.prototype, 'getBoundingClientRect', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function getBoundingClientRect() { return boundingClientRect(this); },
    });
    Object.defineProperty(ElementCtor.prototype, 'getClientRects', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function getClientRects() { return clientRects(this); },
    });
    for (const name of metricNames) {
      Object.defineProperty(HTMLElementCtor.prototype, name, {
        configurable: true,
        enumerable: false,
        get() { return metric(this, name); },
      });
    }
    for (const name of scrollMetricNames) {
      Object.defineProperty(ElementCtor.prototype, name, {
        configurable: true,
        enumerable: false,
        get() { return scrollMetric(this, name); },
        ...(name === 'scrollLeft' || name === 'scrollTop' ? {
          set(value) { setElementScrollOffset(this, name, value); },
        } : {}),
      });
    }
    if (typeof MutationObserverCtor === 'function') {
      observer = new MutationObserverCtor((records) => consumeMutationRecords(records));
      observer.observe(documentRef, { subtree: true, childList: true, characterData: true, attributes: true });
    }
    installed = true;
    return api;
  }

  const api = {
    install,
    revision: currentRevision,
    invalidate: advanceRevision,
    runWithoutMutationInvalidation,
    needsLayout: layoutIsNeeded,
    status,
    viewport,
    update,
    scrollMetric(element, name) { return scrollMetric(element, name); },
    elementScrollTarget,
    queueElementScrollAction,
    setScrollActionQueue(callback) {
      if (callback !== null && typeof callback !== 'function') throw new TypeError('Scroll action queue must be a function');
      scrollActionQueue = callback;
    },
    getBoundingClientRect(element) { return boundingClientRect(element); },
    hasCurrentBox,
    DOMRect,
    DOMRectReadOnly,
  };
  return api;
}
