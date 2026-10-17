// Compare observed geometry; this deliberately makes no pixel-parity claim.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const fixture = JSON.parse(await readFile(resolve(root, 'fixtures/mobile-parity/workspace-matrix.json'), 'utf8'));
const web = JSON.parse(await readFile(resolve(root, 'fixtures/mobile-parity/workspace-matrix-expected.json'), 'utf8'));
const native = JSON.parse(await readFile(resolve(root, 'apps/android/build/parity/workspace-matrix/native-measurements.json'), 'utf8'));
assert.equal(native.reference, fixture.webRevision);
assert.equal(web.webRevision, fixture.webRevision);
const expectedCount = fixture.states.length * fixture.widths.length * fixture.themes.length * fixture.textScales.length;
assert.equal(web.cases.length, expectedCount);
assert.equal(native.cases.length, expectedCount);
assert.equal(new Set(native.cases.map(c => c.id)).size, expectedCount);
const maxima = {};
const cases = [];
const normalize = text => text?.replace(/\s+/g, ' ').trim().toLowerCase();
for (const actual of native.cases) {
  const reference = web.cases.find(c => c.id === actual.id);
  assert.ok(reference, actual.id);
  const metrics = [];
  const uncomparedControls = [];
  const box = name => actual.elements.find(e => e.name === name)?.rect;
  const compare = (name, w, n, dimensions = ['x', 'y', 'width', 'height']) => {
    assert.ok(w && n, `${actual.id}: missing ${name}`);
    for (const dimension of dimensions) {
      const key = `${name}.${dimension}`;
      const delta = n[dimension] - w[dimension];
      metrics.push({ key, web: w[dimension], native: n[dimension], delta });
      if (!maxima[key] || Math.abs(delta) > maxima[key].absoluteDelta) {
        maxima[key] = { absoluteDelta: Math.abs(delta), delta, case: actual.id };
      }
    }
  };
  const frame = reference.top.frame;
  const page = reference.top.page;
  compare('workspace', frame.workspace, box('workspace'));
  compare('header', page.header, box('header'));
  compare('tabs', page.tabs.rect, box('tabs'));
  compare('body', page.body, box('body'));
  if (actual.width <= 650) compare('mobile-tabs', frame.mobileTabs, box('mobile-tabs'));
  for (const heading of page.elements.filter(e => ['h3', 'h4'].includes(e.tag))) {
    compare(`heading-${normalize(heading.text)}`, heading.rect,
      box(heading.tag === 'h3' ? heading.text.toUpperCase() : heading.text), ['y', 'height']);
  }
  for (const control of page.controls) {
    if (control.tag === 'textarea') compare('textarea', control.rect, box('textarea'));
    else if (control.tag === 'button' && box(control.label)) compare(`button-${control.label}`, control.rect, box(control.label));
    else if (control.type === 'checkbox') {
      const key = { Delegation: 'delegation', 'Memory search': 'memory_search', 'Remote recall': 'remote_recall', Schedules: 'schedules', 'Web search': 'web_search' }[control.label];
      compare(`checkbox-${key}`, control.rect, box(`checkbox-${key}`));
    } else uncomparedControls.push({ tag: control.tag, label: control.label, type: control.type });
  }
  if (actual.scroll) {
    const delta = actual.scroll.viewport - page.scrollViewport.height;
    metrics.push({ key: 'scroll-viewport.height', web: page.scrollViewport.height, native: actual.scroll.viewport, delta });
    const key = 'scroll-viewport.height';
    if (!maxima[key] || Math.abs(delta) > maxima[key].absoluteDelta) maxima[key] = { absoluteDelta: Math.abs(delta), delta, case: actual.id };
  }
  cases.push({ id: actual.id, metrics, uncomparedControls });
}
const limitations = [
  'Geometry only. Host SFNS/SFNSMono and loaded icon fonts do not prove Android rasterization, glyph or physical-device parity.',
  'Session-row controls, code-block internals and text glyphs are not measured individually by this comparator.',
  'Three populated states only: sessions, chat settings, untrusted directory configuration. Loading/error/offline/invalid/revoke and other interactions are separate pending gates.',
  'Native bounded desktop workspace differs from the pinned Web implicit grid row which can exceed the viewport and clip settings. Measured height differences remain visible in this report.',
  'Font line metrics, code wrapping (Web break-all versus native word wrapping), session ages (wall clock not frozen), checkbox glyph and resize appearance remain explicit differences.',
  'No safe area, IME, rotation, animation or physical-device capture. Font scaling is a two-pass !important DOM simulation, not OS browser text scaling.',
];
const report = { reference: fixture.webRevision, webCapturedAt: web.capturedAt, nativeCapturedAt: native.capturedAt, cases: cases.length, limitations, maxima, measurements: cases };
await writeFile(resolve(root, 'apps/android/build/parity/workspace-matrix/comparison.json'), JSON.stringify(report, null, 2) + '\n');
const { measurements, ...summary } = report;
await writeFile(resolve(root, 'fixtures/mobile-parity/workspace-matrix-native-summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ cases: report.cases, maxima }, null, 2));
