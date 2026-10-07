import { expect, test } from 'bun:test';
import { closeSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { writeAll, createArtifact, checkpoint } from './ptc-m1/artifacts.js';

test('durable aggregate writer loops on short writes and rejects stalled writes', () => {
  let text = '';
  writeAll(1, 'abcdefgh', ((_fd: number, data: Buffer, offset: number, length: number) => {
    const count = Math.min(2, length);
    text += data.subarray(offset, offset + count).toString();
    return count;
  }) as any);
  expect(text).toBe('abcdefgh');
  expect(() => writeAll(1, 'abc', (() => 0) as any)).toThrow('incomplete');
});

test('artifacts are exclusive, private and append complete numeric checkpoints', () => {
  const root = mkdtempSync('/tmp/ptc-art-');
  const file = `${root}/ledger.jsonl`;
  let fd: number | undefined;
  try {
    fd = createArtifact(file);
    checkpoint(fd, { spentUnits: 106636, reservedUnits: 0 });
    checkpoint(fd, { spentUnits: 106636, reservedUnits: 41638400 });
    expect(
      readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toHaveLength(2);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => createArtifact(file)).toThrow();
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
});
