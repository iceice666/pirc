// Requires an emulator started with:
//   -camera-back imagefile:<path-to-build/parity/scanner-qr-fixture.png>
// Unlike the cancellation acceptance, this test must receive the QR payload.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/theme.dart';

const _fixtureUri =
    'pirc://pair?url=https%3A%2F%2Ffixture.invalid&token=scanner-fixture-not-a-token';

class _ScannerFixtureGateway extends Gateway {
  final scans = <Future<dynamic>>[];
  final interceptedPairLinks = <String>[];

  @override
  Future<dynamic> call(String method, [Json args = const {}]) {
    if (method == 'pair') {
      interceptedPairLinks.add('${args['link']}');
      // Keep the decoded fixture away from GatewayBridge and the backend.
      return Future<dynamic>.error(
        PlatformException(code: 'SCANNER_FIXTURE_PAIR_INTERCEPTED'),
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
    'native camera decodes the exact synthetic QR payload',
    (tester) async {
      expect(
        const bool.fromEnvironment('PIRC_SCANNER_DECODE'),
        isTrue,
        reason:
            'Start the emulator with the generated imagefile, then set PIRC_SCANNER_DECODE=true.',
      );

      final gateway = _ScannerFixtureGateway();
      final controller = LiveController(gateway, showing: 'engine');
      final appTheme = await PircTheme.load();
      await tester.pumpWidget(
        MaterialApp(
          theme: appTheme.build(Brightness.light),
          home: PairingScreen(controller: controller),
        ),
      );
      await tester.pumpAndSettle();

      // ignore: avoid_print
      print('SCANNER_DECODE:waiting-for-native-result');
      final scanButton = find.text('掃描 QR code');
      await tester.ensureVisible(scanButton);
      await tester.tap(scanButton);
      await tester.pump();
      for (var i = 0; i < 30 && gateway.scans.isEmpty; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(gateway.scans, hasLength(1));

      dynamic rawValue;
      var bundled = false;
      try {
        rawValue = await gateway.scans.single.timeout(
          const Duration(seconds: 60),
        );
      } on PlatformException catch (error) {
        bundled = true;
        debugPrint(
          'SCANNER_DECODE:gms-unavailable:${error.code};bundled-camera-next',
        );
        await tester.pumpAndSettle();
        final fallback = find.text('使用內建相機掃描');
        expect(fallback, findsOneWidget);
        await tester.ensureVisible(fallback);
        await tester.tap(fallback);
        await tester.pump();
        for (var i = 0; i < 600 && gateway.interceptedPairLinks.isEmpty; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(
          gateway.interceptedPairLinks,
          hasLength(1),
          reason:
              'Bundled camera must actually decode; a module error is not a pass.',
        );
        rawValue = gateway.interceptedPairLinks.single;
      }

      expect(rawValue, _fixtureUri);
      await tester.pumpAndSettle();
      expect(gateway.interceptedPairLinks, [_fixtureUri]);
      expect(find.byType(PairingScreen), findsOneWidget);
      expect(tester.takeException(), isNull);
      // ignore: avoid_print
      print(
        'SCANNER_DECODE:exact-payload-match:${bundled ? 'bundled' : 'gms'}',
      );

      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
