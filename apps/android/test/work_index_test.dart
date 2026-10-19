import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/work_index.dart';
import 'package:pirc_mobile/live/modes.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'package:pirc_mobile/live/workspace_settings.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'live_test.dart' show FakeGateway, theme;

const project = <String, dynamic>{
  'id': 'assistant:project',
  'hostId': 'assistant',
  'displayName': 'Trip',
  'kind': 'chat',
};
const directory = <String, dynamic>{
  'id': 'device:project',
  'hostId': 'device',
  'displayName': 'Project',
  'kind': 'directory',
};
Json session(
  String id, {
  bool unread = false,
  bool pinned = false,
  bool done = false,
  String? schedule,
  String? status,
}) => {
  'id': id,
  'name': id,
  'workspaceId': project['id'],
  'unread': unread,
  if (pinned) 'pinnedAt': 1,
  if (done) 'settledAt': 2,
  'runStatus': ?status,
  if (schedule != null)
    'origin': {
      'kind': 'schedule',
      'scheduleId': schedule,
      'title': 'Daily review',
    },
};
LiveController fixture(FakeGateway g) => LiveController(g)
  ..booting = false
  ..origin = 'https://gateway.example'
  ..workspaces = [project, directory]
  ..nodes = [
    {'id': 'assistant'},
    {'id': 'device'},
  ];
