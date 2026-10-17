import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/assistant_settings.dart';
import 'package:pirc_mobile/live/common.dart';
import '../../test/live_test.dart' show theme;
import 'capture_fonts.dart';

void main() {
  testWidgets('settings button reference states', (t) async {
    await t.runAsync(loadParityFonts);
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(390, 140);
    addTearDown(t.view.reset);
    final results = <String, dynamic>{};
    final dir = Directory('build/parity/settings-buttons')
      ..createSync(recursive: true);
    for (final brightness in Brightness.values) {
      for (final variant in ['ghost', 'filled', 'primary']) {
        for (final state in ['normal', 'hover', 'keyboard', 'disabled']) {
          final key = GlobalKey();
          await t.pumpWidget(
            RepaintBoundary(
              key: key,
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: theme.build(brightness),
                home: Builder(
                  builder: (context) => Material(
                    color: palette(context)['web.bg'],
                    child: Align(
                      alignment: Alignment.topLeft,
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: AssistantButton(
                          'Save',
                          filled: variant == 'filled',
                          primary: variant == 'primary',
                          onPressed: state == 'disabled' ? null : () {},
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
          final mouse = await t.createGesture(kind: ui.PointerDeviceKind.mouse);
          await mouse.addPointer(location: Offset.zero);
          final button = find.byType(TextButton);
          if (state == 'hover') await mouse.moveTo(t.getCenter(button));
          if (state == 'keyboard') await t.sendKeyEvent(LogicalKeyboardKey.tab);
          await t.pumpAndSettle();
          expect(t.takeException(), isNull);
          final r = t.getRect(button);
          final id = '$variant-$state-${brightness.name}';
          results[id] = {
            'x': r.left,
            'y': r.top,
            'width': r.width,
            'height': r.height,
            'focusVisible': find
                .byKey(const ValueKey('assistant-button-Save-focus-ring'))
                .evaluate()
                .isNotEmpty,
          };
          await t.runAsync(() async {
            final capture =
                await (key.currentContext!.findRenderObject()
                        as RenderRepaintBoundary)
                    .toImage(pixelRatio: 1);
            final bytes = await capture.toByteData(
              format: ui.ImageByteFormat.png,
            );
            File(
              '${dir.path}/native-$id.png',
            ).writeAsBytesSync(bytes!.buffer.asUint8List());
            capture.dispose();
          });
          await mouse.removePointer();
          await t.pumpWidget(const SizedBox());
          await t.pump();
        }
      }
    }
    File(
      '${dir.path}/native.json',
    ).writeAsStringSync(const JsonEncoder.withIndent('  ').convert(results));
  });
}
