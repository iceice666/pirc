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
    },
  );

  test('does not mark non-canvas elements independent', () {
    final specs = _specFor(
      '<div id="ordinary" style="width: 350px; height: 220px"></div>',
    );
    expect(specs['ordinary']!.canvasBitmapSizeIndependent, isFalse);
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
