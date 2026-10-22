import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/scoped_gateway.dart';

import 'live_test.dart' show FakeGateway;

void main() {
  test(
    'app background keeps native watch subscribed and resume reuses its tag',
    () async {
      final transport = FakeGateway();
      final gateway = DartScopedGateway(transport);
      final controller = LiveController(gateway, showing: 'engine');
      addTearDown(() async {
        controller.dispose();
        await transport.stream.close();
      });

      await controller.boot();
      await controller.open('s');
      transport.publish('s', text: 'before background');
      final watchCountBeforeBackground = transport.calls
          .where((call) => call.$1 == 'watch')
          .length;
      final initialWatch = transport.calls.lastWhere(
        (call) => call.$1 == 'watch',
      );
      final initialTag = initialWatch.$2['watchTag'];

      await controller.lifecycle(false);

      expect(controller.active, isFalse);
      expect(transport.calls.where((call) => call.$1 == 'unwatch'), isEmpty);
      final hidden = transport.calls.lastWhere(
        (call) => call.$1 == 'setWatchVisibility',
      );
      expect(hidden.$2['visible'], isFalse);
      expect(hidden.$2['watchTag'], initialTag);
      final hiddenRevision = hidden.$2['visibilityRevision'] as int;

      // Events continue to update the controller while its visible polling is paused.
      transport.publish('s', text: 'received in background');
      expect(
        ((controller.state['messages'] as List).single as Map)['content'],
        'received in background',
      );

      await controller.lifecycle(true);

      final resumed = transport.calls.lastWhere(
        (call) => call.$1 == 'setWatchVisibility',
      );
      expect(resumed.$2['visible'], isTrue);
      expect(resumed.$2['visibilityRevision'], greaterThan(hiddenRevision));
      final watches = transport.calls
          .where((call) => call.$1 == 'watch')
          .toList();
      expect(watches, hasLength(watchCountBeforeBackground + 1));
      expect(watches.last.$2['watchTag'], initialTag);
      expect(transport.calls.where((call) => call.$1 == 'unwatch'), isEmpty);
    },
  );
  test(
    'a hide before boot is sent before the first watch can acquire a lease',
    () async {
      final transport = FakeGateway();
      final controller = LiveController(
        DartScopedGateway(transport),
        showing: 'engine',
      );
      addTearDown(() async {
        controller.dispose();
        await transport.stream.close();
      });

      await controller.lifecycle(false);
      expect(
        transport.calls.where((call) => call.$1 == 'setWatchVisibility'),
        isEmpty,
        reason: 'the controller has no native account context before boot',
      );
      await controller.boot();

      final visibilityIndex = transport.calls.indexWhere(
        (call) => call.$1 == 'setWatchVisibility',
      );
      final watchIndex = transport.calls.indexWhere(
        (call) => call.$1 == 'watch',
      );
      expect(visibilityIndex, greaterThanOrEqualTo(0));
      expect(watchIndex, greaterThan(visibilityIndex));
      expect(transport.calls[visibilityIndex].$2['visible'], isFalse);
    },
  );

  test(
    'a document covered before boot does not grant its first watch acquisition',
    () async {
      final transport = FakeGateway();
      final controller = LiveController(
        DartScopedGateway(transport),
        showing: 'engine',
      );
      addTearDown(() async {
        controller.dispose();
        await transport.stream.close();
      });

      await controller.lifecycle(false);
      await controller.coverDocument();
      await controller.boot();

      final visibilityIndex = transport.calls.indexWhere(
        (call) => call.$1 == 'setWatchVisibility',
      );
      final watchIndex = transport.calls.indexWhere(
        (call) => call.$1 == 'watch',
      );
      expect(visibilityIndex, greaterThanOrEqualTo(0));
      expect(watchIndex, greaterThan(visibilityIndex));
      expect(transport.calls[visibilityIndex].$2['visible'], isFalse);
      expect(controller.active, isFalse);
    },
  );

  test(
    'a delayed visible handshake does not cancel a current open after hide',
    () async {
      final transport = FakeGateway();
      final controller = LiveController(
        DartScopedGateway(transport),
        showing: 'engine',
      );
      final visibleStarted = Completer<void>();
      final releaseVisible = Completer<void>();
      final visibilityCalls = <Json>[];
      var delayedFirstVisible = false;
      transport.handler = (method, args) async {
        if (method == 'setWatchVisibility') {
          visibilityCalls.add(Map<String, dynamic>.of(args));
          if (args['visible'] == true && !delayedFirstVisible) {
            delayedFirstVisible = true;
            visibleStarted.complete();
            await releaseVisible.future;
          }
        }
        return transport.normal(method, args);
      };
      addTearDown(() async {
        controller.dispose();
        await transport.stream.close();
      });

      final boot = controller.boot();
      await visibleStarted.future;
      expect(controller.sessionId, 's');

      await controller.lifecycle(false);
      expect(controller.active, isFalse);
      expect(visibilityCalls.map((call) => call['visible']), [true, false]);
      expect(
        visibilityCalls[1]['visibilityRevision'],
        greaterThan(visibilityCalls[0]['visibilityRevision'] as int),
      );

      releaseVisible.complete();
      await boot;

      final watches = transport.calls
          .where((call) => call.$1 == 'watch')
          .toList();
      expect(watches, isNotEmpty);
      expect(watches.last.$2['sessionId'], 's');
      expect(visibilityCalls.last['visible'], isFalse);
      expect(controller.active, isFalse);
    },
  );
}
