import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
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
  final c = LiveController(g, showing: 'engine');
  await c.boot();
  await c.open('s');
  g.publish('s');
  return c;
}

void main() {
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
