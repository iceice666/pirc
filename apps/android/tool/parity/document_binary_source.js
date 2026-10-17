/*
 * Bounded Blob, File, and FormData primitives for the native document runtime.
 * This source is concatenated into the runtime bundle and intentionally has
 * no imports, exports, or global side effects. It implements in-memory byte
 * bodies and common URL-encoded/multipart parsing, not streams or full browser
 * form serialization, and caps each body at the native fetch budget.
 */
function createDocumentBinary(dependencies) {
  const deps = dependencies || {};
  const MAX_BINARY_BYTES = 2 * 1024 * 1024;
  const MAX_FORM_ENTRIES = 10000;
  const blobStates = new WeakMap();
  const fileStates = new WeakMap();
  const nativeFileStates = new WeakMap();
  const formStates = new WeakMap();
  let nextBoundaryId = 1;

  function sizeError() {
    return new RangeError('Binary document bodies cannot exceed 2 MiB.');
  }

  function checkSize(size) {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BINARY_BYTES)
      throw sizeError();
    return size;
  }

  function byteLength(value) {
    return Object.prototype.toString.call(value) === '[object ArrayBuffer]'
      ? value.byteLength
      : ArrayBuffer.isView(value) ? value.byteLength : null;
  }

  function utf8Length(text) {
    let size = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length &&
          text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
        size += 4;
        index++;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        size += 3;
      } else if (code < 0x80) {
        size++;
      } else if (code < 0x800) {
        size += 2;
      } else {
        size += 3;
      }
      if (size > MAX_BINARY_BYTES)
        throw sizeError();
    }
    return size;
  }

  function utf8Encode(value) {
    const text = String(value);
    const bytes = new Uint8Array(utf8Length(text));
    let offset = 0;
    for (let index = 0; index < text.length; index++) {
      let code = text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        if (index + 1 < text.length) {
          const next = text.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
            index++;
          } else {
            code = 0xfffd;
          }
        } else {
          code = 0xfffd;
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        code = 0xfffd;
      }
      if (code < 0x80) {
        bytes[offset++] = code;
      } else if (code < 0x800) {
        bytes[offset++] = 0xc0 | (code >> 6);
        bytes[offset++] = 0x80 | (code & 0x3f);
      } else if (code < 0x10000) {
        bytes[offset++] = 0xe0 | (code >> 12);
        bytes[offset++] = 0x80 | ((code >> 6) & 0x3f);
        bytes[offset++] = 0x80 | (code & 0x3f);
      } else {
        bytes[offset++] = 0xf0 | (code >> 18);
        bytes[offset++] = 0x80 | ((code >> 12) & 0x3f);
        bytes[offset++] = 0x80 | ((code >> 6) & 0x3f);
        bytes[offset++] = 0x80 | (code & 0x3f);
      }
    }
    return bytes;
  }

  function utf8Decode(input) {
    const bytes = input || [];
    let result = '';
    for (let index = 0; index < bytes.length;) {
      const first = Number(bytes[index]) & 0xff;
      if (first < 0x80) {
        result += String.fromCharCode(first);
        index++;
        continue;
      }
      let count, code, minimum;
      if (first >= 0xc2 && first <= 0xdf) {
        count = 2; code = first & 0x1f; minimum = 0x80;
      } else if (first >= 0xe0 && first <= 0xef) {
        count = 3; code = first & 0x0f; minimum = 0x800;
      } else if (first >= 0xf0 && first <= 0xf4) {
        count = 4; code = first & 0x07; minimum = 0x10000;
      } else {
        result += '\ufffd';
        index++;
        continue;
      }
      if (index + count > bytes.length) {
        result += '\ufffd';
        index++;
        continue;
      }
      let valid = true;
      for (let offset = 1; offset < count; offset++) {
        const next = Number(bytes[index + offset]) & 0xff;
        if ((next & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        code = (code << 6) | (next & 0x3f);
      }
      if (!valid || code < minimum || code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)) {
        result += '\ufffd';
        index++;
        continue;
      }
      if (code <= 0xffff) {
        result += String.fromCharCode(code);
      } else {
        code -= 0x10000;
        result += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
      }
      index += count;
    }
    return result;
  }

  function copyBytes(value) {
    if (Array.isArray(value)) {
      checkSize(value.length);
      const result = new Uint8Array(value.length);
      for (let index = 0; index < value.length; index++)
        result[index] = Number(value[index]) & 0xff;
      return result;
    }
    const length = byteLength(value);
    if (length == null)
      throw new TypeError('Expected an ArrayBuffer or byte array.');
    checkSize(length);
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]')
      return new Uint8Array(value.slice(0));
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }

  function joinBytes(parts, size) {
    checkSize(size);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }

  function normalizeLineBreaks(value) {
    return String(value).replace(/\r\n|\r|\n/g, '\r\n');
  }

  function normalizeType(value) {
    const result = String(value == null ? '' : value);
    if (/[\x00-\x1f\x7f-\uffff]/.test(result))
      return '';
    return result.toLowerCase();
  }

  function normalizeLastModified(value) {
    if (value == null)
      return Date.now();
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : Date.now();
  }

  function contentError(state) {
    if (state.contentError)
      throw new TypeError(state.contentError);
  }

  function blobState(blob) {
    const state = blobStates.get(blob);
    if (!state)
      throw new TypeError('Illegal invocation.');
    return state;
  }

  function fileState(file) {
    const state = fileStates.get(file);
    if (!state)
      throw new TypeError('Illegal invocation.');
    return state;
  }

  function buildBlob(parts, type, endings) {
    if (endings !== 'transparent' && endings !== 'native')
      throw new TypeError('Blob endings must be transparent or native.');
    const chunks = [];
    let size = 0;
    for (const part of parts) {
      if (chunks.length >= MAX_FORM_ENTRIES)
        throw new RangeError('Blob cannot contain more than 10000 parts.');
      let bytes;
      const state = part != null && blobStates.get(part);
      if (state) {
        contentError(state);
        bytes = state.bytes;
      } else if (part != null && byteLength(part) != null) {
        bytes = copyBytes(part);
      } else {
        const text = endings === 'native'
          ? String(part).replace(/\r\n|\r|\n/g, '\n')
          : String(part);
        bytes = utf8Encode(text);
      }
      size = checkSize(size + bytes.length);
      chunks.push(bytes);
    }
    return {
      bytes: joinBytes(chunks, size),
      type: normalizeType(type),
      contentError: null,
      declaredSize: size
    };
  }

  class Blob {
    constructor(parts, options) {
      const values = parts === undefined ? [] : parts;
      if (typeof values === 'string' || values == null ||
          typeof values[Symbol.iterator] !== 'function')
        throw new TypeError('Blob parts must be an iterable object.');
      const init = options == null ? {} : Object(options);
      blobStates.set(this, buildBlob(values, init.type, init.endings || 'transparent'));
    }

    get size() { return blobState(this).declaredSize; }
    get type() { return blobState(this).type; }

    slice(start, end, contentType) {
      const state = blobState(this);
      contentError(state);
      const size = state.bytes.length;
      const relative = value => {
        if (value === undefined) return size;
        const number = Number(value);
        if (Number.isNaN(number)) return 0;
        if (!Number.isFinite(number)) return number < 0 ? 0 : size;
        const integer = Math.trunc(number);
        return integer < 0 ? Math.max(size + integer, 0) : Math.min(integer, size);
      };
      const first = start === undefined ? 0 : relative(start);
      const last = end === undefined ? size : relative(end);
      const bytes = state.bytes.slice(first, Math.max(last, first));
      return makeBlob(bytes, normalizeType(contentType));
    }

    async arrayBuffer() {
      return getBytes(this).buffer;
    }

    async bytes() {
      return getBytes(this);
    }

    async text() {
      return utf8Decode(getBytes(this));
    }

    get [Symbol.toStringTag]() { return 'Blob'; }
  }

  class File extends Blob {
    constructor(fileBits, fileName, options) {
      if (arguments.length < 2)
        throw new TypeError('File name is required.');
      const init = options == null ? {} : Object(options);
      super(fileBits, { type: init.type, endings: init.endings || 'transparent' });
      fileStates.set(this, {
        name: String(fileName),
        lastModified: normalizeLastModified(init.lastModified)
      });
    }

    get name() { return fileState(this).name; }
    get lastModified() { return fileState(this).lastModified; }
    get [Symbol.toStringTag]() { return 'File'; }
  }

  function makeBlob(bytes, type) {
    const blob = Object.create(Blob.prototype);
    blobStates.set(blob, {
      bytes: copyBytes(bytes),
      type: normalizeType(type),
      contentError: null,
      declaredSize: bytes.length
    });
    return blob;
  }

  function makeFile(name, type, lastModified, bytes, error, declaredSize) {
    const file = Object.create(File.prototype);
    const data = bytes == null ? null : bytes;
    blobStates.set(file, {
      bytes: data,
      type: normalizeType(type),
      contentError: error == null ? null : String(error),
      declaredSize: declaredSize == null ? data.length : declaredSize
    });
    fileStates.set(file, {
      name: String(name),
      lastModified: normalizeLastModified(lastModified)
    });
    return file;
  }

  function getBytes(blob) {
    const state = blobState(blob);
    contentError(state);
    checkSize(state.bytes.length);
    return state.bytes.slice();
  }

  function bytesFromBase64(value) {
    const text = String(value).replace(/[\t\n\f\r ]/g, '');
    if (text.length > Math.ceil(MAX_BINARY_BYTES / 3) * 4 + 4)
      throw sizeError();
    const firstPadding = text.indexOf('=');
    const dataLength = firstPadding === -1 ? text.length : firstPadding;
    const padding = text.length - dataLength;
    if (padding > 2 || (firstPadding !== -1 && !/^={1,2}$/.test(text.slice(firstPadding))) ||
        (padding > 0 && text.length % 4 !== 0) ||
        (padding === 1 && dataLength % 4 !== 3) ||
        (padding === 2 && dataLength % 4 !== 2) ||
        (padding === 0 && dataLength % 4 === 1)) {
      throw new TypeError('Selected file data is invalid base64.');
    }
    const size = Math.floor(dataLength * 6 / 8);
    checkSize(size);
    const result = new Uint8Array(size);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let buffer = 0, bits = 0, offset = 0;
    for (let index = 0; index < dataLength; index++) {
      const digit = alphabet.indexOf(text.charAt(index));
      if (digit < 0)
        throw new TypeError('Selected file data is invalid base64.');
      buffer = (buffer << 6) | digit;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        result[offset++] = (buffer >> bits) & 0xff;
      }
    }
    return result;
  }

  function bytesToBase64(bytes) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const chunks = [];
    const charCodes = new Uint8Array(8192);
    let charOffset = 0;
    function flush() {
      chunks.push(String.fromCharCode.apply(null, charCodes.subarray(0, charOffset)));
      charOffset = 0;
    }
    for (let index = 0; index < bytes.length; index += 3) {
      const first = Number(bytes[index]) & 0xff;
      const hasSecond = index + 1 < bytes.length;
      const hasThird = index + 2 < bytes.length;
      const second = hasSecond ? Number(bytes[index + 1]) & 0xff : 0;
      const third = hasThird ? Number(bytes[index + 2]) & 0xff : 0;
      charCodes[charOffset++] = alphabet.charCodeAt(first >> 2);
      charCodes[charOffset++] = alphabet.charCodeAt(((first & 0x03) << 4) | (second >> 4));
      charCodes[charOffset++] = hasSecond
        ? alphabet.charCodeAt(((second & 0x0f) << 2) | (third >> 6))
        : 61;
      charCodes[charOffset++] = hasThird ? alphabet.charCodeAt(third & 0x3f) : 61;
      if (charOffset === charCodes.length)
        flush();
    }
    if (charOffset > 0)
      flush();
    return chunks.join('');
  }

  function copyNativeReference(reference) {
    if (reference == null)
      return null;
    if (typeof reference !== 'object')
      throw new TypeError('Invalid native file reference.');
    const controlId = reference.controlId;
    const resetVersion = reference.resetVersion;
    const index = reference.index;
    if (typeof controlId !== 'string' ||
        !(typeof resetVersion === 'string' ||
          (typeof resetVersion === 'number' && Number.isFinite(resetVersion))) ||
        !Number.isSafeInteger(index) || index < 0) {
      throw new TypeError('Invalid native file reference.');
    }
    return { controlId, resetVersion, index };
  }

  function makeHostFile(name, type, lastModified, bytes, error, declaredSize, nativeReference) {
    const file = makeFile(name, type, lastModified, bytes, error, declaredSize);
    const reference = copyNativeReference(nativeReference);
    if (reference != null) {
      const blob = blobState(file);
      const data = fileState(file);
      nativeFileStates.set(file, {
        reference,
        originalMetadata: {
          name: data.name,
          type: blob.type,
          lastModified: data.lastModified
        }
      });
    }
    return file;
  }

  function fileFromHost(metadata, nativeReference) {
    const item = metadata == null ? {} : Object(metadata);
    const sizeValue = Number(item.size);
    const declaredSize = Number.isFinite(sizeValue) && sizeValue >= 0
      ? Math.trunc(sizeValue)
      : 0;
    const name = item.name == null ? '' : String(item.name);
    const type = item.type == null ? '' : String(item.type);
    const lastModified = normalizeLastModified(item.lastModified);
    if (item.contentError != null && item.contentError !== false) {
      const message = item.contentError === true
        ? 'Selected file contents are unavailable.'
        : String(item.contentError);
      return makeHostFile(name, type, lastModified, null, message, declaredSize, nativeReference);
    }
    if (item.bytesBase64 == null) {
      if (declaredSize === 0)
        return makeHostFile(name, type, lastModified, new Uint8Array(0), null, 0, nativeReference);
      return makeHostFile(
        name, type, lastModified, null,
        'Selected file contents are unavailable in this runtime.', declaredSize,
        nativeReference
      );
    }
    try {
      const bytes = bytesFromBase64(item.bytesBase64);
      if (bytes.length !== declaredSize) {
        return makeHostFile(
          name, type, lastModified, null,
          'Selected file data size does not match its metadata.', declaredSize,
          nativeReference
        );
      }
      return makeHostFile(name, type, lastModified, bytes, null, bytes.length, nativeReference);
    } catch (error) {
      return makeHostFile(name, type, lastModified, null, String(error), declaredSize, nativeReference);
    }
  }

  function fileForForm(blob, filename) {
    const state = blobState(blob);
    const isFile = fileStates.has(blob);
    if (isFile && filename === undefined)
      return blob;
    const name = filename === undefined
      ? isFile ? fileState(blob).name : 'blob'
      : String(filename);
    const modified = isFile ? fileState(blob).lastModified : Date.now();
    const file = makeFile(name, state.type, modified, state.bytes, state.contentError, state.declaredSize);
    const hostState = nativeFileStates.get(blob);
    if (hostState) {
      nativeFileStates.set(file, {
        reference: copyNativeReference(hostState.reference),
        originalMetadata: {
          name: hostState.originalMetadata.name,
          type: hostState.originalMetadata.type,
          lastModified: hostState.originalMetadata.lastModified
        }
      });
    }
    return file;
  }

  function submissionFile(file) {
    if (!fileStates.has(file))
      throw new TypeError('Expected a File.');
    const data = fileState(file);
    const blob = blobState(file);
    const nativeState = nativeFileStates.get(file);
    if (nativeState) {
      const reference = copyNativeReference(nativeState.reference);
      const original = nativeState.originalMetadata;
      if (data.name !== original.name)
        reference.name = data.name;
      if (blob.type !== original.type)
        reference.type = blob.type;
      if (data.lastModified !== original.lastModified)
        reference.lastModified = data.lastModified;
      return { file: reference, byteLength: 0 };
    }
    if (data.name === '' && blob.type === 'application/octet-stream' &&
        blob.declaredSize === 0) {
      return { file: null, byteLength: 0 };
    }
    const bytes = getBytes(file);
    return {
      inlineFile: {
        name: data.name,
        type: blob.type,
        lastModified: data.lastModified,
        bytesBase64: bytesToBase64(bytes)
      },
      byteLength: bytes.length
    };
  }

  function entryValue(value, filename) {
    if (blobStates.has(value))
      return fileForForm(value, filename);
    if (filename !== undefined)
      throw new TypeError('A filename can only be provided for a Blob value.');
    return String(value);
  }

  function formState(form) {
    const state = formStates.get(form);
    if (!state)
      throw new TypeError('Illegal invocation.');
    return state;
  }

  class FormData {
    constructor(form, submitter) {
      const state = { entries: [] };
      formStates.set(this, state);
      if (form !== undefined) {
        if (typeof deps.entriesForForm !== 'function')
          throw new TypeError('FormData(form) is unavailable without a DOM form runtime.');
        const entries = deps.entriesForForm(form, submitter);
        if (entries == null || typeof entries[Symbol.iterator] !== 'function')
          throw new TypeError('The form runtime returned invalid FormData entries.');
        for (const pair of entries) {
          if (pair == null || typeof pair.length !== 'number' || pair.length !== 2)
            throw new TypeError('Each FormData entry must contain a name and value.');
          this.append(pair[0], pair[1]);
        }
        if (typeof deps.formDataCreated === 'function')
          deps.formDataCreated(form, this);
      }
    }

    append(name, value, filename) {
      if (arguments.length < 2)
        throw new TypeError('FormData.append requires a name and value.');
      const state = formState(this);
      if (state.entries.length >= MAX_FORM_ENTRIES)
        throw new RangeError('FormData cannot contain more than 10000 entries.');
      const entry = { name: String(name), value: entryValue(value, filename) };
      state.entries.push(entry);
    }

    delete(name) {
      const key = String(name);
      const state = formState(this);
      state.entries = state.entries.filter(entry => entry.name !== key);
    }

    get(name) {
      const key = String(name);
      const entry = formState(this).entries.find(item => item.name === key);
      return entry ? entry.value : null;
    }

    getAll(name) {
      const key = String(name);
      return formState(this).entries
        .filter(entry => entry.name === key)
        .map(entry => entry.value);
    }

    has(name) {
      const key = String(name);
      return formState(this).entries.some(entry => entry.name === key);
    }

    set(name, value, filename) {
      if (arguments.length < 2)
        throw new TypeError('FormData.set requires a name and value.');
      const key = String(name);
      const state = formState(this);
      const entry = { name: key, value: entryValue(value, filename) };
      const first = state.entries.findIndex(item => item.name === key);
      const next = state.entries.filter(item => item.name !== key);
      next.splice(first < 0 ? next.length : first, 0, entry);
      if (next.length > MAX_FORM_ENTRIES)
        throw new RangeError('FormData cannot contain more than 10000 entries.');
      state.entries = next;
    }

    entries() {
      return formState(this).entries.map(entry => [entry.name, entry.value])[Symbol.iterator]();
    }

    keys() {
      return formState(this).entries.map(entry => entry.name)[Symbol.iterator]();
    }

    values() {
      return formState(this).entries.map(entry => entry.value)[Symbol.iterator]();
    }

    forEach(callback, thisArg) {
      if (typeof callback !== 'function')
        throw new TypeError('FormData.forEach requires a callback.');
      for (const entry of formState(this).entries.slice())
        callback.call(thisArg, entry.value, entry.name, this);
    }

    [Symbol.iterator]() { return this.entries(); }
    get [Symbol.toStringTag]() { return 'FormData'; }
  }

  function concat(parts) {
    let size = 0;
    for (const part of parts)
      size = checkSize(size + part.length);
    return joinBytes(parts, size);
  }

  function containsBytes(haystack, needle) {
    if (needle.length === 0) return true;
    outer: for (let index = 0; index <= haystack.length - needle.length; index++) {
      for (let offset = 0; offset < needle.length; offset++) {
        if (haystack[index + offset] !== needle[offset])
          continue outer;
      }
      return true;
    }
    return false;
  }

  function multipartBoundary(entries) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const random = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
      const boundary = '----PircFormBoundary' + (nextBoundaryId++).toString(36) + random;
      const token = utf8Encode(boundary);
      let collision = false;
      for (const entry of entries) {
        const value = entry.value;
        const bytes = blobStates.has(value)
          ? (contentError(blobState(value)), blobState(value).bytes)
          : utf8Encode(normalizeLineBreaks(value));
        if (containsBytes(bytes, token)) {
          collision = true;
          break;
        }
      }
      if (!collision) return boundary;
    }
    throw new TypeError('Could not create a safe multipart boundary.');
  }

  function dispositionParameter(value) {
    return normalizeLineBreaks(value)
      .replace(/\\/g, '%5C')
      .replace(/"/g, '%22')
      .replace(/\r/g, '%0D')
      .replace(/\n/g, '%0A');
  }

  function encodeFormData(form) {
    const entries = formState(form).entries.slice();
    const boundary = multipartBoundary(entries);
    const chunks = [];
    let size = 0;
    function push(chunk) {
      size = checkSize(size + chunk.length);
      chunks.push(chunk);
    }
    for (const entry of entries) {
      const value = entry.value;
      let header = '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="' + dispositionParameter(entry.name) + '"';
      let body;
      if (blobStates.has(value)) {
        const state = blobState(value);
        contentError(state);
        const file = fileStates.has(value) ? fileState(value) : { name: 'blob' };
        header += '; filename="' + dispositionParameter(file.name) + '"\r\n' +
          'Content-Type: ' + (state.type || 'application/octet-stream');
        body = state.bytes;
      } else {
        body = null;
      }
      push(utf8Encode(header + '\r\n\r\n'));
      if (body == null)
        body = utf8Encode(normalizeLineBreaks(value));
      push(body);
      push(utf8Encode('\r\n'));
    }
    push(utf8Encode('--' + boundary + '--\r\n'));
    return {
      bytes: joinBytes(chunks, size),
      contentType: 'multipart/form-data; boundary=' + boundary
    };
  }

  function encodeBody(body) {
    const state = body != null && blobStates.get(body);
    if (state) {
      contentError(state);
      return {
        bytes: getBytes(body),
        contentType: state.type || null
      };
    }
    if (body != null && formStates.has(body))
      return encodeFormData(body);
    return null;
  }

  function findBytes(bytes, needle, start) {
    outer: for (let index = start || 0; index <= bytes.length - needle.length; index++) {
      for (let offset = 0; offset < needle.length; offset++) {
        if (bytes[index + offset] !== needle[offset])
          continue outer;
      }
      return index;
    }
    return -1;
  }

  function parseHeaderParameters(value) {
    const pieces = [];
    let current = '', quoted = false, escaped = false;
    for (const character of String(value)) {
      if (escaped) {
        current += character;
        escaped = false;
      } else if (quoted && character === '\\') {
        current += character;
        escaped = true;
      } else if (character === '"') {
        current += character;
        quoted = !quoted;
      } else if (character === ';' && !quoted) {
        pieces.push(current.trim());
        current = '';
      } else {
        current += character;
      }
    }
    pieces.push(current.trim());
    const parameters = new Map();
    for (const piece of pieces.slice(1)) {
      const split = piece.indexOf('=');
      if (split < 0) continue;
      let parameter = piece.slice(split + 1).trim();
      if (parameter.startsWith('"') && parameter.endsWith('"')) {
        parameter = parameter.slice(1, -1).replace(/\\([\\"])/g, '$1');
      }
      parameters.set(piece.slice(0, split).trim().toLowerCase(), parameter);
    }
    return { kind: (pieces[0] || '').toLowerCase(), parameters };
  }

  function decodePercentHeader(value) {
    return percentDecode(value, false);
  }

  function percentDecode(value, plusAsSpace) {
    let size = 0;
    for (let index = 0; index < value.length;) {
      const character = value.charAt(index);
      if (character === '%' && /^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
        size++;
        index += 3;
      } else if (character === '+' && plusAsSpace) {
        size++;
        index++;
      } else {
        const end = index + (value.codePointAt(index) > 0xffff ? 2 : 1);
        size = checkSize(size + utf8Length(value.slice(index, end)));
        index = end;
      }
      if (size > MAX_BINARY_BYTES)
        throw sizeError();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (let index = 0; index < value.length;) {
      const character = value.charAt(index);
      if (character === '%' && /^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
        bytes[offset++] = parseInt(value.slice(index + 1, index + 3), 16);
        index += 3;
      } else if (character === '+' && plusAsSpace) {
        bytes[offset++] = 0x20;
        index++;
      } else {
        const end = index + (value.codePointAt(index) > 0xffff ? 2 : 1);
        const encoded = utf8Encode(value.slice(index, end));
        bytes.set(encoded, offset);
        offset += encoded.length;
        index = end;
      }
    }
    return utf8Decode(bytes);
  }

  function decodeFormComponent(value) {
    return percentDecode(value, true);
  }

  function parseUrlEncoded(bytes) {
    let text = '';
    for (let index = 0; index < bytes.length; index += 8192)
      text += String.fromCharCode(...bytes.subarray(index, Math.min(index + 8192, bytes.length)));
    const result = new FormData();
    if (text === '') return result;
    let start = 0, count = 0;
    for (let index = 0; index <= text.length; index++) {
      if (index !== text.length && text.charCodeAt(index) !== 38)
        continue;
      if (++count > MAX_FORM_ENTRIES)
        throw new RangeError('URL-encoded form data has too many entries.');
      const pair = text.slice(start, index);
      const equals = pair.indexOf('=');
      result.append(
        decodeFormComponent(equals < 0 ? pair : pair.slice(0, equals)),
        decodeFormComponent(equals < 0 ? '' : pair.slice(equals + 1))
      );
      start = index + 1;
    }
    return result;
  }

  function parseMultipart(bytes, contentType) {
    const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    const boundary = match && (match[1] || match[2]);
    if (!boundary || boundary.length > 70 || /[^\x21-\x7e]/.test(boundary))
      throw new TypeError('Multipart form data has an invalid boundary.');
    const delimiter = utf8Encode('--' + boundary);
    const headerSeparator = new Uint8Array([13, 10, 13, 10]);
    const lineBreak = new Uint8Array([13, 10]);
    const result = new FormData();
    let cursor = 0, entryCount = 0;
    if (findBytes(bytes, delimiter, 0) !== 0)
      throw new TypeError('Multipart form data has an invalid opening boundary.');
    cursor = delimiter.length;
    if (bytes[cursor] === 45 && bytes[cursor + 1] === 45)
      return result;
    if (bytes[cursor] !== 13 || bytes[cursor + 1] !== 10)
      throw new TypeError('Multipart form data has an invalid boundary line.');
    cursor += 2;

    while (cursor <= bytes.length) {
      if (++entryCount > MAX_FORM_ENTRIES)
        throw new RangeError('Multipart form data has too many entries.');
      const headerEnd = findBytes(bytes, headerSeparator, cursor);
      if (headerEnd < 0 || headerEnd - cursor > 65536)
        throw new TypeError('Multipart form data has invalid part headers.');
      const headers = utf8Decode(bytes.subarray(cursor, headerEnd));
      const bodyStart = headerEnd + headerSeparator.length;
      const marker = concat([lineBreak, delimiter]);
      let boundaryAt = findBytes(bytes, marker, bodyStart);
      while (boundaryAt >= 0) {
        const suffix = boundaryAt + marker.length;
        if ((bytes[suffix] === 13 && bytes[suffix + 1] === 10) ||
            (bytes[suffix] === 45 && bytes[suffix + 1] === 45))
          break;
        boundaryAt = findBytes(bytes, marker, boundaryAt + 1);
      }
      if (boundaryAt < 0)
        throw new TypeError('Multipart form data is missing its closing boundary.');
      const partBytes = bytes.subarray(bodyStart, boundaryAt);
      const headerMap = new Map();
      for (const line of headers.split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon > 0)
          headerMap.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      const disposition = parseHeaderParameters(headerMap.get('content-disposition') || '');
      if (disposition.kind !== 'form-data' || !disposition.parameters.has('name'))
        throw new TypeError('Multipart form data has a part without a field name.');
      const name = decodePercentHeader(disposition.parameters.get('name'));
      let filename = disposition.parameters.get('filename');
      const encodedFilename = disposition.parameters.get('filename*');
      if (encodedFilename) {
        const encoded = /^[^']*''(.*)$/.exec(encodedFilename);
        if (encoded) filename = decodePercentHeader(encoded[1]);
      }
      if (filename !== undefined) {
        result.append(name, new File([partBytes], decodePercentHeader(filename), {
          type: headerMap.get('content-type') || ''
        }));
      } else {
        result.append(name, utf8Decode(partBytes));
      }
      cursor = boundaryAt + marker.length;
      if (bytes[cursor] === 45 && bytes[cursor + 1] === 45) {
        cursor += 2;
        if (bytes[cursor] === 13 && bytes[cursor + 1] === 10)
          cursor += 2;
        if (cursor !== bytes.length)
          throw new TypeError('Multipart form data contains data after its closing boundary.');
        return result;
      }
      if (bytes[cursor] !== 13 || bytes[cursor + 1] !== 10)
        throw new TypeError('Multipart form data has an invalid part separator.');
      cursor += 2;
    }
    throw new TypeError('Multipart form data is incomplete.');
  }

  function parseFormData(input, contentType) {
    const bytes = copyBytes(input);
    const type = String(contentType == null ? '' : contentType).trim();
    if (bytes.length > MAX_BINARY_BYTES)
      throw sizeError();
    if (/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(type))
      return parseUrlEncoded(bytes);
    if (/^multipart\/form-data(?:\s*;|$)/i.test(type))
      return parseMultipart(bytes, type);
    throw new TypeError('Response body is not supported form data.');
  }

  return { Blob, File, FormData, encodeBody, parseFormData, getBytes, fileFromHost, submissionFile,
    bytesToBase64, blobMetadata: function(blob) {
      const data = blobState(blob);
      return {size:data.declaredSize,type:data.type};
    }
  };
}
