import { createHash } from 'node:crypto';
import { z } from 'zod';
import { artifactSchema, bindingSchema, type Binding } from './protocol.js';
import type { EnvironmentArtifacts } from './artifacts.js';
import type { ImageContent } from '../agent/messages.js';

export const artifactPinSchema = z
  .object({ binding: bindingSchema, artifact: artifactSchema })
  .strict();

export const artifactRequestSchema = z
  .object({
    binding: bindingSchema,
    artifact: artifactSchema,
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(32768),
  })
  .strict();
export type ArtifactReference = z.infer<typeof artifactSchema>;
/** Requests/replies are bounded data messages on the shared authenticated link, not control text. */
export class ArtifactTransfer {
  constructor(
    private options: {
      authorize(binding: Binding): void;
      storage: EnvironmentArtifacts;
      online(): boolean;
    },
  ) {}
  pin(value: unknown): void {
    const request = artifactPinSchema.parse(value);
    this.options.authorize(request.binding);
    if (!this.options.online()) throw new Error('Artifact node offline');
    this.options.storage.pin(request.binding, request.artifact);
  }
  async fetch(value: unknown): Promise<{ data: string; offset: number }> {
    const request = artifactRequestSchema.parse(value);
    this.options.authorize(request.binding);
    if (!this.options.online()) throw new Error('Artifact node offline');
    const bytes = await this.options.storage.chunk(
      request.binding,
      request.artifact,
      request.offset,
      request.limit,
    );
    return { data: Buffer.from(bytes).toString('base64'), offset: request.offset };
  }
}

export async function resolveArtifact(
  binding: Binding,
  artifact: ArtifactReference,
  fetch: (
    request: z.infer<typeof artifactRequestSchema>,
  ) => Promise<{ data: string; offset: number }>,
  signal?: AbortSignal,
): Promise<Buffer> {
  artifact = artifactSchema.parse(artifact);
  if (
    artifact.nodeId !== binding.nodeId ||
    artifact.workspaceId !== binding.workspaceId ||
    artifact.sessionId !== binding.sessionId ||
    artifact.availability !== 'available'
  )
    throw new Error('Artifact unavailable or foreign owner');
  const result = Buffer.alloc(artifact.bytes);
  for (let offset = 0; offset < artifact.bytes; ) {
    signal?.throwIfAborted();
    const limit = Math.min(32768, artifact.bytes - offset);
    const reply = await fetch({ binding, artifact, offset, limit });
    const bytes = Buffer.from(reply.data, 'base64');
    if (
      reply.offset !== offset ||
      bytes.length !== limit ||
      bytes.toString('base64') !== reply.data
    )
      throw new Error('Invalid artifact transfer');
    bytes.copy(result, offset);
    offset += bytes.length;
  }
  if (createHash('sha256').update(result).digest('hex') !== artifact.digest)
    throw new Error('Artifact transfer digest mismatch');
  return result;
}

export async function modelArtifactImage(
  binding: Binding,
  artifact: ArtifactReference,
  fetch: Parameters<typeof resolveArtifact>[2],
  signal?: AbortSignal,
): Promise<ImageContent> {
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(artifact.mimeType))
    throw new Error('Unsupported model image');
  const bytes = await resolveArtifact(binding, artifact, fetch, signal);
  return { type: 'image', data: bytes.toString('base64'), mimeType: artifact.mimeType };
}

/** UI keeps ownership and unavailable state explicit; this never invents a gateway fs path. */
export function uiArtifact(artifact: ArtifactReference, online: boolean) {
  const reference = artifactSchema.parse(artifact);
  return { ...reference, availability: online ? reference.availability : ('unavailable' as const) };
}
