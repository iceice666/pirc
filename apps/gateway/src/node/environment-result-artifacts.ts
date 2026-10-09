import type { EnvironmentArtifacts } from '../environment/artifacts.js';
import type { Binding, Terminal } from '../environment/protocol.js';

const IMAGE_BYTES = 5 * 1024 * 1024;
const TOTAL_BYTES = 16 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Ingest returned bytes only, never a child-supplied host path or artifact identity. */
export async function persistExecutorArtifacts(
  terminal: Terminal,
  binding: Binding,
  storage: EnvironmentArtifacts,
  signal?: AbortSignal,
): Promise<Terminal> {
  if (terminal.artifacts.length) throw new Error('Executor cannot manufacture artifact references');
  const output = terminal.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return terminal;
  const content = output.content;
  if (!Array.isArray(content)) return terminal;
  const images: Array<{ bytes: Buffer; mimeType: string }> = [];
  let total = 0;
  // Validate all image entries before writing anything to the trusted store.
  for (const item of content) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || item.type !== 'image') continue;
    if (
      typeof item.data !== 'string' ||
      typeof item.mimeType !== 'string' ||
      !IMAGE_TYPES.has(item.mimeType) ||
      item.data.length > 4 * Math.ceil(IMAGE_BYTES / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data)
    )
      throw new Error('Invalid executor image artifact');
    const bytes = Buffer.from(item.data, 'base64');
    if (!bytes.length || bytes.length > IMAGE_BYTES || bytes.toString('base64') !== item.data)
      throw new Error('Invalid executor image artifact');
    total += bytes.length;
    if (images.length >= 32 || total > TOTAL_BYTES)
      throw new Error('Executor artifact quota exceeded');
    images.push({ bytes, mimeType: item.mimeType });
  }
  if (!images.length) return terminal;
  const artifacts: Terminal['artifacts'] = [];
  try {
    for (const image of images) {
      signal?.throwIfAborted();
      artifacts.push(await storage.put(binding, image.bytes, image.mimeType));
    }
    signal?.throwIfAborted();
    return { ...terminal, artifacts };
  } catch (error) {
    await Promise.all(artifacts.map((artifact) => storage.removeUnreferenced(binding, artifact)));
    throw error;
  }
}
