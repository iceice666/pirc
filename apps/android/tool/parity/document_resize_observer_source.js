// Native ResizeObserver delivery uses completed Flutter layout snapshots.
// It never estimates a content box from authored CSS or integer client metrics.
function createDocumentResizeObservers(options) {
  const { document, Element, layout, diagnostic } = options;
  const states = new WeakMap();
  const observers = new Set();
  const entryStates = new WeakMap();
  const sizeStates = new WeakMap();
  const token = {};
  let pending = false;
  let targetCount = 0;
  let sequence = 0;
  const reported = new WeakSet();

  function unsupported(message) {
    const error = new Error(message);
    error.name = 'NotSupportedError';
    return error;
  }
  function stateFor(observer) {
    const state = states.get(observer);
    if (!state) throw new TypeError('Illegal ResizeObserver invocation');
    return state;
  }
  function validateTarget(target) {
    if (!(target instanceof Element))
      throw new TypeError('ResizeObserver target must be an Element');
    if (target.ownerDocument !== document)
      throw unsupported('ResizeObserver cannot observe another native document');
  }
  class ResizeObserverSize {
    constructor(secret, width, height) {
      if (secret !== token) throw new TypeError('Illegal constructor');
      sizeStates.set(this, { inlineSize: width, blockSize: height });
    }
    get inlineSize() {
      return sizeStates.get(this).inlineSize;
    }
    get blockSize() {
      return sizeStates.get(this).blockSize;
    }
  }
  class ResizeObserverEntry {
    constructor(secret, target, measured) {
      if (secret !== token) throw new TypeError('Illegal constructor');
      const rect = measured.contentRect;
      const border = measured.borderBoxSize;
      entryStates.set(this, {
        target,
        contentRect: new layout.DOMRectReadOnly(rect.x, rect.y, rect.width, rect.height),
        contentBoxSize: Object.freeze([new ResizeObserverSize(token, rect.width, rect.height)]),
        borderBoxSize: Object.freeze([
          new ResizeObserverSize(token, border.inlineSize, border.blockSize),
        ]),
      });
    }
    get target() {
      return entryStates.get(this).target;
    }
    get contentRect() {
      return entryStates.get(this).contentRect;
    }
    get contentBoxSize() {
      return entryStates.get(this).contentBoxSize;
    }
    get borderBoxSize() {
      return entryStates.get(this).borderBoxSize;
    }
    get devicePixelContentBoxSize() {
      throw unsupported('Native device-pixel-content-box observation is unavailable');
    }
  }
  class ResizeObserver {
    constructor(callback) {
      if (typeof callback !== 'function')
        throw new TypeError('ResizeObserver callback must be a function');
      states.set(this, { callback, targets: new Map(), sequence: sequence++ });
    }
    observe(target, options = {}) {
      const state = stateFor(this);
      validateTarget(target);
      if (options != null && typeof options !== 'object' && typeof options !== 'function')
        throw new TypeError('ResizeObserver options must be a dictionary');
      const boxValue = options == null ? undefined : options.box;
      const box = boxValue === undefined ? 'content-box' : String(boxValue);
      if (!['content-box', 'border-box', 'device-pixel-content-box'].includes(box))
        throw new TypeError('Invalid ResizeObserver box option');
      if (box === 'device-pixel-content-box')
        throw unsupported('Native device-pixel-content-box observation is unavailable');
      if (state.targets.get(target)?.box === box) return;
      if (
        (!state.targets.has(target) && targetCount >= 5000) ||
        (!observers.has(this) && observers.size >= 256)
      )
        throw new RangeError('Native ResizeObserver observation limit exceeded');
      // Changing the observed box replaces the previous observation and last size.
      if (state.targets.delete(target)) targetCount--;
      state.targets.set(target, { box, width: -1, height: -1 });
      targetCount++;
      observers.add(this);
      pending = true;
    }
    unobserve(target) {
      const state = stateFor(this);
      validateTarget(target);
      if (state.targets.delete(target)) targetCount--;
      if (!state.targets.size) observers.delete(this);
    }
    disconnect() {
      const state = stateFor(this);
      targetCount -= state.targets.size;
      state.targets.clear();
      observers.delete(this);
    }
  }
  for (const constructor of [ResizeObserver, ResizeObserverEntry, ResizeObserverSize])
    Object.defineProperty(constructor.prototype, Symbol.toStringTag, {
      value: constructor.name,
      configurable: true,
    });

  function deliver() {
    if (!pending || layout.needsLayout()) return;
    pending = false;
    // Gather every entry before invoking any callback. DOM writes by an earlier
    // observer must not change the entries already collected for another one.
    const batches = [];
    for (const observer of Array.from(observers).sort(
      (a, b) => states.get(a).sequence - states.get(b).sequence,
    )) {
      const state = states.get(observer);
      const entries = [];
      for (const [target, observation] of state.targets) {
        const measured = layout.resizeObservation(target);
        if (!measured) {
          if (!reported.has(target)) {
            reported.add(target);
            diagnostic(
              'resize_observer.unavailable',
              'warning',
              'Native layout did not supply a supported ResizeObserver box.',
              { tag: target.localName },
            );
          }
          continue;
        }
        const selected =
          observation.box === 'border-box'
            ? measured.borderBoxSize
            : { inlineSize: measured.contentRect.width, blockSize: measured.contentRect.height };
        if (selected.inlineSize === observation.width && selected.blockSize === observation.height)
          continue;
        entries.push(new ResizeObserverEntry(token, target, measured));
      }
      if (entries.length) batches.push({ observer, state, entries });
    }
    for (const { observer, state, entries } of batches) {
      // Cancellation by an earlier observer also cancels an undelivered entry.
      // A box-option change keeps the entry but commits the newly selected size.
      const activeEntries = entries.filter((entry) => state.targets.has(entry.target));
      if (!activeEntries.length) continue;
      for (const entry of activeEntries) {
        const observation = state.targets.get(entry.target);
        const size =
          observation.box === 'border-box' ? entry.borderBoxSize[0] : entry.contentBoxSize[0];
        observation.width = size.inlineSize;
        observation.height = size.blockSize;
      }
      try {
        state.callback.call(observer, activeEntries, observer);
      } catch (error) {
        diagnostic('resize_observer.callback_error', 'error', String(error?.stack || error));
      }
    }
  }
  return {
    ResizeObserver,
    ResizeObserverEntry,
    ResizeObserverSize,
    changed() {
      if (observers.size) pending = true;
    },
    pending() {
      return pending && observers.size > 0 && !layout.needsLayout();
    },
    deliver,
  };
}
