import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/scoped_gateway.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'real Android scoped gateways isolate session streams and purge on unpair',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      const link = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(link.isNotEmpty, isTrue, reason: 'Missing private pairing link.');

      final raw = Gateway();
      final root = DartScopedGateway(raw);
      final suffix = DateTime.now().microsecondsSinceEpoch;
      final childId = 'scoped-child-$suffix';
      final peerId = 'scoped-peer-$suffix';
      final observerId = 'scoped-observer-$suffix';
      final child = DartScopedGateway(raw, contextId: childId);
      final peer = DartScopedGateway(raw, contextId: peerId);
      final observer = DartScopedGateway(raw, contextId: observerId);
      final rootEvents = <Json>[];
      final childEvents = <Json>[];
      final peerEvents = <Json>[];
      final observerEvents = <Json>[];
      StreamSubscription<Json>? rootSubscription;
      StreamSubscription<Json>? childSubscription;
      StreamSubscription<Json>? peerSubscription;
      StreamSubscription<Json>? observerSubscription;
      final created = <String>[];
      final deleted = <String>{};
      var paired = false;
      var unpaired = false;

      Future<Json> waitForEvent(
        List<Json> events,
        bool Function(Json) predicate,
        String label,
      ) async {
        for (var i = 0; i < 180; i++) {
          for (final event in events.reversed) {
            if (predicate(event)) return event;
          }
          await t.pump(const Duration(milliseconds: 200));
        }
        fail('Timed out waiting for $label.');
      }

      Future<void> expectHttp403(
        Future<dynamic> request,
        String endpoint,
      ) async {
        await expectLater(
          request,
          throwsA(
            isA<PlatformException>()
                .having((e) => e.code, 'code', 'HTTP_403')
                .having(
                  (e) => obj(e.details)['code'],
                  'details code',
                  'forbidden',
                ),
          ),
          reason: 'Device bearer must remain forbidden from $endpoint.',
        );
      }

      Future<void> deleteCreated() async {
        for (final id in created.reversed) {
          if (deleted.contains(id)) continue;
          try {
            await raw.request(sessionPath(id), method: 'DELETE');
            deleted.add(id);
          } catch (_) {
            // Keep cleanup best-effort if the test already removed a session.
          }
        }
      }

      try {
        await raw.call('pair', {'link': link});
        paired = true;
        await raw.call('completeOnboarding');
        final boot = obj(await raw.call('boot'));
        final pairingStamp = boot['pairingStamp'];
        expect(pairingStamp, isA<String>());
        final origin = '${boot['origin']}';

        final workspaceData = await raw.request('/api/workspaces');
        final workspace = rows(
          workspaceData['workspaces'],
        ).firstWhere((item) => item['kind'] == 'chat');
        Future<String> createSession(String name) async {
          final response = await raw.request(
            '/api/sessions',
            method: 'POST',
            body: {'workspaceId': workspace['id']},
          );
          final id = '${obj(response['session'])['id']}';
          expect(id, isNotEmpty);
          created.add(id);
          await raw.request(
            sessionPath(id),
            method: 'PATCH',
            body: {'name': name},
          );
          return id;
        }

        final sessionA = await createSession('Scoped root session $suffix');
        final sessionB = await createSession('Scoped child session $suffix');

        rootSubscription = root.events.listen(rootEvents.add);
        childSubscription = child.events.listen(childEvents.add);
        peerSubscription = peer.events.listen(peerEvents.add);
        observerSubscription = observer.events.listen(observerEvents.add);

        await root.call('watch', {'sessionId': sessionA});
        final rootTag = 'primary:1';
        final rootSnapshot = await waitForEvent(
          rootEvents,
          (event) =>
              event['type'] == 'snapshot' &&
              event['sessionId'] == sessionA &&
              event['watchTag'] == rootTag,
          'primary session snapshot',
        );
        expect(obj(rootSnapshot['data'])['session'], isA<Map>());
        expect(rootSnapshot.containsKey('contextId'), isFalse);
        await waitForEvent(
          rootEvents,
          (event) =>
              event['type'] == 'connection' &&
              event['sessionId'] == sessionA &&
              event['watchTag'] == rootTag,
          'primary connection state',
        );

        await child.ensureContext();
        await child.call('watch', {'sessionId': sessionB});
        final childSnapshot = await waitForEvent(
          childEvents,
          (event) =>
              event['type'] == 'snapshot' &&
              event['sessionId'] == sessionB &&
              event['contextId'] == childId &&
              event['watchTag'] == '$childId:1',
          'child session snapshot',
        );
        expect(obj(childSnapshot['data'])['session'], isA<Map>());
        await waitForEvent(
          childEvents,
          (event) =>
              event['type'] == 'connection' &&
              event['sessionId'] == sessionB &&
              event['contextId'] == childId &&
              event['watchTag'] == '$childId:1',
          'child connection state',
        );

        final primaryBefore = obj(
          await root.call('refresh', {'sessionId': sessionA}),
        );
        final childState = obj(
          await child.call('refresh', {'sessionId': sessionB}),
        );
        final primaryAfter = obj(
          await root.call('refresh', {'sessionId': sessionA}),
        );
        expect(obj(primaryBefore['session'])['id'], sessionA);
        expect(obj(primaryAfter['session'])['id'], sessionA);
        expect(obj(childState['session'])['id'], sessionB);
        expect(sessionA, isNot(sessionB));
        expect(
          rootEvents.any((event) => event['sessionId'] == sessionB),
          isFalse,
          reason: 'Primary receives only its own session events.',
        );
        expect(
          childEvents.any((event) => event['sessionId'] == sessionA),
          isFalse,
          reason: 'Child receives only its own session events.',
        );
        expect(primaryAfter['session'], equals(primaryBefore['session']));

        await expectHttp403(child.request('/api/devices'), '/api/devices');
        await expectHttp403(child.request('/api/providers'), '/api/providers');
        await expectHttp403(
          child.request('/api/provider-auth'),
          '/api/provider-auth',
        );

        await child.call('unwatch');
        await child.closeContext();
        await expectLater(
          child.call('refresh', {'sessionId': sessionB}),
          throwsA(isA<StateError>()),
        );
        await expectLater(
          raw.call('refresh', {'contextId': childId, 'sessionId': sessionB}),
          throwsA(
            isA<PlatformException>()
                .having((e) => e.code, 'code', 'HTTP_409')
                .having(
                  (e) => obj(e.details)['code'],
                  'details code',
                  'context_expired',
                ),
          ),
        );

        await peer.ensureContext();
        await peer.call('watch', {'sessionId': sessionA});
        await waitForEvent(
          peerEvents,
          (event) =>
              event['type'] == 'snapshot' &&
              event['sessionId'] == sessionA &&
              event['contextId'] == peerId &&
              event['watchTag'] == '$peerId:1',
          'same-session peer snapshot',
        );
        await observer.ensureContext();

        for (final endpoint in ['devices', 'providers', 'provider-auth']) {
          await expectHttp403(peer.request('/api/$endpoint'), '/api/$endpoint');
        }

        await peer.closeContext();
        final renamed = 'Root stream remains after peer close $suffix';
        await raw.request(
          sessionPath(sessionA),
          method: 'PATCH',
          body: {'name': renamed},
        );
        final renameSnapshot = await waitForEvent(
          rootEvents,
          (event) =>
              event['type'] == 'snapshot' &&
              event['sessionId'] == sessionA &&
              obj(obj(event['data'])['session'])['name'] == renamed,
          'primary stream after same-session child closes',
        );
        expect(obj(obj(renameSnapshot['data'])['session'])['id'], sessionA);
        await expectLater(
          raw.call('refresh', {'contextId': peerId, 'sessionId': sessionA}),
          throwsA(
            isA<PlatformException>()
                .having((e) => e.code, 'code', 'HTTP_409')
                .having(
                  (e) => obj(e.details)['code'],
                  'details code',
                  'context_expired',
                ),
          ),
        );

        // Remove only test-created sessions before unpairing the device.
        await deleteCreated();
        await root.call('unpair');
        unpaired = true;
        final rootPairingChange = await waitForEvent(
          rootEvents,
          (event) => event['type'] == 'pairingChanged',
          'primary pairing-change event',
        );
        final observerPairingChange = await waitForEvent(
          observerEvents,
          (event) => event['type'] == 'pairingChanged',
          'child account-scope pairing-change event',
        );
        for (final event in [rootPairingChange, observerPairingChange]) {
          final data = obj(event['data']);
          expect(event['scope'], 'account');
          expect(data['origin'], isNull);
          expect(data['clientId'], isA<String>());
          expect(data['pairingStamp'], isA<String>());
          expect(data.containsKey('token'), isFalse);
        }
        await expectLater(
          observer.request('/api/sessions'),
          throwsA(
            isA<PlatformException>()
                .having((e) => e.code, 'code', 'HTTP_409')
                .having(
                  (e) => obj(e.details)['code'],
                  'details code',
                  'context_expired',
                ),
          ),
        );
        expect(origin, isNotEmpty);
        expect(t.takeException(), isNull);
      } finally {
        await deleteCreated();
        for (final context in [child, peer, observer]) {
          try {
            await context.closeContext();
          } catch (_) {}
        }
        try {
          await root.call('unwatch');
        } catch (_) {}
        if (paired && !unpaired) {
          try {
            await raw.call('unpair');
          } catch (_) {}
        }
        await rootSubscription?.cancel();
        await childSubscription?.cancel();
        await peerSubscription?.cancel();
        await observerSubscription?.cancel();
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
