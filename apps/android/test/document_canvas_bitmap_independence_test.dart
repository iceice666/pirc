import 'package:flutter_test/flutter_test.dart';
import 'package:html/parser.dart' as html;
import 'package:pirc_mobile/rendering/document_computed_styles.dart';
import 'package:pirc_mobile/rendering/html_document_styles.dart';

void main() {
  test('marks only canvas boxes with two authored numeric pixel sizes', () {
    final fixed = _specFor(
      '<canvas id="fixed" style="width: 350px; height: 220px"></canvas>',
    );
    expect(fixed['fixed']!.canvasBitmapSizeIndependent, isTrue);
    expect(fixed['fixed']!.canvasEquivalentStyleWrites, isFalse);

    for (final style in [
      'width: auto; height: 220px',
      'width: 350px; height: 50%',
      'width: 22em; height: 220px',
      'width: calc(300px + 50px); height: 220px',
      'width: 350px',
    ]) {
      final spec = _specFor('<canvas id="candidate" style="$style"></canvas>');
      expect(
        spec['candidate']!.canvasBitmapSizeIndependent,
        isFalse,
        reason: style,
      );
    }
  });

  test(
    'keeps zero pixel dimensions eligible and requires the document gate',
    () {
      final zero = _specFor(
        '<canvas id="zero" style="width: 0px; height: 0px"></canvas>',
      );
      expect(zero['zero']!.canvasBitmapSizeIndependent, isTrue);

      final gated = _specFor(
        '<canvas id="gated" style="width: 350px; height: 220px"></canvas>',
        canvasBitmapAttributesIndependent: false,
      );
      expect(gated['gated']!.canvasBitmapSizeIndependent, isFalse);
      expect(gated['gated']!.canvasEquivalentStyleWrites, isFalse);
    },
  );

  test('accepts percent width under an explicit ordinary block width', () {
    final percent = _specFor('''
      <div id="parent" style="width: 350px; height: 240px">
        <canvas id="percent" style="width: 100%; height: 240px"></canvas>
      </div>
    ''');
    expect(percent['percent']!.canvasBitmapSizeIndependent, isTrue);
    expect(percent['percent']!.canvasEquivalentStyleWrites, isTrue);

    final pixels = _specFor('''
      <div id="parent" style="width: 350px; height: 240px">
        <canvas id="pixels" style="width: 350px; height: 240px"></canvas>
      </div>
    ''');
    expect(pixels['pixels']!.canvasBitmapSizeIndependent, isTrue);
    expect(pixels['pixels']!.canvasEquivalentStyleWrites, isTrue);

    final relativeParent = _specFor('''
      <div id="parent" style="position: relative; width: 350px; height: 240px">
        <canvas id="relative" style="width: 0%; height: 0px"></canvas>
      </div>
    ''');
    expect(relativeParent['relative']!.canvasBitmapSizeIndependent, isTrue);
    expect(relativeParent['relative']!.canvasEquivalentStyleWrites, isTrue);
  });

  test('rejects percent width without an explicit pixel-width parent', () {
    for (final parentStyle in ['height: 240px', 'width: 100%; height: 240px']) {
      final specs = _specFor('''
        <div id="parent" style="$parentStyle">
          <canvas id="candidate" style="width: 100%; height: 240px"></canvas>
        </div>
      ''');
      expect(
        specs['candidate']!.canvasBitmapSizeIndependent,
        isFalse,
        reason: parentStyle,
      );
      expect(
        specs['candidate']!.canvasEquivalentStyleWrites,
        isFalse,
        reason: parentStyle,
      );
    }
  });

  test('rejects percent sizing in non-block or intrinsic layout ancestors', () {
    for (final wrapper in [
      '<div style="display: flex; width: 350px; height: 240px">{canvas}</div>',
      '<div style="display: grid; width: 350px; height: 240px">{canvas}</div>',
      '<table style="width: 350px"><tbody><tr><td>{canvas}</td></tr></tbody></table>',
      '<div style="width: 350px"><span>{canvas}</span></div>',
      '<div style="width: 350px"><div style="display: inline-block; width: 350px">{canvas}</div></div>',
      '<div style="width: 350px; float: left; height: 240px">{canvas}</div>',
      '<div style="width: 350px; position: absolute; height: 240px">{canvas}</div>',
      '<div style="width: 350px; position: fixed; height: 240px">{canvas}</div>',
      '<div style="width: min-content"><div style="width: 350px">{canvas}</div></div>',
      '<div style="width: 350px; min-width: min-content">{canvas}</div>',
      '<div style="width: 350px; max-width: max-content">{canvas}</div>',
      '<div style="width: 350px; aspect-ratio: auto">{canvas}</div>',
      '<div style="width: 350px; inline-size: 350px">{canvas}</div>',
      '<div style="position: absolute"><div style="width: 350px">{canvas}</div></div>',
    ]) {
      final specs = _specFor(
        wrapper.replaceAll(
          '{canvas}',
          '<canvas id="candidate" style="width: 100%; height: 240px"></canvas>',
        ),
      );
      expect(
        specs['candidate']!.canvasBitmapSizeIndependent,
        isFalse,
        reason: wrapper,
      );
      expect(
        specs['candidate']!.canvasEquivalentStyleWrites,
        isFalse,
        reason: wrapper,
      );
    }
  });

  test('requires fixed pixel canvas height and supported writing mode', () {
    for (final canvasStyle in [
      'width: 100%; height: auto',
      'width: 100%; height: 50%',
      'width: auto; height: 240px',
    ]) {
      final specs = _specFor('''
        <div style="width: 350px; height: 240px">
          <canvas id="candidate" style="$canvasStyle"></canvas>
        </div>
      ''');
      expect(
        specs['candidate']!.canvasBitmapSizeIndependent,
        isFalse,
        reason: canvasStyle,
      );
      expect(
        specs['candidate']!.canvasEquivalentStyleWrites,
        isFalse,
        reason: canvasStyle,
      );
    }

    final vertical = _specFor('''
      <div style="width: 350px; height: 240px; writing-mode: vertical-rl">
        <canvas id="candidate" style="width: 100%; height: 240px"></canvas>
      </div>
    ''');
    expect(vertical['candidate']!.resizeSupported, isFalse);
    expect(vertical['candidate']!.canvasBitmapSizeIndependent, isFalse);
    expect(vertical['candidate']!.canvasEquivalentStyleWrites, isFalse);
  });

  test('does not mark non-canvas elements independent', () {
    final specs = _specFor(
      '<div id="ordinary" style="width: 350px; height: 220px"></div>',
    );
    expect(specs['ordinary']!.canvasBitmapSizeIndependent, isFalse);
    expect(specs['ordinary']!.canvasEquivalentStyleWrites, isFalse);
  });
  test('special UA and native layout boxes never grant percentage independence', () {
    for (final source in [
      '<fieldset style="width:350px"><canvas id="target" style="width:100%;height:240px"></canvas></fieldset>',
      '<button style="display:block;width:350px"><canvas id="target" style="width:100%;height:240px"></canvas></button>',
      '<dialog open style="width:350px"><canvas id="target" style="width:100%;height:240px"></canvas></dialog>',
      '<div style="width:350px;columns:2"><canvas id="target" style="width:100%;height:240px"></canvas></div>',
    ]) {
      final spec = _specFor(source)['target']!;
      expect(spec.canvasBitmapSizeIndependent, isFalse, reason: source);
      expect(spec.canvasEquivalentStyleWrites, isFalse, reason: source);
    }
  });
}

Map<String, NativeDocumentComputedStyleSpec> _specFor(
  String source, {
  bool canvasBitmapAttributesIndependent = true,
}) {
  final document = html.parse(source);
  final testIdsByScriptId = <String, String>{};
  for (final (index, element) in document.querySelectorAll('*').indexed) {
    final scriptId = 'pirc-${index + 1}';
    testIdsByScriptId[scriptId] = element.id.isEmpty ? scriptId : element.id;
    element.attributes['data-pirc-script-id'] = 'pirc-${index + 1}';
  }
  final styles = NativeDocumentStyleEngine(
    stylesheets: const [],
    viewportWidth: 390,
    dark: false,
  ).apply(document);
  final byScriptId = nativeDocumentComputedStyleSpecs(
    document: document,
    stylesByElement: styles.stylesByElement,
    viewportWidth: 390,
    viewportHeight: 844,
    canvasBitmapAttributesIndependent: canvasBitmapAttributesIndependent,
  );
  return {
    for (final entry in testIdsByScriptId.entries)
      if (byScriptId.containsKey(entry.key))
        entry.value: byScriptId[entry.key]!,
  };
}
