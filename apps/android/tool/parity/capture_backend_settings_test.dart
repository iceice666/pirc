import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/backend_settings.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

void main() {
  for (final width in [390, 768]) {
    for (final brightness in Brightness.values) {
      testWidgets('backend settings shared fixture $width ${brightness.name}', (
        t,
      ) async {
        final fixture = obj(
          jsonDecode(
            File(
              '../../fixtures/mobile-parity/backend-settings.json',
            ).readAsStringSync(),
          ),
        );
        await t.runAsync(loadParityFonts);
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size(
          width.toDouble(),
          (fixture['height'] as num).toDouble(),
        );
        addTearDown(t.view.reset);
        final g = FakeGateway(),
            c = LiveController(g)..state = {'messages': fixture['messages']};
        g.handler = (_, args) async => fixture['settings'];
        final key = GlobalKey();
        await t.pumpWidget(
          RepaintBoundary(
            key: key,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: theme.build(brightness),
              home: Scaffold(
                body: SingleChildScrollView(
                  padding: const EdgeInsets.all(24),
                  child: BackendSettings(controller: c),
                ),
              ),
            ),
          ),
        );
        await t.pumpAndSettle();
        expect(t.takeException(), isNull);
        final geometry = <String, Object>{
          'sectionHeight': t.getSize(find.byType(BackendSettings)).height,
          for (final id in ['local', 'custom'])
            id: {
              'y': t
                  .getRect(
                    find
                        .descendant(
                          of: find.byKey(ValueKey('backend-$id')),
                          matching: find.byType(DecoratedBox),
                        )
                        .first,
                  )
                  .top,
              'height': t
                  .getSize(
                    find
                        .descendant(
                          of: find.byKey(ValueKey('backend-$id')),
                          matching: find.byType(DecoratedBox),
                        )
                        .first,
                  )
                  .height,
              'width': t
                  .getSize(
                    find
                        .descendant(
                          of: find.byKey(ValueKey('backend-$id')),
                          matching: find.byType(DecoratedBox),
                        )
                        .first,
                  )
                  .width,
            },
        };
        await t.runAsync(() async {
          final capture =
              await (key.currentContext!.findRenderObject()
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 1);
          final bytes = await capture.toByteData(
            format: ui.ImageByteFormat.png,
          );
          final dir = Directory('build/parity')..createSync(recursive: true);
          File(
            '${dir.path}/backend-settings-native-$width-${brightness.name}.json',
          ).writeAsStringSync(
            const JsonEncoder.withIndent('  ').convert(geometry),
          );
          File(
            '${dir.path}/backend-settings-native-$width-${brightness.name}.png',
          ).writeAsBytesSync(bytes!.buffer.asUint8List());
          capture.dispose();
        });
        await t.pumpWidget(const SizedBox());
        c.dispose();
        await g.stream.close();
      });
    }
  }
}
