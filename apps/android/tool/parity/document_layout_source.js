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
  const initialMode = config.documentMode;
  if (initialMode != null && !['quirks', 'limited quirks', 'no quirks'].includes(initialMode))
    throw new TypeError('Native document mode is invalid');
  // Mode is fixed by the initial HTML parse, not by later doctype mutations.
  const standardsMode = initialMode == null ? inferInitialStandardsMode() : initialMode !== 'quirks';

  if (!documentRef || typeof ElementCtor !== 'function' || typeof HTMLElementCtor !== 'function') {
    throw new TypeError('createPircDocumentLayout requires document, Element, and HTMLElement');
  }
  if (typeof ensureElementId !== 'function' || typeof resolveElementId !== 'function') {
    throw new TypeError('createPircDocumentLayout requires ensureElementId and resolveElementId');
  }

  const internalAttributes = new Set(['data-pirc-script-id', 'data-pirc-script-click']);
  const readAttribute = ElementCtor.prototype.getAttribute;
  // Reassigning these attributes can reload resources or reset live control
  // state even when their serialized value is unchanged. Keep their fence.
  const repeatedEffectAttributes = new Set([
    'src', 'srcdoc', 'srcset', 'sizes', 'href', 'data', 'poster',
    'crossorigin', 'referrerpolicy', 'fetchpriority', 'loading', 'decoding',
    'rel', 'media', 'as', 'integrity', 'disabled', 'type',
    'value', 'checked', 'selected',
  ]);

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
  const MAX_COMPUTED_STYLE_PROPERTIES = 256;
  const MAX_COMPUTED_STYLE_NAME_LENGTH = 128;
  const MAX_COMPUTED_STYLE_VALUE_LENGTH = 4096;
  const MAX_COMPUTED_STYLE_BOX_CHARS = 16 * 1024;
  const MAX_COMPUTED_STYLE_PACKET_CHARS = 2 * 1024 * 1024;
  // This is the standard-property vocabulary for which the bridge can report
  // that a value was omitted by the host. CSSStyleDeclaration enumeration is
  // intentionally limited to names present in the measured native packet;
  // browsers enumerate a much larger engine-specific property set.
  const knownStandardComputedProperties = new Set((
    'accent-color align-content align-items align-self animation animation-delay animation-direction animation-duration animation-fill-mode animation-iteration-count animation-name animation-play-state animation-timing-function appearance aspect-ratio backface-visibility background background-attachment background-clip background-color background-image background-origin background-position background-repeat background-size block-size border border-block border-block-color border-block-style border-block-width border-bottom border-bottom-color border-bottom-left-radius border-bottom-right-radius border-bottom-style border-bottom-width border-collapse border-color border-image border-left border-left-color border-left-style border-left-width border-radius border-right border-right-color border-right-style border-right-width border-spacing border-style border-top border-top-color border-top-left-radius border-top-right-radius border-top-style border-top-width border-width bottom box-shadow box-sizing break-after break-before break-inside caption-side caret-color clear clip clip-path color color-scheme column-count column-gap column-rule column-rule-color column-rule-style column-rule-width column-span column-width columns contain content cursor direction display empty-cells fill filter flex flex-basis flex-direction flex-flow flex-grow flex-shrink flex-wrap float flood-color font font-family font-feature-settings font-kerning font-size font-size-adjust font-stretch font-style font-variant font-weight gap grid grid-area grid-auto-columns grid-auto-flow grid-auto-rows grid-column grid-column-end grid-column-gap grid-column-start grid-row grid-row-end grid-row-gap grid-row-start grid-template grid-template-areas grid-template-columns grid-template-rows height hyphens image-rendering inline-size inset isolation justify-content justify-items justify-self left letter-spacing line-break line-height list-style list-style-image list-style-position list-style-type margin margin-block margin-block-end margin-block-start margin-bottom margin-inline margin-inline-end margin-inline-start margin-left margin-right margin-top max-block-size max-height max-inline-size max-width min-block-size min-height min-inline-size min-width mix-blend-mode object-fit object-position opacity order outline outline-color outline-offset outline-style outline-width overflow overflow-anchor overflow-wrap overflow-x overflow-y overscroll-behavior overscroll-behavior-x overscroll-behavior-y padding padding-block padding-block-end padding-block-start padding-bottom padding-inline padding-inline-end padding-inline-start padding-left padding-right padding-top page-break-after page-break-before page-break-inside perspective pointer-events position quotes resize right rotate row-gap scale scroll-behavior scroll-margin scroll-padding shape-rendering stroke stroke-width tab-size table-layout text-align text-align-last text-decoration text-decoration-color text-decoration-line text-decoration-style text-indent text-overflow text-rendering text-shadow text-transform top touch-action transform transform-origin transform-style transition transition-delay transition-duration transition-property transition-timing-function unicode-bidi user-select vertical-align visibility white-space width word-break word-spacing word-wrap writing-mode z-index zoom'
  ).split(/\s+/));
  // Chromium 153's indexed CSSStyleDeclaration vocabulary captured by the
  // parity oracle. It contains engine-specific names as well as standardized
  // CSS properties; absent names in this finite set are the only ones for
  // which this bridge promises an explicit "known but not supplied" error.
  // The browser exposes 477 indexed names in this capture; full browser CSSOM
  // enumeration can change with the engine version and is not promised here.
  const chromium153ComputedPropertyNames = new Set((
    'accent-color align-content align-items align-self alignment-baseline anchor-name anchor-scope animation-composition animation-delay animation-direction animation-duration animation-fill-mode animation-iteration-count animation-name animation-play-state animation-range-end animation-range-start animation-timeline animation-timing-function animation-trigger app-region appearance aspect-ratio backdrop-filter backface-visibility background-attachment background-blend-mode background-clip background-color background-image background-origin background-position background-repeat background-size baseline-shift baseline-source block-size border-block-end-color border-block-end-style border-block-end-width border-block-start-color border-block-start-style border-block-start-width border-bottom-color border-bottom-left-radius border-bottom-right-radius border-bottom-style border-bottom-width border-collapse border-end-end-radius border-end-start-radius border-image-outset border-image-repeat border-image-slice border-image-source border-image-width border-inline-end-color border-inline-end-style border-inline-end-width border-inline-start-color border-inline-start-style border-inline-start-width border-left-color border-left-style border-left-width border-right-color border-right-style border-right-width border-shape border-start-end-radius border-start-start-radius border-top-color border-top-left-radius border-top-right-radius border-top-style border-top-width bottom box-decoration-break box-shadow box-sizing break-after break-before break-inside buffered-rendering caption-side caret-animation caret-color caret-shape clear clip clip-path clip-rule color color-interpolation color-interpolation-filters color-rendering color-scheme column-count column-fill column-gap column-height column-rule-break column-rule-color column-rule-inset-cap-end column-rule-inset-cap-start column-rule-inset-junction-end column-rule-inset-junction-start column-rule-style column-rule-visibility-items column-rule-width column-span column-width column-wrap contain contain-intrinsic-block-size contain-intrinsic-height contain-intrinsic-inline-size contain-intrinsic-size contain-intrinsic-width container-name container-type content content-visibility corner-bottom-left-shape corner-bottom-right-shape corner-end-end-shape corner-end-start-shape corner-start-end-shape corner-start-start-shape corner-top-left-shape corner-top-right-shape counter-increment counter-reset counter-set cursor cx cy d direction display dominant-baseline dynamic-range-limit empty-cells field-sizing fill fill-opacity fill-rule filter flex-basis flex-direction flex-grow flex-line-count flex-shrink flex-wrap float flood-color flood-opacity font-family font-feature-settings font-kerning font-language-override font-optical-sizing font-palette font-size font-size-adjust font-stretch font-style font-synthesis-small-caps font-synthesis-style font-synthesis-weight font-variant font-variant-alternates font-variant-caps font-variant-east-asian font-variant-emoji font-variant-ligatures font-variant-numeric font-variant-position font-variation-settings font-weight forced-color-adjust grid-auto-columns grid-auto-flow grid-auto-rows grid-column-end grid-column-start grid-row-end grid-row-start grid-template-areas grid-template-columns grid-template-rows height hyphenate-character hyphenate-limit-chars hyphens image-orientation image-rendering initial-letter inline-size inset-block-end inset-block-start inset-inline-end inset-inline-start interactivity interest-delay-end interest-delay-start interpolate-size isolation justify-content justify-items justify-self left letter-spacing lighting-color line-break line-height list-style-image list-style-position list-style-type margin-block-end margin-block-start margin-bottom margin-inline-end margin-inline-start margin-left margin-right margin-top marker-end marker-mid marker-start mask-clip mask-composite mask-image mask-mode mask-origin mask-position mask-repeat mask-size mask-type math-depth math-shift math-style max-block-size max-height max-inline-size max-width min-block-size min-height min-inline-size min-width mix-blend-mode object-fit object-position object-view-box offset-anchor offset-distance offset-path offset-position offset-rotate opacity order orphans outline-color outline-offset outline-style outline-width overflow-anchor overflow-block overflow-clip-margin overflow-inline overflow-wrap overflow-x overflow-y overlay overscroll-behavior-block overscroll-behavior-inline overscroll-behavior-x overscroll-behavior-y padding-block-end padding-block-start padding-bottom padding-inline-end padding-inline-start padding-left padding-right padding-top paint-order perspective perspective-origin pointer-events position position-anchor position-area position-try-fallbacks position-try-order position-visibility print-color-adjust quotes r reading-flow reading-order resize right rotate row-gap row-rule-break row-rule-color row-rule-inset-cap-end row-rule-inset-cap-start row-rule-inset-junction-end row-rule-inset-junction-start row-rule-style row-rule-visibility-items row-rule-width ruby-align ruby-overhang ruby-position rule-overlap rx ry scale scroll-axis-lock scroll-behavior scroll-initial-target scroll-margin-block-end scroll-margin-block-start scroll-margin-bottom scroll-margin-inline-end scroll-margin-inline-start scroll-margin-left scroll-margin-right scroll-margin-top scroll-marker-group scroll-padding-block-end scroll-padding-block-start scroll-padding-bottom scroll-padding-inline-end scroll-padding-inline-start scroll-padding-left scroll-padding-right scroll-padding-top scroll-snap-align scroll-snap-stop scroll-snap-type scroll-target-group scroll-timeline-axis scroll-timeline-name scrollbar-color scrollbar-gutter scrollbar-width shape-image-threshold shape-margin shape-outside shape-rendering speak stop-color stop-opacity stroke stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width tab-size table-layout text-align text-align-last text-anchor text-autospace text-box-edge text-box-trim text-combine-upright text-decoration text-decoration-color text-decoration-line text-decoration-skip-ink text-decoration-style text-decoration-thickness text-emphasis-color text-emphasis-position text-emphasis-style text-fit text-indent text-justify text-orientation text-overflow text-rendering text-shadow text-size-adjust text-spacing-trim text-transform text-underline-offset text-underline-position text-wrap-mode text-wrap-style timeline-scope timeline-trigger-activation-range-end timeline-trigger-activation-range-start timeline-trigger-active-range-end timeline-trigger-active-range-start timeline-trigger-name timeline-trigger-source top touch-action transform transform-box transform-origin transform-style transition-behavior transition-delay transition-duration transition-property transition-timing-function translate trigger-scope unicode-bidi user-select vector-effect vertical-align view-timeline-axis view-timeline-inset view-timeline-name view-transition-class view-transition-group view-transition-name view-transition-scope visibility white-space-collapse widows width will-change window-drag word-break word-spacing writing-mode x y z-index zoom -webkit-border-horizontal-spacing -webkit-border-image -webkit-border-vertical-spacing -webkit-box-align -webkit-box-decoration-break -webkit-box-direction -webkit-box-flex -webkit-box-ordinal-group -webkit-box-orient -webkit-box-pack -webkit-box-reflect -webkit-font-smoothing -webkit-line-break -webkit-line-clamp -webkit-locale -webkit-mask-box-image -webkit-mask-box-image-outset -webkit-mask-box-image-repeat -webkit-mask-box-image-slice -webkit-mask-box-image-source -webkit-mask-box-image-width -webkit-mask-position-x -webkit-mask-position-y -webkit-rtl-ordering -webkit-ruby-position -webkit-tap-highlight-color -webkit-text-combine -webkit-text-decorations-in-effect -webkit-text-fill-color -webkit-text-orientation -webkit-text-security -webkit-text-stroke-color -webkit-text-stroke-width -webkit-user-drag -webkit-user-modify -webkit-writing-mode'
  ).split(/\s+/));
  function isKnownComputedProperty(name) {
    return knownStandardComputedProperties.has(name) || chromium153ComputedPropertyNames.has(name);
  }
  const standardPropertyName = /^-?[a-z][a-z0-9-]*$/;
  const customPropertyName = /^--[a-zA-Z0-9_-]+$/;
  let revisionValue = 1;
  let lastGeneration = 0;
  let layoutSnapshot = null;
  let pendingScrollActions = [];
  let lastQueuedScrollAction = 0;
  let acknowledgedScrollAction = 0;
  // A nonempty set can certify only an unaffected parent's clientWidth.
  // null means an unproved mutation forbids every partial read until layout.
  let pendingSizeMutationTargets = new Set();
  // Project host-proved box styles and simple Canvas used dimensions. This does
  // not certify the child position, its surrounding line box, or scroll extents.
  let pendingProjectedStyles = new Map();
  let pendingCanvasSizingAxes = new Map();
  let pendingOrdinaryTextOnly = true;
  let installed = false;
  let observer = null;
  let scrollActionQueue = null;
  let internalMutationDepth = 0;
  const knownElements = new Map();

  function noModificationAllowed(message) {
    if (typeof DOMException === 'function') return new DOMException(message, 'NoModificationAllowedError');
    const error = new Error(message);
    error.name = 'NoModificationAllowedError';
    return error;
  }

  function cssPropertyKey(name) {
    if (customPropertyName.test(name)) return name;
    if (!standardPropertyName.test(name)) return null;
    return name.toLowerCase();
  }

  function normalizeCssPropertyName(value) {
    let name;
    try {
      name = String(value);
    } catch (_) {
      return null;
    }
    if (name.startsWith('--')) return customPropertyName.test(name) ? name : null;
    if (!name.includes('-') && /[A-Z]/.test(name)) {
      name = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      if (name.startsWith('css-')) name = name.slice(4);
      if (name.startsWith('ms-')) name = `-${name}`;
      else if (/^(webkit|moz|o)-/.test(name)) name = `-${name}`;
    }
    return cssPropertyKey(name);
  }

  function normalizeCssPropertyArgument(value) {
    let name;
    try {
      name = String(value);
    } catch (_) {
      return null;
    }
    if (name.startsWith('--')) return customPropertyName.test(name) ? name : null;
    if (!/^-?[a-zA-Z][a-zA-Z0-9-]*$/.test(name)) return null;
    // CSSOM method arguments use CSS property names. Unlike IDL attribute
    // accessors such as backgroundColor, method arguments are not camelized.
    return name.toLowerCase();
  }

  function orderedComputedPropertyNames(style) {
    return Object.keys(style).sort((left, right) => {
      const leftCustom = customPropertyName.test(left);
      const rightCustom = customPropertyName.test(right);
      if (leftCustom !== rightCustom) return leftCustom ? 1 : -1;
      if (!leftCustom) {
        const leftPrefixed = left.startsWith('-');
        const rightPrefixed = right.startsWith('-');
        if (leftPrefixed !== rightPrefixed) return leftPrefixed ? 1 : -1;
      }
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }

  function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    try {
      const prototype = Object.getPrototypeOf(value);
      if (prototype === null) return true;
      // The packet may be created in another realm, so compare the shape of an
      // ordinary Object prototype rather than this realm's Object.prototype.
      if (Object.getPrototypeOf(prototype) !== null) return false;
      const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
      return Boolean(constructor && typeof constructor.value === 'function' && constructor.value.name === 'Object');
    } catch (_) {
      return false;
    }
  }

  function validateComputedStyle(source, id, budget) {
    if (!Object.prototype.hasOwnProperty.call(source, 'computedStyle')) return undefined;
    const field = Object.getOwnPropertyDescriptor(source, 'computedStyle');
    if (!field || !Object.prototype.hasOwnProperty.call(field, 'value')) {
      throw new TypeError(`${id}.computedStyle must be a data property`);
    }
    const raw = field.value;
    if (!isPlainRecord(raw)) throw new TypeError(`${id}.computedStyle must be a plain object`);
    let names;
    let symbols;
    try {
      names = Object.getOwnPropertyNames(raw);
      symbols = Object.getOwnPropertySymbols(raw);
    } catch (_) {
      throw new TypeError(`${id}.computedStyle properties could not be inspected`);
    }
    if (symbols.length !== 0) throw new TypeError(`${id}.computedStyle cannot contain symbol properties`);
    if (names.length > MAX_COMPUTED_STYLE_PROPERTIES) {
      throw new RangeError(`${id}.computedStyle may contain at most ${MAX_COMPUTED_STYLE_PROPERTIES} properties`);
    }
    const result = Object.create(null);
    const seen = new Set();
    let boxChars = 0;
    for (const name of names) {
      if (name.length === 0 || name.length > MAX_COMPUTED_STYLE_NAME_LENGTH) {
        throw new RangeError(`${id}.computedStyle property names must contain at most ${MAX_COMPUTED_STYLE_NAME_LENGTH} characters`);
      }
      const key = cssPropertyKey(name);
      if (key === null) throw new TypeError(`${id}.computedStyle contains an invalid CSS property name`);
      if (seen.has(key)) throw new TypeError(`${id}.computedStyle contains duplicate normalized property names`);
      const descriptor = Object.getOwnPropertyDescriptor(raw, name);
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError(`${id}.computedStyle entries must be enumerable data properties`);
      }
      if (typeof descriptor.value !== 'string') throw new TypeError(`${id}.computedStyle values must be strings`);
      if (descriptor.value.length > MAX_COMPUTED_STYLE_VALUE_LENGTH) {
        throw new RangeError(`${id}.computedStyle values may contain at most ${MAX_COMPUTED_STYLE_VALUE_LENGTH} characters`);
      }
      if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(descriptor.value)) {
        throw new TypeError(`${id}.computedStyle values contain a disallowed control character`);
      }
      seen.add(key);
      boxChars += name.length + descriptor.value.length;
      if (boxChars > MAX_COMPUTED_STYLE_BOX_CHARS) {
        throw new RangeError(`${id}.computedStyle may contain at most ${MAX_COMPUTED_STYLE_BOX_CHARS} characters`);
      }
      Object.defineProperty(result, key, { value: descriptor.value, enumerable: true, configurable: false, writable: false });
    }
    budget.chars += boxChars;
    if (budget.chars > MAX_COMPUTED_STYLE_PACKET_CHARS) {
      throw new RangeError(`Packet computed styles may contain at most ${MAX_COMPUTED_STYLE_PACKET_CHARS} characters`);
    }
    return Object.freeze(result);
  }

  const rectState = new WeakMap();
  const computedStyleState = new WeakMap();
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

  function isIndependentCanvasBitmapMutation(record) {
    if ((record.attributeName !== 'width' && record.attributeName !== 'height') ||
        record.attributeNamespace != null ||
        record.target?.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
        record.target?.localName !== 'canvas' ||
        !layoutSnapshot || layoutSnapshot.revision !== revisionValue ||
        !isConnected(record.target)) return false;
    const id = readAttribute.call(record.target, 'data-pirc-script-id');
    const box = layoutSnapshot.boxes.get(id);
    // Only the completed native frame can establish that both CSS dimensions
    // are intrinsic-independent and the complete CSS cascade has no bitmap
    // attribute dependencies. Other DOM/style mutations still fence the packet.
    return box?.kind === 'box' && box.element === record.target &&
      box.canvasBitmapSizeIndependent === true;
  }

  // A narrow parser is intentional: complex values, priorities, comments,
  // escapes and duplicate declarations keep the normal remeasurement fence.
  // No browser CSS parsing or cascade result is fabricated here.
  function simpleInlineDeclarations(source) {
    if (source === null) return new Map();
    if (typeof source !== 'string' || source.length > 16384 ||
        /[\\'"(){}[\]\/!\x00-\x08\x0b\x0e-\x1f\x7f]/.test(source)) return null;
    const result = new Map();
    for (const part of source.split(';')) {
      if (!part.trim()) continue;
      const match = /^\s*(-?[a-zA-Z][a-zA-Z0-9-]*|--[a-zA-Z0-9_-]+)\s*:\s*([^:;]+?)\s*$/.exec(part);
      if (!match) return null;
      const name = match[1].startsWith('--') ? match[1] : match[1].toLowerCase();
      if (name === 'all' || result.has(name)) return null;
      result.set(name,match[2]);
    }
    return result;
  }

  function nonnegativePixelValue(value) {
    if (typeof value !== 'string' || !/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)px$/i.test(value)) return null;
    const number = Number(value.slice(0,-2));
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function isEquivalentCanvasStyleMutation(record, afterValue) {
    if (record.attributeName !== 'style' || record.attributeNamespace != null ||
        record.target?.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
        record.target?.localName !== 'canvas' ||
        !layoutSnapshot || layoutSnapshot.revision !== revisionValue ||
        !isConnected(record.target)) return false;
    const id = readAttribute.call(record.target,'data-pirc-script-id');
    const box = layoutSnapshot.boxes.get(id);
    if (box?.kind !== 'box' || box.element !== record.target ||
        box.canvasEquivalentStyleWrites !== true) return false;
    const before = simpleInlineDeclarations(record.oldValue);
    const after = simpleInlineDeclarations(afterValue);
    if (!before || !after) return false;
    // Reordering unchanged shorthand/longhand pairs can change the cascade.
    // Ordinary CSSOM assignments retain existing property order; require it.
    const beforeNames = [...before.keys()];
    const afterExistingNames = [...after.keys()].filter(name=>before.has(name));
    if (beforeNames.length !== afterExistingNames.length ||
        beforeNames.some((name,index)=>name !== afterExistingNames[index])) return false;
    for (const name of new Set([...before.keys(),...after.keys()])) {
      if (before.get(name) === after.get(name)) continue;
      const next = after.get(name);
      // Removal might expose a different stylesheet declaration; do not infer it.
      if (next === undefined) return false;
      if (name === 'width' || name === 'height') {
        const value = nonnegativePixelValue(next);
        if (value === null || value !== nonnegativePixelValue(box.computedStyle[name])) return false;
      } else if (name === 'display' || name === 'box-sizing') {
        if (next.toLowerCase() !== box.computedStyle[name]) return false;
      } else return false;
    }
    return true;
  }

  function isSizeOnlyMutation(record, afterValue) {
    const target = record?.target;
    if (record?.type !== 'attributes' || record.attributeNamespace != null ||
        target?.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !isConnected(target)) return false;
    if ((record.attributeName === 'width' || record.attributeName === 'height') &&
        ['canvas', 'img'].includes(target.localName)) return true;
    if (record.attributeName !== 'style') return false;
    const before = simpleInlineDeclarations(record.oldValue);
    const after = simpleInlineDeclarations(afterValue);
    if (!before || !after) return false;
    const beforeNames = [...before.keys()];
    const afterExistingNames = [...after.keys()].filter(name => before.has(name));
    if (beforeNames.length !== afterExistingNames.length ||
        beforeNames.some((name, index) => name !== afterExistingNames[index])) return false;
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(name) === after.get(name)) continue;
      if ((name !== 'width' && name !== 'height') || !after.has(name)) return false;
    }
    return true;
  }

  function canvasCssAxis(raw) {
    if (raw === 'auto') return {auto: true};
    if (raw === '0') return {value: 0, percent: false};
    if (typeof raw !== 'string' || raw.length > 128) return null;
    const match = /^(\d+(?:\.\d*)?|\.\d+)(px|%)$/.exec(raw);
    if (!match || !Number.isFinite(Number(match[1]))) return null;
    return {value: Number(match[1]), percent: match[2] === '%'};
  }

  function canvasIntrinsicDimension(element, axis) {
    const fallback = axis === 'width' ? 300 : 150;
    const raw = readAttribute.call(element, axis);
    if (raw == null || !/^[\t\n\f\r ]*\d+[\t\n\f\r ]*$/.test(raw)) return fallback;
    const parsed = Number(String(raw).trim());
    return Number.isFinite(parsed) ? Math.min(Math.trunc(parsed), 0xffffffff) : fallback;
  }

  function canvasCssSize(element, sizing, boxes) {
    const parent = boxes.get(sizing.parentId), content = parent?.resize?.contentRect;
    if (!content || element.parentElement !== parent.element) return null;
    const widthAxis = canvasCssAxis(sizing.width), heightAxis = canvasCssAxis(sizing.height);
    if (!widthAxis || !heightAxis) return null;
    let width = widthAxis.auto ? null : widthAxis.percent ? widthAxis.value * content.width / 100 : widthAxis.value;
    let height = heightAxis.auto ? null : heightAxis.percent ? heightAxis.value * content.height / 100 : heightAxis.value;
    const naturalWidth = canvasIntrinsicDimension(element, 'width');
    const naturalHeight = canvasIntrinsicDimension(element, 'height');
    const hasRatio = naturalWidth > 0 && naturalHeight > 0;
    if (width === null && height === null) { width = naturalWidth; height = naturalHeight; }
    else if (width === null) width = hasRatio ? height * naturalWidth / naturalHeight : naturalWidth;
    else if (height === null) height = hasRatio ? width * naturalHeight / naturalWidth : naturalHeight;
    // Only CSS size is calculated; rectangles and scroll data need native layout.
    if (![width, height].every(value => Number.isFinite(value) && value >= 0 && value <= 1000000)) return null;
    const pixels = value => `${Math.round(value * 1000000) / 1000000}px`;
    return {width: pixels(width), height: pixels(height)};
  }

  function projectedBoxStyleMutation(record, afterValue) {
    const target = record?.target;
    if (record?.type !== 'attributes' || record.attributeNamespace != null ||
        !layoutSnapshot || !isConnected(target)) return null;
    const id = readAttribute.call(target, 'data-pirc-script-id');
    const box = layoutSnapshot.boxes.get(id);
    if (box?.element !== target || (box.replacedBoxStyleProjection !== true && !box.canvasSizingProjection)) return null;
    const style = {...(pendingProjectedStyles?.get(target) || box.computedStyle)};
    const sizing = box.canvasSizingProjection ? {...(pendingCanvasSizingAxes?.get(target) || box.canvasSizingProjection)} : null;
    const finish = () => {
      if (sizing) {
        const dimensions = canvasCssSize(target, sizing, layoutSnapshot.boxes);
        if (!dimensions) return null;
        Object.assign(style, dimensions);
        pendingCanvasSizingAxes.set(target, Object.freeze(sizing));
      }
      return Object.freeze(style);
    };
    if ((record.attributeName === 'width' || record.attributeName === 'height') &&
        target.localName === 'canvas' && (box.canvasBitmapSizeIndependent === true || sizing)) return finish();
    if (record.attributeName !== 'style') return null;
    const before = simpleInlineDeclarations(record.oldValue);
    const after = simpleInlineDeclarations(afterValue);
    if (!before || !after) return null;
    const beforeNames = [...before.keys()];
    const afterExisting = [...after.keys()].filter(name => before.has(name));
    if (beforeNames.length !== afterExisting.length ||
        beforeNames.some((name, index) => name !== afterExisting[index])) return null;
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(name) === after.get(name)) continue;
      const next = after.get(name);
      if (next === undefined) return null;
      if (name === 'width' || name === 'height') {
        if (sizing) {
          const normalized = next.toLowerCase();
          if (!canvasCssAxis(normalized)) return null;
          sizing[name] = normalized;
        } else {
          const value = nonnegativePixelValue(next);
          if (value === null || value !== nonnegativePixelValue(box.computedStyle[name])) return null;
          style[name] = box.computedStyle[name];
        }
      } else if (name === 'display' && ['inline', 'block'].includes(next.toLowerCase())) {
        style.display = next.toLowerCase();
      } else if (name === 'box-sizing' && ['content-box', 'border-box'].includes(next.toLowerCase())) {
        style[name] = next.toLowerCase();
      } else return null;
    }
    return finish();
  }

  function stableReplacedChildBox(element) {
    if (!layoutSnapshot || !pendingProjectedStyles?.size) return null;
    const id = readAttribute.call(element, 'data-pirc-script-id');
    const box = layoutSnapshot.boxes.get(id);
    const childBox = layoutSnapshot.boxes.get(box?.stableReplacedChildId);
    const child = childBox?.element;
    // Changed overflow can clamp a scrolled root even with fixed local edges.
    if (childBox?.canvasSizingProjection &&
        (layoutSnapshot.viewport.scrollX !== 0 || layoutSnapshot.viewport.scrollY !== 0)) return null;
    if (box?.element !== element || !child || !isConnected(child) ||
        readAttribute.call(child, 'data-pirc-script-id') !== box.stableReplacedChildId ||
        child.parentElement !== element ||
        [...pendingProjectedStyles.keys()].some(target => target !== child)) return null;
    return box;
  }

  function partialComputedStyle(element) {
    if (!pendingProjectedStyles?.size) return null;
    if (pendingProjectedStyles.has(element) &&
        [...pendingProjectedStyles.keys()].every(target => target === element)) {
      const style = pendingProjectedStyles.get(element);
      const sizing = pendingCanvasSizingAxes?.get(element);
      if (!sizing) return style;
      const dimensions = canvasCssSize(element, sizing, layoutSnapshot.boxes);
      return dimensions ? Object.freeze({...style, ...dimensions}) : null;
    }
    return stableReplacedChildBox(element)?.computedStyle || null;
  }

  function isOrdinaryTextMutation(record) {
    if (!record) return false;
    let parent;
    if (record.type === 'characterData' && record.target?.nodeType === 3) {
      parent = record.target.parentNode;
    } else if (record.type === 'childList') {
      const nodes = [...(record.addedNodes || []), ...(record.removedNodes || [])];
      if (!nodes.length || nodes.some(node => node.nodeType !== 3)) return false;
      parent = record.target;
    } else return false;
    if (!(parent instanceof ElementCtor) || parent.ownerDocument !== documentRef ||
        !isConnected(parent)) return false;
    // These nodes affect stylesheet sources, control state or automatic bidi
    // direction, rather than just rendered text. Keep their full style fence.
    const visited = new Set();
    for (let node = parent; node instanceof ElementCtor; node = node.parentElement) {
      if (visited.has(node) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
          ['style','script','title','textarea','option','select','bdi'].includes(node.localName) ||
          String(readAttribute.call(node,'dir') || '').toLowerCase() === 'auto') return false;
      visited.add(node);
    }
    return true;
  }

  function consumeMutationRecords(records) {
    if (internalMutationDepth > 0 || !records || records.length === 0) return;
    // MutationRecord carries oldValue only. Recover each write's real successor
    // from the next record, rather than treating a transient change restored in
    // the same batch as an equivalent write. This remains linear in batch size.
    const styleAfter = new Map(), nextStyleBefore = new Map();
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (record?.type !== 'attributes' || record.attributeName !== 'style' ||
          record.attributeNamespace != null ||
          record.target?.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
      styleAfter.set(record,nextStyleBefore.has(record.target) ? nextStyleBefore.get(record.target) :
        readAttribute.call(record.target,'style'));
      nextStyleBefore.set(record.target,record.oldValue);
    }
    let relevant = false;
    for (const record of records) {
      if (record && record.type === 'attributes') {
        if (internalAttributes.has(record.attributeName)) continue;
        if (isIndependentCanvasBitmapMutation(record) ||
            (!pendingProjectedStyles?.size && isEquivalentCanvasStyleMutation(record,styleAfter.get(record)))) continue;
        // Only a known old value and the actual HTML attribute can establish a
        // no-op. Canvas size setters still reset their bitmap/context state;
        // retaining an unchanged native layout does not suppress that work.
        if (typeof readAttribute === 'function' &&
            (record.oldValue === null || typeof record.oldValue === 'string') &&
            record.target?.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
            record.attributeNamespace == null &&
            !repeatedEffectAttributes.has(record.attributeName) &&
            (styleAfter.has(record) ? styleAfter.get(record) :
              readAttribute.call(record.target, record.attributeName)) === record.oldValue) continue;
      }
      relevant = true;
      if (!isOrdinaryTextMutation(record)) pendingOrdinaryTextOnly = false;
      if (pendingProjectedStyles !== null) {
        const projected = projectedBoxStyleMutation(record, styleAfter.get(record));
        if (projected && pendingProjectedStyles.size < 5000) pendingProjectedStyles.set(record.target, projected);
        else { pendingProjectedStyles = null; pendingCanvasSizingAxes = null; }
      }
      if (pendingSizeMutationTargets !== null) {
        if (isSizeOnlyMutation(record, styleAfter.get(record)) && pendingSizeMutationTargets.size < 5000) {
          pendingSizeMutationTargets.add(record.target);
        } else pendingSizeMutationTargets = null;
      }
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

  function nativeViewport() {
    if (!layoutSnapshot) {
      throw notSupported('unmeasured', 'Native viewport geometry has not been measured', {
        revision: currentRevision(),
      });
    }
    return layoutSnapshot.viewport;
  }

  // Replay only unacknowledged commands over host-measured positions/ranges.
  // Smooth destinations are not current positions; omitted axes stay current.
  function projectedScroll(target, position, range) {
    let left = position.left, top = position.top;
    for (const action of pendingScrollActions) {
      if (action.element !== target) continue;
      if (action.behavior === 'smooth') continue;
      if (layoutSnapshot.revision !== currentRevision()) {
        throw notSupported('scroll_feedback_stale', 'Native scroll ranges are stale after a document mutation', {revision: currentRevision()});
      }
      if (!range) {
        throw notSupported('scroll_feedback_unavailable', 'Native scroll ranges have not been measured', {
          revision: currentRevision(), actionId: action.actionId,
        });
      }
      const next = (value, coordinate, minimum, maximum) =>
        Math.min(maximum, Math.max(minimum,
          action.kind === 'by' ? value + (coordinate ?? 0) : coordinate ?? value));
      left = next(left, action.x, range.minLeft, range.maxLeft);
      top = next(top, action.y, range.minTop, range.maxTop);
    }
    return {left, top};
  }

  function viewport() {
    const measured = nativeViewport();
    const projected = projectedScroll(null,
      {left: measured.scrollX, top: measured.scrollY}, measured.scrollRange);
    return Object.freeze({...measured, scrollX: projected.left, scrollY: projected.top});
  }

  function recordScrollAction(action, target) {
    if (!Number.isSafeInteger(action.actionId) || action.actionId <= lastQueuedScrollAction)
      throw new RangeError('Scroll feedback ids must increase');
    lastQueuedScrollAction = action.actionId;
    pendingScrollActions.push(Object.freeze({...action,
      element: target?.id ? resolveElementId(target.id) : null}));
  }

  function requireSettledScrollGeometry() {
    if (!pendingScrollActions.length || !layoutSnapshot) return;
    const root = layoutSnapshot.viewport;
    const projected = projectedScroll(null, {left: root.scrollX, top: root.scrollY}, root.scrollRange);
    let changed = projected.left !== root.scrollX || projected.top !== root.scrollY;
    for (const box of layoutSnapshot.boxes.values()) {
      if (!box.scroll) continue;
      const p = projectedScroll(box.element, box.scroll, box.scroll.range);
      changed ||= p.left !== box.scroll.left || p.top !== box.scroll.top;
    }
    if (changed) throw notSupported('pending_scroll_geometry',
      'Element rectangles require native measurement after pending scroll commands', {revision: currentRevision()});
  }

  function requireBox(element, allowStableParentBounds = false) {
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
      const stable = allowStableParentBounds && stableReplacedChildBox(element);
      if (stable) return {detached: false, box: stable, viewport: layoutSnapshot.viewport};
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

  function requireComputedStyle(element, property = null) {
    validateElement(element);
    if (!isConnected(element)) return { detached: true, style: null };
    if (!enabled) {
      throw notSupported('computed_style_unavailable', 'Computed style is unavailable because native layout parity is disabled', {
        revision: currentRevision(),
      });
    }
    const id = ownIdForElement(element);
    const current = currentRevision();
    if (!layoutSnapshot) {
      throw notSupported('computed_style_unmeasured', 'Computed style has not been measured', { id, revision: current });
    }
    if (layoutSnapshot.revision !== current) {
      const style = partialComputedStyle(element);
      if (style) return {detached: false, style, id, revision: current};
      const box = layoutSnapshot.boxes.get(id);
      if (pendingOrdinaryTextOnly && box?.element === element && box.textIndependentStyleProperties &&
          (property === null || box.textIndependentStyleProperties.has(property) ||
           (!Object.prototype.hasOwnProperty.call(box.computedStyle, property) &&
            (customPropertyName.test(property) || !isKnownComputedProperty(property))))) {
        // Enumeration is unchanged by this proof. Actual value reads must name
        // a host-certified cascade value; used lengths still require layout.
        return {detached: false, style: box.computedStyle, id, revision: current};
      }
      throw notSupported('computed_style_stale', 'Computed style is stale after a document mutation', {
        id,
        revision: current,
        measuredRevision: layoutSnapshot.revision,
      });
    }
    const box = layoutSnapshot.boxes.get(id);
    if (!box || box.element !== element) {
      throw notSupported('computed_style_unmeasured', 'Computed style has not been measured for this element', { id, revision: current });
    }
    if (!Object.prototype.hasOwnProperty.call(box, 'computedStyle')) {
      throw notSupported('computed_style_unavailable', 'Native layout did not provide computed style for this element', {
        id,
        revision: current,
      });
    }
    return { detached: false, style: box.computedStyle, id, revision: current };
  }

  function declarationState(declaration) {
    const state = computedStyleState.get(declaration);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  }

  function declarationSnapshot(declaration, property = null) {
    const state = declarationState(declaration);
    return requireComputedStyle(state.element, property);
  }

  function readComputedProperty(style, key, id, revision) {
    if (Object.prototype.hasOwnProperty.call(style, key)) return style[key];
    if (customPropertyName.test(key)) return '';
    if (isKnownComputedProperty(key)) {
      throw notSupported('computed_style_property_unavailable', `Native layout did not provide computed CSS property ${key}`, {
        id,
        revision,
        property: key,
      });
    }
    return '';
  }

  const computedStyleDeclarationPrototype = Object.create(Object.prototype);
  Object.defineProperties(computedStyleDeclarationPrototype, {
    length: {
      configurable: false,
      enumerable: false,
      get() {
        const snapshot = declarationSnapshot(this);
        return snapshot.detached ? 0 : orderedComputedPropertyNames(snapshot.style).length;
      },
    },
    cssText: {
      configurable: false,
      enumerable: false,
      get() {
        // CSSOM's computed flag requires cssText to serialize as the empty string.
        // Still verify the live snapshot so stale reads are never hidden.
        declarationSnapshot(this);
        return '';
      },
      set() { throw noModificationAllowed('Computed CSS declarations are read-only'); },
    },
    getPropertyValue: {
      configurable: false,
      enumerable: false,
      writable: false,
      value(propertyName) {
        declarationState(this);
        const key = normalizeCssPropertyArgument(propertyName);
        const snapshot = declarationSnapshot(this, key);
        if (snapshot.detached || key === null) return '';
        return readComputedProperty(snapshot.style, key, snapshot.id, snapshot.revision);
      },
    },
    getPropertyPriority: {
      configurable: false,
      enumerable: false,
      writable: false,
      value(propertyName) {
        declarationState(this);
        const key = normalizeCssPropertyArgument(propertyName);
        const snapshot = declarationSnapshot(this, key);
        if (snapshot.detached || key === null) return '';
        readComputedProperty(snapshot.style, key, snapshot.id, snapshot.revision);
        return '';
      },
    },
    item: {
      configurable: false,
      enumerable: false,
      writable: false,
      value(index) {
        const snapshot = declarationSnapshot(this);
        if (snapshot.detached) return '';
        const number = Number(index);
        if (!Number.isFinite(number) || number < 0) return '';
        return orderedComputedPropertyNames(snapshot.style)[Math.trunc(number)] || '';
      },
    },
    setProperty: {
      configurable: false,
      enumerable: false,
      writable: false,
      value() {
        declarationState(this);
        throw noModificationAllowed('Computed CSS declarations are read-only');
      },
    },
    removeProperty: {
      configurable: false,
      enumerable: false,
      writable: false,
      value() {
        declarationState(this);
        throw noModificationAllowed('Computed CSS declarations are read-only');
      },
    },
    [Symbol.iterator]: {
      configurable: false,
      enumerable: false,
      writable: false,
      value() {
        const snapshot = declarationSnapshot(this);
        return (snapshot.detached ? [] : orderedComputedPropertyNames(snapshot.style))[Symbol.iterator]();
      },
    },
    [Symbol.toStringTag]: { value: 'CSSStyleDeclaration', enumerable: false },
  });
  Object.freeze(computedStyleDeclarationPrototype);

  function computedStylePropertyName(property) {
    if (typeof property !== 'string') return null;
    return normalizeCssPropertyName(property);
  }

  function createComputedStyleDeclaration(element) {
    const target = Object.create(computedStyleDeclarationPrototype);
    const state = { element };
    let declaration;
    declaration = new Proxy(target, {
      get(object, property, receiver) {
        if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
        if (typeof property !== 'string') return undefined;
        if (/^(0|[1-9][0-9]*)$/.test(property)) {
          return Reflect.get(object, 'item', receiver).call(receiver, Number(property));
        }
        const key = computedStylePropertyName(property);
        if (key === null) return undefined;
        const snapshot = declarationSnapshot(receiver, key);
        if (snapshot.detached) {
          return customPropertyName.test(key) || isKnownComputedProperty(key) ? '' : undefined;
        }
        if (Object.prototype.hasOwnProperty.call(snapshot.style, key) ||
            customPropertyName.test(key) || isKnownComputedProperty(key)) {
          return readComputedProperty(snapshot.style, key, snapshot.id, snapshot.revision);
        }
        return undefined;
      },
      has(object, property) {
        if (Reflect.has(object, property)) return true;
        if (typeof property === 'string' && /^(0|[1-9][0-9]*)$/.test(property)) {
          const snapshot = declarationSnapshot(declaration);
          return !snapshot.detached && Number(property) < orderedComputedPropertyNames(snapshot.style).length;
        }
        const key = computedStylePropertyName(property);
        if (key === null) return false;
        const snapshot = declarationSnapshot(declaration);
        return (snapshot.detached && isKnownComputedProperty(key)) || (!snapshot.detached &&
          (Object.prototype.hasOwnProperty.call(snapshot.style, key) ||
           customPropertyName.test(key) || isKnownComputedProperty(key)));
      },
      ownKeys(object) {
        const snapshot = declarationSnapshot(declaration);
        const keys = Reflect.ownKeys(object);
        if (snapshot.detached) return keys;
        const indexed = orderedComputedPropertyNames(snapshot.style).map((_, index) => String(index));
        return [...keys, ...indexed];
      },
      getOwnPropertyDescriptor(object, property) {
        const existing = Reflect.getOwnPropertyDescriptor(object, property);
        if (existing) return existing;
        if (typeof property !== 'string' || !/^(0|[1-9][0-9]*)$/.test(property)) return undefined;
        const snapshot = declarationSnapshot(declaration);
        if (snapshot.detached) return undefined;
        const name = orderedComputedPropertyNames(snapshot.style)[Number(property)];
        if (name === undefined) return undefined;
        return { value: name, enumerable: true, configurable: true, writable: false };
      },
      set() { throw noModificationAllowed('Computed CSS declarations are read-only'); },
      defineProperty() { throw noModificationAllowed('Computed CSS declarations are read-only'); },
      deleteProperty() { throw noModificationAllowed('Computed CSS declarations are read-only'); },
      preventExtensions() { throw noModificationAllowed('Computed CSS declarations are read-only'); },
      setPrototypeOf() { throw noModificationAllowed('Computed CSS declarations are read-only'); },
    });
    computedStyleState.set(declaration, state);
    return declaration;
  }

  function getComputedStyle(element, pseudoElement) {
    validateElement(element);
    if (pseudoElement !== undefined && pseudoElement !== null) {
      let pseudo;
      try {
        pseudo = String(pseudoElement);
      } catch (_) {
        throw new TypeError('pseudoElement must be a string');
      }
      if (pseudo !== '') {
        throw notSupported('computed_style_pseudo_unsupported', 'Computed styles for pseudo-elements are not supported', {
          pseudoElement: pseudo,
          revision: currentRevision(),
        });
      }
    }
    // The declaration object is fresh for each call, while each object's
    // accessors consult the accepted snapshot on every read (CSSOM live view).
    return createComputedStyleDeclaration(element);
  }

  function isProperAncestor(parent, element) {
    const visited = new Set();
    let current = element && element.parentNode;
    while (current && !visited.has(current)) {
      if (current === parent) return true;
      visited.add(current);
      current = current.parentNode;
    }
    return false;
  }

  function currentOffsetParent(element, box) {
    const offset = box.offset;
    if (offset.parentId === null) return null;
    const parent = offset.parentElement;
    let resolved;
    let ensured;
    try {
      resolved = resolveElementId(offset.parentId);
      ensured = ensureElementId(parent);
    } catch (_) {
      resolved = null;
      ensured = null;
    }
    const parentBox = layoutSnapshot.boxes.get(offset.parentId);
    if (resolved !== parent || ensured !== offset.parentId ||
        !(parent instanceof HTMLElementCtor) || parent.ownerDocument !== documentRef ||
        !isConnected(parent) || !parentBox || parentBox.element !== parent ||
        parentBox.kind !== 'box' || !isProperAncestor(parent, element)) {
      throw notSupported('stale', 'Native offset parent is no longer the measured connected ancestor', {
        id: box.id,
        parentId: offset.parentId,
        revision: currentRevision(),
        measuredRevision: box.revision,
      });
    }
    return parent;
  }

  function offsetMetric(element, name) {
    const result = requireBox(element);
    if (result.detached || result.box.kind === 'none') return name === 'offsetParent' ? null : 0;
    const offset = result.box.offset;
    if (!offset) {
      throw notSupported('unavailable', `Native layout did not provide ${name}`, {
        id: result.box.id,
        revision: result.box.revision,
        metric: name,
      });
    }
    const parent = currentOffsetParent(element, result.box);
    if (name === 'offsetParent') return parent;
    return name === 'offsetTop' ? offset.top : offset.left;
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

  function scrollGeometryDelta(box) {
    if (!pendingScrollActions.length) return {left: 0, top: 0};
    const proof = box.scrollGeometry;
    if (!proof) {
      requireSettledScrollGeometry();
      return {left: 0, top: 0};
    }
    let left = 0, top = 0;
    if (proof.viewport) {
      const measured = layoutSnapshot.viewport;
      const projected = projectedScroll(null, {left: measured.scrollX, top: measured.scrollY}, measured.scrollRange);
      left -= projected.left - measured.scrollX;
      top -= projected.top - measured.scrollY;
    }
    for (const dependency of proof.ancestors) {
      const owner = layoutSnapshot.boxes.get(dependency.id);
      const projected = projectedScroll(dependency.element, owner.scroll, owner.scroll.range);
      const x = projected.left - owner.scroll.left, y = projected.top - owner.scroll.top;
      const a = dependency.axes;
      left -= a[0] * x + a[2] * y;
      top -= a[1] * x + a[3] * y;
    }
    if (!Number.isFinite(left) || !Number.isFinite(top))
      throw notSupported('pending_scroll_geometry', 'Projected native scroll geometry is not finite', {revision: currentRevision()});
    return {left, top};
  }

  function boundingClientRect(element) {
    const result = requireBox(element, true);
    if (result.detached || result.box.kind === 'none') return zeroRect();
    const box = result.box, delta = scrollGeometryDelta(box);
    return new DOMRect(
      box.x - result.viewport.scrollX + delta.left,
      box.y - result.viewport.scrollY + delta.top,
      box.width,
      box.height,
    );
  }

  function clientRects(element) {
    const result = requireBox(element);
    if (result.detached || result.box.kind === 'none') return createRectList([]);
    const box = result.box, delta = scrollGeometryDelta(box);
    return createRectList([new DOMRect(
      box.x - result.viewport.scrollX + delta.left,
      box.y - result.viewport.scrollY + delta.top,
      box.width,
      box.height,
    )]);
  }

  function inferInitialStandardsMode() {
    const doctype = documentRef.doctype;
    if (!doctype) return false;
    const name = typeof doctype === 'string' ? doctype.split(/\s+/, 1)[0] : doctype.name;
    if (typeof name !== 'string' || name.toLowerCase() !== 'html') return false;
    if (typeof doctype === 'object' && doctype !== null &&
        ((doctype.publicId && String(doctype.publicId).length > 0) ||
         (doctype.systemId && String(doctype.systemId).length > 0))) return false;
    return true;
  }

  function isStandardsModeDocument() { return standardsMode; }

  function bodyElement() {
    const root = documentRef.documentElement;
    if (!root) return null;
    // LinkeDOM's body getter creates a new body when absent. Ownership queries
    // must inspect existing children without changing the document.
    return Array.from(root.children || []).find(element =>
      element.localName === 'body' || element.localName === 'frameset') || null;
  }

  function bodyPotentiallyScrollable(axis, parentClipAsHidden = false) {
    const body = bodyElement();
    if (!body || !body.parentElement) return false;
    const result = requireBox(body);
    if (result.detached || result.box.kind === 'none') return false;
    const name = `overflow-${axis}`;
    const bodyOverflow = getComputedStyle(body).getPropertyValue(name);
    const parentOverflow = getComputedStyle(body.parentElement).getPropertyValue(name);
    return bodyOverflow !== 'visible' && bodyOverflow !== 'clip' &&
      parentOverflow !== 'visible' && (parentClipAsHidden || parentOverflow !== 'clip');
  }

  function scrollingElement() {
    if (!documentRef.documentElement) return null;
    if (isStandardsModeDocument()) return documentRef.documentElement || null;
    const body = bodyElement();
    if (!body) return null;
    return !bodyPotentiallyScrollable('x', true) && !bodyPotentiallyScrollable('y', true) ? body : null;
  }

  function isViewportScrollOwner(element, axis) {
    if (element === documentRef.documentElement) return isStandardsModeDocument();
    return element === bodyElement() && !isStandardsModeDocument() && !bodyPotentiallyScrollable(axis);
  }

  function metric(element, name) {
    validateElement(element);
    if (enabled && isConnected(element)) {
      const viewportClient = element === documentRef.documentElement && isStandardsModeDocument() ||
        element === bodyElement() && !isStandardsModeDocument();
      if (viewportClient && (name === 'clientWidth' || name === 'clientHeight'))
        return nativeViewport()[name === 'clientWidth' ? 'width' : 'height'];
    }
    if (name === 'clientWidth' && enabled && isConnected(element)) {
      const current = currentRevision();
      if (layoutSnapshot && layoutSnapshot.revision !== current &&
          pendingSizeMutationTargets?.size > 0) {
        const id = ownIdForElement(element), box = layoutSnapshot.boxes.get(id);
        if (box?.element === element && box.kind === 'box' &&
            box.clientWidthIndependentOfDescendantSizes === true &&
            [...pendingSizeMutationTargets].every(target => target !== element && element.contains(target))) {
          return box.metrics.clientWidth;
        }
      }
    }
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
    validateElement(element);
    // The standards root is the viewport scroll owner even when Flutter has no
    // separate html RenderBox. Its authoritative measurements are viewport data.
    const axis = name === 'scrollLeft' || name === 'scrollWidth' ? 'x' : 'y';
    if (element === documentRef.documentElement && !isStandardsModeDocument() &&
        (name === 'scrollLeft' || name === 'scrollTop')) return 0;
    if (enabled && isConnected(element) && isViewportScrollOwner(element, axis)) {
      if (name === 'scrollLeft') return viewport().scrollX;
      if (name === 'scrollTop') return viewport().scrollY;
      return documentScrollExtent(element, name);
    }
    const result = requireBox(element);
    if (result.detached || result.box.kind === 'none') return 0;
    const scroll = result.box.scroll;
    if (!scroll) {
      throw notSupported('unavailable', `Native layout did not provide ${name} for this element`, {
        id: result.box.id,
        revision: result.box.revision,
        metric: name,
      });
    }
    if (name === 'scrollLeft') return projectedScroll(element, scroll, scroll.range).left;
    if (name === 'scrollTop') return projectedScroll(element, scroll, scroll.range).top;
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
    if (!isViewportScrollOwner(element, name === 'scrollWidth' ? 'x' : 'y')) {
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
    if (element === documentRef.documentElement) {
      return isStandardsModeDocument() ? { viewport: true } : null;
    }
    if (element === bodyElement() && !isStandardsModeDocument()) {
      const x = bodyPotentiallyScrollable('x'), y = bodyPotentiallyScrollable('y');
      if (x !== y) throw notSupported('quirks_mixed_scroll_owner',
        'Mixed viewport and element axes need native split scroll ownership', {revision: currentRevision()});
      if (!x) return {viewport: true};
    }
    const id = ownIdForElement(element);
    const current = currentRevision();
    // A clean, native-confirmed no-box element cannot own a scroll container.
    // A stale snapshot is not evidence: mutation-then-scroll must still queue.
    if (layoutSnapshot && layoutSnapshot.revision === current) {
      const box = layoutSnapshot.boxes.get(id);
      if (box && box.element === element && box.kind === 'none') return null;
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
    if (element === bodyElement() && !isStandardsModeDocument() &&
        isViewportScrollOwner(element, name === 'scrollLeft' ? 'x' : 'y')) {
      if (typeof scrollActionQueue !== 'function') throw notSupported('unavailable', 'Native scrolling is unavailable', {revision: currentRevision()});
      scrollActionQueue({viewport: true}, 'to', name === 'scrollLeft' ? coordinate : null,
        name === 'scrollTop' ? coordinate : null, 'auto');
      return;
    }
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

  function validateResize(source, id) {
    if (!Object.prototype.hasOwnProperty.call(source, 'resize')) return undefined;
    const raw = source.resize;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${id}.resize must be an object`);
    if (source.kind !== 'box' && raw.kind !== 'none') throw new TypeError(`${id}.resize requires a measured box`);
    if (raw.kind === 'none') return Object.freeze({
      contentRect: Object.freeze({x: 0, y: 0, width: 0, height: 0}),
      borderBoxSize: Object.freeze({inlineSize: 0, blockSize: 0})
    });
    if (raw.kind !== 'box') throw new TypeError(`${id}.resize.kind is invalid`);
    const rect = raw.contentRect, border = raw.borderBoxSize;
    if (!rect || !border || typeof rect !== 'object' || typeof border !== 'object' || Array.isArray(rect) || Array.isArray(border))
      throw new TypeError(`${id}.resize dimensions must be objects`);
    return Object.freeze({
      contentRect: Object.freeze(Object.fromEntries(['x', 'y', 'width', 'height'].map(name =>
        [name, requireFiniteNumber(rect[name], `${id}.resize.contentRect.${name}`, true)]))),
      borderBoxSize: Object.freeze(Object.fromEntries(['inlineSize', 'blockSize'].map(name =>
        [name, requireFiniteNumber(border[name], `${id}.resize.borderBoxSize.${name}`, true)])))
    });
  }

  function resizeObservation(element) {
    validateElement(element);
    if (!isConnected(element)) return {
      contentRect: {x: 0, y: 0, width: 0, height: 0},
      borderBoxSize: {inlineSize: 0, blockSize: 0}
    };
    if (!hasCurrentBox(element)) return null;
    const box = layoutSnapshot.boxes.get(ownIdForElement(element));
    return box.resize || null;
  }

  function validateScrollGeometry(raw, label) {
    if (raw === undefined) return undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        typeof raw.viewport !== 'boolean' || !Array.isArray(raw.ancestors) || raw.ancestors.length > 64)
      throw new TypeError(`${label} requires a viewport flag and bounded ancestors`);
    const seen = new Set();
    const ancestors = raw.ancestors.map(dependency => {
      if (!dependency || !isSafeId(dependency.id) || seen.has(dependency.id) ||
          !Array.isArray(dependency.axes) || dependency.axes.length !== 4)
        throw new TypeError(`${label} requires distinct scroll ids and four affine coefficients`);
      seen.add(dependency.id);
      return Object.freeze({id: dependency.id, axes: Object.freeze(dependency.axes.map((n, i) =>
        requireFiniteNumber(n, `${label}.${dependency.id}.axes[${i}]`, false)))});
    });
    return Object.freeze({viewport: raw.viewport, ancestors: Object.freeze(ancestors)});
  }

  function validateScrollRange(raw, label) {
    if (raw === undefined) return undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new TypeError(`${label} must be an object`);
    const range = {};
    for (const key of ['minLeft', 'maxLeft', 'minTop', 'maxTop'])
      range[key] = requireFiniteNumber(raw[key], `${label}.${key}`, false);
    if (range.minLeft > range.maxLeft || range.minTop > range.maxTop)
      throw new RangeError(`${label} bounds must be ordered`);
    return Object.freeze(range);
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
    const range = validateScrollRange(packet.viewport.scrollRange, 'viewport.scrollRange');
    if (range !== undefined) viewportValue.scrollRange = range;
    const viewport = Object.freeze(viewportValue);
    const through = packet.scrollActionThrough;
    if (through !== undefined && (!Number.isSafeInteger(through) ||
        through < acknowledgedScrollAction || through > lastQueuedScrollAction))
      throw new RangeError('packet.scrollActionThrough must acknowledge an ordered queued prefix');
    if (!Array.isArray(packet.boxes)) throw new TypeError('packet.boxes must be an array');
    if (packet.boxes.length > 5000) throw new RangeError('packet.boxes may contain at most 5000 entries');

    const stagedBoxes = new Map();
    const stagedElements = new Map();
    const computedStyleBudget = { chars: 0 };
    let scrollGeometryReferences = 0;
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

      const computedStyle = validateComputedStyle(source, id, computedStyleBudget);
      let textIndependentStyleProperties = null;
      if (Object.prototype.hasOwnProperty.call(source, 'textIndependentStyleProperties')) {
        const descriptor = Object.getOwnPropertyDescriptor(source, 'textIndependentStyleProperties');
        const raw = descriptor && Object.prototype.hasOwnProperty.call(descriptor,'value') ? descriptor.value : null;
        if (!computedStyle || !Array.isArray(raw) || raw.length > MAX_COMPUTED_STYLE_PROPERTIES) {
          throw new TypeError(`${id}.textIndependentStyleProperties requires a bounded array and computed style`);
        }
        const names = new Set();
        for (let index = 0; index < raw.length; index++) {
          const entry = Object.getOwnPropertyDescriptor(raw, String(index));
          const name = entry && Object.prototype.hasOwnProperty.call(entry,'value') ? entry.value : null;
          if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(computedStyle,name) || names.has(name)) {
            throw new TypeError(`${id}.textIndependentStyleProperties must name distinct supplied data properties`);
          }
          names.add(name);
          computedStyleBudget.chars += name.length;
          if (computedStyleBudget.chars > MAX_COMPUTED_STYLE_PACKET_CHARS) {
            throw new RangeError('Computed-style text dependency metadata exceeds the packet budget');
          }
        }
        textIndependentStyleProperties = names;
      }
      const resize = validateResize(source, id);
      let canvasBitmapSizeIndependent = false;
      if (Object.prototype.hasOwnProperty.call(source, 'canvasBitmapSizeIndependent')) {
        if (typeof source.canvasBitmapSizeIndependent !== 'boolean' ||
            source.kind !== 'box' || element.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
            element.localName !== 'canvas') {
          throw new TypeError(`${id}.canvasBitmapSizeIndependent requires a measured HTML canvas and boolean`);
        }
        canvasBitmapSizeIndependent = source.canvasBitmapSizeIndependent;
      }

      let canvasEquivalentStyleWrites = false;
      if (Object.prototype.hasOwnProperty.call(source, 'canvasEquivalentStyleWrites')) {
        if (typeof source.canvasEquivalentStyleWrites !== 'boolean' ||
            source.kind !== 'box' || element.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
            element.localName !== 'canvas' ||
            !computedStyle || !['display','box-sizing'].every(name=>typeof computedStyle[name] === 'string') ||
            !['width','height'].every(name=>nonnegativePixelValue(computedStyle[name]) !== null)) {
          throw new TypeError(`${id}.canvasEquivalentStyleWrites requires a measured HTML canvas with finite computed dimensions`);
        }
        canvasEquivalentStyleWrites = source.canvasEquivalentStyleWrites;
      }

      let replacedBoxStyleProjection = false;
      if (Object.prototype.hasOwnProperty.call(source, 'replacedBoxStyleProjection')) {
        if (typeof source.replacedBoxStyleProjection !== 'boolean' ||
            source.kind !== 'box' || element.localName !== 'canvas' ||
            element.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
            !canvasBitmapSizeIndependent || !canvasEquivalentStyleWrites ||
            !['padding-left', 'padding-right', 'padding-top', 'padding-bottom',
              'border-left-width', 'border-right-width', 'border-top-width', 'border-bottom-width']
                .every(name => computedStyle?.[name] === '0px')) {
          throw new TypeError(`${id}.replacedBoxStyleProjection requires an independent edgeless measured canvas`);
        }
        replacedBoxStyleProjection = source.replacedBoxStyleProjection;
      }
      let canvasSizingProjection = null;
      if (Object.prototype.hasOwnProperty.call(source, 'canvasSizingProjection')) {
        const raw = source.canvasSizingProjection;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
            !isSafeId(raw.parentId) || !canvasCssAxis(raw.width) || !canvasCssAxis(raw.height) ||
            source.kind !== 'box' || element.localName !== 'canvas' ||
            element.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
            !['inline', 'block'].includes(computedStyle?.display) ||
            !['static', 'relative'].includes(computedStyle?.position) ||
            !['padding-left', 'padding-right', 'padding-top', 'padding-bottom',
              'border-left-width', 'border-right-width', 'border-top-width', 'border-bottom-width',
              'margin-left', 'margin-right', 'margin-top', 'margin-bottom'].every(name => computedStyle?.[name] === '0px')) {
          throw new TypeError(`${id}.canvasSizingProjection requires an edgeless zero-margin measured canvas and simple axes`);
        }
        canvasSizingProjection = Object.freeze({parentId: raw.parentId, width: raw.width, height: raw.height});
      }
      let stableReplacedChildId = null;
      if (Object.prototype.hasOwnProperty.call(source, 'stableReplacedChildId')) {
        if (!isSafeId(source.stableReplacedChildId) || source.kind !== 'box' ||
            computedStyle?.display !== 'block' ||
            !['width', 'height'].every(name => nonnegativePixelValue(computedStyle?.[name]) !== null)) {
          throw new TypeError(`${id}.stableReplacedChildId requires a fixed measured block`);
        }
        stableReplacedChildId = source.stableReplacedChildId;
      }

      let clientWidthIndependentOfDescendantSizes = false;
      if (Object.prototype.hasOwnProperty.call(source, 'clientWidthIndependentOfDescendantSizes')) {
        if (typeof source.clientWidthIndependentOfDescendantSizes !== 'boolean' ||
            source.kind !== 'box' || element.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
            element === documentRef.documentElement || element === bodyElement() ||
            !Object.prototype.hasOwnProperty.call(source, 'clientWidth') ||
            !Number.isFinite(source.clientWidth) || source.clientWidth < 0) {
          throw new TypeError(`${id}.clientWidthIndependentOfDescendantSizes requires a measured HTML box with clientWidth`);
        }
        clientWidthIndependentOfDescendantSizes = source.clientWidthIndependentOfDescendantSizes;
      }

      const scrollGeometry = validateScrollGeometry(source.scrollGeometry, `${id}.scrollGeometry`);
      if (scrollGeometry !== undefined) {
        if (source.kind !== 'box') throw new TypeError(`${id}.scrollGeometry requires a box`);
        scrollGeometryReferences += scrollGeometry.ancestors.length;
        if (scrollGeometryReferences > 16384) throw new RangeError('Scroll geometry metadata exceeds the packet budget');
      }
      const bounds = {};
      for (const name of ['x', 'y', 'width', 'height']) {
        if (Object.prototype.hasOwnProperty.call(source, name) || source.kind === 'box') {
          bounds[name] = requireFiniteNumber(source[name], `${id}.${name}`, name === 'width' || name === 'height');
        }
      }
      const metrics = {};
      let scroll = null;
      let offset = null;
      if (Object.prototype.hasOwnProperty.call(source, 'offset')) {
        if (source.kind !== 'box') throw new TypeError(`${id}.offset requires a box entry`);
        const rawOffset = source.offset;
        if (!rawOffset || typeof rawOffset !== 'object' || Array.isArray(rawOffset)) {
          throw new TypeError(`${id}.offset must be an object`);
        }
        for (const name of ['top', 'left', 'parentId']) {
          if (!Object.prototype.hasOwnProperty.call(rawOffset, name)) {
            throw new TypeError(`${id}.offset.${name} is required`);
          }
        }
        if (!Number.isSafeInteger(rawOffset.top)) {
          throw new TypeError(`${id}.offset.top must be a signed safe integer`);
        }
        if (!Number.isSafeInteger(rawOffset.left)) {
          throw new TypeError(`${id}.offset.left must be a signed safe integer`);
        }
        if (rawOffset.parentId !== null && !isSafeId(rawOffset.parentId)) {
          throw new TypeError(`${id}.offset.parentId must be null or a valid element id`);
        }
        offset = Object.freeze({
          top: rawOffset.top,
          left: rawOffset.left,
          parentId: rawOffset.parentId,
          parentElement: null,
        });
      }
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
            ...(rawScroll.range === undefined ? {} : {range: validateScrollRange(rawScroll.range, `${id}.scroll.range`)}),
          });
        }
        stagedBoxes.set(id, Object.freeze({
          id, kind: source.kind, x, y, width, height, metrics: Object.freeze(metrics), scroll, offset, scrollGeometry,
          ...(computedStyle === undefined ? {} : { computedStyle }), textIndependentStyleProperties, resize, element, revision,
          canvasBitmapSizeIndependent, canvasEquivalentStyleWrites, clientWidthIndependentOfDescendantSizes,
          replacedBoxStyleProjection, stableReplacedChildId, canvasSizingProjection,
        }));
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
          offset: null,
          ...(computedStyle === undefined ? {} : { computedStyle }),
          textIndependentStyleProperties,
          resize,
          element,
          revision,
        }));
      }
      stagedElements.set(id, element);
    }
    for (const [id, box] of stagedBoxes) {
      if (!box.canvasSizingProjection) continue;
      const parent = stagedBoxes.get(box.canvasSizingProjection.parentId);
      const calculated = canvasCssSize(box.element, box.canvasSizingProjection, stagedBoxes);
      if (parent?.stableReplacedChildId !== id || !calculated ||
          calculated.width !== box.computedStyle.width || calculated.height !== box.computedStyle.height) {
        throw new TypeError(`${id}.canvasSizingProjection must match the actual native sizes and its fixed parent`);
      }
    }

    for (const [id, box] of stagedBoxes) {
      if (!box.scrollGeometry) continue;
      const ancestors = box.scrollGeometry.ancestors.map(dependency => {
        const owner = stagedBoxes.get(dependency.id);
        if (!owner || owner.kind !== 'box' || !owner.scroll?.range ||
            owner.element.ownerDocument !== documentRef || !isConnected(owner.element) ||
            !isProperAncestor(owner.element, box.element))
          throw new TypeError(`${id}.scrollGeometry requires measured scroll ancestors`);
        return Object.freeze({...dependency, element: owner.element});
      });
      stagedBoxes.set(id, Object.freeze({...box, scrollGeometry: Object.freeze({
        viewport: box.scrollGeometry.viewport, ancestors: Object.freeze(ancestors),
      })}));
    }

    // Resolve stable-child ownership after every box has been staged.
    for (const [id, box] of stagedBoxes) {
      if (box.stableReplacedChildId == null) continue;
      const child = stagedBoxes.get(box.stableReplacedChildId);
      if ((!child?.replacedBoxStyleProjection && !child?.canvasSizingProjection) || child.element.parentElement !== box.element ||
          box.element.children.length !== 1 ||
          [...box.element.childNodes].some(node => node.nodeType === 3 && String(node.textContent).trim()) ||
          !['margin-top', 'margin-right', 'margin-bottom', 'margin-left']
            .every(name => child.computedStyle?.[name] === '0px')) {
        throw new TypeError(`${id}.stableReplacedChildId must name its sole independent zero-margin canvas`);
      }
    }

    for (const [id, box] of stagedBoxes) {
      if (!box.offset) continue;
      const element = box.element;
      if (!(element instanceof HTMLElementCtor) || !isConnected(element)) {
        throw new TypeError(`${id}.offset requires a connected HTMLElement`);
      }
      let parentElement = null;
      if (box.offset.parentId !== null) {
        const parentId = box.offset.parentId;
        parentElement = stagedElements.get(parentId);
        const parentBox = stagedBoxes.get(parentId);
        if (!parentElement || !parentBox || parentBox.element !== parentElement || parentBox.kind !== 'box' ||
            !(parentElement instanceof HTMLElementCtor) || parentElement.ownerDocument !== documentRef ||
            !isConnected(parentElement) || !isProperAncestor(parentElement, element)) {
          throw new TypeError(`${id}.offset.parentId must name a measured connected HTMLElement ancestor`);
        }
      }
      stagedBoxes.set(id, Object.freeze({
        ...box,
        offset: Object.freeze({ ...box.offset, parentElement }),
      }));
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
      scrollEvents: stagedScrollEvents, scrollActionThrough: through,
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
    if (staged.scrollActionThrough !== undefined) {
      acknowledgedScrollAction = staged.scrollActionThrough;
      pendingScrollActions = pendingScrollActions.filter(action => action.actionId > acknowledgedScrollAction);
    }
    for (const [id, element] of staged.elements) knownElements.set(id, element);
    lastGeneration = staged.generation;
    pendingSizeMutationTargets = new Set();
    pendingProjectedStyles = new Map();
    pendingCanvasSizingAxes = new Map();
    pendingOrdinaryTextOnly = true;
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
    Object.defineProperties(documentRef, {
      scrollingElement: {configurable: true, enumerable: true, get: scrollingElement},
      compatMode: {configurable: true, enumerable: true,
        get() { return isStandardsModeDocument() ? 'CSS1Compat' : 'BackCompat'; }},
    });
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
    for (const name of ['offsetTop', 'offsetLeft', 'offsetParent']) {
      Object.defineProperty(HTMLElementCtor.prototype, name, {
        configurable: true,
        enumerable: false,
        get() { return offsetMetric(this, name); },
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
      observer.observe(documentRef, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true });
    }
    installed = true;
    return api;
  }

  const api = {
    install,
    revision: currentRevision,
    invalidate() {
      pendingOrdinaryTextOnly = false;
      pendingSizeMutationTargets = null;
      pendingProjectedStyles = null;
      pendingCanvasSizingAxes = null;
      return advanceRevision();
    },
    runWithoutMutationInvalidation,
    needsLayout: layoutIsNeeded,
    status,
    viewport,
    nativeViewport,
    recordScrollAction,
    pendingScrollActionCount() { return pendingScrollActions.length; },
    hasPendingScrollActions() { return pendingScrollActions.length > 0; },
    discardScrollFeedback() { pendingScrollActions = []; },
    update,
    scrollMetric(element, name) { return scrollMetric(element, name); },
    elementScrollTarget,
    queueElementScrollAction,
    setScrollActionQueue(callback) {
      if (callback !== null && typeof callback !== 'function') throw new TypeError('Scroll action queue must be a function');
      scrollActionQueue = callback;
    },
    getBoundingClientRect(element) { return boundingClientRect(element); },
    getComputedStyle(element, pseudoElement) { return getComputedStyle(element, pseudoElement); },
    hasCurrentBox,
    resizeObservation,
    DOMRect,
    DOMRectReadOnly,
  };
  return api;
}
