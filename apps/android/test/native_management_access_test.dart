import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/native_management_access.dart';

import 'live_test.dart' show FakeGateway, theme;

Future<void> mount(
  WidgetTester tester,
  LiveController controller, {
  required DateTime Function() clock,
  required Future<void> Function() onApproved,
  required Future<void> Function() onRevoked,
  Json? initialStatus,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: theme.build(Brightness.light),
      home: Scaffold(
        body: SingleChildScrollView(
          child: NativeManagementAccess(
            key: const ValueKey('native-management-access'),
            controller: controller,
            capabilities: const ['providers'],
            onApproved: onApproved,
            onRevoked: onRevoked,
            clock: clock,
            initialStatus: initialStatus,
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
}

void main() {
  testWidgets('requests, polls, cancels, approves, and revokes access', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway)
      ..origin = 'https://gateway.example'
      ..clientId = 'phone'
      ..pairingStamp = 'pairing-one';
    var now = DateTime.utc(2026, 10, 14, 8);
    var approved = false, approvedCallbacks = 0, revokedCallbacks = 0;
    var beginCalls = 0, checkCalls = 0, cancelCalls = 0;
    gateway.handler = (method, args) async {
      switch (method) {
        case 'managementStatus':
          return {'active': false};
        case 'managementBegin':
          beginCalls++;
          return {
            'id': 'request-$beginCalls',
            'status': 'pending',
            'expiresAt': now.millisecondsSinceEpoch + 30000,
            'serverNow': now.millisecondsSinceEpoch,
            'deviceName': 'Pixel 9',
            'capabilities': args['capabilities'],
            'verificationUrl': 'https://verification.example/private-code',
          };
        case 'managementOpen':
          return null;
        case 'managementCheck':
          checkCalls++;
          if (!approved) {
            return {
              'active': false,
              'request': {
                'id': 'request-$beginCalls',
                'status': 'pending',
                'expiresAt': now.millisecondsSinceEpoch + 30000,
                'serverNow': now.millisecondsSinceEpoch,
                'deviceName': 'Pixel 9',
                'capabilities': ['providers'],
              },
            };
          }
          return {
            'active': true,
            'expiresAt': now.millisecondsSinceEpoch + 900000,
            'remainingMs': 900000,
            'capabilities': ['providers'],
            'request': {'id': 'request-$beginCalls', 'status': 'approved'},
          };
        case 'managementCancel':
          cancelCalls++;
          return {'active': false};
        default:
          return null;
      }
    };

    await mount(
      tester,
      controller,
      clock: () => now,
      onApproved: () async {
        approvedCallbacks++;
      },
      onRevoked: () async {
        revokedCallbacks++;
      },
    );
    expect(
      find.byKey(const ValueKey('native-management-access')),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('native-management-begin')));
    await tester.pump();
    await tester.pump();
    expect(beginCalls, 1);
    expect(
      gateway.calls.where((call) => call.$1 == 'managementOpen').single.$2,
      isEmpty,
    );
    expect(
      gateway.calls
          .where((call) => call.$1 == 'managementBegin')
          .single
          .$2['capabilities'],
      ['providers'],
    );
    expect(find.textContaining('private-code'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('native-management-cancel')));
    await tester.pump();
    await tester.pump();
    expect(cancelCalls, 1);
    expect(find.text('Request browser approval'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('native-management-begin')));
    await tester.pump();
    await tester.pump();
    approved = true;
    now = now.add(const Duration(seconds: 2));
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    expect(checkCalls, greaterThanOrEqualTo(1));
    expect(approvedCallbacks, 1);
    expect(find.text('Model backends'), findsOneWidget);
    expect(find.text('Revoke access'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('native-management-revoke')));
    await tester.pump();
    await tester.pump();
    expect(cancelCalls, 2);
    expect(revokedCallbacks, 1);
    expect(find.text('Request browser approval'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await gateway.stream.close();
  });

  testWidgets('pending approval expires using the native server clock', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway)
      ..origin = 'https://gateway.example'
      ..clientId = 'phone'
      ..pairingStamp = 'pairing-one';
    var now = DateTime.utc(2026, 10, 14, 8);
    gateway.handler = (method, args) async {
      if (method == 'managementStatus') return {'active': false};
      if (method == 'managementBegin') {
        return {
          'id': 'request-one',
          'status': 'pending',
          'expiresAt': now.millisecondsSinceEpoch + 3000,
          'serverNow': now.millisecondsSinceEpoch,
          'capabilities': ['providers'],
        };
      }
      if (method == 'managementOpen') return null;
      if (method == 'managementCheck') {
        return {
          'active': false,
          'request': {'id': 'request-one', 'status': 'expired'},
        };
      }
      return null;
    };

    await mount(
      tester,
      controller,
      clock: () => now,
      onApproved: () async {},
      onRevoked: () async {},
    );
    await tester.tap(find.byKey(const ValueKey('native-management-begin')));
    await tester.pump();
    await tester.pump();
    now = now.add(const Duration(seconds: 4));
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(
      find.text('The approval request expired or management access ended.'),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('native-management-retry')),
      findsOneWidget,
    );

    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await gateway.stream.close();
  });

  testWidgets(
    'active expiry uses native remaining time despite phone clock skew',
    (tester) async {
      final gateway = FakeGateway();
      final controller = LiveController(gateway)
        ..origin = 'https://gateway.example'
        ..clientId = 'phone'
        ..pairingStamp = 'pairing-one';
      final now = DateTime.utc(2026, 10, 14, 8);
      gateway.handler = (method, args) async => {'active': false};
      await mount(
        tester,
        controller,
        clock: () => now,
        onApproved: () async {},
        onRevoked: () async {},
        initialStatus: {
          'active': true,
          'expiresAt': 1,
          'remainingMs': 900000,
          'capabilities': ['providers'],
        },
      );
      expect(find.text('Management access expires in 15:00.'), findsOneWidget);
      expect(find.text('Model backends'), findsOneWidget);
      expect(find.text('Revoke access'), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets('an active grant for another page shows the missing scope', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway)
      ..origin = 'https://gateway.example'
      ..clientId = 'phone'
      ..pairingStamp = 'pairing-one';
    var approvedCallbacks = 0;
    gateway.handler = (method, args) async => {'active': false};
    await mount(
      tester,
      controller,
      clock: () => DateTime.utc(2026, 10, 14, 8),
      onApproved: () async {
        approvedCallbacks++;
      },
      onRevoked: () async {},
      initialStatus: {
        'active': true,
        'remainingMs': 900000,
        'capabilities': ['devices'],
      },
    );
    expect(
      find.text(
        'Current access covers paired devices. This page requires model backends.',
      ),
      findsOneWidget,
    );
    expect(find.text('Paired devices'), findsOneWidget);
    expect(find.text('Request additional access'), findsOneWidget);
    expect(approvedCallbacks, 0);

    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await gateway.stream.close();
  });

  testWidgets('account change stops the pending poll for the old pairing', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway)
      ..origin = 'https://gateway.example'
      ..clientId = 'phone'
      ..pairingStamp = 'pairing-one';
    var now = DateTime.utc(2026, 10, 14, 8);
    var checks = 0;
    gateway.handler = (method, args) async {
      if (method == 'managementStatus') return {'active': false};
      if (method == 'managementBegin') {
        return {
          'id': 'request-one',
          'status': 'pending',
          'expiresAt': now.millisecondsSinceEpoch + 30000,
          'serverNow': now.millisecondsSinceEpoch,
          'capabilities': ['providers'],
        };
      }
      if (method == 'managementOpen') return null;
      if (method == 'managementCheck') {
        checks++;
        return {
          'active': false,
          'request': {
            'id': 'request-one',
            'status': 'pending',
            'expiresAt': now.millisecondsSinceEpoch + 30000,
            'serverNow': now.millisecondsSinceEpoch,
            'capabilities': ['providers'],
          },
        };
      }
      return null;
    };

    await mount(
      tester,
      controller,
      clock: () => now,
      onApproved: () async {},
      onRevoked: () async {},
    );
    await tester.tap(find.byKey(const ValueKey('native-management-begin')));
    await tester.pump();
    await tester.pump();
    controller.pairingStamp = 'pairing-two';
    controller.notifyListeners();
    await tester.pump(const Duration(seconds: 5));
    expect(checks, 0);
    expect(
      gateway.calls.where((call) => call.$1 == 'managementBegin'),
      hasLength(1),
    );

    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await gateway.stream.close();
  });
}
