import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/keyboard_suggestions.dart';

void main() {
  testWidgets(
    'suggestions follow keyboard geometry, filter, fill and disappear on blur',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(390, 844);
      addTearDown(t.view.reset);
      final controller = TextEditingController(text: 'Asia');
      final focus = FocusNode();
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: KeyboardSuggestions(
              controller: controller,
              focusNode: focus,
              options: const ['Asia/Taipei', 'Asia/Tokyo', 'UTC'],
              builder: (context, visible) =>
                  TextField(controller: controller, focusNode: focus),
            ),
          ),
        ),
      );
      focus.requestFocus();
      await t.pumpAndSettle();
      final strip = find.byKey(const ValueKey('keyboard-suggestions'));
      expect(strip, findsNothing);
      t.view.viewInsets = const FakeViewPadding(bottom: 300);
      await t.pumpAndSettle();
      expect(strip, findsOneWidget);
      expect(t.getRect(strip), const Rect.fromLTWH(0, 496, 390, 48));
      expect(find.text('UTC'), findsNothing);
      await t.tap(
        find.byKey(const ValueKey('keyboard-suggestion-Asia/Taipei')),
      );
      await t.pumpAndSettle();
      expect(controller.text, 'Asia/Taipei');
      expect(controller.selection.extentOffset, 11);
      expect(focus.hasFocus, isTrue);
      expect(find.text('Asia/Tokyo'), findsNothing);
      t.view.viewInsets = const FakeViewPadding(bottom: 250);
      await t.pumpAndSettle();
      expect(t.getRect(strip).bottom, 594);
      controller.text = 'Europe/Paris';
      await t.pumpAndSettle();
      expect(strip, findsNothing);
      controller.text = 'Asia';
      await t.pumpAndSettle();
      await t.drag(strip, const Offset(-250, 0));
      await t.pumpAndSettle();
      await t.tap(find.byKey(const ValueKey('keyboard-suggestion-Asia/Tokyo')));
      await t.pumpAndSettle();
      expect(controller.text, 'Asia/Tokyo');
      expect(focus.hasFocus, isTrue);
      focus.unfocus();
      await t.pumpAndSettle();
      expect(strip, findsNothing);
      focus.requestFocus();
      await t.pumpAndSettle();
      t.view.viewInsets = const FakeViewPadding();
      await t.pumpAndSettle();
      expect(strip, findsNothing);
      await t.pumpWidget(const SizedBox());
      controller.dispose();
      focus.dispose();
      expect(t.takeException(), isNull);
    },
  );
}
