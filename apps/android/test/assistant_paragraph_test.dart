import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/assistant_settings.dart';

import 'live_test.dart' show theme;

void main() {
  const content = 'ID: services.pirc.chatPrompt.';
  const code = 'services.pirc.chatPrompt';

  testWidgets('wrapped inline code copies the original paragraph exactly', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 640);
    addTearDown(tester.view.reset);

    var clipboardText = '';
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        clipboardText =
            (call.arguments as Map<Object?, Object?>)['text']! as String;
      }
      return null;
    });
    addTearDown(
      () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
    );

    await tester.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(
          body: MediaQuery(
            data: const MediaQueryData(textScaler: TextScaler.linear(2)),
            child: const Padding(
              padding: EdgeInsets.symmetric(horizontal: 24),
              child: AssistantParagraph(
                content,
                inlineCode: code,
                inlineCodeStart: 4,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final selection = tester
        .state<SelectionAreaState>(find.byType(SelectionArea))
        .selectableRegion;
    selection.selectAll();
    final copyItem = selection.contextMenuButtonItems.singleWhere(
      (item) => item.type == ContextMenuButtonType.copy,
    );
    copyItem.onPressed!.call();
    await tester.pump();
    await tester.idle();

    expect(clipboardText, content);
    expect(clipboardText, isNot(contains('\uFFFC')));
  });
}
