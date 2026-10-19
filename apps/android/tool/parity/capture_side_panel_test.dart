import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/side_panel.dart';
import 'package:pirc_mobile/live/panels.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

void main() {
  final fixture = obj(
    jsonDecode(
      File('../../fixtures/mobile-parity/side-panel.json').readAsStringSync(),
    ),
  );
  for (final width in fixture['widths']) {
    for (final view in fixture['views']) {
      for (final brightness in Brightness.values) {
        testWidgets('side panel $width $view ${brightness.name}', (t) async {
          await t.runAsync(loadParityFonts);
          debugDisableShadows = false;
          t.view.devicePixelRatio = 1;
          t.view.physicalSize = Size((width as num).toDouble(), 844);
          addTearDown(t.view.reset);
          final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
          g.handler = (_, a) async => '${a['path']}'.contains('/panel/context')
              ? fixture['context']
              : fixture['directory'];
          final key = GlobalKey();
          final overlay = width <= 860, phone = width <= 650;
          final panelWidth = overlay
              ? (phone ? width.toDouble() : 420.0)
              : 360.0
                    .clamp(280, sidePanelMax(width.toDouble(), false))
                    .toDouble();
          await t.pumpWidget(
            RepaintBoundary(
              key: key,
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: theme.build(brightness),
                home: Scaffold(
                  body: Stack(
                    children: [
                      Positioned(
                        top: 56,
                        right: overlay && !phone ? 8 : 0,
                        bottom: overlay && !phone ? 8 : 0,
                        width: panelWidth,
                        child: Builder(
                          builder: (context) => Container(
                            clipBehavior: Clip.antiAlias,
                            decoration: BoxDecoration(
                              borderRadius: overlay
                                  ? BorderRadius.vertical(
                                      top: const Radius.circular(20),
                                      bottom: Radius.circular(phone ? 0 : 20),
                                    )
                                  : null,
                              boxShadow: overlay
                                  ? [
                                      BoxShadow(
                                        color: Theme.of(context).dividerColor,
                                        spreadRadius: 1,
                                      ),
                                      BoxShadow(
                                        color: Colors.black.withValues(
                                          alpha: brightness == Brightness.dark
                                              ? .45
                                              : .12,
                                        ),
                                        offset: const Offset(0, 12),
                                        blurRadius: 40,
                                      ),
                                    ]
                                  : null,
                            ),
                            child: NativeSidePanel(
                              tab: view,
                              open: true,
                              overlay: overlay,
                              width: panelWidth,
                              maxWidth: sidePanelMax(width.toDouble(), false),
                              activity: const {'tasks': 1, 'memory': 1},
                              touch: true,
                              onSelect: (_) {},
                              onResize: (_) {},
                              child: WorkPanel(
                                controller: c,
                                kind: view,
                                onOpen: (_) {},
                                onFile: (_) {},
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          );
          await t.pumpAndSettle();
          expect(t.takeException(), isNull);
          await t.runAsync(() async {
            final img =
                await (key.currentContext!.findRenderObject()
                        as RenderRepaintBoundary)
                    .toImage(pixelRatio: 1);
            final bytes = await img.toByteData(format: ui.ImageByteFormat.png);
            File(
              'build/parity/side-panel-native-$width-$view-${brightness.name}.png',
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
