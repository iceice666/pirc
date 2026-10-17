import 'dart:async';
import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/workspace_settings.dart';

import 'live_test.dart' show FakeGateway, theme;

const _chat = <String, dynamic>{
  'id': 'node:shared-project',
  'hostId': 'node',
  'kind': 'chat',
  'displayName': 'Shared project',
};
const _directory = <String, dynamic>{
  'id': 'node:shared-project',
  'hostId': 'node',
  'kind': 'directory',
  'displayName': 'Shared project',
};

class _TestController extends LiveController {
  _TestController(super.gateway);

  int revision = 0;

  @override
  int get accountRevision => revision;
}

_TestController _controller(
  FakeGateway gateway, {
  String stamp = 'stamp-one',
}) => _TestController(gateway)
  ..booting = false
  ..origin = 'https://gateway.example'
  ..clientId = 'phone'
  ..pairingStamp = stamp
  ..nodes = [
    {'id': 'node'},
  ];

Widget _host(LiveController controller, Json workspace) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: Scaffold(
    body: SingleChildScrollView(
      child: WorkspaceSettings(controller: controller, workspace: workspace),
    ),
  ),
);

Json _instructions(String text) => {
  'instructions': {'text': text, 'maxChars': 8000},
};

Json _capabilities() => {
  'capabilities': {
    'delegation': true,
    'memory_search': true,
    'remote_recall': true,
    'schedules': true,
    'web_search': true,
  },
};

Json _projectConfig(String version) => {
  'project': {
    'hash': 'hash-$version',
    'trustedHash': null,
    'trusted': false,
    'empty': false,
    'hooks': <String, dynamic>{},
    'env': {'MODE': version},
    'allowedPaths': <String>[],
  },
};

String _instructionsText(WidgetTester tester) =>
    tester.widget<TextField>(find.byType(TextField).first).controller!.text;

