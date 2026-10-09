import { z } from 'zod';
import { CONTRACT_VERSION, ERROR_CODES, type Result } from '../agent/ptc/contracts.js';
import { canonicalJson, type Json } from './json.js';
import { RESULT_BYTES, type Terminal } from './protocol.js';

const json = z.custom<Json>((value) => {
  try {
    canonicalJson(value, RESULT_BYTES);
    return true;
  } catch {
    return false;
  }
});
const resultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      contractVersion: z.literal(CONTRACT_VERSION),
      operationId: z.string().min(1).max(200),
      data: json,
      attachments: z
        .array(
          z
            .object({
              handle: z.string().min(1).max(200),
              mimeType: z.string().max(256),
              bytes: z
                .number()
                .int()
                .nonnegative()
                .max(32 * 1024 * 1024),
            })
            .strict(),
        )
        .max(32),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      contractVersion: z.literal(CONTRACT_VERSION),
      operationId: z.string().min(1).max(200),
      error: z
        .object({
          code: z.enum(ERROR_CODES),
          message: z.string().max(65536),
          operationId: z.string().min(1).max(200).optional(),
          outcome: z.enum(['not_started', 'completed', 'failed', 'cancelled', 'unknown']),
          docs: z
            .object({
              names: z.array(z.string().max(100)).max(256),
              registryVersion: z.string().max(256),
            })
            .strict()
            .optional(),
          data: json.optional(),
        })
        .strict(),
    })
    .strict(),
]);

/** A central service/child result is untrusted IPC, not a TypeScript assertion. */
export function validatePtcResult(value: unknown, operationId?: string): Result {
  canonicalJson(value, RESULT_BYTES);
  const result = resultSchema.parse(value) as Result;
  if (
    operationId !== undefined &&
    (result.operationId !== operationId ||
      (!result.ok &&
        result.error.operationId !== undefined &&
        result.error.operationId !== operationId))
  )
    throw new Error('PTC result operation identity mismatch');
  return result;
}
export function aliasPtcResult(value: Result, operationId: string): Result {
  return value.ok
    ? { ...value, operationId }
    : { ...value, operationId, error: { ...value.error, operationId } };
}
export function ptcTerminal(value: Result): Terminal {
  const result = validatePtcResult(value);
  const effect = result.ok
    ? 'completed'
    : result.error.outcome === 'not_started'
      ? 'not_started'
      : result.error.outcome === 'unknown'
        ? 'unknown'
        : 'completed';
  return {
    state: result.ok ? 'completed' : effect === 'unknown' ? 'unknown' : 'failed',
    effect,
    output: result as unknown as Json,
    artifacts: [],
    truncated: result.ok && result.truncated,
  };
}
