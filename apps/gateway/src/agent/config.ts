import { createHash } from 'node:crypto';
import { readAssistantPrompt } from '../assistant-prompts.js';
import type { PromptSection } from './context.js';
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
import { readRoles, roleDirs, type RoleDir, type RolePreset } from './roles.js';
import { validateMemoryConfig } from './features/memory/config.js';

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
export type ProjectConfig = z.infer<typeof projectSchema>;

/**
 * The project config fields that run code or widen access (plans/security-audit.md
 * H3): honoured only when the workspace owner trusted exactly these values in
 * Settings. The node passes the trusted hash in `PIRC_PROJECT_TRUST`.
 */
export interface ProjectTrustFields {
  hooks: HooksConfig;
  env: Record<string, string>;
  allowedPaths: string[];
}

const HASH = /^[0-9a-f]{64}$/;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** The trust-gated fields of a parsed project config. */
export function projectTrustFields(project: ProjectConfig): ProjectTrustFields {
  return { hooks: project.hooks, env: project.env, allowedPaths: project.allowedPaths };
}

/** sha256 of the canonical JSON of the trust-gated fields (as parsed, defaults filled in). */
export function projectTrustHash(fields: ProjectTrustFields): string {
  const canonical = canonicalJson({
    allowedPaths: fields.allowedPaths,
    env: fields.env,
    hooks: fields.hooks,
  });
  return createHash('sha256').update(`pirc-project-trust-v1\n${canonical}`).digest('hex');
}

/** Nothing to trust: no hooks, env or allowed paths. */
export function projectTrustEmpty(fields: ProjectTrustFields): boolean {
  return (
    !fields.allowedPaths.length &&
    !Object.keys(fields.env).length &&
    Object.values(fields.hooks).every((list) => !list.length)
  );
}

/** `<root>/.pirc/config.json`, parsed; throws when it is invalid. */
export function readProjectConfig(root: string): ProjectConfig {
  return projectSchema.parse(readJson(path.join(root, '.pirc', 'config.json')));
}

/** A valid trust hash, or undefined. */
export function parseTrustHash(value: unknown): string | undefined {
  return typeof value === 'string' && HASH.test(value) ? value : undefined;
}

export const UNTRUSTED_PROJECT_WARNING =
  "This workspace's .pirc/config.json sets hooks, env or allowedPaths; they were ignored because the workspace is not trusted (or they changed since it was trusted). Review and trust them in the workspace's Settings.";

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
  /**
   * Where project config (`.pirc/`) is read from: the session's workspace.
   * Team children run in another cwd but keep their parent's (H4).
   */
  projectRoot?: string;
  /** Problems to show the user when the session starts (e.g. an untrusted project config). */
  warnings?: string[];
  /** What the file tools may read and write (the node's sandbox policy when it has one). */
  pathPolicy: PathPolicy;
  /** The node runs this agent inside its OS sandbox (PIRC_SANDBOX=srt). */
  sandboxed: boolean;
  env: Record<string, string>;
  hooks: HooksConfig;
  limits: z.infer<typeof limitsSchema>;
  features: Record<string, unknown>;
  /** Role file directories, lowest precedence first (roles.ts); read when a role is used. */
  roleDirs?: Array<string | RoleDir>;
  systemPrompt: PromptSection[];
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

