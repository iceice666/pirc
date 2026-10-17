function createDocumentTextDecoder(deps) {
  'use strict';
  deps = deps || {};

  const MAX_INPUT_BYTES = 2 * 1024 * 1024;
  const MAX_OUTPUT_CODE_UNITS = 2 * 1024 * 1024;
  const states = new WeakMap();
  const decodingError = {};
  const own = Object.prototype.hasOwnProperty;
  const validEncodings = new Set([
    'utf-8', 'utf-16le', 'utf-16be', 'windows-1252', 'big5',
  ]);
  const windows1252Special = new Map([
    [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e],
    [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6],
    [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152],
    [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c],
    [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
    [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a],
    [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178],
  ]);
  const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype, 'byteLength').get;
  const sharedArrayBufferByteLength = typeof SharedArrayBuffer === 'undefined'
    ? null
    : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get;
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
  const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
  const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
  const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get;
  const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get;
  const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset').get;

  function asciiLowercase(value) {
    return value.replace(/[A-Z]/g, function(character) {
      return String.fromCharCode(character.charCodeAt(0) + 0x20);
    });
  }

  function trimAsciiWhitespace(value) {
    return value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  }

  function toDomString(value) {
    // String() uses the string hint for objects; Web IDL rejects Symbols.
    if (typeof value === 'symbol') throw new TypeError('A Symbol cannot be converted to a DOMString.');
    return String(value);
  }

  function getEncoding(label) {
    const key = asciiLowercase(trimAsciiWhitespace(label));
    const labels = deps.encodingLabels;
    const canonical = labels && own.call(labels, key) ? labels[key] : undefined;
    if (typeof canonical !== 'string') {
      throw new RangeError('The encoding label is not supported.');
    }
    const encoding = asciiLowercase(canonical);
    if (!validEncodings.has(encoding)) {
      throw new RangeError('The encoding label is not supported.');
    }
    if (encoding === 'big5' && typeof deps.big5CodePoint !== 'function') {
      throw new RangeError('The Big5 decoder mapping is unavailable.');
    }
    return encoding;
  }

  function dictionary(value) {
    if (value == null) return null;
    if (typeof value !== 'object' && typeof value !== 'function') {
      throw new TypeError('A dictionary argument must be an object or null.');
    }
    return value;
  }

  function readConstructorOptions(value) {
    const options = dictionary(value);
    return {
      fatal: Boolean(options && options.fatal),
      ignoreBOM: Boolean(options && options.ignoreBOM),
    };
  }

  function readDecodeOptions(value) {
    const options = dictionary(value);
    return {stream: Boolean(options && options.stream)};
  }

  function bufferLength(value) {
    try {
      return {kind: 'array-buffer', length: arrayBufferByteLength.call(value)};
    } catch (_) {
      // Try SharedArrayBuffer below. Calling the intrinsic getter is a brand
      // check and continues to work for buffers from another realm.
    }
    if (sharedArrayBufferByteLength) {
      try {
        return {kind: 'shared-array-buffer', length: sharedArrayBufferByteLength.call(value)};
      } catch (_) {
        // Not a SharedArrayBuffer.
      }
    }
    return null;
  }

  function inputBytes(input) {
    if (input === undefined) return null;
    if (ArrayBuffer.isView(input)) {
      let buffer;
      let byteOffset;
      let length;
      try {
        buffer = typedArrayBuffer.call(input);
        byteOffset = typedArrayByteOffset.call(input);
        length = typedArrayByteLength.call(input);
      } catch (_) {
        try {
          buffer = dataViewBuffer.call(input);
          byteOffset = dataViewByteOffset.call(input);
          length = dataViewByteLength.call(input);
        } catch (_) {
          throw new TypeError('The input is not a valid BufferSource.');
        }
      }
      if (length > MAX_INPUT_BYTES) {
        throw new RangeError('TextDecoder input exceeds 2 MiB.');
      }
      try {
        return new Uint8Array(buffer, byteOffset, length).slice();
      } catch (_) {
        throw new TypeError('The input is not a valid BufferSource.');
      }
    }

    const info = bufferLength(input);
    if (!info) throw new TypeError('The input is not a valid BufferSource.');
    if (info.length > MAX_INPUT_BYTES) {
      throw new RangeError('TextDecoder input exceeds 2 MiB.');
    }
    try {
      return new Uint8Array(input).slice();
    } catch (_) {
      throw new TypeError('The input is not a valid BufferSource.');
    }
  }

  function checkedState(receiver) {
    const state = states.get(receiver);
    if (!state) throw new TypeError('Illegal invocation.');
    return state;
  }

  function resetDecoder(state) {
    state.bomSeen = false;
    state.utf8CodePoint = 0;
    state.utf8BytesNeeded = 0;
    state.utf8BytesSeen = 0;
    state.utf8LowerBoundary = 0x80;
    state.utf8UpperBoundary = 0xbf;
    state.utf16LeadingByte = null;
    state.utf16LeadingSurrogate = null;
    state.big5Leading = 0;
  }

  function createOutput() {
    let parts = [];
    let units = [];
    let length = 0;

    function flushUnits() {
      if (units.length) {
        parts.push(String.fromCharCode.apply(null, units));
        units = [];
      }
    }

    return {
      add(codePoint) {
        const count = codePoint > 0xffff ? 2 : 1;
        if (length + count > MAX_OUTPUT_CODE_UNITS) {
          throw new RangeError('TextDecoder output exceeds 2 MiB of UTF-16 code units.');
        }
        length += count;
        if (count === 1) {
          units.push(codePoint);
        } else {
          const value = codePoint - 0x10000;
          units.push(0xd800 + (value >> 10), 0xdc00 + (value & 0x3ff));
        }
        if (units.length >= 8192) flushUnits();
      },
      finish() {
        flushUnits();
        const output = parts.join('');
        parts = [];
        return output;
      },
    };
  }

  function emitCodePoint(state, output, codePoint) {
    if ((state.encoding === 'utf-8' || state.encoding === 'utf-16le' ||
         state.encoding === 'utf-16be') && !state.ignoreBOM && !state.bomSeen) {
      state.bomSeen = true;
      if (codePoint === 0xfeff) return;
    }
    output.add(codePoint);
  }

  function reportDecodeError(state, output) {
    if (state.fatal) throw decodingError;
    emitCodePoint(state, output, 0xfffd);
  }

  function decodeUtf8(state, bytes, output, flush) {
    for (let index = 0; index < bytes.length;) {
      const byte = bytes[index];
      if (state.utf8BytesNeeded === 0) {
        if (byte <= 0x7f) {
          emitCodePoint(state, output, byte);
          index += 1;
          continue;
        }
        if (byte >= 0xc2 && byte <= 0xdf) {
          state.utf8BytesNeeded = 1;
          state.utf8CodePoint = byte & 0x1f;
        } else if (byte >= 0xe0 && byte <= 0xef) {
          state.utf8BytesNeeded = 2;
          state.utf8CodePoint = byte & 0x0f;
          if (byte === 0xe0) state.utf8LowerBoundary = 0xa0;
          if (byte === 0xed) state.utf8UpperBoundary = 0x9f;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          state.utf8BytesNeeded = 3;
          state.utf8CodePoint = byte & 0x07;
          if (byte === 0xf0) state.utf8LowerBoundary = 0x90;
          if (byte === 0xf4) state.utf8UpperBoundary = 0x8f;
        } else {
          reportDecodeError(state, output);
          index += 1;
          continue;
        }
        index += 1;
        continue;
      }

      if (byte < state.utf8LowerBoundary || byte > state.utf8UpperBoundary) {
        state.utf8CodePoint = 0;
        state.utf8BytesNeeded = 0;
        state.utf8BytesSeen = 0;
        state.utf8LowerBoundary = 0x80;
        state.utf8UpperBoundary = 0xbf;
        reportDecodeError(state, output);
        // The byte that broke a multibyte sequence starts the next item.
        continue;
      }

      state.utf8LowerBoundary = 0x80;
      state.utf8UpperBoundary = 0xbf;
      state.utf8CodePoint = (state.utf8CodePoint << 6) | (byte & 0x3f);
      state.utf8BytesSeen += 1;
      index += 1;
      if (state.utf8BytesSeen === state.utf8BytesNeeded) {
        const codePoint = state.utf8CodePoint;
        state.utf8CodePoint = 0;
        state.utf8BytesNeeded = 0;
        state.utf8BytesSeen = 0;
        emitCodePoint(state, output, codePoint);
      }
    }

    if (flush && state.utf8BytesNeeded !== 0) {
      state.utf8CodePoint = 0;
      state.utf8BytesNeeded = 0;
      state.utf8BytesSeen = 0;
      state.utf8LowerBoundary = 0x80;
      state.utf8UpperBoundary = 0xbf;
      reportDecodeError(state, output);
    }
  }

  function decodeUtf16(state, bytes, output, flush) {
    const bigEndian = state.encoding === 'utf-16be';
    for (let index = 0; index < bytes.length;) {
      const byte = bytes[index];
      if (state.utf16LeadingByte === null) {
        state.utf16LeadingByte = byte;
        index += 1;
        continue;
      }

      const first = state.utf16LeadingByte;
      state.utf16LeadingByte = null;
      const codeUnit = bigEndian ? (first << 8) + byte : (byte << 8) + first;

      if (state.utf16LeadingSurrogate !== null) {
        const leadingSurrogate = state.utf16LeadingSurrogate;
        state.utf16LeadingSurrogate = null;
        if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
          emitCodePoint(state, output,
            0x10000 + ((leadingSurrogate - 0xd800) << 10) + (codeUnit - 0xdc00));
          index += 1;
          continue;
        }

        reportDecodeError(state, output);
        // The code unit was restored to the input queue by the shared UTF-16
        // decoder. Process it again without a pending leading surrogate. This
        // also handles a unit whose first byte came from the previous chunk.
      }

      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        state.utf16LeadingSurrogate = codeUnit;
        index += 1;
        continue;
      }
      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        reportDecodeError(state, output);
        index += 1;
        continue;
      }
      emitCodePoint(state, output, codeUnit);
      index += 1;
    }

    if (flush && (state.utf16LeadingByte !== null ||
                  state.utf16LeadingSurrogate !== null)) {
      state.utf16LeadingByte = null;
      state.utf16LeadingSurrogate = null;
      reportDecodeError(state, output);
    }
  }

  function validScalar(value) {
    return Number.isInteger(value) && value >= 0 && value <= 0x10ffff &&
      !(value >= 0xd800 && value <= 0xdfff);
  }

  function big5CodePoints(pointer) {
    switch (pointer) {
      case 1133: return [0x00ca, 0x0304];
      case 1135: return [0x00ca, 0x030c];
      case 1164: return [0x00ea, 0x0304];
      case 1166: return [0x00ea, 0x030c];
      default: {
        const value = deps.big5CodePoint(pointer);
        return validScalar(value) ? [value] : null;
      }
    }
  }

  function decodeBig5(state, bytes, output, flush) {
    for (let index = 0; index < bytes.length;) {
      const byte = bytes[index];
      if (state.big5Leading === 0) {
        if (byte <= 0x7f) {
          emitCodePoint(state, output, byte);
          index += 1;
        } else if (byte >= 0x81 && byte <= 0xfe) {
          state.big5Leading = byte;
          index += 1;
        } else {
          reportDecodeError(state, output);
          index += 1;
        }
        continue;
      }

      const leading = state.big5Leading;
      state.big5Leading = 0;
      if ((byte >= 0x40 && byte <= 0x7e) ||
          (byte >= 0xa1 && byte <= 0xfe)) {
        const offset = byte < 0x7f ? 0x40 : 0x62;
        const pointer = (leading - 0x81) * 157 + (byte - offset);
        const codePoints = big5CodePoints(pointer);
        if (codePoints) {
          for (const codePoint of codePoints) emitCodePoint(state, output, codePoint);
          index += 1;
          continue;
        }
      }

      if (byte <= 0x7f) {
        reportDecodeError(state, output);
        // ASCII is restored to the input queue after a bad Big5 trail.
        continue;
      }
      reportDecodeError(state, output);
      index += 1;
    }

    if (flush && state.big5Leading !== 0) {
      state.big5Leading = 0;
      reportDecodeError(state, output);
    }
  }

  function decodeWindows1252(state, bytes, output) {
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      emitCodePoint(state, output, windows1252Special.get(byte) || byte);
    }
  }

  class TextDecoder {
    constructor() {
      const label = arguments.length === 0 || arguments[0] === undefined
        ? 'utf-8'
        : toDomString(arguments[0]);
      const options = readConstructorOptions(arguments.length < 2 ? undefined : arguments[1]);
      const encoding = getEncoding(label);
      const state = {
        encoding,
        fatal: options.fatal,
        ignoreBOM: options.ignoreBOM,
        doNotFlush: false,
      };
      resetDecoder(state);
      states.set(this, state);
    }

    get encoding() { return checkedState(this).encoding; }
    get fatal() { return checkedState(this).fatal; }
    get ignoreBOM() { return checkedState(this).ignoreBOM; }

    decode(input, options) {
      const state = checkedState(this);
      let bytes;
      let decodeOptions;
      try {
        bytes = inputBytes(input);
        decodeOptions = readDecodeOptions(arguments.length < 2 ? undefined : options);
      } catch (error) {
        if (error && error.name === 'RangeError') {
          resetDecoder(state);
          state.doNotFlush = false;
        }
        throw error;
      }

      if (!state.doNotFlush) resetDecoder(state);
      state.doNotFlush = decodeOptions.stream;
      const output = createOutput();
      const flush = !decodeOptions.stream;

      try {
        const chunk = bytes || new Uint8Array(0);
        if (state.encoding === 'utf-8') decodeUtf8(state, chunk, output, flush);
        else if (state.encoding === 'utf-16le' || state.encoding === 'utf-16be') {
          decodeUtf16(state, chunk, output, flush);
        } else if (state.encoding === 'windows-1252') {
          decodeWindows1252(state, chunk, output);
        } else {
          decodeBig5(state, chunk, output, flush);
        }
        const result = output.finish();
        if (flush) {
          resetDecoder(state);
          state.doNotFlush = false;
        }
        return result;
      } catch (error) {
        resetDecoder(state);
        state.doNotFlush = false;
        if (error === decodingError) {
          throw new TypeError('The encoded data was not valid for the encoding.');
        }
        throw error;
      }
    }
  }

  for (const name of ['encoding', 'fatal', 'ignoreBOM']) {
    const descriptor = Object.getOwnPropertyDescriptor(TextDecoder.prototype, name);
    Object.defineProperty(TextDecoder.prototype, name, {
      get: descriptor.get,
      enumerable: true,
      configurable: true,
    });
  }
  Object.defineProperty(TextDecoder.prototype, 'decode', {
    value: TextDecoder.prototype.decode,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(TextDecoder.prototype, Symbol.toStringTag, {
    value: 'TextDecoder',
    configurable: true,
  });

  return {TextDecoder};
}
