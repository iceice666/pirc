// Native Google Code Scanner acceptance. The host driver waits until the GMS
// scanner activity is foregrounded, then presses Android Back to cancel it.
// Run only on an Android device with Google Play services and the barcode_ui
// module available; this test deliberately does not synthesize a QR result.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/theme.dart';

class _ObservedGateway extends Gateway {
  final scans = <Future<dynamic>>[];
  var suppressedPairCalls = 0;

  @override
  Future<dynamic> call(String method, [Json args = const {}]) {
    if (method == 'pair') {
      // A real decoded QR should never turn this scanner smoke test into an
      // account-pairing operation. Keep the decoded value out of logs.
      suppressedPairCalls++;
      return Future<dynamic>.error(
        PlatformException(code: 'SCANNER_TEST_PAIR_SUPPRESSED'),
      );
    }
    final result = super.call(method, args);
    if (method == 'scan') scans.add(result);
    return result;
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'native scanner cancels and can be started again safely',
    (tester) async {
      expect(
        const bool.fromEnvironment('PIRC_SCANNER_ACCEPTANCE'),
        isTrue,
        reason:
            'Run through tool/parity/run_android_scanner_acceptance.py on Android.',
      );

      final gateway = _ObservedGateway();
      final controller = LiveController(gateway);
      final appTheme = await PircTheme.load();
      await tester.pumpWidget(
        MaterialApp(
          theme: appTheme.build(Brightness.light),
          home: PairingScreen(controller: controller),
        ),
      );
      await tester.pumpAndSettle();

      const launchWait = Duration(seconds: 50);
      for (var attempt = 1; attempt <= 2; attempt++) {
        final previousCount = gateway.scans.length;
        // The host driver observes this marker and sends Back only after the
        // Google Play services scanner activity is confirmed foregrounded.
        // No QR contents or pairing links are ever printed.
        // ignore: avoid_print
        print('SCANNER_ACCEPTANCE:launch:$attempt');
        final scanButton = find.text('掃描 QR code');
        await tester.ensureVisible(scanButton);
        await tester.tap(scanButton);
        await tester.pump();

        for (var i = 0; i < 30 && gateway.scans.length == previousCount; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(
          gateway.scans.length,
          previousCount + 1,
          reason: 'The PairingScreen should call the real native scan method.',
        );

        Object? failure;
        dynamic value;
        try {
          value = await gateway.scans[previousCount].timeout(launchWait);
        } on PlatformException catch (error) {
          failure = error;
        }
        await tester.pumpAndSettle();

        expect(find.byType(PairingScreen), findsOneWidget);
        expect(tester.takeException(), isNull);
        if (failure is PlatformException) {
          const safeMessages = <String>{
            '掃描元件正在下載，請稍後再試，也可以貼上配對連結。',
            '掃描器需要更新 Google Play 服務。也可以貼上配對連結。',
            '暫時無法開啟掃描器，請重試或貼上配對連結。',
            '掃描器準備逾時，請重試或貼上配對連結。',
          };
          expect(
            failure.code,
            isIn({
              'SCAN_DOWNLOADING',
              'SCAN_UNSUPPORTED',
              'SCAN_TIMEOUT',
              'SCAN',
            }),
            reason: 'Unexpected native scanner failure code.',
          );
          expect(find.textContaining('java.'), findsNothing);
          expect(find.textContaining('null object'), findsNothing);
          expect(
            safeMessages.any(
              (message) => find.text(message).evaluate().isNotEmpty,
            ),
            isTrue,
            reason:
                'Native scanner failures should expose a safe retry message.',
          );
          // ignore: avoid_print
          print('SCANNER_ACCEPTANCE:result:$attempt:error:${failure.code}');
        } else if (value == null) {
          expect(gateway.suppressedPairCalls, 0);
          // ignore: avoid_print
          print('SCANNER_ACCEPTANCE:result:$attempt:cancelled');
        } else {
          // Do not print or pair a real QR value. This branch is observable but
          // does not claim a virtual-camera success fixture.
          expect(gateway.suppressedPairCalls, attempt);
          // ignore: avoid_print
          print('SCANNER_ACCEPTANCE:result:$attempt:decoded-suppressed');
        }

        if (attempt == 1) {
          // Clear a failure snackbar before proving that a second launch works.
          await tester.pump(const Duration(seconds: 6));
          await tester.pumpAndSettle();
        }
      }

      expect(gateway.scans, hasLength(2));
      expect(find.byType(PairingScreen), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
