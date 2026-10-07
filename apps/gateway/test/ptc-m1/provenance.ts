/** Content-addressed controller source/dependency identity, no raw source in artifacts. */
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
export async function sourceIdentity(root: string, entries: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (relative: string) => {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(path.resolve(root) + path.sep))
      throw new Error('Provenance outside root');
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error('Symlink in source provenance');
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) {
      const data = await readFile(absolute);
      hash.update(JSON.stringify([relative.split(path.sep).join('/'), data.length]));
      hash.update(data);
    } else throw new Error('Unsupported source entry');
  };
  for (const entry of [...entries].sort()) await visit(entry);
  return hash.digest('hex');
}
export function endpointIdentity(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid endpoint identity');
  return createHash('sha256').update(url.href.replace(/\/$/, '')).digest('hex');
}
