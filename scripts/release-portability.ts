import path from 'node:path';

/** Release assets embed interpreter data, not third-party dylibs. Their only
 * approved dynamic dependencies are Apple OS libraries. Fail closed on rpath,
 * Homebrew/Nix/user libraries rather than shipping a host-dependent archive. */
export function assertAppleDependencies(otoolOutput: string, ownInstallName?: string): void {
  const lines = otoolOutput.trimEnd().split('\n');
  if (lines.length < 2) throw new Error('Cannot inspect native dependency closure');
  for (const [index, line] of lines.slice(1).entries()) {
    const dependency = line.trim().split(' (')[0]!;
    if (index === 0 && ownInstallName && dependency === ownInstallName) continue;
    if (
      !dependency ||
      path.normalize(dependency) !== dependency ||
      !(dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/'))
    )
      throw new Error('Release asset has an unshipped native dependency');
  }
}
