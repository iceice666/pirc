import 'dart:ui' show PointerDeviceKind;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/assistant_settings.dart';
import 'package:pirc_mobile/live/common.dart';
import 'live_test.dart' show theme;

void main() {
  for (final brightness in Brightness.values) {
    testWidgets(
      'settings button pointer keyboard and disabled states $brightness',
      (t) async {
        final mouse = await t.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: Offset.zero);
        for (final kind in ['ghost', 'filled', 'primary']) {
          var presses = 0;
          Widget host({bool enabled = true}) => MaterialApp(
            theme: theme.build(brightness),
            home: Scaffold(
              body: Center(
                child: AssistantButton(
                  'Action',
                  filled: kind == 'filled',
                  primary: kind == 'primary',
                  onPressed: enabled ? () => presses++ : null,
                ),
              ),
            ),
          );
          await t.pumpWidget(host());
          await t.pumpAndSettle();
          final button = find.byType(TextButton);
          final colors = palette(t.element(button));
          final material = find.descendant(
            of: button,
            matching: find.byType(Material),
          );
          Color? background() => t.widget<Material>(material).color;
          final normal = kind == 'ghost'
              ? Colors.transparent
              : colors[kind == 'primary' ? 'accent.default' : 'web.bg-hover'];
          final hover =
              colors[kind == 'primary'
                  ? 'web.accent-hover'
                  : kind == 'filled'
                  ? 'web.bg-hover-strong'
                  : 'web.bg-hover'];
          expect(background(), normal);
          await mouse.moveTo(t.getCenter(button));
          await t.pumpAndSettle();
          expect(background(), hover);
          await mouse.moveTo(Offset.zero);
          await t.pumpAndSettle();
          expect(background(), normal);
          await t.tap(button);
          await t.pump();
          final ring = find.byKey(
            const ValueKey('assistant-button-Action-focus-ring'),
          );
          expect(ring, findsNothing);
          expect(presses, 1);
          await t.sendKeyEvent(LogicalKeyboardKey.tab);
          await t.pump();
          expect(t.getRect(ring), t.getRect(button).inflate(4));
          await t.sendKeyEvent(LogicalKeyboardKey.enter);
          await t.pump();
          expect(presses, 2);
          await mouse.moveTo(t.getCenter(button));
          await mouse.down(t.getCenter(button));
          await mouse.up();
          await t.pump();
          expect(ring, findsNothing);
          expect(presses, 3);
          await t.pumpWidget(host(enabled: false));
          await t.pumpAndSettle();
          expect(ring, findsNothing);
          final opacity = find
              .descendant(
                of: find.byType(AssistantButton),
                matching: find.byType(Opacity),
              )
              .first;
          expect(t.widget<Opacity>(opacity).opacity, .45);
          await mouse.moveTo(t.getCenter(button));
          await t.pumpAndSettle();
          expect(background(), normal);
          await t.tap(button);
          expect(presses, 3);
          await mouse.moveTo(Offset.zero);
          await t.pumpWidget(const SizedBox());
        }
        await mouse.removePointer();
        expect(t.takeException(), isNull);
      },
    );
  }
}
