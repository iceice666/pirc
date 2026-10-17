/* Session-history mirror. The host owns traversal and document retention. */
function createDocumentHistory(options) {
  const URLCtor = options.URL;
  const codec = options.codec;
  const initial = options.initial || {};
  const error = (name, message) => new options.DOMException(message, name);
  let index = Number.isSafeInteger(initial.index) ? initial.index : 0;
  let length = Number.isSafeInteger(initial.length) && initial.length > index
    ? initial.length : index + 1;
  let revision = Number.isSafeInteger(initial.ackRevision) ? initial.ackRevision : 0;
  let entryKey = typeof initial.entryKey === 'string' ? initial.entryKey : 'initial';
  const scope = typeof options.scope === 'string' ? 'history:' + options.scope : entryKey + ':js';
  let pendingTraversalIndex = null;
  let graph = initial.stateGraph == null ? codec.serialize(null) : initial.stateGraph;
  let stateValue = codec.deserialize(graph);
  let scroll = initial.scrollRestoration === 'manual' ? 'manual' : 'auto';
  if (typeof initial.url === 'string') options.setURL(new URLCtor(initial.url).href);
  const history = Object.create(History.prototype);
  function check(receiver) {
    if (receiver !== history) throw new TypeError('Illegal invocation');
  }
  function domString(value) {
    // Template conversion uses the Web IDL string hint and rejects Symbols.
    return `${value}`;
  }
  function rewriteURL(value) {
    const current = new URLCtor(options.getURL());
    if (value == null || value === '') return current.href;
    let next;
    try { next = new URLCtor(value, options.getBaseURL()); }
    catch (_) { throw error('SecurityError', 'The history URL is invalid.'); }
    if (current.protocol !== next.protocol || current.username !== next.username ||
        current.password !== next.password || current.host !== next.host ||
        (!['http:', 'https:'].includes(current.protocol) &&
          (current.pathname !== next.pathname || current.search !== next.search))) {
      throw error('SecurityError', 'The history URL cannot rewrite this document URL.');
    }
    if (next.href.length > 8192) throw error('SecurityError', 'The history URL exceeds the document limit.');
    return next.href;
  }
  function queue(action) {
    options.enqueue(Object.freeze(Object.assign({kind: 'history', target: '_self',
      actionOrder: options.nextActionOrder()}, action)));
  }
  function mutate(receiver, method, args) {
    check(receiver);
    if (args.length < 2) throw new TypeError('History requires data and unused arguments.');
    domString(args[1]);
    // Nullable optional USVString conversion precedes structured serialization.
    const rawURL = args.length < 3 || args[2] == null ? null : domString(args[2]);
    const nextGraph = codec.serialize(args[0]);
    const url = rewriteURL(rawURL);
    const nextState = codec.deserialize(nextGraph);
    const nextRevision = revision + 1;
    const key = method === 'push' ? scope + ':' + nextRevision : entryKey;
    // Enqueue before changing the mirror: quota failure must be atomic.
    queue({method, revision: nextRevision, url, stateGraph: nextGraph, entryKey: key,
      scrollRestoration: scroll});
    revision = nextRevision;
    if (method === 'push') { index++; length = index + 1; }
    entryKey = key; graph = nextGraph; stateValue = nextState;
    options.setURL(url);
  }
  function traverse(delta) {
    if (delta === 0) { queue({method: 'go', delta: 0}); return; }
    // Reject a call which is out of bounds now, even if an earlier traversal is pending.
    if (index + delta < 0 || index + delta >= length) return;
    const target = (pendingTraversalIndex == null ? index : pendingTraversalIndex) + delta;
    if (target < 0 || target >= length) return;
    queue({method: 'go', delta, index: target});
    pendingTraversalIndex = target;
  }
  function History() { throw new TypeError('Illegal constructor'); }
  Object.defineProperties(History.prototype, {
    constructor: {value: History, writable: true, configurable: true},
    [Symbol.toStringTag]: {value: 'History', configurable: true},
    length: {enumerable: true, configurable: true, get() { check(this); return length; }},
    state: {enumerable: true, configurable: true, get() { check(this); return stateValue; }},
    scrollRestoration: {enumerable: true, configurable: true,
      get() { check(this); return scroll; },
      set(value) {
        check(this);
        const mode = domString(value);
        if (mode !== 'auto' && mode !== 'manual') throw new TypeError('Invalid ScrollRestoration value.');
        queue({method: 'scroll', revision: revision + 1, scrollRestoration: mode});
        revision++; scroll = mode;
      }},
    pushState: {value: function pushState(data, unused) { mutate(this, 'push', arguments); },
      enumerable: true, configurable: true, writable: true},
    replaceState: {value: function replaceState(data, unused) { mutate(this, 'replace', arguments); },
      enumerable: true, configurable: true, writable: true},
    go: {value: function go(delta) {
      check(this);
      const number = delta === undefined ? 0 : +delta;
      let converted = Number.isFinite(number) ? Math.trunc(number) : 0;
      converted = ((converted % 4294967296) + 4294967296) % 4294967296;
      if (converted >= 2147483648) converted -= 4294967296;
      traverse(converted);
    }, enumerable: true, configurable: true, writable: true},
    back: {value: function back() { check(this); traverse(-1); },
      enumerable: true, configurable: true, writable: true},
    forward: {value: function forward() { check(this); traverse(1); },
      enumerable: true, configurable: true, writable: true}
  });
  function update(snapshot) {
    if (!snapshot || typeof snapshot.url !== 'string' ||
        typeof snapshot.entryKey !== 'string' || !Number.isSafeInteger(snapshot.index) ||
        !Number.isSafeInteger(snapshot.length) || snapshot.index < 0 ||
        snapshot.index >= snapshot.length) throw new TypeError('Invalid host history snapshot.');
    const acknowledged = Number.isSafeInteger(snapshot.ackRevision) ? snapshot.ackRevision : 0;
    // A host acknowledgment can arrive between two synchronous script mutations.
    if (acknowledged < revision) return;
    const changed = snapshot.entryKey !== entryKey;
    const oldURL = options.getURL();
    const url = new URLCtor(snapshot.url).href;
    const nextGraph = snapshot.stateGraph == null ? codec.serialize(null) : snapshot.stateGraph;
    const nextState = changed ? codec.deserialize(nextGraph) : stateValue;
    index = snapshot.index; length = snapshot.length; revision = acknowledged;
    entryKey = snapshot.entryKey; graph = nextGraph; stateValue = nextState;
    scroll = snapshot.scrollRestoration === 'manual' ? 'manual' : 'auto';
    options.setURL(url);
    if (changed) {
      pendingTraversalIndex = null;
      // Capture both URLs before listeners run; a popstate handler may push again.
      const before = new URLCtor(oldURL), after = new URLCtor(url);
      const hashChanged = before.hash !== after.hash ||
        before.href.includes('#') !== after.href.includes('#');
      options.dispatchPopState(stateValue);
      if (hashChanged) options.dispatchHashChange(oldURL, url);
    }
  }
  return {history, History, update};
}
