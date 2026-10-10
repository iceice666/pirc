import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const MAX_DEPTH = 64;

/** Non-ASCII text needs a UTF-8 byte count; ASCII text is one byte per code unit. */
const NON_ASCII = /[^\x00-\x7f]/;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const OTHER_SPACE = /\s/;

/** Strict JSON before schemas: JSON.parse alone loses duplicate-key evidence. */
export function parseJson(source: string, maxBytes: number): Json {
  if (Buffer.byteLength(source) > maxBytes) throw new Error('JSON exceeds byte limit');
  let pos = 0;
  const length = source.length;
  const space = () => {
    while (pos < length) {
      const code = source.charCodeAt(pos);
      if (code === 32 || code === 10 || code === 13 || code === 9) {
        pos++;
        continue;
      }
      // Any other JavaScript whitespace is not JSON whitespace.
      if (
        (code === 11 || code === 12 || code === 0xa0 || code >= 0x1680) &&
        OTHER_SPACE.test(source[pos]!)
      )
        throw new Error('Invalid JSON whitespace');
      return;
    }
  };
  const string = (): string => {
    const start = pos++;
    while (pos < length) {
      const code = source.charCodeAt(pos++);
      if (code === 34) return JSON.parse(source.slice(start, pos)) as string;
      if (code === 92) pos++;
    }
    throw new Error('Unterminated JSON string');
  };
  const value = (depth: number): Json => {
    if (depth > MAX_DEPTH) throw new Error('JSON nesting limit exceeded');
    space();
    const ch = source[pos];
    if (ch === '"') return string();
    if (ch === '{') {
      pos++;
      const out: Record<string, Json> = Object.create(null);
      space();
      if (source[pos] === '}') {
        pos++;
        return out;
      }
      for (;;) {
        space();
        if (source[pos] !== '"') throw new Error('Expected object key');
        const key = string();
        // `out` has no prototype, so `in` sees exactly the keys already parsed.
        if (key in out) throw new Error('Duplicate JSON key');
        space();
        if (source[pos++] !== ':') throw new Error('Expected colon');
        out[key] = value(depth + 1);
        space();
        const separator = source[pos++];
        if (separator === '}') return out;
        if (separator !== ',') throw new Error('Expected object separator');
      }
    }
    if (ch === '[') {
      pos++;
      const out: Json[] = [];
      space();
      if (source[pos] === ']') {
        pos++;
        return out;
      }
      for (;;) {
        out.push(value(depth + 1));
        space();
        const separator = source[pos++];
        if (separator === ']') return out;
        if (separator !== ',') throw new Error('Expected array separator');
      }
    }
    if (source.startsWith('true', pos)) {
      pos += 4;
      return true;
    }
    if (source.startsWith('false', pos)) {
      pos += 5;
      return false;
    }
    if (source.startsWith('null', pos)) {
      pos += 4;
      return null;
    }
    NUMBER.lastIndex = pos;
    const match = NUMBER.exec(source);
    if (!match) throw new Error('Invalid JSON value');
    pos += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) throw new Error('Non-finite JSON number');
    return number;
  };
  const result = value(0);
  space();
  if (pos !== source.length) throw new Error('Trailing JSON input');
  return result;
}

/** Reject JS-only values rather than allowing JSON.stringify to silently drop them. */
export function canonicalJson(value: unknown, maxBytes: number): string {
  const seen = new Set<object>();
  let bytes = 0;
  const out: string[] = [];
  const add = (text: string) => {
    bytes += NON_ASCII.test(text) ? Buffer.byteLength(text) : text.length;
    if (bytes > maxBytes) throw new Error('JSON exceeds byte limit');
    out.push(text);
  };
  const visit = (item: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) throw new Error('JSON nesting limit exceeded');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') {
      add(JSON.stringify(item));
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      add(JSON.stringify(item));
      return;
    }
    if (typeof item !== 'object' || !item) throw new Error('Unsupported JSON value');
    if (seen.has(item)) throw new Error('Cyclic JSON value');
    seen.add(item);
    try {
      if (Object.getOwnPropertySymbols(item).length) throw new Error('Unsupported JSON symbol key');
      const descriptors = Object.getOwnPropertyDescriptors(item) as Record<
        string,
        PropertyDescriptor
      >;
      const names = Object.keys(descriptors);
      for (let index = 0; index < names.length; index++)
        if (!('value' in descriptors[names[index]!]!))
          throw new Error('JSON accessors are forbidden');
      if (Array.isArray(item)) {
        if (names.length !== item.length + 1) throw new Error('Sparse or decorated JSON array');
        add('[');
        for (let index = 0; index < item.length; index++) {
          if (!Object.hasOwn(descriptors, index)) throw new Error('Sparse JSON array');
          if (index) add(',');
          visit(descriptors[index]!.value, depth + 1);
        }
        add(']');
        return;
      }
      const proto = Object.getPrototypeOf(item);
      if (proto !== null && proto !== Object.prototype) throw new Error('Non-plain JSON object');
      add('{');
      names.sort();
      for (let index = 0; index < names.length; index++) {
        const key = names[index]!;
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable) throw new Error('Non-enumerable JSON key');
        if (index) add(',');
        add(JSON.stringify(key));
        add(':');
        visit(descriptor.value, depth + 1);
      }
      add('}');
    } finally {
      seen.delete(item);
    }
  };
  visit(value, 0);
  return out.join('');
}

export function digest(value: unknown, maxBytes: number): string {
  return createHash('sha256').update(canonicalJson(value, maxBytes)).digest('hex');
}
