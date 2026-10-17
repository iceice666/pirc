import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixture = JSON.parse(await readFile(resolve(root, 'fixtures/mobile-parity/settings-matrix.json'), 'utf8'));
const build = resolve(root, 'apps/android/build/parity');
const sourceManifest = JSON.parse(await readFile(resolve(build, 'settings-matrix/run-manifest.json'), 'utf8'));
assert.equal(sourceManifest.webRevision, fixture.webRevision, 'Web source revision differs');
assert.equal(sourceManifest.mode, 'full', 'Web reference is a partial run');
for (const key of ['widths', 'themes', 'textScales', 'tabs']) {
  assert.deepEqual(sourceManifest[key], fixture[key], `Web ${key} coverage differs`);
}
const expectedCaseCount = fixture.widths.length * fixture.themes.length * fixture.textScales.length * fixture.tabs.length;
assert.equal(sourceManifest.expectedCaseCount, expectedCaseCount);
const expectedConfigIds = fixture.widths.flatMap(width => fixture.themes.flatMap(theme =>
  fixture.textScales.map(scale => `${width}-${theme}-scale${scale}`)));
assert.deepEqual(sourceManifest.cases.map(item => item.id).sort(), [...expectedConfigIds].sort(), 'Web configuration IDs differ');
assert.equal(sourceManifest.completedSupplementalDeviceTokenCaseCount,
  expectedConfigIds.length * sourceManifest.supplementalDeviceTokenCasesPerConfiguration,
  'Paired-device source references are incomplete');
const cases = [];
const missing = [];
const tolerance = 0.5;
const normalize = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase();

function compareBox(metrics, label, web, native, dimensions = ['x', 'y', 'width', 'height']) {
  if (!web || !native) {
    metrics.push({ label, missing: web ? 'native' : 'web' });
    return;
  }
  for (const dimension of dimensions) {
    const delta = native[dimension] - web[dimension];
    metrics.push({ label: `${label}.${dimension}`, web: web[dimension], native: native[dimension], delta, withinTolerance: Math.abs(delta) <= tolerance });
  }
}

