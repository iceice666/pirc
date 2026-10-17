import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/common.dart';
import 'live_test.dart' show FakeGateway, theme;

final reference =
    jsonDecode(
          File(
            '../../fixtures/mobile-parity/svg-backgrounds.json',
          ).readAsStringSync(),
        )
        as Map;
void main() {
  for (final cssSize in ['100% 100%', '120px auto']) {
    testWidgets('SVG explicit background size $cssSize preserves both halves', (
      t,
    ) async {
      final svg =
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10"><rect width="10" height="10" fill="red"/><rect x="10" width="10" height="10" fill="blue"/></svg>';
      final url = Uri.dataFromString(
        svg,
        mimeType: 'image/svg+xml',
        encoding: utf8,
      );
      const key = ValueKey('svg-explicit');
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: Scaffold(
            body: RepaintBoundary(
              key: key,
              child: SizedBox(
                width: 120,
                height: 60,
                child: RichTextBody(
                  '<div style="width:120px;height:60px;background-image:url(\'$url\');background-size:$cssSize;background-repeat:no-repeat"></div>',
                  gateway: FakeGateway(),
                ),
              ),
            ),
          ),
        ),
      );
      List<int> values = [];
      for (var i = 0; i < 100; i++) {
        await t.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 10)),
        );
        await t.pump();
        values = (await t.runAsync(() async {
          final image = await t
              .renderObject<RenderRepaintBoundary>(find.byKey(key))
              .toImage(pixelRatio: 1);
          try {
            final bytes = (await image.toByteData(
              format: ui.ImageByteFormat.rawRgba,
            ))!.buffer.asUint8List();
            return [
              ...bytes.sublist(
                (30 * image.width + 25) * 4,
                (30 * image.width + 25) * 4 + 4,
              ),
              ...bytes.sublist(
                (30 * image.width + 95) * 4,
                (30 * image.width + 95) * 4 + 4,
              ),
            ];
          } finally {
            image.dispose();
          }
        }))!;
        if (values.toString() == [255, 0, 0, 255, 0, 0, 255, 255].toString()) {
          break;
        }
      }
      expect(values, [255, 0, 0, 255, 0, 0, 255, 255]);
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
    });
  }

  for (final item in reference['cases'] as List) {
    testWidgets(
      'SVG background native vector pixels match Chrome ${item['id']}',
      (t) async {
        final svg =
            reference['reference']['svgAssets'][item['svgAsset']] as String;
        final css = item['css'] as Map;
        final url = Uri.dataFromString(
          svg,
          mimeType: 'image/svg+xml',
          encoding: utf8,
        ).toString();
        final markup =
            '<div style="width:${css['width']};height:${css['height']};background-color:#eee;background-image:url(\'$url\');background-size:${css['backgroundSize']};background-position:${css['backgroundPosition']};background-repeat:${css['backgroundRepeat']}"></div>';
        const key = ValueKey('svg-background');
        await t.pumpWidget(
          MaterialApp(
            theme: theme.build(Brightness.light),
            home: Scaffold(
              body: RepaintBoundary(
                key: key,
                child: SizedBox(
                  width: (item['box']['width'] as num).toDouble(),
                  height: (item['box']['height'] as num).toDouble(),
                  child: RichTextBody(markup, gateway: FakeGateway()),
                ),
              ),
            ),
          ),
        );
        List<String> mismatches = [];
        for (var attempt = 0; attempt < 120; attempt++) {
          await t.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 10)),
          );
          await t.pump();
          final boundary = t.renderObject<RenderRepaintBoundary>(
            find.byKey(key),
          );
          mismatches = (await t.runAsync(() async {
            final image = await boundary.toImage(pixelRatio: 1);
            final found = <String>[];
            try {
              final data = (await image.toByteData(
                format: ui.ImageByteFormat.rawRgba,
              ))!.buffer.asUint8List();
              for (final sample in item['samples'] as List) {
                final x = sample['x'] as int, y = sample['y'] as int;
                final offset = (y * image.width + x) * 4;
                final expected = (sample['rgba'] as List).cast<int>();
                final actual = data.sublist(offset, offset + 4);
                if (List.generate(
                  4,
                  (c) => (actual[c] - expected[c]).abs(),
                ).any((v) => v > 4)) {
                  found.add('$x,$y:$actual vs $expected');
                }
              }
            } finally {
              image.dispose();
            }
            return found;
          }))!;
          if (mismatches.isEmpty) break;
        }
        expect(
          mismatches,
          isEmpty,
          reason: '${item['id']} ${mismatches.take(8).join('; ')}',
        );
        expect(t.takeException(), isNull);
        await t.pumpWidget(const SizedBox());
      },
    );
  }
}
