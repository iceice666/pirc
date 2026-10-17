import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/rendering/document_computed_styles.dart';
import 'package:pirc_mobile/rendering/document_layout.dart';

void main() {
  group('NativeDocumentLayoutController', () {
    testWidgets('reports the border box and keeps margin and scroll separate', (
      tester,
    ) async {
      final controller = NativeDocumentLayoutController();
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        _document(
          controller: controller,
          revision: 4,
          knownIds: const {'box'},
          child: Padding(
            padding: const EdgeInsets.only(left: 11, top: 13),
            child: NativeDocumentLayoutElement(
              key: const ValueKey('box-element'),
              controller: controller,
              revision: 4,
              id: 'box',
              child: DecoratedBox(
                decoration: BoxDecoration(border: Border.all(width: 2)),
                child: const Padding(
                  padding: EdgeInsets.all(4),
                  child: SizedBox(width: 20, height: 10),
                ),
              ),
            ),
          ),
        ),
      );

      final packet = _capture(
        controller,
        revision: 4,
        scrollOffset: const Offset(3.5, 20.25),
      );
      final box = _box(packet, 'box');
      expect(box['x'], closeTo(11, 0.001));
      expect(box['y'], closeTo(13, 0.001));
      expect(box['width'], closeTo(28, 0.001));
      expect(box['height'], closeTo(18, 0.001));
      expect(box['offsetWidth'], 28);
      expect(box['offsetHeight'], 18);
      expect(box['clientLeft'], 2);
      expect(box['clientTop'], 2);
      expect(box['clientWidth'], 24);
      expect(box['clientHeight'], 14);
      expect(packet['viewport'], {
        'width': 400.0,
        'height': 300.0,
        'scrollX': 3.5,
        'scrollY': 20.25,
      });
    });

    testWidgets('reports fractional transformed axis-aligned bounds', (
      tester,
    ) async {
      final controller = NativeDocumentLayoutController();
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        _document(
          controller: controller,
          revision: 1,
          knownIds: const {'scaled'},
          child: Transform.translate(
            offset: const Offset(3.25, 4.5),
            child: Transform.scale(
              scale: 1.5,
              alignment: Alignment.topLeft,
              child: NativeDocumentLayoutElement(
                controller: controller,
                revision: 1,
                id: 'scaled',
                child: const SizedBox(width: 20.5, height: 10.25),
              ),
            ),
          ),
        ),
      );

      final box = _box(_capture(controller, revision: 1), 'scaled');
      expect(box['x'], closeTo(3.25, 0.001));
      expect(box['y'], closeTo(4.5, 0.001));
      expect(box['width'], closeTo(30.75, 0.001));
      expect(box['height'], closeTo(15.375, 0.001));
      expect(box['offsetWidth'], 21);
      expect(box['offsetHeight'], 10);
      expect(box['clientLeft'], 0);
      expect(box['clientTop'], 0);
      expect(box['clientWidth'], 21);
      expect(box['clientHeight'], 10);
    });

    testWidgets(
      'stops at nested measured elements and omits ambiguous borders',
      (tester) async {
        final controller = NativeDocumentLayoutController();
        addTearDown(controller.dispose);

        await tester.pumpWidget(
          _document(
            controller: controller,
            revision: 2,
            knownIds: const {'parent', 'child', 'ambiguous'},
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                NativeDocumentLayoutElement(
                  controller: controller,
                  revision: 2,
                  id: 'parent',
                  child: DecoratedBox(
                    decoration: BoxDecoration(border: Border.all(width: 2)),
                    child: Padding(
                      padding: const EdgeInsets.all(4),
                      child: NativeDocumentLayoutElement(
                        controller: controller,
                        revision: 2,
                        id: 'child',
                        child: DecoratedBox(
                          decoration: BoxDecoration(
                            border: Border.all(width: 5),
                          ),
                          child: const SizedBox(width: 20, height: 10),
                        ),
                      ),
                    ),
                  ),
                ),
                NativeDocumentLayoutElement(
                  controller: controller,
                  revision: 2,
                  id: 'ambiguous',
                  child: DecoratedBox(
                    decoration: BoxDecoration(border: Border.all(width: 2)),
                    child: DecoratedBox(
                      decoration: BoxDecoration(border: Border.all(width: 3)),
                      child: const SizedBox(width: 20, height: 10),
                    ),
                  ),
                ),
              ],
            ),
          ),
        );

        final packet = _capture(controller, revision: 2);
        final parent = _box(packet, 'parent');
        final child = _box(packet, 'child');
        final ambiguous = _box(packet, 'ambiguous');
        expect(parent['clientLeft'], 2);
        expect(child['clientLeft'], 5);
        expect(ambiguous.containsKey('clientLeft'), isFalse);
        expect(ambiguous.containsKey('clientWidth'), isFalse);
      },
    );

    testWidgets('distinguishes no-box, missing, and duplicate IDs', (
      tester,
    ) async {
      final controller = NativeDocumentLayoutController();
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        _document(
          controller: controller,
          revision: 3,
          knownIds: const {'duplicate', 'missing', 'no-box'},
          noBoxIds: const {'no-box'},
          child: Row(
            children: [
              NativeDocumentLayoutElement(
                controller: controller,
                revision: 3,
                id: 'duplicate',
                child: const SizedBox(width: 10, height: 10),
              ),
              NativeDocumentLayoutElement(
                controller: controller,
                revision: 3,
                id: 'duplicate',
                child: const SizedBox(width: 20, height: 10),
              ),
            ],
          ),
        ),
      );

      final packet = _capture(controller, revision: 3);
      expect(_box(packet, 'no-box')['kind'], 'none');
      expect(_box(packet, 'missing')['kind'], 'unsupported');
      expect(_box(packet, 'duplicate')['kind'], 'unsupported');
    });

    testWidgets('passes through intrinsic dimensions and baseline', (
      tester,
    ) async {
      final controller = NativeDocumentLayoutController();
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        _document(
          controller: controller,
          revision: 1,
          knownIds: const {'text'},
          child: NativeDocumentLayoutElement(
            key: const ValueKey('measured-text'),
            controller: controller,
            revision: 1,
            id: 'text',
            child: RichText(
              key: const ValueKey('text-child'),
              text: const TextSpan(text: 'intrinsic and baseline probe'),
              textDirection: TextDirection.ltr,
            ),
          ),
        ),
      );

      final wrapper = tester.renderObject<RenderBox>(
        find.byKey(const ValueKey('measured-text')),
      );
      final text = tester.renderObject<RenderBox>(
        find.byKey(const ValueKey('text-child')),
      );
      expect(wrapper.getMinIntrinsicWidth(120), text.getMinIntrinsicWidth(120));
      expect(
        wrapper.getMaxIntrinsicHeight(120),
        text.getMaxIntrinsicHeight(120),
      );
      expect(
        wrapper.getDryBaseline(wrapper.constraints, TextBaseline.alphabetic),
        text.getDryBaseline(text.constraints, TextBaseline.alphabetic),
      );
    });

    testWidgets('emits canvas bitmap independence only for measured boxes', (
      tester,
    ) async {
      final controller = NativeDocumentLayoutController();
      addTearDown(controller.dispose);
      final spec = NativeDocumentComputedStyleSpec(
        values: const {},
        lengths: const {},
        fontSize: 16,
        rootFontSize: 16,
        canvasBitmapSizeIndependent: true,
      );

      await tester.pumpWidget(
        _document(
          controller: controller,
          revision: 1,
          knownIds: const {'canvas', 'no-box'},
          noBoxIds: const {'no-box'},
          computedStyles: {'canvas': spec, 'no-box': spec},
          child: NativeDocumentLayoutElement(
            controller: controller,
            revision: 1,
            id: 'canvas',
            child: const SizedBox(width: 350, height: 220),
          ),
        ),
      );

      final packet = _capture(controller, revision: 1);
      expect(_box(packet, 'canvas')['canvasBitmapSizeIndependent'], isTrue);
      expect(
        _box(packet, 'no-box').containsKey('canvasBitmapSizeIndependent'),
        isFalse,
      );
    });

    testWidgets('replacement keeps the new ID binding and detach clears root', (
      tester,
    ) async {
      final controller = NativeDocumentLayoutController();
      addTearDown(controller.dispose);

      Widget tree(String key, double width) => _document(
        controller: controller,
        revision: 1,
        knownIds: const {'same'},
        child: KeyedSubtree(
          key: ValueKey(key),
          child: NativeDocumentLayoutElement(
            key: ValueKey('element-$key'),
            controller: controller,
            revision: 1,
            id: 'same',
            child: SizedBox(width: width, height: 12),
          ),
        ),
      );

      await tester.pumpWidget(tree('old', 20));
      expect(
        _box(_capture(controller, revision: 1), 'same')['offsetWidth'],
        20,
      );

      await tester.pumpWidget(tree('new', 37));
      expect(
        _box(_capture(controller, revision: 1), 'same')['offsetWidth'],
        37,
      );

      await tester.pumpWidget(const SizedBox.shrink());
      expect(
        controller.capture(
          revision: 1,
          generation: 8,
          viewport: const Size(400, 300),
        ),
        isNull,
      );
    });

    testWidgets('moves registrations when the controller owner changes', (
      tester,
    ) async {
      final oldController = NativeDocumentLayoutController();
      final newController = NativeDocumentLayoutController();
      addTearDown(oldController.dispose);
      addTearDown(newController.dispose);

      Widget tree(NativeDocumentLayoutController controller) => _document(
        controller: controller,
        revision: 6,
        knownIds: const {'owned'},
        child: NativeDocumentLayoutElement(
          controller: controller,
          revision: 6,
          id: 'owned',
          child: const SizedBox(width: 26, height: 12),
        ),
      );

      await tester.pumpWidget(tree(oldController));
      expect(
        _box(_capture(oldController, revision: 6), 'owned')['kind'],
        'box',
      );

      await tester.pumpWidget(tree(newController));
      expect(_captureOrNull(oldController, revision: 6), isNull);
      expect(
        _box(_capture(newController, revision: 6), 'owned')['kind'],
        'box',
      );
    });

    testWidgets(
      'translates fixture-positioned render boxes into viewport coordinates',
      (tester) async {
        final controller = NativeDocumentLayoutController();
        addTearDown(controller.dispose);
        final fixture =
            jsonDecode(
                  File(
                    'tool/parity/fixtures/document-layout-chromium153.json',
                  ).readAsStringSync(),
                )
                as Map<String, dynamic>;
        final fixtureCase = (fixture['cases'] as List)
            .cast<Map<String, dynamic>>()
            .firstWhere(
              (entry) =>
                  entry['name'] == 'offscreen_boxes_after_scroll' &&
                  entry['viewportWidth'] == 390 &&
                  entry['theme'] == 'light',
            );
        final scrollY = (fixtureCase['scrollY'] as num).toDouble();
        final expected = fixtureCase['expected'] as Map<String, dynamic>;
        final ids = (fixtureCase['targets'] as List).cast<String>();
        final scrollX =
            ((expected[ids.first] as Map<String, dynamic>)['scrollX'] as num)
                .toDouble();
        final viewport = fixture['viewport'] as Map<String, dynamic>;
        final viewportHeight = (viewport['height'] as num).toDouble();

        Widget measuredBox(String id) {
          final item = expected[id] as Map<String, dynamic>;
          final rect = item['rect'] as Map<String, dynamic>;
          final borderWidth = (item['clientLeft'] as num).toDouble();
          return Positioned(
            left: (rect['x'] as num).toDouble() + scrollX,
            top: (rect['y'] as num).toDouble() + scrollY,
            child: NativeDocumentLayoutElement(
              controller: controller,
              revision: 9,
              id: id,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  border: borderWidth == 0
                      ? null
                      : Border.all(width: borderWidth),
                ),
                child: SizedBox(
                  width: (rect['width'] as num).toDouble(),
                  height: (rect['height'] as num).toDouble(),
                ),
              ),
            ),
          );
        }

        await tester.pumpWidget(
          Directionality(
            textDirection: TextDirection.ltr,
            child: NativeDocumentLayoutRoot(
              controller: controller,
              revision: 9,
              knownIds: ids.toSet(),
              child: SizedBox(
                width: 390,
                height: 1300,
                child: Stack(children: [for (final id in ids) measuredBox(id)]),
              ),
            ),
          ),
        );

        final packet = controller.capture(
          revision: 9,
          generation: 3,
          viewport: Size(
            (fixtureCase['viewportWidth'] as num).toDouble(),
            viewportHeight,
          ),
          scrollOffset: Offset(scrollX, scrollY),
        )!;
        final packetViewport = packet['viewport'] as Map<String, dynamic>;
        expect(packetViewport['scrollY'], scrollY);
        for (final id in ids) {
          final item = expected[id] as Map<String, dynamic>;
          final viewportRect = item['rect'] as Map<String, dynamic>;
          final box = _box(packet, id);
          expect(box['kind'], 'box');
          expect(
            (box['x'] as num) - (packetViewport['scrollX'] as num),
            closeTo((viewportRect['x'] as num).toDouble(), 0.001),
          );
          expect(
            (box['y'] as num) - (packetViewport['scrollY'] as num),
            closeTo((viewportRect['y'] as num).toDouble(), 0.001),
          );
          expect(
            box['width'],
            closeTo((viewportRect['width'] as num).toDouble(), 0.001),
          );
          expect(
            box['height'],
            closeTo((viewportRect['height'] as num).toDouble(), 0.001),
          );
          expect(box['offsetWidth'], item['offsetWidth']);
          expect(box['offsetHeight'], item['offsetHeight']);
          expect(box['clientLeft'], item['clientLeft']);
          expect(box['clientTop'], item['clientTop']);
          expect(box['clientWidth'], item['clientWidth']);
          expect(box['clientHeight'], item['clientHeight']);
        }
      },
    );

    testWidgets('rejects more than the supported ID limit', (tester) async {
      final controller = NativeDocumentLayoutController();
      addTearDown(controller.dispose);
      final ids = <String>{
        for (
          var index = 0;
          index <= NativeDocumentLayoutController.maximumElementCount;
          index++
        )
          'id-$index',
      };

      await tester.pumpWidget(
        _document(
          controller: controller,
          revision: 1,
          knownIds: ids,
          child: const SizedBox(width: 10, height: 10),
        ),
      );

      expect(() => _captureOrNull(controller, revision: 1), throwsRangeError);
    });

    testWidgets('rejects stale revisions and reports unmeasured IDs', (
      tester,
    ) async {
      final controller = NativeDocumentLayoutController();
      addTearDown(controller.dispose);

      Widget tree(int rootRevision, int elementRevision) => _document(
        controller: controller,
        revision: rootRevision,
        knownIds: const {'target'},
        child: NativeDocumentLayoutElement(
          controller: controller,
          revision: elementRevision,
          id: 'target',
          child: const SizedBox(width: 31, height: 14),
        ),
      );

      await tester.pumpWidget(tree(1, 1));
      expect(_box(_capture(controller, revision: 1), 'target')['kind'], 'box');

      await tester.pumpWidget(tree(2, 1));
      expect(_captureOrNull(controller, revision: 1), isNull);
      expect(
        _box(_capture(controller, revision: 2), 'target')['kind'],
        'unsupported',
      );

      await tester.pumpWidget(tree(2, 2));
      expect(_box(_capture(controller, revision: 2), 'target')['kind'], 'box');
    });
  });
}

