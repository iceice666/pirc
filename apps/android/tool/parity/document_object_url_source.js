function createDocumentObjectUrls(options) {
  'use strict';

  const deps = options || {};
  const binary = deps.binary;
  const URLCtor = typeof deps.URL === 'function'
    ? deps.URL
    : (typeof URL === 'function' ? URL : null);
  const baseUrl = deps.baseUrl;
  const nonce = deps.nonce == null ? '' : String(deps.nonce);
  const MAX_OBJECT_URL_BYTES = 2 * 1024 * 1024;
  const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
  const MAX_REGISTRY_ENTRIES = 128;
  const registry = new Map();
  let registryBytes = 0;
  let nextId = 0;

  function toUrlString(value) {
    try {
      return String(value);
    } catch (error) {
      return '';
    }
  }

  function stripFragment(value) {
    const text = toUrlString(value);
    const hash = text.indexOf('#');
    return hash < 0 ? text : text.slice(0, hash);
  }

  function originForDocument() {
    if (!URLCtor) throw new TypeError('Object URLs are unavailable.');
    let value = typeof baseUrl === 'function' ? baseUrl() : baseUrl;
    value = String(value == null ? '' : value);
    try {
      return new URLCtor(value).origin || 'null';
    } catch (error) {
      throw new TypeError('Object URL base URL is invalid.');
    }
  }

  function requireNonce() {
    if (!nonce) throw new TypeError('Object URL nonce is unavailable.');
  }

  function createObjectURL(blob) {
    requireNonce();
    if (!binary || typeof binary.blobMetadata !== 'function' ||
        typeof binary.getBytes !== 'function' ||
        typeof binary.bytesToBase64 !== 'function') {
      throw new TypeError('Blob object URLs are unavailable.');
    }

    // blobMetadata is the private brand check; never inspect public Blob fields.
    const metadata = binary.blobMetadata(blob);
    const declaredSize = Number(metadata && metadata.size);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      throw new TypeError('Blob metadata is invalid.');
    }
    if (declaredSize > MAX_OBJECT_URL_BYTES) {
      throw new RangeError('Object URL blobs cannot exceed 2 MiB.');
    }
    if (registry.size >= MAX_REGISTRY_ENTRIES) {
      throw new RangeError('The document object URL registry is full.');
    }
    if (registryBytes + declaredSize > MAX_REGISTRY_BYTES) {
      throw new RangeError('The document object URL registry exceeds 16 MiB.');
    }

    const bytes = binary.getBytes(blob);
    if (!bytes || typeof bytes.byteLength !== 'number' ||
        bytes.byteLength !== declaredSize) {
      throw new TypeError('Blob bytes do not match their metadata.');
    }
    const snapshot = new Uint8Array(
      bytes.buffer, bytes.byteOffset, bytes.byteLength
    ).slice();
    const origin = originForDocument();
    const id = encodeURIComponent(nonce) + '-' +
      (nextId++).toString(16).padStart(12, '0');
    const url = 'blob:' + origin + '/' + id;
    const entry = {
      url,
      type: String(metadata.type == null ? '' : metadata.type),
      size: snapshot.byteLength,
      bytes: snapshot
    };
    registry.set(url, entry);
    registryBytes += entry.size;
    return url;
  }

  function revokeObjectURL(url) {
    const key = toUrlString(url);
    const entry = registry.get(key);
    if (!entry) return;
    registry.delete(key);
    registryBytes -= entry.size;
  }

  function lookup(url) {
    const text = toUrlString(url);
    if (!/^blob:/i.test(text)) return { isBlob: false, entry: null };
    // A blob URL fragment is client-side state and does not identify another Blob.
    const key = stripFragment(text);
    return { isBlob: true, entry: registry.get(key) || null };
  }

  function read(url) {
    const result = lookup(url);
    if (!result.entry) throw new TypeError('The object URL is unavailable.');
    const entry = result.entry;
    return {
      url: entry.url,
      type: entry.type,
      size: entry.size,
      bytesBase64: binary.bytesToBase64(entry.bytes)
    };
  }

  function headerValues(headers, requestedName) {
    const name = requestedName.toLowerCase();
    if (headers == null) return [];
    if (typeof headers.get === 'function') {
      const value = headers.get(name);
      return value == null ? [] : [String(value)];
    }
    const values = [];
    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (Array.isArray(pair) && String(pair[0]).toLowerCase() === name) {
          values.push(String(pair[1]));
        }
      }
      return values;
    }
    if (typeof headers === 'object') {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name) {
          const value = headers[key];
          if (Array.isArray(value)) {
            for (const item of value) values.push(String(item));
          } else {
            values.push(String(value));
          }
        }
      }
    }
    return values;
  }

  function failedFetch() {
    return { ok: false, error: 'Failed to fetch.' };
  }

  function rangeFor(entry, headers) {
    const values = headerValues(headers, 'range');
    if (values.length === 0) return { kind: 'none' };
    const value = values.join(',');
    const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
    if (!match || (!match[1] && !match[2])) return { kind: 'invalid' };
    if (entry.size === 0) return { kind: 'unsatisfiable' };

    let start;
    let end;
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        return { kind: 'unsatisfiable' };
      }
      start = Math.max(0, entry.size - suffixLength);
      end = entry.size - 1;
    } else {
      start = Number(match[1]);
      if (!Number.isSafeInteger(start) || start >= entry.size) {
        return { kind: 'unsatisfiable' };
      }
      if (!match[2]) {
        end = entry.size - 1;
      } else {
        end = Number(match[2]);
        if (!Number.isSafeInteger(end) || end < start) {
          return { kind: 'unsatisfiable' };
        }
        end = Math.min(end, entry.size - 1);
      }
    }
    return { kind: 'range', start, end };
  }

  function resolveFetch(url, method, headers) {
    const match = lookup(url);
    if (!match.isBlob) return null;
    const entry = match.entry;
    if (!entry) return failedFetch();
    if (String(method == null ? 'GET' : method).toUpperCase() !== 'GET') {
      return failedFetch();
    }

    const range = rangeFor(entry, headers);
    if (range.kind === 'unsatisfiable' || range.kind === 'invalid') return failedFetch();
    const isRange = range.kind === 'range';
    const bodyBytes = isRange
      ? entry.bytes.slice(range.start, range.end + 1)
      : entry.bytes.slice();
    const responseHeaders = [];
    if (entry.type) responseHeaders.push(['content-type', entry.type]);
    responseHeaders.push(['content-length', String(bodyBytes.length)]);
    const status = isRange ? 206 : 200;
    if (isRange) {
      responseHeaders.push([
        'content-range',
        'bytes ' + range.start + '-' + range.end + '/' + entry.size
      ]);
    }
    return {
      ok: true,
      url: entry.url,
      status,
      statusText: 'OK',
      headers: responseHeaders,
      bodyBytes
    };
  }

  return { createObjectURL, revokeObjectURL, read, resolveFetch };
}
