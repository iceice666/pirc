import { z } from 'zod';
import {
  artifactSchema,
  descriptorDigest,
  descriptorSchema,
  DESCRIPTOR_BYTES,
  CONTROL_BYTES,
  type Binding,
} from '../environment/protocol.js';
import { canonicalJson } from '../environment/json.js';
import { ENTRY_BYTES, type AuthorityEntry } from './contracts.js';

/** Model image expansion + text + provenance must fit one authoritative entry. */
export const TURN_IMAGE_BYTES = 4 * 1024 * 1024;
export const turnInputSchema = z
  .object({
    runId: z.string().uuid(),
    turnId: z.string().uuid(),
    text: z
      .string()
      .refine((value) => Buffer.byteLength(value) <= 1024 * 1024, 'Turn text too large'),
    attachments: z.array(artifactSchema).max(16),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.attachments.reduce((total, item) => total + item.bytes, 0) > TURN_IMAGE_BYTES)
      context.addIssue({ code: 'custom', message: 'Turn image budget exceeded' });
    if (new Set(value.attachments.map((item) => item.artifactId)).size !== value.attachments.length)
      context.addIssue({ code: 'custom', message: 'Duplicate turn attachment' });
    for (const artifact of value.attachments) {
      if (
        !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(artifact.mimeType) ||
        artifact.availability !== 'available'
      )
        context.addIssue({ code: 'custom', message: 'Unavailable or unsupported turn image' });
    }
  });
export type TurnInput = z.infer<typeof turnInputSchema>;
export interface AuthorityTurn {
  input: TurnInput;
  descriptor: z.infer<typeof descriptorSchema>;
  entry: AuthorityEntry;
  branchId: string;
}

export function validateTurnInput(value: TurnInput, binding: Binding): TurnInput {
  canonicalJson(value, ENTRY_BYTES);
  const input = turnInputSchema.parse(value);
  for (const artifact of input.attachments) {
    if (
      artifact.nodeId !== binding.nodeId ||
      artifact.workspaceId !== binding.workspaceId ||
      artifact.sessionId !== binding.sessionId
    )
      throw new Error('Turn attachment owner mismatch');
  }
  return input;
}

export function validateTurnDescriptor(value: unknown, binding: Binding) {
  canonicalJson(value, DESCRIPTOR_BYTES);
  const descriptor = descriptorSchema.parse(value);
  if (canonicalJson(descriptor.binding, CONTROL_BYTES) !== canonicalJson(binding, CONTROL_BYTES))
    throw new Error('Turn descriptor binding mismatch');
  if (descriptor.revision !== descriptorDigest(descriptor))
    throw new Error('Turn descriptor digest mismatch');
  if (!descriptor.sandboxStatus.active) throw new Error('Turn environment sandbox unavailable');
  return descriptor;
}
