import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { checkVersions } from './version.js';

const repo = path.resolve(import.meta.dir, '..');
let root = repo;
function run(args: string[], cwd = root): string {
  const result = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode) throw new Error(`${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('Package on macOS ARM64 only');
if (run(['git', 'status', '--porcelain'])) throw new Error('Commit changes before packaging');
const version = checkVersions(root);
const out = path.join(repo, 'dist', 'releases', `v${version}`);
if (existsSync(out)) throw new Error(`Refusing to overwrite ${out}`);
const compiler = process.env.PIRC_RELEASE_BUN;
if (!compiler || !path.isAbsolute(compiler))
  throw new Error('Set PIRC_RELEASE_BUN to the official Bun executable (absolute path)');
if (run(['otool', '-L', compiler]).includes('/nix/store'))
  throw new Error('Use a portable official Bun compiler');
const commit = run(['git', 'rev-parse', 'HEAD']);
const epoch = Number(run(['git', 'show', '-s', '--format=%ct', 'HEAD']));
mkdirSync(out, { recursive: true });
// Build from git-tracked committed files only: ignored local secrets can never enter assets/docs.
const source = path.join(out, 'source');
mkdirSync(source);
run(['git', 'archive', '--format=tar', '--output=' + path.join(out, 'source.tar'), commit]);
run(['tar', '-xf', path.join(out, 'source.tar'), '-C', source]);
root = source;
run([compiler, 'install', '--frozen-lockfile']);
run([compiler, 'run', '--filter', '@pirc/web', 'build']);
const roles = ['gateway', 'chat', 'node'];
for (const role of roles)
  run(
    [
      compiler,
      'build',
      '--compile',
      '--minify',
      '--sourcemap',
      '--external',
      'chromium-bidi',
      `src/entry/${role}.ts`,
      '--outfile',
      `dist/pirc-${role}`,
    ],
    path.join(root, 'apps/gateway'),
  );
for (const role of roles) {
  const binary = path.join(root, 'apps/gateway/dist', `pirc-${role}`);
  if (run([binary, '--version']) !== version)
    throw new Error(`Rebuild pirc-${role} for ${version}`);
  if (!run(['file', binary]).includes('arm64')) throw new Error('Expected ARM64 executable');
  if (run(['otool', '-L', binary]).includes('/nix/store'))
    throw new Error(
      'Nonportable Nix-linked binary: rebuild with official Bun --compile-executable-path',
    );
}
if (!existsSync(path.join(root, 'apps/web/dist/index.html')))
  throw new Error('Build the web client first');
const name = `pirc-v${version}-darwin-arm64`;
const stage = path.join(out, name);
mkdirSync(path.join(stage, 'bin'), { recursive: true });
mkdirSync(path.join(stage, 'libexec/pirc'), { recursive: true });
for (const role of roles) {
  cpSync(
    path.join(root, 'apps/gateway/dist', `pirc-${role}`),
    path.join(stage, 'libexec/pirc', `pirc-${role}`),
  );
  const wrapper =
    '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)\n' +
    (role === 'gateway'
      ? ''
      : ': "${PIRC_PLAYWRIGHT_CORE:=$root/lib/pirc/playwright-core}"\nexport PIRC_PLAYWRIGHT_CORE\n') +
    `exec "$root/libexec/pirc/pirc-${role}" "$@"\n`;
  writeFileSync(path.join(stage, 'bin', `pirc-${role}`), wrapper, { mode: 0o755 });
}
cpSync(
  realpathSync(path.join(root, 'apps/gateway/node_modules/playwright-core')),
  path.join(stage, 'lib/pirc/playwright-core'),
  { recursive: true, dereference: true },
);
cpSync(path.join(root, 'apps/web/dist'), path.join(stage, 'share/pirc/web'), { recursive: true });
cpSync(path.join(root, 'docs'), path.join(stage, 'docs'), { recursive: true });
for (const file of ['README.md', 'CHANGELOG.md'])
  cpSync(path.join(root, file), path.join(stage, file));
// Preserve installed dependency notices (a superset of compiled runtime dependencies).
const notices = path.join(stage, 'third-party-notices');
mkdirSync(notices);
for (const entry of readdirSync(path.join(root, 'node_modules/.bun'))) {
  const modules = path.join(root, 'node_modules/.bun', entry, 'node_modules');
  if (!existsSync(modules)) continue;
  const copyNotices = (dir: string, label: string) => {
    for (const file of readdirSync(dir)) {
      if (!/^(license|licence|notice|copying|copyright|third.?party.?notices)([._-]|$)/i.test(file))
        continue;
      const dest = path.join(notices, entry, label, file);
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(path.join(dir, file), dest, { recursive: true, dereference: true });
    }
  };
  for (const pkg of readdirSync(modules)) {
    const dir = path.join(modules, pkg);
    // Only the package installed by this store entry, not linked dependencies.
    if (!realpathSync(dir).startsWith(path.resolve(modules) + path.sep)) continue;
    if (pkg.startsWith('@')) {
      for (const child of readdirSync(dir)) {
        const sub = path.join(dir, child);
        if (realpathSync(sub).startsWith(path.resolve(modules) + path.sep))
          copyNotices(sub, pkg + '/' + child);
      }
    } else copyNotices(dir, pkg);
  }
}
writeFileSync(
  path.join(stage, 'RELEASE.txt'),
  `pirc ${version}\nCommit: ${commit}\nmacOS ARM64; not Developer ID signed/notarized.\nAdd this archive's bin directory to PATH; do not symlink wrappers outside it.\nSee docs/releasing.md and docs/deploy/ before use.\nChromium/Chrome and optional ffmpeg are external dependencies.\nWeb assets: share/pirc/web (serve through your authenticated reverse proxy).\n`,
);
const bunLicense = process.env.PIRC_RELEASE_BUN_LICENSE;
if (!bunLicense || !path.isAbsolute(bunLicense))
  throw new Error('Set PIRC_RELEASE_BUN_LICENSE to the official Bun LICENSE file');
