import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/scoped_gateway.dart';

class _RecordedCall {
  _RecordedCall(this.method, this.arguments);

  final String method;
  final Json arguments;
}

class _SharedGateway extends Gateway {
  final calls = <_RecordedCall>[];
  late final eventsController = StreamController<Json>.broadcast(
    sync: true,
    onListen: () => sourceListenCount++,
    onCancel: () => sourceCancelCount++,
  );
  final failures = <String, Object>{};
  final pendingResponses = <String, Completer<dynamic>>{};
  int sourceListenCount = 0, sourceCancelCount = 0;
  Json bootResponse = <String, dynamic>{
    'origin': 'https://gateway.example',
    'pairingStamp': 'pair-stamp',
    'route': 'memory',
    'targetSession': 'notification-session',
    'interactionId': 'notification-interaction',
    'answerChoice': 'accept',
    'confirmQuestion': true,
    'pairLink': 'https://gateway.example/pair/secret',
  };

  @override
  Stream<Json> get events => eventsController.stream;

  @override
  Future<dynamic> call(String method, [Json args = const {}]) async {
    calls.add(_RecordedCall(method, Map<String, dynamic>.of(args)));
    final failure = failures[method];
    if (failure != null) throw failure;
    final pending = pendingResponses[method];
    if (pending != null) return pending.future;
    if (method == 'boot') return bootResponse;
    return <String, dynamic>{'method': method, ...args};
  }

  Future<void> dispose() => eventsController.close();
}

