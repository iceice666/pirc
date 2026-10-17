import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/permissions.dart';
import 'package:pirc_mobile/live/settings.dart';
import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

void main() {
  for (final width in [390, 768]) {
    for (final brightness in Brightness.values) {
      for (final view in ['options', 'permissions', 'notifications']) {
        testWidgets('native options $width ${brightness.name} $view', (
          t,
        ) async {
          await t.runAsync(() async {
            await loadParityFonts();
            await (FontLoader('Parity CJK')..addFont(
                  File(
                    '/System/Library/Fonts/STHeiti Light.ttc',
                  ).readAsBytes().then(ByteData.sublistView),
                ))
                .load();
          });
          t.view.devicePixelRatio = 1;
          t.view.physicalSize = Size(width.toDouble(), 900);
          addTearDown(t.view.reset);
          final g = FakeGateway();
          g.handler = (method, args) async => switch (method) {
            'preferences' => {'q': true, 'appearance': 'system'},
            'permissions' => {'notifications': false, 'overlay': false},
            'pushStatus' => {'state': '尚未註冊', 'distributors': []},
            _ => {},
          };
          final c = LiveController(g)
            ..origin = 'https://pirc.example.test'
            ..clientId = 'Android test device'
            ..preferences = {'appearance': 'system'};
          final key = GlobalKey(), base = theme.build(brightness);
          await t.pumpWidget(
            RepaintBoundary(
              key: key,
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: base.copyWith(
                  appBarTheme: base.appBarTheme.copyWith(
                    titleTextStyle: base.appBarTheme.titleTextStyle?.copyWith(
                      fontFamily: 'Parity CJK',
                    ),
                  ),
                  textTheme: base.textTheme.apply(fontFamily: 'Parity CJK'),
                ),
                home: switch (view) {
                  'options' => ManagementPage(
                    kind: 'settings',
                    controller: c,
                    theme: theme,
                  ),
                  'permissions' => PermissionPage(
                    gateway: g,
                    onComplete: () async {},
                  ),
                  _ => Scaffold(
                    appBar: AppBar(title: const Text('通知設定')),
                    body: PushSettings(controller: c),
                  ),
                },
              ),
            ),
          );
          await t.pumpAndSettle();
          expect(t.takeException(), isNull);
          await t.runAsync(() async {
            final shot =
                await (key.currentContext!.findRenderObject()
                        as RenderRepaintBoundary)
                    .toImage();
            final bytes = await shot.toByteData(format: ui.ImageByteFormat.png);
            final file = File(
              'build/parity/native-options-$width-$view-${brightness.name}.png',
            );
            await file.parent.create(recursive: true);
            await file.writeAsBytes(bytes!.buffer.asUint8List());
            shot.dispose();
          });
          await t.pumpWidget(const SizedBox());
          c.dispose();
          await g.stream.close();
        });
      }
    }
  }
}
