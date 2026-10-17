// node apps/android/tool/parity/compare_conversation_history.mjs
// Verify complete long-history captures and report measured renderer geometry.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const fixture = JSON.parse(
  await readFile(resolve(root, 'fixtures/mobile-parity/conversation-history.json'), 'utf8'),
);
const webPath = resolve(
  root,
  'apps/android/build/parity/conversation-history-web/conversation-history-web.json',
);
const nativePath = resolve(
  root,
  'apps/android/build/parity/conversation-history-native/conversation-history-native.json',
);
const web = JSON.parse(await readFile(webPath, 'utf8'));
const native = JSON.parse(await readFile(nativePath, 'utf8'));

assert.equal(fixture.messages.length, 145);
assert.equal(new Set(fixture.messages.map((message) => message.id)).size, 145);
assert.deepEqual(web.widths, fixture.widths, 'browser manifest must contain all required widths');
assert.deepEqual(native.widths, fixture.widths, 'native manifest must contain all required widths');
assert.deepEqual(web.textScales, fixture.textScales);
assert.deepEqual(native.textScales, fixture.textScales);
assert.deepEqual(web.colorSchemes, ['light', 'dark']);
assert.deepEqual([...native.themes].sort(), ['dark', 'light']);
assert.equal(web.fixture, fixture.id);
assert.equal(native.fixture, fixture.id);
assert.equal(web.reference, fixture.webRevision);
assert.equal(native.webRevision, fixture.webRevision);

const states = Object.fromEntries(fixture.states.map((state) => [state.id, state]));
const axes = [];
for (const width of fixture.widths) {
  for (const theme of ['light', 'dark']) {
    for (const textScale of fixture.textScales) {
      for (const state of fixture.states) axes.push({ width, theme, textScale, state: state.id });
    }
  }
}
assert.equal(axes.length, 84, 'fixture axes must contain the required 84 tuples');

const webByTuple = indexCaptures(
  web.captures,
  (row) => `${row.width}/${row.colorScheme}/${row.textScale}/${row.state}`,
  'browser',
);
const nativeByTuple = indexCaptures(
  native.captures,
  (row) => `${row.width}/${row.theme}/${row.textScale}/${row.state}`,
  'native',
);
assert.equal(webByTuple.size, 84, 'browser must produce all 84 unique tuples');
assert.equal(nativeByTuple.size, 84, 'native must produce all 84 unique tuples');

const anchorReports = [];
const retentionViolations = [];
for (const tuple of axes) {
  const key = `${tuple.width}/${tuple.theme}/${tuple.textScale}/${tuple.state}`;
  const browserRow = webByTuple.get(key);
  const nativeRow = nativeByTuple.get(key);
  assert.ok(browserRow && nativeRow, `missing capture tuple ${key}`);
  validateState(browserRow, tuple.state, states[tuple.state], 'browser');
  validateState(nativeRow, tuple.state, states[tuple.state], 'native');
}

for (const width of fixture.widths) {
  for (const theme of ['light', 'dark']) {
    for (const textScale of fixture.textScales) {
      const key = `${width}/${theme}/${textScale}/revealed120`;
      const browserRow = webByTuple.get(key);
      const nativeRow = nativeByTuple.get(key);
      validateRetention(browserRow, fixture.anchorBoxToleranceCssPixels, `browser ${key}`);
      validateRetention(nativeRow, fixture.anchorBoxToleranceCssPixels, `native ${key}`);
      const webButtonHeight = browserRow.earlierButtonBefore?.box?.height;
      const nativeButtonHeight = nativeRow.earlierButtonBefore?.outerBox?.height;
      const webBorder = parseFloat(browserRow.earlierButtonBefore?.style?.borderTopWidth ?? 'NaN');
      const nativeBorder = nativeRow.earlierButtonBefore?.borderTopWidth;
      const webScrollDelta = browserRow.scrollHeightDelta;
      const nativeScrollDelta = nativeRow.contentExtentDelta;
      const webAnchorDelta = browserRow.anchorDeltaCssPixels;
      const nativeAnchorDelta = nativeRow.anchorDeltaCssPixels;
      anchorReports.push({
        width,
        theme,
        textScale,
        readingAnchorId: fixture.readingAnchorId,
        browser: {
          before: browserRow.anchorBefore,
          after: browserRow.anchorAfter,
          deltaCssPixels: webAnchorDelta,
          earlierButtonBefore: browserRow.earlierButtonBefore,
          earlierButtonAfter: browserRow.earlierButtonAfter,
          scrollBefore: browserRow.scrollBefore,
          scrollAfter: browserRow.scrollAfter,
          scrollHeightDelta: webScrollDelta,
          maxExtentDelta: browserRow.maxExtentDelta,
        },
        native: {
          before: nativeRow.anchorBefore,
          after: nativeRow.anchorAfter,
          deltaCssPixels: nativeAnchorDelta,
          earlierButtonBefore: nativeRow.earlierButtonBefore,
          earlierButtonAfter: nativeRow.earlierButtonAfter,
          scrollBefore: nativeRow.scrollBefore,
          scrollAfter: nativeRow.scrollAfter,
          contentExtentDelta: nativeScrollDelta,
          maxExtentDelta: nativeRow.maxExtentDelta,
        },
        residuals: {
          anchorNativeMinusBrowserCssPixels: nativeAnchorDelta - webAnchorDelta,
          buttonHeightNativeMinusBrowserCssPixels: nativeButtonHeight - webButtonHeight,
          borderTopWidthNativeMinusBrowserCssPixels: nativeBorder - webBorder,
          contentExtentGrowthNativeMinusBrowserCssPixels: nativeScrollDelta - webScrollDelta,
        },
      });
    }
  }
}

