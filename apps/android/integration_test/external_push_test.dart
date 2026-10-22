// Requires the real Gateway helper and official ntfy distributor/server.
// The host driver handles actual Android permission, Home and notification taps.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/notification_settings.dart';
import 'package:pirc_mobile/live/settings_dialog.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'real external distributor registers, decrypts and opens a conversation',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      expect(const bool.fromEnvironment('PIRC_EXTERNAL_PUSH'), isTrue);
      const link = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(link, isNotEmpty);
      final gateway = Gateway();
      final controller = LiveController(gateway, showing: 'engine');
      final theme = await PircTheme.load();
      String? sessionId;
      Future<void> until(
        bool Function() check,
        String reason, {
        int attempts = 300,
        bool platformWait = false,
      }) async {
        for (var i = 0; i < attempts && !check(); i++) {
          if (platformWait) {
            await Future<void>.delayed(const Duration(milliseconds: 200));
          } else {
            await t.pump(const Duration(milliseconds: 200));
          }
        }
        expect(check(), isTrue, reason: reason);
        expect(t.takeException(), isNull);
      }

      Future<void> tap(Finder finder) async {
        expect(finder, findsOneWidget);
        await t.ensureVisible(finder);
        await t.pumpAndSettle();
        await t.tap(finder);
        await t.pumpAndSettle();
      }

      try {
        await gateway.call('completeOnboarding');
        await controller.pair(link);
        expect(controller.origin, isNotNull);
        await t.pumpWidget(MobileApp(theme: theme, controller: controller));
        await until(
          () =>
              !controller.booting &&
              !controller.initializing &&
              controller.workspaces.isNotEmpty,
          'paired actual app must finish boot',
        );
        final native = obj(await gateway.call('pushStatus'));
        expect(native['distributors'], contains('io.heckel.ntfy'));
        expect(native['code'], 'off');
        await tap(find.text('Settings'));
        await until(
          () => find.byType(NativeNotificationSettings).evaluate().isNotEmpty,
          'native notification settings',
        );
        if (find.text('Allow notifications').evaluate().isNotEmpty) {
          debugPrint('PUSH_EXTERNAL:notification-permission-next');
          await tap(find.text('Allow notifications'));
        }
        await until(
          () => find.text('Turn on').evaluate().isNotEmpty,
          'notification permission must be granted',
        );
        debugPrint('PUSH_EXTERNAL:register-next');
        await tap(find.text('Turn on'));
        for (
          var i = 0;
          i < 300 &&
              find.text('This phone gets notifications.').evaluate().isEmpty;
          i++
        ) {
          if (i % 10 == 0) {
            final diagnostic = obj(await gateway.call('pushStatus'));
            debugPrint(
              'PUSH_EXTERNAL:registration-state:${diagnostic['code']}',
            );
            expect(
              diagnostic['code'],
              isNot('failed'),
              reason: '${diagnostic['state']}',
            );
          }
          await t.pump(const Duration(milliseconds: 200));
        }
        expect(
          find.text('This phone gets notifications.'),
          findsOneWidget,
          reason:
              'real distributor registration and Gateway subscribe must complete',
        );
        final registered = obj(await gateway.call('pushStatus'));
        expect(registered['code'], 'on');
        final subscriptions = rows(
          (await gateway.request('/api/push'))['subscriptions'],
        );
        expect(subscriptions, hasLength(1));
        expect(subscriptions.single['kind'], 'unifiedpush');
        expect(subscriptions.single['id'], registered['subscriptionId']);
        expect(
          subscriptions.single['host'],
          const String.fromEnvironment(
            'PIRC_PUSH_RELAY_HOST',
            defaultValue: '127.0.0.1:18920',
          ),
        );
        debugPrint('PUSH_EXTERNAL:registered-real-endpoint');
        await tap(find.byTooltip('Close'));
        await until(
          () => find.byType(NativeSettingsDialog).evaluate().isEmpty,
          'settings close',
        );
        final workspace = controller.workspaces.firstWhere(
          (w) => w['kind'] == 'chat',
        );
        await controller.create('${workspace['id']}');
        sessionId = controller.sessionId;
        expect(sessionId, isNotNull);
        await gateway.request(
          sessionPath(sessionId!),
          method: 'PATCH',
          body: {'name': 'External push acceptance'},
        );
        await controller.refreshList();
        final selected =
            controller.selectedModel ?? controller.models.firstOrNull;
        expect(selected, isNotNull);
        final modelReceipt = await gateway.command(sessionId, {
          'type': 'set_model',
          'provider': selected!['provider'],
          'modelId': selected['id'],
        });
        expect(modelReceipt['status'], 'accepted');
        // Stop the session SSE watcher, so it cannot produce the local question
        // notification instead of the external encrypted push under test.
        await gateway.call('unwatch');
        debugPrint('PUSH_EXTERNAL:home-next');
        await until(
          () => !controller.active,
          'actual Android Home must background the app',
          platformWait: true,
        );
        final receipt = await gateway.command(sessionId, {
          'type': 'prompt',
          'message': '/parity-question',
        });
        expect(receipt['status'], 'accepted');
        debugPrint('PUSH_EXTERNAL:notification-tap-next');
        await until(
          () =>
              controller.active &&
              controller.sessionId == sessionId &&
              controller.questions.isNotEmpty,
          'actual encrypted notification tap must resume, route and refresh the target conversation',
          attempts: 450,
          platformWait: true,
        );
        await until(
          () =>
              find.text('Choose the native test target').evaluate().isNotEmpty,
          'pending question must be visible in the routed app',
        );
        final activity = rows(await gateway.call('activity'));
        expect(
          activity.any(
            (item) =>
                item['title'] ==
                    'External push acceptance is waiting for you' &&
                item['sessionId'] == sessionId,
          ),
          isTrue,
          reason:
              'The encrypted remote PushNote title must appear in production notification history.',
        );
        final delivered = rows(
          (await gateway.request('/api/push'))['subscriptions'],
        );
        expect(delivered.single['lastSuccessAt'], isA<num>());
        expect(delivered.single['lastSuccessAt'], greaterThan(0));
        expect(controller.error, isNull);
        debugPrint('PUSH_EXTERNAL:encrypted-delivery-and-conversation-opened');
        // The registered phone must also stop both local and Gateway registration.
        await gateway.call('pushDisable');
        expect(obj(await gateway.call('pushStatus'))['code'], 'off');
        expect(
          rows((await gateway.request('/api/push'))['subscriptions']),
          isEmpty,
        );
        debugPrint('PUSH_EXTERNAL:disabled-and-server-unsubscribed');
      } finally {
        try {
          await controller.unpair();
        } catch (_) {}
        await t.pumpWidget(const SizedBox());
        await t.pump();
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
