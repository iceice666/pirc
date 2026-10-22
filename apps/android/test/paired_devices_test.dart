import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/paired_devices.dart';
import 'live_test.dart' show FakeGateway, theme;
import '../tool/parity/capture_fonts.dart' show loadParityFonts;

void main() {
  late FakeGateway gateway;
  late LiveController controller;
  String? clipboard;
  setUp(() {
    gateway = FakeGateway();
    controller = LiveController(gateway, showing: 'engine')
      ..origin = 'https://gateway.test'
      ..clientId = 'client-one';
    clipboard = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.setData') {
            clipboard = (call.arguments as Map)['text'] as String;
          }
          return null;
        });
  });
  tearDown(() async {
    controller.dispose();
    await gateway.stream.close();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });
  Future<void> show(
    WidgetTester t, {
    double width = 768,
    double scale = 1,
    bool disabled = false,
  }) async {
    await t.runAsync(loadParityFonts);
    t.view.physicalSize = Size(width, 1100);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await t.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: Scaffold(
          body: SingleChildScrollView(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: PairedDevices(
                controller: controller,
                disabled: disabled,
                clock: () => DateTime.utc(2026, 10, 11),
              ),
            ),
          ),
        ),
      ),
    );
    await t.pumpAndSettle();
  }

  Future<void> finish(WidgetTester t) async => t.pumpWidget(const SizedBox());
  Json device(String id, String name) => {
    'id': id,
    'name': name,
    'lastUsedAt': DateTime.utc(2026, 10, 11).millisecondsSinceEpoch,
    'expiresAt': DateTime.utc(2026, 11, 1).millisecondsSinceEpoch,
  };

  testWidgets(
    '403 keeps source pair form, empty state and exact error; POST stays denied',
    (t) async {
      gateway.handler = (method, args) async {
        if (args['path'] == '/api/devices') {
          throw PlatformException(
            code: 'HTTP_403',
            message: 'Device tokens cannot reach this route',
          );
        }
        return {};
      };
      await show(t, width: 390, scale: 2);
      expect(
        find.text('Device tokens cannot reach this route'),
        findsOneWidget,
      );
      expect(find.text('Device name'), findsOneWidget);
      expect(find.text('No phones paired.'), findsOneWidget);
      expect(find.text('Retry settings'), findsNothing);
      expect(
        t
            .widget<TextButton>(find.widgetWithText(TextButton, 'Pair device'))
            .onPressed,
        isNull,
      );
      await t.enterText(
        find.byKey(const ValueKey('device-name')),
        '  Pixel 9  ',
      );
      await t.ensureVisible(find.text('Pair device'));
      await t.pump();
      await t.tap(find.text('Pair device'));
      await t.pumpAndSettle();
      final calls = gateway.calls
          .where((c) => c.$2['path'] == '/api/devices')
          .toList();
      expect(calls.map((c) => c.$2['method']), ['GET', 'POST']);
      expect(calls.last.$2['body'], {'name': 'Pixel 9'});
      expect(
        find.text('Device tokens cannot reach this route'),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('device-pairing-card')), findsNothing);
      expect(t.takeException(), isNull);
      await finish(t);
    },
  );

  testWidgets(
    'pairing reply appears only once, copy/open/done preserve source behavior',
    (t) async {
      var paired = false;
      gateway.handler = (method, args) async {
        if (method == 'openPairLink') return {};
        if (args['path'] == '/api/devices') {
          if (args['method'] == 'POST') {
            paired = true;
            return {
              'device': device('phone-one', 'Pixel 9'),
              'token': 'synthetic-one-time-token',
            };
          }
          return {
            'devices': paired ? [device('phone-one', 'Pixel 9')] : [],
          };
        }
        return {};
      };
      await show(t);
      await t.enterText(find.byKey(const ValueKey('device-name')), 'Pixel 9');
      await t.pump();
      await t.tap(find.text('Pair device'));
      await t.pumpAndSettle();
      final uri = devicePairingUri(
        'https://gateway.test',
        'synthetic-one-time-token',
      );
      expect(find.byKey(const ValueKey('device-pairing-card')), findsOneWidget);
      expect(find.text('Scan with the pirc app'), findsOneWidget);
      expect(
        t
            .widget<TextField>(find.byKey(const ValueKey('device-name')))
            .controller!
            .text,
        '',
      );
      await t.tap(find.text('Copy link'));
      await t.pumpAndSettle();
      expect(clipboard, uri);
      expect(find.text('Copied'), findsOneWidget);
      await t.tap(find.text('Open in app'));
      await t.pumpAndSettle();
      expect(gateway.calls.where((c) => c.$1 == 'openPairLink').single.$2, {
        'url': uri,
      });
      await t.tap(find.text('Done'));
      await t.pumpAndSettle();
      expect(find.byKey(const ValueKey('device-pairing-card')), findsNothing);
      expect(
        find.byKey(const ValueKey('paired-device-phone-one')),
        findsOneWidget,
      );
      await t.pumpWidget(const SizedBox());
      await show(t);
      expect(find.byKey(const ValueKey('device-pairing-card')), findsNothing);
      expect(
        gateway.calls.where((c) => c.$2['method'] == 'POST'),
        hasLength(1),
      );
      expect(t.takeException(), isNull);
      await finish(t);
    },
  );

  testWidgets(
    'revoke DELETE encodes id and clears matching one-time pairing card',
    (t) async {
      var present = false;
      gateway.handler = (method, args) async {
        if (args['method'] == 'POST') {
          present = true;
          return {
            'device': device('id/with space', 'Phone'),
            'token': 'synthetic-revoke-token',
          };
        }
        if (args['method'] == 'DELETE') {
          present = false;
          return {};
        }
        return {
          'devices': present ? [device('id/with space', 'Phone')] : [],
        };
      };
      await show(t);
      await t.enterText(find.byKey(const ValueKey('device-name')), 'Phone');
      await t.pump();
      await t.tap(find.text('Pair device'));
      await t.pumpAndSettle();
      await t.ensureVisible(find.text('Revoke'));
      await t.tap(find.text('Revoke'));
      await t.pumpAndSettle();
      expect(
        gateway.calls
            .where((c) => c.$2['method'] == 'DELETE')
            .single
            .$2['path'],
        '/api/devices/id%2Fwith%20space',
      );
      expect(find.byKey(const ValueKey('device-pairing-card')), findsNothing);
      expect(find.text('No phones paired.'), findsOneWidget);
      expect(t.takeException(), isNull);
      await finish(t);
    },
  );

  testWidgets(
    'busy guard prevents duplicate pair requests and stale account reply is ignored',
    (t) async {
      final reply = Completer<Json>();
      gateway.handler = (method, args) async {
        if (args['method'] == 'POST') return reply.future;
        return {'devices': []};
      };
      await show(t);
      await t.enterText(find.byKey(const ValueKey('device-name')), 'Phone');
      await t.pump();
      await t.tap(find.text('Pair device'));
      await t.pump();
      expect(
        t.widget<TextField>(find.byKey(const ValueKey('device-name'))).enabled,
        isFalse,
      );
      expect(
        t
            .widget<TextButton>(find.widgetWithText(TextButton, 'Pair device'))
            .onPressed,
        isNull,
      );
      controller.clientId = 'client-two';
      controller.notifyListeners();
      await t.pumpAndSettle();
      reply.complete({
        'device': device('old-phone', 'Phone'),
        'token': 'synthetic-stale-token',
      });
      await t.pumpAndSettle();
      expect(find.byKey(const ValueKey('device-pairing-card')), findsNothing);
      expect(
        gateway.calls.where((c) => c.$2['method'] == 'POST'),
        hasLength(1),
      );
      expect(t.takeException(), isNull);
      await finish(t);
    },
  );

  testWidgets(
    're-pairing the same gateway clears the one-time credential and ignores stale GET',
    (t) async {
      final staleList = Completer<Json>();
      var gets = 0;
      gateway.handler = (method, args) async {
        if (args['path'] == '/api/devices' && args['method'] == 'POST') {
          return {
            'device': device('old-phone', 'Old phone'),
            'token': 'synthetic-old-account-token',
          };
        }
        if (args['path'] == '/api/devices') {
          gets++;
          if (gets == 2) return staleList.future;
          return {'devices': []};
        }
        return {};
      };
      await show(t);
      await t.enterText(find.byKey(const ValueKey('device-name')), 'Old phone');
      await t.pump();
      await t.tap(find.text('Pair device'));
      await t.pump();
      expect(find.byKey(const ValueKey('device-pairing-card')), findsOneWidget);
      expect(gets, 2);

      // The origin/client ID remain unchanged when this installation is
      // re-paired to the same gateway with a different native credential.
      controller.pairingStamp = 'new-credential-stamp';
      controller.notifyListeners();
      await t.pumpAndSettle();
      expect(gets, 3);
      expect(find.byKey(const ValueKey('device-pairing-card')), findsNothing);
      expect(find.text('No phones paired.'), findsOneWidget);
      staleList.complete({
        'devices': [device('old-phone', 'Old phone')],
      });
      await t.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('paired-device-old-phone')),
        findsNothing,
      );
      expect(find.byKey(const ValueKey('device-pairing-card')), findsNothing);
      expect(t.takeException(), isNull);
      await finish(t);
    },
  );

  testWidgets(
    'disabled demo makes no management requests and name uses 100 UTF16 units',
    (t) async {
      gateway.handler = (method, args) async => {'devices': []};
      await show(t, disabled: true);
      expect(find.text('Pairing is unavailable in demo mode.'), findsOneWidget);
      expect(find.byKey(const ValueKey('device-name')), findsNothing);
      expect(gateway.calls, isEmpty);
      await finish(t);
      await show(t);
      await t.enterText(find.byKey(const ValueKey('device-name')), '😀' * 51);
      await t.pump();
      final value = t
          .widget<TextField>(find.byKey(const ValueKey('device-name')))
          .controller!
          .text;
      expect(value.length, 100);
      expect(value, '😀' * 50);
      expect(t.takeException(), isNull);
      await finish(t);
    },
  );
}
