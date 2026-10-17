import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/gateway.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'real Android reports no distributor and keeps push/device API boundaries',
    (tester) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      expect(const bool.fromEnvironment('PIRC_DOCUMENTS'), isTrue);
      const link = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(link, isNotEmpty, reason: 'Missing private pairing link.');

      final gateway = Gateway();
      var paired = false;
      try {
        await gateway.call('pair', {'link': link});
        paired = true;

        // Read the device's real permission and UnifiedPush state without
        // opening any Android permission or distributor UI.
        final permissions = obj(await gateway.call('permissions'));
        for (final key in [
          'notifications',
          'overlay',
          'notificationSettings',
          'onboardingComplete',
        ]) {
          expect(permissions[key], isA<bool>(), reason: 'permissions.$key');
        }
        expect(permissions['action'], isA<String>());

        final before = obj(await gateway.call('pushStatus'));
        expect(before['distributors'], isA<List>());
        expect(before['code'], isA<String>());
        expect(before['state'], isA<String>());
        final distributors = before['distributors'] as List;

        // This is an environment precondition. Do not invoke the picker or
        // alter the AVD if a distributor has been installed.
        expect(
          distributors,
          isEmpty,
          reason:
              'The no-distributor bridge case requires an AVD with no installed UnifiedPush distributor.',
        );

        final webPush = await gateway.request('/api/push');
        expect(webPush, contains('publicKey'));
        expect(webPush['subscriptions'], isA<List>());
        expect(
          webPush['subscriptions'],
          isEmpty,
          reason:
              'The isolated helper gateway starts with no push subscriptions.',
        );

        PlatformException? failure;
        try {
          await gateway.call('pushEnable');
        } on PlatformException catch (error) {
          failure = error;
        }
        expect(
          failure,
          isNotNull,
          reason: 'pushEnable must reject this device.',
        );
        expect(failure!.code, 'NO_DISTRIBUTOR');
        expect(
          failure.message,
          contains('No UnifiedPush distributor is installed'),
        );

        final after = obj(await gateway.call('pushStatus'));
        expect(after['distributors'], isEmpty);
        expect(after['code'], before['code']);
        expect(after['subscriptionId'], before['subscriptionId']);

        // The paired device bearer grants app operations, not account/device
        // administration endpoints.
        for (final path in [
          '/api/devices',
          '/api/providers',
          '/api/provider-auth',
        ]) {
          await expectLater(
            gateway.request(path),
            throwsA(
              isA<PlatformException>()
                  .having((error) => error.code, 'code', 'HTTP_403')
                  .having(
                    (error) => obj(error.details)['code'],
                    'details code',
                    'forbidden',
                  ),
            ),
            reason: 'Device bearer must remain forbidden from $path.',
          );
        }
      } finally {
        if (paired) await gateway.call('unpair');
        await tester.pumpWidget(const SizedBox.shrink());
      }
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
