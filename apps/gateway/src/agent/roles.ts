/**
 * Roles: named presets an agent picks for a child or a delegation instead of
 * a model. A role fixes the model, thinking level, tool allowlist and role
 * instructions; only the user sets those, in role files.
 *
 * A role is a markdown file `<name>.md`: YAML front matter with optional
 * `description`, `model`, `thinking` and `tools`, and the role instructions
 * as the body. They are read from the built-in `general`, then the node's
 * `$PIRC_CONFIG_DIR/roles/`, then the workspace's `.pirc/roles/`; a later
 * file replaces a role of the same name as a whole. `.pirc/` is protected
 * from the agent's tools, so an agent cannot define or widen its own roles.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultConfigDir } from '../models.js';
import { parseSkillFile } from './skills.js';

export interface RolePreset {
  /** When to pick this role; shown to the agent that picks. */
  description?: string;
  /** Role instructions added to the system prompt of the agent started in this role. */
  instructions?: string;
  /**
   * Model patterns in order of preference: `provider/model-id`, where `*`
   * matches any characters within a part (a provider of `*` with id `gpt-5`,
   * or `openai` with id `*`). The first
   * catalog model that matches is used; the rest are fallbacks (`expandModels`).
   */
  models?: string[];
  thinking?: string;
  /** Tool allowlist (team coordination tools are always kept for teammates). */
  tools?: string[];
}

/** A role as the agent it applies to carries it. */
export interface AgentRole {
  name: string;
  instructions?: string;
  /** The role's model patterns; the agent falls back along them (Agent.stream). */
  models?: string[];
}

/** What a picking agent (or the gateway) is told about a role. */
export interface RoleBrief {
  name: string;
  description?: string | undefined;
  models?: string[] | undefined;
  thinking?: string | undefined;
  tools?: string[] | undefined;
}

export const DEFAULT_ROLES: Record<string, RolePreset> = {
  general: { description: 'General-purpose agent with the default model and all tools.' },
};

const ROLE_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const DESCRIPTION_LIMIT = 500;
const INSTRUCTIONS_LIMIT = 8000;
const FIELDS = ['description', 'model', 'thinking', 'tools'];

export function validateToolList(value: unknown, label = 'tools'): string[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error(`${label} must be an array of at most 64 tool names`);
  for (const name of value)
    if (typeof name !== 'string' || !TOOL_NAME.test(name))
      throw new Error(`Invalid tool name in ${label}: ${String(name).slice(0, 80)}`);
  return [...new Set(value as string[])];
}

const optionalText = (value: unknown, limit: number, label: string): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(label);
  return value.trim();
};

