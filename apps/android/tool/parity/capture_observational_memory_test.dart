import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/observational_memory_pane.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import '../../test/observational_memory_test.dart'
    show memoryFixture, memoryView;
import 'capture_fonts.dart';

void main() {
  for (final width in memoryFixture['widths']) {
    for (final view in memoryFixture['views']) {
      for (final brightness in Brightness.values) {
        testWidgets('observational memory $width $view ${brightness.name}', (
          t,
        ) async {
          await t.runAsync(loadParityFonts);
          debugDisableShadows = false;
          t.view.devicePixelRatio = 1;
          t.view.physicalSize = Size(
            (width as num).toDouble(),
            (memoryFixture['height'] as num).toDouble(),
          );
          addTearDown(t.view.reset);
          final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
          g.handler = (_, _) async => memoryView(view);
          await c.panelData.refresh();
          final key = GlobalKey();
          await t.pumpWidget(
            RepaintBoundary(
              key: key,
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: theme.build(brightness),
                home: Scaffold(
                  body: TickerMode(
                    enabled: view != 'working',
                    child: ObservationalMemoryPane(
                      controller: c,
                      clock: () => DateTime.fromMillisecondsSinceEpoch(
                        memoryFixture['now'],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
          await t.pumpAndSettle();
          if (view == 'all') {
            await t.tap(find.byKey(const ValueKey('memory-filter-all')));
            await t.pumpAndSettle();
          }
          if (view == 'expanded') {
            await t.tap(
              find.byKey(const ValueKey('memory-entry-a00000000001')),
            );
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
              'build/parity/observational-memory-native-$width-$view-${brightness.name}.png',
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
