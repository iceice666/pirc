import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../../..');
const bytes = await readFile(resolve(root, 'fixtures/mobile-parity/background-positions-expected.json'));
const fixture = JSON.parse(bytes);
if (fixture.cases.length !== 17) throw new Error('Expected 17 positions');
const cases = fixture.cases.map(({ id, element, authoredCss, pixelSamples }) => ({ id, element, authoredCss, pixelSamples }));
const json = JSON.stringify({cases});
if (json.includes("'".repeat(3))) throw new Error('Unexpected Dart delimiter');
await writeFile(resolve(root, 'apps/android/integration_test/background_position_cases.dart'),
  '// Generated from the actual Chrome pixel oracle; do not edit.\n' +
  'const backgroundPositionFixtureSha256 = ' + JSON.stringify(createHash('sha256').update(bytes).digest('hex')) + ';\n' +
  'const backgroundPositionCasesJson = r' + "'".repeat(3) + json + "'".repeat(3) + ';\n');
