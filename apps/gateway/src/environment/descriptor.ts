import { loadAgentConfig, configRoles, type AgentConfig } from '../agent/config.js';
import { capabilityForTool, capabilities, type Capabilities } from '../agent/capabilities.js';
import { discoverSkills, skillRoots } from '../agent/skills.js';
import { skillsPrompt } from '../agent/features/skills.js';
import { resolveWorkspace } from '../agent/features/memory/workspace.js';
import { renderRole } from '../agent/roles.js';
import type { Tool } from '../agent/tools/types.js';
import { catalogEntry } from './catalog.js';
import { canonicalJson, digest } from './json.js';
import {
  descriptorDigest,
  descriptorSchema,
  DESCRIPTOR_BYTES,
  REQUEST_BYTES,
  type Binding,
  type Descriptor,
} from './protocol.js';

/** Trusted node startup inputs, never an execution.start payload. */
export interface DescriptorOptions {
  binding: Binding;
  cwd: string;
  tools: Tool[];
  env?: NodeJS.ProcessEnv;
  role?: string;
  /** Already intersected parent/child allowlist; absence adds no restrictions. */
  allowedTools?: string[];
  capabilities?: Capabilities;
  /** Trusted node chat/project service text, never a model-supplied file path. */
  projectInstructions?: string;
  sandboxStatus: Descriptor['sandboxStatus'];
}

export function describeConfig(config: AgentConfig, options: DescriptorOptions): Descriptor {
  const roles = configRoles(config);
  const roleName = options.role ?? 'general';
  const role = roles[roleName];
  if (!role) throw new Error(`Unknown role: ${roleName}`);
  const flags = capabilities(options.capabilities);
  // Classify every registration before filtering: disabling a tool cannot hide missing ownership.
  for (const tool of options.tools) catalogEntry(tool, '0'.repeat(64));
  const tools = options.tools.filter((tool) => {
    const flag = capabilityForTool(tool.name);
    const feature =
      tool.name === 'background_task'
        ? 'background'
        : tool.name === 'web_fetch' || tool.name.startsWith('browser_')
          ? 'browser'
          : undefined;
    const enabled =
      !feature ||
      (config.features[feature] as { enabled?: boolean } | undefined)?.enabled !== false;
    const chatAllowed =
      config.workspaceKind !== 'chat' ||
      !['bash', 'ls', 'find', 'grep', 'background_task'].includes(tool.name) ||
      (config.features[feature ?? tool.name] as { enabled?: boolean } | undefined)?.enabled ===
        true;
    return (
      enabled &&
      chatAllowed &&
      (!role.tools || role.tools.includes(tool.name)) &&
      (!options.allowedTools || options.allowedTools.includes(tool.name)) &&
      (!flag || flags[flag])
    );
  });
  const skills =
    (config.features.skills as { enabled?: boolean } | undefined)?.enabled === false
      ? []
      : discoverSkills(skillRoots(config.configDir, config.projectRoot ?? config.workspace)).skills;
  const hookRevision = digest(config.hooks, REQUEST_BYTES);
  // Only hashes leave the node; neither hook command text nor environment values are serialized.
  const policyRevision = digest(
    {
      paths: config.pathPolicy,
      protectedPaths: config.protectedPaths,
      hooks: hookRevision,
      environmentRevision: digest(config.env, REQUEST_BYTES),
      features: config.features,
      role,
      allowedTools: options.allowedTools ?? null,
      capabilities: flags,
    },
    REQUEST_BYTES,
  );
  const instructions = [
    ...config.systemPrompt.map((section) => section.text),
    skillsPrompt(skills),
    renderRole({
      name: roleName,
      ...(role.instructions ? { instructions: role.instructions } : {}),
    }),
  ]
    .filter(Boolean)
    .join('\n\n');
  const platform = process.platform;
  if (platform !== 'linux' && platform !== 'darwin')
    throw new Error('Unsupported environment platform');
  const descriptor: Descriptor = {
    binding: options.binding,
    version: 1,
    revision: '0'.repeat(64),
    policyRevision,
    capabilityCatalog: tools.map((tool) => catalogEntry(tool, hookRevision)),
    instructions,
    ...(options.projectInstructions !== undefined
      ? { projectInstructions: options.projectInstructions }
      : {}),
    skills: skills.map(({ name, description }) => ({ name, description })),
    role: roleName,
    repositoryKey: resolveWorkspace(options.cwd).key,
    lifecycleHooks: (['sessionStart', 'beforePrompt', 'agentSettled'] as const).filter(
      (phase) => config.hooks[phase].length > 0,
    ),
    platform,
    cwdDisplay: options.cwd,
    sandboxStatus: options.sandboxStatus,
    limits: { maxActive: 1, maxBudgetMs: 600_000 },
  };
  descriptor.revision = descriptorDigest(descriptor);
  canonicalJson(descriptor, DESCRIPTOR_BYTES);
  return descriptorSchema.parse(descriptor);
}

export function generateDescriptor(options: DescriptorOptions): Descriptor {
  return describeConfig(loadAgentConfig(options.cwd, { providers: {} }, options.env), options);
}
