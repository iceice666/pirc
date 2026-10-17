// Compare observable state and requests, retaining geometry differences separately.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const read = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const fixture = await read('fixtures/mobile-parity/workspace-settings-states.json');
const web = await read('fixtures/mobile-parity/workspace-settings-states-expected.json');
const native = await read('apps/android/build/parity/workspace-settings-states/native-measurements.json');
const expectedCount = fixture.states.length * fixture.widths.length * fixture.themes.length * fixture.textScales.length;
assert.equal(web.webRevision, fixture.webRevision);
assert.equal(native.reference ?? native.webRevision, fixture.webRevision);
assert.equal(web.cases.length, expectedCount);
assert.equal(native.cases.length, expectedCount);
assert.equal(new Set(native.cases.map(c => c.id)).size, expectedCount);
const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const captions = rows => [...new Set((rows ?? []).map(row => norm(typeof row === 'string' ? row : row.text ?? row.label)).filter(Boolean))].sort();
const workspaceRequests = rows => (rows ?? []).filter(r => /\/api\/workspaces\/[^/]+\/(instructions|capabilities|project-config|project-trust)$/.test(r.path ?? '')).map(r => ({
  method: r.method ?? 'GET', path: r.path, body: r.body ?? r.requestBody ?? null, status: r.status ?? null,
})).sort((a, b) => a.path.replace(/\/(project-config|project-trust)$/, '/project').localeCompare(b.path.replace(/\/(project-config|project-trust)$/, '/project')));
const switchLabels = ['Delegation', 'Memory search', 'Remote recall', 'Schedules', 'Web search'];
function nativeSnapshot(snapshot, stage) {
  if (snapshot.controls) return { ...snapshot, elements: snapshot.elements ?? snapshot.text, apiRequests: snapshot.apiRequests ?? stage.apiReceipts };
  return {
    ...snapshot,
    statuses: snapshot.status,
    elements: snapshot.text,
    apiRequests: stage.apiReceipts,
    controls: [
      ...(snapshot.textFields ?? []).map(field => ({ tag: 'textarea', label: 'Instructions', value: field.value, disabled: !field.enabled, rect: field.rect })),
      ...(snapshot.checkboxes ?? []).map((box, index) => ({ tag: 'input', type: 'checkbox', role: 'switch', label: switchLabels[index], checked: box.value, disabled: !box.enabled, rect: box.rect })),
      ...(snapshot.buttons ?? []).map(button => ({ tag: 'button', label: button.label, disabled: !button.enabled, rect: button.rect })),
    ],
  };
}
function controls(snapshot, isWeb) {
  const fieldsetDisabled = isWeb && snapshot.controls.some(c => c.tag === 'fieldset' && c.disabled);
  return snapshot.controls.filter(c => c.tag !== 'fieldset').map(c => {
    const kind = c.type === 'checkbox' || c.role === 'switch' ? 'switch' : c.tag === 'textarea' ? 'textarea' : c.tag === 'button' ? 'button' : c.tag;
    const value = { kind, label: norm(c.label), disabled: Boolean(c.effectiveDisabled ?? (c.disabled || (kind === 'switch' && fieldsetDisabled))) };
    if (kind === 'switch') value.checked = Boolean(c.checked);
    if (kind === 'textarea') value.value = c.value ?? '';
    return value;
  }).sort((a, b) => `${a.kind}:${a.label}`.localeCompare(`${b.kind}:${b.label}`));
}
const cases = [];
const differences = [];
const geometry = [];
let stages = 0;
const check = (id, name, w, n) => {
  if (JSON.stringify(w) !== JSON.stringify(n)) differences.push({ id, name, web: w, native: n });
};
for (const actual of native.cases) {
  const reference = web.cases.find(c => c.id === actual.id);
  assert.ok(reference, actual.id);
  check(actual.id, 'stage names', reference.stages.map(s => s.name), actual.stages.map(s => s.name ?? s.stage));
  for (const stage of actual.stages) {
    const name = stage.name ?? stage.stage;
    const referenceStage = reference.stages.find(s => s.name === name);
    assert.ok(referenceStage, `${actual.id}/${name}`);
    stages++;
    const id = `${actual.id}/${name}`;
    const w = referenceStage.top, n = nativeSnapshot(stage.top, stage), nb = nativeSnapshot(stage.bottom, stage);
    const nativeStatuses = [...(n.statuses ?? []), ...(nb.statuses ?? [])];
    const nativeAlerts = [...(n.alerts ?? []), ...(nb.alerts ?? [])];
    check(id, 'status text', captions(w.statuses), captions(nativeStatuses));
    check(id, 'alert text', captions(w.alerts), captions(nativeAlerts));
    check(id, 'controls', controls(w, true), controls(n, false));
    for (const wc of w.controls.filter(c => c.tag === 'button')) {
      const nc = n.controls.find(c => c.tag === 'button' && norm(c.label) === norm(wc.label));
      if (nc?.rect && wc.rect) for (const dim of ['x', 'width', 'height']) geometry.push({ id, name: `button-${wc.label}.${dim}`, web: wc.rect[dim], native: nc.rect[dim], delta: nc.rect[dim] - wc.rect[dim] });
    }
    check(id, 'workspace requests', workspaceRequests(w.apiRequests), workspaceRequests(n.apiRequests));
    if (w.layout?.settings && n.settingsRect) {
      for (const dim of ['x', 'y', 'width', 'height']) geometry.push({ id, name: `settings.${dim}`, web: w.layout.settings[dim], native: n.settingsRect[dim], delta: n.settingsRect[dim] - w.layout.settings[dim] });
    }
    for (const title of ['PROJECT INSTRUCTIONS', 'PROJECT CAPABILITIES', 'WORKSPACE', 'PROJECT CONFIG', 'Hooks', 'Environment', 'Allowed paths']) {
      const we = w.elements.find(e => ['h3', 'h4'].includes(e.tag) && norm(e.text).toUpperCase() === title.toUpperCase());
      const ne = n.elements.find(e => norm(e.text ?? e.name).toUpperCase() === title.toUpperCase());
      if (!we && !ne) continue;
      if (!we || !ne) { differences.push({ id, name: 'heading present', heading: title, web: Boolean(we), native: Boolean(ne) }); continue; }
      const wr = we.rect, nr = ne.rect;
      if (wr && nr) {
        for (const dim of ['y', 'height']) geometry.push({ id, name: `${title}.${dim}`, web: wr[dim], native: nr[dim], delta: nr[dim] - wr[dim] });
        const wy = wr.y - w.layout.settings.y, ny = nr.y - n.settingsRect.y;
        geometry.push({ id, name: `${title}.relativeY`, web: wy, native: ny, delta: ny - wy });
      }
    }
    cases.push({ id, webRevealScrollTop: referenceStage.revealScrollTop, nativeRevealScrollTop: stage.revealScrollTop, statuses: captions(nativeStatuses), alerts: captions(nativeAlerts), controls: controls(n, false) });
  }
}
assert.equal(stages, web.cases.reduce((sum, c) => sum + c.stages.length, 0));
const maxima = {};
for (const metric of geometry) {
  if (!maxima[metric.name] || Math.abs(metric.delta) > maxima[metric.name].absoluteDelta) maxima[metric.name] = { absoluteDelta: Math.abs(metric.delta), delta: metric.delta, id: metric.id };
}
const summary = {
  reference: fixture.webRevision, webCapturedAt: web.capturedAt, nativeCapturedAt: native.capturedAt,
  configurations: native.cases.length, stages, stateDifferences: differences, geometryMaxima: maxima,
  limitations: [
    'This compares 16 controlled settings scenarios at 390/768, two themes and two simulated font scales; the other required widths and additional transitions remain separate gates.',
    'Matching controls/captions/requests do not prove pixel, line wrapping, font rasterization, keyboard, motion or physical Android acceptance.',
    'Web fieldset disabled applies to descendant controls even when each input.disabled DOM property remains false; effective disabled is compared.',
    'Independent GETs for instructions/capabilities may be dispatched in a different order; per-resource request order and bodies/statuses are compared, keeping project-config/trust as one dependent sequence. Top/bottom native role observations are combined.',
    'Empty Web status paragraphs are omitted by native. Nonempty status/alert captions are compared; native group semantics have separate regression evidence.',
    'Top/bottom capture offsets are matched explicitly in each renderer. Per-stage control-reveal scroll before capture is also recorded; relative-to-settings heading offsets are separate from absolute geometry. Pinned Web grid overflow, font/wrapping/facts differences and config code break-all remain open. Top and bottom captures retain the observed differences.',
  ],
};
await writeFile(resolve(root, 'apps/android/build/parity/workspace-settings-states/comparison.json'), JSON.stringify({ ...summary, geometry, cases }, null, 2) + '\n');
await writeFile(resolve(root, 'fixtures/mobile-parity/workspace-settings-states-native-summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ configurations: summary.configurations, stages, stateDifferences: differences.length, geometryMaxima: maxima }, null, 2));
if (differences.length) process.exitCode = 1;
