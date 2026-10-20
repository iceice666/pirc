import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/workspace_settings.dart';

import 'live_test.dart' show FakeGateway, theme;

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
}