/** `tools` as a YAML list, or a comma-separated string. */
const toolList = (value: unknown, label: string): string[] | undefined => {
  if (value === undefined || value === null) return undefined;
  const list =
    typeof value === 'string'
      ? value
          .replace(/^\s*\[|\]\s*$/g, '')
          .split(',')
          .map((item) => item.trim().replace(/^(['"])(.*)\1$/, '$2'))
          .filter(Boolean)
      : value;
  return validateToolList(list, label);
};

/** One role file's text; `name` comes from its file name. */
export function parseRole(name: string, text: string): RolePreset {
  if (!ROLE_NAME.test(name) || ['parent', 'user'].includes(name))
    throw new Error(`Invalid role name: ${name} (lowercase letters, digits, - and _)`);
  const { meta, body } = parseSkillFile(text);
  const unknown = Object.keys(meta).filter((key) => !FIELDS.includes(key));
  if (unknown.length)
    throw new Error(`Unknown front matter for role ${name}: ${unknown.join(', ')}`);
  const description = optionalText(
    meta.description,
    DESCRIPTION_LIMIT,
    `Invalid description for role ${name} (at most ${DESCRIPTION_LIMIT} characters)`,
  );
  const models = modelList(meta.model, name);
  const thinking = optionalText(meta.thinking, 20, `Invalid thinking level for role ${name}`);
  if (thinking !== undefined && !THINKING.has(thinking))
    throw new Error(`Invalid thinking level for role ${name}: ${thinking}`);
  const tools = toolList(meta.tools, `tools for role ${name}`);
  if (body.length > INSTRUCTIONS_LIMIT)
    throw new Error(`Instructions for role ${name} exceed ${INSTRUCTIONS_LIMIT} characters`);
  return {
    ...(description === undefined ? {} : { description }),
    ...(body ? { instructions: body } : {}),
    ...(models === undefined ? {} : { models }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(tools === undefined ? {} : { tools }),
  };
}

const MODEL_PATTERN = /^[^/\s,]+\/[^\s,]+$/;

/** `model` as one pattern, a YAML list, or a comma-separated string. */
function modelList(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const list =
    typeof value === 'string'
      ? value
          .replace(/^\s*\[|\]\s*$/g, '')
          .split(',')
          .map((item) => item.trim().replace(/^(['"])(.*)\1$/, '$2'))
          .filter(Boolean)
      : value;
  if (!Array.isArray(list) || !list.length || list.length > 20)
    throw new Error(`Invalid model for role ${name}: give 1–20 provider/model-id patterns`);
  for (const item of list)
    if (typeof item !== 'string' || item.length > 200 || !MODEL_PATTERN.test(item))
      throw new Error(
        `Invalid model for role ${name}: ${String(item).slice(0, 80)} (use provider/model-id; * matches within a part)`,
      );
  return [...new Set(list as string[])];
}

const globPart = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );

/**
 * The catalog models matching `patterns`, in pattern order and, within one
 * pattern, in the catalog's (models.json) order, without duplicates.
 */
export function expandModels(
  patterns: string[],
  providers: Record<string, { models: Array<{ id: string }> }>,
): Array<{ provider: string; id: string }> {
  const out: Array<{ provider: string; id: string }> = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const slash = pattern.indexOf('/');
    const provider = globPart(pattern.slice(0, slash));
    const id = globPart(pattern.slice(slash + 1));
    for (const [providerName, config] of Object.entries(providers)) {
      if (!provider.test(providerName)) continue;
      for (const model of config.models) {
        const key = `${providerName}/${model.id}`;
        if (!id.test(model.id) || seen.has(key)) continue;
        seen.add(key);
        out.push({ provider: providerName, id: model.id });
      }
    }
  }
  return out;
}

/** Where role files are looked up, lowest precedence first. */
export function roleDirs(configDir: string, workspace: string): string[] {
  return [path.join(configDir, 'roles'), path.join(workspace, '.pirc', 'roles')];
}

/** The roles in `dirs` over the built-in ones. Throws on an invalid role file. */
export function readRoles(dirs: string[]): Record<string, RolePreset> {
  const roles: Record<string, RolePreset> = { ...DEFAULT_ROLES };
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || !entry.endsWith('.md')) continue;
      const file = path.join(dir, entry);
      try {
        roles[entry.slice(0, -3)] = parseRole(entry.slice(0, -3), readFileSync(file, 'utf8'));
      } catch (error) {
        throw new Error(`${file}: ${(error as Error).message}`);
      }
    }
  }
  return roles;
}

/** A workspace's roles as its agents resolve them (node roles, then `.pirc/roles/`). */
export function loadRoles(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, RolePreset> {
  return readRoles(roleDirs(defaultConfigDir(env), workspace));
}

export function roleBriefs(roles: Record<string, RolePreset>): RoleBrief[] {
  return Object.entries(roles).map(([name, { description, models, thinking, tools }]) => ({
    name,
    ...(description ? { description } : {}),
    ...(models ? { models } : {}),
    ...(thinking ? { thinking } : {}),
    ...(tools ? { tools } : {}),
  }));
}

/** One line per role, for the picking agent. */
export function describeRoles(roles: RoleBrief[]): string {
  return roles
    .map(({ name, description, models, thinking, tools }) => {
      const traits = [
        models && `model ${models.join(' > ')}`,
        thinking && `thinking ${thinking}`,
        tools && `tools: ${tools.join(', ')}`,
      ]
        .filter(Boolean)
        .join('; ');
      return `- ${name}: ${description ?? '(no description)'}${traits ? ` [${traits}]` : ''}`;
    })
    .join('\n');
}

/** The role section of a system prompt. */
export function renderRole(role: AgentRole): string {
  return role.instructions
    ? [
        `## Role: ${role.name}`,
        '',
        'You were started in this role. Follow these role instructions alongside the task; they do not widen your tools, sandbox or approvals.',
        '',
        role.instructions,
      ].join('\n')
    : '';
}
