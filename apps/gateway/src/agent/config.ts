import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  defaultConfigDir,
  expandHome,
  modelRefSchema as modelRef,
  type ModelsConfig,
  type ModelRef,
  type ProviderConfig,
  thinkingLevels,
  type ThinkingLevel,
} from '../models.js';
import type { WorkspaceKind } from '../types.js';
import type { SessionEntry } from './session-store.js';
import { skillReadPaths, skillRoots } from './skills.js';
import { defaultPathPolicy, type PathPolicy } from '../sandbox-policy.js';

export {
  defaultConfigDir,
  expandHome,
  thinkingLevels,
  type ModelConfig,
  type ModelRef,
  type ProviderConfig,
  type ThinkingLevel,
} from '../models.js';

const hookSchema = z.object({
  command: z.string().min(1),
  matcher: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600_000).default(10_000),
});
const hooksSchema = z
  .object({
    sessionStart: z.array(hookSchema).default([]),
    beforePrompt: z.array(hookSchema).default([]),
    beforeTool: z.array(hookSchema).default([]),
    afterTool: z.array(hookSchema).default([]),
    agentSettled: z.array(hookSchema).default([]),
  })
  .default({});

const limitsSchema = z
  .object({
    bashTimeoutMs: z.number().int().positive().default(120_000),
    ptcTimeoutMs: z.number().int().positive().default(120_000),
    toolOutputBytes: z.number().int().positive().default(51_200),
    maxTurns: z.number().int().positive().default(200),
    /** Event-driven team completion wait per boundary; timeout reports pending work. */
    completionWaitMs: z.number().int().positive().max(86_400_000).default(60_000),
  })
  .default({});

/**
 * Node-local agent settings. Providers and the default model are not here:
 * they come from the gateway (see `models.ts`).
 */
const globalSchema = z.object({
  allowedPaths: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  hooks: hooksSchema,
  limits: limitsSchema,
  features: z.record(z.unknown()).default({}),
  /**
   * The OS sandbox (sandbox-policy.ts sandboxConfigSchema). The node reads and
   * validates it when it starts the agent, and warns about mistakes there
   * (node/sandbox.ts); the agent itself only applies what the node sends.
   */
  sandbox: z.unknown().optional(),
});

/** Project config may only extend paths/env/hooks and choose a default model. */
const projectSchema = z
  .object({
    defaultModel: modelRef.optional(),
    allowedPaths: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    hooks: hooksSchema,
  })
  .strict();

export type HookConfig = z.infer<typeof hookSchema>;
export type HooksConfig = z.infer<typeof hooksSchema>;

export interface AgentConfig {
  configDir: string;
  workspace: string;
  /** Providers and default model exactly as the gateway sent them. */
  models: ModelsConfig;
  providers: Record<string, ProviderConfig>;
  /** The project's default model, else the gateway's. */
  defaultModel?: ModelRef;
  /** Canonical absolute paths the file tools may touch, workspace first. */
  allowedPaths: string[];
  /** Paths the agent may read but never write (its own project config). */
  protectedPaths: string[];
  /** What the file tools may read and write (the node's sandbox policy when it has one). */
  pathPolicy: PathPolicy;
  /** The node runs this agent inside its OS sandbox (PIRC_SANDBOX=srt). */
  sandboxed: boolean;
  env: Record<string, string>;
  hooks: HooksConfig;
  limits: z.infer<typeof limitsSchema>;
  features: Record<string, unknown>;
  systemPrompt: string;
  /** `chat` when the node runs this agent in a chat workspace (PIRC_WORKSPACE_KIND). */
  workspaceKind: WorkspaceKind;
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${(error as Error).message}`);
  }
}

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
}

const basePrompt = `You are pirc, a coding agent operating inside a user's workspace through tools.
Work carefully: read before editing, keep changes minimal and verified, and report blockers honestly.
File tools can read anywhere except credential stores and pirc's private state, and write only to the workspace and explicitly allowed paths.`;

/** For chats (plans/assistant.md): the working directory is the chat's own, not a project. */
const chatPrompt = `You are pirc, the user's personal assistant, chatting with them on one of their machines.
Answer directly; use tools when they help, and report what you did and any blockers honestly.
This chat has its own private working directory; file tools write only to it and explicitly allowed paths, and read anywhere except credential stores and pirc's private state.`;

/** Keys of the node's config.json that moved to the gateway and are now ignored. */
export function legacyModelKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = readJson(path.join(defaultConfigDir(env), 'config.json'));
  return raw && typeof raw === 'object'
    ? ['providers', 'defaultModel'].filter((key) => key in raw)
    : [];
}

