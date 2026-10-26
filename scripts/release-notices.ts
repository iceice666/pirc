import { cpSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Collect nested native/vendor notices too (e.g. rquickjs-sys/quickjs/LICENSE).
 * Keep relative paths and refuse links: archive inputs must stay self-contained.
 */
export function copyNotices(source: string, destination: string): void {
  for (const name of readdirSync(source)) {
    const input = path.join(source, name);
    const output = path.join(destination, name);
    const stat = lstatSync(input);
    if (stat.isSymbolicLink()) throw new Error(`Unexpected vendor symlink: ${input}`);
    if (/^(license|licence|notice|copying|copyright|third.?party.?notices)([._-]|$)/i.test(name)) {
      mkdirSync(path.dirname(output), { recursive: true });
      cpSync(input, output, { recursive: true });
    } else if (stat.isDirectory()) copyNotices(input, output);
  }
}

/** The project's license accompanies both native and standalone web archives.
 * Keep it separate from dependencies' notices, whose original terms remain.
 */
export function copyProjectLicense(source: string, destination: string): void {
  const license = path.join(source, 'LICENSE');
  if (!lstatSync(license).isFile()) throw new Error('Project LICENSE must be a regular file');
  mkdirSync(destination, { recursive: true });
  cpSync(license, path.join(destination, 'LICENSE'));
}
