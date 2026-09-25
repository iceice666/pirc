import path from 'node:path';

/** True when running from a `bun build --compile` executable. */
export function isCompiled(): boolean {
  return import.meta.path.startsWith('/$bunfs/') || import.meta.path.includes('~BUN');
}

/**
 * Command prefix that re-executes this program: the binary itself when
 * compiled, `bun <src>/cli.ts` when running from source.
 */
export function selfCommand(): string[] {
  return isCompiled()
    ? [process.execPath]
    : [process.execPath, path.join(import.meta.dir, 'cli.ts')];
}
