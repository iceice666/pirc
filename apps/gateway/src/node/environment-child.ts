import path from 'node:path';
import { statSync } from 'node:fs';
import type { AgentConfig } from '../agent/config.js';
import { configRoles } from '../agent/config.js';
import { PathGuard } from '../agent/sandbox.js';
import { isInside, realResolve } from '../sandbox-policy.js';
import type { Descriptor } from '../environment/protocol.js';

/** Trusted node provisioning helper. Gateway sends relative cwd text, never resolves it locally.
 * Keeps parent's project trust/config and narrows—not expands—the parent catalog.
 */
export function resolveChildEnvironment(options: {
  config: AgentConfig;
  parent: Descriptor;
  cwd: string;
  role: string;
  tools?: readonly string[];
}) {
  const roles = configRoles(options.config),
    role = roles[options.role];
  if (!role) throw new Error('Unknown child role');
  if (typeof options.cwd !== 'string' || options.cwd.length > 4096 || options.cwd.includes('\0'))
    throw new Error('Invalid child cwd');
  const guard = new PathGuard(
    options.config.workspace,
    options.config.pathPolicy,
    options.config.protectedPaths,
  );
  const cwd = guard.resolve(path.resolve(options.config.workspace, options.cwd), 'read');
  if (!statSync(cwd).isDirectory()) throw new Error('Child cwd is not a directory');
  const roots = [options.config.workspace, ...options.config.allowedPaths].map(realResolve);
  if (!roots.some((root) => isInside(realResolve(cwd), root)))
    throw new Error('Child cwd outside parent allowed roots');
  const names = options.parent.capabilityCatalog
    .map((capability) => capability.name)
    .filter(
      (name) =>
        (!role.tools || role.tools.includes(name)) &&
        (!options.tools || options.tools.includes(name)),
    );
  return {
    cwd,
    role: options.role,
    allowedTools: names,
    projectRoot: options.config.projectRoot ?? options.config.workspace,
  };
}
