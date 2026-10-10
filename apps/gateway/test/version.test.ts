import { version } from '../../../package.json';
import { afterEach, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { bumpVersion, checkVersions, parseVersion } from '../../../scripts/version.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'pirc-version-'));
  dirs.push(root);
  for (const file of ['package.json', 'apps/gateway/package.json', 'apps/web/package.json']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), JSON.stringify({ name: 'test', version: '0.1.0' }));
  }
  mkdirSync(path.join(root, 'apps/android/app'), { recursive: true });
  writeFileSync(
    path.join(root, 'apps/android/app/build.gradle.kts'),
    'versionCode = 1\nversionName = "0.1.0"\n',
  );
  writeFileSync(
    path.join(root, 'bun.lock'),
    JSON.stringify({
      workspaces: {
        'apps/gateway': { name: 'g', version: '0.1.0' },
        'apps/web': { name: 'w', version: '0.1.0' },
      },
    }),
  );
  writeFileSync(
    path.join(root, 'Cargo.toml'),
    '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nauthors = ["a"]\nversion = "0.1.0"\n\n[workspace.dependencies]\nversion = "9"\n',
  );
  writeFileSync(
    path.join(root, 'Cargo.lock'),
    'version = 4\n\n[[package]]\nname = "dep"\nversion = "9.9.9"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "pirc-node"\nversion = "0.1.0"\n',
  );
  return root;
}
it('checks manifests and lockfile and bumps Android monotonically', () => {
  const root = fixture();
  expect(checkVersions(root)).toBe('0.1.0');
  bumpVersion(root, '0.2.0');
  expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version).toBe('0.2.0');
  expect(readFileSync(path.join(root, 'apps/android/app/build.gradle.kts'), 'utf8')).toContain(
    'versionCode = 2',
  );
  expect(() => checkVersions(root)).toThrow('Lockfile mismatch');
  const cargoToml = readFileSync(path.join(root, 'Cargo.toml'), 'utf8');
  expect(cargoToml).toContain('authors = ["a"]\nversion = "0.2.0"');
  // Only [workspace.package] follows the product version.
  expect(cargoToml).toContain('[workspace.dependencies]\nversion = "9"');
  const lock = path.join(root, 'bun.lock');
  writeFileSync(lock, readFileSync(lock, 'utf8').replaceAll('0.1.0', '0.2.0'));
  // Registry dependencies keep their own versions; workspace packages follow.
  expect(() => checkVersions(root)).toThrow('Lockfile mismatch: pirc-node');
  const cargoLock = path.join(root, 'Cargo.lock');
  writeFileSync(cargoLock, readFileSync(cargoLock, 'utf8').replaceAll('0.1.0', '0.2.0'));
  expect(checkVersions(root)).toBe('0.2.0');
  expect(() => bumpVersion(root, '0.2.0')).toThrow('increase');
  expect(() => bumpVersion(root, '0.1.9')).toThrow('increase');
});
it('rejects mismatches and malformed versions without writing', () => {
  for (const version of ['v0.2.0', '0.02.0', '0.2', '0.2.0-rc.1', '-1.2.0'])
    expect(() => parseVersion(version)).toThrow();
  const root = fixture();
  writeFileSync(path.join(root, 'apps/web/package.json'), JSON.stringify({ version: '0.9.0' }));
  expect(() => bumpVersion(root, '1.0.0')).toThrow('mismatch');
  expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version).toBe('0.1.0');
  const cargo = fixture();
  writeFileSync(
    path.join(cargo, 'Cargo.toml'),
    '[workspace]\n\n[workspace.package]\nversion = "0.2.0"\n',
  );
  expect(() => checkVersions(cargo)).toThrow('Version mismatch: Cargo.toml');
  writeFileSync(path.join(cargo, 'Cargo.toml'), '[workspace]\n');
  expect(() => bumpVersion(cargo, '1.0.0')).toThrow('Cargo.toml');
  expect(JSON.parse(readFileSync(path.join(cargo, 'package.json'), 'utf8')).version).toBe('0.1.0');
});
it('keeps the actual repository versions synchronized', () => {
  expect(checkVersions(path.resolve(import.meta.dir, '../../..'))).toBe(version);
});
