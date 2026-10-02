import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const manifests = ['package.json', 'apps/gateway/package.json', 'apps/web/package.json'];
const android = 'apps/android/app/build.gradle.kts';
export function parseVersion(value: string): number[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new Error('Expected a stable MAJOR.MINOR.PATCH version (without v)');
  const parts = value.split('.').map(Number);
  if (parts.some((n) => !Number.isSafeInteger(n))) throw new Error('Version component too large');
  return parts;
}
function field(text: string, pattern: RegExp): string {
  const matches = [...text.matchAll(new RegExp(pattern.source, 'g'))];
  if (matches.length !== 1) throw new Error('Expected exactly one version field');
  return matches[0]![1]!;
}
export function checkVersions(root: string): string {
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
  const version = JSON.parse(read(manifests[0]!)).version as string;
  parseVersion(version);
  for (const file of manifests.slice(1))
    if (JSON.parse(read(file)).version !== version) throw new Error(`Version mismatch: ${file}`);
  if (field(read(android), /versionName = "([^"]+)"/) !== version)
    throw new Error('Android versionName mismatch');
  const code = Number(field(read(android), /versionCode = (\d+)/));
  if (!Number.isInteger(code) || code < 1 || code > 2100000000)
    throw new Error('Invalid Android versionCode');
  // Bun's lockfile is JSONC; inspect only workspace headers, not dependency versions.
  const lock = read('bun.lock');
  for (const workspace of ['apps/gateway', 'apps/web']) {
    const escaped = workspace.replaceAll('/', '\\/');
    if (
      field(
        lock,
        new RegExp('"' + escaped + '":\\s*\\{\\s*"name":\\s*"[^"]+",\\s*"version":\\s*"([^"]+)"'),
      ) !== version
    )
      throw new Error(`Lockfile mismatch: ${workspace}; run bun install --lockfile-only`);
  }
  return version;
}
export function bumpVersion(root: string, next: string): void {
  const current = checkVersions(root);
  const before = parseVersion(current),
    after = parseVersion(next);
  const different = after.findIndex((n, i) => n !== before[i]);
  if (different < 0 || after[different]! < before[different]!)
    throw new Error('Version must increase');
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
  const text = read(android);
  const code = Number(field(text, /versionCode = (\d+)/));
  if (code >= 2100000000) throw new Error('Android versionCode exhausted');
  // Validate every input before writing anything. No git/network/release side effects.
  const changes = manifests.map((file) => {
    const manifest = JSON.parse(read(file));
    manifest.version = next;
    return [file, JSON.stringify(manifest, null, 2) + '\n'] as const;
  });
  for (const [file, content] of changes) writeFileSync(path.join(root, file), content);
  writeFileSync(
    path.join(root, android),
    text
      .replace(/versionName = "[^"]+"/, `versionName = "${next}"`)
      .replace(/versionCode = \d+/, `versionCode = ${code + 1}`),
  );
}
if (import.meta.main) {
  const root = path.resolve(import.meta.dir, '..');
  const [command, version, ...extra] = process.argv.slice(2);
  if (command === 'check' && !version) console.log(`Versions synchronized: ${checkVersions(root)}`);
  else if (command === 'bump' && version && !extra.length) {
    bumpVersion(root, version);
    console.log(
      `Bumped to ${version}. Run bun install --lockfile-only, then bun run version:check.`,
    );
  } else throw new Error('Usage: bun scripts/version.ts check | bump <version>');
}