/** For chats (docs/history/assistant.md): the working directory is the chat's own, not a project. */
const chatIdentity = `You are pirc, the user's personal assistant, chatting with them on one of their machines.
Answer directly; use tools when they help, and report what you did and any blockers honestly.`;
const chatEnvironment = `This chat has its own private working directory; file tools write only to it and explicitly allowed paths, and read anywhere except credential stores and pirc's private state.`;

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
  // Project config comes from the session's workspace only: a team child in
  // another directory keeps its parent's (PIRC_PROJECT_ROOT, set by team.ts),
  // so a nested .pirc/ can never add hooks or env (H4).
  const child = !!env.PIRC_TEAM_AGENT;
  const projectRoot =
    child && env.PIRC_PROJECT_ROOT ? path.resolve(env.PIRC_PROJECT_ROOT) : workspace;
  const projectDir = path.join(projectRoot, '.pirc');
  const parsed = readProjectConfig(projectRoot);
  // hooks / env / allowedPaths only when the user trusted exactly these values (H3).
  const fields = projectTrustFields(parsed);
  const trustedHash = parseTrustHash(env.PIRC_PROJECT_TRUST);
  const untrusted =
    !projectTrustEmpty(fields) && (!trustedHash || trustedHash !== projectTrustHash(fields));
  const project = untrusted
    ? { ...parsed, allowedPaths: [], env: {}, hooks: hooksSchema.parse({}) }
    : parsed;
  const warnings = untrusted && !child ? [UNTRUSTED_PROJECT_WARNING] : [];
  const memoryWarning = validateMemoryConfig(global.features).warning;
  if (memoryWarning) warnings.push(memoryWarning);
  const resolvePaths = (items: string[], base: string) =>
    items.map((item) => path.resolve(base, expandHome(item)));
  // Skills are read by the file tools but are configuration, like .pirc/.
  const skillPaths = skillReadPaths(skillRoots(configDir, projectRoot));
  const allowedPaths = [
    workspace,
    ...resolvePaths(global.allowedPaths, configDir),
    ...resolvePaths(project.allowedPaths, projectRoot),
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
        ...(sandboxed && nodePolicy.sharedWrite ? { sharedWrite: nodePolicy.sharedWrite } : {}),
      }
    : defaultPathPolicy(writable);
  const section = (id: string, title: string, source: string, text: string): PromptSection => ({
    id,
    title,
    source,
    text,
  });
  const soul = workspaceKind === 'chat' ? readAssistantPrompt(path.join(configDir, 'SOUL.md')) : '';
  const prompts = (
    workspaceKind === 'chat'
      ? [
          section(
            'soul',
            'Persona',
            soul ? path.join(configDir, 'SOUL.md') : 'built-in',
            soul || chatIdentity,
          ),
          section('chat-env', 'Chat environment', 'built-in', chatEnvironment),
          section(
            'chat-md',
            'Chat rules',
            path.join(configDir, 'CHAT.md'),
            readAssistantPrompt(path.join(configDir, 'CHAT.md')),
          ),
        ]
      : [
          section('base', 'Coding instructions', 'built-in', basePrompt),
          ...[
            [configDir, 'global'],
            [workspace, 'workspace'],
            [projectDir, 'project'],
          ].map(([dir, kind]) => {
            const file = path.join(dir!, 'AGENTS.md');
            return section('agents:' + kind, 'AGENTS.md (' + kind + ')', file, readText(file));
          }),
        ]
  ).filter((s) => !!s.text);
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
      path.join(workspace, '.pirc'),
      // A hook runs as the user on the next commit.
      path.join(workspace, '.git', 'hooks'),
      ...skillPaths,
      // The node's role files: only the user writes them.
      path.join(configDir, 'roles'),
      path.join(configDir, 'SOUL.md'),
      path.join(configDir, 'CHAT.md'),
      // A chat project's instructions (node/chat.ts): only the user edits them, from the web.
      ...(workspaceKind === 'chat' && env.PIRC_PROJECT_INSTRUCTIONS
        ? [path.resolve(env.PIRC_PROJECT_INSTRUCTIONS)]
        : []),
    ],
    projectRoot,
    warnings,
    pathPolicy,
    sandboxed,
    env: { ...global.env, ...project.env },
    hooks,
    limits: global.limits,
    features: global.features,
    roleDirs: roleDirs(configDir, projectRoot),
    systemPrompt: prompts,
    workspaceKind,
  };
}

/** The roles this agent's workspace defines (node, then the project); throws when invalid. */
export function configRoles(config: Pick<AgentConfig, 'roleDirs'>): Record<string, RolePreset> {
  return readRoles(config.roleDirs ?? []);
}

/** Set in the node's config.json, which no longer defines roles (roles.ts reads role files). */
export function legacyRoleConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = readJson(path.join(defaultConfigDir(env), 'config.json')) as {
    roles?: unknown;
    features?: { agentTeam?: { kinds?: unknown } };
  } | null;
  return !!raw && (raw.roles !== undefined || raw.features?.agentTeam?.kinds !== undefined);
}

const pathPolicySchema = z.object({
  denyRead: z.array(z.string()),
  allowRead: z.array(z.string()),
  allowWrite: z.array(z.string()),
  denyWrite: z.array(z.string()),
  sharedWrite: z.array(z.string()).optional(),
});

function parsePathPolicy(value: string | undefined): PathPolicy | undefined {
  if (!value) return undefined;
  try {
    const { sharedWrite, ...rest } = pathPolicySchema.parse(JSON.parse(value));
    return sharedWrite ? { ...rest, sharedWrite } : rest;
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
