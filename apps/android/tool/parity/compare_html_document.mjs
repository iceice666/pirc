import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const readJson = async (path) =>
  JSON.parse(await readFile(resolve(root, path), 'utf8'));
const fixture = await readJson('fixtures/mobile-parity/html-navigation.json');
const web = await readJson(
  'fixtures/mobile-parity/html-navigation-expected.json',
);
assert.equal(fixture.webRevision, 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c');
assert.equal(web.reference, fixture.webRevision);
assert.equal(web.fixture, fixture.id);
assert.match(fixture.responseStyleSource, /id="response-heading"/);

const rectKeys = ['x', 'y', 'width', 'height'];
function compareRect(nativeRect, webRect, sourceNote) {
  if (!nativeRect || !webRect) return null;
  const delta = Object.fromEntries(
    rectKeys.map((key) => [key, nativeRect[key] - webRect[key]]),
  );
  return {
    native: nativeRect,
    web: webRect,
    delta,
    maximumAbsoluteDelta: Math.max(
      ...Object.values(delta).map((value) => Math.abs(value)),
    ),
    sourceNote: sourceNote || null,
  };
}

const configurations = [];
const allRectDeltas = [];
const comparableRectDeltas = [];
const missingConfigurations = [];
for (const colorScheme of ['light', 'dark']) {
  for (const width of [390, 768]) {
    const path =
      'apps/android/build/parity/html-document-native-' +
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
    const capture = await readJson(path);
    assert.equal(capture.fixture, fixture.id);
    assert.equal(capture.reference, fixture.webRevision);
    assert.equal(capture.width, width);
    assert.equal(capture.height, 844);
    assert.equal(capture.colorScheme, colorScheme);
    const screenshot = await stat(resolve(root, 'apps/android', capture.pngPath));
    assert(screenshot.size > 0);

    const webProbe = web.responseStyleProbes.find(
      (probe) =>
        probe.width === width && probe.colorScheme === colorScheme,
    );
    assert(webProbe);
    const nodes = webProbe.document.nodes;
    const boxes = {
      body: compareRect(
        capture.bodyRect,
        nodes.body.rect,
        capture.bodyRectSource,
      ),
      heading: compareRect(
        capture.textBoxes.heading.rect,
        nodes.h1.rect,
        'Web h1 DOMRect versus native RichText paragraph bounds.',
      ),
      paragraph: compareRect(
        capture.textBoxes.paragraph.rect,
        nodes.p.rect,
        'Web p DOMRect versus native RichText bounds.',
      ),
      anchor: compareRect(
        capture.textBoxes.anchor.rect,
        nodes.a.rect,
        'Web anchor DOMRect versus native RichText bounds.',
      ),
      input: compareRect(
        capture.controls.input.borderBox,
        nodes.input.rect,
        'Web input DOMRect versus native text-field widget border box.',
      ),
      button: compareRect(
        capture.controls.button.borderBox,
        nodes.button.rect,
        'Web button DOMRect versus native button widget border box.',
      ),
    };
    for (const [name, item] of Object.entries(boxes)) {
      if (item) {
        allRectDeltas.push(item.maximumAbsoluteDelta);
        if (name !== 'body') comparableRectDeltas.push(item.maximumAbsoluteDelta);
      }
    }
    const nativeWhite = capture.canvasWhitePixel;
    const webWhite = webProbe.viewportCornerPixel;
    configurations.push({
      width,
      height: capture.height,
      devicePixelRatio: capture.devicePixelRatio,
      colorScheme,
      pngPath: capture.pngPath,
      pngBytes: screenshot.size,
      bodyRect: boxes.body,
      textBoxes: {
        heading: boxes.heading,
        paragraph: boxes.paragraph,
        anchor: boxes.anchor,
        buttonLabel: capture.textBoxes.buttonLabel,
      },
      inputSizingMetrics: capture.inputSizingMetrics,
      controls: {
        input: {
          ...boxes.input,
          nativeFontFamily: capture.controls.input.fontFamily,
          nativeFontSize: capture.controls.input.fontSize,
          webFont: nodes.input.font,
          webFontSize: nodes.input.fontSize,
        },
        button: {
          ...boxes.button,
          nativeFontFamily: capture.controls.button.fontFamily,
          nativeFontSize: capture.controls.button.fontSize,
          webFont: nodes.button.font,
          webFontSize: nodes.button.fontSize,
        },
      },
      textStyles: {
        heading: {
          nativeFontFamily: capture.textBoxes.heading.fontFamily,
          nativeFontSize: capture.textBoxes.heading.fontSize,
          nativeColorArgb: capture.textBoxes.heading.colorArgb,
          webFont: nodes.h1.font,
          webFontSize: nodes.h1.fontSize,
          webColor: nodes.h1.color,
        },
        paragraph: {
          nativeFontFamily: capture.textBoxes.paragraph.fontFamily,
          nativeFontSize: capture.textBoxes.paragraph.fontSize,
          nativeColorArgb: capture.textBoxes.paragraph.colorArgb,
          webFont: nodes.p.font,
          webFontSize: nodes.p.fontSize,
          webColor: nodes.p.color,
        },
        anchor: {
          nativeFontFamily: capture.textBoxes.anchor.fontFamily,
          nativeFontSize: capture.textBoxes.anchor.fontSize,
          nativeColorArgb: capture.textBoxes.anchor.colorArgb,
          webFont: nodes.a.font,
          webFontSize: nodes.a.fontSize,
          webColor: nodes.a.color,
        },
      },
      canvasWhite: {
        native: nativeWhite,
        web: webWhite,
        exactRgbaMatch:
          nativeWhite.r === webWhite.r &&
          nativeWhite.g === webWhite.g &&
          nativeWhite.b === webWhite.b &&
          nativeWhite.a === webWhite.a,
      },
      hostFontAliases: capture.hostFontAliases,
      fontLimits: capture.fontLimits,
    });
  }
}

const summary = {
  reference: fixture.webRevision,
  browserVersion: web.browserVersion,
  origin: web.origin,
  responseUrl: web.origin + '/nav/style-probe',
  captureComplete: missingConfigurations.length === 0,
  missingConfigurations,
  configurations,
  maximumAbsoluteRectDelta:
    allRectDeltas.length > 0 ? Math.max(...allRectDeltas) : null,
  maximumComparableRectDelta:
    comparableRectDeltas.length > 0 ? Math.max(...comparableRectDeltas) : null,
  visualParityAccepted: false,
  limitations: [
    'Raw native measurements are compared with the existing Chrome computed-style and DOMRect samples; no reference PNG is rewritten or accepted by a pixel threshold.',
    'Native bodyRect is the HtmlWidget root-fragment render bound, not a DOM body element box.',
    'Native serif/Times aliases load the name-selected PingFang TC Regular/Semibold faces reported by Chrome CDP on this macOS host; extracted files are ignored build output and are not bundled into the app.',
    'Arial host files are comparison-only; host font output is not a portable Android font reference.',
    'Only 1x captures at 390px and 768px are measured. There is no 2x web reference.',
    'The sample contains Latin text only; non-Latin fallback and glyph coverage are not measured.',
  ],
};
const outputPath = resolve(
  root,
  'apps/android/build/parity/html-document-comparison.json',
);
await writeFile(outputPath, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
