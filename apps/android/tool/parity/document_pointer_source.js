/*
 * A bounded DOM pointer-event shim for the native document runtime.
 *
 * Coordinates remain in CSS pixels. Host-measured canvas rectangles are
 * available only during the synchronous trusted native event dispatch that
 * supplied them, so layout-dependent scripts never receive stale geometry.
 */
const documentPointerManagers = new WeakMap();
const installedPointerElementPrototypes = new WeakSet();
const installedPointerCanvasPrototypes = new WeakSet();
const pointerEventClassesByUIEvent = new WeakMap();

function createDocumentPointer(deps) {
  const options = deps || {};
  const document = options.document;
  const HTMLElement = options.HTMLElement ||
    (document && document.defaultView && document.defaultView.HTMLElement);
  const UIEvent = options.UIEvent;
  const defineEventMember = typeof options.defineEventMember === 'function'
    ? options.defineEventMember
    : function(event, name, value) {
        Object.defineProperty(event, name, {
          value: value,
          enumerable: true,
          configurable: false,
          writable: false
        });
      };
  const diagnostic = typeof options.diagnostic === 'function'
    ? options.diagnostic
    : function() {};
  const classes = createDocumentPointer.eventClasses({
    UIEvent: UIEvent,
    defineEventMember: defineEventMember
  });
  const MouseEvent = classes.MouseEvent;
  const PointerEvent = classes.PointerEvent;

  const maxCoordinate = 1e9;
  const maxPointerId = 2147483647;
  const maxActivePointers = 32;
  const maxStringLength = 64;
  const pointerTypes = new Set(['mouse', 'pen', 'touch']);
  const pointerNativeTypes = new Set([
    'pointerover', 'pointerenter', 'pointerdown', 'pointermove',
    'pointerup', 'pointercancel', 'pointerout', 'pointerleave'
  ]);
  const nonBubblingPointerTypes = new Set(['pointerenter', 'pointerleave']);
  const nonCancelablePointerTypes = new Set([
    'pointerenter', 'pointerleave', 'pointercancel',
    'gotpointercapture', 'lostpointercapture'
  ]);
  const activePointers = new Map();
  // Kept for the legacy geometry-only pointer shim when the host layout bridge
  // is disabled. The native-layout runtime never reads this cross-dispatch
  // cache; it uses nativeCanvasRect() only while a trusted event is active.
  const canvasRects = new WeakMap();
  const nativeCanvasGeometry = [];
  const diagnosticOnce = new Set();

  function report(code, severity, message, detail) {
    try {
      diagnostic(code, severity, message, detail);
    } catch (error) {
      // Diagnostics must not change event dispatch behavior.
    }
  }

  function reportOnce(code, severity, message, detail) {
    if (diagnosticOnce.has(code))
      return;
    diagnosticOnce.add(code);
    report(code, severity, message, detail);
  }

  function errorWithName(name, message) {
    try {
      const view = document && document.defaultView;
      if (view && typeof view.DOMException === 'function')
        return new view.DOMException(message, name);
    } catch (error) {
      // Fall through for DOMs without DOMException.
    }
    const error = new Error(message);
    error.name = name;
    return error;
  }

  function ownValue(source, name) {
    if (!source || typeof source !== 'object')
      return undefined;
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, name);
    } catch (error) {
      return undefined;
    }
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : undefined;
  }

  function finiteNumber(source, name) {
    const value = ownValue(source, name);
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > maxCoordinate)
      return undefined;
    return value;
  }

  function boundedNumber(value, fallback, minimum, maximum, integer) {
    if (typeof value !== 'number' || !Number.isFinite(value))
      return fallback;
    let result = Math.max(minimum, Math.min(maximum, value));
    if (integer)
      result = Math.trunc(result);
    return result;
  }

  function boundedString(value, fallback, maximumLength) {
    if (typeof value !== 'string')
      return fallback;
    return value.slice(0, maximumLength || maxStringLength);
  }

  function booleanValue(source, name, fallback) {
    const value = ownValue(source, name);
    return typeof value === 'boolean' ? value : fallback;
  }

  function sanitizeGeometry(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source))
      return null;
    const rawLeft = finiteNumber(source, 'left');
    const rawTop = finiteNumber(source, 'top');
    const x = rawLeft === undefined ? finiteNumber(source, 'x') : rawLeft;
    const y = rawTop === undefined ? finiteNumber(source, 'y') : rawTop;
    const width = finiteNumber(source, 'width');
    const height = finiteNumber(source, 'height');
    if (x === undefined || y === undefined || width === undefined || height === undefined ||
        width < 0 || height < 0)
      return null;
    return Object.freeze({
      x: x,
      y: y,
      left: x,
      top: y,
      right: boundedNumber(x + width, x, -maxCoordinate, maxCoordinate, false),
      bottom: boundedNumber(y + height, y, -maxCoordinate, maxCoordinate, false),
      width: width,
      height: height
    });
  }

  function isCanvas(target) {
    if (!target || typeof target !== 'object')
      return false;
    const name = target.localName || target.tagName;
    return typeof name === 'string' && name.toLowerCase() === 'canvas';
  }

  function rememberGeometry(target, source) {
    if (!isCanvas(target)) return null;
    const geometry = sanitizeGeometry(source);
    if (geometry) canvasRects.set(target, geometry);
    return geometry;
  }

  function isOwnedConnectedCanvas(target) {
    if (!isCanvas(target) || target.ownerDocument !== document)
      return false;
    if (target.isConnected === false)
      return false;
    const root = document && document.documentElement;
    if (root && typeof root.contains === 'function')
      return root.contains(target);
    if (document && typeof document.contains === 'function')
      return document.contains(target);
    return target.isConnected === true;
  }

  function withCanvasGeometry(target, geometry, callback) {
    if (!isCanvas(target))
      return callback();
    const frame = { target: target, geometry: geometry };
    nativeCanvasGeometry.push(frame);
    try {
      return callback();
    } finally {
      // Normally this is the last frame. Remove by identity as well so nested
      // or exceptional dispatch paths cannot leave a stale geometry grant.
      const index = nativeCanvasGeometry.lastIndexOf(frame);
      if (index >= 0)
        nativeCanvasGeometry.splice(index, 1);
    }
  }

  function nativeCanvasRect(target) {
    if (!isOwnedConnectedCanvas(target))
      return null;
    for (let index = nativeCanvasGeometry.length - 1; index >= 0; index--) {
      const frame = nativeCanvasGeometry[index];
      if (frame.target === target)
        return frame.geometry ? snapshotRect(frame.geometry) : null;
    }
    return null;
  }

  function withNativeDispatchGeometry(target, eventData, callback) {
    if (typeof callback !== 'function')
      throw new TypeError('Expected a native event callback');
    const data = nativeEventData(eventData, 'click');
    if (!data)
      return callback();
    return withCanvasGeometry(target, data.geometry, callback);
  }

  function snapshotRect(rect) {
    const result = {
      x: rect.x,
      y: rect.y,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    };
    result.toJSON = function() {
      return {
        x: result.x,
        y: result.y,
        left: result.left,
        top: result.top,
        right: result.right,
        bottom: result.bottom,
        width: result.width,
        height: result.height
      };
    };
    return Object.freeze(result);
  }

  function readPointerMetadata(source) {
    const pointerId = finiteNumber(source, 'pointerId');
    const rawPointerType = ownValue(source, 'pointerType');
    if (pointerId === undefined || Math.trunc(pointerId) !== pointerId ||
        pointerId < 0 || pointerId > maxPointerId ||
        typeof rawPointerType !== 'string' || !pointerTypes.has(rawPointerType))
      return null;
    return {
      pointerId: pointerId,
      pointerType: rawPointerType,
      isPrimary: booleanValue(source, 'isPrimary', false)
    };
  }

  function nativeEventData(source, type) {
    const metadata = readPointerMetadata(source);
    if (!metadata)
      return null;
    const geometry = sanitizeGeometry(ownValue(source, 'geometry'));
    const data = {
      pointerId: metadata.pointerId,
      pointerType: metadata.pointerType,
      isPrimary: metadata.isPrimary,
      geometry: geometry,
      type: type
    };
    for (const name of [
      'clientX', 'clientY', 'screenX', 'screenY', 'offsetX', 'offsetY',
      'movementX', 'movementY', 'width', 'height', 'pressure',
      'tangentialPressure', 'tiltX', 'tiltY', 'twist',
      'altitudeAngle', 'azimuthAngle', 'button', 'buttons'
    ]) {
      const value = finiteNumber(source, name);
      if (value !== undefined)
        data[name] = value;
    }
    for (const name of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey']) {
      const value = ownValue(source, name);
      if (typeof value === 'boolean')
        data[name] = value;
    }
    return data;
  }

  function pointerEventInit(type, data) {
    const clientX = data.clientX === undefined ? 0 : data.clientX;
    const clientY = data.clientY === undefined ? 0 : data.clientY;
    const geometry = data.geometry;
    const offsetX = data.offsetX !== undefined ? data.offsetX :
      (geometry ? clientX - geometry.left : 0);
    const offsetY = data.offsetY !== undefined ? data.offsetY :
      (geometry ? clientY - geometry.top : 0);
    const defaultButton = type === 'pointermove' || type === 'pointerover' ||
      type === 'pointerout' || type === 'pointerenter' || type === 'pointerleave'
      ? -1 : 0;
    let defaultButtons = 0;
    if (type === 'pointerdown')
      defaultButtons = 1;
    else if (type !== 'pointerup' && type !== 'pointercancel')
      defaultButtons = data.pointerType === 'mouse' ? 0 : 0;
    return {
      bubbles: !nonBubblingPointerTypes.has(type),
      cancelable: !nonCancelablePointerTypes.has(type),
      composed: true,
      view: document && document.defaultView ? document.defaultView : null,
      screenX: boundedNumber(data.screenX, 0, -maxCoordinate, maxCoordinate, false),
      screenY: boundedNumber(data.screenY, 0, -maxCoordinate, maxCoordinate, false),
      clientX: boundedNumber(clientX, 0, -maxCoordinate, maxCoordinate, false),
      clientY: boundedNumber(clientY, 0, -maxCoordinate, maxCoordinate, false),
      offsetX: boundedNumber(offsetX, 0, -maxCoordinate, maxCoordinate, false),
      offsetY: boundedNumber(offsetY, 0, -maxCoordinate, maxCoordinate, false),
      movementX: boundedNumber(data.movementX, 0, -maxCoordinate, maxCoordinate, false),
      movementY: boundedNumber(data.movementY, 0, -maxCoordinate, maxCoordinate, false),
      ctrlKey: data.ctrlKey === true,
      shiftKey: data.shiftKey === true,
      altKey: data.altKey === true,
      metaKey: data.metaKey === true,
      button: boundedNumber(data.button, defaultButton, -32768, 32767, true),
      buttons: boundedNumber(data.buttons, defaultButtons, 0, 65535, true),
      relatedTarget: null,
      pointerId: data.pointerId,
      pointerType: data.pointerType,
      isPrimary: data.isPrimary === true,
      width: boundedNumber(data.width, 1, 0, maxCoordinate, false),
      height: boundedNumber(data.height, 1, 0, maxCoordinate, false),
      pressure: boundedNumber(data.pressure, 0, 0, 1, false),
      tangentialPressure: boundedNumber(data.tangentialPressure, 0, -1, 1, false),
      tiltX: boundedNumber(data.tiltX, 0, -90, 90, true),
      tiltY: boundedNumber(data.tiltY, 0, -90, 90, true),
      twist: boundedNumber(data.twist, 0, 0, 359, true),
      altitudeAngle: boundedNumber(data.altitudeAngle, Math.PI / 2, 0, Math.PI / 2, false),
      azimuthAngle: boundedNumber(data.azimuthAngle, 0, 0, Math.PI * 2, false)
    };
  }

  function mouseEventInit(type, data, clickInit) {
    const pointerInit = pointerEventInit(type, data);
    const boundary = ['mouseover', 'mouseout', 'mouseenter', 'mouseleave'].includes(type);
    const nonBubbling = type === 'mouseenter' || type === 'mouseleave';
    const init = {
      bubbles: clickInit && typeof clickInit.bubbles === 'boolean'
        ? clickInit.bubbles : !nonBubbling,
      cancelable: clickInit && typeof clickInit.cancelable === 'boolean'
        ? clickInit.cancelable : !nonBubbling,
      composed: clickInit && typeof clickInit.composed === 'boolean'
        ? clickInit.composed : !nonBubbling,
      view: document && document.defaultView ? document.defaultView : null,
      detail: clickInit && typeof clickInit.detail === 'number' && Number.isFinite(clickInit.detail)
        ? boundedNumber(clickInit.detail, 1, -2147483648, 2147483647, true) : (type === 'mousemove' || boundary ? 0 : 1),
      screenX: pointerInit.screenX,
      screenY: pointerInit.screenY,
      clientX: pointerInit.clientX,
      clientY: pointerInit.clientY,
      offsetX: pointerInit.offsetX,
      offsetY: pointerInit.offsetY,
      movementX: pointerInit.movementX,
      movementY: pointerInit.movementY,
      ctrlKey: pointerInit.ctrlKey,
      shiftKey: pointerInit.shiftKey,
      altKey: pointerInit.altKey,
      metaKey: pointerInit.metaKey,
      button: pointerInit.button,
      buttons: pointerInit.buttons,
      relatedTarget: null
    };
    return init;
  }

  function dispatchEvent(target, event) {
    if (!target || typeof target.dispatchEvent !== 'function')
      return false;
    return target.dispatchEvent(event);
  }

  function captureEventInit(type, pointer) {
    const last = pointer.lastEventData || {};
    const data = Object.assign({}, last, {
      pointerId: pointer.pointerId,
      pointerType: pointer.pointerType,
      isPrimary: pointer.isPrimary,
      button: -1
    });
    return pointerEventInit(type, data);
  }

  function processPendingCapture(pointer) {
    if (!pointer || !pointer.hasPendingCapture)
      return;
    const previous = pointer.captureTarget;
    const next = pointer.pendingCaptureTarget;
    pointer.hasPendingCapture = false;
    pointer.pendingCaptureTarget = null;
    if (previous === next)
      return;
    pointer.captureTarget = next;
    if (previous)
      dispatchEvent(previous, new PointerEvent('lostpointercapture', captureEventInit('lostpointercapture', pointer)));
    if (next)
      dispatchEvent(next, new PointerEvent('gotpointercapture', captureEventInit('gotpointercapture', pointer)));
  }

  function setPendingCapture(pointer, target) {
    pointer.pendingCaptureTarget = target;
    pointer.hasPendingCapture = true;
  }

  function activePointerFor(id) {
    return activePointers.get(id) || null;
  }

  function captureMethodError(name, message) {
    return errorWithName(name, message);
  }

  function pointerIdArgument(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric))
      return 0;
    const truncated = Math.trunc(numeric);
    if (truncated < -2147483648 || truncated > maxPointerId)
      return 0;
    return truncated;
  }

  function installElementMethods() {
    if (!HTMLElement || !HTMLElement.prototype || installedPointerElementPrototypes.has(HTMLElement.prototype))
      return;
    const prototype = HTMLElement.prototype;
    const methods = {
      setPointerCapture: function(pointerId) {
        const owner = this && this.ownerDocument;
        const manager = owner && documentPointerManagers.get(owner);
        const id = pointerIdArgument(pointerId);
        const pointer = manager && manager.activePointers.get(id);
        if (!manager || !pointer)
          throw captureMethodError('NotFoundError', 'The pointer is not active.');
        if (this.isConnected === false)
          throw captureMethodError('InvalidStateError', 'Pointer capture requires a connected element.');
        pointer.pendingCaptureTarget = this;
        pointer.hasPendingCapture = true;
      },
      releasePointerCapture: function(pointerId) {
        const owner = this && this.ownerDocument;
        const manager = owner && documentPointerManagers.get(owner);
        const id = pointerIdArgument(pointerId);
        const pointer = manager && manager.activePointers.get(id);
        if (!manager || !pointer)
          throw captureMethodError('NotFoundError', 'The pointer is not active.');
        const current = pointer.hasPendingCapture
          ? pointer.pendingCaptureTarget
          : pointer.captureTarget;
        if (current === this) {
          pointer.pendingCaptureTarget = null;
          pointer.hasPendingCapture = true;
        }
      },
      hasPointerCapture: function(pointerId) {
        const owner = this && this.ownerDocument;
        const manager = owner && documentPointerManagers.get(owner);
        const id = pointerIdArgument(pointerId);
        const pointer = manager && manager.activePointers.get(id);
        if (!pointer)
          return false;
        return (pointer.hasPendingCapture ? pointer.pendingCaptureTarget : pointer.captureTarget) === this;
      }
    };
    for (const name of Object.keys(methods)) {
      try {
        Object.defineProperty(prototype, name, {
          value: methods[name],
          enumerable: false,
          configurable: true,
          writable: true
        });
      } catch (error) {
        report('pointer.install_error', 'warning', 'Could not install HTMLElement.' + name + '.', { method: name });
      }
    }
    installedPointerElementPrototypes.add(prototype);
  }

  function canvasPrototype() {
    const view = document && document.defaultView;
    if (view && typeof view.HTMLCanvasElement === 'function' && view.HTMLCanvasElement.prototype)
      return view.HTMLCanvasElement.prototype;
    if (document && typeof document.createElement === 'function') {
      try {
        const canvas = document.createElement('canvas');
        const prototype = canvas && Object.getPrototypeOf(canvas);
        if (prototype)
          return prototype;
      } catch (error) {
        // Canvas is optional in this document implementation.
      }
    }
    return null;
  }

  function installCanvasGeometry() {
    const prototype = canvasPrototype();
    if (!prototype || installedPointerCanvasPrototypes.has(prototype))
      return;
    try {
      Object.defineProperty(prototype, 'getBoundingClientRect', {
        value: function() {
          const manager = this && this.ownerDocument && documentPointerManagers.get(this.ownerDocument);
          const rect = manager && (manager.nativeCanvasRect(this) || manager.canvasRects.get(this));
          if (!rect) {
            reportOnce(
              'pointer.canvas_rect_unavailable',
              'error',
              'Canvas getBoundingClientRect() requires a host-measured canvas rectangle.'
            );
            throw errorWithName(
              'NotSupportedError',
              'Canvas getBoundingClientRect() is unavailable until host-measured geometry is supplied.'
            );
          }
          return rect;
        },
        enumerable: false,
        configurable: true,
        writable: true
      });
      installedPointerCanvasPrototypes.add(prototype);
    } catch (error) {
      report('pointer.install_error', 'warning', 'Could not install canvas getBoundingClientRect().');
    }
  }

  function dispatchMouseCompatibility(target, type, data) {
    const mouseType = type === 'pointerdown' ? 'mousedown' :
      type === 'pointermove' ? 'mousemove' :
      type === 'pointerup' ? 'mouseup' :
      type === 'pointerover' ? 'mouseover' :
      type === 'pointerout' ? 'mouseout' :
      type === 'pointerenter' ? 'mouseenter' :
      type === 'pointerleave' ? 'mouseleave' : null;
    if (!mouseType)
      return null;
    const event = new MouseEvent(mouseType, mouseEventInit(mouseType, type === 'pointermove' ? Object.assign({}, data, {button: 0}) : data));
    dispatchEvent(target, event);
    return event;
  }

  function ensurePointerState(data) {
    let pointer = activePointers.get(data.pointerId);
    if (pointer)
      return pointer;
    if (activePointers.size >= maxActivePointers) {
      reportOnce(
        'pointer.active_pointer_limit',
        'warning',
        'The native document runtime tracks at most ' + maxActivePointers + ' active pointers.'
      );
      return null;
    }
    pointer = {
      pointerId: data.pointerId,
      pointerType: data.pointerType,
      isPrimary: data.isPrimary,
      captureTarget: null,
      pendingCaptureTarget: null,
      hasPendingCapture: false,
      suppressCompatMouse: false,
      lastEventData: null
    };
    activePointers.set(data.pointerId, pointer);
    return pointer;
  }

  function dispatch(target, type, eventData) {
    const eventType = String(type);
    if (!pointerNativeTypes.has(eventType))
      return null;
    const data = nativeEventData(eventData, eventType);
    if (!data)
      return null;
    const geometry = rememberGeometry(target, data.geometry);

    return withCanvasGeometry(target, geometry, function() {

    let pointer = activePointerFor(data.pointerId);
    const wasActive = Boolean(pointer);
    if (eventType === 'pointerdown' && !pointer)
      pointer = ensurePointerState(data);
    if (pointer) {
      pointer.pointerType = data.pointerType;
      pointer.isPrimary = data.isPrimary;
      if ((pointer.captureTarget && pointer.captureTarget.isConnected === false) ||
          (pointer.pendingCaptureTarget && pointer.pendingCaptureTarget.isConnected === false))
        setPendingCapture(pointer, null);
      if (eventType !== 'pointerdown' || wasActive)
        processPendingCapture(pointer);
      pointer.lastEventData = data;
    }
    const boundary = ['pointerover', 'pointerenter', 'pointerout', 'pointerleave'].includes(eventType);
    if (boundary && pointer) {
      if (pointer.captureTarget) {
        pointer.deferredBoundary = {
          outside: eventType === 'pointerout' || eventType === 'pointerleave',
          target: target
        };
        return {event: new PointerEvent(eventType, pointerEventInit(eventType, data)), defaultPrevented: false};
      }
      pointer.deferredBoundary = null;
    }
    const eventTarget = pointer && pointer.captureTarget ? pointer.captureTarget : target;
    const event = new PointerEvent(eventType, pointerEventInit(eventType, data));
    if (pointer && eventType === 'pointerdown' && !wasActive &&
        (data.pointerType === 'touch' || data.pointerType === 'pen'))
      setPendingCapture(pointer, target);
    dispatchEvent(eventTarget, event);

    if (pointer && eventType === 'pointerdown' && event.defaultPrevented)
      pointer.suppressCompatMouse = true;
    const suppressCompatMouse = pointer && pointer.suppressCompatMouse;
    if (data.pointerType === 'mouse' && (!suppressCompatMouse || boundary))
      dispatchMouseCompatibility(eventTarget, eventType, data);

    if (pointer && (eventType === 'pointerup' || eventType === 'pointercancel')) {
      if (pointer.captureTarget || pointer.hasPendingCapture)
        setPendingCapture(pointer, null);
      processPendingCapture(pointer);
      activePointers.delete(data.pointerId);
      if (pointer.deferredBoundary?.outside) {
        const boundaryTarget = pointer.deferredBoundary.target;
        if (boundaryTarget?.isConnected !== false) {
          for (const type of ['pointerout', 'pointerleave']) {
            dispatchEvent(boundaryTarget, new PointerEvent(type, pointerEventInit(type, data)));
            if (data.pointerType === 'mouse')
              dispatchMouseCompatibility(boundaryTarget, type, data);
          }
        }
      }
    }
    return { event: event, defaultPrevented: Boolean(event.defaultPrevented) };
    });
  }

  function createMouseBoundaryEvent(type, eventData, relatedTarget) {
    if (!['mouseover', 'mouseout', 'mouseenter', 'mouseleave'].includes(type))
      return null;
    const data = {};
    for (const name of ['clientX', 'clientY', 'screenX', 'screenY', 'offsetX', 'offsetY', 'movementX', 'movementY', 'button', 'buttons']) {
      const value = finiteNumber(eventData, name);
      if (value !== undefined) data[name] = value;
    }
    if (data.clientX === undefined || data.clientY === undefined)
      return null;
    for (const name of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'])
      data[name] = booleanValue(eventData, name, false);
    const init = mouseEventInit(type, data);
    init.relatedTarget = relatedTarget;
    return new MouseEvent(type, init);
  }

  function createClickEvent(eventData, eventInit, target) {
    const metadata = readPointerMetadata(eventData);
    if (!metadata)
      return null;
    const data = nativeEventData(eventData, 'click');
    if (!data)
      return null;
    data.button = data.button === undefined ? 0 : data.button;
    data.buttons = data.buttons === undefined ? 0 : data.buttons;
    const init = mouseEventInit('click', data, eventInit || null);
    init.pointerId = data.pointerId;
    init.pointerType = data.pointerType;
    init.isPrimary = data.isPrimary;
    init.width = boundedNumber(data.width, 1, 0, maxCoordinate, false);
    init.height = boundedNumber(data.height, 1, 0, maxCoordinate, false);
    init.pressure = boundedNumber(data.pressure, 0, 0, 1, false);
    init.tangentialPressure = boundedNumber(data.tangentialPressure, 0, -1, 1, false);
    init.tiltX = boundedNumber(data.tiltX, 0, -90, 90, true);
    init.tiltY = boundedNumber(data.tiltY, 0, -90, 90, true);
    init.twist = boundedNumber(data.twist, 0, 0, 359, true);
    init.altitudeAngle = boundedNumber(data.altitudeAngle, Math.PI / 2, 0, Math.PI / 2, false);
    init.azimuthAngle = boundedNumber(data.azimuthAngle, 0, 0, Math.PI * 2, false);
    return new PointerEvent('click', init);
  }

  function install() {
    documentPointerManagers.set(document, {
      activePointers: activePointers,
      canvasRects: canvasRects,
      nativeCanvasRect: nativeCanvasRect
    });
    installElementMethods();
    installCanvasGeometry();
    return { MouseEvent: MouseEvent, PointerEvent: PointerEvent };
  }

  return {
    MouseEvent: MouseEvent,
    PointerEvent: PointerEvent,
    install: install,
    dispatch: dispatch,
    createClickEvent: createClickEvent,
    createMouseBoundaryEvent: createMouseBoundaryEvent,
    nativeCanvasRect: nativeCanvasRect,
    withNativeDispatchGeometry: withNativeDispatchGeometry
  };
}

