#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const webPath = path.resolve(repoRoot, 'fixtures/mobile-parity/tex-equation-tags-expected.json');
const nativePath = path.resolve(repoRoot, 'fixtures/mobile-parity/tex-equation-tags-native-summary.json');
const outputPath = path.resolve(repoRoot, 'apps/android/build/parity/tex-equation-tags-native/comparison.json');

const web = JSON.parse(await readFile(webPath, 'utf8'));
const native = JSON.parse(await readFile(nativePath, 'utf8'));
const fixture = JSON.parse(await readFile(path.resolve(repoRoot, 'fixtures/mobile-parity/tex-equation-tags.json'), 'utf8'));
assert.equal(web.webRevision, fixture.webRevision);
assert.equal(native.webRevision, fixture.webRevision);
assert.deepEqual(native.measurementErrors, []);
const expectedConfigs = fixture.capture.widths.length * fixture.capture.themes.length * fixture.capture.textScales.length;
assert.equal(web.configurations.length, expectedConfigs);
assert.equal(native.configurations.length, expectedConfigs);
const differences = [];
const geometry = [];
const coverage = { configurations: 0, cases: 0, stages: 0, formulas: 0 };

const asArray = (value) => Array.isArray(value) ? value : [];
const byId = (rows, id) => asArray(rows).find((row) => row?.id === id);
const byStage = (rows, id) => asArray(rows).find((row) => row?.stageId === id);
const configId = (row) => {
  const width = row?.viewport?.width;
  const scale = row?.textScale;
  if (typeof width !== 'number' || typeof scale !== 'number' || !row?.theme) return null;
  return `${width}-${row.theme}-${Number.isInteger(scale) ? scale : scale}`;
};
const cleanText = (value) => String(value ?? '').replaceAll('\u200b', '').trim();
const rectDelta = (actual, expected) => {
  if (!actual || !expected) return null;
  const fields = ['left', 'top', 'width', 'height'];
  const delta = {};
  for (const field of fields) {
    const actualValue = actual[field] ?? (field === 'left' ? actual.x : field === 'top' ? actual.y : undefined);
    const expectedValue = expected[field] ?? (field === 'left' ? expected.x : field === 'top' ? expected.y : undefined);
    if (typeof actualValue === 'number' && typeof expectedValue === 'number') {
      delta[field] = Number((actualValue - expectedValue).toFixed(3));
    }
  }
  return delta;
};
const errorPhrase = (title) => {
  const source = String(title ?? '');
  const marker = 'KaTeX parse error:';
  const index = source.indexOf(marker);
  return cleanText(index < 0 ? source : source.slice(index + marker.length));
};
const sortedY = (rows) => [...rows].sort((a, b) => (a?.rect?.top ?? a?.box?.top ?? 0) - (b?.rect?.top ?? b?.box?.top ?? 0));
const unionRect = (rows) => {
  const rects = rows.map((row) => row?.box).filter((box) => box && typeof box.left === 'number');
  if (!rects.length) return null;
  const left = Math.min(...rects.map((box) => box.left));
  const top = Math.min(...rects.map((box) => box.top));
  const right = Math.max(...rects.map((box) => box.right ?? box.left + box.width));
  const bottom = Math.max(...rects.map((box) => box.bottom ?? box.top + box.height));
  return { left, top, width: right - left, height: bottom - top, right, bottom };
};
const colorToHex = (value) => {
  if (!value) return null;
  const source = String(value).trim();
  if (/^#[0-9a-f]{8}$/i.test(source)) return source.toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(source)) return `#ff${source.slice(1).toLowerCase()}`;
  const match = source.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!match) return source;
  return `#ff${match.slice(1, 4).map((value) => Number(value).toString(16).padStart(2, '0')).join('')}`;
};

function addDifference(kind, detail) {
  differences.push({ kind, ...detail });
}

