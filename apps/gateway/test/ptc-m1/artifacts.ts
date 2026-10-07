/** Aggregate-only durable artifacts; caller must never supply secrets or raw model content. */
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
export function writeAll(fd: number, text: string, write = writeSync): void {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    const size = write(fd, bytes, offset, bytes.length - offset);
    if (!Number.isSafeInteger(size) || size <= 0 || size > bytes.length - offset)
      throw new Error('Aggregate write incomplete');
    offset += size;
  }
}
export function createArtifact(file: string): number {
  const fd = openSync(file, 'wx', 0o600);
  let directory: number | undefined;
  try {
    fsyncSync(fd);
    directory = openSync(path.dirname(file), 'r');
    fsyncSync(directory);
    return fd;
  } catch {
    closeSync(fd);
    throw new Error('Aggregate artifact creation failed');
  } finally {
    if (directory !== undefined) closeSync(directory);
  }
}
export function checkpoint(fd: number, value: unknown): void {
  writeAll(fd, JSON.stringify(value) + '\n');
  fsyncSync(fd);
}
