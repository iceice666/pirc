import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PTC_GUEST_PRELUDE } from '../apps/gateway/src/agent/ptc/guest.js';
import { nativeGuestSdk } from '../apps/gateway/src/gateway-runtime/native-guest-sdk.js';

// Explicit offline input: build never downloads/executes an unverified remote dependency.
// Source: https://github.com/wasm3/wasm3/tree/ac3c1dd1386e83be7de548211efd02805eb1dcee
export const WASM3_COMMIT = 'ac3c1dd1386e83be7de548211efd02805eb1dcee';
export const WASM3_ARCHIVE_SHA256 =
  'c3ee044f23da31055e1c31b3a350dac240c93f0eed8e281739574bf754573c37';
const QUICKJS_SHA256 = '98d27ff5e8babbca4b28a7b9242f554cd51e758498d90b00638a4b1b36b6f463';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const leb = (n: number): number[] => {
  const out = [];
  do {
    let b = n & 127;
    n >>>= 7;
    if (n) b |= 128;
    out.push(b);
  } while (n);
  return out;
};
const vector = (items: number[][]) => [...leb(items.length), ...items.flat()];
const string = (value: string) => [...leb(Buffer.byteLength(value)), ...Buffer.from(value)];
const section = (id: number, bytes: number[]) => [id, ...leb(bytes.length), ...bytes];
/** Trusted adapter: fixed memory and re-exported host imports, no executable WASM code. */
export function fixedMemoryAdapter(): Uint8Array {
  const signatures = [
    'v(iiii)',
    'i(iiii)',
    'i(i)',
    'i(ii)',
    'i(ii)',
    'i(iiii)',
    'i(iii)',
    'i(i)',
    'v(iii)',
    'i(iiiii)',
    'i(iF)',
    'i(i)',
    'v()',
    'v(iiii)',
    'F()',
    'v()',
    'v(i)',
    'i(iiiii)',
    'v(ii)',
  ];
  const type = (ch: string) => (ch === 'i' ? 0x7f : 0x7c);
  const types = signatures.map((sig) => [
    0x60,
    ...vector([...sig.slice(2, -1)].map((ch) => [type(ch)])),
    ...vector(sig[0] === 'v' ? [] : [[type(sig[0]!)]]),
  ]);
  const imports = signatures.map((_, i) => [
    ...string('pirc'),
    ...string(String.fromCharCode(98 + i)),
    0,
    ...leb(i),
  ]);
  const exports = [
    ...signatures.map((_, i) => [...string(String.fromCharCode(98 + i)), 0, ...leb(i)]),
    [...string('a'), 2, 0],
  ];
  return Uint8Array.from([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, vector(types)),
    ...section(2, vector(imports)),
    ...section(5, [1, 1, ...leb(4096), ...leb(4096)]),
    ...section(7, vector(exports)),
  ]);
}

if (import.meta.main) {
  const archive = process.env.PIRC_WASM3_ARCHIVE;
  if (!archive)
    throw new Error('Set PIRC_WASM3_ARCHIVE to the pinned source archive; no network fallback');
  if (sha(readFileSync(archive)) !== WASM3_ARCHIVE_SHA256)
    throw new Error('WASM3 source checksum mismatch');
  const root = path.resolve(import.meta.dir, '..');
  const build = path.join(root, 'work/native-ptc-build');
  mkdirSync(build, { recursive: true });
  const unpack = spawnSync('tar', ['-xzf', path.resolve(archive), '-C', build], {
    stdio: 'inherit',
  });
  if (unpack.status !== 0) throw new Error('Cannot unpack pinned WASM3');
  const source = path.join(build, `wasm3-${WASM3_COMMIT}`, 'source');
  const wasm = readFileSync(
    path.join(
      root,
      'apps/gateway/node_modules/@jitl/quickjs-wasmfile-release-asyncify/dist/emscripten-module.wasm',
    ),
  );
  if (sha(wasm) !== QUICKJS_SHA256) throw new Error('QuickJS WASM checksum mismatch');
  const array = (name: string, bytes: Uint8Array) =>
    `static const unsigned char ${name}[]={${[...bytes].join(',')}};\n`;
  writeFileSync(
    path.join(build, 'native-ptc-assets.h'),
    array('ptc_quickjs', wasm) +
      array('ptc_memory', fixedMemoryAdapter()) +
      array('ptc_sdk', Buffer.from(nativeGuestSdk(PTC_GUEST_PRELUDE) + '\0')),
  );
  const files = [
    'm3_bind',
    'm3_code',
    'm3_compile',
    'm3_core',
    'm3_deterministic',
    'm3_env',
    'm3_exec',
    'm3_function',
    'm3_info',
    'm3_module',
    'm3_parse',
    'm3_validate',
  ];
  const out = path.join(root, 'apps/gateway/dist/pirc-ptc-worker');
  mkdirSync(path.dirname(out), { recursive: true });
  const result = spawnSync(
    process.env.CC ?? 'clang',
    [
      '-O2',
      '-Werror',
      '-Dd_m3GuardedMemory=0',
      '-Dd_m3SkipMemoryBoundsCheck=0',
      '-Dd_m3MaxLinearMemoryPages=4096',
      `-I${source}`,
      `-I${build}`,
      path.join(root, 'apps/gateway/src/gateway-runtime/native-ptc-worker.c'),
      ...files.map((name) => path.join(source, name + '.c')),
      '-lm',
      '-o',
      out,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  writeFileSync(
    out + '.provenance.json',
    JSON.stringify(
      {
        wasm3: WASM3_COMMIT,
        sourceSha256: WASM3_ARCHIVE_SHA256,
        quickjsSha256: QUICKJS_SHA256,
        binarySha256: sha(readFileSync(out)),
      },
      null,
      2,
    ) + '\n',
  );
  // License accompanies shipped code rather than only living in a build cache.
  writeFileSync(
    out + '.LICENSE',
    Buffer.concat([
      Buffer.from('wasm3:\n'),
      readFileSync(path.join(source, '../LICENSE')),
      Buffer.from('\n\nEmbedded QuickJS WASM / quickjs-emscripten:\n'),
      readFileSync(
        path.join(
          root,
          'apps/gateway/node_modules/@jitl/quickjs-wasmfile-release-asyncify/LICENSE',
        ),
      ),
    ]),
  );
}
