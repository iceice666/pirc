/*
 * A bounded Canvas 2D recorder for native document rendering.
 *
 * This factory is concatenated into the document runtime IIFE. It records
 * drawing operations and context state; it does not rasterize or guess font
 * metrics. Unsupported pixel, pattern, and ink measurement APIs fail
 * explicitly so callers cannot mistake missing output for a successful draw.
 */
function createDocumentCanvas(deps) {
  const options = deps || {};
  const document = options.document;
  const ensureElementId = typeof options.ensureElementId === 'function'
    ? options.ensureElementId
    : function(canvas) {
        return canvas.getAttribute('data-pirc-script-id') || '';
      };
  const diagnostic = typeof options.diagnostic === 'function'
    ? options.diagnostic
    : function() {};
  const metricsState = new WeakMap();
  const metricToken = {};
  class TextMetrics {
    constructor(token, width) {
      if (token !== metricToken) throw new TypeError('Illegal constructor');
      metricsState.set(this, width);
    }
    get width() {
      if (!metricsState.has(this)) throw new TypeError('Illegal TextMetrics invocation');
      return metricsState.get(this);
    }
  }
  Object.defineProperty(TextMetrics.prototype,'width',{...Object.getOwnPropertyDescriptor(TextMetrics.prototype,'width'),enumerable:true});
  for (const name of ['actualBoundingBoxLeft','actualBoundingBoxRight','actualBoundingBoxAscent','actualBoundingBoxDescent',
    'fontBoundingBoxAscent','fontBoundingBoxDescent','emHeightAscent','emHeightDescent','hangingBaseline','alphabeticBaseline','ideographicBaseline']) {
    Object.defineProperty(TextMetrics.prototype,name,{get() {throw unsupported('TextMetrics.'+name);},enumerable:true});
  }
  Object.defineProperty(TextMetrics.prototype,Symbol.toStringTag,{value:'TextMetrics'});
  const records = new WeakMap();
  const unsupportedReported = new Set();
  const maxCommands = 5000;
  const maxPathSegments = 5000;
  const maxAggregatePathSegments = 100000;
  const maxClips = 64;
  const maxSaveDepth = 256;
  const maxCanvasDimension = 8192;
  const maxCanvasPixels = 16 * 1024 * 1024;
  const maxCanvases = 64;
  const maxRecordedBytesPerCanvas = 1000000;
  const maxTotalRecordedBytes = 1500000;
  const maxSafeDimension = 0xffffffff;
  const maxCoordinate = 1e9;
  const gradientMark = typeof Symbol === 'function'
    ? Symbol('pircCanvasGradient')
    : '__pircCanvasGradient__';
  let totalRecordedBytes = 0;
  let canvasCountLimitReported = false;
  let coordinateLimitReported = false;

  const namedColors = new Set((
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black ' +
    'blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse ' +
    'chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta ' +
    'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite ' +
    'forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green ' +
    'greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender ' +
    'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon ' +
    'lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue ' +
    'lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
    'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue ' +
    'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream ' +
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange ' +
    'orangered orchid palegoldenrod palegreen paleturquoise palevioletred ' +
    'papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red ' +
    'rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna ' +
    'silver skyblue slateblue slategray slategrey snow springgreen steelblue ' +
    'tan teal thistle tomato turquoise violet wheat white whitesmoke yellow ' +
    'yellowgreen transparent'
  ).split(/\s+/));

  const compositeOperations = new Set([
    'source-over', 'source-in', 'source-out', 'source-atop',
    'destination-over', 'destination-in', 'destination-out', 'destination-atop',
    'lighter', 'copy', 'xor', 'multiply', 'screen', 'overlay', 'darken',
    'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light',
    'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'
  ]);
  const enumValues = {
    lineCap: new Set(['butt', 'round', 'square']),
    lineJoin: new Set(['round', 'bevel', 'miter']),
    textAlign: new Set(['start', 'end', 'left', 'right', 'center']),
    textBaseline: new Set([
      'top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom'
    ]),
    direction: new Set(['inherit', 'ltr', 'rtl'])
  };

  function report(code, severity, message, detail) {
    try {
      diagnostic(code, severity, message, detail);
    } catch (error) {
      // Diagnostics must not change the page script's Canvas behavior.
    }
  }

  function errorWithName(name, message) {
    try {
      if (typeof DOMException === 'function')
        return new DOMException(message, name);
    } catch (error) {
      // Fall through to a regular Error for DOM implementations without it.
    }
    const error = new Error(message);
    error.name = name;
    return error;
  }

  function unsupported(api, message) {
    if (!unsupportedReported.has(api)) {
      unsupportedReported.add(api);
      report(
        'canvas.unsupported_api',
        'error',
        message || ('Canvas 2D API "' + api + '" is unavailable in the native renderer.'),
        { api: api }
      );
    }
    return errorWithName(
      'NotSupportedError',
      message || ('Canvas 2D API "' + api + '" is unavailable in the native renderer.')
    );
  }

  function number(value, name) {
    const result = Number(value);
    if (!Number.isFinite(result))
      throw new TypeError((name || 'Canvas argument') + ' must be finite.');
    if (Math.abs(result) > maxCoordinate) {
      if (!coordinateLimitReported) {
        coordinateLimitReported = true;
        report(
          'canvas.coordinate_limit',
          'error',
          'Canvas coordinates and transform values are limited to 1000000000.',
          { field: name || 'Canvas argument' }
        );
      }
      throw errorWithName(
        'NotSupportedError',
        'Canvas coordinate exceeds the native renderer limit.'
      );
    }
    return result;
  }

  function unsignedLong(value) {
    if (typeof value === 'bigint')
      throw new TypeError('Canvas dimensions cannot be converted from BigInt.');
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric === 0)
      return 0;
    const integer = Math.trunc(numeric);
    return ((integer % 4294967296) + 4294967296) % 4294967296;
  }

  function defaultState() {
    return {
      fillStyle: '#000000',
      strokeStyle: '#000000',
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      miterLimit: 10,
      lineDash: [],
      lineDashOffset: 0,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'low',
      font: '10px sans-serif',
      textAlign: 'start',
      textBaseline: 'alphabetic',
      direction: 'inherit',
      transform: [1, 0, 0, 1, 0, 0],
      clips: []
    };
  }

  function cloneTransform(transform) {
    return transform.slice(0, 6);
  }

  function clonePath(path) {
    return path.map(segment => ({
      op: segment.op,
      args: segment.args.slice(),
      transform: cloneTransform(segment.transform)
    }));
  }

  function cloneClip(clip) {
    return { path: clonePath(clip.path), rule: clip.rule };
  }

  function cloneCurrentState(state) {
    return {
      fillStyle: state.fillStyle,
      strokeStyle: state.strokeStyle,
      globalAlpha: state.globalAlpha,
      globalCompositeOperation: state.globalCompositeOperation,
      lineWidth: state.lineWidth,
      lineCap: state.lineCap,
      lineJoin: state.lineJoin,
      miterLimit: state.miterLimit,
      lineDash: state.lineDash.slice(),
      lineDashOffset: state.lineDashOffset,
      imageSmoothingEnabled: state.imageSmoothingEnabled,
      imageSmoothingQuality: state.imageSmoothingQuality,
      font: state.font,
      textAlign: state.textAlign,
      textBaseline: state.textBaseline,
      direction: state.direction,
      transform: cloneTransform(state.transform),
      clips: state.clips.map(cloneClip)
    };
  }

  function readDimension(canvas, axis) {
    const fallback = axis === 'width' ? 300 : 150;
    let raw = null;
    try {
      raw = canvas.getAttribute(axis);
    } catch (error) {
      return fallback;
    }
    if (raw == null)
      return fallback;
    const text = String(raw);
    if (!/^[\t\n\f\r ]*\d+[\t\n\f\r ]*$/.test(text))
      return fallback;
    const parsed = Number(text.trim());
    if (!Number.isFinite(parsed) || parsed < 0)
      return fallback;
    return Math.min(Math.trunc(parsed), maxSafeDimension);
  }

  function recordFor(canvas) {
    let record = records.get(canvas);
    if (record)
      return record;
    record = {
      canvas: canvas,
      width: readDimension(canvas, 'width'),
      height: readDimension(canvas, 'height'),
      revision: 0,
      commands: [],
      recordedBytes: 0,
      recordedPathSegments: 0,
      dimensionSupported: true,
      path: [],
      currentState: defaultState(),
      stack: [],
      context: null,
      limitReported: new Set()
    };
    records.set(canvas, record);
    checkDimensionLimit(record);
    return record;
  }

  function reportLimit(record, kind, message) {
    if (record.limitReported.has(kind))
      return;
    record.limitReported.add(kind);
    report('canvas.' + kind + '_limit', 'error', message, {
      id: safeCanvasId(record.canvas),
      width: record.width,
      height: record.height
    });
  }

  function safeCanvasId(canvas) {
    try {
      return String(ensureElementId(canvas) || '');
    } catch (error) {
      return '';
    }
  }

  function checkDimensionLimit(record) {
    record.dimensionSupported = record.width <= maxCanvasDimension &&
      record.height <= maxCanvasDimension &&
      record.width * record.height <= maxCanvasPixels;
    if (!record.dimensionSupported) {
      reportLimit(
        record,
        'dimension',
        'This canvas exceeds the native renderer limit of 8192 pixels per side and 16 megapixels.'
      );
    }
  }

  function discardRecordedCommands(record) {
    totalRecordedBytes = Math.max(0, totalRecordedBytes - record.recordedBytes);
    record.commands = [];
    record.recordedBytes = 0;
    record.recordedPathSegments = 0;
  }

  function resetForResize(canvas) {
    const record = recordFor(canvas);
    record.width = readDimension(canvas, 'width');
    record.height = readDimension(canvas, 'height');
    record.revision += 1;
    discardRecordedCommands(record);
    record.path = [];
    record.currentState = defaultState();
    record.stack = [];
    checkDimensionLimit(record);
  }

  function cloneStyle(style) {
    if (!style || typeof style !== 'object' || !style[gradientMark])
      return style;
    return {
      type: style.type,
      args: style.args.slice(),
      transform: cloneTransform(style.transform),
      stops: style.stops.map(stop => ({ offset: stop.offset, color: stop.color }))
    };
  }

  function isSupportedCanvasColor(value) {
    const text = String(value).trim();
    const lower = text.toLowerCase();
    if (namedColors.has(lower))
      return true;
    if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text))
      return true;

    const functionMatch = /^(rgba?|hsla?)\((.*)\)$/i.exec(text);
    if (!functionMatch)
      return false;
    const kind = functionMatch[1].toLowerCase();
    const body = functionMatch[2].trim();
    let components;
    let alpha = null;
    if (body.includes(',')) {
      components = body.split(',').map(part => part.trim());
      if (components.length === 4)
        alpha = components.pop();
      if (components.length !== 3)
        return false;
    } else {
      const slash = body.split('/');
      if (slash.length > 2)
        return false;
      components = slash[0].trim().split(/\s+/).filter(Boolean);
      alpha = slash.length === 2 ? slash[1].trim() : null;
      if (components.length !== 3 || (slash.length === 2 && !alpha))
        return false;
    }

    const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i;
    if (kind[0] === 'r') {
      if (!components.every(part => numeric.test(part)))
        return false;
    } else {
      const hue = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:deg|grad|rad|turn)?$/i;
      const percentage = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%$/i;
      if (!hue.test(components[0]) ||
          !percentage.test(components[1]) ||
          !percentage.test(components[2]))
        return false;
    }
    return alpha == null || numeric.test(alpha);
  }

  function isSupportedCanvasFont(value) {
    const source = String(value);
    if (source.length > 4096)
      return false;
    const trimmed = source.trim();
    const match = /(?:(italic|oblique)\s+)?(?:(bold|bolder|lighter|[1-9]00)\s+)?([0-9]*\.?[0-9]+)(px|pt|pc|in|cm|mm|q|em|rem)(?:\/[^\s]+)?\s+(.+)$/i.exec(trimmed);
    if (!match)
      return false;
    const prefix = trimmed.slice(0, match.index).trim().toLowerCase();
    if (prefix.split(/\s+/).some(token => token && token !== 'normal'))
      return false;
    const rawSize = Number(match[3]);
    const unit = match[4].toLowerCase();
    const scale = {
      px: 1,
      pt: 96 / 72,
      pc: 16,
      in: 96,
      cm: 96 / 2.54,
      mm: 96 / 25.4,
      q: 96 / 101.6,
      em: 16,
      rem: 16
    }[unit];
    const size = rawSize * scale;
    if (!Number.isFinite(size) || size <= 0 || size > 4096)
      return false;

    const families = match[5].split(',');
    if (!families.length)
      return false;
    for (const family of families) {
      const item = family.trim();
      if (!item)
        return false;
      let quote = '';
      for (let index = 0; index < item.length; index += 1) {
        const character = item[index];
        if (quote) {
          if (character === quote && item[index - 1] !== '\\')
            quote = '';
        } else if (character === '"' || character === "'") {
          quote = character;
        }
      }
      if (quote)
        return false;
    }
    return true;
  }

  function stateSnapshot(record, includePath) {
    const state = record.currentState;
    const result = {
      transform: cloneTransform(state.transform),
      fillStyle: cloneStyle(state.fillStyle),
      strokeStyle: cloneStyle(state.strokeStyle),
      globalAlpha: state.globalAlpha,
      globalCompositeOperation: state.globalCompositeOperation,
      lineWidth: state.lineWidth,
      lineCap: state.lineCap,
      lineJoin: state.lineJoin,
      miterLimit: state.miterLimit,
      lineDash: state.lineDash.slice(),
      lineDashOffset: state.lineDashOffset,
      imageSmoothingEnabled: state.imageSmoothingEnabled,
      imageSmoothingQuality: state.imageSmoothingQuality,
      font: state.font,
      textAlign: state.textAlign,
      textBaseline: state.textBaseline,
      direction: state.direction,
      clips: state.clips.map(cloneClip)
    };
    if (includePath)
      result.path = clonePath(record.path);
    return result;
  }

  function utf8ByteLength(value) {
    let bytes = 0;
    for (const character of value) {
      const codePoint = character.codePointAt(0);
      bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 :
        codePoint <= 0xffff ? 3 : 4;
    }
    return bytes;
  }

  function pathSegmentCount(value) {
    if (Array.isArray(value)) {
      let count = 0;
      for (const item of value)
        count += pathSegmentCount(item);
      return count;
    }
    if (!value || typeof value !== 'object')
      return 0;
    let count = 0;
    if (Array.isArray(value.path))
      count += value.path.length;
    for (const key of Object.keys(value)) {
      if (key !== 'path')
        count += pathSegmentCount(value[key]);
    }
    return count;
  }

  function freezeTree(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value))
      return value;
    for (const key of Object.keys(value))
      freezeTree(value[key]);
    return Object.freeze(value);
  }

  function appendCommand(record, command, fullClear) {
    const serializedLength = utf8ByteLength(JSON.stringify(command));
    if (fullClear)
      discardRecordedCommands(record);
    const segmentCount = pathSegmentCount(command.state);
    if (record.recordedPathSegments + segmentCount > maxAggregatePathSegments) {
      reportLimit(
        record,
        'path',
        'Canvas recording exceeded the native renderer aggregate path limit of 100000 segments.'
      );
      throw errorWithName(
        'NotSupportedError',
        'Canvas recording exceeded the native renderer aggregate path limit.'
      );
    }
    if (record.commands.length >= maxCommands ||
        record.recordedBytes + serializedLength > maxRecordedBytesPerCanvas ||
        totalRecordedBytes + serializedLength > maxTotalRecordedBytes) {
      reportLimit(
        record,
        'command',
        'Canvas recording exceeded the native renderer limit of 5000 commands or bounded output size; later drawing was rejected.'
      );
      throw errorWithName(
        'NotSupportedError',
        'Canvas drawing exceeded the native renderer recording limit.'
      );
    }
    freezeTree(command);
    record.commands.push(command);
    record.recordedBytes += serializedLength;
    totalRecordedBytes += serializedLength;
    record.recordedPathSegments += segmentCount;
    record.revision += 1;
  }

  function currentPath(record) {
    if (record.path.length >= maxPathSegments) {
      reportLimit(
        record,
        'path',
        'Canvas path exceeded the native renderer segment limit.'
      );
      throw errorWithName(
        'NotSupportedError',
        'Canvas path exceeded the native renderer segment limit.'
      );
    }
  }

  function addPathSegment(record, op, args) {
    currentPath(record);
    record.path.push({
      op: op,
      args: args,
      transform: cloneTransform(record.currentState.transform)
    });
  }

  function transformIsIdentity(transform) {
    return transform[0] === 1 && transform[1] === 0 &&
      transform[2] === 0 && transform[3] === 1 &&
      transform[4] === 0 && transform[5] === 0;
  }

  function isFullCanvasClear(record, x, y, width, height) {
    if (!transformIsIdentity(record.currentState.transform) ||
        record.currentState.clips.length !== 0 || width === 0 || height === 0)
      return false;
    const left = Math.min(x, x + width);
    const right = Math.max(x, x + width);
    const top = Math.min(y, y + height);
    const bottom = Math.max(y, y + height);
    return left <= 0 && top <= 0 &&
      right >= record.width && bottom >= record.height;
  }

  function draw(record, op, args, includePath, fullClear) {
    if (!record.dimensionSupported) {
      reportLimit(
        record,
        'dimension',
        'This canvas exceeds the native renderer limit of 8192 pixels per side and 16 megapixels.'
      );
      throw errorWithName(
        'NotSupportedError',
        'Canvas dimensions exceed the native renderer limit.'
      );
    }
    const command = {
      op: op,
      args: args,
      state: stateSnapshot(record, includePath)
    };
    appendCommand(record, command, fullClear === true);
  }

  function fillRule(value) {
    if (value == null)
      return 'nonzero';
    const rule = String(value);
    if (rule === 'nonzero' || rule === 'evenodd')
      return rule;
    throw new TypeError('Canvas fill rule must be "nonzero" or "evenodd".');
  }

  function isGradient(value) {
    return Boolean(value && typeof value === 'object' && value[gradientMark]);
  }

  function createGradient(record, type, args) {
    const descriptor = {
      type: type,
      args: args.map((value, index) => number(value, 'Gradient argument ' + index)),
      transform: cloneTransform(record.currentState.transform),
      stops: []
    };
    Object.defineProperty(descriptor, gradientMark, { value: true });
    descriptor.addColorStop = function(offset, color) {
      const position = Number(offset);
      if (!Number.isFinite(position))
        throw new TypeError('Gradient stop offset must be finite.');
      if (position < 0 || position > 1)
        throw errorWithName('IndexSizeError', 'Gradient stop offset must be between zero and one.');
      const normalizedColor = String(color);
      if (!isSupportedCanvasColor(normalizedColor))
        throw errorWithName('SyntaxError', 'Gradient stop color is not a supported CSS color.');
      if (descriptor.stops.length >= 1024) {
        reportLimit(record, 'gradient_stop', 'Canvas gradient exceeded the native renderer color-stop limit.');
        throw errorWithName('NotSupportedError', 'Canvas gradient exceeded the native renderer color-stop limit.');
      }
      descriptor.stops.push({ offset: position, color: normalizedColor });
    };
    return descriptor;
  }

  function contextFor(record) {
    if (record.context)
      return record.context;
    const context = { canvas: record.canvas };
    record.context = context;

    const propertyNames = [
      'fillStyle', 'strokeStyle', 'globalAlpha', 'globalCompositeOperation',
      'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
      'imageSmoothingEnabled', 'imageSmoothingQuality',
      'font', 'textAlign', 'textBaseline', 'direction'
    ];
    for (const name of propertyNames) {
      Object.defineProperty(context, name, {
        enumerable: true,
        configurable: false,
        get: function() {
          return record.currentState[name];
        },
        set: function(value) {
          const state = record.currentState;
          if (name === 'fillStyle' || name === 'strokeStyle') {
            if (isGradient(value)) {
              state[name] = value;
            } else {
              const color = String(value);
              if (color.length <= 1024 && isSupportedCanvasColor(color))
                state[name] = color;
            }
            return;
          }
          if (name === 'globalAlpha') {
            const alpha = Number(value);
            if (Number.isFinite(alpha) && alpha >= 0 && alpha <= 1)
              state.globalAlpha = alpha;
            return;
          }
          if (name === 'globalCompositeOperation') {
            const operation = String(value);
            if (compositeOperations.has(operation))
              state.globalCompositeOperation = operation;
            return;
          }
          if (name === 'lineWidth' || name === 'miterLimit') {
            const numeric = Number(value);
            if (Number.isFinite(numeric) && numeric > 0)
              state[name] = numeric;
            return;
          }
          if (name === 'lineDashOffset') {
            const numeric = Number(value);
            if (Number.isFinite(numeric))
              state.lineDashOffset = numeric;
            return;
          }
          if (name === 'imageSmoothingEnabled') {
            state.imageSmoothingEnabled = Boolean(value);
            return;
          }
          if (name === 'imageSmoothingQuality') {
            const quality = String(value);
            if (quality === 'low' || quality === 'medium' || quality === 'high')
              state.imageSmoothingQuality = quality;
            return;
          }
          if (name === 'font') {
            const font = String(value);
            if (isSupportedCanvasFont(font))
              state.font = font;
            return;
          }
          const allowed = enumValues[name];
          const normalized = String(value);
          if (allowed && allowed.has(normalized))
            state[name] = normalized;
        }
      });
    }

    for (const name of [
      'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'filter',
      'letterSpacing',
      'wordSpacing', 'fontKerning', 'fontStretch', 'fontVariantCaps'
    ]) {
      Object.defineProperty(context, name, {
        enumerable: true,
        configurable: false,
        get: function() {
          throw unsupported(name);
        },
        set: function() {
          throw unsupported(name);
        }
      });
    }

    context.save = function() {
      if (record.stack.length >= maxSaveDepth) {
        reportLimit(record, 'save_depth', 'Canvas save() exceeded the native renderer stack limit.');
        throw errorWithName('NotSupportedError', 'Canvas save() exceeded the native renderer stack limit.');
      }
      record.stack.push(cloneCurrentState(record.currentState));
    };
    context.restore = function() {
      if (record.stack.length)
        record.currentState = record.stack.pop();
    };
    context.beginPath = function() {
      record.path = [];
    };
    context.closePath = function() {
      addPathSegment(record, 'closePath', []);
    };
    context.moveTo = function(x, y) {
      addPathSegment(record, 'moveTo', [
        number(x, 'x'), number(y, 'y')
      ]);
    };
    context.lineTo = function(x, y) {
      addPathSegment(record, 'lineTo', [
        number(x, 'x'), number(y, 'y')
      ]);
    };
    context.rect = function(x, y, width, height) {
      addPathSegment(record, 'rect', [
        number(x, 'x'), number(y, 'y'),
        number(width, 'width'), number(height, 'height')
      ]);
    };
    context.quadraticCurveTo = function(cpx, cpy, x, y) {
      addPathSegment(record, 'quadraticCurveTo', [
        number(cpx, 'control point x'), number(cpy, 'control point y'),
        number(x, 'x'), number(y, 'y')
      ]);
    };
    context.bezierCurveTo = function(cp1x, cp1y, cp2x, cp2y, x, y) {
      addPathSegment(record, 'bezierCurveTo', [
        number(cp1x, 'first control point x'), number(cp1y, 'first control point y'),
        number(cp2x, 'second control point x'), number(cp2y, 'second control point y'),
        number(x, 'x'), number(y, 'y')
      ]);
    };
    context.arc = function(x, y, radius, startAngle, endAngle, anticlockwise) {
      const r = number(radius, 'radius');
      if (r < 0)
        throw errorWithName('IndexSizeError', 'Arc radius must not be negative.');
      addPathSegment(record, 'arc', [
        number(x, 'x'), number(y, 'y'), r,
        number(startAngle, 'start angle'), number(endAngle, 'end angle'),
        Boolean(anticlockwise)
      ]);
    };
    context.ellipse = function(x, y, radiusX, radiusY, rotation, startAngle, endAngle, anticlockwise) {
      const rx = number(radiusX, 'radiusX');
      const ry = number(radiusY, 'radiusY');
      if (rx < 0 || ry < 0)
        throw errorWithName('IndexSizeError', 'Ellipse radii must not be negative.');
      addPathSegment(record, 'ellipse', [
        number(x, 'x'), number(y, 'y'), rx, ry,
        number(rotation, 'rotation'), number(startAngle, 'start angle'),
        number(endAngle, 'end angle'), Boolean(anticlockwise)
      ]);
    };

    context.fill = function(rule) {
      if (rule != null && typeof rule !== 'string')
        throw unsupported('fill(Path2D)');
      if (arguments.length > 1)
        throw unsupported('fill(Path2D, rule)');
      const normalizedRule = fillRule(rule);
      if (record.path.length)
        draw(record, 'fill', [normalizedRule], true, false);
    };
    context.stroke = function() {
      if (arguments.length)
        throw unsupported('stroke(Path2D)');
      if (record.path.length)
        draw(record, 'stroke', [], true, false);
    };
    context.clip = function(rule) {
      if (rule != null && typeof rule !== 'string')
        throw unsupported('clip(Path2D)');
      if (arguments.length > 1)
        throw unsupported('clip(Path2D, rule)');
      if (record.currentState.clips.length >= maxClips) {
        reportLimit(record, 'clip', 'Canvas clip() exceeded the native renderer clip limit.');
        throw errorWithName('NotSupportedError', 'Canvas clip() exceeded the native renderer clip limit.');
      }
      record.currentState.clips.push({
        path: clonePath(record.path),
        rule: fillRule(rule)
      });
    };
    context.fillRect = function(x, y, width, height) {
      draw(record, 'fillRect', [
        number(x, 'x'), number(y, 'y'),
        number(width, 'width'), number(height, 'height')
      ], false, false);
    };
    context.strokeRect = function(x, y, width, height) {
      draw(record, 'strokeRect', [
        number(x, 'x'), number(y, 'y'),
        number(width, 'width'), number(height, 'height')
      ], false, false);
    };
    context.clearRect = function(x, y, width, height) {
      const values = [
        number(x, 'x'), number(y, 'y'),
        number(width, 'width'), number(height, 'height')
      ];
      draw(record, 'clearRect', values, false, isFullCanvasClear(record, values[0], values[1], values[2], values[3]));
    };

    context.translate = function(x, y) {
      multiplyTransform(record, [1, 0, 0, 1, number(x, 'x'), number(y, 'y')]);
    };
    context.scale = function(x, y) {
      multiplyTransform(record, [number(x, 'x scale'), 0, 0, number(y, 'y scale'), 0, 0]);
    };
    context.rotate = function(angle) {
      const radians = number(angle, 'angle');
      const cosine = Math.cos(radians);
      const sine = Math.sin(radians);
      multiplyTransform(record, [cosine, sine, -sine, cosine, 0, 0]);
    };
    context.transform = function(a, b, c, d, e, f) {
      multiplyTransform(record, [
        number(a, 'a'), number(b, 'b'), number(c, 'c'),
        number(d, 'd'), number(e, 'e'), number(f, 'f')
      ]);
    };
    context.setTransform = function(a, b, c, d, e, f) {
      let matrix;
      if (arguments.length === 1 &&
          (a == null || typeof a === 'object' || typeof a === 'function')) {
        const init = a == null ? {} : a;
        if (init.is2D !== undefined && !Boolean(init.is2D))
          throw new TypeError('Canvas transforms must be two-dimensional.');
        const pairs = [
          ['a', 'm11', 1], ['b', 'm12', 0], ['c', 'm21', 0],
          ['d', 'm22', 1], ['e', 'm41', 0], ['f', 'm42', 0]
        ];
        matrix = pairs.map(([name, alias, fallback]) => {
          const directValue = init[name];
          const aliasValue = init[alias];
          const hasDirect = directValue !== undefined;
          const hasAlias = aliasValue !== undefined;
          const direct = hasDirect ? number(directValue, name) : fallback;
          const alternate = hasAlias ? number(aliasValue, alias) : fallback;
          if (hasDirect && hasAlias && direct !== alternate)
            throw new TypeError('Canvas transform matrix aliases must agree.');
          return hasDirect ? direct : hasAlias ? alternate : fallback;
        });
      } else if (arguments.length === 0) {
        matrix = [1, 0, 0, 1, 0, 0];
      } else {
        if (arguments.length !== 6)
          throw new TypeError('setTransform() requires a matrix or six numeric values.');
        matrix = [
          number(a, 'a'), number(b, 'b'), number(c, 'c'),
          number(d, 'd'), number(e, 'e'), number(f, 'f')
        ];
      }
      record.currentState.transform = matrix;
    };
    context.resetTransform = function() {
      record.currentState.transform = [1, 0, 0, 1, 0, 0];
    };
    context.getTransform = function() {
      const [a, b, c, d, e, f] = record.currentState.transform;
      const matrix = { a: a, b: b, c: c, d: d, e: e, f: f };
      for (const [alias, name] of [
        ['m11', 'a'], ['m12', 'b'], ['m21', 'c'],
        ['m22', 'd'], ['m41', 'e'], ['m42', 'f']
      ]) {
        Object.defineProperty(matrix, alias, {
          enumerable: true,
          configurable: false,
          get: function() { return matrix[name]; },
          set: function(value) { matrix[name] = Number(value); }
        });
      }
      Object.defineProperty(matrix, 'is2D', {
        enumerable: true,
        configurable: false,
        value: true,
        writable: false
      });
      return matrix;
    };
    context.setLineDash = function(segments) {
      if (segments == null || typeof segments[Symbol.iterator] !== 'function')
        throw new TypeError('Line dash must be iterable.');
      const dash = Array.from(segments, (value, index) =>
        number(value, 'line dash ' + index)
      );
      if (dash.some(value => value < 0))
        throw errorWithName('IndexSizeError', 'Line dash values must not be negative.');
      record.currentState.lineDash = dash.length % 2 ? dash.concat(dash) : dash;
    };
    context.getLineDash = function() {
      return record.currentState.lineDash.slice();
    };
    context.createLinearGradient = function(x0, y0, x1, y1) {
      return createGradient(record, 'linear', [x0, y0, x1, y1]);
    };
    context.createRadialGradient = function(x0, y0, r0, x1, y1, r1) {
      const innerRadius = number(r0, 'inner radius');
      const outerRadius = number(r1, 'outer radius');
      if (innerRadius < 0 || outerRadius < 0)
        throw errorWithName('IndexSizeError', 'Gradient radii must not be negative.');
      return createGradient(record, 'radial', [
        x0, y0, innerRadius, x1, y1, outerRadius
      ]);
    };
    context.measureText = function(text) {
      if (arguments.length === 0) throw new TypeError('measureText requires a text argument');
      if (typeof text === 'symbol') throw new TypeError('Canvas text cannot be a Symbol');
      if (typeof options.measureText !== 'function')
        throw unsupported('measureText', options.textMetricError || undefined);
      const state = record.currentState;
      let width;
      try {
        width = options.measureText(state.font,String(text),state.direction === 'rtl' ? 'rtl' : 'ltr');
      } catch (error) {
        if (error && error.name === 'NotSupportedError') throw unsupported('measureText',String(error.message));
        throw error;
      }
      if (!Number.isFinite(width) || width < 0) throw new TypeError('Invalid native Canvas text width');
      return new TextMetrics(metricToken,width);
    };
    context.fillText = function(text, x, y, maxWidth) {
      const args = [
        String(text),
        number(x, 'x'),
        number(y, 'y')
      ];
      if (maxWidth !== undefined) {
        const width = imageNumber(maxWidth, 'maxWidth');
        if (!Number.isFinite(width) || width <= 0) return;
        args.push(width);
      }
      draw(record, 'fillText', args, false, false);
    };
    context.strokeText = function(text, x, y, maxWidth) {
      const args = [
        String(text),
        number(x, 'x'),
        number(y, 'y')
      ];
      if (maxWidth !== undefined) {
        const width = imageNumber(maxWidth, 'maxWidth');
        if (!Number.isFinite(width) || width <= 0) return;
        args.push(width);
      }
      draw(record, 'strokeText', args, false, false);
    };

    function imageNumber(value, name) {
      if (typeof value === 'bigint')
        throw new TypeError((name || 'Canvas argument') + ' cannot be converted from BigInt.');
      const result = Number(value);
      if (Number.isFinite(result) && Math.abs(result) > maxCoordinate)
        return number(result, name);
      return result;
    }

    context.drawImage = function(source) {
      if (arguments.length !== 3 && arguments.length !== 5 && arguments.length < 9)
        throw new TypeError('drawImage expects 3, 5, or 9 arguments.');
      if (source === null || source === undefined)
        throw new TypeError('drawImage requires an image source.');
      if (typeof options.resolveImage !== 'function')
        throw unsupported('drawImage');

      // A valid but still-loading image is a no-op. The host resolver also
      // rejects unsupported CanvasImageSource types and broken image elements.
      const resolved = options.resolveImage(source);
      const pending = resolved === null;
      if (!pending && (!resolved || typeof resolved !== 'object' ||
          typeof resolved.imageId !== 'string' || resolved.imageId.length === 0 ||
          resolved.imageId.length > 256 ||
          !Number.isSafeInteger(resolved.width) || resolved.width <= 0 ||
          !Number.isSafeInteger(resolved.height) || resolved.height <= 0)) {
        throw errorWithName('InvalidStateError', 'The image source has no usable decoded image.');
      }

      let sx = 0;
      let sy = 0;
      let sw = pending ? 0 : resolved.width;
      let sh = pending ? 0 : resolved.height;
      let dx;
      let dy;
      let dw;
      let dh;
      if (arguments.length === 3) {
        dx = imageNumber(arguments[1], 'dx');
        dy = imageNumber(arguments[2], 'dy');
        dw = sw;
        dh = sh;
      } else if (arguments.length === 5) {
        dx = imageNumber(arguments[1], 'dx');
        dy = imageNumber(arguments[2], 'dy');
        dw = imageNumber(arguments[3], 'dw');
        dh = imageNumber(arguments[4], 'dh');
      } else {
        sx = imageNumber(arguments[1], 'sx');
        sy = imageNumber(arguments[2], 'sy');
        sw = imageNumber(arguments[3], 'sw');
        sh = imageNumber(arguments[4], 'sh');
        dx = imageNumber(arguments[5], 'dx');
        dy = imageNumber(arguments[6], 'dy');
        dw = imageNumber(arguments[7], 'dw');
        dh = imageNumber(arguments[8], 'dh');
      }

      const values = [sx, sy, sw, sh, dx, dy, dw, dh];
      if (values.some(value => !Number.isFinite(value))) return;
      if (pending) return;
      // Canvas normalizes negative source and destination dimensions by moving
      // the origin. It never mirrors the image for a negative dimension.
      if (sw < 0) { sx += sw; sw = -sw; }
      if (sh < 0) { sy += sh; sh = -sh; }
      if (dw < 0) { dx += dw; dw = -dw; }
      if (dh < 0) { dy += dh; dh = -dh; }
      if (sw === 0 || sh === 0 || dw === 0 || dh === 0) return;

      // Clip the source rectangle here rather than relying on image sampling
      // outside the decoded bitmap. Destination bounds are adjusted by the
      // same fraction, preserving the browser's proportional crop.
      const sourceRight = sx + sw;
      const sourceBottom = sy + sh;
      const clippedLeft = Math.max(0, sx);
      const clippedTop = Math.max(0, sy);
      const clippedRight = Math.min(resolved.width, sourceRight);
      const clippedBottom = Math.min(resolved.height, sourceBottom);
      if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) return;
      const sourceScaleX = dw / sw;
      const sourceScaleY = dh / sh;
      dx += (clippedLeft - sx) * sourceScaleX;
      dy += (clippedTop - sy) * sourceScaleY;
      dw = (clippedRight - clippedLeft) * sourceScaleX;
      dh = (clippedBottom - clippedTop) * sourceScaleY;
      sx = clippedLeft;
      sy = clippedTop;
      sw = clippedRight - clippedLeft;
      sh = clippedBottom - clippedTop;

      // Apply the same finite-coordinate bounds used by the other Canvas
      // commands after the geometry has been normalized and clipped.
      const args = [
        resolved.imageId,
        number(sx, 'sx'), number(sy, 'sy'),
        number(sw, 'sw'), number(sh, 'sh'),
        number(dx, 'dx'), number(dy, 'dy'),
        number(dw, 'dw'), number(dh, 'dh')
      ];
      draw(record, 'drawImage', args, false, false);
    };

    for (const api of [
      'createPattern', 'createConicGradient',
      'getImageData', 'putImageData', 'createImageData', 'isPointInPath',
      'isPointInStroke', 'arcTo', 'roundRect',
      'scrollPathIntoView', 'reset'
    ]) {
      context[api] = function() {
        throw unsupported(api);
      };
    }
    return context;
  }

  function multiplyTransform(record, right) {
    const left = record.currentState.transform;
    const next = [
      left[0] * right[0] + left[2] * right[1],
      left[1] * right[0] + left[3] * right[1],
      left[0] * right[2] + left[2] * right[3],
      left[1] * right[2] + left[3] * right[3],
      left[0] * right[4] + left[2] * right[5] + left[4],
      left[1] * right[4] + left[3] * right[5] + left[5]
    ];
    if (next.some(value => !Number.isFinite(value) || Math.abs(value) > maxCoordinate)) {
      if (!coordinateLimitReported) {
        coordinateLimitReported = true;
        report(
          'canvas.coordinate_limit',
          'error',
          'Canvas coordinates and transform values are limited to 1000000000.',
          { field: 'transform' }
        );
      }
      throw errorWithName(
        'NotSupportedError',
        'Canvas transform exceeds the native renderer limit.'
      );
    }
    record.currentState.transform = next;
  }

  function patchUnsupportedCanvasMethod(prototype, name) {
    Object.defineProperty(prototype, name, {
      configurable: true,
      writable: true,
      value: function() {
        throw unsupported('canvas.' + name);
      }
    });
  }

  function install() {
    if (!document || typeof document.createElement !== 'function')
      throw new TypeError('Canvas recorder requires a document.');
    const sample = document.createElement('canvas');
    const prototype = sample && Object.getPrototypeOf(sample);
    if (!prototype)
      throw new TypeError('Canvas elements do not expose a patchable prototype.');

    const rawSetAttribute = prototype.setAttribute;
    const rawRemoveAttribute = prototype.removeAttribute;
    const rawSetAttributeNS = prototype.setAttributeNS;
    const rawRemoveAttributeNS = prototype.removeAttributeNS;
    const rawToggleAttribute = prototype.toggleAttribute;

    function dimensionMutation(canvas) {
      resetForResize(canvas);
    }

    Object.defineProperty(prototype, 'getContext', {
      configurable: true,
      writable: true,
      value: function(type, attributes) {
        if (String(type) !== '2d') {
          if (String(type) === 'webgl' || String(type) === 'webgl2' ||
              String(type) === 'experimental-webgl' ||
              String(type) === 'bitmaprenderer') {
            unsupportedReported.add('context:' + String(type));
            report(
              'canvas.unsupported_context',
              'error',
              'Canvas context "' + String(type) + '" is unavailable in the native renderer.',
              { context: String(type), id: safeCanvasId(this) }
            );
          }
          return null;
        }
        if (attributes && typeof attributes === 'object') {
          if (attributes.alpha === false ||
              (attributes.colorSpace != null && attributes.colorSpace !== 'srgb')) {
            throw unsupported(
              'getContext(options)',
              'Requested Canvas 2D context options are unavailable in the native renderer.'
            );
          }
        }
        safeCanvasId(this);
        return contextFor(recordFor(this));
      }
    });

    for (const axis of ['width', 'height']) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, axis);
      Object.defineProperty(prototype, axis, {
        configurable: true,
        enumerable: descriptor ? descriptor.enumerable : true,
        get: function() {
          return readDimension(this, axis);
        },
        set: function(value) {
          const dimension = unsignedLong(value);
          if (typeof rawSetAttribute !== 'function')
            throw new TypeError('Canvas element cannot reflect its ' + axis + ' attribute.');
          rawSetAttribute.call(this, axis, String(dimension));
          dimensionMutation(this);
        }
      });
    }

    if (typeof rawSetAttribute === 'function') {
      Object.defineProperty(prototype, 'setAttribute', {
        configurable: true,
        writable: true,
        value: function(name, value) {
          const result = rawSetAttribute.call(this, name, value);
          const normalized = String(name).toLowerCase();
          if (normalized === 'width' || normalized === 'height')
            dimensionMutation(this);
          return result;
        }
      });
    }
    if (typeof rawRemoveAttribute === 'function') {
      Object.defineProperty(prototype, 'removeAttribute', {
        configurable: true,
        writable: true,
        value: function(name) {
          const normalized = String(name).toLowerCase();
          const result = rawRemoveAttribute.call(this, name);
          if (normalized === 'width' || normalized === 'height')
            dimensionMutation(this);
          return result;
        }
      });
    }
    if (typeof rawSetAttributeNS === 'function') {
      Object.defineProperty(prototype, 'setAttributeNS', {
        configurable: true,
        writable: true,
        value: function(namespace, qualifiedName, value) {
          const localName = String(qualifiedName).split(':').pop().toLowerCase();
          const result = rawSetAttributeNS.call(this, namespace, qualifiedName, value);
          if (localName === 'width' || localName === 'height')
            dimensionMutation(this);
          return result;
        }
      });
    }
    if (typeof rawRemoveAttributeNS === 'function') {
      Object.defineProperty(prototype, 'removeAttributeNS', {
        configurable: true,
        writable: true,
        value: function(namespace, localName) {
          const normalized = String(localName).toLowerCase();
          const result = rawRemoveAttributeNS.call(this, namespace, localName);
          if (normalized === 'width' || normalized === 'height')
            dimensionMutation(this);
          return result;
        }
      });
    }
    if (typeof rawToggleAttribute === 'function') {
      Object.defineProperty(prototype, 'toggleAttribute', {
        configurable: true,
        writable: true,
        value: function(name, force) {
          const normalized = String(name).toLowerCase();
          const before = this.hasAttribute(normalized);
          const result = arguments.length < 2
            ? rawToggleAttribute.call(this, name)
            : rawToggleAttribute.call(this, name, force);
          if ((normalized === 'width' || normalized === 'height') &&
              before !== this.hasAttribute(normalized))
            dimensionMutation(this);
          return result;
        }
      });
    }

    patchUnsupportedCanvasMethod(prototype, 'toDataURL');
    patchUnsupportedCanvasMethod(prototype, 'toBlob');
    return { install: install, snapshots: snapshots };
  }

  function snapshots() {
    if (!document || typeof document.querySelectorAll !== 'function')
      return [];
    const canvases = document.querySelectorAll('canvas');
    const output = [];
    const connected = Array.from(canvases || []);
    if (connected.length > maxCanvases && !canvasCountLimitReported) {
      canvasCountLimitReported = true;
      report(
        'canvas.count_limit',
        'error',
        'Only the first 64 connected canvases can be represented by the native renderer.',
        { count: connected.length, limit: maxCanvases }
      );
    }
    for (const canvas of connected.slice(0, maxCanvases)) {
      const record = recordFor(canvas);
      if (!record.dimensionSupported)
        continue;
      output.push({
        id: safeCanvasId(canvas),
        width: record.width,
        height: record.height,
        revision: record.revision,
        commands: record.commands.slice()
      });
    }
    return output;
  }

  return {
    TextMetrics, install: install, snapshots: snapshots };
}
