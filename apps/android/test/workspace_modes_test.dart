import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/modes.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'package:pirc_mobile/live/side_panel.dart';
import 'package:pirc_mobile/live/web_controls.dart';
import 'package:pirc_mobile/live/work_index.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'package:pirc_mobile/live/workspace_settings.dart';

import 'live_test.dart' show FakeGateway, theme;
import 'mode_fixtures.dart';

/// An older gateway: no `mode`/`available` on workspaces, no node modes.
Json _legacy(Json workspace) => {...workspace}
  ..remove('mode')
  ..remove('available');

Iterable<String> _ids(Iterable<Json> rows) => rows.map((r) => '${r['id']}');

/// Serves the mode fixtures; [modes] null answers 404 like an older gateway.
FakeGateway _gateway({
  List<Json>? modes = const [],
  List<Json> workspaces = modeWorkspacesFixture,
  List<Json> nodes = modeNodesFixture,
  List<Json> sessions = const [],
  FutureOr<dynamic> Function(Json args)? request,
}) {
  final g = FakeGateway();
  g.handler = (method, args) async {
    if (method != 'request') return g.normal(method, args);
    final custom = await request?.call(args);
    if (custom != null) return custom;
    return switch (args['path']) {
      '/api/modes' when modes == null => throw PlatformException(
        code: 'HTTP_404',
      ),
      '/api/modes' => {'modes': modes},
      '/api/workspaces' => {'workspaces': workspaces},
      '/api/nodes' => {'nodes': nodes},
      '/api/sessions' => {'sessions': sessions},
      _ => g.normal(method, args),
    };
  };
  return g;
}

LiveController _controller(
  FakeGateway g, {
  List<Json> modes = const [],
  List<Json> workspaces = modeWorkspacesFixture,
  List<Json> nodes = modeNodesFixture,
  List<Json> sessions = const [],
}) => LiveController(g, showing: 'engine')
  ..booting = false
  ..origin = 'https://gateway.example'
  ..clientId = 'phone'
  ..pairingStamp = 'pairing'
  ..catalog = ModeCatalog(modes)
  ..workspaces = workspaces
  ..nodes = nodes
  ..sessions = sessions;

Widget _host(Widget child) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: Scaffold(body: child),
);

Future<void> _finish(WidgetTester t, LiveController c, FakeGateway g) async {
  await t.pumpWidget(const SizedBox());
  c.dispose();
  await g.stream.close();
}

