import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';

export const now = () => Date.now();
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;

export function canonicalPath(input: string): string {
  return path.normalize(realpathSync(path.resolve(input)));
}

export function pathsOverlap(a: string, b: string): boolean {
  const relativeAB = path.relative(a, b);
  const relativeBA = path.relative(b, a);
  return (
    relativeAB === '' ||
    relativeBA === '' ||
    (!relativeAB.startsWith(`..${path.sep}`) && relativeAB !== '..') ||
    (!relativeBA.startsWith(`..${path.sep}`) && relativeBA !== '..')
  );
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

export function payloadHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

export function safeJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
