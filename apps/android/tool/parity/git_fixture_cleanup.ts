import path from 'node:path';
import { rmSync } from 'node:fs';

/** Delete only the helper-owned Git workspace after its Rust node has exited. */
export function cleanGitFixture(root: string, gitDirectory: string): void {
  const isolatedRoot = path.resolve(root);
  const target = path.resolve(gitDirectory);
  if (
    path.dirname(isolatedRoot) !== '/private/tmp' ||
    !path.basename(isolatedRoot).startsWith('pirc-rust-')
  ) {
    throw new Error('Unexpected Rust helper state root');
  }
  if (
    path.dirname(target) !== isolatedRoot ||
    !path.basename(target).startsWith('git-fixture-')
  ) {
    throw new Error('Refusing to remove a non-fixture Git directory');
  }
  rmSync(target, { recursive: true, force: true });
}
