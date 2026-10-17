import fs from 'node:fs';
import path from 'node:path';

const fixturePath = '../../fixtures/mobile-parity/html-control-styles.json';
const webPath = '../../fixtures/mobile-parity/html-control-styles-expected.json';
const outputPath = 'build/parity/html-control-styles-native-comparison.json';
const nativeDir = process.argv[2] ?? 'build/parity';
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const web = JSON.parse(fs.readFileSync(webPath, 'utf8'));

if (
  fixture.webRevision !== 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c' ||
  web.reference !== fixture.webRevision ||
  web.fixture !== fixture.id
) {
  throw new Error('Raw HTML control comparison is not pinned to its Chrome fixture.');
}

const controlNames = Object.keys(fixture.snapshotControls);

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function cssPx(value) {
  if (typeof value !== 'string' || !value.endsWith('px')) return null;
  return numeric(value.slice(0, -2));
}

function colorChannels(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)(?:\s*[,/]\s*([0-9.]+))?\s*\)$/i);
  if (!match) return null;
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function pairNumber(nativeValue, browserValue, source) {
  if (!Number.isFinite(nativeValue)) {
    return { available: false, reason: 'Native measurement is absent.', source };
  }
  if (!Number.isFinite(browserValue)) {
    return { available: false, reason: 'Browser reference value is not a pixel number.', source };
  }
  return {
    available: true,
    native: nativeValue,
    browser: browserValue,
    delta: nativeValue - browserValue,
    source,
  };
}

function pairColor(nativeValue, browserValue, source) {
  const native = colorChannels(nativeValue);
  const browser = colorChannels(browserValue);
  if (!native) return { available: false, reason: 'Native color measurement is absent or unparseable.', source };
  if (!browser) return { available: false, reason: 'Browser color reference is absent or unparseable.', source };
  return {
    available: true,
    native,
    browser,
    delta: {
      r: native.r - browser.r,
      g: native.g - browser.g,
      b: native.b - browser.b,
      a: native.a - browser.a,
    },
    source,
  };
}

function parseArgb(argb) {
  if (!Number.isFinite(argb)) return null;
  const value = Number(argb) >>> 0;
  return {
    r: (value >>> 16) & 0xff,
    g: (value >>> 8) & 0xff,
    b: value & 0xff,
    a: ((value >>> 24) & 0xff) / 255,
  };
}

function colorCssFromArgb(argb) {
  const color = parseArgb(argb);
  if (!color) return null;
  return 'rgba(' + color.r + ', ' + color.g + ', ' + color.b + ', ' + color.a + ')';
}

function compareRect(nativeRect, browserRect) {
  if (!nativeRect || !browserRect) {
    return { available: false, reason: 'Native widget bounds or browser DOMRect is absent.' };
  }
  const delta = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    delta[key] = numeric(nativeRect[key]) - numeric(browserRect[key]);
  }
  return { available: true, native: nativeRect, browser: browserRect, delta };
}

function compareInsets(native, browser, note) {
  if (!native || !browser) {
    return {
      available: false,
      reason: 'One side does not expose a complete four-edge measurement.',
      semantics: note,
    };
  }
  const delta = {};
  for (const key of ['top', 'right', 'bottom', 'left']) {
    delta[key] = numeric(native[key]) - numeric(browser[key]);
  }
  return {
    available: true,
    native,
    browser,
    delta,
    semantics: note,
    acceptedAsEquivalent: false,
  };
}