const maximum = (rows, pick) => Math.max(...rows.map((row) => Math.abs(pick(row))));
const summary = {
  fixture: fixture.id,
  browserCaptures: web.captures.length,
  nativeCaptures: native.captures.length,
  requiredUniqueTuples: axes.length,
  messageCount: fixture.messages.length,
  stateHiddenCounts: fixture.states.map((state) => ({
    id: state.id,
    hiddenMessages: state.hiddenMessages,
    visibleMessages: state.visibleMessages,
  })),
  anchorToleranceCssPixels: fixture.anchorBoxToleranceCssPixels,
  maximumAbsoluteAnchorShift: {
    browser: maximum(anchorReports, (row) => row.browser.deltaCssPixels),
    native: maximum(anchorReports, (row) => row.native.deltaCssPixels),
  },
  maximumAbsoluteCrossRendererResidual: {
    anchorCssPixels: maximum(
      anchorReports,
      (row) => row.residuals.anchorNativeMinusBrowserCssPixels,
    ),
    earlierButtonHeightCssPixels: maximum(
      anchorReports,
      (row) => row.residuals.buttonHeightNativeMinusBrowserCssPixels,
    ),
    contentExtentGrowthCssPixels: maximum(
      anchorReports,
      (row) => row.residuals.contentExtentGrowthNativeMinusBrowserCssPixels,
    ),
  },
  retentionViolationCount: retentionViolations.length,
  visualParityAccepted: false,
  sourceSetup: fixture.runtimeStubs.description,
};
const report = { summary, anchorReports, retentionViolations };
const outputPath = resolve(root, 'apps/android/build/parity/conversation-history-comparison.json');
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ outputPath, summary }, null, 2));

function indexCaptures(captures, keyOf, client) {
  assert.equal(captures.length, axes.length, `${client} must produce exactly 84 captures`);
  const indexed = new Map();
  for (const row of captures) {
    const key = keyOf(row);
    assert.ok(!indexed.has(key), `${client} duplicate tuple ${key}`);
    indexed.set(key, row);
  }
  return indexed;
}

function validateState(row, stateId, state, client) {
  const key = `${row.width}/${row.colorScheme ?? row.theme}/${row.textScale}/${stateId}`;
  const sourceIds = fixture.messages.slice(state.hiddenMessages).map((message) => message.id);
  assert.equal(row.state, stateId, `${client} ${key} state`);
  assert.equal(row.hiddenMessages, state.hiddenMessages, `${client} ${key} hidden count`);
  assert.equal(row.messageCount, 145, `${client} ${key} full source count`);
  assert.equal(row.renderedIds.length, state.visibleMessages, `${client} ${key} rendered count`);
  assert.equal(
    new Set(row.renderedIds).size,
    row.renderedIds.length,
    `${client} ${key} duplicate rendered IDs`,
  );
  assert.deepEqual(row.renderedIds, sourceIds, `${client} ${key} missing/reordered IDs`);
  assert.equal(row.sourceMatchesFixture, true, `${client} ${key} original source contents`);
  assert.equal(row.sourceUniqueIdCount, 145, `${client} ${key} unique source IDs`);
  assert.equal(
    row.readingAnchor?.id ?? row.readingAnchorId,
    fixture.readingAnchorId,
    `${client} ${key} anchor ID`,
  );
  assert.ok(row.readingAnchor?.box ?? row.readingAnchor, `${client} ${key} anchor box`);
}

function validateRetention(row, tolerance, client) {
  assert.ok(row.anchorBefore && row.anchorAfter, `${client} actual before/after anchor boxes`);
  for (const side of ['left', 'top', 'right', 'bottom', 'width', 'height']) {
    assert.ok(
      Number.isFinite(row.anchorBefore[side]) && Number.isFinite(row.anchorAfter[side]),
      `${client} anchor ${side} must contain measured finite geometry`,
    );
    const delta = row.anchorAfter[side] - row.anchorBefore[side];
    if (Math.abs(delta) > tolerance)
      retentionViolations.push({
        client,
        width: row.width,
        theme: row.colorScheme ?? row.theme,
        textScale: row.textScale,
        side,
        deltaCssPixels: delta,
        toleranceCssPixels: tolerance,
      });
  }
  assert.ok(row.earlierButtonBefore, `${client} earlier button before reveal geometry`);
  assert.ok(row.earlierButtonAfter, `${client} earlier button after reveal geometry`);
  assert.ok(row.scrollBefore && row.scrollAfter, `${client} actual before/after scroll extents`);
}
