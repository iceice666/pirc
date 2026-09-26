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
} from '../models.js';

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
  env: Record<string, string>;
  hooks: HooksConfig;
  limits: z.infer<typeof limitsSchema>;
  features: Record<string, unknown>;
  systemPrompt: string;
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
  const defaultModel = project.defaultModel ?? models.defaultModel;
  return {
    configDir,
    workspace,
    models,
    providers: models.providers,
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
