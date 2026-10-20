import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/memory_settings.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

class _FixtureGateway extends FakeGateway {
  _FixtureGateway(this.fixture);
  final Json fixture;
  @override
  dynamic normal(String method, Json args) {
    if (method == 'request') {
      if (args['path'] == '/api/memory') return fixture['memory'] ?? {};
      for (final kind in ['nodes', 'workspaces', 'sessions']) {
        if (args['path'] == '/api/$kind') return {kind: fixture[kind]};
      }
    }
    return super.normal(method, args);
  }
}

void main() {
  for (final kind in ['navigation', 'workspace', 'memory']) {
    for (final brightness in Brightness.values) {
      testWidgets('shared $kind fixture ${brightness.name}', (t) async {
        final fixture = obj(
          jsonDecode(
            File('../../fixtures/mobile-parity/$kind.json').readAsStringSync(),
          ),
        );
        await t.runAsync(loadParityFonts);
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size(
          (fixture['width'] as num).toDouble(),
          (fixture['height'] as num).toDouble(),
        );
        t.platformDispatcher.platformBrightnessTestValue = brightness;
        addTearDown(t.view.reset);
        addTearDown(t.platformDispatcher.clearPlatformBrightnessTestValue);
        final g = _FixtureGateway(fixture);
        final c = LiveController(g);
        final key = GlobalKey();
        await t.pumpWidget(
          RepaintBoundary(
            key: key,
            child: kind == 'memory'
                ? MaterialApp(
                    debugShowCheckedModeBanner: false,
                    theme: theme.build(brightness),
                    home: Scaffold(
                      body: SingleChildScrollView(
                        padding: const EdgeInsets.all(20),
                        child: MemorySettings(controller: c),
                      ),
                    ),
                  )
                : MobileApp(theme: theme, controller: c),
          ),
        );
        await t.pumpAndSettle();
        if (kind == 'workspace') {
          await t.tap(find.text('Project'));
          await t.pumpAndSettle();
        }
        expect(t.takeException(), isNull);
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
            '${dir.path}/$kind-native-${brightness.name}.png',
          ).writeAsBytesSync(bytes!.buffer.asUint8List());
          capture.dispose();
        });
        await t.pumpWidget(const SizedBox());
        if (kind == 'memory') c.dispose();
        await g.stream.close();
      });
    }
  }
}
