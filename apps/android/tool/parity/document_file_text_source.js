function createDocumentFileText(deps) {
  'use strict';
  deps = deps || {};

  const MAX_BYTES = 2 * 1024 * 1024;
  const WINDOWS_1252_SPECIAL = new Map([
    [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e],
    [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6],
    [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152],
    [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c],
    [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
    [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a],
    [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178],
  ]);

  const unsupportedLabels = new Set([
    'big5', 'big5-hkscs', 'cn-big5', 'csbig5', 'x-x-big5',
    'euc-jp', 'x-euc-jp', 'csiso2022jp', 'iso-2022-jp', 'shift_jis',
    'shift-jis', 'sjis', 'ms_kanji', 'csshiftjis', 'windows-31j',
    'x-sjis', 'euc-kr', 'ks_c_5601-1987', 'ks_c_5601-1989', 'korean',
    'iso-ir-149', 'csksc56011987', 'ksc5601', 'windows-949', 'gb2312',
    'chinese', 'csgb2312', 'csiso58gb231280', 'gbk', 'gb_2312',
    'gb18030', 'x-gbk', 'iso-8859-2', 'iso-ir-101', 'latin2',
    'l2', 'csisolatin2', 'iso-8859-3', 'iso-ir-109', 'latin3',
    'l3', 'csisolatin3', 'iso-8859-4', 'iso-ir-110', 'latin4',
    'l4', 'csisolatin4', 'iso-8859-5', 'iso-ir-144', 'cyrillic',
    'csisolatincyrillic', 'iso-8859-6', 'iso-ir-127', 'ecma-114', 'asmo-708',
    'arabic', 'csiso88596e', 'csiso88596i', 'iso-8859-6-e', 'iso-8859-6-i',
    'iso-8859-7', 'iso-ir-126', 'elot_928', 'greek', 'greek8',
    'sun_eu_greek', 'iso-8859-8', 'iso-ir-138', 'hebrew', 'csiso88598e',
    'iso-8859-8-e', 'visual', 'csiso88598i', 'iso-8859-8-i', 'iso-8859-10',
    'iso-ir-157', 'latin6', 'l6', 'csisolatin6', 'iso-8859-13',
    'iso-8859-14', 'iso-8859-15', 'iso-8859-16', 'koi8-r', 'cskoi8r',
    'koi8-u', 'macintosh', 'mac', 'csmacintosh', 'x-mac-roman',
    'x-mac-cyrillic', 'x-mac-ukrainian', 'ibm866', '866', 'cp866',
    'csibm866', 'iso-8859-11', 'tis-620', 'dos-874', 'windows-874',
    'cp1250', 'windows-1250', 'x-cp1250', 'cp1251', 'windows-1251',
    'x-cp1251', 'cp1253', 'windows-1253', 'x-cp1253', 'cp1254',
    'windows-1254', 'x-cp1254', 'cp1255', 'windows-1255', 'x-cp1255',
    'cp1256', 'windows-1256', 'x-cp1256', 'cp1257', 'windows-1257',
    'x-cp1257', 'cp1258', 'windows-1258', 'x-cp1258', 'cseuckr',
    'cseucpkdfmtjapanese', 'csisolatin5', 'csisolatin9', 'csisolatinhebrew', 'csisolatinarabic',
    'csisolatingreek', 'iso-ir-58', 'gb_2312-80', 'iso-ir-148', 'latin5',
    'l5', 'csisolatin9', 'iso8859-2', 'iso8859-3', 'iso8859-4',
    'iso8859-5', 'iso8859-6', 'iso8859-7', 'iso8859-8', 'iso8859-9',
    'iso8859-10', 'iso8859-11', 'iso8859-13', 'iso8859-14', 'iso8859-15',
    'iso88592', 'iso88593', 'iso88594', 'iso88595', 'iso88596',
    'iso88597', 'iso88598', 'iso88599', 'iso885910', 'iso885911',
    'iso885913', 'iso885914', 'iso885915', 'iso_8859-2', 'iso_8859-2:1987',
    'iso_8859-3', 'iso_8859-3:1988', 'iso_8859-4', 'iso_8859-4:1988', 'iso_8859-5',
    'iso_8859-5:1988', 'iso_8859-6', 'iso_8859-6:1987', 'iso_8859-7', 'iso_8859-7:1987',
    'iso_8859-8', 'iso_8859-8:1988', 'iso_8859-9', 'iso_8859-9:1989', 'iso_8859-15',
    'iso-ir-148', 'ecma-118', 'koi', 'koi8', 'koi8-ru',
    'koi8_r', 'ksc_5601', 'logical', 'ms932', 'x-user-defined',
  ]);

  function makeError(name, message) {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  function normalizedLabel(label) {
    return String(label == null ? '' : label)
      .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '')
      .toLowerCase();
  }

  function labelEncoding(label) {
    const key = normalizedLabel(label);
    if (deps.encodingLabels) {
      const canonical = Object.prototype.hasOwnProperty.call(deps.encodingLabels, key)
        ? deps.encodingLabels[key] : 'utf-8';
      if (['utf-8', 'utf-16le', 'utf-16be', 'windows-1252', 'big5'].includes(canonical))
        return canonical;
      throw makeError('NotSupportedError', 'The requested text encoding is not supported.');
    }
    if (key === '' || key === 'utf-8' || key === 'utf8' ||
        key === 'unicode-1-1-utf-8') {
      return 'utf-8';
    }
    if (key === 'utf-16' || key === 'utf-16le' || key === 'unicode' ||
        key === 'ucs-2' || key === 'iso-10646-ucs-2') {
      return 'utf-16le';
    }
    if (key === 'utf-16be' || key === 'unicodefffe') return 'utf-16be';

    if (key === 'windows-1252' || key === 'cp1252' || key === 'x-cp1252' ||
        key === 'iso-8859-1' || key === 'iso8859-1' || key === 'iso88591' ||
        key === 'iso-ir-100' || key === 'latin1' ||
        key === 'l1' || key === 'ibm819' || key === 'cp819' ||
        key === 'us-ascii' || key === 'ascii' ||
        key === 'ansi_x3.4-1968') {
      return 'windows-1252';
    }
    if (unsupportedLabels.has(key)) {
      throw makeError('NotSupportedError', 'The requested text encoding is not supported.');
    }
    // File API decodes an unknown encoding as UTF-8.
    return 'utf-8';
  }

  function bytesView(input) {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof SharedArrayBuffer !== 'undefined' && input instanceof SharedArrayBuffer) {
      return new Uint8Array(input);
    }
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (Array.isArray(input)) {
      if (input.length > MAX_BYTES) throw new RangeError('Text input exceeds 2 MiB.');
      return Uint8Array.from(input);
    }
    throw new TypeError('Text input must be a byte buffer or byte array.');
  }


  function decodeUtf8Strict(bytes) {
    let output = '';
    let chunk = [];
    function write(codePoint) {
      if (codePoint <= 0xffff) {
        chunk.push(codePoint);
      } else {
        const value = codePoint - 0x10000;
        chunk.push(0xd800 + (value >> 10), 0xdc00 + (value & 0x3ff));
      }
      if (chunk.length >= 8192) {
        output += String.fromCharCode(...chunk);
        chunk = [];
      }
    }
    function flush() {
      if (chunk.length) output += String.fromCharCode(...chunk);
      chunk = [];
    }

    for (let i = 0; i < bytes.length;) {
      const first = bytes[i];
      if (first <= 0x7f) {
        write(first);
        i += 1;
        continue;
      }

      let expected = 0;
      let codePoint = 0;
      let firstLower = 0x80;
      let firstUpper = 0xbf;
      if (first >= 0xc2 && first <= 0xdf) {
        expected = 1;
        codePoint = first & 0x1f;
      } else if (first >= 0xe0 && first <= 0xef) {
        expected = 2;
        codePoint = first & 0x0f;
        if (first === 0xe0) firstLower = 0xa0;
        if (first === 0xed) firstUpper = 0x9f;
      } else if (first >= 0xf0 && first <= 0xf4) {
        expected = 3;
        codePoint = first & 0x07;
        if (first === 0xf0) firstLower = 0x90;
        if (first === 0xf4) firstUpper = 0x8f;
      } else {
        write(0xfffd);
        i += 1;
        continue;
      }

      let consumed = 0;
      let valid = true;
      while (consumed < expected) {
        const nextIndex = i + consumed + 1;
        if (nextIndex >= bytes.length) {
          // A truncated valid prefix is one maximal subpart.
          write(0xfffd);
          i += consumed + 1;
          valid = false;
          break;
        }
        const next = bytes[nextIndex];
        const lower = consumed === 0 ? firstLower : 0x80;
        const upper = consumed === 0 ? firstUpper : 0xbf;
        if (next < lower || next > upper) {
          // Do not consume the byte which broke the sequence; it may start
          // another character (or its own replacement).
          write(0xfffd);
          i += consumed + 1;
          valid = false;
          break;
        }
        codePoint = (codePoint << 6) | (next & 0x3f);
        consumed += 1;
      }
      if (valid) {
        write(codePoint);
        i += expected + 1;
      }
    }
    flush();
    return output;
  }

  function isValidUtf8(bytes) {
    for (let i = 0; i < bytes.length;) {
      const first = bytes[i];
      if (first <= 0x7f) {
        i += 1;
        continue;
      }
      let expected;
      let lower = 0x80;
      let upper = 0xbf;
      if (first >= 0xc2 && first <= 0xdf) {
        expected = 1;
      } else if (first >= 0xe0 && first <= 0xef) {
        expected = 2;
        if (first === 0xe0) lower = 0xa0;
        if (first === 0xed) upper = 0x9f;
      } else if (first >= 0xf0 && first <= 0xf4) {
        expected = 3;
        if (first === 0xf0) lower = 0x90;
        if (first === 0xf4) upper = 0x8f;
      } else {
        return false;
      }
      if (i + expected >= bytes.length) return false;
      for (let j = 1; j <= expected; j += 1) {
        const value = bytes[i + j];
        if (value < (j === 1 ? lower : 0x80) ||
            value > (j === 1 ? upper : 0xbf)) return false;
      }
      i += expected + 1;
    }
    return true;
  }

  function decodeUtf16(bytes, littleEndian) {
    let output = '';
    let chunk = [];
    function append(value) {
      chunk.push(value);
      if (chunk.length >= 8192) {
        output += String.fromCharCode(...chunk);
        chunk = [];
      }
    }
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const unit = littleEndian
        ? bytes[i] | (bytes[i + 1] << 8)
        : (bytes[i] << 8) | bytes[i + 1];
      if (unit >= 0xd800 && unit <= 0xdbff) {
        if (i + 3 < bytes.length) {
          const low = littleEndian
            ? bytes[i + 2] | (bytes[i + 3] << 8)
            : (bytes[i + 2] << 8) | bytes[i + 3];
          if (low >= 0xdc00 && low <= 0xdfff) {
            append(unit);
            append(low);
            i += 2;
            continue;
          }
        }
        append(0xfffd);
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        append(0xfffd);
      } else {
        append(unit);
      }
    }
    if (bytes.length % 2 !== 0) append(0xfffd);
    if (chunk.length) output += String.fromCharCode(...chunk);
    return output;
  }

  function decodeWindows1252(bytes) {
    let output = '';
    let chunk = [];
    for (const byte of bytes) {
      const point = byte >= 0x80 && byte <= 0x9f && WINDOWS_1252_SPECIAL.has(byte)
        ? WINDOWS_1252_SPECIAL.get(byte)
        : byte;
      chunk.push(point);
      if (chunk.length >= 8192) {
        output += String.fromCharCode(...chunk);
        chunk = [];
      }
    }
    if (chunk.length) output += String.fromCharCode(...chunk);
    return output;
  }

  const utf8Decode = typeof deps.utf8Decode === 'function' ? deps.utf8Decode : null;

    function decode(input, encoding, mimeType) {
      // Chrome's FileReader ignores Blob.type charset parameters.
      void mimeType;
      let bytes = bytesView(input);
      if (bytes.byteLength > MAX_BYTES) {
        throw new RangeError('Text input exceeds 2 MiB.');
      }

      let bomEncoding = null;
      let bomLength = 0;
      if (bytes.length >= 3 && bytes[0] === 0xef &&
          bytes[1] === 0xbb && bytes[2] === 0xbf) {
        bomEncoding = 'utf-8';
        bomLength = 3;
      } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        bomEncoding = 'utf-16le';
        bomLength = 2;
      } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        bomEncoding = 'utf-16be';
        bomLength = 2;
      }

      const selected = bomEncoding || labelEncoding(encoding);
      if (bomLength) bytes = bytes.subarray(bomLength);
      // File API sniffs a leading BOM before consulting the label. The public
      // TextDecoder has fixed-label semantics; preserve any second BOM here.
      if (typeof deps.TextDecoder === 'function')
        return new deps.TextDecoder(selected, { ignoreBOM: true }).decode(bytes);
      if (selected === 'utf-16le') return decodeUtf16(bytes, true);
      if (selected === 'utf-16be') return decodeUtf16(bytes, false);
      if (selected === 'windows-1252') return decodeWindows1252(bytes);
      if (utf8Decode && isValidUtf8(bytes)) return utf8Decode(bytes);
      return decodeUtf8Strict(bytes);
    }

    function decodeUtf8(input) {
      let bytes = bytesView(input);
      if (bytes.byteLength > MAX_BYTES) throw new RangeError('Text input exceeds 2 MiB.');
      if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
        bytes = bytes.subarray(3);
      return decodeUtf8Strict(bytes);
    }
    return { decode, decodeUtf8 };
}