for (const width of fixture.widths) {
  for (const theme of fixture.themes) {
    for (const scale of fixture.textScales) {
      const id = `${width}-${theme}-scale${scale}`;
      let web, native;
      try {
        web = JSON.parse(await readFile(resolve(build, 'settings-matrix', id, 'capture.json'), 'utf8'));
        native = JSON.parse(await readFile(resolve(build, 'settings-matrix-native', id, 'geometry.json'), 'utf8'));
      } catch (error) {
        missing.push({ id, error: error.message });
        continue;
      }
      assert.equal(native.webRevision, fixture.webRevision, `${id}: Native fixture revision missing or wrong`);
      assert.equal(native.width, width, `${id}: native width differs`);
      assert.equal(native.theme, theme, `${id}: native theme differs`);
      assert.equal(native.textScale, scale, `${id}: native scale differs`);
      assert.deepEqual(native.tabs.flatMap(tab => tab.layoutErrors ?? []), [], `${id}: native layout errors`);
      for (const tab of fixture.tabs) {
        const deviceReference = web.deviceTokenCaptures?.[tab];
        const reference = deviceReference?.ui ?? web.tabCaptures[tab];
        const capture = native.tabs.find((entry) => entry.tab === tab);
        if (!reference || !capture) {
          missing.push({ id, tab, error: 'Missing tab capture' });
          continue;
        }
        const metrics = [];
        compareBox(metrics, 'frame', reference.frame.dialog.box, capture.frame);
        compareBox(metrics, 'header', reference.frame.header.box, capture.header.bounds);
        compareBox(metrics, 'content', reference.frame.content.box, capture.content.viewport);
        for (const item of reference.frame.navigation.items) {
          const label = item.id.replace('settings-tab-', '');
          const nativeLabel = Object.keys(capture.nav.tabs).find((value) => normalize(value) === label);
          compareBox(metrics, `tab.${label}`, item.box, capture.nav.tabs[nativeLabel]);
        }
        const unmatchedHeadings = [];
        for (const heading of reference.textElements.filter((element) => element.tag === 'h3' || element.tag === 'h4')) {
          const match = capture.content.visibleText.find((element) => normalize(element.fullText ?? element.text) === normalize(heading.fullText ?? heading.text));
          if (match) compareBox(metrics, `heading.${heading.text}`, heading.box, match);
          else unmatchedHeadings.push({ web: heading.text });
        }
        const unmatchedText = [];
        const comparedText = new Set();
        for (const text of reference.textElements.filter((element) => element.tag === 'p' || (element.tag === 'label' && element.className.includes('settings-toggle')))) {
          const key = normalize(text.fullText ?? text.text);
          if (!key) continue;
          if (comparedText.has(key)) continue;
          const match = capture.content.visibleText.find((element) => normalize(element.fullText ?? element.text) === key);
          if (!match) {
            unmatchedText.push({ web: text.fullText ?? text.text, tag: text.tag, reason: 'No exact native text record; missing content or capture fragmentation needs inspection.' });
            continue;
          }
          comparedText.add(key);
          compareBox(metrics, `text.${text.text}`, text.box, match, ['y', 'height']);
        }
        const controlStateDifferences = [];
        if (tab === 'devices') {
          const webName = reference.controls.find(control => control.tag === 'input' && control.label === 'Device name');
          const nativeName = capture.content.textFields.find(field => field.key === 'device-name');
          const webPair = reference.controls.find(control => control.tag === 'button' && control.text === 'Pair device');
          const nativePair = capture.content.actions.find(action => action.label === 'Pair device');
          compareBox(metrics, 'device-name', webName?.box, nativeName);
          compareBox(metrics, 'pair-device', webPair?.box, nativePair);
          for (const [label, webControl, nativeControl] of [
            ['device-name', webName, nativeName], ['pair-device', webPair, nativePair],
          ]) {
            if (!webControl || !nativeControl || webControl.disabled !== !nativeControl.enabled) {
              controlStateDifferences.push({ label, webDisabled: webControl?.disabled, nativeEnabled: nativeControl?.enabled });
            }
          }
        }
        cases.push({
          id, tab,
          authContext: ['models', 'devices'].includes(tab) ? (deviceReference ? 'paired-device' : 'MISMATCH: web admin reference / native paired-device') : 'permitted read',
          webScrollTop: reference.frame.content.scrollTop,
          nativeScrollTop: capture.content.scroll.offset,
          nativeLayoutErrors: capture.layoutErrors,
          metrics,
          unmatchedHeadings,
          unmatchedText,
          controlStateDifferences,
          remainingGeometryDifferences: metrics.filter((metric) => metric.missing || !metric.withinTolerance).length,
        });
      }
    }
  }
}
const report = {
  sourceWebSha: fixture.webRevision,
  purpose: 'Geometry comparison only; matching boxes do not prove pixel, typography, behavior or physical-device parity.',
  tolerance, capturedCases: cases.length, missing,
  casesWithControlStateDifferences: cases.filter(entry => entry.controlStateDifferences.length).length,
  casesWithUnmatchedText: cases.filter(entry => entry.unmatchedText.length || entry.unmatchedHeadings.length).length,
  casesWithGeometryDifferences: cases.filter((entry) => entry.remainingGeometryDifferences > 0).length,
  cases,
};
await mkdir(build, { recursive: true });
await writeFile(resolve(build, 'settings-matrix-comparison.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ capturedCases: report.capturedCases, missing: missing.length, casesWithGeometryDifferences: report.casesWithGeometryDifferences, casesWithUnmatchedText: report.casesWithUnmatchedText, casesWithControlStateDifferences: report.casesWithControlStateDifferences }));

assert.deepEqual(missing, [], 'Settings capture coverage is incomplete');
assert.equal(cases.length, expectedCaseCount, 'Settings case count differs');
assert.ok(cases.every(item => !item.authContext.startsWith('MISMATCH')), 'Web/native authorization contexts differ');
