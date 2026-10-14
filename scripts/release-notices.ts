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
