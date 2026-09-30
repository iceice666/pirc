import path from 'node:path';
import { expandHome } from './config.js';
import {
  isInside,
  readAllowed,
  realResolve,
  writeAllowed,
  type PathPolicy,
} from '../sandbox-policy.js';

export { realResolve } from '../sandbox-policy.js';

/**
 * The file tools' view of the sandbox policy (sandbox-policy.ts): reads are
 * open except denied regions (credential stores, pirc's state), writes only
 * inside allowed roots and never into protected ones. Under a sandboxing
 * node the policy is the node's, so the tools refuse exactly what srt would;
 * the OS sandbox, not this, is what holds shell commands to it.
 */
export class PathGuard {
  private readonly policy: PathPolicy;
  private readonly protectedRoots: string[];

  constructor(
    readonly cwd: string,
    policy: PathPolicy,
    protectedPaths: string[] = [],
  ) {
    const resolve = (items: string[]) => items.map((item) => realResolve(item));
    this.policy = {
      denyRead: resolve(policy.denyRead),
      allowRead: resolve(policy.allowRead),
      allowWrite: resolve(policy.allowWrite),
      denyWrite: resolve(policy.denyWrite),
    };
    this.protectedRoots = resolve(protectedPaths);
  }

  /** Roots the file tools may write under. */
  get allowedRoots(): readonly string[] {
    return this.policy.allowWrite;
  }

  /** The writable root containing `absolute` (innermost match), or undefined. */
  rootOf(absolute: string): string | undefined {
    const real = realResolve(absolute);
    return this.policy.allowWrite
      .filter((root) => isInside(real, root))
      .sort((a, b) => b.length - a.length)[0];
  }

  resolve(input: string, mode: 'read' | 'write'): string {
    if (typeof input !== 'string' || !input) throw new Error('Path is required');
    const cleaned = input.startsWith('@') ? input.slice(1) : input;
    const absolute = path.resolve(this.cwd, expandHome(cleaned));
    const real = realResolve(absolute);
    const shown = real === absolute ? input : `${input} (${real})`;
    if (mode === 'read') {
      if (!readAllowed(this.policy, real))
        throw new Error(`Path ${shown} is private (credentials or pirc state) and cannot be read`);
      return absolute;
    }
    if (!writeAllowed(this.policy, real))
      throw new Error(
        `Path ${shown} is outside the writable paths (${this.policy.allowWrite.join(', ')})`,
      );
    if (this.protectedRoots.some((root) => isInside(real, root)))
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
