/* Native responsive-environment and matchMedia support for document scripts. */
function createPircDocumentMedia(options) {
  'use strict';
  options = options || {};

  const DEFAULTS = {
    width: 390,
    height: 844,
    devicePixelRatio: 1,
    dark: false,
    reducedMotion: false,
    pointer: 'coarse',
    hover: 'none',
    screenWidth: 390,
    screenHeight: 844,
  };
  const EVENT_TRUST = new WeakSet();
  const mediaListStates = new WeakMap();
  // Listener-bearing queries must remain alive even when page code drops its
  // reference. Temporary read-only queries are never retained.
  const activeMediaLists = new Set();
  let nextMediaListOrder = 0;
  const installedTargets = new WeakSet();
  const diagnostic = typeof options.diagnostic === 'function'
    ? options.diagnostic
    : function() {};
  const EventCtor = typeof options.Event === 'function'
    ? options.Event
    : (typeof Event === 'function' ? Event : FallbackEvent);
  const EventTargetCtor = typeof options.EventTarget === 'function'
    ? options.EventTarget
    : (typeof EventTarget === 'function' ? EventTarget : FallbackEventTarget);

  let environment = normalizeEnvironment(options.environment, DEFAULTS, true);
  const screenObject = makeScreenObject();

  function report(code, message, detail) {
    try { diagnostic(code, 'warning', message, detail); } catch (_) { /* advisory */ }
  }

  function trackMediaList(mediaList, state) {
    if (state.tracked) return;
    state.matches = evaluate(state.query, environment);
    state.tracked = true;
    activeMediaLists.add(mediaList);
  }

  function untrackMediaList(mediaList, state) {
    if (!state.tracked) return;
    state.tracked = false;
    activeMediaLists.delete(mediaList);
  }

  function getTrackedMediaLists() {
    return Array.from(activeMediaLists).sort((a,b) =>
      mediaListStates.get(a).order - mediaListStates.get(b).order);
  }

  function forgetListener(mediaList, type, listener, capture, record) {
    const state = mediaListStates.get(mediaList);
    if (!state) return;
    const byListener = state.listenerWrappers.get(type);
    const byCapture = byListener && byListener.get(listener);
    if (!byCapture || byCapture.get(capture) !== record) return;
    byCapture.delete(capture);
    if (byCapture.size === 0) byListener.delete(listener);
    if (byListener.size === 0) state.listenerWrappers.delete(type);
    if (record.abortHandler && record.signal && typeof record.signal.removeEventListener === 'function') {
      try { record.signal.removeEventListener('abort', record.abortHandler); } catch (_) { /* advisory */ }
      record.abortHandler = null;
    }
    if (record.tracked) {
      record.tracked = false;
      state.changeListenerCount--;
      if (state.changeListenerCount === 0) untrackMediaList(mediaList, state);
    }
  }

  function finiteNonNegative(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function normalizeChoice(value, allowed, fallback) {
    const choice = String(value == null ? '' : value).trim().toLowerCase();
    return allowed.includes(choice) ? choice : fallback;
  }

  function normalizeEnvironment(input, previous, initial) {
    const patch = input && typeof input === 'object' ? input : {};
    const result = {...previous};
    for (const key of ['width', 'height', 'devicePixelRatio', 'dark', 'reducedMotion',
      'pointer', 'hover', 'screenWidth', 'screenHeight']) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) result[key] = patch[key];
    }
    result.width = finiteNonNegative(result.width, previous.width);
    result.height = finiteNonNegative(result.height, previous.height);
    result.devicePixelRatio = Number(result.devicePixelRatio);
    if (!Number.isFinite(result.devicePixelRatio) || result.devicePixelRatio <= 0) {
      result.devicePixelRatio = previous.devicePixelRatio;
    }
    result.screenWidth = finiteNonNegative(result.screenWidth, previous.screenWidth);
    result.screenHeight = finiteNonNegative(result.screenHeight, previous.screenHeight);
    if (initial && !Object.prototype.hasOwnProperty.call(patch, 'screenWidth')) {
      result.screenWidth = Object.prototype.hasOwnProperty.call(patch, 'width')
        ? result.width
        : DEFAULTS.screenWidth;
    }
    if (initial && !Object.prototype.hasOwnProperty.call(patch, 'screenHeight')) {
      result.screenHeight = Object.prototype.hasOwnProperty.call(patch, 'height')
        ? result.height
        : DEFAULTS.screenHeight;
    }
    result.dark = result.dark === true;
    result.reducedMotion = result.reducedMotion === true;
    result.pointer = normalizeChoice(result.pointer, ['none', 'coarse', 'fine'], 'none');
    result.hover = normalizeChoice(result.hover, ['none', 'hover'], 'none');
    return result;
  }

  function splitTopLevelKeyword(source, keyword) {
    const lower = source.toLowerCase();
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < source.length; index++) {
      const character = source[index];
      if (character === '(') depth++;
      else if (character === ')') {
        depth--;
        if (depth < 0) return null;
      } else if (depth === 0 && lower.slice(index, index + keyword.length) === keyword &&
          (index === 0 || !/[a-z0-9_-]/i.test(source[index - 1])) &&
          (index + keyword.length === source.length || !/[a-z0-9_-]/i.test(source[index + keyword.length]))) {
        parts.push(source.slice(start, index).trim());
        start = index + keyword.length;
        index = start - 1;
      }
    }
    if (depth !== 0) return null;
    if (parts.length === 0) return [source.trim()];
    parts.push(source.slice(start).trim());
    return parts;
  }

  function stripOuterParentheses(source) {
    const text = source.trim();
    if (text[0] !== '(' || text[text.length - 1] !== ')') return null;
    let depth = 0;
    for (let index = 0; index < text.length; index++) {
      if (text[index] === '(') depth++;
      else if (text[index] === ')') {
        depth--;
        if (depth < 0 || (depth === 0 && index !== text.length - 1)) return null;
      }
    }
    return depth === 0 ? text.slice(1, -1).trim() : null;
  }

  function parseLength(value) {
    const match = String(value).trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(px|em|rem)?$/i);
    if (!match) return null;
    const number = Number(match[1]);
    if (!Number.isFinite(number)) return null;
    const unit = (match[2] || '').toLowerCase();
    if (!unit && number !== 0) return null;
    return unit === 'em' || unit === 'rem' ? number * 16 : number;
  }

  function parseResolution(value) {
    const match = String(value).trim().match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(dppx|dpi|dpcm)$/i);
    if (!match) return null;
    const number = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(number)) return null;
    if (unit === 'dppx') return number;
    if (unit === 'dpi') return number / 96;
    return number * 2.54 / 96;
  }

  function parseRatio(value) {
    const match = String(value).trim().match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+))(?:\s*\/\s*([+]?(?:\d+(?:\.\d*)?|\.\d+)))?$/);
    if (!match) return null;
    const numerator = Number(match[1]);
    const denominator = match[2] == null ? 1 : Number(match[2]);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
    return numerator / denominator;
  }

  function getNumericFeature(feature, env) {
    if (feature === 'width') return env.width;
    if (feature === 'height') return env.height;
    if (feature === 'device-width') return env.screenWidth;
    if (feature === 'device-height') return env.screenHeight;
    if (feature === 'resolution') return env.devicePixelRatio;
    if (feature === 'aspect-ratio') return env.height === 0 ? Infinity : env.width / env.height;
    return null;
  }

  function parseFeatureValue(feature, value) {
    if (feature === 'width' || feature === 'height' || feature === 'device-width' || feature === 'device-height') {
      return parseLength(value);
    }
    if (feature === 'resolution') return parseResolution(value);
    if (feature === 'aspect-ratio') return parseRatio(value);
    return null;
  }

  function compare(left, operator, right) {
    if (operator === '>') return left > right;
    if (operator === '>=') return left >= right || nearlyEqual(left, right);
    if (operator === '<') return left < right;
    if (operator === '<=') return left <= right || nearlyEqual(left, right);
    return nearlyEqual(left, right);
  }

  function nearlyEqual(left, right) {
    if (left === right) return true;
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
  }

  function featureResult(name, operator, rawValue, env) {
    const feature = name.toLowerCase();
    let baseFeature = feature;
    let prefix = '';
    if (feature.startsWith('min-')) {
      prefix = 'min-';
      baseFeature = feature.slice(4);
    } else if (feature.startsWith('max-')) {
      prefix = 'max-';
      baseFeature = feature.slice(4);
    }
    const numeric = getNumericFeature(baseFeature, env);
    if (numeric != null) {
      const expected = parseFeatureValue(baseFeature, rawValue);
      if (expected == null || !Number.isFinite(numeric)) return {valid: false, matches: false};
      if (prefix === 'min-' && operator === ':') return {valid: true, matches: numeric >= expected};
      if (prefix === 'max-' && operator === ':') return {valid: true, matches: numeric <= expected};
      if (prefix) return {valid: false, matches: false};
      return {valid: true, matches: compare(numeric, operator, expected)};
    }
    if (prefix || operator !== ':') return {valid: false, matches: false};

    const value = String(rawValue).trim().toLowerCase();
    if (baseFeature === 'orientation') {
      if (value !== 'portrait' && value !== 'landscape') return {valid: false, matches: false};
      return {valid: true, matches: value === 'landscape'
        ? env.width > env.height
        : env.height >= env.width};
    }
    if (baseFeature === 'pointer' || baseFeature === 'any-pointer') {
      if (!['none', 'coarse', 'fine'].includes(value)) return {valid: false, matches: false};
      return {valid: true, matches: value === env.pointer};
    }
    if (baseFeature === 'hover' || baseFeature === 'any-hover') {
      if (!['none', 'hover'].includes(value)) return {valid: false, matches: false};
      return {valid: true, matches: value === env.hover};
    }
    if (baseFeature === 'prefers-color-scheme') {
      if (value !== 'dark' && value !== 'light' && value !== 'no-preference') return {valid: false, matches: false};
      return {valid: true, matches: value === 'dark' ? env.dark : !env.dark};
    }
    if (baseFeature === 'prefers-reduced-motion') {
      if (value !== 'reduce' && value !== 'no-preference') return {valid: false, matches: false};
      return {valid: true, matches: value === 'reduce' ? env.reducedMotion : !env.reducedMotion};
    }
    return {valid: false, matches: false};
  }

  function parseFeature(source, env) {
    const text = source.trim();
    const valueToken = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:\\s*\\/\\s*[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))?\\s*[a-z]*';
    const operatorToken = '(?:<=|>=|<|>|=)';
    let match = text.match(new RegExp('^([a-z][a-z0-9-]*)\\s*' + operatorToken + '\\s*(' + valueToken + ')$', 'i'));
    if (match) {
      const parsed = text.match(/^([a-z][a-z0-9-]*)\s*(<=|>=|<|>|=)\s*(.*?)$/i);
      return featureResult(parsed[1], parsed[2], parsed[3], env);
    }
    match = text.match(new RegExp('^(' + valueToken + ')\\s*' + operatorToken + '\\s*([a-z][a-z0-9-]*)\\s*' + operatorToken + '\\s*(' + valueToken + ')$', 'i'));
    if (match) {
      const parsed = text.match(/^(.*?)\s*(<=|>=|<|>|=)\s*([a-z][a-z0-9-]*)\s*(<=|>=|<|>|=)\s*(.*?)$/i);
      const feature = parsed[3].toLowerCase();
      const current = getNumericFeature(feature, env);
      const lower = parseFeatureValue(feature, parsed[1]);
      const upper = parseFeatureValue(feature, parsed[5]);
      if (current == null || lower == null || upper == null || !Number.isFinite(current)) {
        return {valid: false, matches: false};
      }
      return {valid: true, matches: compare(lower, parsed[2], current) && compare(current, parsed[4], upper)};
    }
    match = text.match(new RegExp('^(' + valueToken + ')\\s*' + operatorToken + '\\s*([a-z][a-z0-9-]*)$', 'i'));
    if (match) {
      const parsed = text.match(/^(.*?)\s*(<=|>=|<|>|=)\s*([a-z][a-z0-9-]*)$/i);
      return featureResult(parsed[3], reverseOperator(parsed[2]), parsed[1], env);
    }
    match = text.match(/^([a-z][a-z0-9-]*)\s*:\s*(.*?)$/i);
    if (match) return featureResult(match[1], ':', match[2], env);

    // Range features can be tested as booleans when their value is nonzero.
    const booleanFeature = text.match(/^([a-z][a-z0-9-]*)$/i);
    if (booleanFeature) {
      const name = booleanFeature[1].toLowerCase();
      const value = getNumericFeature(name, env);
      if (value != null) return {valid: true, matches: value > 0};
      return {valid: false, matches: false};
    }
    return {valid: false, matches: false};
  }

  function reverseOperator(operator) {
    if (operator === '>') return '<';
    if (operator === '>=') return '<=';
    if (operator === '<') return '>';
    if (operator === '<=') return '>=';
    return operator;
  }

  function parseCondition(source, env) {
    const text = source.trim();
    if (!text) return {valid: false, matches: false};
    const orParts = splitTopLevelKeyword(text, 'or');
    if (!orParts) return {valid: false, matches: false};
    if (orParts.length > 1) {
      const results = orParts.map(part => parseCondition(part, env));
      return {valid: results.every(result => result.valid), matches: results.some(result => result.valid && result.matches)};
    }
    const andParts = splitTopLevelKeyword(text, 'and');
    if (!andParts) return {valid: false, matches: false};
    if (andParts.length > 1) {
      const results = andParts.map(part => parseCondition(part, env));
      return {valid: results.every(result => result.valid), matches: results.every(result => result.valid && result.matches)};
    }
    if (/^not\s+/i.test(text)) {
      const inner = parseCondition(text.replace(/^not\s+/i, ''), env);
      return {valid: inner.valid, matches: inner.valid ? !inner.matches : false};
    }
    const inner = stripOuterParentheses(text);
    if (inner == null) return {valid: false, matches: false};
    const feature = parseFeature(inner, env);
    if (feature.valid) return feature;
    return parseCondition(inner, env);
  }

  function parseOneQuery(source, env) {
    let text = source.trim();
    if (!text) return {valid: true, matches: true};
    const modifier = text.match(/^(only|not)\s+([a-z][a-z0-9-]*)(?:\s+and\s+(.+))?$/i);
    const plain = text.match(/^([a-z][a-z0-9-]*)(?:\s+and\s+(.+))?$/i);
    const typeMatch = modifier || plain;
    if (typeMatch) {
      const mode = modifier ? modifier[1].toLowerCase() : '';
      const mediaType = (modifier ? modifier[2] : typeMatch[1]).toLowerCase();
      const condition = modifier ? modifier[3] : typeMatch[2];
      if (!['all', 'screen', 'print'].includes(mediaType)) {
        return {valid: true, matches: mode === 'not'};
      }
      let matches = mediaType === 'all' || mediaType === 'screen';
      if (condition != null) {
        const result = parseCondition(condition, env);
        if (!result.valid) return {valid: false, matches: false};
        matches = matches && result.matches;
      }
      return {valid: true, matches: mode === 'not' ? !matches : matches};
    }
    return parseCondition(text, env);
  }

  function evaluate(query, env) {
    const text = String(query);
    if (text.includes('/*') || text.includes('*/')) {
      const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
      if (withoutComments.includes('/*') || withoutComments.includes('*/')) return false;
      return evaluateList(withoutComments, env);
    }
    return evaluateList(text, env);
  }

  function evaluateList(source, env) {
    let depth = 0;
    const queries = [];
    let start = 0;
    for (let index = 0; index < source.length; index++) {
      if (source[index] === '(') depth++;
      else if (source[index] === ')') {
        depth--;
        if (depth < 0) return false;
      } else if (source[index] === ',' && depth === 0) {
        queries.push(source.slice(start, index));
        start = index + 1;
      }
    }
    if (depth !== 0) return false;
    queries.push(source.slice(start));
    return queries.some(query => {
      const result = parseOneQuery(query, env);
      return result.valid && result.matches;
    });
  }

  class MediaQueryListEvent extends EventCtor {
    constructor(type, eventInitDict) {
      const init = eventInitDict && typeof eventInitDict === 'object' ? eventInitDict : {};
      const matches = init.matches === true;
      const media = String(init.media == null ? '' : init.media);
      super(String(type), {bubbles: init.bubbles === true, cancelable: init.cancelable === true});
      Object.defineProperties(this, {
        matches: {configurable: false, enumerable: true, get: () => matches},
        media: {configurable: false, enumerable: true, get: () => media},
      });
    }

    get isTrusted() { return EVENT_TRUST.has(this); }
  }

  class MediaQueryList extends EventTargetCtor {
    constructor(query) {
      super();
      const queryText = String(query);
      const trimmed = queryText.trim();
      const media = trimmed === 'not' ? 'not all' : trimmed;
      mediaListStates.set(this, {
        order: nextMediaListOrder++,
        query: queryText,
        media,
        matches: evaluate(String(query), environment),
        onchange: null,
        onchangeListener: null,
        listenerWrappers: new Map(),
        changeListenerCount: 0,
        tracked: false,
      });
    }

    get matches() {
      const state = mediaListStates.get(this);
      return state ? evaluate(state.query, environment) : false;
    }
    get media() { return mediaListStates.get(this).media; }

    listenerWrapper(type, listener, eventOptions) {
      const state = mediaListStates.get(this);
      if (!state || !listener || (typeof listener !== 'function' && typeof listener.handleEvent !== 'function')) {
        return {record: null, created: false};
      }
      let byListener = state.listenerWrappers.get(type);
      if (!byListener) state.listenerWrappers.set(type, byListener = new Map());
      let byCapture = byListener.get(listener);
      if (!byCapture) byListener.set(listener, byCapture = new Map());
      const capture = eventOptions === true || (eventOptions && typeof eventOptions === 'object' && eventOptions.capture === true);
      if (byCapture.has(capture)) return {record: byCapture.get(capture), created: false};
      const once = !!(eventOptions && typeof eventOptions === 'object' && eventOptions.once === true);
      const signal = eventOptions && typeof eventOptions === 'object' ? eventOptions.signal : null;
      const record = {wrapper: null, once, signal, abortHandler: null, tracked: false};
      const wrapped = event => {
        if (record.once) forgetListener(this, type, listener, capture, record);
        try {
          if (typeof listener === 'function') return listener.call(this, event);
          if (listener && typeof listener.handleEvent === 'function') return listener.handleEvent.call(listener, event);
        } catch (error) {
          report('media.listener', 'A MediaQueryList listener threw an exception.', {error: String(error)});
        }
      };
      record.wrapper = wrapped;
      byCapture.set(capture, record);
      return {record, created: true};
    }

    addEventListener(type, listener, eventOptions) {
      const name = String(type);
      if (listener == null || (typeof listener !== 'function' && typeof listener.handleEvent !== 'function')) return;
      const signal = eventOptions && typeof eventOptions === 'object' ? eventOptions.signal : null;
      if (signal && signal.aborted === true) return;
      const {record, created} = this.listenerWrapper(name, listener, eventOptions);
      if (!record) return;
      try {
        super.addEventListener(name, record.wrapper, eventOptions);
      } catch (error) {
        if (created) {
          const capture = eventOptions === true || (eventOptions && typeof eventOptions === 'object' && eventOptions.capture === true);
          forgetListener(this, name, listener, capture, record);
        }
        throw error;
      }
      if (created && name === 'change') {
        const state = mediaListStates.get(this);
        record.tracked = true;
        state.changeListenerCount++;
        trackMediaList(this, state);
      }
      if (created && signal && typeof signal.addEventListener === 'function') {
        const capture = eventOptions === true || (eventOptions && typeof eventOptions === 'object' && eventOptions.capture === true);
        record.abortHandler = () => {
          try { EventTargetCtor.prototype.removeEventListener.call(this, name, record.wrapper, capture); }
          catch (_) { /* the signal already removed it or the host target lacks the method */ }
          forgetListener(this, name, listener, capture, record);
        };
        try { signal.addEventListener('abort', record.abortHandler, {once: true}); }
        catch (error) {
          super.removeEventListener(name, record.wrapper, eventOptions);
          forgetListener(this, name, listener, capture, record);
          throw error;
        }
      }
    }

    removeEventListener(type, listener, eventOptions) {
      const state = mediaListStates.get(this);
      const name = String(type);
      const capture = eventOptions === true || (eventOptions && typeof eventOptions === 'object' && eventOptions.capture === true);
      const byListener = state && state.listenerWrappers.get(name);
      const byCapture = byListener && byListener.get(listener);
      const record = byCapture && byCapture.get(capture);
      super.removeEventListener(name, record ? record.wrapper : listener, eventOptions);
      if (record) forgetListener(this, name, listener, capture, record);
    }

    get onchange() { return mediaListStates.get(this).onchange; }
    set onchange(value) {
      const state = mediaListStates.get(this);
      if (!state) return;
      if (state.onchangeListener) this.removeEventListener('change', state.onchangeListener);
      state.onchange = value == null ? null : value;
      state.onchangeListener = typeof value === 'function' || (value && typeof value.handleEvent === 'function')
        ? value
        : null;
      if (state.onchangeListener) this.addEventListener('change', state.onchangeListener);
    }

    addListener(listener) { this.addEventListener('change', listener); }
    removeListener(listener) { this.removeEventListener('change', listener); }
  }

  function makeScreenObject() {
    const screen = {};
    for (const [property, key] of [
      ['width', 'screenWidth'],
      ['height', 'screenHeight'],
      ['availWidth', 'screenWidth'],
      ['availHeight', 'screenHeight'],
    ]) {
      Object.defineProperty(screen, property, {
        configurable: false,
        enumerable: true,
        get() { return environment[key]; },
      });
    }
    return screen;
  }

  function matchMedia(query) {
    return new MediaQueryList(query);
  }

  function snapshot() {
    return {...environment};
  }

  function update(nextEnvironment) {
    const previous = environment;
    const next = normalizeEnvironment(nextEnvironment, previous, false);
    const resized = previous.width !== next.width || previous.height !== next.height;
    environment = next;

    const changes = [];
    for (const mediaList of getTrackedMediaLists()) {
      const state = mediaListStates.get(mediaList);
      if (!state) continue;
      const matches = evaluate(state.query, environment);
      if (matches !== state.matches) {
        state.matches = matches;
        changes.push({mediaList, state, matches});
      }
    }
    for (const change of changes) {
      const event = new MediaQueryListEvent('change', {
        matches: change.matches,
        media: change.state.media,
      });
      EVENT_TRUST.add(event);
      try { change.mediaList.dispatchEvent(event); }
      catch (error) {
        report('media.change_dispatch', 'Could not dispatch a MediaQueryList change event.', {error: String(error)});
      }
    }
    if (resized && typeof options.dispatchResize === 'function') {
      try { options.dispatchResize({width: next.width, height: next.height}); }
      catch (error) { report('media.resize_dispatch', 'Could not dispatch a viewport resize event.', {error: String(error)}); }
    }
    return {resized, changes: changes.length, environment: snapshot()};
  }

  function install(target) {
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) return false;
    if (installedTargets.has(target)) return target;
    const properties = {
      innerWidth: () => environment.width,
      innerHeight: () => environment.height,
      devicePixelRatio: () => environment.devicePixelRatio,
      screen: () => screenObject,
    };
    for (const [key, getter] of Object.entries(properties)) {
      try {
        Object.defineProperty(target, key, {
          configurable: true,
          enumerable: true,
          get: getter,
        });
      } catch (error) {
        report('media.install_property', 'Could not install a responsive window property.', {property: key, error: String(error)});
      }
    }
    for (const [key, value] of Object.entries({
      matchMedia,
      MediaQueryList,
      MediaQueryListEvent,
    })) {
      try {
        Object.defineProperty(target, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      } catch (error) {
        report('media.install_property', 'Could not install a responsive window property.', {property: key, error: String(error)});
      }
    }
    installedTargets.add(target);
    return target;
  }

  function FallbackEvent(type, init) {
    this.type = String(type);
    this.bubbles = !!(init && init.bubbles);
    this.cancelable = !!(init && init.cancelable);
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
  }
  FallbackEvent.prototype.preventDefault = function() {
    if (this.cancelable) this.defaultPrevented = true;
  };

  function FallbackEventTarget() {
    this._listeners = new Map();
  }
  FallbackEventTarget.prototype.addEventListener = function(type, listener) {
    if (!listener) return;
    let listeners = this._listeners.get(type);
    if (!listeners) this._listeners.set(type, listeners = new Set());
    listeners.add(listener);
  };
  FallbackEventTarget.prototype.removeEventListener = function(type, listener) {
    const listeners = this._listeners.get(type);
    if (listeners) listeners.delete(listener);
  };
  FallbackEventTarget.prototype.dispatchEvent = function(event) {
    event.target = this;
    event.currentTarget = this;
    const listeners = Array.from(this._listeners.get(event.type) || []);
    for (const listener of listeners) {
      if (typeof listener === 'function') listener.call(this, event);
      else if (listener && typeof listener.handleEvent === 'function') listener.handleEvent(event);
    }
    return !event.defaultPrevented;
  };

  return Object.freeze({install, update, snapshot, matchMedia, MediaQueryList, MediaQueryListEvent});
}
