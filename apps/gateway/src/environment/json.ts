import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const MAX_DEPTH = 64;

/** Strict JSON before schemas: JSON.parse alone loses duplicate-key evidence. */
export function parseJson(source: string, maxBytes: number): Json {
  if (Buffer.byteLength(source) > maxBytes) throw new Error('JSON exceeds byte limit');
  let pos = 0;
  const space = () => {
    while (/\s/.test(source[pos] ?? '') && pos < source.length) {
      if (!' \t\n\r'.includes(source[pos]!)) throw new Error('Invalid JSON whitespace');
      pos++;
    }
  };
  const string = (): string => {
    const start = pos++;
    while (pos < source.length) {
      const ch = source[pos++];
      if (ch === '"') return JSON.parse(source.slice(start, pos)) as string;
      if (ch === '\\') pos++;
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
      const keys = new Set<string>();
      space();
      if (source[pos] === '}') {
        pos++;
        return out;
      }
      for (;;) {
        space();
        if (source[pos] !== '"') throw new Error('Expected object key');
        const key = string();
        if (keys.has(key)) throw new Error('Duplicate JSON key');
        keys.add(key);
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
    for (const [token, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (source.startsWith(token, pos)) {
        pos += token.length;
        return result;
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(pos));
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
  const add = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > maxBytes) throw new Error('JSON exceeds byte limit');
    return text;
  };
  const visit = (item: unknown, depth: number): string => {
    if (depth > MAX_DEPTH) throw new Error('JSON nesting limit exceeded');
    if (item === null || typeof item === 'boolean' || typeof item === 'string')
      return add(JSON.stringify(item));
    if (typeof item === 'number' && Number.isFinite(item)) return add(JSON.stringify(item));
    if (typeof item !== 'object' || !item) throw new Error('Unsupported JSON value');
    if (seen.has(item)) throw new Error('Cyclic JSON value');
    seen.add(item);
    try {
      if (Object.getOwnPropertySymbols(item).length) throw new Error('Unsupported JSON symbol key');
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Object.values(descriptors).some((entry) => !('value' in entry)))
        throw new Error('JSON accessors are forbidden');
      if (Array.isArray(item)) {
        if (Object.keys(descriptors).length !== item.length + 1)
          throw new Error('Sparse or decorated JSON array');
        const parts: string[] = [];
        add('[');
        for (let index = 0; index < item.length; index++) {
          if (!Object.hasOwn(descriptors, index)) throw new Error('Sparse JSON array');
          if (index) add(',');
          parts.push(visit(descriptors[index]!.value, depth + 1));
        }
        add(']');
        return `[${parts.join(',')}]`;
      }
      const proto = Object.getPrototypeOf(item);
      if (proto !== null && proto !== Object.prototype) throw new Error('Non-plain JSON object');
      add('{');
      const parts = Object.keys(descriptors)
        .sort()
        .map((key, index) => {
          if (!descriptors[key]!.enumerable) throw new Error('Non-enumerable JSON key');
          if (index) add(',');
          return `${add(JSON.stringify(key))}${add(':')}${visit(descriptors[key]!.value, depth + 1)}`;
        });
      add('}');
      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(item);
    }
  };
  return visit(value, 0);
}

export function digest(value: unknown, maxBytes: number): string {
  return createHash('sha256').update(canonicalJson(value, maxBytes)).digest('hex');
}
