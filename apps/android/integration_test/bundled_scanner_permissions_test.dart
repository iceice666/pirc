import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/pairing_scanner.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'denied Android camera permission permits safe return to paste',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_SCANNER_DENIAL'), isTrue);
      final theme = await PircTheme.load();
      final returned = <String?>[];
      await t.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: theme.build(Brightness.dark),
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () async {
                  returned.add(
                    await Navigator.of(context).push<String>(
                      MaterialPageRoute(
                        builder: (_) => PairingScannerPage(gateway: Gateway()),
                      ),
                    ),
                  );
                },
                child: const Text('Open camera permission test'),
              ),
            ),
          ),
        ),
      );
      await t.pumpAndSettle();
      await t.tap(find.text('Open camera permission test'));
      await t.pump();
      debugPrint('SCANNER_DENIAL:waiting-for-real-os-denial');
      for (
        var i = 0;
        i < 600 && find.text('需要相機權限才能掃描').evaluate().isEmpty;
        i++
      ) {
        await t.pump(const Duration(milliseconds: 100));
      }
      expect(find.text('需要相機權限才能掃描'), findsOneWidget);
      expect(find.text('重試').hitTestable(), findsOneWidget);
      expect(find.text('前往系統設定').hitTestable(), findsOneWidget);
      expect(t.takeException(), isNull);
      await t.tap(find.text('返回貼上配對連結'));
      await t.pumpAndSettle();
      expect(returned, [null]);
      expect(find.byType(PairingScannerPage), findsNothing);
      expect(t.takeException(), isNull);
      debugPrint('SCANNER_DENIAL:styled-error-and-safe-return');
      await t.pumpWidget(const SizedBox());
      await t.pump();
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
