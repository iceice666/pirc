import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/workspace_settings.dart';
import 'live_test.dart' show FakeGateway, theme;

const workspace = {
  'id': 'h:project',
  'hostId': 'h',
  'kind': 'directory',
  'displayName': 'Project',
};
Json project(String hash, {bool trusted = false}) => {
  'project': {
    'hash': hash,
    'trustedHash': trusted ? hash : null,
    'trusted': trusted,
    'empty': false,
    'hooks': {},
    'env': {'MODE': hash},
    'allowedPaths': [],
  },
};
Future<LiveController> mount(WidgetTester t, FakeGateway g) async {
  final c = LiveController(g, showing: 'engine')
    ..nodes = [
      {'id': 'h'},
    ];
  await t.pumpWidget(
    MaterialApp(
      theme: theme.build(Brightness.light),
      home: Scaffold(
        body: SingleChildScrollView(
          child: WorkspaceSettings(controller: c, workspace: workspace),
        ),
      ),
    ),
  );
  await t.pumpAndSettle();
  return c;
}

Future<void> finish(WidgetTester t, LiveController c, FakeGateway g) async {
  await t.pumpWidget(const SizedBox());
  c.dispose();
  await g.stream.close();
}

Future<void> trust(WidgetTester t) async {
  await t.ensureVisible(find.text('Trust'));
  await t.tap(find.text('Trust'));
  await t.pumpAndSettle();
}

void main() {
  for (final code in ['HTTP_403', 'NETWORK']) {
    testWidgets('project read $code shows the pinned error copy', (t) async {
      final g = FakeGateway();
      g.handler = (_, _) async => throw PlatformException(
        code: code,
        message: code == 'HTTP_403'
            ? 'Project access denied'
            : 'java.net.SocketException',
      );
      final c = await mount(t, g);
      expect(
        find.text(
          code == 'HTTP_403'
              ? 'Project access denied'
              : 'Unable to reach the gateway. Try again.',
        ),
        findsOneWidget,
      );
      expect(find.text('Trust'), findsNothing);
      await finish(t, c, g);
    });
    testWidgets('trust $code preserves reviewed data without a config reload', (
      t,
    ) async {
      final g = FakeGateway();
      var reads = 0, writes = 0;
      g.handler = (_, args) async {
        if (args['method'] == 'POST') {
          writes++;
          throw PlatformException(code: code, message: 'Project access denied');
        }
        reads++;
        return project('reviewed');
      };
      final c = await mount(t, g);
      await trust(t);
      expect(reads, 1);
      expect(writes, 1);
      expect(
        find.text(
          code == 'HTTP_403'
              ? 'Project access denied'
              : 'Unable to reach the gateway. Try again.',
        ),
        findsOneWidget,
      );
      expect(find.text('MODE=reviewed'), findsOneWidget);
      await finish(t, c, g);
    });
  }
  testWidgets(
    'trust conflict preserves its server message when review GET fails',
    (t) async {
      final g = FakeGateway();
      var reads = 0, writes = 0;
      g.handler = (_, args) async {
        if (args['method'] == 'POST') {
          writes++;
          throw PlatformException(
            code: 'HTTP_409',
            message: 'Review this changed configuration.',
          );
        }
        reads++;
        if (reads > 1) {
          throw PlatformException(code: 'NETWORK', message: 'offline');
        }
        return project('reviewed');
      };
      final c = await mount(t, g);
      await trust(t);
      expect(reads, 2);
      expect(writes, 1);
      expect(find.text('Review this changed configuration.'), findsOneWidget);
      expect(
        find.text('Unable to reach the gateway. Try again.'),
        findsNothing,
      );
      expect(find.text('MODE=reviewed'), findsOneWidget);
      await finish(t, c, g);
    },
  );
  testWidgets(
    'trust conflict updates review but never submits the changed hash automatically',
    (t) async {
      final g = FakeGateway();
      var reads = 0, writes = 0;
      g.handler = (_, args) async {
        if (args['method'] == 'POST') {
          writes++;
          throw PlatformException(
            code: 'HTTP_409',
            message:
                'The project config changed since it was shown; review it again before trusting it',
          );
        }
        return project(++reads == 1 ? 'reviewed' : 'changed');
      };
      final c = await mount(t, g);
      await trust(t);
      expect(reads, 2);
      expect(writes, 1);
      expect(find.text('MODE=changed'), findsOneWidget);
      expect(
        find.text(
          'The project config changed since it was shown; review it again before trusting it',
        ),
        findsOneWidget,
      );
      expect(find.text('Not trusted: ignored'), findsOneWidget);
      await finish(t, c, g);
    },
  );
  testWidgets(
    'late conflict review cannot overwrite a newer explicit successful trust',
    (t) async {
      final g = FakeGateway(), stale = Completer<Json>();
      var reads = 0, writes = 0;
      g.handler = (_, args) async {
        if (args['method'] == 'POST') {
          if (++writes == 1) {
            throw PlatformException(
              code: 'HTTP_409',
              message: 'Review the configuration.',
            );
          }
          // The real config can be externally restored to the originally reviewed
          // hash before this second explicit decision; its acknowledgement wins.
          return project('reviewed', trusted: true);
        }
        return ++reads == 1 ? project('reviewed') : stale.future;
      };
      final c = await mount(t, g);
      await trust(t);
      await trust(t);
      stale.complete(project('stale-other-hash'));
      await t.pumpAndSettle();
      expect(writes, 2);
      expect(reads, 2);
      expect(find.text('MODE=reviewed'), findsOneWidget);
      expect(find.text('Trusted'), findsOneWidget);
      expect(find.text('MODE=stale-other-hash'), findsNothing);
      await finish(t, c, g);
    },
  );
}
