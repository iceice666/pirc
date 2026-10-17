import fs from 'node:fs';
import path from 'node:path';

const fixturePath = '../../fixtures/mobile-parity/mermaid-mindmap.json';
const expectedPath = '../../fixtures/mobile-parity/mermaid-mindmap-expected.json';
const summaryPath = process.env.PIRC_MINDMAP_SUMMARY ?? 'build/parity/mermaid-mindmap-native/summary.json';
const outputPath = process.env.PIRC_MINDMAP_REPORT ?? 'build/parity/mermaid-mindmap-native/comparison.json';
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const refSHA = 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c';

const cases = fixture.cases;
const widths = fixture.widths;
const scales = fixture.textScales.map(Number);
const captures = summary.captures ?? [];
const issues = [];
for (const [label, sha] of [['fixture', fixture.webRevision], ['expected', expected.reference], ['native', summary.reference]]) {
  if (sha !== refSHA) issues.push({kind: 'source-revision-mismatch', label, actual: sha, expected: refSHA});
}
const requiredKeys = new Set(widths.flatMap(width => fixture.themes.flatMap(theme => scales.flatMap(scale =>
  cases.map(item => `${item.id}|${width}|${theme}|${scale}`)))));
const seenKeys = new Set();
for (const capture of captures) {
  const key = `${capture.case}|${capture.viewport?.width}|${capture.brightness}|${Number(capture.textScale)}`;
  if (!requiredKeys.has(key)) issues.push({kind: 'unexpected-configuration', key});
  if (seenKeys.has(key)) issues.push({kind: 'duplicate-configuration', key});
  seenKeys.add(key);
}
for (const key of requiredKeys) {
  if (!seenKeys.has(key)) issues.push({kind: 'missing-configuration', key});
}
if (summary.captureComplete !== true) issues.push({kind: 'capture-incomplete'});


function expectedCase(capture) {
  const theme = expected.themes[capture.brightness];
  const width = theme?.widths?.find((row) => row.width === capture.viewport?.width);
  const scale = width?.scales?.find((row) => Number(row.textScale) === Number(capture.textScale));
  return scale?.cases?.find((row) => row.id === capture.case);
}

function abs(value) {
  return Math.abs(Number(value));
}

function updateMax(target, name, value, capture, detail) {
  if (!Number.isFinite(value)) return;
  const prior = target[name];
  if (!prior || value > prior.value) {
    target[name] = {
      value,
      case: capture.case,
      width: capture.viewport?.width,
      brightness: capture.brightness,
      textScale: capture.textScale,
      screenshot: capture.screenshot,
      detail,
    };
  }
}

const maxima = {};
const states = [];
let capturedNodes = 0;
let capturedEdges = 0;
let fillMatches = 0;
let labelColorMatches = 0;
let fillComparisons = 0;
let errorMatches = 0;
let statusMatches = 0;
let shapeMatches = 0;
let shapeComparisons = 0;