createDocumentPointer.eventClasses = function(deps) {
  const options = deps || {};
  const UIEvent = options.UIEvent;
  const defineEventMember = typeof options.defineEventMember === 'function'
    ? options.defineEventMember
    : function(event, name, value) {
        Object.defineProperty(event, name, {
          value: value,
          enumerable: true,
          configurable: false,
          writable: false
        });
      };
  if (typeof UIEvent !== 'function')
    throw new TypeError('createDocumentPointer requires a UIEvent constructor.');
  const cached = pointerEventClassesByUIEvent.get(UIEvent);
  if (cached)
    return cached;

  function optionValue(source, name, fallback) {
    if (!source || typeof source !== 'object')
      return fallback;
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, name);
    } catch (error) {
      return fallback;
    }
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : fallback;
  }

  function numberOption(source, name, fallback, minimum, maximum, integer) {
    let value = optionValue(source, name, fallback);
    if (typeof value !== 'number' || !Number.isFinite(value))
      value = fallback;
    value = Math.max(minimum, Math.min(maximum, value));
    return integer ? Math.trunc(value) : value;
  }

  function stringOption(source, name, fallback, maximumLength) {
    const value = optionValue(source, name, fallback);
    return typeof value === 'string' ? value.slice(0, maximumLength) : fallback;
  }

  class PircMouseEvent extends UIEvent {
    constructor(type, init) {
      const options = init && typeof init === 'object' ? init : {};
      super(type, options);
      if (!Object.prototype.hasOwnProperty.call(this, 'composed'))
        defineEventMember(this, 'composed', optionValue(options, 'composed', false) === true);
      for (const name of ['screenX', 'screenY', 'clientX', 'clientY', 'offsetX', 'offsetY', 'movementX', 'movementY']) {
        defineEventMember(this, name, numberOption(options, name, 0, -1e9, 1e9, false));
      }
      for (const name of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey'])
        defineEventMember(this, name, optionValue(options, name, false) === true);
      defineEventMember(this, 'button', numberOption(options, 'button', 0, -32768, 32767, true));
      defineEventMember(this, 'buttons', numberOption(options, 'buttons', 0, 0, 65535, true));
      defineEventMember(this, 'relatedTarget', optionValue(options, 'relatedTarget', null));
    }
  }

  class PircPointerEvent extends PircMouseEvent {
    constructor(type, init) {
      const options = init && typeof init === 'object' ? init : {};
      super(type, options);
      defineEventMember(this, 'pointerId', numberOption(options, 'pointerId', 0, -2147483648, 2147483647, true));
      defineEventMember(this, 'width', numberOption(options, 'width', 1, 0, 1e9, false));
      defineEventMember(this, 'height', numberOption(options, 'height', 1, 0, 1e9, false));
      defineEventMember(this, 'pressure', numberOption(options, 'pressure', 0, 0, 1, false));
      defineEventMember(this, 'tangentialPressure', numberOption(options, 'tangentialPressure', 0, -1, 1, false));
      defineEventMember(this, 'tiltX', numberOption(options, 'tiltX', 0, -90, 90, true));
      defineEventMember(this, 'tiltY', numberOption(options, 'tiltY', 0, -90, 90, true));
      defineEventMember(this, 'twist', numberOption(options, 'twist', 0, 0, 359, true));
      defineEventMember(this, 'pointerType', stringOption(options, 'pointerType', '', 32));
      defineEventMember(this, 'isPrimary', optionValue(options, 'isPrimary', false) === true);
      defineEventMember(this, 'altitudeAngle', numberOption(options, 'altitudeAngle', Math.PI / 2, 0, Math.PI / 2, false));
      defineEventMember(this, 'azimuthAngle', numberOption(options, 'azimuthAngle', 0, 0, Math.PI * 2, false));
    }
  }

  const result = Object.freeze({ MouseEvent: PircMouseEvent, PointerEvent: PircPointerEvent });
  pointerEventClassesByUIEvent.set(UIEvent, result);
  return result;
};
