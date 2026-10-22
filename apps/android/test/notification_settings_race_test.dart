import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/notification_settings.dart';
import 'package:pirc_mobile/live/settings_dialog.dart';

import 'live_test.dart' show FakeGateway, theme;

const _origin = 'https://gateway.example';
const _clientId = 'phone';
const _notHandled = _NotHandled();

class _NotHandled {
  const _NotHandled();
}

void _installHandler(
  FakeGateway gateway,
  FutureOr<dynamic> Function(String method, Json args)? override,
) {
  gateway.handler = (method, args) async {
    if (override != null) {
      final value = await override(method, args);
      if (!identical(value, _notHandled)) return value;
    }
    if (method == 'boot') {
      return {
        'origin': _origin,
        'clientId': _clientId,
        'pairingStamp': 'stamp-one',
      };
    }
    if (method == 'preferences') return <String, dynamic>{};
    if (method == 'permissions') return {'notifications': true};
    if (method == 'pushStatus') return {'code': 'off'};
    if (method == 'request') {
      return switch ('${args['path']}') {
        '/api/push' => {'subscriptions': <Json>[]},
        '/api/sessions' => {'sessions': <Json>[]},
        '/api/workspaces' => {'workspaces': <Json>[]},
        '/api/nodes' => {'nodes': <Json>[]},
        '/api/memory' => {'user': <Json>[]},
        _ => <String, dynamic>{},
      };
    }
    return <String, dynamic>{};
  };
}

Widget _host(LiveController controller) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: Scaffold(
    body: SingleChildScrollView(
      child: NativeNotificationSettings(
        key: const Key('notification-settings'),
        controller: controller,
      ),
    ),
  ),
);

void _pairingChanged(FakeGateway gateway, String stamp) {
  gateway.stream.add({
    'type': 'pairingChanged',
    'data': {'origin': _origin, 'clientId': _clientId, 'pairingStamp': stamp},
  });
}

