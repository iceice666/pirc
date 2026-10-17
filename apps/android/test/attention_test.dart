import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/attention.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/memory_settings.dart';
import 'package:pirc_mobile/live/mobile_tabs.dart';
import 'live_test.dart' show FakeGateway, theme;

Json fixture() => obj(
  jsonDecode(
    File('../../fixtures/mobile-parity/attention.json').readAsStringSync(),
  ),
);

class AttentionGateway extends FakeGateway {
  final data = fixture();
  Json get memory => obj(data['memory']);
  @override
  dynamic normal(String method, Json args) {
    if (method == 'wallInput') {
      return '${rows(data['missedRuns']).first['wallTime']}'.replaceFirst(
        ' ',
        'T',
      );
    }
    if (method == 'request') {
      final path = args['path'];
      for (final key in ['nodes', 'workspaces', 'sessions', 'schedules']) {
        if (path == '/api/$key') return {key: data[key]};
      }
      if (path == '/api/memory') return memory;
      if (path == '/api/schedules/daily') {
        return {
          'schedule': rows(data['schedules']).first,
          'runs': rows(data['missedRuns']).map((i) => i['run']).toList(),
        };
      }
    }
    return super.normal(method, args);
  }
}

Widget memoryApp(
  LiveController c, {
  ValueChanged<String>? onOpen,
  double scale = 1,
}) => MaterialApp(
  theme: theme.build(Brightness.light),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
    child: child!,
  ),
  home: Scaffold(
    body: SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: MemorySettings(controller: c, onOpenChat: onOpen),
    ),
  ),
);
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('memory source links scale once and remain tappable', (t) async {
    final g = AttentionGateway(), c = LiveController(g);
    (g.data['memory'] as Map)['sessions'] = {'chat': 'chat'};
    String? opened;
    await t.pumpWidget(memoryApp(c, onOpen: (id) => opened = id));
    await t.pumpAndSettle();
    final link = find.text('chat').first;
    final base = t.getRect(link).size;
    await t.pumpWidget(memoryApp(c, scale: 2, onOpen: (id) => opened = id));
    await t.pumpAndSettle();
    final enlarged = t.getRect(link).size;
    expect(enlarged.width, closeTo(base.width * 2, .01));
    expect(enlarged.height, closeTo(base.height * 2, .01));
    await t.ensureVisible(link);
    await t.tap(link);
    await t.pumpAndSettle();
    expect(opened, 'chat');
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });
  test(
    'all attention sources load, retain timezone and choose the next active schedule',
    () async {
      final g = AttentionGateway(), a = AttentionState(g);
      await a.refresh();
      expect(a.count, 2);
      expect(a.proposals.single['id'], 'p');
      expect(
        a.missedRuns.single['wallTime'],
        rows(g.data['missedRuns']).single['wallTime'],
      );
      expect(g.calls.singleWhere((c) => c.$1 == 'wallInput').$2, {
        'at': 1790960400000,
        'timezone': 'Asia/Taipei',
      });
      a.schedules.add({'id': 'paused', 'nextRunAt': 1, 'status': 'paused'});
      expect(a.nextSchedule?['id'], 'daily');
      expect(
        untilRun(120000, now: DateTime.fromMillisecondsSinceEpoch(0)),
        'in 2m',
      );
      a.dispose();
      await g.stream.close();
    },
  );
  test(
    'approval submits exactly the displayed target revision, stale reads cannot resurrect it',
    () async {
      final g = AttentionGateway(), a = AttentionState(g);
      await a.refreshMemory();
      final pending = Completer<Json>();
      g.handler = (m, args) async {
        if (m == 'request' && args['method'] == 'POST') {
          return {...g.memory, 'proposals': []};
        }
        if (m == 'request' && args['path'] == '/api/memory') {
          return pending.future;
        }
        return g.normal(m, args);
      };
      final stale = a.refreshMemory();
      await a.decideProposal(a.proposals.single, true);
      pending.complete(g.memory);
      await stale;
      expect(a.proposals, isEmpty);
      final post = g.calls.singleWhere((c) => c.$2['method'] == 'POST').$2;
      expect(post['path'], '/api/memory/proposals/p/approve');
      expect(post['body'], {'targetRevision': 1});
      a.dispose();
      await g.stream.close();
    },
  );
  test(
    'conflicting approval reloads the newer revision without automatically approving it',
    () async {
      final g = AttentionGateway(), a = AttentionState(g);
      await a.refreshMemory();
      g.handler = (m, args) async {
        if (args['method'] == 'POST') throw StateError('Revision changed');
        if (args['path'] == '/api/memory') {
          return {
            ...g.memory,
            'proposals': [
              {
                ...rows(g.memory['proposals']).single,
                'target': {
                  'id': 'u',
                  'content': 'Changed elsewhere',
                  'revision': 2,
                },
              },
            ],
          };
        }
        return g.normal(m, args);
      };
      await a.decideProposal(a.proposals.single, true);
      expect(obj(a.proposals.single['target'])['revision'], 2);
      expect(a.memoryError, 'Revision changed');
      expect(a.memoryBusy, isNull);
      expect(g.calls.where((c) => c.$2['method'] == 'POST').length, 1);
      // A later user-wide event / foreground review must not erase why the
      // decision failed. Only an explicit new decision clears that reason.
      await a.memoryChanged();
      await a.refreshMemory(preserveUnchanged: true);
      expect(a.memoryError, 'Revision changed');
      expect(obj(a.proposals.single['target'])['revision'], 2);
      expect(g.calls.where((c) => c.$2['method'] == 'POST').length, 1);
      g.handler = (_, args) async =>
          args['method'] == 'POST' ? {...g.memory, 'proposals': []} : g.memory;
      await a.decideProposal(a.proposals.single, false);
      expect(a.memoryError, isNull);
      expect(a.proposals, isEmpty);
      expect(g.calls.where((c) => c.$2['method'] == 'POST').length, 2);
      a.dispose();
      await g.stream.close();
    },
  );
  test(
    'account reset ignores old memory responses and mutation acknowledgements',
    () async {
      final g = AttentionGateway(), a = AttentionState(g);
      await a.refreshMemory();
      final pending = Completer<Json>();
      g.handler = (m, args) async => pending.future;
      final old = a.decideProposal(a.proposals.single, false);
      a.reset();
      pending.complete(g.memory);
      await old;
      expect(a.memory, isNull);
      expect(a.count, 0);
      expect(a.memoryBusy, isNull);
      a.dispose();
      await g.stream.close();
    },
  );
  test(
    'allow missed run coalesces taps and sends one POST with the original run id',
    () async {
      final g = AttentionGateway(), a = AttentionState(g);
      await a.refreshSchedules();
      final item = a.missedRuns.single;
      final pending = Completer<Json>();
      g.handler = (m, args) async {
        if (args['method'] == 'POST') return pending.future;
        return g.normal(m, args);
      };
      final first = a.decideMissed(item, true);
      await a.decideMissed(item, true);
      expect(a.runBusy, contains('missed-one'));
      pending.complete({});
      await first;
      final post = g.calls.singleWhere((c) => c.$2['method'] == 'POST').$2;
      expect(post['path'], '/api/schedules/daily/run');
      expect(post['body'], {'runId': 'missed-one'});
      expect(a.missedRuns, isEmpty);
      expect(a.runBusy, isEmpty);
      a.dispose();
      await g.stream.close();
    },
  );
  test(
    'failed dismiss preserves the run and visible error, without replaying POST',
    () async {
      final g = AttentionGateway(), a = AttentionState(g);
      await a.refreshSchedules();
      g.handler = (m, args) async {
        if (args['method'] == 'POST') throw StateError('Connection lost');
        return g.normal(m, args);
      };
      await a.decideMissed(a.missedRuns.single, false);
      expect(a.missedRuns.length, 1);
      expect(a.scheduleError, 'Connection lost');
      final post = g.calls.singleWhere((c) => c.$2['method'] == 'POST').$2;
      expect(post['path'], '/api/schedules/daily/runs/missed-one/dismiss');
      expect(post['body'], isNull);
      a.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'phone inbox and Work badge include questions, missed runs and memory',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(390, 844);
      addTearDown(t.view.reset);
      final g = AttentionGateway(), c = LiveController(g)..mode = 'work';
      await t.pumpWidget(MobileApp(theme: theme, controller: c));
      await t.pumpAndSettle();
      expect(c.attentionCount, 3);
      expect(t.widget<MobileTabs>(find.byType(MobileTabs)).waiting, 3);
      expect(find.text('Reply'), findsOneWidget);
      expect(find.text('Allow & run'), findsOneWidget);
      expect(find.text('Approve'), findsOneWidget);
      expect(find.textContaining('Missed · '), findsOneWidget);
      await t.tap(find.text('Update memory'));
      await t.pumpAndSettle();
      expect(find.text('About you · USER'), findsOneWidget);
      expect(find.text('Now: I prefer concise answers.'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
      await g.stream.close();
    },
  );
  testWidgets(
    'forget requires the second inline click; restore history sends the selected version',
    (t) async {
      final g = AttentionGateway(), c = LiveController(g);
      g.handler = (m, args) async {
        if ('${args['path']}'.endsWith('/history')) {
          return {
            'versions': [
              {
                'revision': 1,
                'op': 'add',
                'content': 'Earlier text',
                'actor': 'user:me',
                'at': 1790960400000,
              },
            ],
          };
        }
        if ('${args['path']}'.endsWith('/forget')) {
          return {...g.memory, 'user': []};
        }
        if ('${args['path']}'.endsWith('/restore')) return g.memory;
        return g.normal(m, args);
      };
      await t.pumpWidget(memoryApp(c));
      await t.pumpAndSettle();
      await t.ensureVisible(find.text('History'));
      await t.tap(find.text('History'));
      await t.pumpAndSettle();
      await t.ensureVisible(find.text('Restore this'));
      await t.tap(find.text('Restore this'));
      await t.pumpAndSettle();
      expect(
        g.calls
            .singleWhere((c) => '${c.$2['path']}'.endsWith('/restore'))
            .$2['body'],
        {'revision': 1},
      );
      await t.ensureVisible(find.text('Forget'));
      await t.tap(find.text('Forget'));
      await t.pumpAndSettle();
      expect(
        g.calls.where((c) => '${c.$2['path']}'.endsWith('/forget')),
        isEmpty,
      );
      await t.ensureVisible(find.text('Forget for good'));
      await t.tap(find.text('Forget for good'));
      await t.pumpAndSettle();
      expect(
        g.calls.where((c) => '${c.$2['path']}'.endsWith('/forget')).length,
        1,
      );
      expect(
        find.text(
          'Nothing yet. When you tell the assistant about yourself, it asks you here first.',
        ),
        findsOneWidget,
      );
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'history requests do not leak a late version into another entry',
    (t) async {
      final g = AttentionGateway(),
          c = LiveController(g),
          late = Completer<Json>();
      g.data['memory'] = {
        ...g.memory,
        'proposals': [],
        'user': [
          ...rows(g.memory['user']),
          {
            ...rows(g.memory['user']).single,
            'id': 'u2',
            'content': 'Second entry',
          },
        ],
      };
      g.handler = (m, args) async {
        if (args['path'] == '/api/memory/entries/u/history') return late.future;
        if (args['path'] == '/api/memory/entries/u2/history') {
          return {
            'versions': [
              {
                'revision': 1,
                'op': 'add',
                'content': 'Second history',
                'actor': 'user:me',
                'at': 1790960400000,
              },
            ],
          };
        }
        return g.normal(m, args);
      };
      await t.pumpWidget(memoryApp(c));
      await t.pumpAndSettle();
      await t.tap(find.text('History').first);
      await t.pump();
      await t.tap(find.text('History').last);
      await t.pumpAndSettle();
      late.complete({
        'versions': [
          {
            'revision': 1,
            'content': 'Wrong late history',
            'actor': 'user:me',
            'at': 1790960400000,
          },
        ],
      });
      await t.pumpAndSettle();
      expect(find.text('Second history'), findsOneWidget);
      expect(find.text('Wrong late history'), findsNothing);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  test(
    'chat deletion refresh wins over an older memory mutation response',
    () async {
      final g = AttentionGateway(), a = AttentionState(g);
      await a.refreshMemory();
      final pending = Completer<Json>();
      g.handler = (m, args) async {
        if (args['method'] == 'POST') return pending.future;
        if (args['path'] == '/api/memory') {
          return {...g.memory, 'proposals': [], 'user': []};
        }
        return g.normal(m, args);
      };
      final approval = a.decideProposal(a.proposals.single, true);
      await a.memoryChanged();
      pending.complete(g.memory);
      await approval;
      expect(a.proposals, isEmpty);
      expect(rows(a.memory?['user']), isEmpty);
      a.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'native change events debounce, ignore old sessions and reconcile after reconnect',
    (t) async {
      final g = AttentionGateway(), c = LiveController(g);
      await c.boot();
      await c.open('s');
      g.publish('s');
      await t.pump();
      g.calls.clear();
      for (var i = 0; i < 4; i++) {
        g.stream.add({
          'type': 'indexChange',
          'sessionId': 's',
          'data': 'memory_changed',
        });
      }
      g.stream.add({
        'type': 'indexChange',
        'sessionId': 'old',
        'data': 'schedules_changed',
      });
      await t.pump(const Duration(milliseconds: 251));
      expect(g.calls.where((x) => x.$2['path'] == '/api/memory').length, 1);
      expect(g.calls.where((x) => x.$2['path'] == '/api/schedules'), isEmpty);
      g.calls.clear();
      g.stream.add({
        'type': 'connection',
        'sessionId': 's',
        'data': 'reconnecting',
      });
      g.stream.add({'type': 'connection', 'sessionId': 's', 'data': 'live'});
      await t.pump();
      expect(g.calls.where((x) => x.$2['path'] == '/api/memory').length, 1);
      expect(g.calls.where((x) => x.$2['path'] == '/api/schedules').length, 1);
      expect(g.calls.where((x) => x.$2['path'] == '/api/sessions').length, 1);
      c.dispose();
      await g.stream.close();
    },
  );
  test(
    'partial schedule detail failure is visible and retains previously shown runs',
    () async {
      final g = AttentionGateway(), a = AttentionState(g);
      await a.refreshSchedules();
      g.handler = (method, args) async {
        if (args['path'] == '/api/schedules/daily') {
          throw StateError('Unavailable');
        }
        return g.normal(method, args);
      };
      await a.refreshSchedules();
      expect(a.missedRuns.length, 1);
      expect(a.scheduleError, 'Daily review: Unavailable');
      a.reset();
      await a.refreshSchedules();
      expect(a.missedRuns, isEmpty);
      expect(a.scheduleError, 'Daily review: Unavailable');
      a.dispose();
      await g.stream.close();
    },
  );
  for (final width in [390.0, 768.0]) {
    testWidgets('memory at $width and 2x text remains usable', (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = Size(width, 900);
      t.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(t.view.reset);
      addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
      final g = AttentionGateway(), c = LiveController(g);
      String? opened;
      await t.pumpWidget(memoryApp(c, onOpen: (id) => opened = id));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      await t.ensureVisible(find.text('Working preferences').first);
      await t.tap(find.text('Working preferences').first);
      expect(opened, 'chat');
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    });
  }
}
