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
import { copyNotices } from './release-notices.js';

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
const bun = process.execPath;
const cargo = process.env.PIRC_RELEASE_CARGO;
if (!cargo || !path.isAbsolute(cargo))
  throw new Error('Set PIRC_RELEASE_CARGO to a native cargo executable (absolute path)');
const commit = run(['git', 'rev-parse', 'HEAD']);
const epoch = Number(run(['git', 'show', '-s', '--format=%ct', 'HEAD']));
mkdirSync(out, { recursive: true });
// Build from git-tracked committed files only: ignored local secrets can never enter assets/docs.
const source = path.join(out, 'source');
mkdirSync(source);
run(['git', 'archive', '--format=tar', '--output=' + path.join(out, 'source.tar'), commit]);
run(['tar', '-xf', path.join(out, 'source.tar'), '-C', source]);
root = source;
run([bun, 'install', '--frozen-lockfile', '--ignore-scripts']);
run([bun, 'run', '--filter', '@pirc/web', 'build']);
const roles = ['gateway', 'node'];
// Pin the artifact directory even if the operator has CARGO_TARGET_DIR set.
run([
  cargo,
  'build',
  '--locked',
  '--release',
  '--target-dir',
  path.join(root, 'target'),
  '-p',
  'pirc-gateway',
  '-p',
  'pirc-node',
]);
for (const role of roles) {
  const binary = path.join(root, 'target/release', `pirc-${role}`);
  if (run([binary, '--version']) !== version)
    throw new Error(`Rebuild pirc-${role} for ${version}`);
  if (!run(['file', binary]).includes('arm64')) throw new Error('Expected ARM64 executable');
  if (run(['otool', '-L', binary]).includes('/nix/store'))
    throw new Error(
      'Nonportable Nix-linked binary: rebuild with a native Rust toolchain and Apple SDK',
    );
}
if (!existsSync(path.join(root, 'apps/web/dist/index.html')))
  throw new Error('Build the web client first');
const name = `pirc-v${version}-darwin-arm64`;
const stage = path.join(out, name);
mkdirSync(path.join(stage, 'bin'), { recursive: true });
for (const role of roles) {
  cpSync(
    path.join(root, 'target/release', `pirc-${role}`),
    path.join(stage, 'bin', `pirc-${role}`),
  );
}
cpSync(path.join(root, 'apps/web/dist'), path.join(stage, 'share/pirc/web'), { recursive: true });
cpSync(path.join(root, 'docs'), path.join(stage, 'docs'), { recursive: true });
for (const file of ['README.md', 'CHANGELOG.md'])
  cpSync(path.join(root, file), path.join(stage, file));
// Preserve web/build dependency notices and the native crates' vendored licenses.
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
  `pirc ${version}\nCommit: ${commit}\nmacOS ARM64; not Developer ID signed/notarized.\nAdd this archive's bin directory to PATH. Chat role: pirc-node chat.\nSee docs/development/releasing.md and docs/deploy/ before use.\nChromium/Chrome and optional ffmpeg are external dependencies.\nWeb assets: share/pirc/web (serve through your authenticated reverse proxy).\n`,
);
// Cargo vendor provides the exact locked dependency sources and licenses.
const vendor = path.join(out, 'cargo-vendor');
run([cargo, 'vendor', '--locked', vendor]);
copyNotices(vendor, path.join(notices, 'rust'));
cpSync(path.join(root, 'crates/pirc-node/NOTICE'), path.join(notices, 'pirc-node-NOTICE'));
for (const file of ['PLAYWRIGHT-LICENSE', 'PLAYWRIGHT-NOTICE'])
  cpSync(path.join(root, 'crates/pirc-node/src/browser/assets', file), path.join(notices, file));
writeFileSync(
  path.join(stage, 'BUILD.json'),
  JSON.stringify(
    {
      version,
      commit,
      epoch,
      cargo: run([cargo, '--version']),
      rustc: run(['rustc', '-vV']),
      bun: run([bun, '--version']),
      binaryBytes: Object.fromEntries(
        roles.map((role) => [
          `pirc-${role}`,
          readFileSync(path.join(stage, 'bin', `pirc-${role}`)).length,
        ]),
      ),
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
