import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/backend_settings.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/paired_devices.dart';

import 'settings_shell.dart' show shell;
import 'live_test.dart' show FakeGateway;

Json providersSnapshot() => {
  'providers': [
    {
      'id': 'local',
      'name': 'Local backend',
      'source': 'ui',
      'api': 'openai-completions',
      'hasApiKey': true,
      'models': [],
    },
  ],
  'oauthProviders': [],
};

Json pairedDevice() => {
  'id': 'phone-one',
  'name': 'Pixel 9',
  'lastUsedAt': DateTime.utc(2026, 10, 14).millisecondsSinceEpoch,
  'expiresAt': DateTime.utc(2026, 11, 14).millisecondsSinceEpoch,
};

Future<void> pumpUpdates(WidgetTester tester, [int count = 5]) async {
  for (var index = 0; index < count; index++) {
    await tester.pump();
  }
}

Future<void> tapKey(WidgetTester tester, String key) async {
  final finder = find.byKey(ValueKey(key));
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder);
  await pumpUpdates(tester);
}

Future<void> settleAndDispose(
  WidgetTester tester,
  LiveController controller,
  FakeGateway gateway,
) async {
  await tester.pumpWidget(const SizedBox());
  controller.dispose();
  await gateway.stream.close();
}

void main() {
  testWidgets('provider 403 approval reloads backends and revoke clears them', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway)
      ..origin = 'https://gateway.example'
      ..clientId = 'phone'
      ..pairingStamp = 'pairing-one';
    var approved = false;
    var beginCalls = 0;
    gateway.handler = (method, args) async {
      if (method == 'managementStatus') {
        return {
          'active': approved,
          if (approved) 'remainingMs': 900000,
          if (approved) 'capabilities': ['providers'],
        };
      }
      if (method == 'managementBegin') {
        beginCalls++;
        return {
          'id': 'provider-request',
          'status': 'pending',
          'expiresAt': 1897190400000,
          'serverNow': 1897190100000,
          'capabilities': args['capabilities'],
        };
      }
      if (method == 'managementOpen') return null;
      if (method == 'managementCheck') {
        return {
          'active': approved,
          'remainingMs': approved ? 900000 : null,
          'capabilities': approved ? ['providers'] : const [],
          'request': {
            'id': 'provider-request',
            'status': approved ? 'approved' : 'pending',
          },
        };
      }
      if (method == 'managementCancel') {
        approved = false;
        return {'active': false};
      }
      if (method == 'request' && args['path'] == '/api/providers') {
        if (!approved) {
          throw PlatformException(
            code: 'HTTP_403',
            message: 'Browser approval is required.',
          );
        }
        return providersSnapshot();
      }
      if (method == 'request' && args['path'] == '/api/models') {
        return {'models': []};
      }
      return <String, dynamic>{};
    };

    await tester.pumpWidget(shell(BackendSettings(controller: controller)));
    await pumpUpdates(tester);
    expect(
      find.byKey(const ValueKey('native-management-access')),
      findsOneWidget,
    );
    expect(find.text('Browser approval is required.'), findsOneWidget);
    await tapKey(tester, 'native-management-begin');
    expect(beginCalls, 1);
    expect(
      gateway.calls.where((call) => call.$1 == 'managementOpen'),
      hasLength(1),
    );

    approved = true;
    await tapKey(tester, 'native-management-check');
    await pumpUpdates(tester, 10);
    expect(find.byKey(const ValueKey('backend-local')), findsOneWidget);
    expect(find.text('Revoke access'), findsOneWidget);

    await tapKey(tester, 'native-management-revoke');
    await pumpUpdates(tester, 10);
    expect(find.byKey(const ValueKey('backend-local')), findsNothing);
    expect(find.text('Browser approval is required.'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('native-management-access')),
      findsOneWidget,
    );
    await settleAndDispose(tester, controller, gateway);
  });

  testWidgets('device 403 approval reloads devices and revoke clears them', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway)
      ..origin = 'https://gateway.example'
      ..clientId = 'phone'
      ..pairingStamp = 'pairing-one';
    var approved = false;
    gateway.handler = (method, args) async {
      if (method == 'managementStatus') {
        return {
          'active': approved,
          if (approved) 'remainingMs': 900000,
          if (approved) 'capabilities': ['devices'],
        };
      }
      if (method == 'managementBegin') {
        return {
          'id': 'device-request',
          'status': 'pending',
          'expiresAt': 1897190400000,
          'serverNow': 1897190100000,
          'capabilities': args['capabilities'],
        };
      }
      if (method == 'managementOpen') return null;
      if (method == 'managementCheck') {
        return {
          'active': approved,
          'remainingMs': approved ? 900000 : null,
          'capabilities': approved ? ['devices'] : const [],
          'request': {
            'id': 'device-request',
            'status': approved ? 'approved' : 'pending',
          },
        };
      }
      if (method == 'managementCancel') {
        approved = false;
        return {'active': false};
      }
      if (method == 'request' && args['path'] == '/api/devices') {
        if (!approved) {
          throw PlatformException(
            code: 'HTTP_403',
            message: 'Browser approval is required.',
          );
        }
        return {
          'devices': [pairedDevice()],
        };
      }
      return <String, dynamic>{};
    };

    await tester.pumpWidget(shell(PairedDevices(controller: controller)));
    await pumpUpdates(tester);
    expect(
      find.byKey(const ValueKey('native-management-access')),
      findsOneWidget,
    );
    expect(find.text('Browser approval is required.'), findsOneWidget);
    await tapKey(tester, 'native-management-begin');

    approved = true;
    await tapKey(tester, 'native-management-check');
    await pumpUpdates(tester, 10);
    expect(
      find.byKey(const ValueKey('paired-device-phone-one')),
      findsOneWidget,
    );

    await tapKey(tester, 'native-management-revoke');
    await pumpUpdates(tester, 10);
    expect(find.byKey(const ValueKey('paired-device-phone-one')), findsNothing);
    expect(find.text('Browser approval is required.'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('native-management-access')),
      findsOneWidget,
    );
    await settleAndDispose(tester, controller, gateway);
  });

  testWidgets('reopening provider settings restores a native access grant', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway)
      ..origin = 'https://gateway.example'
      ..clientId = 'phone'
      ..pairingStamp = 'pairing-one';
    gateway.handler = (method, args) async {
      if (method == 'managementStatus') {
        return {
          'active': true,
          'remainingMs': 900000,
          'expiresAt': 1,
          'capabilities': ['providers'],
        };
      }
      if (method == 'request' && args['path'] == '/api/providers') {
        return providersSnapshot();
      }
      if (method == 'request' && args['path'] == '/api/models') {
        return {'models': []};
      }
      return <String, dynamic>{};
    };

    await tester.pumpWidget(shell(BackendSettings(controller: controller)));
    await pumpUpdates(tester, 10);
    expect(
      find.byKey(const ValueKey('native-management-access')),
      findsOneWidget,
    );
    expect(find.text('Model backends'), findsOneWidget);
    expect(find.text('Revoke access'), findsOneWidget);
    expect(
      gateway.calls.where((call) => call.$1 == 'managementBegin'),
      isEmpty,
    );
    expect(
      gateway.calls.where((call) => call.$1 == 'managementStatus'),
      hasLength(1),
    );
    expect(
      find.textContaining('Management access expires in '),
      findsOneWidget,
    );
    await settleAndDispose(tester, controller, gateway);
  });

  testWidgets('provider data disappears when an active grant expires', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway)
      ..origin = 'https://gateway.example'
      ..clientId = 'phone'
      ..pairingStamp = 'pairing-one';
    var active = true;
    gateway.handler = (method, args) async {
      if (method == 'managementStatus') {
        return {
          'active': active,
          'remainingMs': active ? 1000 : 0,
          'capabilities': active ? ['providers'] : const [],
        };
      }
      if (method == 'managementCheck') {
        active = false;
        return {
          'active': false,
          'request': {'id': 'provider-request', 'status': 'expired'},
        };
      }
      if (method == 'request' && args['path'] == '/api/providers') {
        if (!active) {
          throw PlatformException(
            code: 'HTTP_403',
            message: 'Browser approval is required.',
          );
        }
        return providersSnapshot();
      }
      if (method == 'request' && args['path'] == '/api/models') {
        return {'models': []};
      }
      return <String, dynamic>{};
    };

    await tester.pumpWidget(shell(BackendSettings(controller: controller)));
    await pumpUpdates(tester, 10);
    expect(find.byKey(const ValueKey('backend-local')), findsOneWidget);
    expect(find.text('Revoke access'), findsOneWidget);

    await tapKey(tester, 'native-management-check');
    await pumpUpdates(tester, 10);
    expect(find.byKey(const ValueKey('backend-local')), findsNothing);
    expect(find.text('Browser approval is required.'), findsOneWidget);
    await settleAndDispose(tester, controller, gateway);
  });
}
