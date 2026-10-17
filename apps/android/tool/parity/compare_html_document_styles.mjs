// Compare native CSS response measurements with the untouched Chrome 154 capture.
// Run from apps/android after the capture test:
// node tool/parity/compare_html_document_styles.mjs
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const readJson = async path =>
  JSON.parse(await readFile(resolve(root, path), 'utf8'));
const fixture = await readJson('fixtures/mobile-parity/html-document-styles.json');
const web = await readJson(
  'fixtures/mobile-parity/html-document-styles-expected.json',
);
assert.equal(fixture.webRevision, 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c');
assert.equal(web.reference, fixture.webRevision);
assert.equal(web.fixture, fixture.id);

const rectKeys = ['x', 'y', 'width', 'height'];
function compareRect(nativeRect, webRect, sourceNote) {
  if (!nativeRect || !webRect) return null;
  const delta = Object.fromEntries(
    rectKeys.map(key => [key, nativeRect[key] - webRect[key]]),
  );
  return {
    native: nativeRect,
    web: webRect,
    delta,
    maximumAbsoluteDelta: Math.max(
      ...Object.values(delta).map(value => Math.abs(value)),
    ),
    sourceNote,
  };
}

function colorFromArgb(value) {
  if (value === null || value === undefined) return null;
  const argb = Number(value) >>> 0;
  const alpha = (argb >>> 24) & 0xff;
  const red = (argb >>> 16) & 0xff;
  const green = (argb >>> 8) & 0xff;
  const blue = argb & 0xff;
  return alpha === 255
    ? `rgb(${red}, ${green}, ${blue})`
    : `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
}

function cssPixels(value) {
  if (typeof value !== 'string') return null;
  const match = /^(-?(?:\d+\.?\d*|\.\d+))px$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

function primaryFamily(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.split(',')[0].trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}

function compareTextStyle(nativeStyle, webComputed, hostFontAliases = {}) {
  if (!nativeStyle || !webComputed) return null;
  const nativeColor = colorFromArgb(nativeStyle.colorArgb);
  const nativeFontSize = Number.isFinite(nativeStyle.fontSize)
    ? nativeStyle.fontSize
    : null;
  const webFontSize = cssPixels(webComputed['font-size']);
  const nativeFamily = nativeStyle.fontFamily || null;
  const webFamily = webComputed['font-family'] || null;
  const nativePrimary = primaryFamily(nativeFamily);
  const webPrimary = primaryFamily(webFamily);
  const alias = nativePrimary
    ? Object.entries(hostFontAliases).find(
        ([family]) => family.toLowerCase() === nativePrimary,
      )?.[1]
    : null;
  const resolvedHostPrimary = alias?.resolvedFaceFamily ?? nativePrimary;
  return {
    color: {
      native: nativeColor,
      web: webComputed.color ?? null,
      exactMatch: nativeColor !== null && nativeColor === webComputed.color,
    },
    fontFamily: {
      native: nativeFamily,
      web: webFamily,
      primaryFamilyMatch: nativePrimary !== null && nativePrimary === webPrimary,
      comparisonOnlyHostAlias: alias
        ? {
            resolvedNativePrimaryFamily: resolvedHostPrimary,
            webPrimaryFamily: webPrimary,
            resolvedPrimaryFamilyMatch:
              resolvedHostPrimary !== null &&
              resolvedHostPrimary.toLowerCase() === webPrimary,
            files: alias.files ?? [],
          }
        : {
            status: 'no-comparison-only-host-alias-for-native-primary-family',
            nativePrimaryFamily: nativePrimary,
          },
    },
    fontSize: {
      nativePx: nativeFontSize,
      webPx: webFontSize,
      deltaPx:
        nativeFontSize === null || webFontSize === null
          ? null
          : nativeFontSize - webFontSize,
    },
  };
}

function compareControlInsets(nativeInsets, webComputed, note) {
  if (!nativeInsets) {
    return {
      status: 'missing-native-insets',
      reason: 'No native control inset map was captured.',
      sourceNote: note,
    };
  }
  if (!webComputed) {
    return {
      status: 'missing-web-computed-style',
      reason: 'The Chrome oracle has no computed style for this control.',
      nativeInsets,
      sourceNote: note,
    };
  }
  const sides = {};
  let comparedSideCount = 0;
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const padding = cssPixels(webComputed[`padding-${side}`]);
    const border = cssPixels(webComputed[`border-${side}-width`]);
    const nativeInset = nativeInsets[side];
    const missingWebProperties = [];
    if (padding === null) missingWebProperties.push(`padding-${side}`);
    if (border === null) missingWebProperties.push(`border-${side}-width`);
    if (!Number.isFinite(nativeInset)) {
      sides[side] = {
        status: 'missing-native-side-measurement',
        nativeInsetPx: null,
        webPaddingPx: padding,
        webBorderWidthPx: border,
        missingWebProperties,
      };
    } else if (missingWebProperties.length > 0) {
      sides[side] = {
        status: 'missing-web-computed-property',
        nativeInsetPx: nativeInset,
        webPaddingPx: padding,
        webBorderWidthPx: border,
        webBorderPlusPaddingPx: null,
        deltaPx: null,
        missingWebProperties,
      };
    } else {
      const webInset = padding + border;
      sides[side] = {
        status: 'compared',
        nativeInsetPx: nativeInset,
        webPaddingPx: padding,
        webBorderWidthPx: border,
        webBorderPlusPaddingPx: webInset,
        deltaPx: nativeInset - webInset,
        missingWebProperties,
      };
      comparedSideCount++;
    }
  }
  return {
    status: comparedSideCount === 4 ? 'all-sides-compared' : 'partial-web-style-properties',
    nativeInsets,
    webInsetsBySide: sides,
    comparedSideCount,
    missingWebComputedProperties: [
      ...new Set(
        Object.values(sides).flatMap(side => side.missingWebProperties),
      ),
    ],
    sourceNote: note,
  };
}

const configurations = [];
const missingConfigurations = [];
const rectDeltas = [];
const nativeFiles = [];
for (const colorScheme of ['light', 'dark']) {
  for (const width of [390, 768]) {
    const path =
      'apps/android/build/parity/html-document-styles-native-' +
      colorScheme +
      '-' +
      width +
      '.json';
    try {
      await stat(resolve(root, path));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missingConfigurations.push({ width, colorScheme, path });
      continue;
    }
    const native = await readJson(path);
    nativeFiles.push(path);
    assert.equal(native.fixture, fixture.id);
    assert.equal(native.reference, fixture.webRevision);
    assert.equal(native.width, width);
    assert.equal(native.height, 844);
    assert.equal(native.colorScheme, colorScheme);
    const screenshotPath = resolve(root, 'apps/android', native.pngPath);
    const screenshot = await stat(screenshotPath);
    assert(screenshot.size > 0);

    const webCapture = web.captures.find(
      capture => capture.width === width && capture.colorScheme === colorScheme,
    );
    assert(webCapture, `Missing Chrome CSS capture for ${width}/${colorScheme}`);
    const webNodes = webCapture.document.nodes;
    const nativeNodes = native.probeMeasurements;
    const textStyleComparisons = {};
    const textRectComparisons = {};

    for (const [name, webNode] of Object.entries(webNodes)) {
      if (!webNode || !nativeNodes[name]?.measurable) continue;
      const nativeProbe = nativeNodes[name];
      let nativeStyle = null;
      if (name === 'input') nativeStyle = native.controls.input;
      else if (name === 'button') nativeStyle = native.controls.button.labelRichText;
      else {
        const richText = native.richTextProbes[name];
        if (richText?.found && richText.matches?.length) {
          nativeStyle = richText.matches[0];
        }
      }
      const styleComparison = compareTextStyle(
        nativeStyle,
        webNode.computed,
        native.hostFontAliases ?? {},
      );
      if (styleComparison) textStyleComparisons[name] = styleComparison;
      const nativeRect =
        nativeProbe.rect ?? nativeStyle?.rect ?? null;
      const rectComparison = compareRect(
        nativeRect,
        webNode.rect,
        name === 'body'
          ? 'Native HtmlWidget fragment bounds versus the Chrome body DOMRect; these do not identify the same box.'
          : name === 'input' || name === 'button'
            ? 'Native control widget bounds versus the Chrome control DOMRect.'
            : 'Native selected-text bounds from RenderParagraph.getBoxesForSelection versus the Chrome element DOMRect; glyph-range bounds and CSS element boxes have different semantics.',
      );
      if (rectComparison) {
        textRectComparisons[name] = rectComparison;
        rectDeltas.push(rectComparison.maximumAbsoluteDelta);
      }
    }

    const inputWeb = webNodes.input;
    const buttonWeb = webNodes.button;
    const inputNativeInsets =
      native.controls?.input?.contentInsets ?? nativeNodes.input?.contentInsets;
    const buttonNativeInsets =
      native.controls?.button?.labelInsets ?? nativeNodes.button?.labelInsets;
    const inputInsets = compareControlInsets(
      inputNativeInsets,
      inputWeb?.computed,
      'Rendered native editable-text inset compared side by side with the Chrome computed padding plus border width. Missing Chrome properties are reported per side.',
    );
    const buttonInsets = compareControlInsets(
      buttonNativeInsets,
      buttonWeb?.computed,
      'Native button label box inset compared side by side with the Chrome computed padding plus border width. Missing Chrome properties are reported per side; text line-box metrics also affect the native inset.',
    );
    const nativeCanvas = native.viewportCornerPixel;
    const webCanvas = webCapture.canvasPixel;

    const unsupportedDiagnostics = {
      loader: native.styleLoaderDiagnostics ?? [],
      cascade: native.cascadeImportsAndDiagnostics?.diagnostics ?? [],
      sourceBehavior: fixture.notes.customAndUnsupported,
      engineLimits: [
        'CSS engine supports a bounded author cascade; unsupported shorthand expansion, cascade layers, pseudo-elements, animations, unsupported media features, and general CSS-wide keyword computation are not represented as browser-equivalent styles.',
        'A RichText rectangle is not a computed CSS element box; the comparison keeps that distinction in each rectangle source note.',
        'The raw document HTML is parsed for rendering but no script is executed.',
      ],
    };

    configurations.push({
      width,
      height: native.height,
      devicePixelRatio: native.devicePixelRatio,
      colorScheme,
      pngPath: native.pngPath,
      pngBytes: screenshot.size,
      stylesheetOrder: native.loadedStylesheets.map(sheet => ({
        baseUrl: sheet.baseUrl,
        media: sheet.media,
      })),
      probeMeasurements: native.probeMeasurements,
      richTextProbes: native.richTextProbes,
      textStyleComparisons,
      textRectComparisons,
      controlInsets: { input: inputInsets, button: buttonInsets },
      canvas: {
        native: nativeCanvas,
        web: webCanvas,
        exactRgbaMatch:
          nativeCanvas.r === webCanvas.r &&
          nativeCanvas.g === webCanvas.g &&
          nativeCanvas.b === webCanvas.b &&
          nativeCanvas.a === webCanvas.a,
        sourceNote: 'Native bottom-right and Chrome top-left pixels sample a solid viewport background; coordinates differ.',
      },
      styleLoaderDiagnostics: native.styleLoaderDiagnostics,
      cascadeImportsAndDiagnostics: native.cascadeImportsAndDiagnostics,
      unsupportedDiagnostics,
      fontLimits: native.fontLimits,
    });
  }
}

const summary = {
  reference: fixture.webRevision,
  browserVersion: web.browserVersion,
  origin: web.origin,
  responsePath: fixture.responsePath,
  captureComplete: missingConfigurations.length === 0,
  missingConfigurations,
  nativeFiles,
  configurations,
  maximumAbsoluteRectDelta:
    rectDeltas.length > 0 ? Math.max(...rectDeltas) : null,
  visualParityAccepted: false,
  limitations: [
    'This is a measurement report, not a visual acceptance gate; the comparator never changes or copies values into the Chrome fixtures.',
    'Only text color, first family name, font size, measured geometry, and control inner insets have direct native measurements included.',
      'The Chrome fixture records only border-top-width for the input and button; side-specific border-plus-padding comparisons are therefore partial and missing border widths are named per side.',
      'Paragraph and anchor padding is not independently exposed by NativeHtmlDocumentView; CSS computed padding remains in the Chrome oracle only.',
    'The web and native viewport-corner pixels use different coordinates and are only comparable for the captured solid viewport background.',
    'Arial on this macOS host is comparison-only and is not a portable Android font reference.',
    'All captures are 1x; the raw fixture contains Latin text only.',
  ],
};
const outputPath = resolve(
  root,
  'apps/android/build/parity/html-document-styles-comparison.json',
);
await writeFile(outputPath, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
