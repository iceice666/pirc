import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/pots_state.dart';
import 'package:pirc_mobile/live/pots_page.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/mobile_tabs.dart';
import 'package:pirc_mobile/l10n/app_i18n.dart';

import 'live_test.dart' show FakeGateway, theme;

final futureExpiry = DateTime.utc(2100).millisecondsSinceEpoch;
Json overview({String account = 'alice', bool populated = true}) => {
  'actor': {'kind': 'pots', 'id': 'personal'},
  'accountKey': account,
  'executionAvailable': false,
  'observationMode': 'session_progress_events',
  'workspaces': [
    {'id': 'node:work', 'name': 'Selected workspace'},
  ],
  'responsibilities': [
    if (populated)
      {
        'id': 'r /',
        'revision': 3,
        'generation': 2,
        'purpose': 'Watch progress',
        'enabled': false,
        'observationPaused': false,
        'coordinationPaused': true,
        'scopes': [
          {'workspaceId': 'node:work', 'access': 'progress'},
        ],
        'budgets': {'observations': 3, 'dispatches': 0, 'concurrency': 1},
        'observationsUsed': 0,
        'dispatchesUsed': 0,
      },
  ],
  'suggestions': [
    if (populated)
      {
        'id': 's /',
        'revision': 4,
        'disposition': 'pending',
        'snoozedUntil': null,
        'targetSessionId': 'source',
        'taskId': null,
        'evidence': {
          'workspaceId': 'node:work',
          'sessionId': 'source',
          'runnerEpoch': 2,
          'interactionId': 'input',
          'expiresAt': futureExpiry,
        },
      },
  ],
  'tasks': [
    if (populated)
      {
        'id': 't /',
        'revision': 5,
        'controlGeneration': 3,
        'status': 'tracked',
        'takenOver': false,
        'coordinationPaused': false,
        'originSuggestionId': 's /',
        'targetSessionId': 'source',
        'executionSessionId': null,
      },
  ],
};

LiveController paired(FakeGateway g) => LiveController(g)
  ..origin = 'https://gateway.example'
  ..clientId = 'same-device'
  ..pairingStamp = 'old-pairing';