for (const capture of captures) {
  const ref = expectedCase(capture);
  if (!ref) {
    issues.push({kind: 'missing-web-case', case: capture.case, width: capture.viewport?.width, brightness: capture.brightness, textScale: capture.textScale});
    continue;
  }
  const source = cases.find((item) => item.id === capture.case);
  const expectedStatus = source?.expectedStatus === 'error' ? 'error' : 'ok';
  const stateStatusMatches = capture.status === expectedStatus && capture.status === ref.status;
  if (!stateStatusMatches) issues.push({kind: 'status-mismatch', case: capture.case, expected: expectedStatus, browser: ref.status, native: capture.status});
  else statusMatches++;
  if (capture.status === 'error') {
    const parsedError = expected.parsedCases[capture.case]?.[capture.brightness]?.errorText;
    const nativeErrorMatches = capture.nativeError === capture.expectedError && capture.nativeError === parsedError;
    if (nativeErrorMatches) errorMatches++;
    else issues.push({kind: 'error-text-mismatch', case: capture.case, expected: parsedError, native: capture.nativeError});
    states.push({case: capture.case, width: capture.viewport.width, brightness: capture.brightness, textScale: capture.textScale, status: capture.status, errorMatches: nativeErrorMatches, screenshot: capture.screenshot});
    continue;
  }
  if (capture.geometryId !== ref.svg?.geometryId) {
    issues.push({kind: 'geometry-id-mismatch', case: capture.case, width: capture.viewport.width, brightness: capture.brightness, textScale: capture.textScale, expected: ref.svg?.geometryId, nativeReference: capture.geometryId});
  }

  const nodes = capture.native?.nodes ?? [];
  const edges = capture.native?.edges ?? [];
  const sourceNodes = expected.parsedCases[capture.case]?.[capture.brightness]?.api?.nodes ?? [];
  const sourceEdges = expected.parsedCases[capture.case]?.[capture.brightness]?.api?.edges ?? [];
  const nodeIDs = new Set(nodes.map(node => node.id));
  if (nodes.length !== sourceNodes.length || nodeIDs.size !== nodes.length ||
      sourceNodes.some(node => !nodeIDs.has(node.domId))) {
    issues.push({kind: 'node-coverage-mismatch', case: capture.case, expected: sourceNodes.length, actual: nodes.length});
  }
  if (edges.length !== sourceEdges.length) issues.push({kind: 'edge-coverage-mismatch', case: capture.case, expected: sourceEdges.length, actual: edges.length});
  capturedNodes += nodes.length;
  capturedEdges += edges.length;
  const nodeResiduals = {
    center: 0,
    bounds: 0,
    labelSize: 0,
      renderedLabelBox: 0,
      fontSize: 0,
      lineHeight: 0,
      nativeStyleLineHeight: 0,
  };
  for (const node of nodes) {
    const center = node.centerDeltaAfterViewBoxNormalization;
    if (center) {
      for (const axis of ['x', 'y']) {
        const delta = abs(center[axis]);
        nodeResiduals.center = Math.max(nodeResiduals.center, delta);
        updateMax(maxima, 'normalizedNodeCenter', delta, capture, {node: node.id, axis, delta});
      }
    }
    for (const [kind, field] of [['bounds', 'localBoundsDelta'], ['labelSize', 'labelSizeDelta'], ['renderedLabelBox', 'renderedLabelBoxDelta']]) {
      const values = node[field];
      if (!values) continue;
      for (const [axis, raw] of Object.entries(values)) {
        const delta = abs(raw);
        nodeResiduals[kind] = Math.max(nodeResiduals[kind], delta);
        updateMax(maxima, kind, delta, capture, {node: node.id, axis, delta});
      }
    }
    for (const [kind, field] of [['fontSize', 'fontSizeDelta'], ['lineHeight', 'lineHeightDelta'], ['nativeStyleLineHeight', 'nativeStyleLineHeightDelta']]) {
      const delta = node[field];
      if (delta === null || delta === undefined) continue;
      nodeResiduals[kind] = Math.max(nodeResiduals[kind], abs(delta));
      updateMax(maxima, kind, abs(delta), capture, {node: node.id, delta});
    }
    const fillMatch = node.fillMatches === true;
    const textMatch = node.labelColorMatches === true;
    fillComparisons++;
    if (fillMatch) fillMatches++;
    if (textMatch) labelColorMatches++;
    if (!fillMatch || !textMatch) issues.push({kind: 'missing-or-mismatched-color', case: capture.case, node: node.id});
    const nativeShape = node.shape;
    const browserShape = node.browserShape;
    const expectedShape = {
      defaultNode: 'defaultMindmapNode',
      rectangle: 'rect',
      roundedRectangle: 'rounded',
      circle: 'mindmapCircle',
      cloud: 'cloud',
      bang: 'bang',
      hexagon: 'hexagon',
    }[nativeShape];
    const shapeMatch = expectedShape === browserShape;
    shapeComparisons++;
    if (shapeMatch) shapeMatches++;
    else issues.push({kind: 'shape-mismatch', case: capture.case, node: node.id, nativeShape, browserShape});
    states.push({
      case: capture.case,
      width: capture.viewport.width,
      brightness: capture.brightness,
      textScale: capture.textScale,
      node: node.label,
      status: capture.status,
      shapeMatch,
      fillMatch,
      labelColorMatch: textMatch,
      residuals: nodeResiduals,
      screenshot: capture.screenshot,
    });
  }

  let edgeMax = 0;
  for (const edge of edges) {
    for (const [axis, raw] of Object.entries(edge.endpointDelta ?? {})) {
      const delta = abs(raw);
      edgeMax = Math.max(edgeMax, delta);
      updateMax(maxima, 'edgeEndpoint', delta, capture, {source: edge.source, target: edge.target, axis, delta});
    }
  }
  const blockDeltas = capture.blockBoxDelta ?? {};
  const figureDeltas = capture.figureBoxDelta ?? {};
  for (const [axis, raw] of Object.entries(blockDeltas)) {
    updateMax(maxima, 'blockBox', abs(raw), capture, {axis, delta: abs(raw)});
  }
  for (const [axis, raw] of Object.entries(figureDeltas)) {
    updateMax(maxima, 'figureBox', abs(raw), capture, {axis, delta: abs(raw)});
  }
  states.push({
    case: capture.case,
    width: capture.viewport.width,
    brightness: capture.brightness,
    textScale: capture.textScale,
    status: capture.status,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    residuals: {...nodeResiduals, edgeEndpoint: edgeMax, blockBox: Math.max(0, ...Object.values(blockDeltas).map(abs)), figureBox: Math.max(0, ...Object.values(figureDeltas).map(abs))},
    screenshot: capture.screenshot,
  });
}

