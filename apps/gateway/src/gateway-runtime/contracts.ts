import { z } from 'zod';
import { bindingSchema } from '../environment/protocol.js';
import { canonicalJson, type Json } from '../environment/json.js';
import type { SessionEntry } from '../agent/session-store.js';

export const ENTRY_BYTES = 8 * 1024 * 1024;
const id = z.string().uuid();
/** Existing node transcript IDs and gateway directory IDs are not bare UUIDs. */
export const legacyReferenceSchema = z.union([
  id,
  z.string().regex(/^[a-f0-9]{16}$/),
  z.string().regex(/^session_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
]);
const timestamp = z.number().finite().nonnegative();
const json = z.custom<Json>((value) => {
  try {
    canonicalJson(value, ENTRY_BYTES);
    return true;
  } catch {
    return false;
  }
});
const text = z
  .object({ type: z.literal('text'), text: z.string(), textSignature: z.string().optional() })
  .strict();
const image = z
  .object({ type: z.literal('image'), data: z.string(), mimeType: z.string() })
  .strict();
const object = json.refine(
  (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
);
const message = z.discriminatedUnion('role', [
  z
    .object({
      role: z.literal('user'),
      content: z.union([z.string(), z.array(z.union([text, image]))]),
      timestamp,
    })
    .strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.array(
        z.union([
          text,
          z
            .object({
              type: z.literal('thinking'),
              thinking: z.string(),
              signature: z.string().optional(),
              redacted: z.boolean().optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal('toolCall'),
              id: z.string(),
              name: z.string(),
              arguments: object,
              thoughtSignature: z.string().optional(),
            })
            .strict(),
        ]),
      ),
      api: z.string(),
      provider: z.string(),
      model: z.string(),
      canonicalProvider: z.string().optional(),
      responseId: z.string().optional(),
      responseModel: z.string().optional(),
      usage: z
        .object({
          input: timestamp,
          output: timestamp,
          cacheRead: timestamp,
          cacheWrite: timestamp,
          totalTokens: timestamp,
        })
        .strict(),
      stopReason: z.enum(['stop', 'length', 'toolUse', 'error', 'aborted']),
      errorMessage: z.string().optional(),
      timestamp,
      completedAt: timestamp.optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal('toolResult'),
      toolCallId: z.string(),
      toolName: z.string(),
      content: z.array(z.union([text, image])),
      details: json.optional(),
      isError: z.boolean(),
      timestamp,
    })
    .strict(),
  z
    .object({
      role: z.literal('custom'),
      customType: z.string(),
      content: z.string(),
      display: z.boolean(),
      details: json.optional(),
      timestamp,
    })
    .strict(),
  z
    .object({
      role: z.literal('compactionSummary'),
      summary: z.string(),
      tokensBefore: timestamp,
      timestamp,
    })
    .strict(),
]);

/** Service-owned entry payloads; IDs, parents and timestamps cannot be supplied by a worker. */
export const entrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message }).strict(),
  z.object({ type: z.literal('custom'), customType: z.string(), data: json }).strict(),
  z
    .object({
      type: z.literal('compaction'),
      summary: z.string(),
      firstKeptEntryId: id,
      tokensBefore: timestamp,
      details: json.optional(),
    })
    .strict(),
  z.object({ type: z.literal('model_change'), provider: z.string(), modelId: z.string() }).strict(),
  z.object({ type: z.literal('thinking_level_change'), thinkingLevel: z.string() }).strict(),
  z
    .object({
      type: z.literal('session_info'),
      name: z.string(),
      source: z.enum(['user', 'auto']).optional(),
    })
    .strict(),
]);
export type EntryInput = z.infer<typeof entrySchema>;
export type AuthorityEntry = SessionEntry;

/** Trusted supervisor lifecycle contracts, deliberately not Environment wire messages. */
export const transferSchema = z
  .object({
    transferId: id,
    binding: bindingSchema,
    legacySessionIds: z.array(legacyReferenceSchema).max(1024),
  })
  .strict()
  .refine(
    (value) => new Set(value.legacySessionIds).size === value.legacySessionIds.length,
    'Duplicate legacy session',
  );
export type WriterTransfer = z.infer<typeof transferSchema>;
export interface WriterFenceReceipt extends WriterTransfer {
  fenced: true;
}
export interface WriterLease {
  binding: z.infer<typeof bindingSchema>;
  branchId: string;
}
