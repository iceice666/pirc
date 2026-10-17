import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const read = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const fixture = await read('fixtures/mobile-parity/html-input-sizing.json');
const web = await read('fixtures/mobile-parity/html-input-sizing-expected.json');
assert.equal(fixture.webRevision, 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c');
assert.equal(web.reference, fixture.webRevision);
assert.equal(web.fixture, fixture.id);
let observations = 0;
const maximum = { x: 0, y: 0, width: 0, height: 0 };
const configurations = [];
for (const theme of ['light', 'dark']) {
  for (const width of fixture.widths) {
    const rows = await read(
      `apps/android/build/parity/html-input-sizing-native-${theme}-${width}.json`,
    );
    const reference = web.themes[theme].widths.find((row) => row.width === width);
    assert(reference);
    const expected = reference.cases.flatMap((item) =>
      item.controls.map((control) => ({ case: item.id, control })),
    );
    assert.equal(rows.length, expected.length);
    assert.equal(new Set(rows.map((row) => `${row.case}/${row.id}`)).size, rows.length);
    for (const [index, { case: caseId, control }] of expected.entries()) {
      const row = rows[index];
      assert.equal(row.case, caseId);
      assert.equal(row.id, control.id);
      assert.equal(row.value, control.value);
      assert.equal(row.fontMetrics.fontFamily, 'Arial');
      assert(row.fontMetrics.xAdvance > 0 && Number.isFinite(row.fontMetrics.ascent));
      for (const key of Object.keys(maximum)) {
        assert(Number.isFinite(row.box[key]) && Number.isFinite(row.delta[key]));
        const measuredDelta = row.box[key] - control.box[key];
        assert(Math.abs(measuredDelta - row.delta[key]) < 1e-8);
        maximum[key] = Math.max(maximum[key], Math.abs(measuredDelta));
      }
      observations++;
    }
    configurations.push({ theme, width, observations: rows.length });
  }
}
const summary = {
  reference: fixture.webRevision,
  observations,
  configurations,
  valuesAccepted: true,
  maximumBoxDifference: maximum,
  intrinsicWidthsWithinKnown1pxResidual: maximum.width <= 1.01,
  visualParityAccepted: false,
  limitations: [
    'Flutter line metrics include font leading; Blink raw ascent differs. The measured one-pixel width residual is retained.',
    'The browser sizing harness adds an external eight-pixel block margin; native capture renders only the source. Vertical positions are recorded and are not accepted as equivalent.',
    'This host Arial fixture covers 390/768 at scale 1, not the full app or Android font metric path.',
  ],
};
assert(summary.intrinsicWidthsWithinKnown1pxResidual);
await writeFile(
  resolve(root, 'apps/android/build/parity/html-input-sizing-comparison.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
