import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { sourceIdentity, endpointIdentity } from './ptc-m1/provenance.js';
test('controller identity changes for source or lockfile changes and rejects symlinks', async () => {
  const root = await mkdtemp('/tmp/ptc-prov-');
  try {
    await writeFile(`${root}/source.ts`, 'a');
    await writeFile(`${root}/lock`, 'v1');
    const first = await sourceIdentity(root, ['source.ts', 'lock']);
    expect(first).toBe(await sourceIdentity(root, ['lock', 'source.ts']));
    await writeFile(`${root}/lock`, 'v2');
    expect(first).not.toBe(await sourceIdentity(root, ['lock', 'source.ts']));
    await symlink('source.ts', `${root}/link`);
    await expect(sourceIdentity(root, ['link'])).rejects.toThrow('Symlink');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('endpoint fingerprint is normalized and never accepts URL secrets', () => {
  expect(endpointIdentity('https://example.invalid/')).toBe(
    endpointIdentity('https://example.invalid'),
  );
  for (const url of [
    'http://example.invalid',
    'https://secret@example.invalid',
    'https://example.invalid/?key=secret',
  ])
    expect(() => endpointIdentity(url)).toThrow();
});
