import { z } from 'zod';
import { canonicalJson, digest, parseJson, type Json } from './json.js';

/** Foundation only: not negotiated or dispatched on the production node link yet. */
export const ENVIRONMENT_PROTOCOL_VERSION = 1;
export const CONTROL_BYTES = 65_536;
export const REQUEST_BYTES = 8 * 1024 * 1024;
export const RESULT_BYTES = 16 * 1024 * 1024;
export const DESCRIPTOR_BYTES = 1024 * 1024;
const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const json = z.custom<Json>((value) => {
  try {
    canonicalJson(value, RESULT_BYTES);
    return true;
  } catch {
    return false;
  }
}, 'Invalid bounded JSON');
const object = json.refine(
  (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  'Expected JSON object',
);

export const bindingSchema = z
  .object({
    nodeId: name,
    workspaceId: z.string().min(3).max(201),
    sessionId: id,
    writerEpoch: id,
    executorEpoch: id,
  })
  .strict()
  .refine(
    (binding) =>
      binding.workspaceId.startsWith(`${binding.nodeId}:`) &&
      name.safeParse(binding.workspaceId.slice(binding.nodeId.length + 1)).success,
    'Workspace must be node-qualified',
  );
export type Binding = z.infer<typeof bindingSchema>;

export const intentSchema = z
  .object({
    binding: bindingSchema,
    executionId: id,
    runId: id,
    turnId: id,
    toolCallId: id,
    parentExecutionId: id.optional(),
    innerOperationId: id.optional(),
    descriptorRevision: hash,
    policyRevision: hash,
    capability: z.string().regex(/^[a-z][a-zA-Z0-9_.]{0,99}$/),
    arguments: object,
    argumentDigest: hash,
    budgetMs: z.number().int().positive().max(3_600_000),
    ptc: z
      .object({
        branchId: id,
        revision: id,
        store: z.string().max(1_048_578),
        untrusted: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(64),
        images: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => !!value.parentExecutionId === !!value.innerOperationId,
    'Inner operation requires parent and inner IDs',
  )
  .refine(
    (value) => !value.ptc || (value.capability === 'ptc' && !value.parentExecutionId),
    'Only outer PTC carries a store snapshot',
  );
export type ExecutionIntent = z.infer<typeof intentSchema>;

export const artifactSchema = z
  .object({
    nodeId: name,
    workspaceId: z.string().min(3).max(201),
    sessionId: id,
    artifactId: id,
    digest: hash,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(32 * 1024 * 1024),
    mimeType: z.string().min(1).max(256),
    availability: z.enum(['available', 'unavailable']),
  })
  .strict();

export const errorSchema = z
  .object({
    code: z.enum([
      'incompatible',
      'invalid_binding',
      'stale_revision',
      'stale_epoch',
      'unavailable_sandbox',
      'approval_denied',
      'quota_exceeded',
      'expired',
      'cancelled',
      'failed',
      'unknown',
      'conflict',
    ]),
    message: z.string().max(8192),
  })
  .strict();

export const terminalSchema = z
  .object({
    state: z.enum(['rejected', 'completed', 'failed', 'cancelled', 'unknown']),
    effect: z.enum(['not_started', 'completed', 'unknown']),
    output: json.optional(),
    error: errorSchema.optional(),
    truncated: z.boolean(),
    artifacts: z.array(artifactSchema).max(256),
  })
  .strict()
  .refine(
    (value) => value.state !== 'rejected' || value.effect === 'not_started',
    'Rejection cannot have effects',
  )
  .refine(
    (value) => value.state !== 'unknown' || value.effect === 'unknown',
    'Unknown state requires unknown effects',
  );
export type Terminal = z.infer<typeof terminalSchema>;

export const eventSchema = z
  .object({
    binding: bindingSchema,
    executionId: id,
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    kind: z.enum(['progress', 'approval_requested', 'output', 'artifact']),
    payload: json,
  })
  .strict();
export type ExecutionEvent = z.infer<typeof eventSchema>;

export const recordSchema = z
  .object({
    binding: bindingSchema,
    executionId: id,
    argumentDigest: hash,
    state: z.enum([
      'rejected',
      'accepted',
      'running',
      'completed',
      'failed',
      'cancelled',
      'unknown',
    ]),
    effect: z.enum(['not_started', 'completed', 'unknown']),
    finalSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cancelRequested: z.boolean(),
    terminal: terminalSchema.optional(),
    resultDigest: hash.optional(),
    acknowledged: z.boolean(),
    reclaimed: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const active = value.state === 'accepted' || value.state === 'running';
    if (active && (value.terminal || value.resultDigest || value.acknowledged || value.reclaimed))
      context.addIssue({
        code: 'custom',
        message: 'Active record cannot contain terminal evidence',
      });
    if (!active && (!value.resultDigest || (!value.terminal && !value.reclaimed)))
      context.addIssue({
        code: 'custom',
        message: 'Terminal record requires a result or tombstone',
      });
    if (
      value.terminal &&
      (value.state !== value.terminal.state || value.effect !== value.terminal.effect)
    )
      context.addIssue({ code: 'custom', message: 'Terminal summary mismatch' });
    for (const artifact of value.terminal?.artifacts ?? []) {
      if (
        artifact.nodeId !== value.binding.nodeId ||
        artifact.workspaceId !== value.binding.workspaceId ||
        artifact.sessionId !== value.binding.sessionId
      )
        context.addIssue({ code: 'custom', message: 'Artifact ownership mismatch' });
    }
    if (value.reclaimed && (!value.acknowledged || value.terminal))
      context.addIssue({ code: 'custom', message: 'Invalid tombstone' });
    if (
      (value.state === 'accepted' || value.state === 'rejected') &&
      value.effect !== 'not_started'
    )
      context.addIssue({ code: 'custom', message: 'Unstarted record cannot have effects' });
  });
export type ExecutionRecord = z.infer<typeof recordSchema>;

export const descriptorSchema = z
  .object({
    binding: bindingSchema,
    version: z.literal(ENVIRONMENT_PROTOCOL_VERSION),
    revision: hash,
    policyRevision: hash,
    capabilityCatalog: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-zA-Z0-9_.]{0,99}$/),
            argumentSchema: object,
            resultSchema: object,
            placement: z.enum(['node', 'gateway']),
            effects: z.enum(['read', 'write', 'external']),
            concurrency: z.enum(['read', 'write', 'exclusive']),
            approval: z.enum(['none', 'policy', 'always']),
            hookRevision: hash,
          })
          .strict(),
      )
      .max(256),
    instructions: z
      .string()
      .refine((value) => Buffer.byteLength(value) <= 512 * 1024, 'Instructions too large'),
    skills: z
      .array(z.object({ name: z.string().max(256), description: z.string().max(4096) }).strict())
      .max(256),
    repositoryKey: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .optional(),
    lifecycleHooks: z
      .array(z.enum(['sessionStart', 'beforePrompt', 'agentSettled']))
      .max(3)
      .optional(),
    role: z.string().max(256),
    platform: z.enum(['linux', 'darwin']),
    cwdDisplay: z.string().max(4096),
    sandboxStatus: z
      .object({ active: z.boolean(), reason: z.string().max(8192).optional() })
      .strict(),
    limits: z
      .object({
        maxActive: z.number().int().positive().max(4),
        maxBudgetMs: z.number().int().positive().max(3_600_000),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.capabilityCatalog.map((entry) => entry.name)).size ===
      value.capabilityCatalog.length,
    'Duplicate capability',
  );
export type Descriptor = z.infer<typeof descriptorSchema>;

export interface Environment {
  describe(binding: Binding): Promise<Descriptor>;
  start(intent: ExecutionIntent): Promise<ExecutionRecord>;
  status(binding: Binding, executionId: string): Promise<ExecutionRecord>;
  cancel(binding: Binding, executionId: string): Promise<ExecutionRecord>;
  ack(binding: Binding, executionId: string, resultDigest: string): Promise<void>;
}

const SIZE_REQUEST_ID = '00000000-0000-4000-8000-000000000000';
const header = { version: z.literal(ENVIRONMENT_PROTOCOL_VERSION), requestId: id };
export const messageSchema = z.discriminatedUnion('type', [
  z.object({ ...header, type: z.literal('environment.describe'), binding: bindingSchema }).strict(),
  z
    .object({ ...header, type: z.literal('environment.descriptor'), descriptor: descriptorSchema })
    .strict(),
  z.object({ ...header, type: z.literal('execution.start'), intent: intentSchema }).strict(),
  z.object({ ...header, type: z.literal('workspace.snapshot'), binding: bindingSchema }).strict(),
  z
    .object({
      ...header,
      type: z.literal('workspace.snapshot.result'),
      binding: bindingSchema,
      repositoryKey: z.string().regex(/^[a-f0-9]{16}$/),
      items: json,
    })
    .strict(),
  z
    .object({
      ...header,
      type: z.literal('workspace.append'),
      binding: bindingSchema,
      input: object,
    })
    .strict(),
  z
    .object({
      ...header,
      type: z.literal('workspace.append.result'),
      binding: bindingSchema,
      item: json,
    })
    .strict(),
  z
    .object({
      ...header,
      type: z.literal('ptc.central'),
      intent: intentSchema,
      finalArguments: object.optional(),
    })
    .strict(),
  z.object({ ...header, type: z.literal('ptc.central.status'), intent: intentSchema }).strict(),
  z
    .object({
      ...header,
      type: z.literal('ptc.central.cancel'),
      binding: bindingSchema,
      executionId: id,
    })
    .strict(),
  z
    .object({
      ...header,
      type: z.literal('ptc.central.cancelled'),
      binding: bindingSchema,
      executionId: id,
    })
    .strict(),
  z
    .object({
      ...header,
      type: z.literal('ptc.central.error'),
      binding: bindingSchema,
      executionId: id,
      error: errorSchema,
    })
    .strict(),
  z
    .object({
      ...header,
      type: z.literal('ptc.central.result'),
      binding: bindingSchema,
      executionId: id,
      result: json,
    })
    .strict(),
  z
    .object({
      ...header,
      type: z.literal('execution.status'),
      binding: bindingSchema,
      executionId: id,
    })
    .strict(),
  z
    .object({
      ...header,
      type: z.literal('execution.cancel'),
      binding: bindingSchema,
      executionId: id,
    })
    .strict(),
  z
    .object({
      ...header,
      type: z.literal('execution.ack'),
      binding: bindingSchema,
      executionId: id,
      resultDigest: hash,
    })
    .strict(),
  z.object({ ...header, type: z.literal('execution.event'), event: eventSchema }).strict(),
  z.object({ ...header, type: z.literal('execution.result'), record: recordSchema }).strict(),
  z.object({ ...header, type: z.literal('execution.reply'), record: recordSchema }).strict(),
  z.object({ ...header, type: z.literal('execution.acknowledged') }).strict(),
  z
    .object({
      ...header,
      type: z.literal('artifact.pin'),
      binding: bindingSchema,
      artifact: artifactSchema,
    })
    .strict(),
  z.object({ ...header, type: z.literal('artifact.pinned') }).strict(),
  z
    .object({
      ...header,
      type: z.literal('artifact.fetch'),
      binding: bindingSchema,
      artifact: artifactSchema,
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(32768),
    })
    .strict(),
  z
    .object({
      ...header,
      type: z.literal('artifact.chunk'),
      offset: z.number().int().nonnegative(),
      data: z.string().max(43692),
    })
    .strict(),
  z.object({ ...header, type: z.literal('environment.error'), error: errorSchema }).strict(),
]);
export type EnvironmentMessage = z.infer<typeof messageSchema>;

/** Hash every identity/policy/budget field as well as arguments; request correlation is separate. */
export function intentDigest(
  intent: Omit<ExecutionIntent, 'argumentDigest'> | ExecutionIntent,
): string {
  const { argumentDigest: _ignored, ...content } = intent as ExecutionIntent;
  return digest(content, REQUEST_BYTES);
}
export function validateIntent(value: unknown): ExecutionIntent {
  canonicalJson(value, REQUEST_BYTES);
  canonicalJson(
    {
      version: ENVIRONMENT_PROTOCOL_VERSION,
      requestId: SIZE_REQUEST_ID,
      type: 'execution.start',
      intent: value,
    },
    REQUEST_BYTES,
  );
  const intent = intentSchema.parse(value);
  if (intent.argumentDigest !== intentDigest(intent)) throw new Error('Intent digest mismatch');
  return intent;
}
export function descriptorDigest(value: Omit<Descriptor, 'revision'> | Descriptor): string {
  const { revision: _ignored, ...content } = value as Descriptor;
  return digest(content, DESCRIPTOR_BYTES);
}

/** Logical messages only: future transport must chunk data, not send 16 MiB control frames. */
export function decodeMessage(source: string): EnvironmentMessage {
  const message = messageSchema.parse(parseJson(source, RESULT_BYTES));
  const limit =
    message.type === 'execution.start' ||
    message.type === 'ptc.central' ||
    message.type === 'ptc.central.status' ||
    message.type === 'workspace.append'
      ? REQUEST_BYTES
      : message.type === 'environment.descriptor'
        ? DESCRIPTOR_BYTES
        : message.type === 'execution.result' ||
            message.type === 'execution.reply' ||
            message.type === 'ptc.central.result' ||
            message.type === 'workspace.snapshot.result' ||
            message.type === 'workspace.append.result'
          ? RESULT_BYTES
          : CONTROL_BYTES;
  if (Buffer.byteLength(source) > limit) throw new Error('Message exceeds byte limit');
  if (
    message.type === 'execution.start' ||
    message.type === 'ptc.central' ||
    message.type === 'ptc.central.status'
  )
    validateIntent(message.intent);
  if (
    message.type === 'environment.descriptor' &&
    message.descriptor.revision !== descriptorDigest(message.descriptor)
  )
    throw new Error('Descriptor digest mismatch');
  return message;
}
/** Validate exactly the correlated envelope that journaled data must fit on replay. */
export function validateEventDelivery(event: ExecutionEvent): void {
  encodeMessage({
    version: ENVIRONMENT_PROTOCOL_VERSION,
    requestId: SIZE_REQUEST_ID,
    type: 'execution.event',
    event,
  });
}
export function validateRecordDelivery(record: ExecutionRecord): void {
  encodeMessage({
    version: ENVIRONMENT_PROTOCOL_VERSION,
    requestId: SIZE_REQUEST_ID,
    type: 'execution.result',
    record,
  });
}

export function encodeMessage(message: EnvironmentMessage): string {
  const source = canonicalJson(message, RESULT_BYTES);
  decodeMessage(source);
  return source;
}