cpSync(bunLicense, path.join(notices, 'Bun-LICENSE.md'));
writeFileSync(
  path.join(stage, 'BUILD.json'),
  JSON.stringify(
    {
      version,
      commit,
      epoch,
      compiler: run([compiler, '--version']),
      compilerSha256: createHash('sha256').update(readFileSync(compiler)).digest('hex'),
      platform: process.platform,
      arch: process.arch,
    },
    null,
    2,
  ) + '\n',
);
const webName = `pirc-web-v${version}`;
cpSync(path.join(stage, 'share/pirc/web'), path.join(out, webName, 'web'), { recursive: true });
cpSync(notices, path.join(out, webName, 'third-party-notices'), { recursive: true });
const archives = [name, webName].map((dir) => {
  const file = dir + '.tar.gz';
  // Python tarfile avoids AppleDouble/xattrs and normalizes archive metadata/order.
  run(
    [
      'python3',
      '-c',
      `import gzip, tarfile, os, sys
source, output, epoch = sys.argv[1], sys.argv[2], int(sys.argv[3])
with open(output, 'wb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=epoch) as gz, tarfile.open(fileobj=gz, mode='w', format=tarfile.PAX_FORMAT) as archive:
    for base, dirs, files in os.walk(source):
        dirs.sort(); files.sort()
        for item in [base] + [os.path.join(base, f) for f in files]:
            if os.path.islink(item): raise RuntimeError('Unexpected symlink: ' + item)
            info = archive.gettarinfo(item, item)
            info.uid = info.gid = 0; info.uname = info.gname = ''; info.mtime = epoch; info.pax_headers = {}
            if info.isfile():
                with open(item, 'rb') as data: archive.addfile(info, data)
            elif info.isdir(): archive.addfile(info)
            else: raise RuntimeError('Unexpected special file: ' + item)
`,
      dir,
      file,
      String(epoch),
    ],
    out,
  );
  return file;
});
writeFileSync(
  path.join(out, 'SHA256SUMS'),
  archives
    .map(
      (file) =>
        `${createHash('sha256')
          .update(readFileSync(path.join(out, file)))
          .digest('hex')}  ${file}\n`,
    )
    .join(''),
);
console.log(out);
