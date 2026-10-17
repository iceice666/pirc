import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/common.dart';
import 'package:pirc_mobile/live/gateway.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import '../../test/markdown_image_test.dart' show svgData, waitImage;
import 'capture_fonts.dart';

Json box(WidgetTester tester, Finder finder) {
  final r = tester.getRect(finder);
  return {'left': r.left, 'top': r.top, 'width': r.width, 'height': r.height};
}

void main() {
  final fixture =
      jsonDecode(
            File(
              '../../fixtures/mobile-parity/markdown-images.json',
            ).readAsStringSync(),
          )
          as Json;
  testWidgets('capture real native table images against pinned browser', (
    tester,
  ) async {
    await tester.runAsync(loadParityFonts);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final output = Directory('build/parity')..createSync(recursive: true);
    final captures = <Json>[];
    for (final width in fixture['tableWidths'] as List) {
      tester.view.physicalSize = Size((width as num).toDouble(), 500);
      for (final brightness in Brightness.values) {
        for (final scale in [1.0, 2.0]) {
          tester.platformDispatcher.textScaleFactorTestValue = scale;
          for (final item in rows(fixture['tableCases'])) {
            final gateway = FakeGateway();
            gateway.handler = (method, args) async {
              if (method != 'image' || args['source'] != item['imageSource']) {
                throw StateError(
                  'Unexpected table fixture call: $method $args',
                );
              }
              return svgData();
            };
            final boundary = GlobalKey();
            final data = theme.build(brightness);
            await tester.pumpWidget(
              RepaintBoundary(
                key: boundary,
                child: MaterialApp(
                  debugShowCheckedModeBanner: false,
                  theme: data.copyWith(
                    textTheme: data.textTheme.apply(fontFamily: 'Arial'),
                  ),
                  home: Scaffold(
                    body: SingleChildScrollView(
                      child: RichTextBody(
                        '${item['source']}',
                        gateway: gateway,
                      ),
                    ),
                  ),
                ),
              ),
            );
            await waitImage(
              tester,
              () => find.byType(SvgPicture).evaluate().isNotEmpty,
            );
            await tester.pumpAndSettle();
            expect(tester.takeException(), isNull);
            expect(gateway.calls, hasLength(1));
            final screenshot =
                'markdown-table-images-native-${item['id']}-$width-${brightness.name}-scale${scale.toInt()}.png';
            captures.add({
              'id': item['id'],
              'width': width,
              'theme': brightness.name,
              'textScale': scale,
              'src': gateway.calls.single.$2['source'],
              'image': box(tester, find.byType(SvgPicture)),
              'table': box(tester, find.byType(Table)),
              'viewport': box(
                tester,
                find.byKey(const ValueKey('native-markdown-table')),
              ),
              'screenshot': screenshot,
            });
            await tester.runAsync(() async {
              final image =
                  await (boundary.currentContext!.findRenderObject()
                          as RenderRepaintBoundary)
                      .toImage(pixelRatio: 1);
              try {
                final png = await image.toByteData(
                  format: ui.ImageByteFormat.png,
                );
                File(
                  '${output.path}/$screenshot',
                ).writeAsBytesSync(png!.buffer.asUint8List());
              } finally {
                image.dispose();
              }
            });
            await tester.pumpWidget(const SizedBox());
            await tester.pumpAndSettle();
            await gateway.stream.close();
          }
        }
      }
    }
    File('${output.path}/markdown-table-images-native.json').writeAsStringSync(
      '${const JsonEncoder.withIndent('  ').convert({'reference': fixture['webRevision'], 'captures': captures})}\n',
    );
  });
}
