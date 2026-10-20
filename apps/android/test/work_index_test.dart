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
  'id': 'device:trip',
  'hostId': 'device',
  'displayName': 'Trip',
  'kind': 'directory',
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
  String? status,
}) => {
  'id': id,
  'name': id,
  'workspaceId': project['id'],
  'unread': unread,
  if (pinned) 'pinnedAt': 1,
  if (done) 'settledAt': 2,
  'runStatus': ?status,
};
LiveController fixture(FakeGateway g) => LiveController(g)
  ..booting = false
  ..origin = 'https://gateway.example'
  ..workspaces = [project, directory]
  ..nodes = [
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
  });
  test('hosts retain offline workspaces and list empty nodes', () {
    final list = workHosts(
      [
        directory,
        {'id': 'offline:old', 'hostId': 'offline'},
      ],
      [
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
  testWidgets(
    'workspace history includes read sessions and searches done',
    (t) async {
      final g = FakeGateway(), c = fixture(g);
      c.sessions = [
        session('Read conversation'),
        session('Completed', done: true),
        session('Pinned run', pinned: true),
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