List<Json> posts(FakeGateway g) => g.calls
    .where((c) => c.$1 == 'request' && c.$2['method'] == 'POST')
    .map((c) => c.$2)
    .toList();

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  tearDown(() => AppI18n.instance.setLanguage('en'));

  test(
    'read/open has no effects; all controls use exact revisions and paired HTTP',
    () async {
      final g = FakeGateway()..handler = (m, a) async => overview();
      final c = paired(g);
      final state = PotsState(c);
      await state.load();
      expect(posts(g), isEmpty);
      await state.responsibility(state.responsibilities.single, 'activate');
      expect(
        posts(g).last['path'],
        '/api/pots/responsibilities/r%20%2F/control',
      );
      expect(posts(g).last['body'], {
        'expectedRevision': 3,
        'expectedGeneration': 2,
        'action': {'type': 'activate'},
      });
      await state.track(state.suggestions.single);
      expect(obj(posts(g).last['body'])['expectedRevision'], 4);
      expect(obj(posts(g).last['body'])['commandId'], isNotEmpty);
      await state.task(state.tasks.single, 'take_over');
      expect(posts(g).last['body'], {
        'expectedRevision': 5,
        'expectedGeneration': 3,
        'action': {'type': 'take_over'},
      });
      await state.task(state.tasks.single, 'stop');
      await state.suggestion(state.suggestions.single, 'snooze');
      for (final call in g.calls) {
        expect(call.$1, 'request');
        expect(call.$2['pairingStamp'], 'old-pairing');
        expect('${call.$2['path']}', isNot(contains('/start')));
        expect('${call.$2['path']}', isNot(contains('/api/sessions')));
      }
      state.dispose();
      c.dispose();
      await g.stream.close();
    },
  );

  test(
    'finite selected progress scopes, no auto activation, stable create retry key',
    () async {
      final g = FakeGateway();
      g.handler = (m, a) async {
        if (a['method'] == 'POST') throw PlatformException(code: 'offline');
        return overview();
      };
      final c = paired(g);
      final state = PotsState(c);
      await state.load();
      Future<bool> create({
        int observations = 2,
        List<String> scopes = const ['node:work'],
      }) => state.create(
        purpose: 'Purpose',
        scopes: scopes,
        observations: observations,
        dispatches: 0,
        concurrency: 1,
      );
      expect(await create(observations: 0), false);
      expect(await create(scopes: ['ungranted']), false);
      expect(posts(g), isEmpty);
      expect(await create(), false);
      expect(
        posts(g).length,
        1,
      ); // Failure reconciles by GET, not replayed POST.
      final body = obj(posts(g).single['body']);
      expect(body['scopes'], [
        {'workspaceId': 'node:work', 'access': 'progress'},
      ]);
      expect(body.containsKey('enabled'), false);
      expect(body.containsKey('actor'), false);
      expect(await create(), false);
      expect(
        obj(posts(g).last['body'])['idempotencyKey'],
        body['idempotencyKey'],
      );
      state.dispose();
      c.dispose();
      await g.stream.close();
    },
  );

  test(
    're-pair immediately clears records, rejects stale closures and late responses',
    () async {
      final g = FakeGateway();
      final stale = Completer<Json>(), fresh = Completer<Json>();
      var reads = 0;
      g.handler = (m, a) async {
        reads++;
        if (reads == 1) return overview();
        if (reads == 2) return stale.future;
        return fresh.future;
      };
      final c = paired(g), state = PotsState(c);
      await state.load();
      final old = state.suggestions.single;
      final pending = state.load();
      c.pairingStamp = 'new-pairing';
      c.changed();
      expect(state.snapshot, isNull);
      expect(await state.track(old), false);
      stale.complete(overview(account: 'stale-secret'));
      await pending;
      expect(state.snapshot, isNull);
      fresh.complete(overview(account: 'bob'));
      await Future<void>.delayed(Duration.zero);
      expect(state.snapshot?['accountKey'], 'bob');
      expect(await state.track(old), false);
      expect(posts(g), isEmpty);
      state.dispose();
      c.dispose();
      await g.stream.close();
    },
  );

  test(
    'late mutation after re-pair cannot overwrite or clear new account state',
    () async {
      final g = FakeGateway(), mutation = Completer<Json>();
      g.handler = (m, a) async => a['method'] == 'POST'
          ? mutation.future
          : overview(
              account: a['pairingStamp'] == 'old-pairing' ? 'alice' : 'bob',
            );
      final c = paired(g), state = PotsState(c);
      await state.load();
      final pending = state.track(state.suggestions.single);
      c.pairingStamp = 'new-pairing';
      c.changed();
      await Future<void>.delayed(Duration.zero);
      mutation.complete({});
      expect(await pending, false);
      expect(state.snapshot?['accountKey'], 'bob');
      expect(state.busy, false);
      expect(posts(g).single['pairingStamp'], 'old-pairing');
      state.dispose();
      c.dispose();
      await g.stream.close();
    },
  );

  test(
    'server owner change clears stale actions even with unchanged device identity',
    () async {
      var account = 'alice';
      final g = FakeGateway()
        ..handler = (m, a) async => overview(account: account);
      final c = paired(g);
      final state = PotsState(c);
      await state.load();
      final old = state.suggestions.single;
      account = 'bob';
      await state.load();
      expect(state.epoch, 1);
      expect(state.loading, false);
      expect(state.snapshot?['accountKey'], 'bob');
      expect(await state.track(old), false);
      expect(posts(g), isEmpty);
      state.dispose();
      c.dispose();
      await g.stream.close();
    },
  );

  test('expired, superseded and snoozed evidence cannot be tracked', () async {
    var now = DateTime.utc(2099);
    final g = FakeGateway()..handler = (m, a) async => overview();
    final c = paired(g);
    final state = PotsState(c, clock: () => now);
    await state.load();
    final s = state.suggestions.single;
    now = DateTime.utc(2100);
    expect(await state.track(s), false);
    now = DateTime.utc(2099);
    s['disposition'] = 'superseded';
    expect(await state.track(s), false);
    s['disposition'] = 'snoozed';
    s['snoozedUntil'] = futureExpiry;
    expect(await state.track(s), false);
    expect(posts(g), isEmpty);
    state.dispose();
    c.dispose();
    await g.stream.close();
  });

  test(
    'revoked/failed refresh hides former previews and old record actions',
    () async {
      final g = FakeGateway();
      var fail = false;
      g.handler = (m, a) async {
        if (fail) throw PlatformException(code: '404');
        return overview();
      };
      final c = paired(g), state = PotsState(c);
      await state.load();
      final old = state.suggestions.single;
      fail = true;
      await state.load();
      expect(state.snapshot, isNull);
      expect(state.error, isNotEmpty);
      expect(await state.track(old), false);
      state.dispose();
      c.dispose();
      await g.stream.close();
    },
  );

  for (final size in [const Size(390, 844), const Size(1024, 900)]) {
    testWidgets(
      'native pots at $size shows truthful tracking and source without dispatch',
      (t) async {
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = size;
        addTearDown(t.view.reset);
        final g = FakeGateway()..handler = (m, a) async => overview();
        final c = paired(g);
        String? opened;
        await t.pumpWidget(
          MaterialApp(
            theme: theme.build(Brightness.light),
            home: Scaffold(
              body: PotsPage(controller: c, onOpenChat: (id) => opened = id),
            ),
          ),
        );
        await t.pumpAndSettle();
        expect(posts(g), isEmpty);
        await t.scrollUntilVisible(
          find.text('Review source conversation'),
          500,
          scrollable: find
              .descendant(
                of: find.byType(ListView),
                matching: find.byType(Scrollable),
              )
              .first,
        );
        await t.drag(find.byType(ListView), const Offset(0, -180));
        await t.pumpAndSettle();
        await t.tap(find.text('Review source conversation'));
        await t.pump();
        expect(opened, 'source');
        expect(posts(g), isEmpty);
        await t.scrollUntilVisible(
          find.text('Start unavailable'),
          400,
          scrollable: find
              .descendant(
                of: find.byType(ListView),
                matching: find.byType(Scrollable),
              )
              .first,
        );
        final start = t.widget<OutlinedButton>(
          find.ancestor(
            of: find.text('Start unavailable'),
            matching: find.byType(OutlinedButton),
          ),
        );
        expect(start.onPressed, isNull);
        expect(
          find.text('No execution session. Tracking is not running.'),
          findsOneWidget,
        );
        expect(find.text('Stop tracking'), findsOneWidget);
        expect(t.takeException(), isNull);
        await t.pumpWidget(const SizedBox());
        c.dispose();
        await g.stream.close();
      },
    );
  }

  testWidgets(
    'outdated status is explicit and re-pair clears draft immediately',
    (t) async {
      final g = FakeGateway()
        ..handler = (m, a) async {
          final v = overview();
          (v['suggestions'] as List).single['disposition'] = 'needs_refresh';
          return v;
        };
      final c = paired(g);
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: PotsPage(controller: c, onOpenChat: (_) {}),
          ),
        ),
      );
      await t.pumpAndSettle();
      await t.enterText(find.byType(TextField).first, 'old private draft');
      c.pairingStamp = 'new-pairing';
      c.changed();
      await t.pumpAndSettle();
      expect(find.text('old private draft'), findsNothing);
      await t.scrollUntilVisible(
        find.text('Previous input request — recheck source'),
        500,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(
        find.text(
          'Outdated evidence. Refresh and review the source; no work is authorized.',
        ),
        findsOneWidget,
      );
      expect(find.text('Track only'), findsNothing);
      expect(posts(g), isEmpty);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );

  testWidgets('phone navigation opens pots through existing app transport', (
    t,
  ) async {
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(390, 844);
    addTearDown(t.view.reset);
    final g = FakeGateway();
    g.handler = (m, a) async =>
        m == 'request' && a['path'] == '/api/pots?limit=100'
        ? overview()
        : g.normal(m, a);
    final c = LiveController(g);
    await t.pumpWidget(MobileApp(theme: theme, controller: c));
    await t.pumpAndSettle();
    await t.tap(
      find.descendant(of: find.byType(MobileTabs), matching: find.text('pots')),
    );
    await t.pumpAndSettle();
    expect(find.byType(PotsPage), findsOneWidget);
    expect(posts(g), isEmpty);
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    await g.stream.close();
  });
}
