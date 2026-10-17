import { requireTestBrowserExecutable } from './test_browser.mjs';
// Generate small synthetic AVIF images and capture actual Chrome RGBA.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dir = await mkdtemp(path.join(tmpdir(), 'pirc-avif-oracle-'));
await run('python3', [
  '-c',
  `
from pathlib import Path
import struct,zlib,sys
p=Path(sys.argv[1])
def chunk(t,b):return struct.pack('>I',len(b))+t+b+struct.pack('>I',zlib.crc32(t+b))
for label,alpha in [('opaque',255),('alpha',128)]:
 data=b''.join(b'\\x00'+bytes([45,150,210,alpha])*32 for _ in range(16))
 png=b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',32,16,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(data))+chunk(b'IEND',b'')
 (p/(label+'.png')).write_bytes(png)
`,
  dir,
]);
for (const id of ['opaque-8', 'alpha-8', 'opaque-10']) {
  await run(process.env.AVIFENC ?? 'avifenc', [
    '-j',
    '2',
    '-s',
    '8',
    '-q',
    '100',
    '-d',
    id.endsWith('-10') ? '10' : '8',
    path.join(dir, id.startsWith('alpha') ? 'alpha.png' : 'opaque.png'),
    path.join(dir, id + '.avif'),
  ]);
}
const browser = await chromium.launch({
  executablePath: requireTestBrowserExecutable(),
  headless: true,
});
try {
  const page = await browser.newPage();
  const fixtures = [];
  for (const id of ['opaque-8', 'alpha-8', 'opaque-10']) {
    const bytes = await readFile(path.join(dir, id + '.avif'));
    const dataUri = 'data:image/avif;base64,' + bytes.toString('base64');
    const observed = await page.evaluate(async (source) => {
      const i = new Image();
      i.src = source;
      await i.decode();
      const c = document.createElement('canvas');
      c.width = i.naturalWidth;
      c.height = i.naturalHeight;
      const x = c.getContext('2d');
      x.drawImage(i, 0, 0);
      return {
        width: i.naturalWidth,
        height: i.naturalHeight,
        center: Array.from(x.getImageData(16, 8, 1, 1).data),
      };
    }, dataUri);
    fixtures.push({
      id,
      dataUri,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      expected: observed,
    });
  }
  await writeFile(
    path.join(root, 'fixtures/mobile-parity/avif-images.json'),
    JSON.stringify(
      {
        baselineCommit: 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c',
        browser: await browser.version(),
        encoder: 'libavif 1.4.1/aom 3.13.3; q100; speed8; 8/10-bit; synthetic RGBA32x16',
        fixtures,
      },
      null,
      2,
    ),
  );
  process.stdout.write(JSON.stringify(fixtures.map(({ id, expected }) => ({ id, expected }))));
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
