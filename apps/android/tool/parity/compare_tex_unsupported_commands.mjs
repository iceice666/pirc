import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const read = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const fixture = await read('fixtures/mobile-parity/tex-unsupported-commands.json');
const web = await read('fixtures/mobile-parity/tex-unsupported-commands-expected.json');
const native = await read('apps/android/build/parity/tex-unsupported-commands/native-measurements.json');
assert.equal(web.webRevision, fixture.webRevision);
const count = fixture.cases.length * fixture.capture.widths.length * fixture.capture.themes.length * fixture.capture.textScales.length;
assert.equal(native.captureCount, count);
assert.deepEqual(native.validationErrors, []);
const rows = [], differences = [], maxima = {};
for (const nc of native.configurations) {
  const wc = web.configurations.find(c => c.viewport.width === nc.viewport.width && c.theme === nc.theme && c.textScale === nc.textScale);
  assert.ok(wc, nc.id);
  assert.equal(nc.cases.length, fixture.cases.length);
  for (const n of nc.cases) {
    const f = fixture.cases.find(c => c.id === n.id), w = wc.cases.find(c => c.id === n.id);
    assert.ok(f && w, n.id);
    const target = w.mathNodes[f.targetMathIndex];
    const id = `${nc.id}/${n.id}`;
    if (n.actualKind !== f.expectedKind) differences.push({ id, kind: n.actualKind, expected: f.expectedKind });
    assert.equal(n.layoutException, null, id);
    const expectedRed = f.expectedRedText ?? [];
    const astRed = (n.target.redAstRuns ?? []).map(r => r.text);
    if (f.expectedKind === 'rendered-with-unsupported-command') {
      assert.deepEqual(astRed, expectedRed, `${id}: actual AST error text`);
      assert.ok(n.target.redRenderedTextRuns.length, `${id}: no painted red glyphs`);
    } else if (f.expectedKind === 'normal-rendered') assert.deepEqual(astRed, [], `${id}: known syntax colored as unsupported`);
    else {
      assert.ok(n.target.parseError, `${id}: expected structural failure`);
      assert.deepEqual(n.target.fallbackText.map(r => r.text), expectedRed, `${id}: raw error expression`);
      assert.ok(n.target.fallbackText.every(r => r.color === '#ffcc0000'), `${id}: error text color`);
    }
    assert.deepEqual(n.beforeExpressions, f.expectedBeforeAnnotations, `${id}: neighboring formulas before`);
    assert.deepEqual(n.afterExpressions, f.expectedAfterAnnotations, `${id}: neighboring formulas after`);
    assert.ok(n.neighborMath.every(m => !m.parseError), `${id}: neighboring math failed`);
    const box = n.target.partsMathPaintRectUnion ?? n.target.mathBox;
    const webBox = target.baseUnionRect ?? target.rect;
    const deltas = {};
    for (const dimension of ['width', 'height']) {
      const delta = box[dimension] - webBox[dimension];
      deltas[dimension] = delta;
      if (!maxima[dimension] || Math.abs(delta) > maxima[dimension].absoluteDelta) maxima[dimension] = { absoluteDelta: Math.abs(delta), delta, id };
    }
    rows.push({ id, kind: n.actualKind, red: astRed, webDomSpan: target.rect, webMathBaseUnion: target.baseUnionRect, webMathBases: target.baseBoxes, nativeLayout: n.target.targetLayoutBox,
      nativeMathPartsUnion: box, webBaseline: target.baseline, nativeBaseline: n.target.baseline,
      webMathBlock: target.mathBlockRect, nativeMathBlock: n.target.displayBlockBox, deltas });
  }
}
assert.equal(rows.length, count);
const report = {
  reference: fixture.webRevision, webCapturedAt: web.capturedAt, captures: count,
  classificationDifferences: differences, paintedPartVsWebBaseMaxima: maxima,
  limitations: [
    'Classification, error-color/AST and preserved-neighbor agreement do not prove complete formula or pixel parity.',
    'Web top-level .base union and native painted Math-part union are compared for rendered formulas. Full-width display .katex wrappers remain separate; whole-error span and native text line boxes are recorded as different quantities.',
    'Native inline fragments currently wrap inside an atomic outer Markdown widget. The browser can place a leading fragment alongside preceding prose; this can add a native row in narrow enlarged-text cases.',
    'The later equation-tag checkpoint implements def/gdef/edef/xdef and manual/automatic tags; their geometry/grammar acceptance remains separate. Error-title tooltip, MathML speech/selection, font/glyph metrics and remaining grammar/device cases are unaccepted requirements.',
    'These captures use host Arial and package math fonts, zero safe area/IME, two widths/themes and two text scales; the remaining required widths and physical Android flows are not accepted here.',
  ],
};
await writeFile(resolve(root, 'apps/android/build/parity/tex-unsupported-commands/comparison.json'), JSON.stringify({ ...report, rows }, null, 2) + '\n');
await writeFile(resolve(root, 'fixtures/mobile-parity/tex-unsupported-commands-native-summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ captures: count, classificationDifferences: differences.length, maxima }, null, 2));
if (differences.length) process.exitCode = 1;
