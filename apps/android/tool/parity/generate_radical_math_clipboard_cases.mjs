import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../../..');
const bytes = await readFile(resolve(root, 'fixtures/mobile-parity/radical-math-clipboard-expected.json'));
const fixture = JSON.parse(bytes);
if (fixture.webRevision !== 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c' || fixture.renderer.katexVersion !== '0.16.47' || fixture.cases.length !== 16) throw new Error('Unexpected radical oracle');
const quote = value => JSON.stringify(value).replaceAll('$', '\\$');
let source = await readFile(resolve(root, 'apps/android/integration_test/structural_math_clipboard_test.dart'), 'utf8');
const start = source.indexOf('const cases =');
const end = source.indexOf('void main()', start);
source = source.slice(0, start) +
  `// Oracle SHA-256: ${createHash('sha256').update(bytes).digest('hex')}\n` +
  'const cases = <Map<String, String>>[\n' + fixture.cases.map(c =>
    `  {'id': ${quote(c.id)}, 'source': ${quote(c.source)}, 'expected': ${quote(c.actualClipboard.textPlain)}}`).join(',\n') +
  ',\n];\n\n' + source.slice(end);
source = source.replace('Chrome structural math in both themes', 'Chrome radical math in both themes');
await writeFile(resolve(root, 'apps/android/integration_test/radical_math_clipboard_test.dart'), source);