Widget host(Widget child) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: Scaffold(body: child),
);
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('stable pin partition and unread/open sidebar match the web index', () {
    final list = [
      session('new'),
      session('pin', pinned: true),
      session('read'),
      session('unread', unread: true),
      session('waiting', unread: true, status: 'waiting_input'),
    ];
    expect(pinnedFirst(list).map((s) => s['id']), [
      'pin',
      'new',
      'read',
      'unread',
      'waiting',
    ]);
    expect(
      sidebarSessions(
        list,
        '${project['id']}',
        'read',
        skipWaiting: true,
      ).map((s) => s['id']),
      ['read', 'unread'],
    );
    expect(
      sidebarSessions(
        list,
        '${project['id']}',
        'waiting',
        skipWaiting: true,
      ).map((s) => s['id']),
      ['unread', 'waiting'],
    );
    final groups = foldRecent(
      pinnedFirst([
        session('a', schedule: 'x'),
        session('b'),
        session('c', schedule: 'x'),
        session('d', schedule: 'x', pinned: true),
        session('e', schedule: 'y'),
      ]),
    );
    expect(groups.length, 4);
    expect(groups.first.sessions.single['id'], 'd');
    expect(groups[1].sessions.map((s) => s['id']), ['a', 'c']);
    expect(groups[1].folded, true);
    expect(groups.last.folded, false);
  });
  test('hosts retain offline workspaces and exclude assistant nodes', () {
    final list = workHosts(
      [
        {'id': 'assistant:chats', 'hostId': 'assistant', 'kind': 'chat'},
        directory,
        {'id': 'offline:old', 'hostId': 'offline'},
      ],
      [
        {'id': 'assistant'},
        {'id': 'device'},
        {'id': 'empty'},
      ],
      ModeCatalog(),
    );
    expect(list.map((h) => h['id']), ['device', 'empty', 'offline']);
    expect(list.last['online'], false);
    expect(rows(list[1]['workspaces']), isEmpty);
  });
  test(
    'read acknowledgements require visible foreground chat and coalesce',
    () async {
      final g = FakeGateway(), pending = Completer<Json>();
      final c = fixture(g)
        ..sessions = [session('s', unread: true)]
        ..sessionId = 's';
      g.handler = (method, args) async =>
          method == 'request' && args['path'] == '/api/sessions/s/read'
          ? pending.future
          : g.normal(method, args);
      await c.markVisibleRead();
      c.sessionVisible = true;
      c.active = false;
      await c.markVisibleRead();
      expect(g.calls, isEmpty);
      c.active = true;
      final one = c.markVisibleRead();
      await c.markVisibleRead();
      expect(g.calls.length, 1);
      expect(c.sessions.single['unread'], true);
      pending.complete({});
      await one;
      expect(c.sessions.single['unread'], false);
      c.dispose();
      await g.stream.close();
    },
  );
  test(
    'late deletion keeps another selected chat and its draft, filters stale index',
    () async {
      final g = FakeGateway(), pending = Completer<Json>();
      final old = session('old');
      final c = fixture(g)
        ..sessions = [old, session('new')]
        ..sessionId = 'old'
        ..draft = 'old draft';
      g.handler = (method, args) async {
        if (method == 'request' && args['method'] == 'DELETE') {
          return pending.future;
        }
        if (method == 'request' && args['path'] == '/api/sessions') {
          return {
            'sessions': [old, session('new')],
          };
        }
        return g.normal(method, args);
      };
      final deleting = c.deleteChat('old');
      c.sessionId = 'new';
      c.draft = 'new draft';
      pending.complete({});
      await deleting;
      expect(c.sessionId, 'new');
      expect(c.draft, 'new draft');
      expect(g.calls.where((x) => x.$1 == 'unwatch'), isEmpty);
      expect(g.drafts['old'], '');
      await c.refreshList();
      expect(c.sessions.map((s) => s['id']), ['new']);
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'workspace history includes read sessions, folds schedules and searches done',
    (t) async {
      final g = FakeGateway(), c = fixture(g);
      c.sessions = [
        session('Read conversation'),
        session('Completed', done: true),
        session('First run', schedule: 'daily'),
        session('Second run', schedule: 'daily'),
        session('Pinned run', pinned: true, schedule: 'daily'),
      ];
      String? selected;
      await t.pumpWidget(
        host(
          WorkspacePage(
            controller: c,
            workspaceId: '${project['id']}',
            onBack: () {},
            onOpen: (id) => selected = id,
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(find.text('Read conversation'), findsOneWidget);
      expect(find.text('Completed'), findsNothing);
      expect(find.text('Pinned run'), findsOneWidget);
      expect(find.text('First run'), findsNothing);
      await t.tap(find.text('Daily review'));
      await t.pumpAndSettle();
      expect(find.text('First run'), findsOneWidget);
      await t.tap(find.text('Read conversation'));
      await t.pump(const Duration(milliseconds: 350));
      expect(selected, 'Read conversation');
      await t.enterText(find.byType(TextField), 'Completed');
      await t.pumpAndSettle();
      expect(find.text('Completed'), findsWidgets);
      expect(find.text('Read conversation'), findsNothing);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'delete dialog warns about memories and preserves failure without repeating DELETE',
    (t) async {
      final g = FakeGateway(),
          c = fixture(g)..sessions = [session('Trip plans')];
      g.handler = (method, args) async {
        if (method == 'request' && args['method'] == 'DELETE') {
          throw StateError('Connection lost');
        }
        return g.normal(method, args);
      };
      await t.pumpWidget(
        host(
          WorkspacePage(
            controller: c,
            workspaceId: '${project['id']}',
            onBack: () {},
            onOpen: (_) {},
          ),
        ),
      );
      await t.pumpAndSettle();
      await t.tap(find.byTooltip('Delete Trip plans'));
      await t.pumpAndSettle();
      expect(
        find.textContaining('USER memories and MEMORY notes'),
        findsOneWidget,
      );
      expect(
        find.textContaining('Memories created by other chats are kept.'),
        findsOneWidget,
      );
      await t.tap(find.text('Delete chat and memories'));
      await t.pumpAndSettle();
      expect(find.text('Connection lost'), findsOneWidget);
      expect(find.text('Delete chat?'), findsOneWidget);
      expect(c.sessions.length, 1);
      expect(g.calls.where((x) => x.$2['method'] == 'DELETE').length, 1);
      await t.tap(find.text('Cancel'));
      await t.pumpAndSettle();
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets('capability switch remains server-owned when save fails', (
    t,
  ) async {
    final g = FakeGateway(), c = fixture(g);
    g.handler = (method, args) async {
      if (method == 'request' && '${args['path']}'.endsWith('/capabilities')) {
        if (args['method'] == 'PATCH') {
          throw PlatformException(code: 'HTTP_403', message: 'Policy denied');
        }
        return {
          'capabilities': {
            'delegation': true,
            'memory_search': true,
            'remote_recall': true,
            'schedules': true,
            'web_search': true,
          },
        };
      }
      if (method == 'request' && '${args['path']}'.endsWith('/instructions')) {
        return {
          'instructions': {'text': 'Keep answers concise', 'maxChars': 80},
        };
      }
      return g.normal(method, args);
    };
    await t.pumpWidget(
      host(
        SingleChildScrollView(
          child: WorkspaceSettings(controller: c, workspace: project),
        ),
      ),
    );
    await t.pumpAndSettle();
    final check = find.descendant(
      of: find.byKey(const ValueKey('capability-checkbox-delegation')),
      matching: find.byType(Checkbox),
    );
    await t.ensureVisible(check);
    await t.tap(check);
    await t.pumpAndSettle();
    expect(t.widget<Checkbox>(check).value, true);
    expect(find.text('Policy denied'), findsOneWidget);
    final patch = g.calls.singleWhere((x) => x.$2['method'] == 'PATCH');
    expect(patch.$2['body'], {
      'capabilities': {'delegation': false},
    });
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });
  testWidgets(
    'trust sends only the reviewed hash, reloads conflict without retrying trust',
    (t) async {
      final g = FakeGateway(), c = fixture(g);
      var reads = 0;
      g.handler = (method, args) async {
        if (method == 'request' &&
            '${args['path']}'.endsWith('/project-config')) {
          reads++;
          return {
            'project': {
              'hash': reads == 1 ? 'reviewed' : 'changed',
              'trustedHash': null,
              'trusted': false,
              'empty': false,
              'hooks': {},
              'env': {'MODE': reads == 1 ? 'safe' : 'changed'},
              'allowedPaths': [],
            },
          };
        }
        if (method == 'request' &&
            '${args['path']}'.endsWith('/project-trust')) {
          throw PlatformException(
            code: 'HTTP_409',
            message: 'Config changed. Review again.',
          );
        }
        return g.normal(method, args);
      };
      await t.pumpWidget(
        host(
          SingleChildScrollView(
            child: WorkspaceSettings(controller: c, workspace: directory),
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(g.calls.where((x) => x.$2['method'] == 'POST'), isEmpty);
      await t.ensureVisible(find.text('Trust'));
      await t.tap(find.text('Trust'));
      await t.pumpAndSettle();
      final sent = g.calls.where((x) => x.$2['method'] == 'POST').toList();
      expect(sent.length, 1);
      expect(sent.single.$2['body'], {'trusted': true, 'hash': 'reviewed'});
      expect(reads, 2);
      expect(find.text('MODE=changed'), findsOneWidget);
      expect(find.text('Config changed. Review again.'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  for (final width in [390.0, 768.0]) {
    testWidgets('workspace and sidebar remain usable at $width / 2x text', (
      t,
    ) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = Size(width, 900);
      t.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(t.view.reset);
      addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
      final g = FakeGateway(),
          c = fixture(g)
            ..mode = 'work'
            ..sessions = [
              {
                ...session('Waiting for approval', status: 'waiting_input'),
                'workspaceId': directory['id'],
              },
            ];
      await t.pumpWidget(
        host(
          SessionSidebar(
            controller: c,
            onOpen: (_) {},
            onWorkspace: (_) {},
            onPage: (_) {},
            onCollapse: () {},
            onMode: (_) {},
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      await t.pumpWidget(
        host(
          WorkspacePage(
            controller: c,
            workspaceId: '${directory['id']}',
            onBack: () {},
            onOpen: (_) {},
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    });
  }
}
