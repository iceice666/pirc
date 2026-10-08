import { createHash, randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import { artifactSchema, bindingSchema, CONTROL_BYTES, type Binding } from './protocol.js';
import { canonicalJson } from './json.js';
import type { z } from 'zod';

type Artifact = z.infer<typeof artifactSchema>;
const ARTIFACT_LIMIT = 32 * 1024 * 1024;
const SESSION_LIMIT = 256 * 1024 * 1024;
/** Node-owned opaque artifacts; the directory must be outside executor read/write roots. */
export class EnvironmentArtifacts {
  private db: Database;
  private verified = new Map<string, string>();
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'index.sqlite');
    this.db = new Database(file, { create: true });
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, owner TEXT NOT NULL, bytes INTEGER NOT NULL,
        digest TEXT NOT NULL, mime TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0);`);
  }
  private owner(binding: Binding): string {
    bindingSchema.parse(binding);
    return canonicalJson(
      { nodeId: binding.nodeId, workspaceId: binding.workspaceId, sessionId: binding.sessionId },
      CONTROL_BYTES,
    );
  }
  async put(binding: Binding, bytes: Uint8Array, mimeType: string): Promise<Artifact> {
    if (bytes.byteLength > ARTIFACT_LIMIT) throw new Error('Artifact exceeds limit');
    // Snapshot caller bytes before asynchronous writes/hash checks.
    const content = Buffer.from(bytes);
    const artifact = artifactSchema.parse({
      nodeId: binding.nodeId,
      workspaceId: binding.workspaceId,
      sessionId: binding.sessionId,
      artifactId: randomUUID(),
      digest: createHash('sha256').update(content).digest('hex'),
      bytes: content.byteLength,
      mimeType,
      availability: 'available',
    });
    const owner = this.owner(binding);
    this.db
      .transaction(() => {
        const used = this.db
          .query('SELECT COALESCE(SUM(bytes),0) AS bytes FROM artifacts WHERE owner=?')
          .get(owner) as { bytes: number };
        if (used.bytes + content.byteLength > SESSION_LIMIT)
          throw new Error('Session artifact quota exceeded');
        this.db
          .query('INSERT INTO artifacts(id,owner,bytes,digest,mime) VALUES (?,?,?,?,?)')
          .run(artifact.artifactId, owner, artifact.bytes, artifact.digest, artifact.mimeType);
      })
      .immediate();
    try {
      const file = await open(path.join(this.directory, artifact.artifactId), 'wx', 0o600);
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
      this.db.query('UPDATE artifacts SET ready=1 WHERE id=?').run(artifact.artifactId);
      return artifact;
    } catch (error) {
      await rm(path.join(this.directory, artifact.artifactId), { force: true });
      this.db.query('DELETE FROM artifacts WHERE id=?').run(artifact.artifactId);
      throw error;
    }
  }
  private lookup(binding: Binding, artifact: Artifact) {
    artifactSchema.parse(artifact);
    if (
      artifact.nodeId !== binding.nodeId ||
      artifact.workspaceId !== binding.workspaceId ||
      artifact.sessionId !== binding.sessionId
    )
      throw new Error('Artifact owner mismatch');
    const row = this.db
      .query('SELECT * FROM artifacts WHERE id=? AND owner=? AND ready=1')
      .get(artifact.artifactId, this.owner(binding)) as {
      digest: string;
      bytes: number;
      mime: string;
      pinned: number;
    } | null;
    if (
      !row ||
      row.digest !== artifact.digest ||
      row.bytes !== artifact.bytes ||
      row.mime !== artifact.mimeType
    )
      throw new Error('Artifact unavailable or digest mismatch');
    return row;
  }
  async chunk(
    binding: Binding,
    artifact: Artifact,
    offset: number,
    limit = 32 * 1024,
  ): Promise<Uint8Array> {
    this.lookup(binding, artifact);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > artifact.bytes ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 32 * 1024
    )
      throw new Error('Invalid artifact range');
    const file = await open(path.join(this.directory, artifact.artifactId), 'r');
    try {
      const stat = await file.stat();
      if (stat.size !== artifact.bytes) throw new Error('Artifact content mismatch');
      const revision = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (this.verified.get(artifact.artifactId) !== revision) {
        const hash = createHash('sha256');
        const block = Buffer.alloc(32768);
        for (let cursor = 0; cursor < stat.size; ) {
          const read = await file.read(
            block,
            0,
            Math.min(block.length, stat.size - cursor),
            cursor,
          );
          if (!read.bytesRead) throw new Error('Artifact content mismatch');
          hash.update(block.subarray(0, read.bytesRead));
          cursor += read.bytesRead;
        }
        if (hash.digest('hex') !== artifact.digest) throw new Error('Artifact content mismatch');
        this.verified.set(artifact.artifactId, revision);
      }
      const bytes = Buffer.alloc(Math.min(limit, artifact.bytes - offset));
      let position = 0;
      while (position < bytes.length) {
        const read = await file.read(bytes, position, bytes.length - position, offset + position);
        if (!read.bytesRead) throw new Error('Artifact content mismatch');
        position += read.bytesRead;
      }
      // Whole-transfer consumers verify the digest once, not once per range.
      return bytes;
    } finally {
      await file.close();
    }
  }
  pin(binding: Binding, artifact: Artifact): void {
    this.lookup(binding, artifact);
    this.db.query('UPDATE artifacts SET pinned=1 WHERE id=?').run(artifact.artifactId);
  }
  async removeUnreferenced(binding: Binding, artifact: Artifact): Promise<void> {
    const row = this.lookup(binding, artifact);
    if (row.pinned) throw new Error('Artifact referenced by transcript');
    // Mark unavailable before unlink so concurrent readers never adopt missing data.
    this.verified.delete(artifact.artifactId);
    this.db.query('UPDATE artifacts SET ready=0 WHERE id=? AND pinned=0').run(artifact.artifactId);
    await rm(path.join(this.directory, artifact.artifactId), { force: true });
    this.db.query('DELETE FROM artifacts WHERE id=? AND pinned=0').run(artifact.artifactId);
  }
  close(): void {
    this.db.close();
  }
}
