import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'bun:test';
import { embeddedSeccomp } from '../src/node/srt.js';

it("writes the built-in srt's seccomp helper for Linux once, and repairs it", () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'pirc-srt-bin-')), 'bin');
  expect(embeddedSeccomp(dir, 'darwin', 'arm64')).toBeUndefined();
  expect(embeddedSeccomp(dir, 'linux', 'ia32')).toBeUndefined();
  for (const arch of ['x64', 'arm64']) {
    const file = embeddedSeccomp(dir, 'linux', arch)!;
    expect(path.basename(file)).toStartWith(`apply-seccomp-${arch}-`);
    expect(readFileSync(file).subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    expect(statSync(file).mode & 0o777).toBe(0o755);
    const first = statSync(file).mtimeMs;
    expect(embeddedSeccomp(dir, 'linux', arch)).toBe(file);
    expect(statSync(file).mtimeMs).toBe(first);
    // Tampered with: written again.
    writeFileSync(file, 'not the helper');
    expect(embeddedSeccomp(dir, 'linux', arch)).toBe(file);
    expect(readFileSync(file).subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  }
});
