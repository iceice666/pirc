// Compare actual NativeMarkdown RenderParagraph/Math geometry with the pinned
// Chrome inline-math paragraph oracle. This reports measured deltas; it does
// not treat a close bounding box as pixel parity.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const fixturePath = '../../fixtures/mobile-parity/inline-math-paragraph.json';
const expectedPath = '../../fixtures/mobile-parity/inline-math-paragraph-expected.json';
const clipboardExpectedPath = '../../fixtures/mobile-parity/inline-math-clipboard-expected.json';
const nativePath =
  process.env.PIRC_INLINE_MATH_NATIVE_SUMMARY ??
  '../../fixtures/mobile-parity/inline-math-paragraph-native-summary.json';
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
const clipboardExpected = JSON.parse(await readFile(clipboardExpectedPath, 'utf8'));
const native = JSON.parse(await readFile(nativePath, 'utf8'));
assert.equal(expected.webRevision, fixture.webRevision);
assert.equal(clipboardExpected.webRevision, fixture.webRevision);
assert.equal(native.webRevision, fixture.webRevision);
assert.deepEqual(native.validationErrors, []);
const fixtureById = new Map(fixture.cases.map(item => [item.id, item]));
const expectedByConfig = new Map(expected.configurations.map(item => [item.id, item]));
const clipboardByConfig = new Map(clipboardExpected.configurations.map(item => [item.id, item]));
const nativeByConfig = new Map(native.configurations.map(item => [item.id, item]));
assert.equal(native.selection?.completeMatrix, true, 'native capture is filtered or incomplete');
assert.equal(nativeByConfig.size, expectedByConfig.size, 'configuration coverage differs');
assert.equal(clipboardByConfig.size, expectedByConfig.size, 'actual clipboard oracle configuration coverage differs');

const round = value => Math.round(value * 1000) / 1000;
const rectDelta = (nativeRect, webRect) => {
  if (!nativeRect || !webRect) return null;
  const [x, y, width, height] = nativeRect;
  const [webX, webY, webWidth, webHeight] = webRect;
  return {
    x: round(x - webX),
    y: round(y - webY),
    width: round(width - webWidth),
    height: round(height - webHeight),
  };
};
const groupedCoordinates = (values, tolerance = 0.75) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const groups = [];
  for (const value of sorted) {
    const last = groups.at(-1);
    if (!last || Math.abs(value - last.at(-1)) >= tolerance) groups.push([value]);
    else last.push(value);
  }
  return groups.map(group => round(group.reduce((sum, value) => sum + value, 0) / group.length));
};
const boxIsPainted = box => Array.isArray(box) && box[2] > 0 && box[3] > 0;
const nativeBaselineRows = parts => groupedCoordinates(
  (parts ?? [])
    .filter(part => boxIsPainted(part.mathRenderBox ?? part.placeholderBox))
    .map(part => part.baselineY),
);
const webBaseRows = spans => groupedCoordinates(
  (spans ?? [])
    .map(span => span.rect)
    .filter(boxIsPainted)
    .map(rect => rect[1]),
);
const verticalPadding = style => {
  const values = String(style?.padding ?? '0px')
    .trim()
    .split(/\s+/)
    .map(value => Number.parseFloat(value) || 0);
  if (!values.length) return 0;
  if (values.length === 1) return values[0] * 2;
  if (values.length === 2) return values[0] * 2;
  if (values.length === 3) return values[0] + values[2];
  return values[0] + values[2];
};
const nativeParagraphForCell = (paragraphs, cellRect) => {
  const candidates = (paragraphs ?? []).filter(paragraph => {
    const rect = paragraph.box;
    return paragraph.textWithPlaceholders?.includes('\uFFFC') &&
      rect && rect[0] >= cellRect[0] - 1 && rect[0] < cellRect[0] + cellRect[2] &&
      rect[1] >= cellRect[1] - 1 && rect[1] < cellRect[1] + cellRect[3];
  });
  return candidates.sort((a, b) => a.box[1] - b.box[1])[0] ?? null;
};


