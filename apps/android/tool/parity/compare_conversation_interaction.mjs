// Run after both complete --interactive/PARITY_CAPTURE_INTERACTIVE captures.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../../../..');
const out = resolve(root, 'apps/android/build/parity');
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const fixture = await read(
  resolve(root, 'fixtures/mobile-parity/conversation-interaction-screen.json'),
);
const web = await read(resolve(out, 'conversation-interaction-screen-web.json'));
const native = await read(resolve(out, 'conversation-interaction-screen-native.json'));
assert.equal(web.fixture, fixture.id);
assert.equal(native.fixture, fixture.id);
assert.equal(web.reference, fixture.webRevision);
assert.equal(native.webRevision, fixture.webRevision);
const webRows = Object.values(web.themes).flatMap((theme) =>
  theme.widths.flatMap((width) => width.cases),
);
const key = (row) =>
  [row.case ?? row.id, row.width, row.theme ?? row.colorScheme, row.textScale].join('/');
const webByKey = new Map(webRows.map((row) => [key(row), row]));
const nativeByKey = new Map(native.captures.map((row) => [key(row), row]));
const count = fixture.widths.length * 2 * fixture.textScales.length * fixture.cases.length;
assert.equal(webRows.length, count, 'Requires the complete web matrix');
assert.equal(webByKey.size, count, 'Duplicate web tuple');
assert.equal(native.captures.length, count, 'Requires the complete native matrix');
assert.equal(nativeByKey.size, count, 'Duplicate native tuple');
const surfaces = [
  ['header', (row) => row.elements.topbar[0]?.box, (row) => row.bounds.header],
  ['composer', (row) => row.elements.composer[0]?.box, (row) => row.bounds.composerSurface],
  ['transcript', (row) => row.elements.timeline[0]?.box, (row) => row.bounds.timelineViewport],
  [
    'question',
    (row) => row.elements.interactionCards[0]?.box,
    (row) => row.interactionEvidence.card,
  ],
  ['queueDock', (row) => row.elements.composerDock[0]?.box, (row) => row.interactionEvidence.dock],
];
const geometry = Object.fromEntries(
  surfaces.map(([name]) => [
    name,
    { compared: 0, differing: 0, maximum: { left: 0, top: 0, width: 0, height: 0 } },
  ]),
);
const differences = [];
for (const scenario of fixture.cases)
  for (const width of fixture.widths)
    for (const theme of ['light', 'dark'])
      for (const textScale of fixture.textScales) {
        const tuple = key({ case: scenario.id, width, theme, textScale });
        const w = webByKey.get(tuple),
          n = nativeByKey.get(tuple);
        assert.ok(w && n, 'Missing tuple ' + tuple);
        assert.deepEqual(w.pageErrors, []);
        assert.deepEqual(w.consoleErrors, []);
        assert.deepEqual(w.badResponses, []);
        assert.deepEqual(w.interactionEvidence.hoveredOptions, [], tuple + ' sticky hover');
        assert.ok(
          w.networkCalls.every((call) => call.fixtureResponse),
          tuple + ' unexpected route',
        );
        assert.equal(n.controller.connection, 'live');
        assert.equal(n.controller.control.held, true);
        for (const ids of [w.appState.messageIds, n.controller.messageIds])
          assert.deepEqual(
            ids,
            fixture.messages.map((message) => message.id),
          );
        for (const draft of [w.appState.draft, n.controller.draft])
          assert.equal(draft, fixture.draft);
        assert.deepEqual(
          w.appState.uploadIds,
          fixture.attachments.map((file) => file.id),
        );
        assert.deepEqual(
          n.controller.attachments.map((file) => file.id),
          fixture.attachments.map((file) => file.id),
        );
        const pendingIds = scenario.answer
          ? []
          : fixture.state.interactions.map((question) => question.id);
        const selectedLabels = scenario.choice
          ? [
              fixture.state.interactions[0].options.find(
                (option) => option.value === scenario.choice,
              ).label,
            ]
          : [];
        for (const evidence of [w.interactionEvidence, n.interactionEvidence]) {
          assert.deepEqual(evidence.pendingIds, pendingIds, tuple + ' pending questions');
          assert.deepEqual(evidence.selectedLabels, selectedLabels, tuple + ' actual selection');
          assert.deepEqual(
            evidence.queueIds,
            fixture.state.queue.map((item) => item.id),
          );
          assert.equal(evidence.runStatus, fixture.state.run.status);
        }
        const webAnswers = w.networkCalls.filter((call) => call.url.endsWith('/answer'));
        const nativeAnswers = n.interactionEvidence.answers;
        assert.equal(webAnswers.length, scenario.answer ? 1 : 0);
        assert.equal(nativeAnswers.length, scenario.answer ? 1 : 0);
        if (scenario.answer) {
          assert.equal(webAnswers[0].method, 'POST');
          assert.equal(webAnswers[0].body.generation, 7);
          assert.deepEqual(webAnswers[0].body.answer, { value: scenario.answer.value });
          assert.deepEqual(nativeAnswers[0], {
            sessionId: fixture.session.id,
            interactionId: scenario.answer.interactionId,
            epoch: fixture.state.interactions[0].epoch,
            origin: 'https://gateway.example',
            pairingStamp: 'conversation-screen-fixture-pairing-stamp',
            answer: { values: [scenario.answer.value] },
          });
        }
        for (const [name, webBox, nativeBox] of surfaces) {
          const wb = webBox(w),
            nb = nativeBox(n);
          assert.equal(Boolean(wb), Boolean(nb), tuple + ' missing ' + name);
          if (!wb) continue;
          const delta = Object.fromEntries(
            ['left', 'top', 'width', 'height'].map((field) => [field, nb[field] - wb[field]]),
          );
          const summary = geometry[name];
          summary.compared++;
          for (const field of Object.keys(delta))
            summary.maximum[field] = Math.max(summary.maximum[field], Math.abs(delta[field]));
          if (Object.values(delta).some((value) => Math.abs(value) > 0.05)) {
            summary.differing++;
            differences.push({ tuple, surface: name, delta });
          }
        }
      }
const report = {
  fixture: fixture.id,
  reference: fixture.webRevision,
  configurations: count,
  interactionAndStateAssertions: 'passed',
  geometry,
  differences,
  scope:
    'Host Arial/Menlo; real App widgets and answer handlers, controlled gateway responses; single select, waiting-input snapshot and queued prompts. Geometry differences are recorded, not accepted as pixel equality. No live-stream, complete question-kind/state, backend delivery or Android lifecycle acceptance claim.',
};
await writeFile(
  resolve(out, 'conversation-interaction-comparison.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    {
      configurations: count,
      interactionAndStateAssertions: report.interactionAndStateAssertions,
      geometry,
    },
    null,
    2,
  ),
);