Future<void> _clean(
  WidgetTester tester,
  Iterable<(LiveController, FakeGateway)> pairs,
) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump();
  for (final (controller, gateway) in pairs) {
    controller.dispose();
    await gateway.stream.close();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  for (final change in ['origin', 'clientId', 'pairingStamp', 'revision']) {
    testWidgets(
      'same workspace id reloads and rejects stale instructions after $change changes',
      (tester) async {
        final gateway = FakeGateway();
        final stale = Completer<dynamic>();
        var instructionReads = 0;
        gateway.handler = (method, args) async {
          if (method != 'request') return gateway.normal(method, args);
          final path = args['path'] as String;
          if (path.endsWith('/instructions')) {
            instructionReads++;
            if (instructionReads == 1) return stale.future;
            return _instructions('Fresh instructions');
          }
          if (path.endsWith('/capabilities')) return _capabilities();
          return <String, dynamic>{};
        };
        final controller = _controller(gateway);
        await tester.pumpWidget(_host(controller, _chat));
        await tester.pumpAndSettle();
        expect(instructionReads, 1);

        switch (change) {
          case 'origin':
            controller.origin = 'https://new-gateway.example';
            break;
          case 'clientId':
            controller.clientId = 'replacement-phone';
            break;
          case 'pairingStamp':
            controller.pairingStamp = 'stamp-two';
            break;
          case 'revision':
            controller.revision++;
            break;
        }
        await tester.pumpWidget(_host(controller, _chat));
        await tester.pumpAndSettle();

        stale.complete(_instructions('Stale instructions'));
        await tester.pumpAndSettle();

        expect(instructionReads, 2);
        expect(_instructionsText(tester), 'Fresh instructions');
        await _clean(tester, [(controller, gateway)]);
      },
    );
  }

  testWidgets(
    'same workspace id switching controller ignores old load and starts new one',
    (tester) async {
      final oldGateway = FakeGateway();
      final oldRead = Completer<dynamic>();
      var oldInstructionReads = 0;
      oldGateway.handler = (method, args) async {
        if (method != 'request') return oldGateway.normal(method, args);
        final path = args['path'] as String;
        if (path.endsWith('/instructions')) {
          oldInstructionReads++;
          return oldRead.future;
        }
        if (path.endsWith('/capabilities')) return _capabilities();
        return <String, dynamic>{};
      };
      final newGateway = FakeGateway();
      var newInstructionReads = 0;
      newGateway.handler = (method, args) async {
        if (method != 'request') return newGateway.normal(method, args);
        final path = args['path'] as String;
        if (path.endsWith('/instructions')) {
          newInstructionReads++;
          return _instructions('New controller instructions');
        }
        if (path.endsWith('/capabilities')) return _capabilities();
        return <String, dynamic>{};
      };
      final oldController = _controller(oldGateway);
      final newController = _controller(newGateway, stamp: 'stamp-two');

      await tester.pumpWidget(_host(oldController, _chat));
      await tester.pumpAndSettle();
      await tester.pumpWidget(_host(newController, _chat));
      await tester.pumpAndSettle();

      oldRead.complete(_instructions('Old controller instructions'));
      await tester.pumpAndSettle();

      expect(oldInstructionReads, 1);
      expect(newInstructionReads, 1);
      expect(_instructionsText(tester), 'New controller instructions');
      await _clean(tester, [
        (oldController, oldGateway),
        (newController, newGateway),
      ]);
    },
  );

  testWidgets(
    'project config reloads after the workspace goes offline and returns',
    (tester) async {
      final gateway = FakeGateway();
      var reads = 0;
      gateway.handler = (method, args) async {
        if (method != 'request') return gateway.normal(method, args);
        final path = args['path'] as String;
        if (path.endsWith('/project-config')) {
          reads++;
          return _projectConfig('version-$reads');
        }
        return <String, dynamic>{};
      };
      final controller = _controller(gateway);
      await tester.pumpWidget(_host(controller, _directory));
      await tester.pumpAndSettle();
      expect(reads, 1);
      expect(find.text('MODE=version-1'), findsOneWidget);

      controller.nodes = [];
      await tester.pumpWidget(_host(controller, _directory));
      await tester.pumpAndSettle();
      expect(find.textContaining('node is offline'), findsOneWidget);

      controller.nodes = [
        {'id': 'node'},
      ];
      await tester.pumpWidget(_host(controller, _directory));
      await tester.pumpAndSettle();

      expect(reads, 2);
      expect(find.text('MODE=version-2'), findsOneWidget);
      await _clean(tester, [(controller, gateway)]);
    },
  );
  testWidgets('capability label toggles once and waits for the server policy', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    final gateway = FakeGateway();
    final write = Completer<dynamic>();
    final patches = <Json>[];
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      final path = args['path'] as String;
      if (path.endsWith('/instructions')) return _instructions('Instructions');
      if (path.endsWith('/capabilities')) {
        if (args['method'] == 'PATCH') {
          patches.add(args);
          return write.future;
        }
        return _capabilities();
      }
      return <String, dynamic>{};
    };
    final controller = _controller(gateway);
    await tester.pumpWidget(_host(controller, _chat));
    await tester.pumpAndSettle();
    final label = find.text('Delegation');
    await tester.ensureVisible(label);
    await tester.pumpAndSettle();
    final toggle = find.bySemanticsLabel('Delegation');
    expect(
      tester.getSemantics(toggle).getSemanticsData().flagsCollection.isToggled,
      Tristate.isTrue,
    );
    await tester.tap(label);
    await tester.pump();
    expect(patches, hasLength(1));
    expect(patches.single['body'], {
      'capabilities': {'delegation': false},
    });
    expect(tester.widget<Checkbox>(find.byType(Checkbox).first).value, isTrue);
    expect(
      tester
          .getSemantics(toggle)
          .getSemanticsData()
          .hasAction(SemanticsAction.tap),
      isFalse,
    );
    await tester.tap(label);
    await tester.pump();
    expect(patches, hasLength(1));
    write.complete({
      'capabilities': {
        ..._capabilities()['capabilities'] as Json,
        'delegation': false,
      },
    });
    await tester.pumpAndSettle();
    expect(tester.widget<Checkbox>(find.byType(Checkbox).first).value, isFalse);
    expect(
      tester.getSemantics(toggle).getSemanticsData().flagsCollection.isToggled,
      Tristate.isFalse,
    );
    expect(
      tester
          .getSemantics(toggle)
          .getSemanticsData()
          .hasAction(SemanticsAction.tap),
      isTrue,
    );
    await _clean(tester, [(controller, gateway)]);
    semantics.dispose();
  });
  testWidgets('late capability write cannot unlock a replacement scope write', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final oldWrite = Completer<dynamic>();
    final newWrite = Completer<dynamic>();
    var writes = 0;
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      final path = args['path'] as String;
      if (path.endsWith('/instructions')) {
        return _instructions('Project instructions');
      }
      if (path.endsWith('/capabilities')) {
        if (args['method'] == 'PATCH') {
          writes++;
          return writes == 1 ? oldWrite.future : newWrite.future;
        }
        return _capabilities();
      }
      return <String, dynamic>{};
    };
    final controller = _controller(gateway);
    await tester.pumpWidget(_host(controller, _chat));
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.byType(Checkbox).first);
    await tester.tap(find.byType(Checkbox).first);
    await tester.pump();
    expect(writes, 1);
    expect(find.text('Saving project capabilities…'), findsOneWidget);

    controller.revision++;
    await tester.pumpWidget(_host(controller, _chat));
    await tester.pumpAndSettle();
    expect(find.text('Saving project capabilities…'), findsNothing);

    await tester.ensureVisible(find.byType(Checkbox).first);
    await tester.tap(find.byType(Checkbox).first);
    await tester.pump();
    expect(writes, 2);
    expect(find.text('Saving project capabilities…'), findsOneWidget);

    oldWrite.complete({
      'capabilities': {
        'delegation': false,
        'memory_search': true,
        'remote_recall': true,
        'schedules': true,
        'web_search': true,
      },
    });
    await tester.pumpAndSettle();
    expect(find.text('Saving project capabilities…'), findsOneWidget);
    expect(writes, 2);

    newWrite.complete({
      'capabilities': {
        'delegation': false,
        'memory_search': true,
        'remote_recall': true,
        'schedules': true,
        'web_search': true,
      },
    });
    await tester.pumpAndSettle();
    expect(find.text('Saving project capabilities…'), findsNothing);
    await _clean(tester, [(controller, gateway)]);
  });

  testWidgets('failed instruction save keeps the edited draft', (tester) async {
    final gateway = FakeGateway();
    var writes = 0;
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      final path = args['path'] as String;
      if (path.endsWith('/instructions')) {
        if (args['method'] == 'PATCH') {
          writes++;
          throw PlatformException(
            code: 'HTTP_403',
            message: 'instruction save denied',
          );
        }
        return _instructions('Server instructions');
      }
      if (path.endsWith('/capabilities')) return _capabilities();
      return <String, dynamic>{};
    };
    final controller = _controller(gateway);
    await tester.pumpWidget(_host(controller, _chat));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, 'Keep my local draft');
    await tester.pumpAndSettle();
    final instructionSave = find.byKey(
      const ValueKey('workspace-instructions-save'),
    );
    await tester.tap(instructionSave);
    await tester.pumpAndSettle();

    expect(writes, 1);
    expect(_instructionsText(tester), 'Keep my local draft');
    expect(find.text('instruction save denied'), findsOneWidget);
    expect(
      find.descendant(of: instructionSave, matching: find.text('Save')),
      findsOneWidget,
    );
    await _clean(tester, [(controller, gateway)]);
  });
  testWidgets('workspace id change rejects the previous instructions read', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final stale = Completer<dynamic>();
    var instructionReads = 0;
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      final path = args['path'] as String;
      if (path.endsWith('/instructions')) {
        instructionReads++;
        if (instructionReads == 1) return stale.future;
        return _instructions('Other project instructions');
      }
      if (path.endsWith('/capabilities')) return _capabilities();
      return <String, dynamic>{};
    };
    final controller = _controller(gateway);
    final otherWorkspace = {..._chat, 'id': 'node:other-project'};
    await tester.pumpWidget(_host(controller, _chat));
    await tester.pumpAndSettle();

    await tester.pumpWidget(_host(controller, otherWorkspace));
    await tester.pumpAndSettle();
    stale.complete(_instructions('Previous project instructions'));
    await tester.pumpAndSettle();

    expect(instructionReads, 2);
    expect(_instructionsText(tester), 'Other project instructions');
    await _clean(tester, [(controller, gateway)]);
  });

  testWidgets('workspace kind change does not retain the previous kind data', (
    tester,
  ) async {
    final gateway = FakeGateway();
    final stale = Completer<dynamic>();
    var instructionReads = 0;
    gateway.handler = (method, args) async {
      if (method != 'request') return gateway.normal(method, args);
      final path = args['path'] as String;
      if (path.endsWith('/instructions')) {
        instructionReads++;
        if (instructionReads == 1) return stale.future;
        return _instructions('Fresh chat instructions');
      }
      if (path.endsWith('/capabilities')) return _capabilities();
      if (path.endsWith('/project-config')) return _projectConfig('directory');
      return <String, dynamic>{};
    };
    final controller = _controller(gateway);
    await tester.pumpWidget(_host(controller, _chat));
    await tester.pumpAndSettle();

    await tester.pumpWidget(_host(controller, _directory));
    await tester.pumpAndSettle();
    expect(find.text('MODE=directory'), findsOneWidget);
    stale.complete(_instructions('Stale chat instructions'));
    await tester.pumpAndSettle();

    await tester.pumpWidget(_host(controller, _chat));
    await tester.pumpAndSettle();
    expect(instructionReads, 2);
    expect(_instructionsText(tester), 'Fresh chat instructions');
    await _clean(tester, [(controller, gateway)]);
  });

  testWidgets(
    'late instructions reload preserves an edit made while the read is pending',
    (tester) async {
      final gateway = FakeGateway();
      final reload = Completer<dynamic>();
      var instructionReads = 0;
      gateway.handler = (method, args) async {
        if (method != 'request') return gateway.normal(method, args);
        final path = args['path'] as String;
        if (path.endsWith('/instructions')) {
          instructionReads++;
          if (instructionReads == 1) {
            return {
              'instructions': {'text': 'Initial server text', 'maxChars': 80},
            };
          }
          return reload.future;
        }
        if (path.endsWith('/capabilities')) return _capabilities();
        return <String, dynamic>{};
      };
      final controller = _controller(gateway);
      await tester.pumpWidget(_host(controller, _chat));
      await tester.pumpAndSettle();
      expect(_instructionsText(tester), 'Initial server text');

      final dynamic state = tester.state(find.byType(WorkspaceSettings));
      final Future<void> pendingReload = state.load('instructions');
      await tester.pump();
      expect(instructionReads, 2);

      await tester.enterText(find.byType(TextField).first, 'New local draft');
      await tester.pump();
      reload.complete({
        'instructions': {'text': 'Updated server baseline', 'maxChars': 24},
      });
      await pendingReload;
      await tester.pumpAndSettle();

      expect(_instructionsText(tester), 'New local draft');
      expect(state.saved, 'Updated server baseline');
      expect(state.maxChars, 24);
      expect(find.text('15 / 24 characters'), findsOneWidget);
      await _clean(tester, [(controller, gateway)]);
    },
  );
}
