import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/conversation_composer.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/l10n/app_i18n.dart';
import 'live_test.dart' show FakeGateway, theme;

void main() {
  testWidgets(
    'streaming and IME animation retain theme, focus and composing range',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 900);
      addTearDown(tester.view.reset);
      final gateway = FakeGateway();
      final controller = LiveController(gateway);
      await tester.pumpWidget(MobileApp(theme: theme, controller: controller));
      await tester.pumpAndSettle();
      await controller.open('s');
      gateway.publish('s');
      await tester.pumpAndSettle();
      final editor = find.descendant(
        of: find.byType(ConversationComposer),
        matching: find.byType(EditableText),
      );
      await tester.showKeyboard(editor);
      const value = TextEditingValue(
        text: '正在輸入',
        selection: TextSelection.collapsed(offset: 4),
        composing: TextRange(start: 0, end: 4),
      );
      tester.testTextInput.updateEditingValue(value);
      await tester.pump();
      final before = tester.widget<EditableText>(editor);
      final initialApp = tester.widget<MaterialApp>(find.byType(MaterialApp));
      for (var frame = 0; frame < 40; frame++) {
        tester.view.viewInsets = FakeViewPadding(
          bottom: frame < 20 ? frame * 14 : (39 - frame) * 14,
        );
        gateway.publish(
          's',
          text: 'Streaming $frame\n\n```dart\nfinal frame = $frame;\n```',
        );
        await tester.pump(const Duration(milliseconds: 16));
        final current = tester.widget<EditableText>(editor);
        expect(identical(current.focusNode, before.focusNode), isTrue);
        expect(current.focusNode.hasFocus, isTrue);
        expect(current.controller.value, value);
        expect(tester.testTextInput.isVisible, isTrue);
        expect(
          identical(
            tester.widget<MaterialApp>(find.byType(MaterialApp)).theme,
            initialApp.theme,
          ),
          isTrue,
        );
      }
      AppI18n.instance.setLanguage('zh-TW');
      await tester.pumpAndSettle();
      expect(tester.widget<EditableText>(editor).controller.value, value);
      expect(tester.widget<EditableText>(editor).focusNode.hasFocus, isTrue);
      expect(tester.takeException(), isNull);
      AppI18n.instance.setLanguage('en');
      await tester.pumpWidget(const SizedBox());
      await gateway.stream.close();
    },
  );
}
