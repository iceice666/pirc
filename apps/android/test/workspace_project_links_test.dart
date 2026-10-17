import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/workspace_project_links.dart';
import 'package:pirc_mobile/live/workspace_settings.dart';

import 'live_test.dart' show FakeGateway, theme;

const _project = <String, dynamic>{
  'id': 'home:project',
  'hostId': 'home',
  'kind': 'chat',
  'displayName': 'Project',
};

const _directory = <String, dynamic>{
  'id': 'home:repo',
  'hostId': 'home',
  'kind': 'directory',
  'displayName': 'Repository',
};

const _missingLink = <String, dynamic>{
  'workspaceId': 'old:repo',
  'name': 'Removed repository',
  'node': 'old',
  'repo': 'github.com/acme/old',
  'online': false,
  'removed': true,
  'createdAt': 1,
};

LiveController _controller(FakeGateway gateway) => LiveController(gateway)
  ..origin = 'https://gateway.example'
  ..clientId = 'phone'
  ..pairingStamp = 'pairing'
  ..workspaces = [
    _directory,
    _project,
    {
      'id': 'home:chats',
      'hostId': 'home',
      'kind': 'chat',
      'displayName': 'Chats',
    },
  ]
  ..nodes = [
    {'id': 'home'},
  ];

Widget _host(Widget child) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: Scaffold(body: SingleChildScrollView(child: child)),
);

Future<void> _finish(
  WidgetTester tester,
  LiveController controller,
  FakeGateway gateway,
) async {
  await tester.pumpWidget(const SizedBox());
  controller.dispose();
  await gateway.stream.close();
}

void main() {
  testWidgets(
    'loads project links, preserves missing saved links, and saves ordered IDs',
    (tester) async {
      final gateway = FakeGateway();
      Json? putBody;
      String? getPath;
      gateway.handler = (method, args) async {
        if (method != 'request') return gateway.normal(method, args);
        final path = '${args['path']}';
        if (path == '/api/workspaces/home%3Aproject/links' &&
            args['method'] == 'GET') {
          getPath = path;
          return {
            'links': [_missingLink],
          };
        }
        if (path == '/api/workspaces/home%3Aproject/links' &&
            args['method'] == 'PUT') {
          putBody = args['body'] as Json;
          return {
            'links': [
              _missingLink,
              {
                'workspaceId': 'home:repo',
                'name': 'Repository',
                'node': 'home',
                'repo': 'github.com/acme/repo',
                'online': true,
                'removed': false,
                'createdAt': 2,
              },
            ],
          };
        }
        return <String, dynamic>{};
      };
      final controller = _controller(gateway);
      await tester.pumpWidget(
        _host(
          WorkspaceProjectLinks(
            controller: controller,
            workspaceId: 'home:project',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(getPath, '/api/workspaces/home%3Aproject/links');
      expect(find.text('Repository'), findsOneWidget);
      expect(find.text('Project'), findsNothing);
      expect(find.text('Removed repository'), findsOneWidget);
      expect(find.text('old · no longer available'), findsOneWidget);

      await tester.tap(find.byType(Checkbox).first);
      await tester.pump();
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(putBody, {
        'workspaceIds': ['old:repo', 'home:repo'],
      });
      expect(find.text('Linked workspaces saved.'), findsOneWidget);
      await _finish(tester, controller, gateway);
    },
  );

  testWidgets('ignores stale link GET and PUT results after pairing changes', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final staleRead = Completer<Json>();
    final staleWrite = Completer<Json>();
    var reads = 0, writes = 0;
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      final path = '${args['path']}';
      if (path != '/api/workspaces/home%3Aproject/links') {
        return <String, dynamic>{};
      }
      if (args['method'] == 'PUT') {
        writes++;
        return staleWrite.future;
      }
      reads++;
      if (reads == 1) return staleRead.future;
      return {
        'links': [
          {
            'workspaceId': 'home:repo',
            'name': 'Repository',
            'node': 'home',
            'online': true,
            'removed': false,
            'createdAt': reads,
          },
        ],
      };
    };
    final controller = _controller(gateway);
    Widget view() => _host(
      WorkspaceProjectLinks(
        controller: controller,
        workspaceId: 'home:project',
      ),
    );

    await tester.pumpWidget(view());
    await tester.pumpAndSettle();
    expect(reads, 1);

    controller.pairingStamp = 'pairing-two';
    await tester.pumpWidget(view());
    await tester.pumpAndSettle();
    expect(reads, 2);
    expect(find.text('Repository'), findsOneWidget);

    staleRead.complete({
      'links': [
        {
          'workspaceId': 'old:repo',
          'name': 'Stale link',
          'node': 'old',
          'online': false,
          'removed': true,
          'createdAt': 1,
        },
      ],
    });
    await tester.pumpAndSettle();
    expect(find.text('Stale link'), findsNothing);
    expect(find.text('Repository'), findsOneWidget);

    await tester.tap(find.byType(Checkbox).first);
    await tester.pump();
    await tester.tap(find.text('Save'));
    await tester.pump();
    expect(writes, 1);

    controller.pairingStamp = 'pairing-three';
    await tester.pumpWidget(view());
    await tester.pumpAndSettle();
    expect(reads, 3);
    expect(find.text('Linked workspaces saved.'), findsNothing);
    expect(tester.widget<Checkbox>(find.byType(Checkbox).first).value, isTrue);

    staleWrite.complete({'links': <Json>[]});
    await tester.pumpAndSettle();
    expect(find.text('Linked workspaces saved.'), findsNothing);
    expect(tester.widget<Checkbox>(find.byType(Checkbox).first).value, isTrue);
    await _finish(tester, controller, gateway);
  });

  testWidgets(
    'shows the trusted project config default model and thinking level',
    (tester) async {
      final gateway = FakeGateway();
      gateway.handler = (method, args) async {
        if (method != 'request') return gateway.normal(method, args);
        if ('${args['path']}'.endsWith('/project-config')) {
          return {
            'project': {
              'hash': 'config-hash',
              'trustedHash': 'config-hash',
              'trusted': true,
              'empty': false,
              'hooks': <String, dynamic>{},
              'env': <String, dynamic>{},
              'allowedPaths': <String>[],
              'defaultModel': {
                'provider': 'anthropic',
                'id': 'claude-sonnet',
                'thinking': 'high',
              },
            },
          };
        }
        return <String, dynamic>{};
      };
      final controller = _controller(gateway);
      await tester.pumpWidget(
        _host(WorkspaceSettings(controller: controller, workspace: _directory)),
      );
      await tester.pumpAndSettle();

      expect(find.text('Default model'), findsOneWidget);
      expect(
        find.text('anthropic/claude-sonnet (thinking high)'),
        findsOneWidget,
      );
      await _finish(tester, controller, gateway);
    },
  );
}
