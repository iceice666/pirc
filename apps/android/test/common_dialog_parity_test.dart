import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/common.dart';
import 'package:pirc_mobile/live/web_controls.dart';

import 'live_test.dart' show theme;

void main() {
  for (final width in [390.0, 1024.0]) {
    for (final brightness in Brightness.values) {
      testWidgets(
        'confirmation keeps shared design and safe dismissal $width $brightness',
        (tester) async {
          tester.view.devicePixelRatio = 1;
          tester.view.physicalSize = Size(width, 900);
          addTearDown(tester.view.reset);
          bool? result;
          await tester.pumpWidget(
            MaterialApp(
              theme: theme.build(brightness),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(
                  context,
                ).copyWith(textScaler: const TextScaler.linear(2)),
                child: child!,
              ),
              home: Builder(
                builder: (context) => Scaffold(
                  body: TextButton(
                    onPressed: () async => result = await confirm(
                      context,
                      'Continue after checking?',
                      'Check whether the previous message arrived. Continuing unlocks sending and does not resend that operation.',
                      action: 'Continue',
                      cancelLabel: 'Cancel',
                    ),
                    child: const Text('Open confirmation'),
                  ),
                ),
              ),
            ),
          );
          await tester.tap(find.text('Open confirmation'));
          await tester.pumpAndSettle();
          expect(find.byType(WebDialog), findsOneWidget);
          expect(find.byType(AlertDialog), findsNothing);
          expect(find.text('取消'), findsNothing);
          await tester.tap(find.text('Cancel'));
          await tester.pumpAndSettle();
          expect(result, isFalse);
          await tester.tap(find.text('Open confirmation'));
          await tester.pumpAndSettle();
          await tester.tap(find.byTooltip('Close'));
          await tester.pumpAndSettle();
          expect(result, isFalse);
          await tester.tap(find.text('Open confirmation'));
          await tester.pumpAndSettle();
          await tester.tap(find.text('Continue'));
          await tester.pumpAndSettle();
          expect(result, isTrue);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
        },
      );
    }
  }
  testWidgets(
    'input keeps entered text only on confirmation and releases field',
    (tester) async {
      String? result;
      await tester.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.dark),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () async => result = await input(
                  context,
                  'Node 上的資料夾路徑',
                  value: '/original',
                ),
                child: const Text('Open input'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open input'));
      await tester.pumpAndSettle();
      expect(find.byType(WebDialog), findsOneWidget);
      expect(find.byType(AlertDialog), findsNothing);
      await tester.enterText(
        find.byType(TextField),
        '/workspace with spaces/新目錄',
      );
      await tester.tap(find.text('確認'));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(milliseconds: 500));
      expect(result, '/workspace with spaces/新目錄');
      await tester.tap(find.text('Open input'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '/original',
      );
      await tester.enterText(find.byType(TextField), 'discard');
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(milliseconds: 500));
      expect(result, isNull);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
