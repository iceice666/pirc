import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/scoped_gateway.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'package:pirc_mobile/theme.dart';

class _RecordingGateway extends DartScopedGateway {
  _RecordingGateway() : super(Gateway());
  final calls = <(String, Json)>[];
  final watchedDrafts = <String>[];
  final savedDrafts = <Json>[];
  var backgroundHidden = Completer<void>();
  @override
  Future<dynamic> call(String method, [Json args = const {}]) async {
    calls.add((method, Map<String, dynamic>.of(args)));
    final result = await super.call(method, args);
    if (method == 'watch' && result is String) watchedDrafts.add(result);
    if (method == 'draft') savedDrafts.add(Map<String, dynamic>.of(args));
    if (method == 'setWatchVisibility' &&
        args['visible'] == false &&
        !backgroundHidden.isCompleted) {
      backgroundHidden.complete();
    }
    return result;
  }

  int count(String method) => calls.where((c) => c.$1 == method).length;
}

class _PlatformProbe with WidgetsBindingObserver {
  final inactive = Completer<void>();
  Completer<void> resumed = Completer<void>();
  final states = <AppLifecycleState>[];
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    states.add(state);
    if (state == AppLifecycleState.inactive && !inactive.isCompleted) {
      inactive.complete();
    }
    if (state == AppLifecycleState.resumed && !resumed.isCompleted) {
      resumed.complete();
    }
  }
}

