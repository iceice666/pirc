// Compare native timeline captures with the pinned Chrome oracle.
// Geometry differences are reported as measurements; no visual-pass tolerance
// is applied here because the capture is still diagnostic.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '../../../..');
const fixturePath = resolve(root, 'fixtures/mobile-parity/mermaid-timeline.json');
const expectedPath = resolve(root, 'fixtures/mobile-parity/mermaid-timeline-expected.json');
const summaryPath = resolve(
  root,
  process.argv[2] ?? 'apps/android/build/parity/mermaid-timeline-native/summary.json',
);
const revision = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';

const [fixture, expected, native] = await Promise.all([
  readFile(fixturePath, 'utf8').then(JSON.parse),
  readFile(expectedPath, 'utf8').then(JSON.parse),
  readFile(summaryPath, 'utf8').then(JSON.parse),
]);
assert.equal(fixture.webRevision, revision, 'fixture must pin the Web revision');
assert.equal(expected.reference, revision, 'expected must pin the Web revision');
assert.equal(native.reference, revision, 'native summary must pin the Web revision');
assert.equal(fixture.mermaidVersion, '11.17.2');
assert.equal(expected.mermaidVersion, '11.17.2');
execFileSync('git', ['diff', '--exit-code', revision, '--', 'apps/web', ':!apps/web/tool'], { cwd: root });

