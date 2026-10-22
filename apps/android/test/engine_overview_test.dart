import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/app_document_route.dart';
import 'package:pirc_mobile/live/engine_overview.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show FakeGateway, theme;
import 'rooms_test.dart' show RoomsGateway, pumpRooms;

const now = 1_000_000_000_000;

/// The engine's routes, answered from fixed data; every request is recorded.
class EngineGateway extends FakeGateway {
  final requests = <(String, String, Object?)>[];

  @override
  dynamic normal(String method, Json args) {
    if (method != 'request') return super.normal(method, args);
    final path = '${args['path']}';
    final verb = '${args['method'] ?? 'GET'}';
    requests.add((verb, path, args['body']));
    if (verb != 'GET') return {};
    if (path == '/api/rooms?archived=1') {
      return {
        'rooms': [
          {'id': 'general', 'name': 'general'},
          {'id': 'slime', 'name': 'SlimeOS'},
        ],
      };
    }
    if (path == '/api/nodes') {
      return {
        'nodes': [
          {
            'id': 'desk',
            'lastSeenAt': now - 120000,
            'workspaces': [
              {'id': 'w', 'displayName': 'slimeos'},
            ],
            'capabilities': {
              'os': 'linux',
              'arch': 'x86_64',
              'gpus': [
                {
                  'vendor': 'nvidia',
                  'count': 2,
                  'model': 'RTX 4090',
                  'vramMb': 24576,
                },
              ],
              'browser': true,
              'terminals': true,
              'sandbox': {'backend': 'bwrap', 'status': 'ready'},
            },
            'load': {'running': 1, 'max': 4},
          },
        ],
      };
    }
    if (path.startsWith('/api/brain/turns')) {
      return {
        'turns': [
          {
            'id': 't1',
            'kind': 'wake',
            'startedAt': now - 5000,
            'endedAt': now - 2500,
            'outcome': 'preempted',
            'usage': {'totalTokens': 1234},
          },
        ],
      };
    }
    if (path == '/api/loops?status=open') {
      return {
        'loops': [
          {
            'id': 'l1',
            'what': 'Renew the visa',
            'why': 'expires soon',
            'roomId': 'slime',
            'dueAt': null,
            'anchor': null,
          },
        ],
      };
    }
    if (path.startsWith('/api/loops?status=closed')) {
      return {
        'loops': [
          {
            'id': 'l2',
            'what': 'Book flights',
            'closedReason': 'done',
            'closedAt': now - 60000,
          },
        ],
      };
    }
    if (path.startsWith('/api/wakes')) {
      return {
        'wakes': [
          {
            'id': 'w1',
            'kind': 'self',
            'trigger': {'why': 'the CI'},
            'roomId': 'slime',
            'scheduledAt': now + 3600000,
            'startedAt': null,
            'outcome': null,
          },
          {
            'id': 'w2',
            'kind': 'anchor',
            'trigger': {'moment': 'eve'},
            'roomId': 'general',
            'scheduledAt': now - 3600000,
            'endedAt': now - 3500000,
            'outcome': 'silent',
            'note': null,
          },
        ],
        'today': {'used': 2, 'limit': 24},
      };
    }
    if (path == '/api/memory/preferences') {
      return {
        'usage': {'used': 30, 'max': 2000},
        'preferences': [
          {
            'id': 'p1',
            'content': 'Answer in Chinese',
            'revision': 2,
            'createdInRoom': 'general',
          },
        ],
        'removed': [
          {'id': 'p0', 'content': 'Use metric', 'revision': 1},
        ],
      };
    }
    if (path.startsWith('/api/memory/records')) {
      return {
        'records': [
          {
            'id': 'f1',
            'kind': 'fact',
            'content': 'CI runs on Fridays',
            'date': '2026-10-01',
          },
        ],
      };
    }
    if (path == '/api/sources') {
      return {
        'sources': [
          {
            'id': 's1',
            'kind': 'email',
            'name': 'School mail',
            'pausedAt': null,
            'lastPolledAt': now - 300000,
            'lastError': null,
            'failures': 0,
            'rooms': ['slime'],
          },
        ],
      };
    }
    return super.normal(method, args);
  }
}

