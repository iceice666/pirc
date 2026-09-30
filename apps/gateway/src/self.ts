import path from 'node:path';

export type ExecutableRole = 'gateway' | 'chat' | 'node';
let executableRole: ExecutableRole = 'node';

/** Set by the fixed role entry, including internal worker processes. */
export function setExecutableRole(role: ExecutableRole): void {
  executableRole = role;
}

/** True when running from a `bun build --compile` executable. */
export function isCompiled(): boolean {
  return import.meta.path.startsWith('/$bunfs/') || import.meta.path.includes('~BUN');
}

/** Re-execute the current role binary, or its matching source entry in development/tests. */
export function selfCommand(role: ExecutableRole = executableRole): string[] {
  if (isCompiled()) {
    if (role !== executableRole)
      throw new Error(`Cannot run ${role} workers from pirc-${executableRole}`);
    return [process.execPath];
  }
  return [process.execPath, path.join(import.meta.dir, 'entry', `${role}.ts`)];
}
