import { z } from 'zod';
import { canonicalJson, digest } from './json.js';
import { REQUEST_BYTES, intentSchema, type ExecutionIntent } from './protocol.js';
import { validateSchema } from '../agent/ptc/schema.js';

const args = z.record(z.unknown());
const action = z
  .object({
    tool: z.string().max(100),
    kind: z.enum(['command', 'input', 'script']),
    text: z.string().max(65536),
    cwd: z.string().max(4096),
  })
  .strict();
const final = { arguments: args, finalArgumentDigest: z.string().regex(/^[a-f0-9]{64}$/) };
export const brokerSchemas = {
  ptc_inner_start: z.object({ intent: intentSchema }).strict(),
  ptc_inner_result: z.object({ intent: intentSchema, result: z.unknown() }).strict(),
  ptc_inner_delivered: z.object({ innerOperationId: z.string().uuid() }).strict(),
  ptc_preflight: z.object({ intent: intentSchema }).strict(),
  ptc_preflight_done: z.object({ intent: intentSchema, arguments: args }).strict(),
  ptc_post: z.object({ intent: intentSchema }).strict(),
  ptc_post_done: z.object({ intent: intentSchema }).strict(),
  ptc_central: z.object({ intent: intentSchema, arguments: args }).strict(),
  lease: z.object({ root: z.string().min(1).max(4096) }).strict(),
  approval: z.object({ action, reason: z.string().max(8192), ...final }).strict(),
  classify: z
    .object({
      action,
      hint: z.string().max(8192),
      choices: z
        .array(
          z
            .object({
              provider: z.string().optional(),
              id: z.string().optional(),
              thinking: z.string().optional(),
            })
            .strict(),
        )
        .max(32),
      timeoutMs: z.number().positive().max(300_000),
      useMemory: z.boolean(),
    })
    .strict(),
  browser: z
    .object({
      op: z.enum([
        'fetch',
        'navigate',
        'snapshot',
        'click',
        'type',
        'select',
        'press',
        'wait_for',
        'screenshot',
        'tabs',
        'handoff',
        'wait_control',
        'release',
        'record',
      ]),
      args,
      ...final,
    })
    .strict(),
  sandbox: z.object({ op: z.enum(['network', 'exec']), args, ...final }).strict(),
  ui: z.object({ title: z.string().max(1024), message: z.string().max(8192) }).strict(),
  background: z
    .object({
      tasks: z
        .array(
          z
            .object({
              id: z.string(),
              pid: z.number().int().positive().optional(),
              status: z.string(),
              startedAt: z.string(),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
} as const;
export type BrokerKind = keyof typeof brokerSchemas;

export function finalArgumentsDigest(
  intent: Pick<ExecutionIntent, 'executionId'>,
  arguments_: Record<string, unknown>,
  action?: unknown,
): string {
  return digest(
    {
      executionId: intent.executionId,
      arguments: arguments_,
      ...(action === undefined ? {} : { action }),
    },
    REQUEST_BYTES,
  );
}

/** Validate before dispatch into trusted node services, including hook-final argument schema. */
export function validateBroker(
  kind: BrokerKind,
  payload: unknown,
  intent: ExecutionIntent,
  schema?: Record<string, unknown>,
): Record<string, any> {
  canonicalJson(payload, REQUEST_BYTES);
  const parsed = brokerSchemas[kind].parse(payload) as Record<string, any>;
  if ('finalArgumentDigest' in parsed) {
    if (
      parsed.finalArgumentDigest !== finalArgumentsDigest(intent, parsed.arguments, parsed.action)
    )
      throw new Error('Invalid final argument digest');
    if (!schema) throw new Error('Missing trusted capability schema');
    const errors = validateSchema(parsed.arguments, schema);
    if (errors.length) throw new Error(`Invalid final arguments: ${errors.join('; ')}`);
  }
  return parsed;
}
