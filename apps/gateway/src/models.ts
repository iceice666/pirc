/**
 * Model providers are configured once, on the gateway (`models.json`), and
 * pushed to every node over the node link. A node hands them to each agent
 * process it starts on the agent's first stdin line, so provider settings
 * and keys never live in a node's own configuration, environment or disk.
 *
 * The gateway resolves API key references (`apiKeyEnv`, `apiKeyFile`,
 * `apiKeyCommand`) when it loads the file; nodes and agents only ever see
 * the resolved `apiKey`. A reload (SIGHUP) reaches agents started afterwards.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PIRC_CONFIG_DIR ?? path.join(os.homedir(), '.config', '.pirc');
}

/** The gateway's provider file: `PIRC_MODELS_FILE`, default `$PIRC_CONFIG_DIR/models.json`. */
export function defaultModelsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.PIRC_MODELS_FILE ?? path.join(defaultConfigDir(env), 'models.json');
}

export function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  contextWindow: z.number().int().positive().default(200_000),
  maxTokens: z.number().int().positive().default(32_000),
  reasoning: z.boolean().default(false),
  input: z.array(z.enum(['text', 'image'])).default(['text']),
  compat: z.record(z.unknown()).default({}),
});

const providerBase = z.object({
  api: z.enum(['openai-chat', 'anthropic-messages']),
  baseUrl: z.string().url(),
  headers: z.record(z.string()).default({}),
  compat: z.record(z.unknown()).default({}),
  models: z.array(modelSchema).min(1),
});

/** A provider in `models.json`: the key may be literal or referenced indirectly. */
const providerSourceSchema = providerBase.extend({
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  apiKeyFile: z.string().optional(),
  apiKeyCommand: z.array(z.string()).min(1).optional(),
});

/** A provider as nodes and agents receive it: the key is already resolved. */
const providerSchema = providerBase.extend({ apiKey: z.string().optional() });

export const modelRefSchema = z.object({
  provider: z.string(),
  id: z.string(),
  thinking: z.enum(thinkingLevels).optional(),
});

const modelsFileSchema = z
  .object({
    providers: z.record(providerSourceSchema).default({}),
    defaultModel: modelRefSchema.optional(),
  })
  .strict();

/** Resolved providers, as sent over the node link and to agents. */
export const modelsSchema = z.object({
  providers: z.record(providerSchema).default({}),
  defaultModel: modelRefSchema.optional(),
});

export type ModelConfig = z.infer<typeof modelSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
export type ModelRef = z.infer<typeof modelRefSchema>;
export type ModelsConfig = z.infer<typeof modelsSchema>;

export const emptyModels = (): ModelsConfig => ({ providers: {} });

function resolveApiKey(
  name: string,
  provider: z.infer<typeof providerSourceSchema>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  let key: string | undefined;
  if (provider.apiKey) key = provider.apiKey;
  else if (provider.apiKeyEnv) key = env[provider.apiKeyEnv];
  else if (provider.apiKeyFile) key = readFileSync(expandHome(provider.apiKeyFile), 'utf8');
  else if (provider.apiKeyCommand) {
    const [command, ...args] = provider.apiKeyCommand;
    const result = Bun.spawnSync([expandHome(command!), ...args], { stderr: 'pipe' });
    if (result.exitCode !== 0)
      throw new Error(`apiKeyCommand for ${name} failed: ${result.stderr.toString().trim()}`);
    key = result.stdout.toString();
  }
  return key?.trim() || undefined;
}

/**
 * Read and resolve the gateway's `models.json`. A missing file yields no
 * providers (`null` is returned so the caller can warn); anything invalid,
 * including a key reference that cannot be resolved, throws.
 */
export function loadModelsFile(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelsConfig | null {
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${(error as Error).message}`);
  }
  const parsed = modelsFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${file}: ${parsed.error.message}`);
  const { defaultModel } = parsed.data;
  if (
    defaultModel &&
    !parsed.data.providers[defaultModel.provider]?.models.some(
      (model) => model.id === defaultModel.id,
    )
  )
    throw new Error(
      `Invalid ${file}: defaultModel ${defaultModel.provider}/${defaultModel.id} is not configured`,
    );
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, source] of Object.entries(parsed.data.providers)) {
    const {
      apiKey: _literal,
      apiKeyEnv: _env,
      apiKeyFile: _file,
      apiKeyCommand: _cmd,
      ...rest
    } = source;
    const apiKey = resolveApiKey(name, source, env);
    providers[name] = apiKey === undefined ? rest : { ...rest, apiKey };
  }
  return defaultModel ? { providers, defaultModel } : { providers };
}

/** Public model list for the browser (never includes keys). */
export function listModels(models: ModelsConfig): Array<Record<string, unknown>> {
  return Object.entries(models.providers).flatMap(([provider, config]) =>
    config.models.map((model) => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
      input: model.input,
    })),
  );
}

/** The current provider set; replaced wholesale on reload, never mutated. */
export class ModelStore {
  private value: ModelsConfig = emptyModels();
  get current(): ModelsConfig {
    return this.value;
  }
  set(models: ModelsConfig): void {
    this.value = models;
  }
}

/** The first line a node writes to an agent's stdin, before any RPC command. */
export interface ConfigureMessage {
  type: 'configure';
  models: ModelsConfig;
}
export const configureLine = (models: ModelsConfig): string =>
  `${JSON.stringify({ type: 'configure', models } satisfies ConfigureMessage)}\n`;