Future<void> _removeWidget(
  WidgetTester tester,
  Iterable<(LiveController, FakeGateway)> pairs,
) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump();
  for (final (controller, gateway) in pairs) {
    controller.dispose();
    await gateway.stream.close();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'same-origin pairing stamp change invalidates a pending notification read',
    (tester) async {
      final gateway = FakeGateway();
      final staleRead = Completer<dynamic>();
      var pushReads = 0;
      _installHandler(gateway, (method, args) async {
        if (method == 'pushStatus') {
          pushReads++;
          if (pushReads == 1) return staleRead.future;
          return {'code': 'on', 'subscriptionId': 'fresh-device'};
        }
        if (method == 'request' && args['path'] == '/api/push') {
          return {
            'subscriptions': [
              {
                'id': 'fresh-device',
                'kind': 'unifiedpush',
                'name': 'Phone',
                'host': 'push.example',
              },
            ],
          };
        }
        return _notHandled;
      });
      final controller = LiveController(gateway, showing: 'engine');
      await controller.boot();

      await tester.pumpWidget(_host(controller));
      await tester.pump();
      expect(pushReads, 1);

      _pairingChanged(gateway, 'stamp-two');
      await tester.pumpAndSettle();
      expect(pushReads, 2);
      expect(find.text('This phone gets notifications.'), findsOneWidget);
      expect(find.text('Phone (this phone)'), findsOneWidget);

      staleRead.complete({'code': 'off'});
      await tester.pumpAndSettle();
      expect(find.text('This phone gets notifications.'), findsOneWidget);
      expect(find.text('This phone does not get notifications.'), findsNothing);
      expect(pushReads, 2);

      await _removeWidget(tester, [(controller, gateway)]);
    },
  );

  testWidgets(
    'same-origin pairing change suppresses a late action error and reload',
    (tester) async {
      final gateway = FakeGateway();
      final pendingEnable = Completer<dynamic>();
      var pushReads = 0;
      _installHandler(gateway, (method, args) async {
        if (method == 'pushStatus') {
          pushReads++;
          return {'code': 'off'};
        }
        if (method == 'pushEnable') return pendingEnable.future;
        return _notHandled;
      });
      final controller = LiveController(gateway, showing: 'engine');
      await controller.boot();

      await tester.pumpWidget(_host(controller));
      await tester.pumpAndSettle();
      expect(pushReads, 1);

      await tester.tap(find.text('Turn on'));
      await tester.pump();
      _pairingChanged(gateway, 'stamp-two');
      await tester.pumpAndSettle();
      expect(pushReads, 2);
      expect(
        find.text('This phone does not get notifications.'),
        findsOneWidget,
      );

      pendingEnable.completeError(StateError('stale account failure'));
      await tester.pumpAndSettle();
      expect(find.textContaining('stale account failure'), findsNothing);
      expect(pushReads, 2);

      await _removeWidget(tester, [(controller, gateway)]);
    },
  );

  testWidgets(
    'controller replacement detaches the old listener and ignores its read',
    (tester) async {
      final oldGateway = FakeGateway();
      final newGateway = FakeGateway();
      final oldRead = Completer<dynamic>();
      var oldPushReads = 0;
      var newPushReads = 0;
      _installHandler(oldGateway, (method, args) async {
        if (method == 'pushStatus') {
          oldPushReads++;
          return oldRead.future;
        }
        return _notHandled;
      });
      _installHandler(newGateway, (method, args) async {
        if (method == 'pushStatus') {
          newPushReads++;
          return {'code': 'on', 'subscriptionId': 'new-controller'};
        }
        if (method == 'request' && args['path'] == '/api/push') {
          return {
            'subscriptions': [
              {
                'id': 'new-controller',
                'kind': 'unifiedpush',
                'name': 'Replacement phone',
                'host': 'push.example',
              },
            ],
          };
        }
        return _notHandled;
      });
      final oldController = LiveController(oldGateway, showing: 'engine')
        ..origin = _origin
        ..clientId = _clientId
        ..pairingStamp = 'same-stamp';
      final newController = LiveController(newGateway, showing: 'engine')
        ..origin = _origin
        ..clientId = _clientId
        ..pairingStamp = 'same-stamp';

      await tester.pumpWidget(_host(oldController));
      await tester.pump();
      expect(oldPushReads, 1);

      await tester.pumpWidget(_host(newController));
      await tester.pumpAndSettle();
      expect(newPushReads, 1);
      expect(find.text('This phone gets notifications.'), findsOneWidget);
      expect(find.text('Replacement phone (this phone)'), findsOneWidget);

      oldRead.complete({'code': 'off'});
      await tester.pumpAndSettle();
      expect(find.text('This phone gets notifications.'), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      await tester.pump();
      // If the old controller still retains the State listener, this notification
      // observes the new controller's changed identity and calls setState after
      // the widget has been disposed.
      newController
        ..origin = 'https://changed.example'
        ..clientId = 'changed-phone'
        ..pairingStamp = 'changed-stamp';
      expect(oldController.changed, returnsNormally);
      expect(tester.takeException(), isNull);

      oldController.dispose();
      newController.dispose();
      await oldGateway.stream.close();
      await newGateway.stream.close();
    },
  );

  testWidgets('stale connecting poll cannot restart after Turn off begins', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final stalePoll = Completer<dynamic>();
    final disable = Completer<dynamic>();
    var pushReads = 0;
    var disableCalls = 0;
    var disabled = false;
    _installHandler(gateway, (method, args) async {
      if (method == 'pushStatus') {
        pushReads++;
        if (pushReads == 1) return {'code': 'connecting'};
        if (pushReads == 2) return stalePoll.future;
        return {'code': disabled ? 'off' : 'connecting'};
      }
      if (method == 'pushDisable') {
        disableCalls++;
        return disable.future;
      }
      return _notHandled;
    });
    final controller = LiveController(gateway, showing: 'engine');

    await tester.pumpWidget(_host(controller));
    await tester.pump();
    await tester.pump();
    expect(
      find.text('Registering this phone for notifications…'),
      findsOneWidget,
    );
    expect(pushReads, 1);

    await tester.pump(const Duration(seconds: 2));
    expect(pushReads, 2);

    await tester.tap(find.text('Turn off'));
    await tester.pump();
    expect(disableCalls, 1);

    stalePoll.complete({'code': 'connecting'});
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    expect(pushReads, 2);

    disabled = true;
    disable.complete(null);
    await tester.pumpAndSettle();
    expect(pushReads, 3);
    expect(find.text('This phone does not get notifications.'), findsOneWidget);
    expect(
      find.text('Registering this phone for notifications…'),
      findsNothing,
    );

    await tester.pump(const Duration(seconds: 6));
    expect(pushReads, 3);

    await _removeWidget(tester, [(controller, gateway)]);
  });

  testWidgets(
    'connecting polls stop while General is hidden and restart on reveal',
    (tester) async {
      final gateway = FakeGateway();
      var pushReads = 0;
      _installHandler(gateway, (method, args) async {
        if (method == 'pushStatus') {
          pushReads++;
          return {'code': 'connecting', 'state': 'Registering'};
        }
        return _notHandled;
      });
      final controller = LiveController(gateway, showing: 'engine');
      await controller.boot();

      await tester.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                key: const Key('open-settings'),
                onPressed: () {
                  showNativeSettings(
                    context,
                    controller: controller,
                    onResetLayout: () {},
                    onOpenChat: (_) {},
                    onAppOptions: () {},
                  );
                },
                child: const Text('Open settings'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(const Key('open-settings')));
      await tester.pumpAndSettle();
      expect(pushReads, 1);
      expect(
        find.text('Registering this phone for notifications…'),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const ValueKey('settings-tab-About')));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 6));
      expect(pushReads, 1, reason: 'hidden General must not keep polling');

      await tester.tap(find.byKey(const ValueKey('settings-tab-General')));
      await tester.pumpAndSettle();
      expect(pushReads, 2, reason: 'reveal should make one immediate read');
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      expect(pushReads, 3, reason: 'polling resumes after General is visible');

      await tester.tap(find.byKey(const ValueKey('settings-tab-About')));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 6));
      expect(pushReads, 3, reason: 'polling stops again after hiding General');

      await tester.pumpWidget(const SizedBox());
      await tester.pump();
      controller.dispose();
      await gateway.stream.close();
    },
  );
}