Iterable<String> _requested(FakeGateway g) =>
    g.calls.where((c) => c.$1 == 'request').map((c) => '${c.$2['path']}');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final catalog = ModeCatalog(modeCatalogFixture);

  test('a workspace reads its capabilities from its mode', () {
    final scratch = catalog.of(scratchWorkspaceFixture);
    expect(scratch.label, 'Scratch');
    expect(scratch.noun, 'session');
    expect(scratch.repository, isFalse);
    expect(scratch.sharedDirectory, isFalse);
    expect(scratch.delegateTarget, isTrue);
    // Unavailable: read-only, whatever its mode says.
    final unavailable = {...scratchWorkspaceFixture, 'available': false};
    expect(isReadOnly(unavailable), isTrue);
    expect(catalog.of(unavailable).label, 'Unavailable');
    expect(catalog.of(unavailableWorkspaceFixture).label, 'Unavailable');

    final hosts = workHosts(modeWorkspacesFixture, modeNodesFixture, catalog);
    expect(_ids(hosts), ['device']);
    expect(_ids(rows(hosts.single['workspaces'])), [
      'device:repo',
      'device:jobs',
      'device:review',
    ]);
  });

  test('without a catalog every workspace is a directory', () {
    final empty = ModeCatalog();
    final legacy = modeWorkspacesFixture.map(_legacy).toList();
    final directory = legacy.firstWhere((w) => w['id'] == 'device:repo');
    expect(empty.of(directory).repository, isTrue);
    expect(empty.of(directory).sharedDirectory, isTrue);
    final scratch = legacy.firstWhere((w) => w['id'] == 'device:jobs');
    expect(empty.of(scratch).id, 'directory');
    // A catalog that lacks a still-available mode falls back the same way.
    expect(
      catalog.of({...scratchWorkspaceFixture, 'mode': 'new'}).id,
      'directory',
    );
    // Without node modes, every node hosts workspaces.
    final nodes = [
      {'id': 'device'},
      {'id': 'empty'},
    ];
    expect(_ids(empty.workNodes(nodes)), ['device', 'empty']);
    expect(_ids(workHosts(legacy, nodes, empty)), ['device', 'empty']);
    expect(empty.creatable(nodes[0]), isEmpty);
  });

  test('node modes decide Work hosts and creatable modes', () {
    final nodes = [
      ...modeNodesFixture,
      {
        'id': 'gpu',
        'modes': ['scratch'],
      },
      {
        'id': 'retired',
        'modes': ['chat'],
      },
      {'id': 'legacy'},
    ];
    // A node accepting only modes the catalog lacks hosts nothing.
    expect(_ids(catalog.workNodes(nodes)), ['device', 'gpu', 'legacy']);
    expect(catalog.creatable(nodes[0]).map((m) => m.id), [
      'directory',
      'scratch',
    ]);
    expect(catalog.creatable(nodes[1]).map((m) => m.id), ['scratch']);
    expect(catalog.creatable(nodes[2]), isEmpty);
  });

  test('the index loads the catalog; a 404 falls back to directory', () async {
    final g = _gateway(modes: modeCatalogFixture);
    final c = _controller(g);
    await c.refreshList();
    expect(_requested(g), contains('/api/modes'));
    expect(c.catalog.byId('scratch')?.label, 'Scratch');

    // A transient failure keeps the last catalog.
    g.handler = (method, args) async {
      if (method == 'request' && args['path'] == '/api/modes') {
        throw PlatformException(code: 'NETWORK');
      }
      return g.normal(method, args);
    };
    await c.refreshList();
    expect(c.catalog.isEmpty, isFalse);
    c.dispose();
    await g.stream.close();

    final old = _gateway(
      modes: null,
      workspaces: modeWorkspacesFixture.map(_legacy).toList(),
    );
    final legacy = _controller(old, modes: modeCatalogFixture);
    await legacy.refreshList();
    expect(legacy.catalog.isEmpty, isTrue);
    expect(legacy.error, isNull);
    expect(
      legacy.catalog
          .of(legacy.workspaces.firstWhere((w) => w['id'] == 'device:jobs'))
          .id,
      'directory',
    );
    legacy.dispose();
    await old.stream.close();
  });

  test('side panels follow capabilities', () {
    final g = FakeGateway();
    final c = _controller(g, modes: modeCatalogFixture);
    void open(String workspace) => c.state = {
      'session': {'id': 's', 'workspaceId': workspace},
    };
    open('device:jobs');
    expect(c.sessionPanel('git'), isFalse);
    expect(c.sessionPanel('terminals'), isFalse);
    expect(c.sessionPanel('files'), isTrue);
    open('device:repo');
    expect(c.sessionPanel('git'), isTrue);
    expect(c.sessionPanel('terminals'), isTrue);
    c.dispose();
  });

  testWidgets('side panel offers Git and Terminal by capability', (t) async {
    Future<void> pump({required bool git, required bool terminal}) =>
        t.pumpWidget(
          _host(
            SizedBox(
              width: 420,
              height: 600,
              child: NativeSidePanel(
                tab: 'files',
                git: git,
                terminal: terminal,
                open: true,
                overlay: false,
                width: 420,
                maxWidth: 636,
                onSelect: (_) {},
                onResize: (_) {},
                child: const SizedBox(),
              ),
            ),
          ),
        );
    Finder tab(String id) => find.byKey(ValueKey('panel-tab-$id'));
    await pump(git: false, terminal: false);
    expect(tab('git'), findsNothing);
    expect(tab('terminals'), findsNothing);
    expect(tab('files'), findsOneWidget);
    await pump(git: true, terminal: true);
    expect(tab('git'), findsOneWidget);
    expect(tab('terminals'), findsOneWidget);
  });

  testWidgets('Work groups scratch and unavailable workspaces by device', (
    t,
  ) async {
    final g = FakeGateway();
    final c = _controller(g, modes: modeCatalogFixture);
    await t.pumpWidget(
      _host(
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
    expect(find.text('device'), findsOneWidget);
    expect(find.text('Jobs'), findsOneWidget);
    expect(find.text('Old review'), findsOneWidget);
    WebIconButton button(String label) => t.widget<WebIconButton>(
      find.byWidgetPredicate((w) => w is WebIconButton && w.label == label),
    );
    expect(button('New session in Jobs').onPressed, isNotNull);
    expect(button('New session in Old review').onPressed, isNull);
    expect(button('Add workspace on device').onPressed, isNotNull);
    await _finish(t, c, g);
  });

  testWidgets('a scratch workspace page uses its label and noun', (t) async {
    final g = FakeGateway();
    final c = _controller(
      g,
      modes: modeCatalogFixture,
      sessions: [
        {'id': 'run', 'name': 'Render job', 'workspaceId': 'device:jobs'},
      ],
    );
    await t.pumpWidget(
      _host(
        WorkspacePage(
          controller: c,
          workspaceId: 'device:jobs',
          onBack: () {},
          onOpen: (_) {},
        ),
      ),
    );
    await t.pumpAndSettle();
    expect(find.text('Scratch · device'), findsOneWidget);
    expect(find.text('Sessions'), findsOneWidget);
    final create = t.widget<WebButton>(
      find.widgetWithText(WebButton, 'New session'),
    );
    expect(create.onPressed, isNotNull);
    expect(find.byTooltip('Rename Render job'), findsOneWidget);
    await _finish(t, c, g);
  });

  testWidgets('an unavailable workspace page is read-only', (t) async {
    final g = FakeGateway();
    final c = _controller(
      g,
      modes: modeCatalogFixture,
      sessions: [
        {'id': 'old', 'name': 'Old run', 'workspaceId': 'device:review'},
      ],
    );
    await t.pumpWidget(
      _host(
        WorkspacePage(
          controller: c,
          workspaceId: 'device:review',
          onBack: () {},
          onOpen: (_) {},
        ),
      ),
    );
    await t.pumpAndSettle();
    expect(find.text(workspaceUnavailableNotice), findsOneWidget);
    expect(find.text('Unavailable · device'), findsOneWidget);
    expect(
      t
          .widget<WebButton>(find.widgetWithText(WebButton, 'New session'))
          .onPressed,
      isNull,
    );
    expect(find.text('Old run'), findsOneWidget);
    await expectLater(c.create('device:review'), throwsStateError);
    expect(_requested(g), isNot(contains('/api/sessions')));
    await _finish(t, c, g);
  });

  testWidgets('scratch settings show workspace facts only', (t) async {
    final g = _gateway(modes: modeCatalogFixture);
    final c = _controller(g, modes: modeCatalogFixture);
    await t.pumpWidget(
      _host(
        SingleChildScrollView(
          child: WorkspaceSettings(
            controller: c,
            workspace: scratchWorkspaceFixture,
          ),
        ),
      ),
    );
    await t.pumpAndSettle();
    expect(find.text('WORKSPACE'), findsOneWidget);
    expect(find.text('Device'), findsOneWidget);
    for (final absent in ['PROJECT CONFIG']) {
      expect(find.text(absent), findsNothing, reason: absent);
    }
    expect(
      _requested(g).where((p) => p.startsWith('/api/workspaces/')),
      isEmpty,
    );
    await _finish(t, c, g);
  });

  Future<Json?> addWorkspace(
    WidgetTester t, {
    required List<Json> modes,
    required List<Json> workspaces,
    required List<Json> nodes,
    String? pick,
    String? path,
  }) async {
    Json? body;
    final g = _gateway(
      modes: modes,
      workspaces: workspaces,
      nodes: nodes,
      request: (args) {
        if (args['path'] == '/api/workspaces' && args['method'] == 'POST') {
          body = args['body'] as Json;
          return {
            'workspace': {'id': 'device:new'},
          };
        }
        return null;
      },
    );
    final c = _controller(
      g,
      modes: modes,
      workspaces: workspaces,
      nodes: nodes,
    );
    await t.pumpWidget(
      _host(
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
    await t.tap(find.byTooltip('Add workspace on device'));
    await t.pumpAndSettle();
    final picker = find.byKey(const ValueKey('workspace-mode'));
    if (pick == null) {
      expect(picker, findsNothing);
    } else {
      await t.tap(picker);
      await t.pumpAndSettle();
      await t.tap(find.textContaining(pick).last);
      await t.pumpAndSettle();
    }
    final directory = find.text('Existing directory on that device');
    expect(directory, path == null ? findsNothing : findsOneWidget);
    await t.enterText(find.widgetWithText(TextField, 'My project'), 'Jobs');
    if (path != null) {
      await t.enterText(
        find.widgetWithText(TextField, '~/projects/my-project'),
        path,
      );
    }
    await t.pump();
    await t.tap(find.widgetWithText(WebButton, 'Add workspace'));
    await t.pumpAndSettle();
    await _finish(t, c, g);
    return body;
  }

  testWidgets('add workspace picks a mode and omits the path per-session', (
    t,
  ) async {
    final body = await addWorkspace(
      t,
      modes: modeCatalogFixture,
      workspaces: modeWorkspacesFixture,
      nodes: modeNodesFixture,
      pick: 'Scratch',
    );
    expect(body, {
      'nodeId': 'device',
      'displayName': 'Jobs',
      'mode': 'scratch',
    });
  });

  testWidgets('add workspace hides a single mode and asks its path', (t) async {
    final body = await addWorkspace(
      t,
      modes: modeCatalogFixture,
      workspaces: modeWorkspacesFixture,
      nodes: [
        {
          'id': 'device',
          'modes': ['directory'],
        },
      ],
      path: '~/src/repo',
    );
    expect(body, {
      'nodeId': 'device',
      'displayName': 'Jobs',
      'mode': 'directory',
      'path': '~/src/repo',
    });
  });

  testWidgets('add workspace keeps path-only creation for older gateways', (
    t,
  ) async {
    final body = await addWorkspace(
      t,
      modes: const [],
      workspaces: modeWorkspacesFixture.map(_legacy).toList(),
      nodes: [
        {'id': 'device'},
      ],
      path: '~/src/repo',
    );
    expect(body, {
      'nodeId': 'device',
      'displayName': 'Jobs',
      'path': '~/src/repo',
    });
  });
}
