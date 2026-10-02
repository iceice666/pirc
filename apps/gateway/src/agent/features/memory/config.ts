import { z } from 'zod';
import { thinkingLevels } from '../../../models.js';

const modelChoice = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  // `max` (accepted for configs carried over from Pi) maps to our highest level.
  thinking: z
    .enum([...thinkingLevels, 'max'])
    .transform((level) => (level === 'max' ? 'xhigh' : level))
    .optional(),
});
const positive = z.number().int().positive();
export const memorySchema = z.object({
  enabled: z.boolean().default(true),
  passive: z.boolean().default(false),
  observeAfterTokens: positive.default(10_000),
  reflectAfterTokens: positive.default(20_000),
  observerChunkMaxTokens: positive.optional(),
  compactAfterTokens: positive.default(81_000),
  compactAfterTokensMode: z.enum(['calibrated', 'ratio']).default('calibrated'),
  compactAfterTokensRatio: z.number().gt(0).lt(1).default(0.68),
  observationsPoolMaxTokens: positive.default(20_000),
  observationsPoolTargetTokens: positive.optional(),
  agentMaxTurns: positive.default(16),
  agentMaxTokens: positive.default(32_000),
  model: modelChoice.optional(),
  fallbackModels: z.array(modelChoice).default([]),
  rateLimitCooldownMs: positive.default(900_000),
  showWorkerNotifications: z.boolean().default(true),
  /** Cross-session memory shared by every main session (and worktree) of a repository. */
  workspace: z
    .object({
      enabled: z.boolean().default(true),
      /** Budget for the notes frozen into a new session's system prompt (and the promoter's target). */
      maxTokens: positive.default(3_000),
      shutdownTimeoutMs: positive.default(20_000),
    })
    .default({}),
});
export type MemoryConfig = z.infer<typeof memorySchema>;

interface MemoryValidation {
  config: MemoryConfig;
  warning?: string;
}

// Agent settings are loaded once. Workers and panel refreshes reuse that result.
const validations = new WeakMap<Record<string, unknown>, MemoryValidation>();
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fieldPath = (parts: (string | number)[]) =>
  'features.observationalMemory' +
  parts.map((part) => (typeof part === 'number' ? `[${part}]` : `.${part}`)).join('');

// Never use issue.message: enum errors can include the rejected config value.
function reason(issue: z.ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `expected ${issue.expected}`;
    case 'invalid_enum_value':
      return 'expected a supported option';
    case 'too_small':
      return `must be ${issue.inclusive ? 'at least' : 'greater than'} ${issue.minimum}`;
    case 'too_big':
      return `must be ${issue.inclusive ? 'at most' : 'less than'} ${issue.maximum}`;
    case 'not_finite':
      return 'must be finite';
    default:
      return 'invalid field';
  }
}

/** Validate once per loaded settings object, without logging or exposing values. */
export function validateMemoryConfig(features: Record<string, unknown>): MemoryValidation {
  const cached = validations.get(features);
  if (cached) return cached;
  const raw = features.observationalMemory ?? {};
  const parsed = memorySchema.safeParse(raw);
  const diagnostics = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${fieldPath(issue.path)}: ${reason(issue)}`);
  const unknownKeys = (value: unknown, keys: string[], parts: (string | number)[]) => {
    if (!object(value)) return;
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) {
        // Quote field names so punctuation/newlines cannot impersonate another warning.
        diagnostics.push(`${fieldPath(parts)}[${JSON.stringify(key)}]: unknown field (ignored)`);
      }
    }
  };
  unknownKeys(raw, Object.keys(memorySchema.shape), []);
  if (object(raw)) {
    unknownKeys(raw.model, Object.keys(modelChoice.shape), ['model']);
    if (Array.isArray(raw.fallbackModels))
      raw.fallbackModels.forEach((model, index) =>
        unknownKeys(model, Object.keys(modelChoice.shape), ['fallbackModels', index]),
      );
    unknownKeys(raw.workspace, Object.keys(memorySchema.shape.workspace.removeDefault().shape), [
      'workspace',
    ]);
  }
  const result: MemoryValidation = {
    config: parsed.success ? parsed.data : memorySchema.parse({}),
    ...(diagnostics.length
      ? {
          warning:
            `Observational memory configuration: ${
              parsed.success
                ? 'unknown fields were ignored; valid settings remain in effect.'
                : 'invalid settings; the entire configuration uses defaults (enabled=true, workspace.enabled=true), even if you configured it as disabled.'
            } ` +
            diagnostics.join('; ') +
            ' Fix features.observationalMemory in the node config.json and restart the agent. PIRC_MEMORY_PASSIVE still overrides passive.',
        }
      : {}),
  };
  validations.set(features, result);
  return result;
}

export function memoryConfigFrom(features: Record<string, unknown>): MemoryConfig {
  const config = validateMemoryConfig(features).config;
  return {
    ...config,
    ...(process.env.PIRC_MEMORY_PASSIVE
      ? {
          passive: /^(1|true|yes|on)$/i.test(process.env.PIRC_MEMORY_PASSIVE.trim()),
        }
      : {}),
  };
}