const cases = [];
for (const [configId, webConfig] of expectedByConfig) {
  const nativeConfig = nativeByConfig.get(configId);
  const clipboardConfig = clipboardByConfig.get(configId);
  assert.ok(nativeConfig, `missing native config ${configId}`);
  assert.ok(clipboardConfig, `missing actual browser clipboard config ${configId}`);
  const nativeCases = new Map(nativeConfig.cases.map(item => [item.id, item]));
  const clipboardCases = new Map(clipboardConfig.cases.map(item => [item.id, item]));
  for (const webCase of webConfig.cases) {
    const id = webCase.id;
    const sourceCase = fixtureById.get(id);
    const nativeCase = nativeCases.get(id);
    const clipboardCase = clipboardCases.get(id);
    assert.ok(nativeCase, `${configId}/${id} missing native case`);
    assert.ok(clipboardCase, `${configId}/${id} missing actual browser clipboard case`);
    assert.equal(typeof clipboardCase.actualClipboard?.textPlain, 'string', `${configId}/${id} missing Chrome text/plain`);
    assert.equal(nativeCase.actualMathCount, sourceCase.expectedMathCount, `${configId}/${id} formula count`);
    const formulaMetrics = nativeCase.formulas.map((formula, index) => {
      const webMath = webCase.mathNodes[index];
      const nativeRows = nativeBaselineRows(formula.parts);
      const browserRows = webBaseRows(webMath?.baseSpans);
      const browserBaselineY = webMath?.baseline?.markerRect?.[1] ?? null;
      const nativeBaselineY = nativeRows.at(-1) ?? null;
      const lastWebBase = (webMath?.baseSpans ?? [])
        .filter(span => boxIsPainted(span.rect))
        .sort((a, b) => a.rect[1] - b.rect[1])
        .at(-1);
      const markerSharesLastBaseLine = lastWebBase != null &&
        Number.isFinite(browserBaselineY) &&
        browserBaselineY >= lastWebBase.rect[1] - 0.75 &&
        browserBaselineY <= lastWebBase.rect[1] + lastWebBase.rect[3] + 0.75;
      return {
        expression: formula.expression,
        nativeKind: formula.kind,
        webKind: webMath?.kind ?? null,
        parseError: formula.parseError,
        paintedPartCount: formula.paintedPartCount,
        nativePaintedBaselineRows: nativeRows,
        webKaTeXBaseTopRows: browserRows,
        paintedRowCountDelta: nativeRows.length > 0 && browserRows.length > 0
          ? nativeRows.length - browserRows.length
          : null,
        webBaselineMarkerY: Number.isFinite(browserBaselineY) ? round(browserBaselineY) : null,
        webBaselineMarkerSharesLastBaseLine: markerSharesLastBaseLine,
        inlineFinalBaselineDelta: !formula.display && markerSharesLastBaseLine &&
            Number.isFinite(nativeBaselineY) && Number.isFinite(browserBaselineY)
          ? round(nativeBaselineY - browserBaselineY)
          : null,
        // These boxes intentionally remain available for inspection, but the
        // painted-child union and Chrome's outer .katex rect include different
        // strut/line-box geometry and must not be summarized as a pixel delta.
        paintedPartUnionVsKaTeXElementRect: rectDelta(
          formula.paintedPartUnion,
          webMath?.rect ?? null,
        ),
        displayBlockVsKaTeXDisplayWrapper: formula.display
          ? rectDelta(formula.displayBlockRect, webMath?.displayWrapper?.rect ?? null)
          : null,
      };
    });
    const webTableCells = (webCase.textBlocks ?? []).filter(
      block => block.tag?.tag === 'td',
    );
    const nativeBodyCells = (nativeCase.tableCells ?? [])
      .filter(cell => cell.row > 0)
      .sort((a, b) => a.row - b.row || a.column - b.column);
    assert.equal(nativeBodyCells.length, webTableCells.length,
      `${configId}/${id} actual table-cell coverage differs`);
    const tableCellParagraphs = webTableCells.map((cell, index) => {
      const nativeParagraph = nativeParagraphForCell(nativeCase.paragraphs, cell.rect);
      const browserPaddingY = verticalPadding(cell.style);
      const browserContentHeight = cell.rect[3] - browserPaddingY;
      return {
        browserTag: cell.tag.tag,
        nativeCellBorderBox: nativeBodyCells[index]?.borderBox ?? null,
        nativeCellVsBrowserCellBoundsDelta: rectDelta(
          nativeBodyCells[index]?.borderBox, cell.rect),
        nativeParagraphBox: nativeParagraph?.box ?? null,
        browserCellBorderBox: cell.rect,
        browserCellPaddingY: round(browserPaddingY),
        browserCellContentHeight: round(browserContentHeight),
        // Native paragraphs are measured inside the cell's content area;
        // comparing them with the full browser cell border box is invalid.
        nativeParagraphVsBrowserCellContentHeightDelta: nativeParagraph
          ? round(nativeParagraph.box[3] - browserContentHeight)
          : null,
      };
    });
    const webParagraph = webTableCells.length === 0
      ? webCase.textBlocks?.[0]?.rect ?? null
      : null;
    const nativeParagraph = webTableCells.length === 0
      ? nativeCase.paragraphs?.find(
          paragraph => paragraph.textWithPlaceholders?.includes('\uFFFC'),
        )?.box ?? null
      : null;
    cases.push({
      configId,
      id,
      viewport: webConfig.viewport,
      theme: webConfig.theme,
      textScale: webConfig.textScale,
      expectedMathCount: sourceCase.expectedMathCount,
      nativeFormulaExpressions: nativeCase.formulas.map(formula => formula.expression),
      nativeKinds: nativeCase.actualKinds,
      expectedKinds: sourceCase.expectedKinds,
      formulas: formulaMetrics,
      paragraphBoundsDelta: rectDelta(nativeParagraph, webParagraph),
      tableCellParagraphs,
      nativeClipboard: nativeCase.nativeSelectAllClipboard,
      webSourceSelectionText: webCase.copySelectionText,
      actualWebClipboardText: clipboardCase.actualClipboard.textPlain,
      sourceSelectionMatchesNativeClipboard:
        nativeCase.nativeSelectAllClipboard === webCase.copySelectionText,
      actualClipboardMatchesNativeClipboard:
        nativeCase.nativeSelectAllClipboard === clipboardCase.actualClipboard.textPlain,
    });
  }
}

