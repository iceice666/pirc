// Requires the isolated real_gateway.ts --push-race mode, a paired device,
// and the installed official ntfy UnifiedPush distributor. The helper only
// delays the real Gateway response; registration and cleanup remain real.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/notification_settings.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'real push registration compensates after disable and recovers from an invalid VAPID key',
    (tester) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      expect(const bool.fromEnvironment('PIRC_PUSH_RACE'), isTrue);
      const link = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(link, isNotEmpty, reason: 'Missing private pairing link.');

      final gateway = Gateway();
      final controller = LiveController(gateway);
      final theme = (await PircTheme.load()).build(Brightness.light);
      var paired = false;
      var mounted = false;

      Future<void> until(
        bool Function() ready,
        String reason, {
        int attempts = 300,
      }) async {
        for (var i = 0; i < attempts && !ready(); i++) {
          await tester.pump(const Duration(milliseconds: 200));
        }
        expect(ready(), isTrue, reason: reason);
        expect(tester.takeException(), isNull);
      }

      Future<void> tapButton(
        String label, {
        bool opensExternalUi = false,
      }) async {
        final button = find.text(label);
        expect(button, findsOneWidget, reason: 'Expected "$label" action.');
        await tester.ensureVisible(button);
        await tester.pumpAndSettle();
        await tester.tap(button);
        if (opensExternalUi) {
          // The host driver handles Android permission/distributor UI and
          // returns to this task after observing the marker.
          await tester.pump(const Duration(milliseconds: 100));
        } else {
          await tester.pumpAndSettle();
        }
      }

      Future<Json> waitForPushCode(String code, {int attempts = 300}) async {
        Json status = {};
        for (var i = 0; i < attempts; i++) {
          status = obj(await gateway.call('pushStatus'));
          if (status['code'] == code) return status;
          await tester.pump(const Duration(milliseconds: 200));
        }
        fail('Timed out waiting for push status $code; last status: $status');
      }

      Future<Json> waitForGate(
        bool Function(Json status) ready,
        String reason, {
        int attempts = 300,
      }) async {
        Json status = {};
        for (var i = 0; i < attempts; i++) {
          status = await gateway.request('/api/parity-push/status');
          if (ready(status)) return status;
          await tester.pump(const Duration(milliseconds: 200));
        }
        fail('Timed out waiting for $reason; last status: $status');
      }

      Future<List<Json>> waitForSubscriptions(
        bool Function(List<Json>) ready,
        String reason, {
        int attempts = 300,
      }) async {
        List<Json> subscriptions = [];
        for (var i = 0; i < attempts; i++) {
          subscriptions = rows(
            (await gateway.request('/api/push'))['subscriptions'],
          );
          if (ready(subscriptions)) return subscriptions;
          await tester.pump(const Duration(milliseconds: 200));
        }
        fail('Timed out waiting for $reason; subscriptions: $subscriptions');
      }

      Future<void> postRaceControl(String path) async {
        await gateway.request(
          '/api/parity-push/$path',
          method: 'POST',
          body: <String, dynamic>{},
        );
      }

      try {
        await gateway.call('completeOnboarding');
        await gateway.call('pair', {'link': link});
        paired = true;
        await controller.boot();
        expect(controller.origin, isNotNull);
        expect(controller.booting, isFalse);

        // Remove any previous test registration before measuring this run.
        await gateway.call('pushDisable');
        final initialPush = obj(await gateway.call('pushStatus'));
        expect(initialPush['code'], 'off');
        expect(initialPush['distributors'], contains('io.heckel.ntfy'));
        expect(
          rows((await gateway.request('/api/push'))['subscriptions']),
          isEmpty,
          reason: 'The isolated real Gateway must begin without subscriptions.',
        );

        await tester.pumpWidget(
          MaterialApp(
            theme: theme,
            home: Scaffold(
              body: SafeArea(
                child: SingleChildScrollView(
                  child: NativeNotificationSettings(controller: controller),
                ),
              ),
            ),
          ),
        );
        mounted = true;

        await until(
          () =>
              find.text('Allow notifications').evaluate().isNotEmpty ||
              find.text('Turn on').evaluate().isNotEmpty,
          'notification permission or Turn on action',
        );
        if (find.text('Allow notifications').evaluate().isNotEmpty) {
          debugPrint('PUSH_EXTERNAL:notification-permission-next');
          await tapButton('Allow notifications', opensExternalUi: true);
          await until(
            () => find.text('Turn on').evaluate().isNotEmpty,
            'Android notification permission granted',
          );
        }
        final permissions = obj(await gateway.call('permissions'));
        expect(permissions['notifications'], isTrue);
        debugPrint('PUSH_RACES:permission-ready');

        await postRaceControl('arm');
        expect(
          (await gateway.request('/api/parity-push/status'))['armed'],
          isTrue,
        );
        debugPrint('PUSH_RACES:response-gate-armed');
        debugPrint('PUSH_EXTERNAL:register-next');
        await tapButton('Turn on', opensExternalUi: true);

        final held = await waitForGate(
          (status) => status['held'] == true && status['forwarded'] == true,
          'the real subscription POST to be forwarded and held',
        );
        expect(held['armed'], isFalse);
        final serverBeforeDisable = rows(
          (await gateway.request('/api/push'))['subscriptions'],
        );
        expect(serverBeforeDisable, hasLength(1));
        expect(serverBeforeDisable.single['kind'], 'unifiedpush');
        expect(serverBeforeDisable.single['id'], isNotEmpty);
        final connecting = await waitForPushCode('connecting');
        expect(connecting['subscriptionId'], isNull);
        await until(
          () =>
              find
                  .textContaining('Registering this phone')
                  .evaluate()
                  .isNotEmpty &&
              find.text('Turn off').evaluate().isNotEmpty,
          'Turn off action while the Gateway response is held',
        );
        debugPrint('PUSH_RACES:real-subscription-forwarded-response-held');

        await tapButton('Turn off');
        await until(
          () =>
              find
                  .text('This phone does not get notifications.')
                  .evaluate()
                  .isNotEmpty &&
              find.text('Turn on').evaluate().isNotEmpty,
          'local notification state returns to Off',
        );
        expect((await gateway.call('pushStatus'))['code'], 'off');
        expect(
          rows((await gateway.request('/api/push'))['subscriptions']),
          hasLength(1),
          reason:
              'The server accepted the subscription before releasing its response.',
        );

        await postRaceControl('release');
        await waitForGate(
          (status) => status['held'] == false && status['forwarded'] == true,
          'the held Gateway response to be released',
        );
        final compensated = await waitForSubscriptions(
          (subscriptions) => subscriptions.isEmpty,
          'the late endpoint callback compensation to delete the subscription',
        );
        expect(compensated, isEmpty);
        final afterCompensation = obj(await gateway.call('pushStatus'));
        expect(afterCompensation['code'], 'off');
        expect(afterCompensation['subscriptionId'], isNull);
        debugPrint('PUSH_RACES:late-registration-compensated-server-empty');

        await postRaceControl('invalid-key');
        expect(
          (await gateway.request('/api/push'))['publicKey'],
          'invalid-vapid-fixture',
        );
        debugPrint('PUSH_EXTERNAL:register-next');
        await tapButton('Turn on', opensExternalUi: true);
        final failed = await waitForPushCode('failed');
        expect(failed['state'], isA<String>());
        expect((failed['state'] as String).trim(), isNotEmpty);
        await until(
          () =>
              find.text('Turn on').evaluate().isNotEmpty &&
              find.textContaining('Registering this phone').evaluate().isEmpty,
          'invalid VAPID registration to settle in Failed instead of Connecting',
        );
        expect(
          rows((await gateway.request('/api/push'))['subscriptions']),
          isEmpty,
          reason: 'An invalid VAPID key must not create a server subscription.',
        );
        debugPrint('PUSH_RACES:invalid-vapid-key-failed-not-connecting');

        await postRaceControl('valid-key');
        expect(
          (await gateway.request('/api/push'))['publicKey'],
          isNot('invalid-vapid-fixture'),
        );
        debugPrint('PUSH_EXTERNAL:register-next');
        await tapButton('Turn on', opensExternalUi: true);
        final retrySubscriptions = await waitForSubscriptions(
          (subscriptions) => subscriptions.length == 1,
          'the real subscription after restoring the valid VAPID key',
        );
        final registered = await waitForPushCode('on');
        expect(registered['subscriptionId'], retrySubscriptions.single['id']);
        expect(retrySubscriptions.single['kind'], 'unifiedpush');
        await until(
          () =>
              find.text('This phone gets notifications.').evaluate().isNotEmpty,
          'valid-key retry to complete registration',
        );
        debugPrint('PUSH_RACES:valid-key-retry-registered');

        await tapButton('Turn off');
        await until(
          () => find
              .text('This phone does not get notifications.')
              .evaluate()
              .isNotEmpty,
          'final local disable',
        );
        expect(
          await waitForSubscriptions(
            (subscriptions) => subscriptions.isEmpty,
            'final server-side unsubscribe',
          ),
          isEmpty,
        );
        expect((await gateway.call('pushStatus'))['code'], 'off');
        debugPrint('PUSH_RACES:disabled-server-empty');
      } finally {
        if (mounted) {
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pump();
        }
        controller.dispose();
        if (paired) {
          // Always release a held response before unpairing so the production
          // callback can perform its normal same-account compensation.
          for (final path in ['release', 'valid-key']) {
            try {
              await postRaceControl(path);
            } catch (_) {}
          }
          try {
            await gateway.call('pushDisable');
          } catch (_) {}
          try {
            await waitForSubscriptions(
              (subscriptions) => subscriptions.isEmpty,
              'cleanup of the real Gateway subscription',
              attempts: 120,
            );
          } catch (_) {}
          try {
            await gateway.call('unpair');
          } catch (_) {}
        }
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