const expectedStates = cases.length * widths.length * 2 * scales.length;
const statusCounts = captures.reduce((counts, row) => {
  counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}, {});
const comparison = {
  fixture: fixture.id,
  webRevision: expected.reference,
  requiredWebRevision: refSHA,
  sourceRevisionMatches: expected.reference === refSHA,
  expectedStates,
  statesCaptured: captures.length,
  statusCounts,
  capturedNodes,
  capturedEdges,
  errorStatesExactMatch: errorMatches,
  statusMatches,
  shapeComparisons,
  shapeMatches,
  fillComparisons,
  fillMatches,
  labelColorComparisons: capturedNodes,
  labelColorMatches,
  visualParityAccepted: false,
  captureComplete: captures.length === expectedStates && summary.captureComplete === true,
  issues,
  largestResiduals: maxima,
  states,
  limitations: [
    'Visual deltas are measurements; this report sets no acceptance threshold.',
    'SFNS and Arial are host comparison fonts loaded from macOS, not bundled mobile fonts.',
    'The browser reports the -apple-system/system-ui/Segoe UI stack; computed family does not identify the resolved physical font file.',
    'Node centers are normalized by each renderer viewBox origin; browser and native figure placements remain separately measured.',
    'lineHeight residual compares Web CSS line-height with actual adjacent native line baselines; single-line labels have no baseline-stride residual. Rounded Flutter LineMetrics.height, ascent/descent, and the native TextStyle height-derived line box are reported independently.',
  ],
};
fs.mkdirSync(path.dirname(outputPath), {recursive: true});
fs.writeFileSync(outputPath, JSON.stringify(comparison, null, 2) + '\n');
console.log(JSON.stringify({
  comparison: outputPath,
  visualParityAccepted: false,
  captureComplete: comparison.captureComplete,
  statesCaptured: comparison.statesCaptured,
  expectedStates: comparison.expectedStates,
  statusCounts,
  errorStatesExactMatch: errorMatches,
  maximumResiduals: Object.fromEntries(Object.entries(maxima).map(([key, value]) => [key, value.value])),
  largestCenter: maxima.normalizedNodeCenter,
  issues: issues.length,
}, null, 2));
if (issues.length > 0 || !comparison.captureComplete || !comparison.sourceRevisionMatches) process.exitCode = 1;
