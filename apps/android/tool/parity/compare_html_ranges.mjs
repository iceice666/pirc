// Summarize the browser/native control matrix after capture_html_ranges_test.dart.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const fixture = JSON.parse(
  await readFile(resolve(root, 'fixtures/mobile-parity/html-ranges.json'), 'utf8'),
);
const web = JSON.parse(
  await readFile(resolve(root, 'fixtures/mobile-parity/html-ranges-expected.json'), 'utf8'),
);
assert.equal(fixture.webRevision, 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c');
assert.equal(web.reference, fixture.webRevision);
const expectedCaseIds = new Set(fixture.cases.map((item) => item.id));
const themes = {};
let tupleCount = 0;
let controlObservationCount = 0;
let focusMismatches = 0;
let touchValueMaxDelta = 0;

for (const theme of ['light', 'dark']) {
  themes[theme] = {};
  for (const width of fixture.widths) {
    const nativePath = resolve(
      root,
      `apps/android/build/parity/html-ranges-native-${theme}-${width}.json`,
    );
    const nativeRows = JSON.parse(await readFile(nativePath, 'utf8'));
    const webCases = web.themes[theme].widths.find((row) => row.width === width).cases;
    const expectedRows = webCases.flatMap((item) => item.observations);
    if (nativeRows.length !== expectedRows.length) {
      throw new Error(
        `${theme}/${width}: ${nativeRows.length}/${expectedRows.length} observations`,
      );
    }
    const nativeIndex = new Map(nativeRows.map((row) => [`${row.case}\0${row.phase}`, row]));
    if (nativeIndex.size !== expectedRows.length) {
      throw new Error(`${theme}/${width}: duplicate native phase tuples`);
    }
    const allGeometry = [];
    let allInitial = [];
    let ordinaryInitial = [];
    let maxTouchDelta = 0;
    let focusMismatchesThisConfig = 0;

    for (const webRow of expectedRows) {
      if (!expectedCaseIds.has(webRow.id)) throw new Error(`Unknown fixture case ${webRow.id}`);
      const nativeRow = nativeIndex.get(`${webRow.id}\0${webRow.phase}`);
      if (!nativeRow)
        throw new Error(`Missing native tuple ${theme}/${width}/${webRow.id}/${webRow.phase}`);
      tupleCount++;
      if (nativeRow.controls.length !== webRow.controls.length) {
        throw new Error(`${theme}/${width}/${webRow.id}/${webRow.phase}: control count mismatch`);
      }
      for (let index = 0; index < webRow.controls.length; index++) {
        const reference = webRow.controls[index];
        const actual = nativeRow.controls[index];
        if (actual.id !== reference.id) {
          throw new Error(`${theme}/${width}/${webRow.id}/${webRow.phase}: control order mismatch`);
        }
        controlObservationCount++;
        for (const [axis, deltaKey] of Object.entries({
          x: 'deltaX',
          y: 'deltaY',
          width: 'deltaWidth',
          height: 'deltaHeight',
        })) {
          const delta = actual.box[axis] - reference.box[axis];
          assert(Number.isFinite(delta));
          assert(Math.abs(delta - actual.box[deltaKey]) < 1e-8);
        }
        allGeometry.push(actual.box);
        if (actual.focused !== reference.focused) {
          focusMismatches++;
          focusMismatchesThisConfig++;
        }
        if (nativeRow.phase === 'touch-drag') {
          const difference = Math.abs(Number(actual.value) - Number(reference.value));
          const tolerance = actual.range.stepAny
            ? (Number(actual.range.max) - Number(actual.range.min)) / 100
            : Number(actual.range.step);
          assert(Number.isFinite(difference) && Number.isFinite(tolerance));
          assert(
            difference <= tolerance + 1e-9,
            `${actual.id}: touch exceeds configured tolerance`,
          );
          maxTouchDelta = Math.max(maxTouchDelta, difference);
          touchValueMaxDelta = Math.max(touchValueMaxDelta, difference);
        } else if (actual.value !== reference.value) {
          throw new Error(
            `${theme}/${width}/${webRow.id}/${webRow.phase}/${actual.id}: value mismatch ${actual.value} vs ${reference.value}`,
          );
        }
        if (nativeRow.phase === 'initial') {
          const entry = {
            case: webRow.id,
            id: actual.id,
            deltaX: actual.box.deltaX,
            deltaY: actual.box.deltaY,
            deltaWidth: actual.box.deltaWidth,
            deltaHeight: actual.box.deltaHeight,
          };
          allInitial.push(entry);
          if (!webRow.id.startsWith('fieldset')) ordinaryInitial.push(entry);
        }
      }
    }

    const maxima = (rows) =>
      Object.fromEntries(
        ['deltaX', 'deltaY', 'deltaWidth', 'deltaHeight'].map((key) => [
          key,
          Math.max(...rows.map((row) => Math.abs(row[key]))),
        ]),
      );
    const outliers = allInitial.filter(
      (row) =>
        Math.abs(row.deltaX) > 10 ||
        Math.abs(row.deltaY) > 2 ||
        Math.abs(row.deltaWidth) > 0.1 ||
        Math.abs(row.deltaHeight) > 0.1,
    );
    themes[theme][width] = {
      observations: nativeRows.length,
      controlObservations: nativeRows.reduce((sum, row) => sum + row.controls.length, 0),
      initialControls: allInitial.length,
      maxAbsoluteGeometryDelta: maxima(allGeometry),
      initialMaxAbsoluteGeometryDelta: maxima(allInitial),
      ordinaryMaxAbsoluteGeometryDelta: maxima(ordinaryInitial),
      initialGeometryOutliers: outliers,
      focusMismatches: focusMismatchesThisConfig,
      maxTouchValueDelta: maxTouchDelta,
    };
  }
}

const expectedTupleCount =
  4 * fixture.cases.reduce((count, item) => count + 1 + (item.actions?.length ?? 0), 0);
if (tupleCount !== expectedTupleCount) {
  throw new Error(`${tupleCount}/${expectedTupleCount} total capture tuples`);
}
const report = {
  fixture: fixture.id,
  browser: web.browserVersion,
  reference: fixture.webRevision,
  matrix: { themes: 2, widths: fixture.widths, cases: fixture.cases.length },
  tupleCount,
  controlObservationCount,
  focusMismatches,
  touchValueMaxDelta,
  touchTolerance:
    'At most one configured step, or 1% of the range for step=any; keyboard and boundary values match exactly.',
  visualParityAccepted: false,
  themes,
};
const output = resolve(root, 'apps/android/build/parity/html-ranges-comparison.json');
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    { output, tupleCount, controlObservationCount, focusMismatches, touchValueMaxDelta, themes },
    null,
    2,
  ),
);
