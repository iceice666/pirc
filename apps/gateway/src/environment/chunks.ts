import { open, mkdir, readFile, rm } from 'node:fs/promises';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { RESULT_BYTES } from './protocol.js';

/** Private supervisor-owned staging directory; never mount it into an executor. */
export class ChunkStore {
  private sizes = new Map<string, number>();
  /** Exclusive per-link staging directory. No recovered chunk may resume execution. */
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Only our UUID chunk names, never unrelated supervisor data. The owner must
    // fence the prior link before constructing another store for this directory.
    for (const name of readdirSync(directory)) {
      if (/^[a-f0-9-]{36}$/.test(name)) rmSync(path.join(directory, name), { force: true });
    }
  }
  private file(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid chunk ID');
    return path.join(this.directory, id);
  }
  async append(id: string, offset: number, total: number, bytes: Uint8Array): Promise<void> {
    if (
      total > RESULT_BYTES ||
      offset !== (this.sizes.get(id) ?? 0) ||
      offset + bytes.length > total
    )
      throw new Error('Invalid chunk offset');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = await open(this.file(id), offset === 0 ? 'wx' : 'r+', 0o600);
    try {
      let written = 0;
      while (written < bytes.length) {
        const result = await file.write(bytes, written, bytes.length - written, offset + written);
        if (!result.bytesWritten) throw new Error('Chunk write made no progress');
        written += result.bytesWritten;
      }
      await file.sync();
      this.sizes.set(id, offset + bytes.length);
    } finally {
      await file.close();
    }
  }
  async take(id: string): Promise<string> {
    if (!this.sizes.has(id)) throw new Error('Unknown chunk assembly');
    const value = await readFile(this.file(id));
    await this.discard(id);
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  }
  async discard(id: string): Promise<void> {
    this.sizes.delete(id);
    await rm(this.file(id), { force: true });
  }
}
