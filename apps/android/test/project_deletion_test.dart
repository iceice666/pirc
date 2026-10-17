import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/project_deletion_dialog.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'package:pirc_mobile/live/workspace_settings.dart';

import 'live_test.dart' show FakeGateway, theme;

const Json topChats = {
  'id': 'h:chats',
  'hostId': 'h',
  'kind': 'chat',
  'displayName': 'Chats',
};
const Json project = {
  'id': 'h:trip',
  'hostId': 'h',
  'kind': 'chat',
  'displayName': 'Trip',
};
const Json otherProject = {
  'id': 'h:repo',
  'hostId': 'h',
  'kind': 'chat',
  'displayName': 'Repo',
};
const String deletionPath = '/api/workspaces/h%3Atrip/deletion';

Json _entry(String id, String content, int revision) => {
  'id': id,
  'kind': 'note',
  'content': content,
  'status': 'active',
  'revision': revision,
  'origins': ['assistant'],
  'sources': {},
  'createdAt': 0,
  'updatedAt': 0,
};

Json _memoryItem(
  String id,
  String content,
  int revision,
  String action, {
  String? restored,
  int? restoredRevision,
}) => {
  'entry': _entry(id, content, revision),
  'action': action,
  'restored': restored,
  'restoredRevision': restoredRevision,
};

List<Json> _defaultMemory() => [
  _memoryItem('only-here', 'Only here', 1, 'forget'),
  _memoryItem(
    'rollback',
    'Tea for X',
    2,
    'rollback',
    restored: 'Tea',
    restoredRevision: 1,
  ),
  _memoryItem('mixed-forget', 'Mixed text to forget', 4, 'review'),
  _memoryItem('mixed-keep', 'Mixed text to keep', 7, 'review'),
  _memoryItem('mixed-edit', 'Mixed text to edit', 9, 'review'),
];

Json _preview({
  bool online = true,
  bool deleting = false,
  List<Json>? memory,
  String projectId = 'h:trip',
  String displayName = 'Trip',
}) => {
  'project': {'id': projectId, 'displayName': displayName},
  'nodeOnline': online,
  'deleting': deleting,
  'chats': [
    {'id': 's1', 'name': 'Plan'},
  ],
  'schedules': [
    {'id': 'sc1', 'title': 'Daily fares'},
  ],
  'keptSchedules': [
    {
      'id': 'sc2',
      'title': 'Repo check',
      'workspaceId': 'h:repo',
      'workspaceName': 'Repo',
    },
  ],
  'delegations': 1,
  'links': 2,
  'memory': memory ?? _defaultMemory(),
};

dynamic _fallback(
  FakeGateway gateway,
  String method,
  Json args, {
  List<Json> sessions = const [],
  List<Json> workspaces = const [topChats, project, otherProject],
  List<Json> nodes = const [
    {'id': 'h'},
  ],
}) {
  if (method == 'request') {
    final path = '${args['path']}';
    if (path == '/api/sessions') return {'sessions': sessions};
    if (path == '/api/workspaces') return {'workspaces': workspaces};
    if (path == '/api/nodes') return {'nodes': nodes};
    if (path == '/api/memory') return {'entries': [], 'proposals': []};
    if (path == '/api/schedules') return {'schedules': []};
  }
  return gateway.normal(method, args);
}

void _installFallback(
  FakeGateway gateway, {
  List<Json> sessions = const [],
  List<Json> workspaces = const [topChats, project, otherProject],
  List<Json> nodes = const [
    {'id': 'h'},
  ],
}) {
  gateway.handler = (method, args) async => _fallback(
    gateway,
    method,
    args,
    sessions: sessions,
    workspaces: workspaces,
    nodes: nodes,
  );
}