Widget _document({
  required NativeDocumentLayoutController controller,
  required int revision,
  required Set<String> knownIds,
  Set<String> noBoxIds = const <String>{},
  Map<String, NativeDocumentComputedStyleSpec> computedStyles = const {},
  required Widget child,
}) {
  return Directionality(
    textDirection: TextDirection.ltr,
    child: NativeDocumentLayoutRoot(
      controller: controller,
      revision: revision,
      knownIds: knownIds,
      noBoxIds: noBoxIds,
      computedStyles: computedStyles,
      child: SizedBox(
        width: 400,
        height: 300,
        child: Align(alignment: Alignment.topLeft, child: child),
      ),
    ),
  );
}

Map<String, dynamic> _capture(
  NativeDocumentLayoutController controller, {
  required int revision,
  Offset scrollOffset = Offset.zero,
}) {
  final packet = _captureOrNull(
    controller,
    revision: revision,
    scrollOffset: scrollOffset,
  );
  expect(packet, isNotNull);
  return packet!;
}

Map<String, dynamic>? _captureOrNull(
  NativeDocumentLayoutController controller, {
  required int revision,
  Offset scrollOffset = Offset.zero,
}) {
  return controller.capture(
    revision: revision,
    generation: 8,
    viewport: const Size(400, 300),
    scrollOffset: scrollOffset,
  );
}

Map<String, dynamic> _box(Map<String, dynamic> packet, String id) {
  final boxes = (packet['boxes'] as List).cast<Map<String, dynamic>>();
  return boxes.singleWhere((box) => box['id'] == id);
}
