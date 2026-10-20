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

Json fixture() {
  final data = obj(
    jsonDecode(
      File('../../fixtures/mobile-parity/memory.json').readAsStringSync(),
    ),
  );
  data['memory'] = {...obj(data['memory']), 'notes': [], 'removed': []};
  return data;
}

class AttentionGateway extends FakeGateway {
  final data = fixture();
  Json get memory => obj(data['memory']);
  @override
  dynamic normal(String method, Json args) {
    if (method == 'request') {
      final path = args['path'];
      for (final key in ['nodes', 'workspaces', 'sessions']) {
        if (path == '/api/$key') return {key: data[key]};
      }
      if (path == '/api/memory') return memory;
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
    'account reset ignores old memory responses and mutation acknowledgements',
    () async {
      final g = AttentionGateway(), a = AttentionState(g);
      await a.refreshMemory();
      final pending = Completer<Json>();
      g.handler = (m, args) async => pending.future;
      final old = a.forget('u');
      a.reset();
      pending.complete(g.memory);
      await old;
      expect(a.memory, isNull);
      expect(a.memoryBusy, isNull);
      a.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'phone inbox and Work badge count sessions waiting for an answer',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(390, 844);
      addTearDown(t.view.reset);
      final g = AttentionGateway(), c = LiveController(g);
      await t.pumpWidget(MobileApp(theme: theme, controller: c));
      await t.pumpAndSettle();
      expect(c.attentionCount, 1);
      expect(t.widget<MobileTabs>(find.byType(MobileTabs)).waiting, 1);
      expect(find.text('Reply'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
      await g.stream.close();
    },
  );
  testWidgets(
    'a delegated session waiting on a relayed approval offers Allow and Deny',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(390, 844);
      addTearDown(t.view.reset);
      final g = AttentionGateway();
      g.data['sessions'] = [
        {
          ...rows(g.data['sessions']).first,
          'origin': {
            'kind': 'delegation',
            'delegationId': 'd1',
            'fromSessionId': 'chat',
            'title': 'Fix build',
            'status': 'waiting_input',
            'approval': {
              'sessionId': 'chat',
              'interactionId': 'relay.d1.interaction_7',
              'title': 'Run rm -rf build?',
              'message': 'Auto mode stopped a dangerous command',
            },
          },
        },
        ...rows(g.data['sessions']).skip(1),
      ];
      g.handler = (m, args) async =>
          m == 'answerRelayed' ? {} : g.normal(m, args);
      final c = LiveController(g);
      await t.pumpWidget(MobileApp(theme: theme, controller: c));
      await t.pumpAndSettle();
      expect(find.text('Run rm -rf build?'), findsOneWidget);
      expect(find.text('Reply'), findsOneWidget);
      expect(find.text('Deny'), findsOneWidget);
      await t.tap(find.text('Allow'));
      await t.pumpAndSettle();
      final call = g.calls.singleWhere((c) => c.$1 == 'answerRelayed').$2;
      expect(call['sessionId'], 'chat');
      expect(call['interactionId'], 'relay.d1.interaction_7');
      expect(call['confirmed'], true);
      // No lease is taken to answer it.
      expect(
        g.calls.where((c) => c.$1 == 'control' && c.$2['acquire'] == true),
        isEmpty,
      );
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
      expect(find.text('Nothing yet.'), findsOneWidget);
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
    'an external memory change wins over an older mutation response',
    () async {
      final g = AttentionGateway(), a = AttentionState(g);
      await a.refreshMemory();
      final pending = Completer<Json>();
      g.handler = (m, args) async {
        if (args['method'] == 'POST') return pending.future;
        if (args['path'] == '/api/memory') return {...g.memory, 'user': []};
        return g.normal(m, args);
      };
      final mutation = a.restore('u', revision: 1);
      await a.memoryChanged();
      pending.complete(g.memory);
      await mutation;
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
        'data': 'memory_changed',
      });
      await t.pump(const Duration(milliseconds: 251));
      expect(g.calls.where((x) => x.$2['path'] == '/api/memory').length, 1);
      g.calls.clear();
      g.stream.add({
        'type': 'connection',
        'sessionId': 's',
        'data': 'reconnecting',
      });
      g.stream.add({'type': 'connection', 'sessionId': 's', 'data': 'live'});
      await t.pump();
      expect(g.calls.where((x) => x.$2['path'] == '/api/memory').length, 1);
      expect(g.calls.where((x) => x.$2['path'] == '/api/sessions').length, 1);
      c.dispose();
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
