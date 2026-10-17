// node apps/android/tool/parity/compare_html_form_actions.mjs
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../../..');
const load = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const fixture = await load('fixtures/mobile-parity/html-form-actions.json');
const web = await load('fixtures/mobile-parity/html-form-actions-expected.json');
assert.equal(web.reference, fixture.webRevision);
const details = [];
let observations = 0,
  controls = 0,
  focusDifferences = 0;
const maximum = { x: 0, y: 0, width: 0, height: 0 };
for (const theme of ['light', 'dark']) {
  for (const width of fixture.widths) {
    const native = await load(
      `apps/android/build/parity/html-form-actions-native-${theme}-${width}.json`,
    );
    const reference = web.themes[theme].widths.find((row) => row.width === width);
    assert(reference, `missing browser width ${theme} ${width}`);
    const seen = new Set();
    for (const item of fixture.cases) {
      const browserCase = reference.cases.find((row) => row.id === item.id);
      assert.equal(browserCase.observations.length, item.actions.length + 1);
      for (const browser of browserCase.observations) {
        const key = `${item.id}:${browser.actionIndex}`;
        assert(!seen.has(key), `duplicate reference ${key}`);
        seen.add(key);
        const matches = native.filter(
          (row) => row.case === item.id && row.actionIndex === browser.actionIndex,
        );
        assert.equal(matches.length, 1, `missing/duplicate native ${theme} ${width} ${key}`);
        const actual = matches[0];
        assert.equal(actual.phase, browser.phase);
        assert.deepEqual(actual.clipboardWrites, browser.clipboardWrites);
        const browserControls = [...browser.controls, ...browser.buttons];
        assert.equal(actual.controls.length, browserControls.length);
        observations++;
        actual.controls.forEach((control, index) => {
          const target = browserControls[index];
          assert.equal(control.id, target.id);
          for (const field of [
            'value',
            'checked',
            'disabled',
            'accessibleName',
            'selectedIndices',
          ]) {
            if (Object.hasOwn(control, field) && Object.hasOwn(target, field)) {
              assert.deepEqual(control[field], target[field], `${key} ${target.id} ${field}`);
            }
          }
          if (target.tag === 'button') assert.equal(control.text, target.textContent);
          const focused = target.focused ?? browser.activeElement?.id === target.id;
          assert.equal(control.focusMatches, control.focused === focused);
          focusDifferences += Number(!control.focusMatches);
          controls++;
          const delta = Object.fromEntries(
            Object.keys(maximum).map((axis) => [axis, control.box[axis] - target.box[axis]]),
          );
          for (const axis of Object.keys(maximum)) {
            assert(Number.isFinite(delta[axis]), `${key} ${target.id} ${axis}`);
            assert(Math.abs(delta[axis] - control.delta[axis]) < 1e-7);
            maximum[axis] = Math.max(maximum[axis], Math.abs(delta[axis]));
          }
          details.push({
            theme,
            width,
            case: item.id,
            actionIndex: browser.actionIndex,
            phase: browser.phase,
            id: target.id,
            delta,
            focusMatches: control.focusMatches,
          });
        });
      }
    }
    assert.equal(native.length, seen.size, 'extra native observations');
  }
}
const expectedObservations =
  fixture.cases.reduce((sum, item) => sum + item.actions.length + 1, 0) * fixture.widths.length * 2;
assert.equal(observations, expectedObservations);
const summary = {
  reference: fixture.webRevision,
  observations,
  controls,
  stateAndClipboardAccepted: true,
  focusDifferences,
  maximumBoxDifference: maximum,
  measuredBoxesWithin2px: Object.values(maximum).every((value) => value <= 2),
  visualParityAccepted: false,
  limitations: [
    'Bounding boxes do not verify glyph rasterization, bevels, overflow clipping or motion.',
    'This feature fixture covers only 390/768 at text scale 1; the complete application matrix remains pending.',
  ],
  details,
};
await writeFile(
  resolve(root, 'apps/android/build/parity/html-form-actions-comparison.json'),
  JSON.stringify(summary, null, 2) + '\n',
);
console.log(JSON.stringify({ ...summary, details: undefined }, null, 2));
