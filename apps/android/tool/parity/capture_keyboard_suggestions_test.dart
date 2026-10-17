import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/keyboard_suggestions.dart';
import 'capture_fonts.dart';

void main() {
  testWidgets('capture keyboard suggestion sizes and themes', (t) async {
    await t.runAsync(loadParityFonts);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    final directory = Directory('build/parity/keyboard-suggestions')
      ..createSync(recursive: true);
    final results = <String, dynamic>{};
    for (final width in [320.0, 390.0, 768.0]) {
      for (final scale in [1.0, 2.0]) {
        for (final brightness in Brightness.values) {
          t.view.physicalSize = Size(width, 844);
          t.view.viewInsets = const FakeViewPadding(bottom: 300);
          final boundary = GlobalKey();
          final controller = TextEditingController(text: 'Asia');
          final focus = FocusNode();
          await t.pumpWidget(
            RepaintBoundary(
              key: boundary,
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: ThemeData(brightness: brightness, fontFamily: 'Arial'),
                builder: (context, child) => MediaQuery(
                  data: MediaQuery.of(
                    context,
                  ).copyWith(textScaler: TextScaler.linear(scale)),
                  child: child!,
                ),
                home: Scaffold(
                  body: Padding(
                    padding: const EdgeInsets.all(24),
                    child: KeyboardSuggestions(
                      controller: controller,
                      focusNode: focus,
                      options: const [
                        'Asia/Taipei',
                        'Asia/Tokyo',
                        'Asia/Kolkata',
                      ],
                      builder: (context, active) =>
                          TextField(controller: controller, focusNode: focus),
                    ),
                  ),
                ),
              ),
            ),
          );
          focus.requestFocus();
          await t.pumpAndSettle();
          final strip = t.getRect(
            find.byKey(const ValueKey('keyboard-suggestions')),
          );
          final chip = t.getRect(
            find.byKey(const ValueKey('keyboard-suggestion-Asia/Taipei')),
          );
          final label = t.getRect(find.text('Asia/Taipei'));
          final paragraph = t.renderObject<RenderParagraph>(
            find.text('Asia/Taipei'),
          );
          final natural = TextPainter(
            text: paragraph.text,
            textDirection: TextDirection.ltr,
            textScaler: paragraph.textScaler,
          )..layout();
          expect(natural.height, lessThanOrEqualTo(label.height));
          final id = '${width.toInt()}-${scale.toInt()}-${brightness.name}';
          results[id] = {
            'strip': [strip.left, strip.top, strip.width, strip.height],
            'chip': [chip.left, chip.top, chip.width, chip.height],
            'label': [label.left, label.top, label.width, label.height],
            'naturalTextHeight': natural.height,
            'textClippedVertically': natural.height > label.height,
            'labelVerticallyContained':
                label.top >= chip.top && label.bottom <= chip.bottom,
          };
          natural.dispose();
          await t.runAsync(() async {
            final frame =
                await (boundary.currentContext!.findRenderObject()
                        as RenderRepaintBoundary)
                    .toImage();
            final data = await frame.toByteData(format: ui.ImageByteFormat.png);
            File(
              '${directory.path}/$id.png',
            ).writeAsBytesSync(data!.buffer.asUint8List());
            frame.dispose();
          });
          expect(t.takeException(), isNull);
          await t.pumpWidget(const SizedBox());
          controller.dispose();
          focus.dispose();
        }
      }
    }
    File(
      '${directory.path}/geometry.json',
    ).writeAsStringSync(const JsonEncoder.withIndent('  ').convert(results));
  });
}
