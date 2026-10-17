/*
 * UTF-8 TextEncoder for the standalone document runtime.
 * This file is inserted into the runtime IIFE, so it has no imports, exports,
 * or global side effects.
 */
function createDocumentTextEncoder() {
  const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
  const StringCtor = String;
  const Uint8ArrayCtor = Uint8Array;
  const ArrayBufferIsView = ArrayBuffer.isView;
  const typedArrayPrototype = Object.getPrototypeOf(Uint8ArrayCtor.prototype);
  const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    Symbol.toStringTag
  ).get;
  const typedArrayLengthGetter = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'length'
  ).get;
  const stringCharCodeAt = String.prototype.charCodeAt;
  const encoderInstances = new WeakSet();

  function requireEncoder(receiver) {
    if (!encoderInstances.has(receiver))
      throw new TypeError('Illegal invocation.');
  }

  function toString(value) {
    // String(Symbol()) accepts a Symbol as a special case, while Web IDL's
    // abstract ToString conversion throws for Symbols.
    if (typeof value === 'symbol')
      throw new TypeError('Cannot convert a Symbol value to a string.');
    return StringCtor(value);
  }

  // Return a scalar code point packed with whether it consumed two UTF-16
  // code units. Unpaired surrogates are emitted as U+FFFD without copying the
  // entire source into a second, well-formed string.
  function scalarAt(source, offset) {
    const first = stringCharCodeAt.call(source, offset);
    if (first >= 0xd800 && first <= 0xdbff) {
      if (offset + 1 < source.length) {
        const second = stringCharCodeAt.call(source, offset + 1);
        if (second >= 0xdc00 && second <= 0xdfff) {
          const point = 0x10000 + ((first - 0xd800) << 10) +
            (second - 0xdc00);
          return (point << 1) | 1;
        }
      }
      return 0xfffd << 1;
    }
    if (first >= 0xdc00 && first <= 0xdfff)
      return 0xfffd << 1;
    return first << 1;
  }

  function scalarCodePoint(packed) {
    return packed >>> 1;
  }

  function scalarCodeUnits(packed) {
    return (packed & 1) + 1;
  }

  function utf8Length(point) {
    if (point <= 0x7f) return 1;
    if (point <= 0x7ff) return 2;
    if (point <= 0xffff) return 3;
    return 4;
  }

  // Return limit + 1 as soon as the encoded size is known to exceed limit.
  // This lets encode() reject oversized output before allocating it, and lets
  // encodeInto() preflight only when the destination could exceed the cap.
  function byteLengthUpTo(source, limit) {
    let offset = 0;
    let total = 0;
    while (offset < source.length) {
      const packed = scalarAt(source, offset);
      const size = utf8Length(scalarCodePoint(packed));
      if (total + size > limit) return limit + 1;
      total += size;
      offset += scalarCodeUnits(packed);
    }
    return total;
  }

  function writeScalar(destination, offset, point) {
    if (point <= 0x7f) {
      destination[offset] = point;
      return 1;
    }
    if (point <= 0x7ff) {
      destination[offset] = 0xc0 | (point >>> 6);
      destination[offset + 1] = 0x80 | (point & 0x3f);
      return 2;
    }
    if (point <= 0xffff) {
      destination[offset] = 0xe0 | (point >>> 12);
      destination[offset + 1] = 0x80 | ((point >>> 6) & 0x3f);
      destination[offset + 2] = 0x80 | (point & 0x3f);
      return 3;
    }
    destination[offset] = 0xf0 | (point >>> 18);
    destination[offset + 1] = 0x80 | ((point >>> 12) & 0x3f);
    destination[offset + 2] = 0x80 | ((point >>> 6) & 0x3f);
    destination[offset + 3] = 0x80 | (point & 0x3f);
    return 4;
  }

  function uint8ArrayLength(value) {
    if (value === null || typeof value !== 'object' ||
        !ArrayBufferIsView(value)) {
      throw new TypeError('The destination must be a Uint8Array.');
    }
    let kind;
    try {
      // Intrinsic typed-array accessors validate the internal slot, work across
      // realms and accept SharedArrayBuffer-backed views, while rejecting
      // proxies, DataViews, and other typed-array kinds.
      kind = typedArrayTagGetter.call(value);
      if (kind !== 'Uint8Array')
        throw new TypeError('The destination must be a Uint8Array.');
      return typedArrayLengthGetter.call(value);
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw new TypeError('The destination must be a Uint8Array.');
    }
  }

  class TextEncoder {
    constructor() {
      encoderInstances.add(this);
    }

    get encoding() {
      requireEncoder(this);
      return 'utf-8';
    }

    encode(input = '') {
      requireEncoder(this);
      const source = toString(input);
      const byteLength = byteLengthUpTo(source, MAX_OUTPUT_BYTES);
      if (byteLength > MAX_OUTPUT_BYTES)
        throw new RangeError('Encoded output exceeds 2 MiB.');

      const output = new Uint8ArrayCtor(byteLength);
      let read = 0;
      let written = 0;
      while (read < source.length) {
        const packed = scalarAt(source, read);
        const point = scalarCodePoint(packed);
        written += writeScalar(output, written, point);
        read += scalarCodeUnits(packed);
      }
      return output;
    }

    encodeInto(source, destination) {
      requireEncoder(this);
      const input = toString(source);
      const destinationLength = uint8ArrayLength(destination);

      // If the caller offers a destination larger than the runtime cap, reject
      // before writing whenever this input could write beyond the cap. A small
      // destination still accepts a prefix of an arbitrarily long input.
      if (destinationLength > MAX_OUTPUT_BYTES &&
          byteLengthUpTo(input, MAX_OUTPUT_BYTES) > MAX_OUTPUT_BYTES) {
        throw new RangeError('Encoded output exceeds 2 MiB.');
      }

      let read = 0;
      let written = 0;
      while (read < input.length) {
        const packed = scalarAt(input, read);
        const point = scalarCodePoint(packed);
        const size = utf8Length(point);
        if (written + size > destinationLength ||
            written + size > MAX_OUTPUT_BYTES) {
          break;
        }
        writeScalar(destination, written, point);
        written += size;
        read += scalarCodeUnits(packed);
      }
      return { read, written };
    }
  }

  Object.defineProperty(TextEncoder.prototype, 'encoding', {
    enumerable: true
  });
  Object.defineProperty(TextEncoder.prototype, 'encode', {
    enumerable: true
  });
  Object.defineProperty(TextEncoder.prototype, 'encodeInto', {
    enumerable: true
  });
  Object.defineProperty(TextEncoder.prototype, Symbol.toStringTag, {
    configurable: true,
    enumerable: false,
    value: 'TextEncoder',
    writable: false
  });

  return { TextEncoder };
}
