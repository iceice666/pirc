import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../../..');
const out = resolve(root, 'apps/android/build/parity');
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const fixture = await read(resolve(root, 'fixtures/mobile-parity/markdown-images.json'));
const web = await read(resolve(out, 'markdown-table-images-web.json'));
const native = await read(resolve(out, 'markdown-table-images-native.json'));
assert.equal(web.reference, fixture.webRevision);
assert.equal(native.reference, fixture.webRevision);
const key = (row) => [row.id, row.width, row.theme, row.textScale].join('/');
const count = fixture.tableCases.length * fixture.tableWidths.length * 2 * 2;
const byKey = new Map(web.captures.map((row) => [key(row), row]));
assert.equal(web.captures.length, count);
assert.equal(byKey.size, count);
assert.equal(native.captures.length, count);
assert.equal(new Set(native.captures.map(key)).size, count);
const maximum = Object.fromEntries(
  ['image', 'table', 'viewport'].map((surface) => [
    surface,
    Object.fromEntries(['left', 'top', 'width', 'height'].map((field) => [field, 0])),
  ]),
);
const differences = [];
for (const row of native.captures) {
  const tuple = key(row),
    expected = byKey.get(tuple);
  assert.ok(expected, 'Missing web tuple ' + tuple);
  const item = fixture.tableCases.find((item) => item.id === row.id);
  assert.equal(row.src, item.imageSource);
  assert.equal(expected.src, item.imageSource);
  assert.equal(row.viewport.width, row.width);
  assert.equal(row.table.width, row.width - 2);
  assert.ok(Math.abs(row.image.width / row.image.height - 300 / 140) < 0.001);
  // Image sizing accepts only the observed subpixel CSS/Flutter rounding;
  // vertical box/baseline differences remain reported separately below.
  for (const field of ['width', 'height'])
    assert.ok(Math.abs(row.image[field] - expected.image[field]) < 0.05, tuple + ' image ' + field);
  for (const surface of Object.keys(maximum)) {
    const delta = {};
    for (const field of Object.keys(maximum[surface])) {
      delta[field] = row[surface][field] - expected[surface][field];
      maximum[surface][field] = Math.max(maximum[surface][field], Math.abs(delta[field]));
    }
    if (Object.values(delta).some((value) => Math.abs(value) > 0.05))
      differences.push({ tuple, surface, delta });
  }
}
const report = {
  reference: fixture.webRevision,
  configurations: count,
  imageSizingAndSourceAssertions: 'passed',
  maximum,
  differences,
  scope:
    'Two SVG image URL fragments in one-cell Markdown tables at240/390, light/dark,1x/2x, host Arial. Source/shape and small image sizing rounding are verified. Table/viewport vertical geometry, inline baseline, broader SVG fragment-view behavior and Android media acceptance remain unaccepted.',
};
await writeFile(
  resolve(out, 'markdown-table-images-comparison.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    {
      configurations: count,
      imageSizingAndSourceAssertions: report.imageSizingAndSourceAssertions,
      maximum,
    },
    null,
    2,
  ),
);
