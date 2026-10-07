import { expect, test } from 'bun:test';
import { writeFile, readdir } from 'node:fs/promises';
import { DisposablePair } from './ptc-m1/disposable-pair.js';
test('same-path pair recreates clean state and refuses overlap or third run', async () => {
  const pair = await DisposablePair.create();
  try {
    const prime = await pair.acquire();
    await writeFile(`${prime.root}/synthetic-state`, 'not reused');
    await expect(pair.acquire()).rejects.toThrow('unavailable');
    await expect(pair.close()).rejects.toThrow('active');
    await prime.release();
    const measured = await pair.acquire();
    expect(measured.root).toBe(prime.root);
    expect(await readdir(measured.root)).toEqual([]);
    await measured.release();
    await expect(pair.acquire()).rejects.toThrow('unavailable');
  } finally {
    await pair.close();
  }
});

test('unverified termination poisons pair instead of allowing same-path reuse', async () => {
  const pair = await DisposablePair.create();
  const lease = await pair.acquire();
  pair.invalidate();
  await expect(pair.acquire()).rejects.toThrow('unavailable');
  await expect(pair.close()).rejects.toThrow('active');
  // The test now confirms its own synthetic work is gone before explicit cleanup.
  await lease.release();
  await expect(pair.acquire()).rejects.toThrow('unavailable');
  await pair.close();
});
