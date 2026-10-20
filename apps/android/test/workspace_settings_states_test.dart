import 'dart:async';
import 'dart:ui' show SemanticsRole;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/workspace_settings.dart';
import 'live_test.dart' show FakeGateway, theme;

const directory = {'id': 'h:dir', 'hostId': 'h', 'kind': 'directory'};
Json config({bool trusted = false, bool empty = false}) => {
  'project': {
    'hash': empty ? null : 'reviewed',
    'trustedHash': trusted ? 'reviewed' : null,
    'trusted': trusted,
    'empty': empty,
    'hooks': {},
    'env': {},
    'allowedPaths': [],
  },
};
Widget host(LiveController c, Json workspace) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: Scaffold(
    body: SingleChildScrollView(
      child: WorkspaceSettings(controller: c, workspace: workspace),
    ),
  ),
);
Future<LiveController> mount(
  WidgetTester t,
  FakeGateway g,
  Json workspace,
) async {
  t.view.devicePixelRatio = 1;
  t.view.physicalSize = const Size(390, 900);
  addTearDown(t.view.reset);
  final c = LiveController(g)
    ..nodes = [
      {'id': 'h'},
    ];
  await t.pumpWidget(host(c, workspace));
  await t.pumpAndSettle();
  return c;
}

Future<void> finish(WidgetTester t, LiveController c, FakeGateway g) async {
  await t.pumpWidget(const SizedBox());
  c.dispose();
  await g.stream.close();
}

void main() {
  testWidgets(
    'revoke waits for acknowledgement and returns reviewed config to Trust',
    (t) async {
      final handle = t.ensureSemantics();
      final g = FakeGateway(), revoked = Completer<Json>();
      final writes = <Json>[];
      g.handler = (_, a) async {
        if (a['method'] == 'POST') {
          writes.add(a['body'] as Json);
          return revoked.future;
        }
        return config(trusted: true);
      };
      final c = await mount(t, g, directory);
      expect(find.text('Trusted'), findsOneWidget);
      expect(find.text('Trust'), findsNothing);
      await t.ensureVisible(find.text('Revoke trust'));
      await t.tap(find.text('Revoke trust'));
      await t.pump();
      expect(writes, [
        {'trusted': false},
      ]);
      expect(find.text('Trusted'), findsOneWidget);
      expect(
        t
            .getSemantics(find.bySemanticsLabel('Saving…'))
            .getSemanticsData()
            .role,
        SemanticsRole.status,
      );
      revoked.complete(config());
      await t.pumpAndSettle();
      expect(find.text('Revoke trust'), findsNothing);
      expect(find.text('Trust'), findsOneWidget);
      expect(find.text('Not trusted: ignored'), findsOneWidget);
      expect(
        t
            .getSemantics(
              find.bySemanticsLabel('Trust revoked. New sessions ignore them.'),
            )
            .getSemanticsData()
            .role,
        SemanticsRole.status,
      );
      await finish(t, c, g);
      handle.dispose();
    },
  );
  testWidgets(
    'hook event labels enlarge with text scale and omit empty matchers',
    (t) async {
      final g = FakeGateway();
      g.handler = (_, _) async => {
        'project': {
          ...config()['project'] as Json,
          'hooks': {
            'beforeTool': [
              {'command': 'npm test', 'matcher': ''},
            ],
          },
        },
      };
      final c = await mount(t, g, directory);
      final label = find.byWidgetPredicate(
        (w) => w is RichText && w.text.toPlainText() == 'Before a tool runs',
      );
      final original = t.getSize(label).height;
      t.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
      await t.pumpAndSettle();
      expect(t.getSize(label).height, greaterThanOrEqualTo(original * 1.9));
      expect(find.textContaining('Only for tools matching'), findsNothing);
      expect(t.takeException(), isNull);
      await finish(t, c, g);
    },
  );
  testWidgets('empty config exposes no trust decisions', (t) async {
    final g = FakeGateway();
    g.handler = (_, _) async => config(empty: true);
    final c = await mount(t, g, directory);
    expect(
      find.text(
        "This workspace's project config sets no hooks, environment, allowed paths or default model.",
      ),
      findsOneWidget,
    );
    expect(find.text('Trust'), findsNothing);
    expect(find.text('Revoke trust'), findsNothing);
    await finish(t, c, g);
  });
}