function compareControl(native, browser) {
  if (!native) {
    return {
      available: false,
      reason: 'Native capture has no entry for this fixture control.',
      browser: { id: browser?.id, rect: browser?.rect, computed: browser?.computed },
    };
  }

  const computed = browser?.computed ?? {};
  const rendered = native.renderedStyle ?? {};
  const paint = native.paint ?? null;
  const nativeGeometry = native.geometry ?? {};
  const nativeBorder = paint?.border ?? null;
  const borderPainter = paint?.borderPainter ?? null;
  const browserPadding = {
    top: cssPx(computed['padding-top']),
    right: cssPx(computed['padding-right']),
    bottom: cssPx(computed['padding-bottom']),
    left: cssPx(computed['padding-left']),
  };
  const browserContentInsets = {
    top: cssPx(computed['border-top-width']) + browserPadding.top,
    right: cssPx(computed['border-right-width']) + browserPadding.right,
    bottom: cssPx(computed['border-bottom-width']) + browserPadding.bottom,
    left: cssPx(computed['border-left-width']) + browserPadding.left,
  };
  const actualContainerPadding = paint?.containerPadding ?? null;
  const sideNames = ['top', 'right', 'bottom', 'left'];
  const padding = {};
  const borders = {};
  for (const side of sideNames) {
    padding[side] = pairNumber(
      actualContainerPadding?.[side],
      browserPadding[side],
      'Actual Container.padding vs Chrome computed CSS padding side; native value may include implementation-level padding.',
    );
    const browserWidth = cssPx(computed['border-' + side + '-width']);
    const browserColor = computed['border-' + side + '-color'];
    const browserStyle = computed['border-' + side + '-style'];
    const nativeSide = nativeBorder?.[side] ?? null;
    const requestedStyle = nativeSide?.cssStyleName ?? nativeSide?.style ?? null;
    const paintedPattern = nativeSide?.paintedPattern ?? nativeSide?.style ?? null;
    const browserPattern = browserStyle === 'none' || browserStyle === 'hidden'
      ? 'none'
      : browserStyle;
    borders[side] = {
      width: pairNumber(
        nativeSide?.width,
        browserWidth,
        'Actual BoxDecoration BorderSide width vs Chrome computed border width.',
      ),
      color: pairColor(
        nativeSide?.colorCss,
        browserColor,
        'Actual BoxDecoration BorderSide color vs Chrome computed border color.',
      ),
      style: {
        available: requestedStyle != null && browserStyle != null,
        native: requestedStyle,
        nativePaintedPattern: paintedPattern,
        nativeConfiguredBorderSideStyle: nativeSide?.style ?? null,
        browser: browserStyle ?? null,
        equal: paintedPattern === browserPattern,
        requestedStyleMatches: requestedStyle === browserStyle,
        styleFallbackApplied: nativeSide?.styleFallbackApplied ?? false,
        unsupportedCssStyleFallback: nativeSide?.unsupportedCssStyleFallback ?? false,
        reason: nativeSide == null
          ? 'Native border painter side is unavailable.'
          : null,
      },
    };
  }

  const nativeFamily = rendered.fontFamily ?? null;
  const expectedFamily = computed['font-family'] ?? null;
  const expectedPrimaryFamily = typeof expectedFamily === 'string'
    ? expectedFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '').toLowerCase()
    : null;
  const nativePrimaryFamily = typeof nativeFamily === 'string'
    ? nativeFamily.trim().replace(/^['"]|['"]$/g, '').toLowerCase()
    : null;
  const nativeLineHeight = Number.isFinite(rendered.lineHeightFactor) &&
      Number.isFinite(rendered.fontSize)
    ? rendered.lineHeightFactor * rendered.fontSize
    : null;
  const browserLineHeight = cssPx(computed['line-height']);
  const nativeInsets = nativeGeometry.editableRenderBoxInsets ?? null;
  const borderRadius = {};
  for (const [corner, cssKey] of [
    ['topLeft', 'border-top-left-radius'],
    ['topRight', 'border-top-right-radius'],
    ['bottomRight', 'border-bottom-right-radius'],
    ['bottomLeft', 'border-bottom-left-radius'],
  ]) {
    borderRadius[corner] = {
      x: pairNumber(
        paint?.borderRadius?.[corner]?.x,
        cssPx(computed[cssKey]?.split(' ')[0]),
      'Actual NativeHtmlControlBorderPainter radius vs Chrome computed corner radius; only the first CSS radius component is compared.',
      ),
      y: pairNumber(
        paint?.borderRadius?.[corner]?.y,
        cssPx(computed[cssKey]?.split(' ').at(-1)),
      'Actual NativeHtmlControlBorderPainter radius vs Chrome computed corner radius; only the final CSS radius component is compared.',
      ),
    };
  }
  const styleMetrics = {
    fontFamily: {
      available: nativeFamily != null && expectedFamily != null,
      native: nativeFamily,
      nativeFallback: rendered.fontFamilyFallback ?? [],
      browser: expectedFamily,
      browserPrimaryFamily: expectedPrimaryFamily,
      nativePrimaryFamily,
      primaryFamilyMatches: nativePrimaryFamily != null &&
        nativePrimaryFamily === expectedPrimaryFamily,
      reason: nativeFamily == null ? 'Rendered widget font family is missing.' : null,
    },
    fontSize: pairNumber(
      rendered.fontSize,
      cssPx(computed['font-size']),
      'Actual control widget TextStyle.fontSize vs Chrome computed font-size.',
    ),
    fontWeight: pairNumber(
      rendered.fontWeight,
      numeric(computed['font-weight']),
      'Actual control widget TextStyle.fontWeight vs Chrome computed font-weight.',
    ),
    lineHeight: pairNumber(
      nativeLineHeight,
      browserLineHeight,
      'Native TextStyle.height × font size vs Chrome CSS line-height; this is a style metric, not baseline geometry.',
    ),
    textColor: pairColor(
      rendered.colorCss,
      computed.color,
      'Actual control widget TextStyle color vs Chrome computed text color.',
    ),
    backgroundColor: pairColor(
      paint?.backgroundColorCss,
      computed['background-color'],
      'Actual BoxDecoration background color vs Chrome computed background-color.',
    ),
    padding,
    borders,
    borderRadius,
  };
  const inputInsets = nativeInsets
    ? compareInsets(
        nativeInsets,
        browserContentInsets,
        'Native EditableText render-box edge inset compared diagnostically with browser border-width + padding. These are not the same semantic box and are never accepted as equivalent.',
      )
    : {
        available: false,
        reason: nativeGeometry.editableTextBox == null
          ? 'This native select has no EditableText box.'
          : 'Native editable render-box inset is absent.',
        browserContentInsets,
        acceptedAsEquivalent: false,
      };

  return {
    available: true,
    selector: native.selector,
    name: native.name,
    type: native.type,
    state: native.state,
    geometry: {
      controlBorderBox: compareRect(nativeGeometry.controlBorderBox, browser?.rect),
      paintedBorderBox: compareRect(
        borderPainter?.renderCustomPaintRect,
        browser?.rect,
      ),
      editableTextBox: nativeGeometry.editableTextBox
        ? { available: true, rect: nativeGeometry.editableTextBox }
        : { available: false, reason: 'Select controls expose no EditableText render box.' },
      inputRenderedInsets: inputInsets,
      semantics: nativeGeometry.geometrySemantics,
    },
    styleMetrics,
    paintMeasurement: native.paintMeasurement ?? {
      available: false,
      reason: 'Native capture omitted paint measurement diagnostics.',
    },
    browserReference: {
      computedStyle: computed,
      rect: browser?.rect ?? null,
    },
  };
}

function summarizeInteractions(native, browserCapture) {
  if (!native) return { available: false, reason: 'Native matrix capture is missing.' };
  const expected = browserCapture?.interactions ?? {};
  const nativeInteractions = native.interactions ?? {};
  const controlStates = {};
  for (const phase of ['afterEdits', 'afterReset', 'beforeSubmit']) {
    const nativePhase = nativeInteractions[phase]?.controls ?? nativeInteractions[phase] ?? {};
    const browserPhase = expected[phase]?.controls ?? {};
    controlStates[phase] = {};
    for (const name of controlNames) {
      const actual = nativePhase[name]?.state ?? nativePhase[name] ?? null;
      const reference = browserPhase[name] ?? null;
      if (!actual || !reference) {
        controlStates[phase][name] = {
          available: false,
          reason: 'Native or browser interaction snapshot is missing.',
          native: actual,
          browser: reference,
        };
        continue;
      }
      const actualSelection = actual.selection;
      const expectedSelection = reference.selection;
      let selection = {
        available: false,
        reason: 'The control does not expose comparable text selection state.',
        native: actualSelection,
        browser: expectedSelection,
      };
      if (actualSelection?.supported && expectedSelection?.supported &&
          typeof expectedSelection.start === 'number' &&
          typeof expectedSelection.end === 'number') {
        const start = Math.min(actualSelection.baseOffset, actualSelection.extentOffset);
        const end = Math.max(actualSelection.baseOffset, actualSelection.extentOffset);
        const direction = actualSelection.baseOffset > actualSelection.extentOffset
          ? 'backward'
          : actualSelection.baseOffset < actualSelection.extentOffset
            ? 'forward'
            : 'none';
        selection = {
          available: true,
          native: { start, end, direction },
          browser: expectedSelection,
          equal: start === expectedSelection.start &&
            end === expectedSelection.end &&
            direction === expectedSelection.direction,
          note: 'Flutter controller selection state vs live Chrome selection state.',
        };
      }
      controlStates[phase][name] = {
        available: true,
        value: {
          native: actual.value,
          browser: reference.value,
          equal: actual.value === reference.value,
        },
        selectedValues: {
          native: actual.selectedValues ?? null,
          browser: reference.selectedValues ?? null,
          equal: JSON.stringify(actual.selectedValues ?? null) ===
            JSON.stringify(reference.selectedValues ?? null),
        },
        selection,
        disabled: {
          native: actual.disabled,
          browser: reference.disabled,
          equal: actual.disabled === reference.disabled,
        },
        readOnly: {
          native: actual.readOnly,
          browser: reference.readOnly,
          equal: actual.readOnly === reference.readOnly,
        },
      };
    }
  }
  const browserSubmit = browserCapture?.submitRequest?.bodyUtf8 ?? null;
  const nativeSubmit = nativeInteractions.submission?.request?.bodyUtf8 ?? null;
  return {
    available: true,
    controlStates,
    readonlyAttempt: nativeInteractions.readonlyAttempt ?? null,
    disabledAttempt: nativeInteractions.disabledAttempt ?? null,
    resetRestoredInitialValues: nativeInteractions.resetRestoredInitialValues ?? null,
    submission: {
      nativeBodyUtf8: nativeSubmit,
      browserBodyUtf8: browserSubmit,
      exactBodyMatch: nativeSubmit != null && nativeSubmit === browserSubmit,
      nativeEntries: nativeInteractions.submission?.entries ?? null,
      browserEntries: browserCapture?.submitRequest?.decodedEntries ?? null,
    },
  };
}

const reports = [];
for (const browserCapture of web.captures) {
  if (browserCapture.deviceScaleFactor !== 1) continue;
  const name = 'html-control-styles-native-' +
    browserCapture.colorScheme + '-' + browserCapture.width + '-dpr1.json';
  const file = path.join(nativeDir, name);
  const native = readJson(file);
  const controls = {};
  const counts = { available: 0, missing: 0, browserControls: 0 };
  for (const controlName of controlNames) {
    const browserControl = browserCapture.initialDocument.controls[controlName] ?? null;
    if (browserControl) counts.browserControls++;
    controls[controlName] = compareControl(
      native?.controls?.[controlName] ?? null,
      browserControl,
    );
    if (controls[controlName].available) counts.available++;
    else counts.missing++;
  }
  reports.push({
    width: browserCapture.width,
    height: browserCapture.height,
    colorScheme: browserCapture.colorScheme,
    deviceScaleFactor: 1,
    nativeFile: file,
    nativeCaptureAvailable: native != null,
    controls,
    interactionComparison: summarizeInteractions(native, browserCapture),
    coverage: {
      expectedControlCount: controlNames.length,
      nativeControlCount: Object.keys(native?.controls ?? {}).length,
      browserControlCount: counts.browserControls,
      comparisonsAvailable: counts.available,
      controlsMissing: counts.missing,
      captureDeclaredCoverage: native?.coverage ?? null,
    },
    visualParityAccepted: false,
  });
}

const dpr2Path = path.join(
  nativeDir,
  'html-control-styles-native-light-390-dpr2-diagnostic.json',
);
const dpr2Native = readJson(dpr2Path);
const dpr2Diagnostic = dpr2Native
  ? {
      available: true,
      nativeFile: dpr2Path,
      width: dpr2Native.width,
      height: dpr2Native.height,
      devicePixelRatio: dpr2Native.devicePixelRatio,
      controls: dpr2Native.controls,
      note: 'Native-only scale diagnostic; there is no 2x browser golden.',
      visualParityAccepted: false,
    }
  : {
      available: false,
      nativeFile: dpr2Path,
      reason: 'Native-only 2x diagnostic has not been captured.',
      visualParityAccepted: false,
    };

const report = {
  schemaVersion: 1,
  fixture: fixture.id,
  reference: fixture.webRevision,
  comparator: 'Native Flutter widget/style/geometry measurements compared with the pinned actual Chrome DOM snapshots.',
  reports,
  scale2Diagnostic: dpr2Diagnostic,
  limitations: [
    'The comparator records raw deltas and does not apply a tolerance or declare visual acceptance.',
    'EditableText render-box insets and selected-option glyph bounds are not CSS DOMRects or CSS content boxes.',
    'Borders and radii come from the actual NativeHtmlControlBorderPainter and RenderCustomPaint bounds; requested CSS names are reported separately from the pattern that the painter draws, including fallbacks.',
    'Font metrics depend on comparison-only host font aliases and are not bundled app font measurements.',
    'The 2x native capture has no web reference and is diagnostic only.',
  ],
  visualParityAccepted: false,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
const availableCases = reports.filter((capture) => capture.nativeCaptureAvailable).length;
const comparedControls = reports.reduce(
  (sum, capture) => sum + capture.coverage.comparisonsAvailable,
  0,
);
const missingControls = reports.reduce(
  (sum, capture) => sum + capture.coverage.controlsMissing,
  0,
);
console.log(JSON.stringify({
  output: outputPath,
  nativeMatrixCaptures: availableCases + '/' + reports.length,
  measuredControlComparisons: comparedControls,
  missingControlComparisons: missingControls,
  scale2Diagnostic: dpr2Diagnostic.available,
  visualParityAccepted: false,
}, null, 2));