const processDeathStage = String.fromEnvironment('PIRC_PROCESS_DEATH_STAGE');
const processDeathSession = String.fromEnvironment(
  'PIRC_PROCESS_DEATH_SESSION',
);
const processDeathClient = String.fromEnvironment('PIRC_PROCESS_DEATH_CLIENT');
const processDeathDraft = 'Keep this unsent process-death draft 🧪\n第二行仍然保留';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'actual Android focus interruption and long background preserve draft and respect another client',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      expect(
        const bool.fromEnvironment('PIRC_PLATFORM_LIFECYCLE'),
        isTrue,
        reason:
            'Use the host runner; this test requires actual Android system events.',
      );
      final g = _RecordingGateway();
      await g.call('pair', {
        'link': const String.fromEnvironment('PIRC_PAIR_LINK'),
      });
      await g.call('completeOnboarding');
      final workspaces = rows(
        (await g.request('/api/workspaces'))['workspaces'],
      );
      final workspace = workspaces.firstWhere((w) => w['kind'] == 'chat');
      final created = await g.request(
        '/api/sessions',
        method: 'POST',
        body: {'workspaceId': workspace['id']},
      );
      final sessionId = '${obj(created['session'])['id']}';
      final c = LiveController(g, showing: 'engine'), probe = _PlatformProbe();
      Timer? secondHeartbeat;
      final heartbeatErrors = <Object>[];
      final heartbeatJobs = <Future<void>>[];
      String? addedSession;
      int? secondGeneration;
      const secondClient = 'platform-lifecycle-second-client';
      const draft = 'Keep this unsent Android draft 🌱\n第二行仍然保留';
      const marker = 'Timeline update while the Android App is hidden';
      Future<void> until(bool Function() ready, String label) async {
        for (var i = 0; i < 150 && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 100));
        }
        expect(ready(), isTrue, reason: label);
        await t.pumpAndSettle();
        expect(t.takeException(), isNull, reason: label);
      }

      try {
        final theme = await PircTheme.load();
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        await until(() => !c.booting, 'actual App boot');
        c.pairLink = null;
        c.routePage = null;
        await c.open(sessionId);
        await until(() => c.canWrite, 'real session stream and control');
        await t.enterText(find.byKey(const Key('live-draft')), draft);
        await t.pumpAndSettle();
        t.binding.addObserver(probe);
        final initialWatches = g.count('watch'),
            initialUnwatches = g.count('unwatch');
        debugPrint('LIFE_PHASE_READY_INACTIVE');
        await probe.inactive.future.timeout(const Duration(seconds: 30));
        expect(
          c.active,
          isTrue,
          reason: 'A visible focus interruption must not hide the App.',
        );
        expect(g.count('unwatch'), initialUnwatches);
        debugPrint('LIFE_PHASE_INACTIVE_OBSERVED');
        await probe.resumed.future.timeout(const Duration(seconds: 30));
        await t.pumpAndSettle();
        expect(g.count('watch'), initialWatches);
        expect(c.draft, draft);
        probe.resumed = Completer<void>();
        g.backgroundHidden = Completer<void>();
        debugPrint('LIFE_PHASE_READY_BACKGROUND');
        await g.backgroundHidden.future.timeout(const Duration(seconds: 30));
        expect(c.active, isFalse);
        expect(
          probe.states.any(
            (s) =>
                s == AppLifecycleState.hidden || s == AppLifecycleState.paused,
          ),
          isTrue,
        );
        final backgroundClock = Stopwatch()..start();
        debugPrint('LIFE_PHASE_OWNER_BACKGROUND_STARTED');
        await Future<void>.delayed(const Duration(seconds: 35));
        expect(backgroundClock.elapsed.inSeconds, greaterThanOrEqualTo(34));
        final held = obj(
          (await g.request('${sessionPath(sessionId)}/control'))['lease'],
        );
        expect(held['clientId'], c.clientId);
        expect(
          held['expired'],
          isFalse,
          reason: 'The original owner survives the 30s TTL while hidden.',
        );
        debugPrint('LIFE_PHASE_OWNER_RETAINED');
        await g.request(
          '${sessionPath(sessionId)}/control/release',
          method: 'POST',
          body: {'clientId': c.clientId, 'generation': held['generation']},
        );
        await Future<void>.delayed(const Duration(seconds: 16));
        final free = obj(
          (await g.request('${sessionPath(sessionId)}/control'))['lease'],
        );
        expect(
          free.isEmpty || free['expired'] == true,
          isTrue,
          reason:
              'A hidden subscriber must not acquire a lease after it becomes free.',
        );
        debugPrint('LIFE_PHASE_HIDDEN_DID_NOT_ACQUIRE');
        final backgroundMessage = Completer<void>();
        void observeMessage() {
          if (c.messages.any((m) => '${m['content']}'.contains(marker)) &&
              !backgroundMessage.isCompleted) {
            backgroundMessage.complete();
          }
        }

        c.addListener(observeMessage);
        final lease = obj(
          (await g.request(
            '${sessionPath(sessionId)}/control/acquire',
            method: 'POST',
            body: {'clientId': secondClient, 'force': false},
          ))['lease'],
        );
        secondGeneration = (lease['generation'] as num).toInt();
        Future<void> heartbeat() async {
          try {
            await g.request(
              '${sessionPath(sessionId)}/control/heartbeat',
              method: 'POST',
              body: {'clientId': secondClient, 'generation': secondGeneration},
            );
          } catch (e) {
            heartbeatErrors.add(e);
          }
        }

        secondHeartbeat = Timer.periodic(const Duration(seconds: 8), (_) {
          heartbeatJobs.add(heartbeat());
        });
        final command = await g.request(
          '${sessionPath(sessionId)}/commands',
          method: 'POST',
          body: {
            'commandId':
                'platform-lifecycle-${DateTime.now().microsecondsSinceEpoch}',
            'clientId': secondClient,
            'generation': secondGeneration,
            'payload': {'type': 'prompt', 'message': marker},
          },
        );
        expect(obj(command['command'])['status'], 'accepted');
        final extra = await g.request(
          '/api/sessions',
          method: 'POST',
          body: {'workspaceId': workspace['id']},
        );
        addedSession = '${obj(extra['session'])['id']}';
        await backgroundMessage.future.timeout(const Duration(seconds: 15));
        c.removeListener(observeMessage);
        expect(c.active, isFalse);
        expect(g.count('unwatch'), initialUnwatches);
        debugPrint('LIFE_PHASE_BACKGROUND_STREAM_LIVE');
        debugPrint('LIFE_PHASE_SERVER_CHANGED');
        await probe.resumed.future.timeout(const Duration(seconds: 60));
        await until(
          () =>
              c.connection == 'live' &&
              c.control['holder'] == secondClient &&
              c.messages.any((m) => '${m['content']}'.contains(marker)) &&
              c.sessions.any((s) => s['id'] == addedSession),
          'foreground resync sees timeline, index and current control holder',
        );
        expect(c.active, isTrue);
        expect(
          c.canWrite,
          isFalse,
          reason:
              'Resuming must not force ownership away from the other client.',
        );
        expect(c.draft, draft);
        expect(find.text(draft), findsOneWidget);
        expect(
          g.watchedDrafts.last,
          draft,
          reason:
              'The resumed idempotent watch reads the native persisted draft.',
        );
        expect(c.messages.any((m) => m['content'] == draft), isFalse);
        expect(
          g.count('command'),
          0,
          reason: 'The App must never submit its saved draft automatically.',
        );
        expect(heartbeatErrors, isEmpty);
        for (final endpoint in ['devices', 'providers', 'provider-auth']) {
          await expectLater(
            g.request('/api/$endpoint'),
            throwsA(
              isA<PlatformException>().having(
                (e) => e.code,
                'code',
                'HTTP_403',
              ),
            ),
          );
        }
        debugPrint('LIFE_PHASE_ACCEPTED');
        backgroundClock.stop();
      } finally {
        secondHeartbeat?.cancel();
        await Future.wait(heartbeatJobs);
        t.binding.removeObserver(probe);
        await t.pumpWidget(const SizedBox());
        if (secondGeneration != null) {
          await g.request(
            '${sessionPath(sessionId)}/control/release',
            method: 'POST',
            body: {'clientId': secondClient, 'generation': secondGeneration},
          );
        }
        await g.request(sessionPath(sessionId), method: 'DELETE');
        if (addedSession != null) {
          await g.request(sessionPath(addedSession), method: 'DELETE');
        }
        await g.call('unpair');
      }
    },
    skip: processDeathStage.isNotEmpty,
  );

  testWidgets(
    'native persisted draft survives a force-stopped process and fresh startup',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      expect(processDeathStage, anyOf('prepare', 'restore'));
      Future<void> until(bool Function() ready, String label) async {
        for (var i = 0; i < 180 && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 100));
        }
        expect(ready(), isTrue, reason: label);
        await t.pumpAndSettle();
        expect(t.takeException(), isNull, reason: label);
      }

      if (processDeathStage == 'prepare') {
        final g = _RecordingGateway();
        await g.call('pair', {
          'link': const String.fromEnvironment('PIRC_PAIR_LINK'),
        });
        await g.call('completeOnboarding');
        final workspaces = rows(
          (await g.request('/api/workspaces'))['workspaces'],
        );
        final workspace = workspaces.firstWhere((w) => w['kind'] == 'chat');
        final created = await g.request(
          '/api/sessions',
          method: 'POST',
          body: {'workspaceId': workspace['id']},
        );
        final sessionId = '${obj(created['session'])['id']}';
        final theme = await PircTheme.load();
        final c = LiveController(g, showing: 'engine');
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        await until(() => !c.booting, 'prepare process-death App boot');
        c.pairLink = null;
        c.routePage = null;
        await c.open(sessionId);
        await until(
          () => c.sessionId == sessionId && c.connection == 'live',
          'prepare process-death session is live',
        );
        await t.enterText(
          find.byKey(const Key('live-draft')),
          processDeathDraft,
        );
        await until(
          () => g.savedDrafts.any(
            (draft) =>
                draft['sessionId'] == sessionId &&
                draft['text'] == processDeathDraft,
          ),
          'native draft write completed',
        );
        // SharedPreferences.apply() writes asynchronously; leave the process
        // alive briefly so the real device has time to flush the value to disk.
        await Future<void>.delayed(const Duration(seconds: 2));
        expect(
          c.messages.any((m) => m['content'] == processDeathDraft),
          isFalse,
        );
        debugPrint('LIFE_PHASE_PROCESS_DRAFT_READY $sessionId ${c.clientId}');
        // The host runner force-stops the package after this marker. The test
        // intentionally cannot dispose or clean up before process death.
        await Completer<void>().future;
      }

      if (processDeathStage == 'restore') {
        final sessionId = processDeathSession;
        final expectedClient = processDeathClient;
        expect(sessionId, isNotEmpty);
        expect(expectedClient, isNotEmpty);
        final g = _RecordingGateway();
        final theme = await PircTheme.load();
        final c = LiveController(g, showing: 'engine');
        var restoreVerified = false;
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        try {
          await until(() => !c.booting, 'fresh process App boot');
          expect(
            c.origin,
            isNotNull,
            reason: 'The pairing survived process death.',
          );
          expect(
            c.clientId,
            expectedClient,
            reason: 'The native client ID persisted.',
          );
          await until(
            () =>
                find.byType(SessionSidebar).evaluate().isNotEmpty &&
                c.sessions.any((session) => session['id'] == sessionId),
            'fresh process sidebar lists the target session',
          );
          expect(
            c.sessions.first['id'],
            sessionId,
            reason: 'The target is the most recently updated session.',
          );
          await until(
            () =>
                c.sessionId == sessionId &&
                c.connection == 'live' &&
                c.draft == processDeathDraft &&
                g.watchedDrafts.contains(processDeathDraft),
            'cold boot automatically opens the recent session and restores its draft',
          );
          expect(
            g.count('command'),
            0,
            reason: 'Cold-start restoration must never auto-send the draft.',
          );
          expect(
            c.messages.any((m) => m['content'] == processDeathDraft),
            isFalse,
          );
          debugPrint('LIFE_PHASE_PROCESS_RECENT_RESTORED');
          final targetRow = find.byKey(ValueKey('sidebar-$sessionId'));
          await t.ensureVisible(targetRow);
          expect(targetRow.hitTestable(), findsOneWidget);
          await t.tap(targetRow);
          await t.pumpAndSettle();
          expect(t.takeException(), isNull);
          await until(
            () =>
                c.sessionId == sessionId &&
                c.connection == 'live' &&
                c.draft == processDeathDraft &&
                find.byKey(const Key('live-draft')).evaluate().isNotEmpty,
            'selecting the target session opens the composer with the restored draft',
          );
          expect(find.byKey(const Key('live-draft')), findsOneWidget);
          expect(find.text(processDeathDraft), findsOneWidget);
          expect(
            c.messages.any((m) => m['content'] == processDeathDraft),
            isFalse,
          );
          expect(
            g.count('command'),
            0,
            reason: 'Restoration must never auto-send the draft.',
          );
          expect(g.watchedDrafts, contains(processDeathDraft));
          restoreVerified = true;
          debugPrint('LIFE_PHASE_PROCESS_RESTORED');
          // Keep the restored package process alive for the host PID check.
          await Future<void>.delayed(const Duration(seconds: 2));
        } finally {
          await t.pumpWidget(const SizedBox());
          if (restoreVerified) {
            await g.request(sessionPath(sessionId), method: 'DELETE');
            await g.call('unpair');
          } else {
            debugPrint(
              'LIFE_PHASE_PROCESS_CLEANUP_DEFERRED: restore assertions failed; '
              'skip remote cleanup so it cannot mask the original failure.',
            );
          }
        }
        debugPrint('LIFE_PHASE_PROCESS_CLEANED');
      }
    },
    skip: processDeathStage.isEmpty,
  );
}