export function loadAgentConfig(
  workspace: string,
  models: ModelsConfig,
  env: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const configDir = defaultConfigDir(env);
  const global = globalSchema.parse(readJson(path.join(configDir, 'config.json')));
  const projectDir = path.join(workspace, '.pirc');
  const project = projectSchema.parse(readJson(path.join(projectDir, 'config.json')));
  const resolvePaths = (items: string[], base: string) =>
    items.map((item) => path.resolve(base, expandHome(item)));
  // Skills are read by the file tools but are configuration, like .pirc/.
  const skillPaths = skillReadPaths(skillRoots(configDir, workspace));
  const allowedPaths = [
    workspace,
    ...resolvePaths(global.allowedPaths, configDir),
    ...resolvePaths(project.allowedPaths, workspace),
    ...skillPaths,
  ];
  const hooks = Object.fromEntries(
    Object.entries(global.hooks).map(([key, list]) => [
      key,
      [...list, ...(project.hooks[key as keyof HooksConfig] ?? [])],
    ]),
  ) as HooksConfig;
  const workspaceKind: WorkspaceKind = env.PIRC_WORKSPACE_KIND === 'chat' ? 'chat' : 'directory';
  const writable = [...new Set(allowedPaths)];
  const sandboxed = env.PIRC_SANDBOX === 'srt';
  const nodePolicy = parsePathPolicy(env.PIRC_SANDBOX_POLICY);
  // The node's read rules always; its write rules only when srt enforces
  // them (unsandboxed, the configured allowedPaths still apply).
  const pathPolicy: PathPolicy = nodePolicy
    ? {
        denyRead: nodePolicy.denyRead,
        allowRead: nodePolicy.allowRead,
        allowWrite: sandboxed ? nodePolicy.allowWrite : writable,
        denyWrite: sandboxed ? nodePolicy.denyWrite : [],
      }
    : defaultPathPolicy(writable);
  const prompts = [
    workspaceKind === 'chat' ? chatPrompt : basePrompt,
    readText(path.join(configDir, 'AGENTS.md')),
    readText(path.join(workspace, 'AGENTS.md')),
    readText(path.join(projectDir, 'AGENTS.md')),
  ].filter(Boolean);
  const defaultModel = project.defaultModel ?? models.defaultModel;
  return {
    configDir,
    workspace,
    models,
    providers: models.providers,
    ...(defaultModel ? { defaultModel } : {}),
    allowedPaths: writable,
    protectedPaths: [
      projectDir,
      ...skillPaths,
      // A chat project's instructions (node/chat.ts): only the user edits them, from the web.
      ...(workspaceKind === 'chat' && env.PIRC_PROJECT_INSTRUCTIONS
        ? [path.resolve(env.PIRC_PROJECT_INSTRUCTIONS)]
        : []),
    ],
    pathPolicy,
    sandboxed,
    env: { ...global.env, ...project.env },
    hooks,
    limits: global.limits,
    features: global.features,
    systemPrompt: prompts.join('\n\n'),
    workspaceKind,
  };
}

const pathPolicySchema = z.object({
  denyRead: z.array(z.string()),
  allowRead: z.array(z.string()),
  allowWrite: z.array(z.string()),
  denyWrite: z.array(z.string()),
});

function parsePathPolicy(value: string | undefined): PathPolicy | undefined {
  if (!value) return undefined;
  try {
    return pathPolicySchema.parse(JSON.parse(value));
  } catch {
    throw new Error('PIRC_SANDBOX_POLICY is not a valid path policy');
  }
}

/**
 * Model and thinking level an agent uses for a session: the latest recorded
 * change on the branch, else the default model (and its thinking level), else
 * the first configured model. Shared by the agent and the gateway snapshot.
 */
export function sessionSettings(
  branch: readonly SessionEntry[],
  config: Pick<AgentConfig, 'defaultModel' | 'providers'>,
): { model: { provider: string; id: string } | null; thinking: ThinkingLevel } {
  const change = branch.findLast((entry) => entry.type === 'model_change');
  const level = branch.findLast((entry) => entry.type === 'thinking_level_change');
  const fallback = config.defaultModel;
  let model: { provider: string; id: string } | null = null;
  if (change?.type === 'model_change') model = { provider: change.provider, id: change.modelId };
  else if (fallback) model = { provider: fallback.provider, id: fallback.id };
  else {
    const [name, provider] = Object.entries(config.providers)[0] ?? [];
    if (name && provider?.models[0]) model = { provider: name, id: provider.models[0].id };
  }
  const recorded =
    level?.type === 'thinking_level_change' ? level.thinkingLevel : fallback?.thinking;
  const thinking =
    recorded && (thinkingLevels as readonly string[]).includes(recorded)
      ? (recorded as ThinkingLevel)
      : 'medium';
  return { model, thinking };
}
