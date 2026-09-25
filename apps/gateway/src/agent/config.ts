import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  contextWindow: z.number().int().positive().default(200_000),
  maxTokens: z.number().int().positive().default(32_000),
  reasoning: z.boolean().default(false),
  input: z.array(z.enum(['text', 'image'])).default(['text']),
  compat: z.record(z.unknown()).default({}),
});

const providerSchema = z.object({
  api: z.enum(['openai-chat', 'anthropic-messages']),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  apiKeyFile: z.string().optional(),
  apiKeyCommand: z.array(z.string()).min(1).optional(),
  headers: z.record(z.string()).default({}),
  compat: z.record(z.unknown()).default({}),
  models: z.array(modelSchema).min(1),
});

const modelRef = z.object({
  provider: z.string(),
  id: z.string(),
  thinking: z.enum(thinkingLevels).optional(),
});

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
  })
  .default({});

const globalSchema = z.object({
  providers: z.record(providerSchema).default({}),
  defaultModel: modelRef.optional(),
  allowedPaths: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  hooks: hooksSchema,
  limits: limitsSchema,
  features: z.record(z.unknown()).default({}),
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

export type ModelConfig = z.infer<typeof modelSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
export type HookConfig = z.infer<typeof hookSchema>;
export type HooksConfig = z.infer<typeof hooksSchema>;
export type ModelRef = z.infer<typeof modelRef>;

export interface AgentConfig {
  configDir: string;
  workspace: string;
  providers: Record<string, ProviderConfig>;
  defaultModel?: ModelRef;
  /** Canonical absolute paths the file tools may touch, workspace first. */
  allowedPaths: string[];
  /** Paths the agent may read but never write (its own project config). */
  protectedPaths: string[];
  env: Record<string, string>;
  hooks: HooksConfig;
  limits: z.infer<typeof limitsSchema>;
  features: Record<string, unknown>;
  systemPrompt: string;
}

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PIRC_CONFIG_DIR ?? path.join(os.homedir(), '.config', '.pirc');
}

export function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
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
File tools are limited to the workspace and explicitly allowed paths.`;

export function loadAgentConfig(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const configDir = defaultConfigDir(env);
  const global = globalSchema.parse(readJson(path.join(configDir, 'config.json')));
  const projectDir = path.join(workspace, '.pirc');
  const project = projectSchema.parse(readJson(path.join(projectDir, 'config.json')));
  const resolvePaths = (items: string[], base: string) =>
    items.map((item) => path.resolve(base, expandHome(item)));
  const allowedPaths = [
    workspace,
    ...resolvePaths(global.allowedPaths, configDir),
    ...resolvePaths(project.allowedPaths, workspace),
  ];
  const hooks = Object.fromEntries(
    Object.entries(global.hooks).map(([key, list]) => [
      key,
      [...list, ...(project.hooks[key as keyof HooksConfig] ?? [])],
    ]),
  ) as HooksConfig;
  const prompts = [
    basePrompt,
    readText(path.join(configDir, 'AGENTS.md')),
    readText(path.join(workspace, 'AGENTS.md')),
    readText(path.join(projectDir, 'AGENTS.md')),
  ].filter(Boolean);
  const defaultModel = project.defaultModel ?? global.defaultModel;
  return {
    configDir,
    workspace,
    providers: global.providers,
    ...(defaultModel ? { defaultModel } : {}),
    allowedPaths: [...new Set(allowedPaths)],
    protectedPaths: [projectDir],
    env: { ...global.env, ...project.env },
    hooks,
    limits: global.limits,
    features: global.features,
    systemPrompt: prompts.join('\n\n'),
  };
}

const keyCache = new Map<string, string>();

/** Resolve a provider API key from literal, env, file or command (cached per process). */
export function resolveApiKey(name: string, provider: ProviderConfig): string | undefined {
  const cached = keyCache.get(name);
  if (cached !== undefined) return cached;
  let key: string | undefined;
  if (provider.apiKey) key = provider.apiKey;
  else if (provider.apiKeyEnv) key = process.env[provider.apiKeyEnv];
  else if (provider.apiKeyFile) key = readFileSync(expandHome(provider.apiKeyFile), 'utf8');
  else if (provider.apiKeyCommand) {
    const [command, ...args] = provider.apiKeyCommand;
    const result = Bun.spawnSync([expandHome(command!), ...args], { stderr: 'pipe' });
    if (result.exitCode !== 0)
      throw new Error(`apiKeyCommand for ${name} failed: ${result.stderr.toString().trim()}`);
    key = result.stdout.toString();
  }
  key = key?.trim();
  if (key) keyCache.set(name, key);
  return key;
}
