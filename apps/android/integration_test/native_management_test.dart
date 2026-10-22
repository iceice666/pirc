// Real Android bridge + isolated trusted proxy + actual browser consent UI.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/native_management_access.dart';
import 'package:pirc_mobile/theme.dart';

// The companion Playwright driver opens the exact consent URL in desktop Chrome.
// Suppress only OS browser launch to keep the Android test Activity foreground.
class _ConsentGateway extends Gateway {
  @override
  Future<dynamic> call(String method, [Json args = const {}]) =>
      method == 'managementOpen'
      ? Future.value(null)
      : super.call(method, args);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'browser-approved native grants manage providers and devices, then revoke',
    (tester) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      final gateway = _ConsentGateway();
      final paired = obj(
        await gateway.call('pair', {
          'link': const String.fromEnvironment('PIRC_PAIR_LINK'),
        }),
      );
      final controller = LiveController(gateway, showing: 'engine')
        ..origin = paired['origin'] as String
        ..clientId = paired['clientId'] as String
        ..pairingStamp = paired['pairingStamp'] as String;
      final theme = await PircTheme.load();
      var approvals = 0, revocations = 0;
      Future<void> until(bool Function() done, String label) async {
        for (var i = 0; i < 400 && !done(); i++) {
          await tester.pump(const Duration(milliseconds: 200));
        }
        expect(done(), isTrue, reason: label);
        expect(tester.takeException(), isNull, reason: label);
      }

      Future<void> forbidden(String path) async {
        try {
          await gateway.request(path);
          fail('Management must be denied: $path');
        } on PlatformException catch (e) {
          expect(e.code, 'HTTP_403');
        }
      }

      Future<void> mount(List<String> capabilities) async {
        await tester.pumpWidget(
          MaterialApp(
            theme: theme.build(Brightness.dark),
            home: Scaffold(
              body: SingleChildScrollView(
                child: NativeManagementAccess(
                  key: ValueKey(capabilities.join(',')),
                  controller: controller,
                  capabilities: capabilities,
                  onApproved: () async {
                    approvals++;
                  },
                  onRevoked: () async {
                    revocations++;
                  },
                ),
              ),
            ),
          ),
        );
        await until(
          () => find
              .byKey(const Key('native-management-begin'))
              .evaluate()
              .isNotEmpty,
          'request approval affordance',
        );
        final begin = find.byKey(const Key('native-management-begin'));
        await tester.ensureVisible(begin);
        await tester.tap(begin);
        await tester.pump();
      }

      try {
        await forbidden('/api/providers');
        await forbidden('/api/devices');
        await mount(['providers', 'devices']);
        await until(
          () => approvals == 1,
          'actual browser approval and native claim',
        );
        final state = obj(await gateway.call('managementStatus'));
        expect(state['active'], true);
        expect(state.toString().contains('pirc_mgmt_'), false);
        final providers = await gateway.request('/api/providers');
        expect(providers['providers'], isNotNull);
        expect(
          (await gateway.request('/api/providers/presets'))['presets'],
          isNotNull,
        );
        final provider =
            'mobile-consent-${DateTime.now().millisecondsSinceEpoch}';
        final input = {
          'api': 'openai-chat',
          'baseUrl': 'http://127.0.0.1:18890/v1',
          'models': [
            {'id': 'consent-model'},
          ],
        };
        await gateway.request(
          '/api/providers',
          method: 'POST',
          body: {'id': provider, ...input},
        );
        await gateway.request(
          '/api/providers/$provider',
          method: 'PUT',
          body: {
            ...input,
            'models': [
              {'id': 'consent-model', 'name': 'Updated native model'},
            ],
          },
        );
        await gateway.request('/api/providers/$provider', method: 'DELETE');
        final created = await gateway.request(
          '/api/devices',
          method: 'POST',
          body: {'name': 'Consent disposable device'},
        );
        final deviceId = obj(created['device'])['id'];
        expect(deviceId, isA<String>());
        expect(
          rows(
            (await gateway.request('/api/devices'))['devices'],
          ).any((d) => d['id'] == deviceId),
          true,
        );
        await gateway.request(
          '/api/devices/${enc('$deviceId')}',
          method: 'DELETE',
        );
        expect(
          rows(
            (await gateway.request('/api/devices'))['devices'],
          ).any((d) => d['id'] == deviceId),
          false,
        );
        final revoke = find.byKey(const Key('native-management-revoke'));
        await tester.ensureVisible(revoke);
        await tester.tap(revoke);
        await until(() => revocations == 1, 'native visible revoke action');
        await forbidden('/api/providers');
        await forbidden('/api/devices');
        debugPrint(
          'NATIVE_MANAGEMENT:both-scopes-crud-and-native-revoke=passed',
        );

        await mount(['providers']);
        await until(() => approvals == 2, 'providers-only browser approval');
        await gateway.request('/api/providers');
        await forbidden('/api/devices');
        final state2 = obj(await gateway.call('managementStatus'));
        expect(state2['capabilities'], ['providers']);
        await gateway.call('managementCancel');
        debugPrint(
          'NATIVE_MANAGEMENT:providers-only-does-not-grant-devices=passed',
        );

        await tester.pumpWidget(const SizedBox());
        await gateway.call('managementBegin', {
          'capabilities': ['devices'],
        });
        var active = false;
        for (var i = 0; i < 100 && !active; i++) {
          active = obj(await gateway.call('managementCheck'))['active'] == true;
          await tester.pump(const Duration(milliseconds: 200));
        }
        expect(active, true);
        await gateway.request('/api/devices');
        var revoked = false;
        for (var i = 0; i < 100 && !revoked; i++) {
          final data = obj(await gateway.call('managementCheck'));
          revoked =
              obj(data['request'])['status'] == 'revoked' &&
              data['active'] == false;
          await tester.pump(const Duration(milliseconds: 200));
        }
        expect(
          revoked,
          true,
          reason: 'Companion browser must click Revoke access',
        );
        await forbidden('/api/devices');
        debugPrint(
          'NATIVE_MANAGEMENT:browser-revoke-closes-native-access=passed',
        );
      } finally {
        await tester.pumpWidget(const SizedBox());
        await gateway.call('managementCancel');
        controller.dispose();
      }
    },
  );
}