const comparableBaselineDeltas = cases.flatMap(item =>
  item.formulas.map(formula => formula.inlineFinalBaselineDelta).filter(Number.isFinite),
);
const comparableParagraphHeightDeltas = cases.flatMap(item => [
  item.paragraphBoundsDelta?.height,
  ...item.tableCellParagraphs.map(cell => cell.nativeParagraphVsBrowserCellContentHeightDelta),
].filter(Number.isFinite));
const summary = {
  fixture: fixturePath,
  webExpected: expectedPath,
  nativeSummary: nativePath,
  matrix: {
    configurationCount: nativeByConfig.size,
    caseCount: cases.length,
    allFormulaCountsMatch: cases.every(item => item.expectedMathCount === item.nativeFormulaExpressions.length),
    allKindsMatch: cases.every(item => JSON.stringify(item.nativeKinds) === JSON.stringify(item.expectedKinds)),
  },
  measuredComparableQuantities: {
    inlineFinalBaselineComparisons: comparableBaselineDeltas.length,
    maxAbsInlineFinalBaselineDelta: round(Math.max(0, ...comparableBaselineDeltas.map(Math.abs))),
    paragraphContentHeightComparisons: comparableParagraphHeightDeltas.length,
    maxAbsParagraphContentHeightDelta: round(Math.max(0, ...comparableParagraphHeightDeltas.map(Math.abs))),
    note: 'These compare inline baselines and paragraph/content heights. Painted-child unions versus KaTeX element boxes and table-cell border boxes are reported separately because they are different quantities.',
  },
  copy: {
    sourceSelectionComparison: {
      comparedCases: cases.length,
      exactMatches: cases.filter(item => item.sourceSelectionMatchesNativeClipboard).length,
      differenceCount: cases.filter(item => !item.sourceSelectionMatchesNativeClipboard).length,
      label: 'Legacy webCopySelectionText comes from DOM Selection.toString(); it is not Chrome clipboard data.',
    },
    actualClipboardComparison: {
      comparedCases: cases.length,
      exactMatches: cases.filter(item => item.actualClipboardMatchesNativeClipboard).length,
      differenceCount: cases.filter(item => !item.actualClipboardMatchesNativeClipboard).length,
      source: 'fixtures/mobile-parity/inline-math-clipboard-expected.json actual text/plain read after Chrome Meta+A/Meta+C.',
      sampleDifferences: cases
        .filter(item => !item.actualClipboardMatchesNativeClipboard)
        .slice(0, 8)
        .map(({ configId, id, nativeClipboard, actualWebClipboardText }) => ({
          configId, id, nativeClipboard, actualWebClipboardText,
        })),
    },
  },
  cases,
};
const outputPath = process.env.PIRC_INLINE_MATH_COMPARE_OUTPUT;
if (outputPath) await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ...summary, cases: undefined }, null, 2));

assert.equal(summary.matrix.allKindsMatch, true, 'formula/error presentation differs');
