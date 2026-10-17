import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixture = JSON.parse(await readFile(resolve(root, 'fixtures/mobile-parity/notification-matrix.json'), 'utf8'));
const build = resolve(root, 'apps/android/build/parity');
const cases = [], nativeOnly = [], missing = [], inconsistentAnchors = [];
const tolerance = 0.5;
function compareBox(metrics, label, web, native, dimensions = ['x', 'y', 'width', 'height']) {
  if (!web || !native) { metrics.push({ label, missing: web ? 'native' : 'web' }); return; }
  for (const dimension of dimensions) {
    const delta = native[dimension] - web[dimension];
    metrics.push({ label: `${label}.${dimension}`, web: web[dimension], native: native[dimension], delta, withinTolerance: Math.abs(delta) <= tolerance });
  }
}
function checkAnchors(id, state, renderer, anchors) {
  for (const [anchorId, item] of Object.entries(anchors ?? {})) {
    const actual = renderer === 'web' ? item.capture.chrome.panelScrollTop : item.capture.notification.panelScrollTop;
    const expected = item.anchor.panelScrollTopAfter;
    if (Math.abs(actual - expected) > .01 || !item.anchor.targetIntersectsPanelViewport || !item.anchor.targetIntersectsBrowserViewport) {
      inconsistentAnchors.push({ id, state, renderer, anchorId, actual, expected });
    }
    const related = item.anchor.relatedGeometry.title;
    const measured = renderer === 'web' ? item.capture.heading.box : item.capture.notification.heading;
    if (related && measured && Math.abs(related.y - measured.y) > .01) {
      inconsistentAnchors.push({ id, state, renderer, anchorId, error: 'Related title geometry differs from nested capture' });
    }
  }
}
function cssColor(color) {
  const parts = color?.match(/[\d.]+/g)?.map(Number);
  if (!parts || parts.length < 3) return null;
  const alpha = Math.round((parts[3] ?? 1) * 255).toString(16).padStart(2, '0');
  return `#${alpha}${parts.slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('')}`;
}
for (const width of fixture.widths) for (const theme of fixture.themes) for (const scale of fixture.textScales) {
  const id = `${width}-${theme}-scale${scale}`;
  let web, native;
  try {
    web = JSON.parse(await readFile(resolve(build, 'notification-matrix', id, 'capture.json'), 'utf8'));
    native = JSON.parse(await readFile(resolve(build, 'notification-matrix-native', id, 'capture.json'), 'utf8'));
  } catch (error) { missing.push({ id, error: error.message }); continue; }
  for (const [state, webState] of Object.entries(web.states)) {
    const counterpart = native.cases.find(item => item.id === state);
    if (!counterpart) { missing.push({ id, state }); continue; }
    const reference = webState.capture;
    const metrics = [], feedback = [];
    compareBox(metrics, 'frame', reference.chrome.dialogBox, counterpart.settingsFrame);
    compareBox(metrics, 'heading', reference.heading.box, counterpart.notification.heading);
    for (const control of reference.controls) {
      const match = counterpart.notification.buttons.find(item => item.label === control.text);
      if (match) compareBox(metrics, `button.${control.text}`, control.box, match);
    }
    for (const item of reference.alerts) {
      const match = counterpart.notification.visibleText.find(text => text.text === item.text);
      feedback.push({ webRole: item.role, webText: item.text, nativeText: match?.text ?? null, webColor: cssColor(item.style.color), nativeColor: match?.color ?? null });
      if (match) compareBox(metrics, `feedback.${item.text}`, item.box, match, ['x', 'y', 'height']);
    }
    checkAnchors(id, state, 'web', webState.focusedAnchors);
    checkAnchors(id, state, 'native', counterpart.focusedAnchors);
    const focused = {};
    for (const [anchorId, referenceAnchor] of Object.entries(webState.focusedAnchors)) {
      const target = counterpart.focusedAnchors?.[anchorId];
      focused[anchorId] = target ? {
        webScreenshot: referenceAnchor.screenshot, nativeScreenshot: target.screenshot,
        webScroll: referenceAnchor.anchor.panelScrollTopAfter, nativeScroll: target.anchor.panelScrollTopAfter,
        webTarget: referenceAnchor.anchor.targetText, nativeTarget: target.anchor.targetText,
        sameTargetText: referenceAnchor.anchor.targetText === target.anchor.targetText,
      } : { missing: 'native' };
    }
    cases.push({ id, state, nativeState: counterpart.nativeState, platformDifference: counterpart.comparisonNote,
      nativeLayoutError: counterpart.layoutError, metrics, feedback, focused,
      geometryResiduals: metrics.filter(item => item.missing || !item.withinTolerance).length });
  }
  for (const extra of native.cases.filter(item => !web.states[item.id])) {
    checkAnchors(id, extra.id, 'native', extra.focusedAnchors);
    nativeOnly.push({ id, state: extra.id, nativeState: extra.nativeState, note: extra.comparisonNote, layoutError: extra.layoutError });
  }
}
const report = {
  webRevision: fixture.webRevision, purpose: 'Measured comparisons and declared platform differences; this report is not pixel or device acceptance.',
  tolerance, sharedStates: cases.length, nativeOnlyStates: nativeOnly.length, missing, inconsistentAnchors,
  casesWithGeometryResiduals: cases.filter(item => item.geometryResiduals > 0).length,
  cases, nativeOnly,
};
await writeFile(resolve(build, 'notification-matrix-comparison.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ sharedStates: report.sharedStates, nativeOnlyStates: report.nativeOnlyStates, missing: missing.length, inconsistentAnchors: inconsistentAnchors.length, casesWithGeometryResiduals: report.casesWithGeometryResiduals }));
if (missing.length || inconsistentAnchors.length) process.exitCode = 1;