LiveController _controller(
  FakeGateway gateway, {
  List<Json>? sessions,
  List<Json>? workspaces,
  List<Json>? nodes,
  String? pairingStamp = 'pair-one',
}) => LiveController(gateway)
  ..origin = 'https://gateway.example'
  ..clientId = 'phone'
  ..pairingStamp = pairingStamp
  ..sessions = List<Json>.of(sessions ?? const [])
  ..workspaces = List<Json>.of(
    workspaces ?? const [topChats, project, otherProject],
  )
  ..nodes = List<Json>.of(
    nodes ??
        const [
          {'id': 'h'},
        ],
  );

Future<void> _mountDialog(
  WidgetTester tester,
  LiveController controller,
  Json workspace, {
  Size size = const Size(390, 900),
  double textScale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  await tester.pumpWidget(
    MaterialApp(
      theme: theme.build(Brightness.light),
      home: Scaffold(
        body: Center(
          child: Builder(
            builder: (context) => TextButton(
              key: const Key('open-project-deletion'),
              onPressed: () => unawaited(
                deleteProjectDialog(context, controller, workspace),
              ),
              child: const Text('Open deletion review'),
            ),
          ),
        ),
      ),
    ),
  );
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Future<void> _openDialog(WidgetTester tester) async {
  await _tap(tester, find.byKey(const Key('open-project-deletion')));
  await tester.pumpAndSettle();
}

Future<void> _mountSettings(
  WidgetTester tester,
  LiveController controller,
  Json workspace,
) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(390, 900);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: theme.build(Brightness.light),
      home: Scaffold(
        body: SingleChildScrollView(
          child: WorkspaceSettings(
            controller: controller,
            workspace: workspace,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _mountPage(
  WidgetTester tester,
  LiveController controller,
  String workspaceId,
) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(390, 900);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: theme.build(Brightness.light),
      home: WorkspacePage(
        controller: controller,
        workspaceId: workspaceId,
        onBack: () {},
        onOpen: (_) {},
      ),
    ),
  );
}

Finder _keyedButton(WidgetTester tester, String key) => find.descendant(
  of: find.byKey(Key(key)),
  matching: find.byType(TextButton),
);

bool _disabled(WidgetTester tester, String key) =>
    tester.widget<TextButton>(_keyedButton(tester, key)).onPressed == null;

Future<void> _dispose(
  WidgetTester tester,
  LiveController controller,
  FakeGateway gateway,
) async {
  await tester.pumpWidget(const SizedBox.shrink());
  controller.dispose();
  await gateway.stream.close();
}

void main() {
  testWidgets(
    'shows deletion effects and submits only explicit, revision-bound memory choices',
    (tester) async {
      final gateway = FakeGateway();
      final requests = <Json>[];
      gateway.handler = (method, args) async {
        if (method == 'request' && args['path'] == deletionPath) {
          requests.add(args);
          if (args['method'] == 'POST') return <String, dynamic>{};
          return _preview();
        }
        return _fallback(gateway, method, args);
      };
      final controller = _controller(gateway);
      await _mountDialog(tester, controller, project);
      await _openDialog(tester);

      expect(
        find.textContaining('1 chat, with their messages'),
        findsOneWidget,
      );
      expect(find.textContaining('“Only here”'), findsOneWidget);
      expect(find.textContaining('“Tea for X” → “Tea”'), findsOneWidget);
      expect(find.textContaining('“Daily fares”'), findsOneWidget);
      expect(find.textContaining('“Repo check” (Repo)'), findsOneWidget);
      expect(
        find.textContaining('other chats may write it again'),
        findsOneWidget,
      );
      expect(_disabled(tester, 'project-deletion-confirm'), isTrue);
      expect(
        requests.first['pairingStamp'],
        'pair-one',
        reason: 'The preview must be scoped to the current pairing.',
      );

      await _tap(
        tester,
        find.byKey(const Key('project-memory-mixed-forget-forget')),
      );
      await _tap(
        tester,
        find.byKey(const Key('project-memory-mixed-keep-keep')),
      );
      await _tap(
        tester,
        find.byKey(const Key('project-memory-mixed-edit-edit')),
      );
      await tester.pump();
      await tester.enterText(
        find.byKey(const Key('project-memory-mixed-edit-text')),
        '  Revised shared fact  ',
      );
      await tester.pump();
      expect(_disabled(tester, 'project-deletion-confirm'), isFalse);

      await _tap(tester, _keyedButton(tester, 'project-deletion-confirm'));
      await tester.pumpAndSettle();
      final posts = requests
          .where((request) => request['method'] == 'POST')
          .toList();
      expect(posts, hasLength(1));
      expect(posts.single['path'], deletionPath);
      expect(posts.single['pairingStamp'], 'pair-one');
      expect(posts.single['body'], {
        'decisions': [
          {'entryId': 'mixed-forget', 'revision': 4, 'action': 'forget'},
          {'entryId': 'mixed-keep', 'revision': 7, 'action': 'keep'},
          {
            'entryId': 'mixed-edit',
            'revision': 9,
            'action': 'edit',
            'content': 'Revised shared fact',
          },
        ],
      });
      expect(find.byType(Dialog), findsNothing);
      await _dispose(tester, controller, gateway);
    },
  );

  testWidgets('a memory conflict reloads entries and clears every old choice', (
    tester,
  ) async {
    final gateway = FakeGateway();
    var previews = 0;
    final requests = <Json>[];
    gateway.handler = (method, args) async {
      if (method == 'request' && args['path'] == deletionPath) {
        requests.add(args);
        if (args['method'] == 'POST') {
          throw PlatformException(
            code: 'HTTP_409',
            message: 'Memory changed',
            details: {'code': 'conflict'},
          );
        }
        previews++;
        return _preview(
          memory: [
            _memoryItem(
              'mixed',
              previews == 1 ? 'Mixed text' : 'Mixed text, changed',
              previews == 1 ? 4 : 5,
              'review',
            ),
          ],
        );
      }
      return _fallback(gateway, method, args);
    };
    final controller = _controller(gateway);
    await _mountDialog(tester, controller, project);
    await _openDialog(tester);

    expect(_disabled(tester, 'project-deletion-confirm'), isTrue);
    await _tap(tester, find.byKey(const Key('project-memory-mixed-keep')));
    await tester.pump();
    await _tap(tester, _keyedButton(tester, 'project-deletion-confirm'));
    await tester.pumpAndSettle();

    expect(previews, 2);
    expect(
      find.textContaining('Memory changed since this was shown'),
      findsOneWidget,
    );
    expect(find.textContaining('Mixed text, changed'), findsOneWidget);
    expect(_disabled(tester, 'project-deletion-confirm'), isTrue);
    expect(
      requests.where((request) => request['method'] == 'POST'),
      hasLength(1),
    );
    await _dispose(tester, controller, gateway);
  });

  testWidgets(
    'an interrupted deletion can be finished after a partial failure reloads the preview',
    (tester) async {
      final workspace = {...project, 'deleting': true};
      final gateway = FakeGateway();
      final failFirstPost = Completer<Json>();
      var previews = 0, posts = 0;
      gateway.handler = (method, args) async {
        if (method == 'request' && args['path'] == deletionPath) {
          if (args['method'] == 'POST') {
            if (++posts == 1) return failFirstPost.future;
            return <String, dynamic>{};
          }
          previews++;
          return _preview(
            deleting: true,
            memory: previews == 1
                ? [_memoryItem('mixed', 'Mixed text', 3, 'review')]
                : [],
          );
        }
        return _fallback(
          gateway,
          method,
          args,
          workspaces: [topChats, workspace, otherProject],
        );
      };
      final controller = _controller(
        gateway,
        workspaces: [topChats, workspace, otherProject],
      );
      await _mountPage(tester, controller, project['id'] as String);

      expect(find.byKey(const Key('project-deletion-finish')), findsOneWidget);
      await _tap(tester, _keyedButton(tester, 'project-deletion-finish'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('An earlier deletion of this project'),
        findsOneWidget,
      );

      await _tap(tester, find.byKey(const Key('project-memory-mixed-keep')));
      await tester.pump();
      await _tap(tester, _keyedButton(tester, 'project-deletion-confirm'));
      await tester.pump();
      expect(posts, 1);
      expect(_disabled(tester, 'project-deletion-cancel'), isTrue);
      expect(_disabled(tester, 'project-deletion-confirm'), isTrue);
      failFirstPost.completeError(
        PlatformException(
          code: 'HTTP_500',
          message: 'Temporary deletion failure',
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Temporary deletion failure'), findsOneWidget);
      expect(
        find.textContaining('An earlier deletion of this project'),
        findsOneWidget,
      );
      expect(previews, 2);
      expect(_disabled(tester, 'project-deletion-confirm'), isFalse);

      await _tap(tester, _keyedButton(tester, 'project-deletion-confirm'));
      await tester.pumpAndSettle();
      expect(posts, 2);
      expect(find.byType(Dialog), findsNothing);
      await _dispose(tester, controller, gateway);
    },
  );

  testWidgets(
    'preview failure offers retry; cancel closes a still-loading retry',
    (tester) async {
      final gateway = FakeGateway();
      final retryPreview = Completer<Json>();
      var previews = 0, posts = 0;
      gateway.handler = (method, args) async {
        if (method == 'request' && args['path'] == deletionPath) {
          if (args['method'] == 'POST') {
            posts++;
            return <String, dynamic>{};
          }
          if (++previews == 1) {
            throw PlatformException(code: 'NETWORK', message: 'offline');
          }
          return retryPreview.future;
        }
        return _fallback(gateway, method, args);
      };
      final controller = _controller(gateway);
      await _mountDialog(tester, controller, project);
      await _openDialog(tester);
      expect(find.text('連線或裝置操作失敗，請確認連線後重試。'), findsOneWidget);
      expect(find.byKey(const Key('project-deletion-retry')), findsOneWidget);

      await _tap(tester, _keyedButton(tester, 'project-deletion-retry'));
      await tester.pump();
      expect(find.text('Loading what the project holds…'), findsOneWidget);
      expect(_disabled(tester, 'project-deletion-confirm'), isTrue);
      await _tap(tester, _keyedButton(tester, 'project-deletion-cancel'));
      await tester.pumpAndSettle();

      retryPreview.complete(_preview(memory: []));
      await tester.pumpAndSettle();
      expect(find.byType(Dialog), findsNothing);
      expect(posts, 0);
      await _dispose(tester, controller, gateway);
    },
  );

  testWidgets('offline project preview cannot be confirmed', (tester) async {
    final gateway = FakeGateway();
    gateway.handler = (method, args) async {
      if (method == 'request' && args['path'] == deletionPath) {
        return _preview(online: false, memory: []);
      }
      return _fallback(gateway, method, args);
    };
    final controller = _controller(gateway, nodes: const []);
    await _mountDialog(tester, controller, project);
    await _openDialog(tester);

    expect(
      find.text('Connect the chat node to delete this project.'),
      findsOneWidget,
    );
    expect(_disabled(tester, 'project-deletion-confirm'), isTrue);
    await _dispose(tester, controller, gateway);
  });

  testWidgets('deletion review fits a narrow screen at 2× text scale', (
    tester,
  ) async {
    final gateway = FakeGateway();
    gateway.handler = (method, args) async {
      if (method == 'request' && args['path'] == deletionPath) {
        return _preview(memory: []);
      }
      return _fallback(gateway, method, args);
    };
    final controller = _controller(gateway);
    await _mountDialog(
      tester,
      controller,
      project,
      size: const Size(320, 720),
      textScale: 2,
    );
    await _openDialog(tester);

    expect(find.byKey(const Key('project-deletion-body')), findsOneWidget);
    expect(find.byKey(const Key('project-deletion-confirm')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await _dispose(tester, controller, gateway);
  });

  testWidgets('edited memory text is limited by trimmed UTF-16 length', (
    tester,
  ) async {
    final gateway = FakeGateway();
    gateway.handler = (method, args) async {
      if (method == 'request' && args['path'] == deletionPath) {
        return _preview(
          memory: [_memoryItem('emoji', 'Shared fact', 8, 'review')],
        );
      }
      return _fallback(gateway, method, args);
    };
    final controller = _controller(gateway);
    await _mountDialog(tester, controller, project);
    await _openDialog(tester);
    await _tap(tester, find.byKey(const Key('project-memory-emoji-edit')));
    await tester.pump();

    final field = find.byKey(const Key('project-memory-emoji-text'));
    await tester.enterText(field, List.filled(501, '😀').join());
    await tester.pump();
    expect(find.text('Use at most 1000 characters.'), findsOneWidget);
    expect(_disabled(tester, 'project-deletion-confirm'), isTrue);

    await tester.enterText(field, List.filled(500, '😀').join());
    await tester.pump();
    expect(find.text('Use at most 1000 characters.'), findsNothing);
    expect(_disabled(tester, 'project-deletion-confirm'), isFalse);
    await _tap(tester, _keyedButton(tester, 'project-deletion-cancel'));
    await tester.pumpAndSettle();
    await _dispose(tester, controller, gateway);
  });

  testWidgets(
    'settings exposes delete for projects, never the top Chats workspace',
    (tester) async {
      final gateway = FakeGateway();
      _installFallback(gateway);
      final controller = _controller(gateway);
      await _mountSettings(tester, controller, project);
      expect(find.byKey(const Key('project-delete-open')), findsOneWidget);

      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
      final topController = _controller(gateway);
      await _mountSettings(tester, topController, topChats);
      expect(find.byKey(const Key('project-delete-open')), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
      topController.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'obsolete account, host, and removed-project previews close safely',
    (tester) async {
      for (final change in ['account', 'host', 'removed']) {
        final gateway = FakeGateway();
        final pending = Completer<Json>();
        gateway.handler = (method, args) async {
          if (method == 'pair') {
            return {
              'origin': 'https://new-gateway.example',
              'clientId': 'new-phone',
              'pairingStamp': 'pair-two',
            };
          }
          if (method == 'request' && args['path'] == deletionPath) {
            return pending.future;
          }
          return _fallback(gateway, method, args);
        };
        final controller = _controller(gateway);
        await _mountDialog(tester, controller, project);
        await _openDialog(tester);
        expect(find.text('Loading what the project holds…'), findsOneWidget);

        if (change == 'account') {
          await controller.pair('new-link');
        } else if (change == 'host') {
          controller.workspaces = [
            topChats,
            {...project, 'hostId': 'h2'},
            otherProject,
          ];
          controller.nodes = [
            {'id': 'h2'},
          ];
          controller.changed();
        } else {
          controller.workspaces = [topChats, otherProject];
          controller.changed();
        }
        await tester.pumpAndSettle();
        expect(find.byType(Dialog), findsNothing, reason: change);

        pending.complete(_preview());
        await tester.pumpAndSettle();
        expect(find.byType(Dialog), findsNothing, reason: change);
        expect(
          gateway.calls.where(
            (call) => call.$1 == 'request' && call.$2['method'] == 'POST',
          ),
          isEmpty,
        );
        await _dispose(tester, controller, gateway);
      }
    },
  );

  test(
    'acknowledged deletion cleans project sessions and drafts; stale indexes cannot restore them',
    () async {
      final gateway = FakeGateway();
      final workspaceReadStarted = Completer<void>();
      final staleWorkspaces = Completer<Json>();
      final clearedDrafts = <String>{};
      final draftsCleared = Completer<void>();
      final projectSessions = [
        {'id': 'trip-one', 'workspaceId': 'h:trip'},
        {'id': 'trip-two', 'workspaceId': 'h:trip'},
      ];
      final externalSession = {'id': 'repo-one', 'workspaceId': 'h:repo'};
      gateway.handler = (method, args) async {
        if (method == 'request') {
          final path = '${args['path']}';
          if (path == '/api/workspaces') {
            if (!workspaceReadStarted.isCompleted) {
              workspaceReadStarted.complete();
              return staleWorkspaces.future;
            }
            return {
              'workspaces': [topChats, project, otherProject],
            };
          }
          if (path == '/api/sessions') {
            return {
              'sessions': [...projectSessions, externalSession],
            };
          }
          if (path == '/api/nodes') {
            return {
              'nodes': [
                {'id': 'h'},
              ],
            };
          }
          if (path == '/api/memory') return {'entries': [], 'proposals': []};
          if (path == '/api/schedules') {
            return {
              'schedules': [
                {
                  'id': 'repo-schedule',
                  'title': 'Repo check',
                  'status': 'active',
                },
              ],
            };
          }
          if (path == deletionPath) return <String, dynamic>{};
        }
        if (method == 'draft' && args['text'] == '') {
          clearedDrafts.add('${args['sessionId']}');
          if (clearedDrafts.containsAll(['trip-one', 'trip-two']) &&
              !draftsCleared.isCompleted) {
            draftsCleared.complete();
          }
        }
        return gateway.normal(method, args);
      };
      final controller = _controller(
        gateway,
        sessions: [...projectSessions, externalSession],
      );
      gateway.drafts.addAll({
        'trip-one': 'trip draft one',
        'trip-two': 'trip draft two',
        'repo-one': 'repo draft',
      });
      controller
        ..sessionId = 'trip-one'
        ..state = {
          'session': {'id': 'trip-one', 'workspaceId': 'h:trip'},
          'messages': [
            {'id': 'm', 'role': 'assistant', 'content': 'Trip notes'},
          ],
        }
        ..draft = 'unsent trip draft'
        ..workspaceFilter = 'h:trip'
        ..routePage = 'workspace:h:trip'
        ..panelState['files'] = {'path': 'trip.txt'};
      final navigationBefore = controller.sessionNavigationRevision;

      final staleRead = controller.refreshList();
      await workspaceReadStarted.future;
      await controller.deleteProject('h:trip', const []);
      staleWorkspaces.complete({
        'workspaces': [topChats, project, otherProject],
      });
      await staleRead;
      await draftsCleared.future;

      expect(controller.sessions.map((s) => s['id']), ['repo-one']);
      expect(controller.workspaces.map((w) => w['id']), ['h:chats', 'h:repo']);
      expect(controller.sessionId, isNull);
      expect(controller.state, isEmpty);
      expect(controller.draft, isEmpty);
      expect(controller.workspaceFilter, isNull);
      expect(controller.routePage, isNull);
      expect(
        controller.sessionNavigationRevision,
        greaterThan(navigationBefore),
      );
      expect(gateway.drafts, {
        'trip-one': '',
        'trip-two': '',
        'repo-one': 'repo draft',
      });
      expect(controller.attention.schedules.single['id'], 'repo-schedule');
      expect(
        gateway.calls.any(
          (call) => call.$1 == 'request' && call.$2['path'] == '/api/memory',
        ),
        isTrue,
      );
      expect(
        gateway.calls.any(
          (call) => call.$1 == 'request' && call.$2['path'] == '/api/schedules',
        ),
        isTrue,
      );

      await controller.open('trip-one');
      expect(controller.sessionId, isNull);
      await expectLater(controller.create('h:trip'), throwsStateError);
      expect(
        gateway.calls.where(
          (call) =>
              call.$1 == 'request' &&
              call.$2['path'] == '/api/sessions' &&
              call.$2['method'] == 'POST',
        ),
        isEmpty,
      );
      controller.dispose();
      await gateway.stream.close();
    },
  );

  test(
    'controller snapshots decision revisions and prevents duplicate deletion requests',
    () async {
      final gateway = FakeGateway();
      final postStarted = Completer<Json>();
      final finishPost = Completer<Json>();
      gateway.handler = (method, args) async {
        if (method == 'request' && args['path'] == deletionPath) {
          postStarted.complete(args);
          await finishPost.future;
          return <String, dynamic>{};
        }
        return _fallback(gateway, method, args);
      };
      final controller = _controller(gateway);
      final decision = <String, dynamic>{
        'entryId': 'mixed',
        'revision': 4,
        'action': 'keep',
      };
      final decisions = <Json>[decision];
      final deletion = controller.deleteProject('h:trip', decisions);
      final request = await postStarted.future;

      decision['revision'] = 99;
      decisions.clear();
      expect(request['body'], {
        'decisions': [
          {'entryId': 'mixed', 'revision': 4, 'action': 'keep'},
        ],
      });
      await expectLater(
        controller.deleteProject('h:trip', const []),
        throwsStateError,
      );
      finishPost.complete({});
      await deletion;
      controller.dispose();
      await gateway.stream.close();
    },
  );

  test('a pending new-chat response cannot reopen a deleted project', () async {
    final gateway = FakeGateway();
    final created = Completer<Json>();
    gateway.handler = (method, args) async {
      if (method == 'request' &&
          args['path'] == '/api/sessions' &&
          args['method'] == 'POST') {
        return created.future;
      }
      if (method == 'request' &&
          args['path'] == deletionPath &&
          args['method'] == 'POST') {
        return <String, dynamic>{};
      }
      return _fallback(gateway, method, args);
    };
    final controller = _controller(gateway);
    final pendingCreate = controller.create('h:trip');
    await controller.deleteProject('h:trip', []);
    created.complete({
      'session': {'id': 'late-created', 'workspaceId': 'h:trip'},
    });
    await pendingCreate;
    expect(controller.sessionId, isNull);
    expect(controller.workspaces.any((w) => w['id'] == 'h:trip'), isFalse);
    expect(gateway.calls.where((call) => call.$1 == 'watch'), isEmpty);
    controller.dispose();
    await gateway.stream.close();
  });

  test(
    'an old account deletion acknowledgement cannot clear the newly paired state',
    () async {
      final gateway = FakeGateway();
      final postStarted = Completer<void>();
      final oldAcknowledgement = Completer<Json>();
      var switched = false;
      gateway.handler = (method, args) async {
        if (method == 'pair') {
          switched = true;
          return {
            'origin': 'https://new-gateway.example',
            'clientId': 'new-phone',
            'pairingStamp': 'pair-two',
          };
        }
        if (method == 'request') {
          final path = '${args['path']}';
          if (path == deletionPath && args['method'] == 'POST') {
            postStarted.complete();
            return oldAcknowledgement.future;
          }
          if (path == '/api/workspaces') {
            return {
              'workspaces': switched
                  ? [
                      {'id': 'new:chats', 'hostId': 'new', 'kind': 'chat'},
                      {
                        'id': 'new:trip',
                        'hostId': 'new',
                        'kind': 'chat',
                        'displayName': 'New trip',
                      },
                    ]
                  : [topChats, project],
            };
          }
          if (path == '/api/sessions') {
            return {
              'sessions': switched
                  ? [
                      {'id': 'new-session', 'workspaceId': 'new:trip'},
                    ]
                  : [],
            };
          }
          if (path == '/api/nodes') {
            return {
              'nodes': [
                {'id': switched ? 'new' : 'h'},
              ],
            };
          }
          if (path == '/api/memory') return {'entries': [], 'proposals': []};
          if (path == '/api/schedules') return {'schedules': []};
        }
        return gateway.normal(method, args);
      };
      final controller = _controller(gateway);
      final deletion = controller.deleteProject('h:trip', const []);
      await postStarted.future;

      await controller.pair('new-link');
      expect(controller.pairingStamp, 'pair-two');
      expect(controller.sessions.single['id'], 'new-session');
      expect(controller.sessionId, 'new-session');
      expect(
        controller.workspaces.any((workspace) => workspace['id'] == 'new:trip'),
        isTrue,
      );

      oldAcknowledgement.complete({});
      await deletion;
      expect(controller.sessions.single['id'], 'new-session');
      expect(controller.sessionId, 'new-session');
      expect(
        controller.workspaces.any((workspace) => workspace['id'] == 'new:trip'),
        isTrue,
      );
      controller.dispose();
      await gateway.stream.close();
    },
  );
}