Future<EngineGateway> pumpOverview(
  WidgetTester t,
  String section, {
  ValueNotifier<int>? loops,
}) async {
  t.view.devicePixelRatio = 1;
  t.view.physicalSize = const Size(390, 844);
  addTearDown(t.view.reset);
  final g = EngineGateway();
  await t.pumpWidget(
    MaterialApp(
      theme: theme.build(Brightness.light),
      home: EngineOverview(
        gateway: g,
        section: section,
        clock: () => now,
        loopsRevision: loops,
      ),
    ),
  );
  await t.pumpAndSettle();
  return g;
}

void main() {
  test('wakes, turns, tokens and sources read like the web', () {
    expect(
      describeTrigger({
        'kind': 'self',
        'trigger': {'why': 'the CI'},
      }),
      'Coming back to look at: the CI',
    );
    expect(
      describeTrigger({
        'kind': 'anchor',
        'trigger': {'moment': 'eve'},
      }),
      'The day before an open loop is due',
    );
    expect(
      describeTrigger({
        'kind': 'source',
        'trigger': {'name': 'Mail', 'reason': 'loop'},
      }),
      'Something new in Mail touched an open loop',
    );
    expect(
      describeWakeOutcome({'outcome': 'quota'}),
      "Skipped: today's wakes were used up",
    );
    expect(describeWakeOutcome({'outcome': null, 'startedAt': 5}), 'Awake now');
    expect(turnOutcome({'outcome': 'preempted'}), 'Cut short by new messages');
    expect(turnOutcome({'outcome': null}), 'Running');
    expect(tokens(1234), '1.2k tokens');
    expect(tokens(null), '0 tokens');
    expect(sourceHealth({'pausedAt': 1}), 'Paused');
    expect(sourceHealth({'failures': 3}), 'Failing (3 in a row)');
    expect(agoMs(now - 120000, clock: () => now), '2 min ago');
  });

  test('links name rooms and the engine like the web', () {
    NativeAppDocumentRouteTarget? target(String url) =>
        NativeAppDocumentRoute.parse(
          url,
          appRootUrl: 'https://pirc.test/',
        )?.target;
    expect(
      (target('https://pirc.test/?room=slime')! as NativeAppRoomRouteTarget)
          .roomId,
      'slime',
    );
    expect(
      (target('https://pirc.test/engine?open=loops')!
              as NativeAppEngineRouteTarget)
          .section,
      'loops',
    );
    expect(
      (target('https://pirc.test/engine')! as NativeAppEngineRouteTarget)
          .section,
      'nodes',
    );
    expect(
      (target('https://pirc.test/engine?open=bogus')!
              as NativeAppEngineRouteTarget)
          .section,
      'nodes',
    );
    expect(
      target('https://pirc.test/engine?session=s1'),
      isA<NativeAppSessionRouteTarget>(),
    );
    // The older links still work.
    expect(
      target('https://pirc.test/?session=s1'),
      isA<NativeAppSessionRouteTarget>(),
    );
    expect(
      target('https://pirc.test/?open=memory'),
      isA<NativeAppMemoryRouteTarget>(),
    );
    expect(
      NativeAppDocumentRoute.parse(
        'https://pirc.test/other',
        appRootUrl: 'https://pirc.test/',
      ),
      isNull,
    );
  });

  testWidgets('six tabs, opening on the one asked for', (t) async {
    await pumpOverview(t, 'memory');
    for (final label in [
      'Nodes',
      'Brain',
      'Open loops',
      'Wakes',
      'Memory',
      'Sources',
    ]) {
      expect(find.text(label), findsOneWidget);
    }
    expect(find.text('Answer in Chinese'), findsOneWidget);
  });

  testWidgets('nodes say what they can do and how busy they are', (t) async {
    await pumpOverview(t, 'nodes');
    expect(find.text('desk'), findsOneWidget);
    expect(find.text('GPU: nvidia ×2 RTX 4090 24 GB'), findsOneWidget);
    expect(find.text('Running 1 of 4'), findsOneWidget);
    expect(find.text('Workspaces: slimeos'), findsOneWidget);
  });

  testWidgets("a room's brain turns", (t) async {
    final g = await pumpOverview(t, 'brain');
    expect(
      g.requests.any((r) => r.$2 == '/api/brain/turns?room=general&limit=20'),
      isTrue,
    );
    expect(find.text('Came back on its own'), findsOneWidget);
    expect(find.textContaining('Cut short by new messages'), findsOneWidget);
    expect(find.textContaining('2.5 s · 1.2k tokens'), findsOneWidget);
  });

  testWidgets('open loops close, reopen and follow the stream', (t) async {
    final loops = ValueNotifier(0);
    final g = await pumpOverview(t, 'loops', loops: loops);
    await t.tap(find.text('Not needed'));
    await t.pumpAndSettle();
    final closed = g.requests.where((r) => r.$1 == 'PATCH').single;
    expect(closed.$2, '/api/loops/l1');
    expect(closed.$3, {'status': 'closed'});
    await t.tap(find.text('Not done yet'));
    await t.pumpAndSettle();
    expect(g.requests.where((r) => r.$1 == 'PATCH').last.$3, {
      'status': 'open',
    });
    final reads = g.requests
        .where((r) => r.$2 == '/api/loops?status=open')
        .length;
    loops.value++;
    await t.pumpAndSettle();
    expect(
      g.requests.where((r) => r.$2 == '/api/loops?status=open').length,
      reads + 1,
    );
  });

  testWidgets('wakes coming can be called off', (t) async {
    final g = await pumpOverview(t, 'wakes');
    expect(find.text('Today: 2 of 24'), findsOneWidget);
    expect(find.text('Coming back to look at: the CI'), findsOneWidget);
    expect(find.text('Recent wakes · 1'), findsOneWidget);
    await t.tap(find.text('Cancel'));
    await t.pumpAndSettle();
    expect(
      g.requests.any((r) => r.$1 == 'DELETE' && r.$2 == '/api/wakes/w1'),
      isTrue,
    );
  });

  testWidgets(
    'memory: preferences change on your word, facts are found and forgotten',
    (t) async {
      final g = await pumpOverview(t, 'memory');
      expect(find.text('Preferences · 30 of 2000 characters'), findsOneWidget);
      await t.tap(find.byTooltip('Preference actions'));
      await t.pumpAndSettle();
      await t.tap(find.text('Remove').last);
      await t.pumpAndSettle();
      expect(
        g.requests.any(
          (r) => r.$1 == 'POST' && r.$2 == '/api/memory/preferences/p1/remove',
        ),
        isTrue,
      );
      await t.tap(find.text('Restore'));
      await t.pumpAndSettle();
      expect(
        g.requests.any(
          (r) => r.$1 == 'POST' && r.$2 == '/api/memory/preferences/p0/restore',
        ),
        isTrue,
      );
      await t.enterText(find.byType(TextField), 'CI');
      await t.pump(const Duration(milliseconds: 400));
      await t.pumpAndSettle();
      expect(
        g.requests.any((r) => r.$2 == '/api/memory/records?scope=person&q=CI'),
        isTrue,
      );
      await t.tap(find.text('Forget'));
      await t.pumpAndSettle();
      expect(
        g.requests.any(
          (r) => r.$1 == 'DELETE' && r.$2 == '/api/memory/records/f1',
        ),
        isTrue,
      );
    },
  );

  testWidgets('sources say how reading goes and pause', (t) async {
    final g = await pumpOverview(t, 'sources');
    expect(find.text('School mail · email'), findsOneWidget);
    expect(find.text('Read 5 min ago · followed in #SlimeOS'), findsOneWidget);
    await t.tap(find.text('Pause'));
    await t.pumpAndSettle();
    expect(
      g.requests.any((r) => r.$1 == 'POST' && r.$2 == '/api/sources/s1/pause'),
      isTrue,
    );
  });

  testWidgets("a line's Details opens the engine at its section", (t) async {
    await pumpRooms(t, gateway: RoomsGateway());
    final c = t.widget<MobileApp>(find.byType(MobileApp)).controller;
    c.showEngine(section: 'loops');
    await t.pumpAndSettle();
    expect(find.byType(EngineOverview), findsOneWidget);
    expect(
      t.widget<EngineOverview>(find.byType(EngineOverview)).section,
      'loops',
    );
    expect(c.engineSection, isNull);
  });
}
