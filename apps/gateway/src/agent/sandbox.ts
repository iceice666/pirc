import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { expandHome } from './config.js';

/** Resolve a path the way the kernel will, following symlinks of the longest existing prefix. */
export function realResolve(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  let real: string;
  try {
    real = realpathSync(current);
  } catch {
    real = current;
  }
  return path.join(real, ...tail);
}

const inside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/**
 * Enforces the workspace boundary for file tools and PTC file APIs.
 * Not a security sandbox for shell commands — bash still runs with the
 * agent account's permissions, exactly like Pi.
 */
export class PathGuard {
  private readonly roots: string[];
  private readonly protectedRoots: string[];

  constructor(
    readonly cwd: string,
    allowed: string[],
    protectedPaths: string[] = [],
  ) {
    this.roots = allowed.map((item) => realResolve(item));
    this.protectedRoots = protectedPaths.map((item) => realResolve(item));
  }

  get allowedRoots(): readonly string[] {
    return this.roots;
  }

  resolve(input: string, mode: 'read' | 'write'): string {
    if (typeof input !== 'string' || !input) throw new Error('Path is required');
    const cleaned = input.startsWith('@') ? input.slice(1) : input;
    const absolute = path.resolve(this.cwd, expandHome(cleaned));
    const real = realResolve(absolute);
    if (!this.roots.some((root) => inside(real, root)))
      throw new Error(
        `Path ${input} is outside the workspace and allowed paths (${this.roots.join(', ')})`,
      );
    if (mode === 'write' && this.protectedRoots.some((root) => inside(real, root)))
      throw new Error(`Path ${input} is protected agent configuration and cannot be modified`);
    return absolute;
  }
}

/** Keep the head and tail of oversized output so errors at the end stay visible. */
export function truncateOutput(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { text, truncated: false };
  const buffer = Buffer.from(text);
  const head = Math.floor(maxBytes * 0.3);
  const tail = maxBytes - head;
  return {
    text:
      buffer.subarray(0, head).toString('utf8') +
      `\n\n[… ${bytes - maxBytes} bytes truncated …]\n\n` +
      buffer.subarray(bytes - tail).toString('utf8'),
    truncated: true,
  };
}
