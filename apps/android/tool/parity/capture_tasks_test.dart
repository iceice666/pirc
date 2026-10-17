import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/tasks_pane.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

void main() {
  final f = obj(
    jsonDecode(
      File('../../fixtures/mobile-parity/tasks.json').readAsStringSync(),
    ),
  );
  for (final width in f['widths']) {
    for (final view in f['views']) {
      for (final brightness in Brightness.values) {
        testWidgets('tasks $width $view ${brightness.name}', (t) async {
          await t.runAsync(loadParityFonts);
          debugDisableShadows = false;
          t.view.devicePixelRatio = 1;
          t.view.physicalSize = Size(
            (width as num).toDouble(),
            (f['height'] as num).toDouble(),
          );
          addTearDown(t.view.reset);
          final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
          g.handler = (_, a) async => '${a['path']}'.contains('/background/')
              ? f['output']
              : view == 'empty'
              ? f['empty']
              : f['panel'];
          final key = GlobalKey();
          await t.pumpWidget(
            RepaintBoundary(
              key: key,
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: theme.build(brightness),
                home: Scaffold(
                  body: TasksPane(
                    controller: c,
                    clock: () => DateTime.fromMillisecondsSinceEpoch(f['now']),
                  ),
                ),
              ),
            ),
          );
          await t.pumpAndSettle();
          if (view == 'output') {
            await t.tap(find.text('bun run watch --verbose'));
            await t.pumpAndSettle();
          }
          expect(t.takeException(), isNull);
          await t.runAsync(() async {
            final img =
                await (key.currentContext!.findRenderObject()
                        as RenderRepaintBoundary)
                    .toImage(pixelRatio: 1);
            final bytes = await img.toByteData(format: ui.ImageByteFormat.png);
            File(
              'build/parity/tasks-native-$width-$view-${brightness.name}.png',
            ).writeAsBytesSync(bytes!.buffer.asUint8List());
            img.dispose();
          });
          await t.pumpWidget(const SizedBox());
          c.dispose();
          await g.stream.close();
          debugDisableShadows = true;
        });
      }
    }
  }
}