const assertFiniteTree = (value, path = 'root') => {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `non-finite numeric value at ${path}: ${value}`);
    return;
  }
  if (typeof value === 'string') {
    assert.ok(!/^(?:NaN|[-+]?Infinity)$/.test(value), `non-finite numeric string at ${path}: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteTree(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertFiniteTree(item, `${path}.${key}`);
  }
};

const validatePinnedIdentity = (fixtureValue, expectedValue, nativeValue) => {
  assert.equal(fixtureValue.webRevision, revision);
  assert.equal(expectedValue.reference, revision);
  assert.equal(nativeValue.reference, revision);
  assert.equal(fixtureValue.id, expectedValue.fixture);
  assert.equal(fixtureValue.id, nativeValue.fixture);
  assert.equal(fixtureValue.mermaidVersion, '11.17.2');
  assert.equal(expectedValue.mermaidVersion, '11.17.2');
  assert.equal(nativeValue.requiredReference, revision);
};

const validateExpectedManifest = (fixtureValue, expectedValue) => {
  const caseIds = fixtureValue.cases.map((item) => item.id);
  assert.equal(new Set(caseIds).size, caseIds.length, 'fixture case IDs must be unique');
  assert.deepEqual(expectedValue.cases.map((item) => item.id), caseIds, 'expected source case manifest must exactly match fixture');
  assert.deepEqual(Object.keys(expectedValue.themes).sort(), [...fixtureValue.themes].sort(), 'expected source themes must match fixture');
  assert.deepEqual(expectedValue.matrix.widths, fixtureValue.widths);
  assert.deepEqual(expectedValue.matrix.themes, fixtureValue.themes);
  assert.deepEqual(expectedValue.matrix.textScales, fixtureValue.textScales);
  assert.equal(expectedValue.matrix.height, fixtureValue.height);
  assert.equal(expectedValue.deviceScaleFactor, fixtureValue.deviceScaleFactor);

  for (const brightness of fixtureValue.themes) {
    const widthRows = expectedValue.themes[brightness].widths;
    assert.deepEqual(widthRows.map((row) => row.width), fixtureValue.widths, `source width manifest for ${brightness}`);
    for (const widthRow of widthRows) {
      const scaleRows = widthRow.scales;
      assert.deepEqual(scaleRows.map((row) => Number(row.textScale)), fixtureValue.textScales, `source scale manifest for ${brightness}/${widthRow.width}`);
      for (const scaleRow of scaleRows) {
        const ids = scaleRow.cases.map((row) => row.id);
        assert.equal(new Set(ids).size, ids.length, `source cases must be unique at ${brightness}/${widthRow.width}/${scaleRow.textScale}`);
        assert.deepEqual(ids, caseIds, `source cases must be complete and ordered at ${brightness}/${widthRow.width}/${scaleRow.textScale}`);
        for (const row of scaleRow.cases) {
          const item = fixtureValue.cases.find((candidate) => candidate.id === row.id);
          assert.equal(row.status, item.expectedStatus ?? 'ok', `source status for ${row.id}/${brightness}/${widthRow.width}/${scaleRow.textScale}`);
          if (row.status === 'ok') {
            const geometryId = row.svg?.geometryId;
            assert.ok(geometryId && expectedValue.geometryCatalog[geometryId]?.shared, `source geometry missing for ${row.id}/${brightness}/${widthRow.width}/${scaleRow.textScale}`);
          }
        }
      }
    }
  }
};

const assertNodeCount = (sourceNodes, nativeNodes, label) => {
  assert.equal(nativeNodes.length, sourceNodes.length, `${label} source/native node count`);
};

const normalizeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const modulo = (value, base) => ((value % base) + base) % base;

const runGateMutationProbes = () => {
  const missing = structuredClone(expected);
  missing.themes.light.widths[0].scales[0].cases.pop();
  assert.throws(() => validateExpectedManifest(fixture, missing), /complete and ordered/);

  const duplicate = structuredClone(expected);
  duplicate.themes.light.widths[0].scales[0].cases.push(
    structuredClone(duplicate.themes.light.widths[0].scales[0].cases[0]),
  );
  assert.throws(() => validateExpectedManifest(fixture, duplicate), /must be unique/);

  const wrongRevision = structuredClone(expected);
  wrongRevision.reference = 'wrong-source-sha';
  assert.throws(() => validatePinnedIdentity(fixture, wrongRevision, native));

  const nonFinite = { x: Number.NaN };
  assert.throws(() => assertFiniteTree(nonFinite, 'mutation'), /non-finite numeric value/);

  assert.throws(() => assertNodeCount([{}, {}], [{}], 'mutation'), /source\/native node count/);
  return [
    'missing source config rejected',
    'duplicate source case rejected',
    'wrong source SHA rejected',
    'non-finite geometry rejected',
    'source/native node-count mismatch rejected',
  ];
};

validatePinnedIdentity(fixture, expected, native);
validateExpectedManifest(fixture, expected);
assertFiniteTree(expected, 'expected');
assertFiniteTree(native, 'native');
const mutationProbesPassed = runGateMutationProbes();

const number = (value) => Number(value);
const cssColor = (value) => {
  if (!value) return null;
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return value.toLowerCase();
  const parts = match[1].split(',').map((part) => part.trim());
  const rgb = parts.slice(0, 3).map((part) => Math.round(Number.parseFloat(part)));
  const alpha = parts[3] === undefined ? 255 : Math.round(Number.parseFloat(parts[3]) * 255);
  return `#${[...rgb, alpha].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
};
const nativeColor = (value) => {
  if (!value) return null;
  const color = value.startsWith('#') ? value.slice(1) : value;
  if (color.length === 6) return `#${color.toLowerCase()}ff`;
  return `#${color.toLowerCase()}`;
};
const parseViewBox = (value) => {
  const parts = String(value).trim().split(/[ ,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
};
const rectDelta = (actual, source) => actual && source ? {
  x: actual.x - source.x,
  y: actual.y - source.y,
  width: actual.width - source.width,
  height: actual.height - source.height,
} : null;
const worst = (list, selector) => list.reduce((best, item) => {
  const amount = Math.abs(selector(item) ?? 0);
  return !best || amount > Math.abs(selector(best) ?? 0) ? item : best;
}, null);
const stateKey = (row) => `${row.case}|${row.viewport?.width ?? row.width}|${row.brightness}|${row.textScale}`;
const expectedCase = (id, width, brightness, scale) => {
  const theme = expected.themes[brightness];
  const widthRow = theme.widths.find((row) => row.width === width);
  const scaleRow = widthRow?.scales.find((row) => number(row.textScale) === number(scale));
  return scaleRow?.cases.find((row) => row.id === id) ?? null;
};
const geometryFor = (reference) => {
  const geometryId = reference.svg.geometryId;
  const catalog = expected.geometryCatalog[geometryId];
  assert.ok(catalog?.shared, `missing shared source geometry ${geometryId}`);
  return { geometryId, shared: catalog.shared };
};
const nativeCssNodeBox = (node, nativeState) => {
  const scale = nativeState.native.scale;
  const viewBox = nativeState.native.viewBox;
  // NativeMermaidTimeline can fill the viewport while its CustomPaint is
  // centered within it. SVG coordinates therefore start at the actual painter.
  const painter = nativeState.native.painterBox;
  const bounds = node.bounds;
  return {
    // NativePlacedNode.bounds is already translated into timeline user space.
    x: painter.x + (bounds.x - viewBox.x) * scale,
    y: painter.y + (bounds.y - viewBox.y) * scale,
    width: bounds.width * scale,
    height: bounds.height * scale,
  };
};
const nativeCssPathBox = (node, nativeState) => {
  const scale = nativeState.native.scale;
  const viewBox = nativeState.native.viewBox;
  const painter = nativeState.native.painterBox;
  const bounds = node.geometry.backgroundPathBounds;
  return {
    x: painter.x + (node.position.x + bounds.x - viewBox.x) * scale,
    y: painter.y + (node.position.y + bounds.y - viewBox.y) * scale,
    width: bounds.width * scale,
    height: bounds.height * scale,
  };
};
const nativeCssFontCellBox = (node, line, nativeState) => {
  const scale = nativeState.native.scale;
  const viewBox = nativeState.native.viewBox;
  const painter = nativeState.native.painterBox;
  const transform = node.geometry.textTransform;
  const bounds = line.fontCellBounds;
  return {
    x: painter.x + (node.position.x + transform.x + bounds.x - viewBox.x) * scale,
    y: painter.y + (node.position.y + transform.y + bounds.y - viewBox.y) * scale,
    width: bounds.width * scale,
    height: bounds.height * scale,
  };
};
const renderedLinesByNode = (nativeState) => {
  const result = new Map();
  for (const entry of nativeState.native.renderedTextWidgets ?? []) {
    if (entry.role !== 'node-line') continue;
    const group = result.get(entry.nodeIndex) ?? [];
    group[entry.lineIndex] = entry.rendered;
    result.set(entry.nodeIndex, group);
  }
  return result;
};

const baselineOnly = native.captureMode === '390-light-scale1-baseline';
const expectedStates = [];
for (const idCase of fixture.cases) {
  for (const width of fixture.widths) {
    for (const brightness of fixture.themes) {
      for (const textScale of fixture.textScales) {
        if (baselineOnly && (width !== 390 || brightness !== 'light' || textScale !== 1)) continue;
        expectedStates.push({ case: idCase.id, width, brightness, textScale });
      }
    }
  }
}
const expectedKeys = new Set(expectedStates.map(stateKey));
const capturesByKey = new Map();
for (const capture of native.captures ?? []) {
  const key = stateKey(capture);
  assert.ok(expectedKeys.has(key), `unexpected native state ${key}`);
  assert.ok(!capturesByKey.has(key), `duplicate native state ${key}`);
  capturesByKey.set(key, capture);
}
const missing = [...expectedKeys].filter((key) => !capturesByKey.has(key));
assert.equal(missing.length, 0, `missing requested native states: ${missing.join(', ')}`);
assert.equal(native.captures.length, expectedStates.length, 'native requested-mode state count');
assert.equal(native.captureCompleteForRequestedMode, true, 'native capture must complete requested mode');
assert.equal(native.statusParityComplete, true, 'native/Web status parity gate must pass');

const results = [];
const nodeMeasures = [];
const lineMeasures = [];
const boxMeasures = [];
const colorMismatches = [];
const statusMismatches = [];
const nodeCountMismatches = [];
const titleMeasures = [];
let nodeClassChecks = 0;
let descriptionChecks = 0;
let tspanChecks = 0;
let kindCountChecks = 0;

for (const capture of native.captures) {
  const source = expectedCase(
    capture.case,
    capture.viewport.width,
    capture.brightness,
    capture.textScale,
  );
  assert.ok(source, `missing Chrome reference for ${stateKey(capture)}`);
  const expectedSourceStatus = fixture.cases.find((row) => row.id === capture.case)?.expectedStatus;
  const parsedSource = expected.parsedCases[capture.case]?.[capture.brightness];
  assert.ok(parsedSource, `missing pinned source parser result for ${stateKey(capture)}`);
  assert.equal(parsedSource.status, source.status, `source parser/SVG status for ${stateKey(capture)}`);
  if (source.status === 'error') {
    assert.ok(parsedSource.errorText, `pinned source error text missing for ${stateKey(capture)}`);
    assert.ok(capture.nativeError, `native error text missing for ${stateKey(capture)}`);
    assert.equal(capture.native, null, `errored native state must not carry a layout: ${stateKey(capture)}`);
  } else {
    assert.equal(parsedSource.status, 'ok', `pinned source parser error for ${stateKey(capture)}`);
    assert.ok(parsedSource.api, `pinned source API data missing for ${stateKey(capture)}`);
    assert.ok(capture.native, `valid native state missing layout: ${stateKey(capture)}`);
    assert.equal(capture.nativeError, null, `unexpected native error at ${stateKey(capture)}`);
  }
  const statusMatches = capture.status === source.status &&
    capture.status === (expectedSourceStatus === 'error' ? 'error' : 'ok');
  if (!statusMatches) statusMismatches.push({ key: stateKey(capture), source: source.status, native: capture.status, expectedSourceStatus });

  const boxDeltas = {
    block: rectDelta(capture.nativeBlockBox, source.html.block.box),
    figureLineBox: rectDelta(capture.native?.figureLineBox ?? null, source.html.figure?.box ?? null),
    svgPainter: rectDelta(capture.nativePainterBox, source.svg?.box ?? null),
  };
  for (const [role, delta] of Object.entries(boxDeltas)) {
    if (delta) boxMeasures.push({ case: capture.case, status: capture.status, width: capture.viewport.width, brightness: capture.brightness, textScale: capture.textScale, role, delta });
  }

  const result = {
    key: stateKey(capture),
    status: {
      source: source.status,
      native: capture.status,
      matches: statusMatches,
      sourceError: source.errorText ?? parsedSource.errorText ?? null,
      nativeError: capture.nativeError ?? null,
    },
    screenshot: capture.screenshot ?? null,
    boxes: {
      source: { block: source.html.block.box, figure: source.html.figure?.box ?? null, svg: source.svg?.box ?? null },
      native: { block: capture.nativeBlockBox, figureLineBox: capture.native?.figureLineBox ?? null, diagramWidget: capture.nativeFigureBox, painter: capture.nativePainterBox },
      deltas: boxDeltas,
    },
    viewBox: null,
    nodeCount: null,
    nodes: [],
    title: null,
    fontMetadata: native.fontMetadata,
  };

  if (capture.status === 'ok') {
    const { geometryId, shared } = geometryFor(source);
    const sourceViewBox = parseViewBox(shared.attrs.viewBox);
    const nativeViewBox = capture.native.viewBox;
    result.viewBox = {
      geometryId,
      source: sourceViewBox,
      native: nativeViewBox,
      delta: rectDelta(nativeViewBox, sourceViewBox),
      sourceSvgUserSpace: true,
      nativeSvgUserSpace: true,
    };
    const sourceNodes = shared.timelineNodes;
    const nativeNodes = capture.native.nodes;
    assertNodeCount(sourceNodes, nativeNodes, result.key);
    result.nodeCount = { source: sourceNodes.length, native: nativeNodes.length, matches: sourceNodes.length === nativeNodes.length };
    if (sourceNodes.length !== nativeNodes.length) {
      nodeCountMismatches.push({ key: result.key, source: sourceNodes.length, native: nativeNodes.length });
    }
    const sourceApi = parsedSource.api;
    const expectedLabelsByKind = {
      section: sourceApi.sections.map(normalizeText),
      task: sourceApi.tasks.map((task) => normalizeText(task.task)),
      event: sourceApi.tasks.flatMap((task) => task.events.map(normalizeText)),
    };
    const actualLabelsByKind = Object.fromEntries(
      Object.keys(expectedLabelsByKind).map((kind) => [
        kind,
        nativeNodes.filter((node) => node.kind === kind).map((node) => normalizeText(node.description)),
      ]),
    );
    for (const kind of Object.keys(expectedLabelsByKind)) {
      assert.deepEqual(actualLabelsByKind[kind], expectedLabelsByKind[kind], `${result.key} ${kind} descriptions/order`);
    }
    kindCountChecks++;
    const renderedLines = renderedLinesByNode(capture);
    for (let index = 0; index < Math.min(sourceNodes.length, nativeNodes.length); index++) {
      const sourceNode = sourceNodes[index];
      const sourceTextIndices = sourceNode.textIndices ?? [];
      const sourceText = shared.texts[sourceTextIndices.find((textIndex) => shared.texts[textIndex]?.tag === 'text') ?? sourceTextIndices[0]];
      const sourceLines = sourceTextIndices
        .map((textIndex) => ({ textIndex, text: shared.texts[textIndex] }))
        .filter((entry) => entry.text?.tag === 'tspan');
      const sourceLineEntries = sourceLines.length
        ? sourceLines
        : [{ textIndex: sourceTextIndices[0], text: sourceText }];
      const sourceShape = shared.shapes[sourceNode.shapeIndices?.[0]];
      const nativeNode = nativeNodes[index];
      const sourceClassIndex = Number(sourceNode.class?.match(/(?:^|\s)section-(-?\d+)(?:\s|$)/)?.[1]);
      assert.ok(Number.isFinite(sourceClassIndex), `${result.key} source class token missing: ${sourceNode.class}`);
      const sourcePaletteIndex = modulo(sourceClassIndex + 1, 12);
      assert.equal(nativeNode.colorIndex, sourcePaletteIndex, `${result.key} node ${index} source class/palette index`);
      assert.equal(nativeNode.event, nativeNode.kind === 'event', `${result.key} node ${index} event role`);
      nodeClassChecks++;
      const sourceTspanText = sourceLineEntries.map((entry) => String(entry.text?.text ?? '')).join(' ');
      const nativeRawLineText = nativeNode.geometry.lines.map((line) => String(line.rawText ?? '')).join(' ');
      const normalizedSourceText = normalizeText(sourceTspanText || sourceText?.text);
      const normalizedNativeText = normalizeText(nativeRawLineText || nativeNode.description);
      // Description text is checked against the Mermaid parser API above.
      // SVG tspans represent rendered lines, so `<br>` can split one parser
      // description into multiple visible strings without appearing literally.
      assert.equal(normalizedSourceText, normalizedNativeText, `${result.key} node ${index} complete rendered text`);
      assert.equal(sourceLineEntries.length, nativeNode.geometry.lines.length, `${result.key} node ${index} tspan/native line count`);
      for (let lineIndex = 0; lineIndex < sourceLineEntries.length; lineIndex++) {
        assert.equal(
          normalizeText(sourceLineEntries[lineIndex].text?.text),
          normalizeText(nativeNode.geometry.lines[lineIndex].rawText),
          `${result.key} node ${index} tspan text line ${lineIndex}`,
        );
        tspanChecks++;
      }
      descriptionChecks++;
      const sourceGroupBox = source.svg.timelineNodeBoxes?.[index] ?? null;
      const sourcePathBox = source.svg.shapeBoxes?.[sourceNode.shapeIndices?.[0]] ?? null;
      const sourceLocalPath = sourceShape?.bbox ?? null;
      const sourceNodeBoxDelta = rectDelta(nativeCssNodeBox(nativeNode, capture), sourceGroupBox);
      const nativePathCssBox = nativeCssPathBox(nativeNode, capture);
      const sourcePathBoxDelta = rectDelta(nativePathCssBox, sourcePathBox);
      const sourcePathLocalDelta = rectDelta(nativeNode.geometry.backgroundPathBounds, sourceLocalPath);
      const nativeNodeLocalDelta = rectDelta(nativeNode.geometry.localBounds, sourceNode.bbox);
      const nativeLines = nativeNode.geometry.lines ?? [];
      const lines = [];
      for (let lineIndex = 0; lineIndex < Math.max(sourceLineEntries.length, nativeLines.length); lineIndex++) {
        const webLine = sourceLineEntries[lineIndex]?.text ?? null;
        const nativeLine = nativeLines[lineIndex] ?? null;
        const textIndex = sourceLineEntries[lineIndex]?.textIndex;
        const sourceLineBox = textIndex === undefined ? null : source.svg.textBoxes?.[textIndex] ?? null;
        const nativeLineBox = nativeLine ? nativeCssFontCellBox(nativeNode, nativeLine, capture) : null;
        const normalizedSourceText = webLine?.text?.replace(/\s+/g, ' ').trim() ?? null;
        const normalizedNativeText = nativeLine?.paintText?.replace(/\s+/g, ' ').trim() ?? null;
        if (webLine && nativeLine) {
          assert.equal(normalizedSourceText, normalizeText(nativeLine.rawText), `${result.key} node ${index} source/native tspan line ${lineIndex}`);
        }
        const textMetrics = nativeLine && webLine ? {
          source: {
            text: webLine.text,
            computedTextLength: webLine.computedTextLength,
            fontFamily: webLine.computed?.fontFamily,
            fontSize: webLine.computed?.fontSize,
            bbox: webLine.bbox,
            viewportBox: sourceLineBox,
            dy: webLine.attrs?.dy ?? null,
          },
          native: {
            rawText: nativeLine.rawText,
            paintText: nativeLine.paintText,
            advanceWidth: nativeLine.advanceWidth,
            baseline: nativeLine.baseline,
            dy: nativeLine.dy,
            fontCellBounds: nativeLine.fontCellBounds,
            viewportBox: nativeLineBox,
            actualFlutterSelectionBoxes: renderedLines.get(index)?.[lineIndex]?.selectionBoxes ?? null,
          },
          normalizedTextMatches: normalizedSourceText === normalizedNativeText,
          widthDelta: nativeLine.advanceWidth - webLine.computedTextLength,
          modelFontCellVersusSvgObservation: {
            semantics: 'Native model font-cell bounds are measured before final SVG placement; Chrome SVG getBBox and client rectangles are post-sizing observations. These are diagnostic measurements, not SDK selection boxes or a visual pass gate.',
            nativeLocalFontCell: nativeLine.fontCellBounds,
            sourceLocalSvgTextBox: webLine.bbox,
            localDiagnosticDelta: rectDelta(nativeLine.fontCellBounds, webLine.bbox),
            nativeViewportFontCell: nativeLineBox,
            sourceViewportSvgTextBox: sourceLineBox,
            viewportDiagnosticDelta: rectDelta(nativeLineBox, sourceLineBox),
            actualFlutterSelectionBoxes: renderedLines.get(index)?.[lineIndex]?.selectionBoxes ?? null,
          },
        } : { source: webLine ? webLine.text : null, native: nativeLine?.paintText ?? null, missingSide: webLine ? 'native' : 'source' };
        if (textMetrics.widthDelta !== undefined) lineMeasures.push({ key: result.key, node: index, line: lineIndex, delta: textMetrics });
        lines.push(textMetrics);
      }
      const sourceFill = cssColor(sourceShape?.computed?.fill);
      const nativeFill = nativeColor(nativeNode.paintColors?.paletteBeforeEventBrightness);
      const nativePaintFill = nativeColor(nativeNode.paintColors?.actualBackgroundDrawColorAfterEventBrightness);
      const sourceTextColor = cssColor(sourceText?.computed?.fill);
      const nativeTextColor = nativeColor(nativeNode.paintColors?.labelBeforeEventBrightness);
      const nativePaintTextColor = nativeColor(nativeNode.paintColors?.actualLabelDrawColorAfterEventBrightness);
      const fillMatches = sourceFill === nativeFill;
      const textColorMatches = sourceTextColor === nativeTextColor;
      if (!fillMatches || !textColorMatches) {
        colorMismatches.push({ key: result.key, node: index, text: sourceText?.text, sourceFill, nativeFill, sourceTextColor, nativeTextColor, nativePaintFill, nativePaintTextColor });
      }
      const nodeRecord = {
        index,
        label: { source: sourceText?.text ?? null, native: nativeNode.description, normalizedMatches: (sourceText?.text ?? '').replace(/\s+/g, ' ').trim() === (nativeNode.description ?? '').replace(/\s+/g, ' ').trim() },
        kind: nativeNode.kind,
        sourceClass: sourceNode.class,
        sourceShape: { tag: sourceShape?.tag ?? null, class: sourceShape?.class ?? null, id: sourceShape?.id ?? null, attrs: sourceShape?.attrs ?? null, computed: sourceShape?.computed ?? null },
        geometry: {
          sourceGroupBox: sourceGroupBox,
          nativeGroupBox: nativeCssNodeBox(nativeNode, capture),
          groupViewportDelta: sourceNodeBoxDelta,
          sourcePathLocalBox: sourceLocalPath,
          nativePathLocalBox: nativeNode.geometry.backgroundPathBounds,
          pathLocalDelta: sourcePathLocalDelta,
          sourcePathViewportBox: sourcePathBox,
          nativePathViewportBox: nativePathCssBox,
          pathViewportDelta: sourcePathBoxDelta,
          sourceNodeLocalBox: sourceNode.bbox,
          nativeNodeLocalBox: nativeNode.geometry.localBounds,
          nodeLocalDelta: nativeNodeLocalDelta,
          sourceDrawnHeight: sourceLocalPath?.height ?? null,
          nativeDrawnHeight: nativeNode.geometry.height,
          nativePreflightVirtualHeight: nativeNode.geometry.virtualHeight,
          virtualHeightRelationship: 'Native preflight virtualHeight is reported separately; the Chrome oracle captures post-sizing SVG paths, not the renderer preflight virtual value.',
        },
        colors: { sourceFill, nativeFill, fillMatches, sourceTextColor, nativeTextColor, textColorMatches, nativePaintColors: nativeNode.paintColors },
        sourceTextBBox: sourceText?.bbox ?? null,
        nativeTextFontCellUnionPreTransform: nativeNode.geometry.textFontCellUnionPreTransform,
        textFontCellUnionVsSvgGeometry: {
          semantics: 'Native union is the renderer’s preflight font-cell model; Chrome source bbox is the post-sizing SVG getBBox. The raw measurements are retained without treating them as actual Flutter selection boxes.',
          nativeFontCellUnion: nativeNode.geometry.textFontCellUnionPreTransform,
          sourceSvgTextBBox: sourceText?.bbox ?? null,
          diagnosticDelta: rectDelta(nativeNode.geometry.textFontCellUnionPreTransform, sourceText?.bbox),
        },
        lines,
      };
      result.nodes.push(nodeRecord);
      nodeMeasures.push({ key: result.key, index, text: nodeRecord.label.source, group: sourceNodeBoxDelta, pathLocal: sourcePathLocalDelta, pathViewport: sourcePathBoxDelta });
    }

    const titleText = capture.native.title?.text;
    if (titleText) {
      const memberTextIndexes = new Set(sourceNodes.flatMap((node) => node.textIndices ?? []));
      const titleSourceIndex = shared.texts.findIndex((text, index) => text.tag === 'text' && text.text === titleText && !memberTextIndexes.has(index));
      const sourceTitle = titleSourceIndex < 0 ? null : shared.texts[titleSourceIndex];
      const sourceTitleBox = titleSourceIndex < 0 ? null : source.svg.textBoxes?.[titleSourceIndex] ?? null;
      const nativeWidget = capture.native.title.renderedWidget;
      const nativeSelectionUnion = nativeWidget?.selectionBoxes?.reduce((acc, box) => {
        if (!acc) return { ...box };
        const left = Math.min(acc.x, box.x); const top = Math.min(acc.y, box.y);
        const right = Math.max(acc.x + acc.width, box.x + box.width);
        const bottom = Math.max(acc.y + acc.height, box.y + box.height);
        return { x: left, y: top, width: right - left, height: bottom - top };
      }, null) ?? null;
      result.title = {
        source: sourceTitle ? { text: sourceTitle.text, computed: sourceTitle.computed, bbox: sourceTitle.bbox, viewportBox: sourceTitleBox, computedTextLength: sourceTitle.computedTextLength } : null,
        native: capture.native.title,
        nativeSelectionUnion,
        sourceSvgTextClientRect: sourceTitleBox,
        selectionVersusSvgGeometry: {
          semantics: 'These are actual Flutter TextPainter selection rectangles compared diagnostically with the Chrome SVG text client rectangle; they use different box definitions.',
          viewportDiagnosticDelta: rectDelta(nativeSelectionUnion, sourceTitleBox),
        },
        sourceTitleLookupIndex: titleSourceIndex,
      };
      assert.equal(capture.native.title.text, sourceTitle?.text, `${result.key} title content`);
      if (sourceTitle) titleMeasures.push({ key: result.key, delta: rectDelta(nativeSelectionUnion, sourceTitleBox), fontSize: { source: sourceTitle.computed?.fontSize, native: capture.native.title.style?.fontSize } });
    } else if (source.svg.textBoxes?.length) {
      result.title = { source: null, native: null, note: 'No native timeline title in this state.' };
    }
  }
  results.push(result);
}

assert.equal(statusMismatches.length, 0, `status mismatches: ${JSON.stringify(statusMismatches)}`);
assert.equal(nodeCountMismatches.length, 0, `node count mismatches: ${JSON.stringify(nodeCountMismatches)}`);
assert.equal(colorMismatches.length, 0, `base palette mismatches: ${JSON.stringify(colorMismatches)}`);
const fullMatrixComplete = native.captures.length === fixture.cases.length * fixture.widths.length * fixture.themes.length * fixture.textScales.length;
const validBoxMeasures = boxMeasures.filter((row) => row.status === 'ok');
const errorBoxMeasures = boxMeasures.filter((row) => row.status === 'error');
const maxima = {
  block: Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, worst(validBoxMeasures.filter((row) => row.role === 'block'), (row) => row.delta[key])])),
  figureLineBox: Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, worst(validBoxMeasures.filter((row) => row.role === 'figureLineBox'), (row) => row.delta[key])])),
  svgPainter: Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, worst(validBoxMeasures.filter((row) => row.role === 'svgPainter'), (row) => row.delta[key])])),
  errorBlock: Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, worst(errorBoxMeasures.filter((row) => row.role === 'block'), (row) => row.delta[key])])),
  nodeGroupViewport: Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, worst(nodeMeasures, (row) => row.group?.[key])])),
  nodePathLocal: Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, worst(nodeMeasures, (row) => row.pathLocal?.[key])])),
  lineTextWidth: worst(lineMeasures, (row) => row.delta.widthDelta),
  lineFontCellVersusSvgDiagnostic: Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, worst(lineMeasures, (row) => row.delta.modelFontCellVersusSvgObservation?.viewportDiagnosticDelta?.[key])])),
  titleSelectionVersusSvgDiagnostic: Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, worst(titleMeasures, (row) => row.delta?.[key])])),
};
const output = {
  fixture: fixture.id,
  reference: revision,
  nativeCaptureMode: native.captureMode,
  sourceGate: 'Pinned Web production tree diff checked against bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c, excluding only apps/web/tool.',
  statesCompared: results.length,
  fullMatrixStatesExpected: fixture.cases.length * fixture.widths.length * fixture.themes.length * fixture.textScales.length,
  requestedModeComplete: true,
  fullMatrixComplete,
  statusAndNodeCountGatesPassed: true,
  qualityGates: {
    fixtureAndRevisionIdentity: true,
    completeUniqueSourceManifest: true,
    completeUniqueNativeStateManifest: true,
    finiteNumericMeasurements: true,
    nativeSourceStatusAndNodeCounts: true,
    sourceClassToNativePaletteIndexes: nodeClassChecks,
    parsedDescriptionsAndRenderedText: descriptionChecks,
    sourceTspanLinesCompared: tspanChecks,
    sourceNativeKindCounts: kindCountChecks,
    exactBasePaletteColors: colorMismatches.length === 0,
    singleLineTextAssertions: native.captures.reduce((count, capture) =>
      count + (capture.native?.renderedTextWidgets?.filter((entry) => entry.rendered?.singleLineNoRewrap).length ?? 0), 0),
  },
  mutationProbesPassed,
  visualParityAccepted: false,
  note: 'This report preserves source and native geometry with their distinct measurement semantics. All residuals remain diagnostics; no pixel or geometry threshold is treated as a visual-parity pass.',
  fontMetadata: native.fontMetadata,
  maxima,
  colorMismatchCount: colorMismatches.length,
  colorMismatches,
  captures: results,
};
const outputPath = resolve(dirname(summaryPath), 'comparison.json');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({
  outputPath,
  nativeCaptureMode: native.captureMode,
  statesCompared: results.length,
  fullMatrixStatesExpected: output.fullMatrixStatesExpected,
  fullMatrixComplete,
  maxValidBlockHeightDelta: maxima.block.height?.delta?.height ?? null,
  maxFigureLineBoxHeightDelta: maxima.figureLineBox.height?.delta?.height ?? null,
  maxSvgPainterHeightDelta: maxima.svgPainter.height?.delta?.height ?? null,
  maxNodeGroupYDelta: maxima.nodeGroupViewport.y,
  maxNodeTextWidthDelta: maxima.lineTextWidth,
  colorMismatchCount: colorMismatches.length,
  mutationProbeCount: mutationProbesPassed.length,
  visualParityAccepted: false,
}, null, 2));
