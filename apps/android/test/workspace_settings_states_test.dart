import 'dart:async';
import 'dart:ui' show SemanticsRole, Tristate;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/workspace_settings.dart';
import 'live_test.dart' show FakeGateway, theme;

const chat = {'id': 'h:chat', 'hostId': 'h', 'kind': 'chat'};
const directory = {'id': 'h:dir', 'hostId': 'h', 'kind': 'directory'};
Json instructions(String value) => {
  'instructions': {'text': value, 'maxChars': 8000},
};
const capabilities = {
  'capabilities': {
    'delegation': true,
    'memory_search': true,
    'remote_recall': true,
    'schedules': true,
    'web_search': true,
  },
};
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
  for (final scale in [1.0, 2.0]) {
    testWidgets(
      'instruction paragraph optical size follows rendered text scale $scale',
      (t) async {
        t.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
        final g = FakeGateway();
        g.handler = (_, a) async => '${a['path']}'.endsWith('/instructions')
            ? instructions('Instructions')
            : capabilities;
        final c = await mount(t, g, chat);
        const explanation =
            'Instructions for every chat in this project. Only you can change them: the assistant cannot edit them. They are kept on the project\'s node, and each chat keeps the instructions it started with, so a change reaches new chats only.';
        final style = t.widget<Text>(find.text(explanation)).style!;
        expect(style.fontSize, 13);
        expect(style.height, 1.55);
        expect(style.letterSpacing, 0);
        expect(style.fontVariations, hasLength(1));
        final opticalSize = style.fontVariations!.single;
        expect(opticalSize.axis, 'opsz');
        expect(opticalSize.value, 13 * scale);

        final counterStyle = t
            .widget<Text>(find.text('12 / 8000 characters'))
            .style!;
        expect(counterStyle.fontSize, 13);
        expect(counterStyle.fontWeight, FontWeight.w400);
        expect(counterStyle.height, kTextHeightNone);
        expect(counterStyle.letterSpacing, 0);
        expect(counterStyle.fontVariations, hasLength(1));
        expect(counterStyle.fontVariations!.single.axis, 'opsz');
        expect(counterStyle.fontVariations!.single.value, 13 * scale);
        await finish(t, c, g);
      },
    );
  }

  testWidgets(
    'pending reads expose status and hide unloaded editors and policies',
    (t) async {
      final handle = t.ensureSemantics();
      final g = FakeGateway(),
          instructionRead = Completer<Json>(),
          policyRead = Completer<Json>();
      g.handler = (_, a) => '${a['path']}'.endsWith('/instructions')
          ? instructionRead.future
          : policyRead.future;
      final c = await mount(t, g, chat);
      expect(find.byType(TextField), findsNothing);
      expect(find.byType(Checkbox), findsNothing);
      for (final caption in [
        'Loading project instructions…',
        'Loading project capabilities…',
      ]) {
        expect(
          t
              .getSemantics(find.bySemanticsLabel(caption))
              .getSemanticsData()
              .role,
          SemanticsRole.status,
        );
      }
      instructionRead.complete(instructions('Loaded'));
      policyRead.complete(capabilities);
      await t.pumpAndSettle();
      expect(find.byType(TextField), findsOneWidget);
      expect(find.byType(Checkbox), findsNWidgets(5));
      expect(find.textContaining('Loading project'), findsNothing);
      await finish(t, c, g);
      handle.dispose();
    },
  );
  testWidgets(
    'failed instructions Retry replaces alert with pending status and editor',
    (t) async {
      final handle = t.ensureSemantics();
      final g = FakeGateway(), retry = Completer<Json>();
      var reads = 0;
      g.handler = (_, a) async {
        if ('${a['path']}'.endsWith('/instructions')) {
          if (++reads == 1) {
            throw PlatformException(
              code: 'HTTP_403',
              message: 'Instructions denied',
            );
          }
          return retry.future;
        }
        return capabilities;
      };
      final c = await mount(t, g, chat);
      expect(
        t
            .getSemantics(find.bySemanticsLabel('Instructions denied'))
            .getSemanticsData()
            .role,
        SemanticsRole.alert,
      );
      await t.tap(find.text('Retry'));
      await t.pump();
      expect(reads, 2);
      expect(find.text('Instructions denied'), findsNothing);
      expect(find.text('Retry'), findsNothing);
      expect(find.text('Loading project instructions…'), findsOneWidget);
      retry.complete(instructions('Read after retry'));
      await t.pumpAndSettle();
      expect(
        t.widget<TextField>(find.byType(TextField)).controller!.text,
        'Read after retry',
      );
      await finish(t, c, g);
      handle.dispose();
    },
  );
  testWidgets(
    'instruction save has one Saving button and announces only its result',
    (t) async {
      final handle = t.ensureSemantics();
      final g = FakeGateway(), saved = Completer<Json>();
      var writes = 0;
      g.handler = (_, a) async {
        if ('${a['path']}'.endsWith('/instructions')) {
          if (a['method'] == 'PATCH') {
            writes++;
            return saved.future;
          }
          return instructions('Original');
        }
        return capabilities;
      };
      final c = await mount(t, g, chat);
      await t.enterText(find.byType(TextField), 'Draft to save');
      await t.pump();
      await t.tap(find.byKey(const ValueKey('workspace-instructions-save')));
      await t.pump();
      expect(writes, 1);
      expect(find.text('Saving…'), findsOneWidget);
      expect(t.widget<TextField>(find.byType(TextField)).enabled, isFalse);
      saved.complete(instructions('Draft to save'));
      await t.pumpAndSettle();
      const result =
          'Project instructions saved. New chats in this project will use them.';
      expect(
        t.getSemantics(find.bySemanticsLabel(result)).getSemanticsData().role,
        SemanticsRole.status,
      );
      expect(find.text('Saving…'), findsNothing);
      await finish(t, c, g);
      handle.dispose();
    },
  );
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
  testWidgets(
    'offline unmount drops instructions draft and reconnect loads fresh server text',
    (t) async {
      final g = FakeGateway();
      var reads = 0, capabilityReads = 0;
      g.handler = (_, a) async {
        final path = '${a['path']}';
        if (path.endsWith('/instructions')) {
          return instructions(
            ++reads == 1 ? 'Original instructions' : 'Changed while offline',
          );
        }
        if (path.endsWith('/capabilities')) {
          capabilityReads++;
          return capabilities;
        }
        if (path.endsWith('/links')) return {'links': <Json>[]};
        return <String, dynamic>{};
      };
      final c = await mount(t, g, chat);
      await t.enterText(
        find.byType(TextField),
        'Unsaved edit before node went offline',
      );
      await t.pump();
      c.nodes = [];
      await t.pumpWidget(host(c, chat));
      await t.pumpAndSettle();
      expect(find.byType(TextField), findsNothing);
      expect(
        find.textContaining("The project's node is offline"),
        findsOneWidget,
      );
      expect(find.byType(Checkbox), findsNWidgets(5));
      c.nodes = [
        {'id': 'h'},
      ];
      await t.pumpWidget(host(c, chat));
      await t.pumpAndSettle();
      expect(reads, 2);
      expect(capabilityReads, 1);
      expect(
        t.widget<TextField>(find.byType(TextField)).controller!.text,
        'Changed while offline',
      );
      expect(find.text('Unsaved edit before node went offline'), findsNothing);
      await finish(t, c, g);
    },
  );
  testWidgets('capability switches share one named native group', (t) async {
    final handle = t.ensureSemantics();
    final g = FakeGateway();
    g.handler = (_, a) async => '${a['path']}'.endsWith('/instructions')
        ? instructions('Instructions')
        : capabilities;
    final c = await mount(t, g, chat);
    t.view.physicalSize = const Size(390, 1600);
    await t.pumpAndSettle();
    final group = t.getSemantics(
      find.byKey(const ValueKey('project-capabilities-group')),
    );
    expect(group.label, 'Allowed assistant features');
    final labels = <String>[];
    group.visitChildren((node) {
      if (node.getSemanticsData().flagsCollection.isToggled != Tristate.none) {
        labels.add(node.label);
      }
      return true;
    });
    expect(labels, [
      'Delegation',
      'Memory search',
      'Remote recall',
      'Schedules',
      'Web search',
    ]);
    await finish(t, c, g);
    handle.dispose();
  });
}