for (const webConfig of asArray(web.configurations)) {
  const id = configId(webConfig);
  const nativeConfig = byId(native.configurations, id);
  if (!nativeConfig) {
    addDifference('missing-configuration', { configuration: id });
    continue;
  }
  coverage.configurations++;

  for (const webCase of asArray(webConfig.cases)) {
    const nativeCase = byId(nativeConfig.cases, webCase.id);
    if (!nativeCase) {
      addDifference('missing-case', { configuration: id, caseId: webCase.id });
      continue;
    }
    coverage.cases++;

    for (const webStage of asArray(webCase.stages)) {
      const nativeStage = byStage(nativeCase.stages, webStage.stageId);
      if (!nativeStage) {
        addDifference('missing-stage', { configuration: id, caseId: webCase.id, stageId: webStage.stageId });
        continue;
      }
      coverage.stages++;
      const webFormulas = asArray(webStage.formulas);
      const nativeFormulas = asArray(nativeStage.formulas);
      if (webFormulas.length !== nativeFormulas.length) {
        addDifference('formula-count', {
          configuration: id,
          caseId: webCase.id,
          stageId: webStage.stageId,
          web: webFormulas.length,
          native: nativeFormulas.length,
        });
      }

      for (let index = 0; index < Math.min(webFormulas.length, nativeFormulas.length); index++) {
        const webFormula = webFormulas[index];
        const nativeFormula = nativeFormulas[index];
        coverage.formulas++;
        const identity = { configuration: id, caseId: webCase.id, stageId: webStage.stageId, formulaIndex: index };

        const webIsError = webFormula.kind === 'whole-expression-parse-error';
        const nativeIsError = nativeFormula.kind === 'whole-expression-parse-error';
        if (webIsError !== nativeIsError) {
          addDifference('parse-kind', { ...identity, web: webFormula.kind, native: nativeFormula.kind, nativeError: nativeFormula.parseError });
        }
        if (webFormula.annotation != null && webFormula.annotation !== nativeFormula.expression) {
          addDifference('annotation', { ...identity, web: webFormula.annotation, native: nativeFormula.expression });
        }
        if (webIsError && nativeIsError) {
          const expectedPhrase = errorPhrase(webFormula.title);
          const actualMessage = cleanText(nativeFormula.parseError?.message);
          if (expectedPhrase && !actualMessage.includes(expectedPhrase)) {
            addDifference('parse-error-message', { ...identity, web: expectedPhrase, native: actualMessage });
          }
        }

        const webManualTags = asArray(webFormula.tags)
          .map((tag) => cleanText(tag.textContent))
          .filter(Boolean);
        const nativeTags = asArray(nativeFormula.tags);
        const nativeManualTexts = nativeTags
          .filter((tag) => tag.automatic === false)
          .map((tag) => cleanText(tag.astSymbolText))
          .filter(Boolean);
        const webAutomaticTags = sortedY(asArray(webStage.counterNodes).filter((node) =>
          node.kind === 'html-equation-number' && node.formulaIndex === index,
        )).map((node) => cleanText(node.generatedText)).filter(Boolean);
        const nativeAutomaticTags = nativeTags
          .filter((tag) => tag.automatic === true)
          .map((tag) => cleanText(tag.astSymbolText))
          .filter(Boolean);
        if (JSON.stringify(webManualTags) !== JSON.stringify(nativeManualTexts)) {
          addDifference('manual-tag-text', { ...identity, web: webManualTags, native: nativeManualTexts });
        }
        if (JSON.stringify(webAutomaticTags) !== JSON.stringify(nativeAutomaticTags)) {
          addDifference('automatic-tag-text', { ...identity, web: webAutomaticTags, native: nativeAutomaticTags });
        }

        const layout = nativeFormula.layout ?? {};
        for (const [name, nativeRect, webRect] of [
          ['display-block', layout.displayBlockBox, webFormula.mathBlockRect],
          ['tagged-math', layout.taggedMathBox, webFormula.rect],
        ]) {
          const delta = rectDelta(nativeRect, webRect);
          if (delta) geometry.push({ ...identity, measurement: name, delta, native: nativeRect, web: webRect });
        }

        const browserManualTags = asArray(webFormula.tags)
          .map((tag) => ({ text: cleanText(tag.textContent), rect: tag.rect, style: tag.style }))
          .filter((tag) => tag.text);
        const webAnchors = asArray(webFormula.tagRows).flatMap((row) => asArray(row.anchors));
        const nativeManualTags = nativeTags.filter((tag) => tag.automatic === false);
        for (let tagIndex = 0; tagIndex < nativeManualTags.length; tagIndex++) {
          const nativeTag = nativeManualTags[tagIndex];
          const text = cleanText(nativeTag.astSymbolText);
          const anchor = webAnchors.find((row) => cleanText(row.text) === text && row.textRect);
          const webTag = browserManualTags.find((row) => row.text === text) ?? browserManualTags[tagIndex];
          const nativePaint = unionRect(asArray(nativeTag.richTextRuns));
          const webPaint = anchor?.textRect ?? webTag?.rect;
          if (nativePaint && webPaint) {
            const multilineGroup = !anchor && webPaint.height > (Number.parseFloat(webTag?.style?.fontSize ?? '0') * 1.5);
            if (multilineGroup) {
              const centerDelta = Number(((nativePaint.top + nativePaint.height / 2) - (webPaint.top + webPaint.height / 2)).toFixed(3));
              const widthDelta = Number((nativePaint.width - webPaint.width).toFixed(3));
              geometry.push({
                ...identity,
                measurement: `manual-tag-${tagIndex}-paint-center`,
                comparisonNote: 'Web tag rect spans multiple table rows; compare the Native painted text center and width, not the full group height.',
                delta: { centerY: centerDelta, width: widthDelta },
                native: nativePaint,
                web: webPaint,
              });
            } else {
              const delta = rectDelta(nativePaint, webPaint);
              if (delta) geometry.push({ ...identity, measurement: `manual-tag-${tagIndex}-paint`, delta, native: nativePaint, web: webPaint });
            }
          }
          const nativeColor = colorToHex(nativeTag.richTextRuns?.[0]?.color ?? nativeTag.optionsColor);
          const webColor = colorToHex(anchor?.style?.color ?? webTag?.style?.color);
          if (nativeColor && webColor && nativeColor !== webColor) {
            addDifference('manual-tag-color', { ...identity, tagIndex, web: webColor, native: nativeColor });
          }
          const webFontSize = Number.parseFloat(anchor?.style?.fontSize ?? webTag?.style?.fontSize ?? 'NaN');
          const nativeFontSize = nativeTag.richTextRuns?.[0]?.fontSize;
          if (Number.isFinite(webFontSize) && typeof nativeFontSize === 'number' && Math.abs(webFontSize - nativeFontSize) > 0.02) {
            addDifference('manual-tag-font-size', { ...identity, tagIndex, web: webFontSize, native: nativeFontSize });
          }
        }

        const webAutoNodes = sortedY(asArray(webStage.counterNodes).filter((node) =>
          node.kind === 'html-equation-number' && node.formulaIndex === index,
        ));
        const nativeAutoTags = nativeTags.filter((tag) => tag.automatic === true);
        for (let tagIndex = 0; tagIndex < Math.min(webAutoNodes.length, nativeAutoTags.length); tagIndex++) {
          const nativeTag = nativeAutoTags[tagIndex];
          const nativePaint = unionRect(asArray(nativeTag.richTextRuns));
          const webPaint = webAutoNodes[tagIndex].rect;
          const delta = rectDelta(nativePaint, webPaint);
          if (delta) geometry.push({ ...identity, measurement: `automatic-tag-${tagIndex}-paint`, delta, native: nativePaint, web: webPaint });
          const nativeColor = colorToHex(nativeTag.richTextRuns?.[0]?.color ?? nativeTag.optionsColor);
          const webColor = colorToHex(webAutoNodes[tagIndex].style?.color);
          if (nativeColor && webColor && nativeColor !== webColor) {
            addDifference('automatic-tag-color', { ...identity, tagIndex, web: webColor, native: nativeColor });
          }
          const webFontSize = Number.parseFloat(webAutoNodes[tagIndex].style?.fontSize ?? 'NaN');
          const nativeFontSize = nativeTag.richTextRuns?.[0]?.fontSize;
          if (Number.isFinite(webFontSize) && typeof nativeFontSize === 'number' && Math.abs(webFontSize - nativeFontSize) > 0.02) {
            addDifference('automatic-tag-font-size', { ...identity, tagIndex, web: webFontSize, native: nativeFontSize });
          }
        }

        const bodyPaint = nativeFormula.bodyMathRichTextUnion;
        const webBasePaint = webFormula.baseGeometry?.baseUnionRect;
        const bodyPaintDelta = rectDelta(bodyPaint, webBasePaint);
        if (bodyPaintDelta) geometry.push({ ...identity, measurement: 'body-painted-rich-text-union', delta: bodyPaintDelta, native: bodyPaint, web: webBasePaint, comparisonNote: 'RichText glyph union; stretchy/custom-painted TeX shapes are not included.' });

        if (nativeFormula.kind === 'rendered' && (!layout.bodyMathBox || !layout.displayBlockBox && webFormula.display)) {
          addDifference('missing-render-box', { ...identity, layout });
        }
      }
    }
  }
}

const maxAbsGeometryDelta = {};
for (const row of geometry) {
  for (const [field, delta] of Object.entries(row.delta)) {
    maxAbsGeometryDelta[field] = Math.max(maxAbsGeometryDelta[field] ?? 0, Math.abs(delta));
  }
}
const result = {
  schemaVersion: 1,
  webExpected: path.relative(repoRoot, webPath),
  nativeSummary: path.relative(repoRoot, nativePath),
  webRevision: web.webRevision,
  nativeWebRevision: native.webRevision,
  visualParityAccepted: false,
  coverage,
  counts: {
    differences: differences.length,
    geometryMeasurements: geometry.length,
    semanticDifferences: differences.length,
    maxAbsGeometryDelta,
  },
  differences,
  geometry,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ output: path.relative(repoRoot, outputPath), coverage, counts: result.counts }, null, 2));

if (differences.length) process.exitCode = 1;
