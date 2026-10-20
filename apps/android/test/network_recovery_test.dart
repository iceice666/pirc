import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';

import 'live_test.dart' show FakeGateway;

int requestCount(FakeGateway gateway, String path) => gateway.calls
    .where((call) => call.$1 == 'request' && call.$2['path'] == path)
    .length;

Future<void> sendNetworkAvailable(FakeGateway gateway) async {
  gateway.stream.add({
    'type': 'networkAvailable',
    'sessionId': null,
    'data': true,
  });
  // Let the controller's fire-and-forget refreshes pass through the fake bridge.
  await Future<void>.delayed(const Duration(milliseconds: 1));
}

Future<void> boot(LiveController controller) async {
  await controller.boot();
}

void main() {
  test(
    'networkAvailable refreshes paired account without session filtering',
    () async {
      final gateway = FakeGateway();
      final controller = LiveController(gateway);
      await boot(controller);
      // Explicitly return to the no-session state; bootstrap now selects the
      // first server session just as the web app does.
      await controller.home();
      expect(controller.sessionId, isNull);

      var sessions = requestCount(gateway, '/api/sessions');
      var memory = requestCount(gateway, '/api/memory');
      await sendNetworkAvailable(gateway);
      expect(requestCount(gateway, '/api/sessions'), sessions + 1);
      expect(requestCount(gateway, '/api/memory'), memory + 1);

      // The process-level event has no sessionId and still refreshes while a
      // conversation is selected; it must be handled before the session filter.
      controller.sessionId = 'different-session';
      sessions = requestCount(gateway, '/api/sessions');
      memory = requestCount(gateway, '/api/memory');
      await sendNetworkAvailable(gateway);
      expect(requestCount(gateway, '/api/sessions'), sessions + 1);
      expect(requestCount(gateway, '/api/memory'), memory + 1);

      controller.dispose();
      await gateway.stream.close();
    },
  );

  test('networkAvailable retries a failed initial list immediately', () async {
    final gateway = FakeGateway();
    final firstStarted = Completer<void>();
    final firstResponse = Completer<dynamic>();
    final retryStarted = Completer<void>();
    final retryResponse = Completer<dynamic>();
    var sessionsAttempts = 0;
    gateway.handler = (method, args) async {
      if (method == 'request' && args['path'] == '/api/sessions') {
        sessionsAttempts++;
        if (sessionsAttempts == 1) {
          firstStarted.complete();
          return firstResponse.future;
        }
        if (sessionsAttempts == 2) {
          retryStarted.complete();
          return retryResponse.future;
        }
      }
      return gateway.normal(method, args);
    };
    final controller = LiveController(gateway);
    final booting = controller.boot();
    await firstStarted.future.timeout(const Duration(seconds: 2));

    await sendNetworkAvailable(gateway);
    firstResponse.completeError(PlatformException(code: 'NETWORK'));
    await retryStarted.future.timeout(
      const Duration(seconds: 2),
      onTimeout: () =>
          throw TestFailure('Initial list was not retried promptly'),
    );
    await booting.timeout(const Duration(seconds: 2));

    retryResponse.complete({
      'sessions': [gateway.snapshot['session']],
    });
    await Future<void>.delayed(const Duration(milliseconds: 1));
    expect(sessionsAttempts, 2);
    expect(controller.sessions.single['id'], 's');
    expect(controller.sessionId, 's');
    expect(controller.revealSelectedSession, isFalse);
    expect(controller.loading, isFalse);

    controller.dispose();
    await gateway.stream.close();
  });

  test('networkAvailable is ignored when unpaired or in background', () async {
    final unpairedGateway = FakeGateway();
    unpairedGateway.handler = (method, args) async {
      if (method == 'boot') return {'origin': null, 'clientId': 'phone'};
      return unpairedGateway.normal(method, args);
    };
    final unpaired = LiveController(unpairedGateway);
    await boot(unpaired);
    final unpairedCalls = unpairedGateway.calls.length;
    await sendNetworkAvailable(unpairedGateway);
    expect(unpairedGateway.calls, hasLength(unpairedCalls));
    unpaired.dispose();
    await unpairedGateway.stream.close();

    final backgroundGateway = FakeGateway();
    final background = LiveController(backgroundGateway);
    await boot(background);
    background.active = false;
    final backgroundCalls = backgroundGateway.calls.length;
    await sendNetworkAvailable(backgroundGateway);
    expect(backgroundGateway.calls, hasLength(backgroundCalls));
    background.dispose();
    await backgroundGateway.stream.close();
  });
}
