import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const gateway = path.resolve(import.meta.dir, '../apps/gateway');
const dist = path.join(gateway, 'dist');
mkdirSync(dist, { recursive: true });
if (process.platform === 'darwin') {
  const compiler = Bun.which(process.env.CC ?? 'clang');
  if (!compiler) throw new Error('macOS worker native compiler unavailable');
  for (const [source, output, library] of [
    ['macos-worker-driver.c', 'pirc-runtime-worker', false],
    ['macos-worker-bootstrap.c', 'pirc-worker-bootstrap.dylib', true],
    ['macos-worker-inspection.c', 'pirc-worker-inspection.dylib', true],
    ['macos-worker-watchdog.c', 'pirc-worker-watchdog', false],
  ] as const) {
    const result = spawnSync(
      compiler,
      [
        ...(library ? ['-dynamiclib'] : []),
        '-O2',
        '-Wno-deprecated-declarations',
        path.join(gateway, 'src/gateway-runtime', source),
        '-o',
        path.join(dist, output),
      ],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
} else {
  const result = spawnSync(
    process.execPath,
    [
      'build',
      '--compile',
      '--no-compile-autoload-bunfig',
      '--no-compile-autoload-dotenv',
      '--no-compile-autoload-tsconfig',
      '--no-compile-autoload-package-json',
      '--minify',
      'src/entry/runtime-worker.ts',
      '--outfile',
      'dist/pirc-runtime-worker',
    ],
    { cwd: gateway, stdio: 'inherit' },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