void main() {
  group('DartScopedGateway', () {
    late _SharedGateway shared;

    setUp(() {
      shared = _SharedGateway();
    });

    tearDown(() async {
      await shared.dispose();
    });

    test(
      'unwraps nested wrappers and fixes context on ordinary calls',
      () async {
        final primary = DartScopedGateway(shared);
        final child = DartScopedGateway(primary, contextId: 'document-2');
        final callerArguments = <String, dynamic>{
          'sessionId': 'session-a',
          'contextId': 'primary',
        };

        final response = await child.call('refresh', callerArguments);

        expect(child.contextId, 'document-2');
        expect(child.isPrimary, isFalse);
        expect(child.rawTransport, same(shared));
        expect(child.transport, same(shared));
        expect(callerArguments['contextId'], 'primary');
        expect(shared.calls.map((call) => call.method), <String>[
          'boot',
          'openContext',
          'refresh',
        ]);
        expect(shared.calls[1].arguments, <String, dynamic>{
          'contextId': 'document-2',
          'pairingStamp': 'pair-stamp',
        });
        expect(shared.calls.last.arguments, <String, dynamic>{
          'sessionId': 'session-a',
          'contextId': 'document-2',
        });
        expect(response['method'], 'refresh');
        expect(response['contextId'], 'document-2');
      },
    );

    test(
      'shares one registration across concurrent contextual calls',
      () async {
        final child = DartScopedGateway(shared, contextId: 'document-open');
        final opening = Completer<dynamic>();
        shared.pendingResponses['openContext'] = opening;

        final watch = child.call('watch', <String, dynamic>{
          'sessionId': 'session-a',
          'contextId': 'forged',
          'watchTag': 'forged',
        });
        final refresh = child.call('refresh', <String, dynamic>{
          'sessionId': 'session-a',
        });
        await Future<void>.delayed(Duration.zero);

        expect(shared.calls.map((call) => call.method), <String>[
          'boot',
          'openContext',
        ]);
        expect(shared.calls.last.arguments, <String, dynamic>{
          'contextId': 'document-open',
          'pairingStamp': 'pair-stamp',
        });
        expect(
          shared.calls.where((call) => call.method == 'watch'),
          isEmpty,
          reason:
              'contextual operations wait until native registration succeeds',
        );

        opening.complete(null);
        await Future.wait(<Future<dynamic>>[watch, refresh]);
        expect(shared.calls.map((call) => call.method), <String>[
          'boot',
          'openContext',
          'watch',
          'refresh',
        ]);
        expect(shared.calls[2].arguments['contextId'], 'document-open');
        expect(shared.calls[2].arguments['watchTag'], 'document-open:1');
        expect(shared.calls[3].arguments['contextId'], 'document-open');
      },
    );

    test('primary ensureContext never registers a native context', () async {
      final primary = DartScopedGateway(shared);

      await primary.ensureContext();
      await primary.call('watch', <String, dynamic>{'sessionId': 'session-a'});
      await primary.call('watch', <String, dynamic>{'sessionId': 'session-a'});

      expect(shared.calls.map((call) => call.method), <String>[
        'watch',
        'watch',
      ]);
      expect(shared.calls[0].arguments['contextId'], 'primary');
      expect(shared.calls[0].arguments['watchTag'], 'primary:1');
      expect(shared.calls[1].arguments['watchTag'], 'primary:1');
    });

    test(
      'watch visibility forwards revision and current tag without replacing it',
      () async {
        final child = DartScopedGateway(shared, contextId: 'visibility-child');
        await child.call('watch', <String, dynamic>{'sessionId': 'session-a'});
        final tag = shared.calls.last.arguments['watchTag'];

        await child.call('setWatchVisibility', <String, dynamic>{
          'visible': false,
          'visibilityRevision': 7,
        });

        expect(shared.calls.last.method, 'setWatchVisibility');
        expect(shared.calls.last.arguments, <String, dynamic>{
          'visible': false,
          'visibilityRevision': 7,
          'contextId': 'visibility-child',
          'watchTag': tag,
        });
        expect(shared.calls.where((call) => call.method == 'unwatch'), isEmpty);
      },
    );

    test(
      'visibility revision stays monotonic across controller counter resets',
      () async {
        final oldControllerGateway = DartScopedGateway(shared);
        final newControllerGateway = DartScopedGateway(shared);

        await oldControllerGateway.call('setWatchVisibility', <String, dynamic>{
          'visible': false,
          'visibilityRevision': 7,
        });
        await newControllerGateway.call('setWatchVisibility', <String, dynamic>{
          'visible': true,
          'visibilityRevision': 1,
        });

        final updates = shared.calls
            .where((call) => call.method == 'setWatchVisibility')
            .toList();
        final firstRevision = updates[0].arguments['visibilityRevision'] as int;
        final secondRevision =
            updates[1].arguments['visibilityRevision'] as int;
        expect(firstRevision, greaterThan(7));
        expect(secondRevision, firstRevision + 1);
      },
    );

    test('watch after unwatch receives a fresh identity', () async {
      final child = DartScopedGateway(shared, contextId: 'visibility-child');
      await child.call('watch', <String, dynamic>{'sessionId': 'session-a'});
      final firstTag = shared.calls.last.arguments['watchTag'];
      await child.call('unwatch');
      await child.call('watch', <String, dynamic>{'sessionId': 'session-a'});

      expect(shared.calls.last.arguments['watchTag'], 'visibility-child:2');
      expect(
        shared.calls
            .where((call) => call.method == 'unwatch')
            .single
            .arguments['watchTag'],
        firstTag,
      );
    });

    test(
      'shared and playback operations do not receive a context ID',
      () async {
        final child = DartScopedGateway(shared, contextId: 'document-3');
        const calls = <String>[
          'preferences',
          'savePreferences',
          'pair',
          'unpair',
          'permissions',
          'completeOnboarding',
          'requestNotifications',
          'requestOverlay',
          'notificationSettings',
          'pushStatus',
          'pushDisable',
          'activity',
          'share',
          'external',
          'scan',
          'recordingOpen',
          'recordingControl',
          'recordingClose',
          'recordingSave',
          'managementStatus',
          'managementBegin',
          'managementCheck',
          'managementCancel',
          'managementOpen',
        ];

        for (final method in calls) {
          await child.call(method, <String, dynamic>{
            'contextId': 'primary',
            'sentinel': method,
          });
          expect(shared.calls.last.method, method);
          expect(shared.calls.last.arguments, <String, dynamic>{
            'sentinel': method,
          });
        }
      },
    );

    test(
      'push enable keeps the invoking context through an async picker',
      () async {
        final child = DartScopedGateway(shared, contextId: 'document-push');
        await child.call('pushEnable', {'contextId': 'primary'});
        expect(shared.calls.last.method, 'pushEnable');
        expect(shared.calls.last.arguments, {'contextId': 'document-push'});
        await child.closeContext();
        final count = shared.calls.length;
        await expectLater(child.call('pushEnable'), throwsStateError);
        expect(shared.calls.length, count);
      },
    );

    test(
      'child boot strips only the primary notification route fields',
      () async {
        final root = DartScopedGateway(shared);
        final child = DartScopedGateway(root, contextId: 'document-4');

        final childBoot = obj(await child.call('boot'));
        expect(childBoot, <String, dynamic>{
          'origin': 'https://gateway.example',
          'pairingStamp': 'pair-stamp',
        });
        expect(shared.calls.single.method, 'boot');
        expect(shared.calls.single.arguments, isEmpty);
        expect(shared.bootResponse['targetSession'], 'notification-session');

        final rootBoot = obj(await root.call('boot'));
        expect(rootBoot['route'], 'memory');
        expect(rootBoot['targetSession'], 'notification-session');
        expect(rootBoot['pairLink'], 'https://gateway.example/pair/secret');
        expect(shared.calls.last.arguments, isEmpty);
      },
    );

    test(
      'events stay in scope, broadcast account changes and keep routes primary-only',
      () async {
        final root = DartScopedGateway(shared);
        final child = DartScopedGateway(root, contextId: 'document-5');
        final rootEvents = <Json>[];
        final childEvents = <Json>[];
        final rootSubscription = root.events.listen(rootEvents.add);
        final childSubscription = child.events.listen(childEvents.add);
        addTearDown(rootSubscription.cancel);
        addTearDown(childSubscription.cancel);

        shared.eventsController.add(<String, dynamic>{
          'type': 'networkAvailable',
        });
        shared.eventsController.add(<String, dynamic>{
          'type': 'snapshot',
          'contextId': 'document-5',
        });
        shared.eventsController.add(<String, dynamic>{
          'type': 'snapshot',
          'contextId': 'another-document',
        });
        shared.eventsController.add(<String, dynamic>{
          'type': 'accountChanged',
          'scope': 'account',
        });
        shared.eventsController.add(<String, dynamic>{
          'type': 'pairingChanged',
          'contextId': 'another-document',
        });
        shared.eventsController.add(<String, dynamic>{
          'type': 'route',
          'scope': 'account',
          'data': <String, dynamic>{'sessionId': 'from-notification'},
        });
        await Future<void>.delayed(Duration.zero);

        expect(rootEvents.map((event) => event['type']), <String>[
          'networkAvailable',
          'accountChanged',
          'pairingChanged',
          'route',
        ]);
        expect(childEvents.map((event) => event['type']), <String>[
          'snapshot',
          'accountChanged',
          'pairingChanged',
        ]);

        await child.closeContext();
        shared.eventsController.add(<String, dynamic>{
          'type': 'accountChanged',
          'scope': 'account',
        });
        await Future<void>.delayed(Duration.zero);
        expect(
          rootEvents.where((event) => event['type'] == 'accountChanged'),
          hasLength(2),
        );
        expect(
          childEvents.where((event) => event['type'] == 'accountChanged'),
          hasLength(1),
        );
      },
    );

    test(
      'closeContext is idempotent and cannot target another context',
      () async {
        final child = DartScopedGateway(shared, contextId: 'document-6');
        await child.ensureContext();

        await child.call('closeContext', <String, dynamic>{
          'contextId': 'primary',
          'sessionId': 'must-not-forward',
        });
        await child.closeContext();

        expect(shared.calls.map((call) => call.method), <String>[
          'boot',
          'openContext',
          'closeContext',
        ]);
        expect(shared.calls.last.arguments, <String, dynamic>{
          'contextId': 'document-6',
          'pairingStamp': 'pair-stamp',
        });
      },
    );

    test(
      'closing during registration fences queued work and closes afterward',
      () async {
        final child = DartScopedGateway(shared, contextId: 'closing-child');
        final opening = Completer<dynamic>();
        shared.pendingResponses['openContext'] = opening;

        final queuedWatch = child.call('watch', <String, dynamic>{
          'sessionId': 'session-a',
        });
        final queuedWatchError = expectLater(
          queuedWatch,
          throwsA(isA<StateError>()),
        );
        await Future<void>.delayed(Duration.zero);
        expect(shared.calls.map((call) => call.method), <String>[
          'boot',
          'openContext',
        ]);

        final closing = child.closeContext();
        expect(child.isClosed, isTrue);
        await expectLater(child.call('watch'), throwsA(isA<StateError>()));
        await expectLater(
          child.call('preferences'),
          throwsA(isA<StateError>()),
        );

        opening.complete(null);
        await closing;
        await queuedWatchError;
        expect(shared.calls.map((call) => call.method), <String>[
          'boot',
          'openContext',
          'closeContext',
        ]);
        expect(shared.calls.last.arguments, <String, dynamic>{
          'contextId': 'closing-child',
          'pairingStamp': 'pair-stamp',
        });

        await expectLater(child.ensureContext(), throwsA(isA<StateError>()));
        expect(
          shared.calls,
          hasLength(3),
          reason: 'closed contexts never reopen',
        );
      },
    );

    test('missing pairing stamp prevents opening a child context', () async {
      final child = DartScopedGateway(shared, contextId: 'unpaired-child');
      shared.bootResponse = <String, dynamic>{
        'origin': 'https://gateway.example',
      };

      await expectLater(child.ensureContext(), throwsA(isA<StateError>()));

      expect(shared.calls.map((call) => call.method), <String>['boot']);
      expect(child.isClosed, isFalse);
    });

    test(
      'latest watch tag filters stale events and old unwatch completion',
      () async {
        final child = DartScopedGateway(shared, contextId: 'watch-child');
        await child.ensureContext();
        final received = <Json>[];
        final subscription = child.events.listen(received.add);
        addTearDown(subscription.cancel);

        final watchPending = Completer<dynamic>();
        shared.pendingResponses['watch'] = watchPending;
        final oldWatch = child.call('watch', <String, dynamic>{
          'sessionId': 'old-session',
        });
        final currentWatch = child.call('watch', <String, dynamic>{
          'sessionId': 'current-session',
        });
        await Future<void>.delayed(Duration.zero);
        final watchCalls = shared.calls
            .where((call) => call.method == 'watch')
            .toList();
        expect(watchCalls, hasLength(2));
        final oldTag = watchCalls[0].arguments['watchTag'] as String;
        final currentTag = watchCalls[1].arguments['watchTag'] as String;
        expect(oldTag, 'watch-child:1');
        expect(currentTag, 'watch-child:2');
        watchPending.complete(null);
        await Future.wait(<Future<dynamic>>[oldWatch, currentWatch]);
        shared.pendingResponses.remove('watch');

        final unwatchPending = Completer<dynamic>();
        shared.pendingResponses['unwatch'] = unwatchPending;
        final olderUnwatch = child.call('unwatch', <String, dynamic>{
          'watchTag': 'forged',
        });
        await Future<void>.delayed(Duration.zero);
        expect(shared.calls.last.method, 'unwatch');
        expect(shared.calls.last.arguments['watchTag'], currentTag);

        final newerWatch = await child.call('watch', <String, dynamic>{
          'sessionId': 'new-session',
        });
        expect(newerWatch['method'], 'watch');
        final newestTag = shared.calls.last.arguments['watchTag'] as String;
        expect(newestTag, 'watch-child:3');
        unwatchPending.complete(null);
        await olderUnwatch;

        shared.eventsController.add(<String, dynamic>{
          'type': 'snapshot',
          'contextId': 'watch-child',
          'watchTag': oldTag,
        });
        shared.eventsController.add(<String, dynamic>{
          'type': 'snapshot',
          'contextId': 'watch-child',
          'watchTag': currentTag,
        });
        shared.eventsController.add(<String, dynamic>{
          'type': 'socket',
          'contextId': 'watch-child',
        });
        shared.eventsController.add(<String, dynamic>{
          'type': 'snapshot',
          'contextId': 'watch-child',
          'watchTag': newestTag,
        });
        await Future<void>.delayed(Duration.zero);

        expect(received.map((event) => event['type']), <String>[
          'socket',
          'snapshot',
        ]);
        expect(received.last['watchTag'], newestTag);
      },
    );

    test(
      'last event listener cancellation releases the raw filtered stream',
      () async {
        final child = DartScopedGateway(shared, contextId: 'stream-child');
        final subscription = child.events.listen((_) {});

        expect(shared.sourceListenCount, 1);
        await subscription.cancel();
        await Future<void>.delayed(Duration.zero);

        expect(shared.sourceCancelCount, 1);
      },
    );

    test('preserves errors from the shared transport', () async {
      final child = DartScopedGateway(shared, contextId: 'document-7');
      final failure = StateError('native failure');
      shared.failures['document'] = failure;

      await expectLater(
        child.call('document', <String, dynamic>{
          'url': 'https://example.test',
        }),
        throwsA(same(failure)),
      );
      expect(shared.calls.last.arguments['contextId'], 'document-7');
    });

    test('rejects empty context identities', () {
      expect(
        () => DartScopedGateway(shared, contextId: '   '),
        throwsArgumentError,
      );
    });
  });
}
