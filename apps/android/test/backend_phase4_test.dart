import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/conversation_composer.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/session_row.dart';
import 'live_test.dart' show FakeGateway, theme;

Widget shell(Widget child, {double scale = 1}) => MaterialApp(
  theme: theme.build(Brightness.light),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
    child: child!,
  ),
  home: Scaffold(body: child),
);
Future<LiveController> ready(FakeGateway g) async {
  g.snapshot = {
    ...g.snapshot,
    'approvalMode': 'auto',
    'defaultApprovalMode': 'auto',
  };
  final c = LiveController(g);
  await c.boot();
  await c.open('s');
  g.publish('s');
  return c;
}

void main() {
  testWidgets(
    'full-access warning and selectors fit a narrow enlarged composer',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(320, 900);
      addTearDown(t.view.reset);
      final g = FakeGateway(),
          c = await ready(g),
          text = TextEditingController();
      c.state = {...c.state, 'approvalMode': 'full-access'};
      await t.pumpWidget(
        shell(ConversationComposer(controller: c, text: text), scale: 2),
      );
      await t.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('composer-full-access-notice')),
        findsOneWidget,
      );
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      text.dispose();
      c.dispose();
      await g.stream.close();
    },
  );
  for (final status in ['completed', 'failed']) {
    testWidgets('delegated task $status is visible', (t) async {
      final g = FakeGateway(), c = await ready(g);
      await t.pumpWidget(
        shell(
          SessionRow(
            controller: c,
            session: {
              'id': 'd',
              'name': 'Delegated task',
              'workspaceId': 'w',
              'origin': {
                'kind': 'delegation',
                'title': 'Research',
                'status': status,
              },
            },
            onOpen: () {},
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(
        find.text(status == 'completed' ? 'Done' : 'Failed'),
        findsOneWidget,
      );
      expect(
        find.byTooltip(
          'Delegated: Research (${status == 'completed' ? 'finished' : 'failed'})',
        ),
        findsOneWidget,
      );
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    });
  }
}
