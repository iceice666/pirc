import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/settings_dialog.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

void main() {
  final fixture = obj(
    jsonDecode(
      File(
        '../../fixtures/mobile-parity/settings-dialog.json',
      ).readAsStringSync(),
    ),
  );
  for (final width in fixture['widths']) {
    for (final brightness in Brightness.values) {
      testWidgets('settings dialog $width ${brightness.name}', (t) async {
        await t.runAsync(loadParityFonts);
        debugDisableShadows = false;
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size(
          (width as num).toDouble(),
          (fixture['height'] as num).toDouble(),
        );
        addTearDown(t.view.reset);
        final g = FakeGateway(),
            c = LiveController(g)
              ..clientId = fixture['clientId']
              ..nodes = rows(fixture['nodes']);
        g.handler = (method, args) async {
          if (method == 'permissions') return {'notifications': true};
          if (method == 'pushStatus') return {'code': 'off'};
          return switch (args['path']) {
            '/api/assistant/node' => fixture['binding'],
            '/api/assistant/prompts' => fixture['prompts'],
            '/api/memory' => fixture['memory'],
            '/api/push' => {'subscriptions': []},
            _ => {},
          };
        };
        final key = GlobalKey();
        await t.pumpWidget(
          RepaintBoundary(
            key: key,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: theme.build(brightness),
              home: Scaffold(
                body: Builder(
                  builder: (context) => TextButton(
                    style: TextButton.styleFrom(
                      foregroundColor: Colors.transparent,
                      overlayColor: Colors.transparent,
                    ),
                    onPressed: () => showNativeSettings(
                      context,
                      controller: c,
                      initialTab: 'Assistant',
                      onResetLayout: () {},
                      onOpenChat: (_) {},
                      onAppOptions: () {},
                    ),
                    child: const Text('Open'),
                  ),
                ),
              ),
            ),
          ),
        );
        await t.tap(find.text('Open'));
        await t.pumpAndSettle();
        expect(t.takeException(), isNull);
        final frame = t.getRect(find.byKey(const Key('settings-frame')));
        expect(frame.width, (width.toDouble() - 40).clamp(0, 760));
        expect(frame.height, 640);
        expect(frame.top, (fixture['height'] - 640) / 2);
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
            '${dir.path}/settings-dialog-native-$width-${brightness.name}.png',
          ).writeAsBytesSync(bytes!.buffer.asUint8List());
          capture.dispose();
        });
        await t.pumpWidget(const SizedBox());
        c.dispose();
        await g.stream.close();
        debugDisableShadows = true;
      });
    }
  }
}
