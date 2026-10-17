import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'attention_test.dart' show AttentionGateway;
import 'live_test.dart' show theme;

Finder get sidebarScroll => find
    .descendant(
      of: find.byType(SessionSidebar),
      matching: find.byWidgetPredicate(
        (w) => w is Scrollable && w.axisDirection == AxisDirection.down,
      ),
    )
    .first;

Future<void> reach(WidgetTester t, Finder target, {double delta = 180}) async {
  await t.scrollUntilVisible(target, delta, scrollable: sidebarScroll);
  await t.pumpAndSettle();
  expect(target.hitTestable(), findsOneWidget);
}

void main() {
  for (final width in [390.0, 650.0, 651.0, 768.0, 860.0, 861.0, 1024.0]) {
    for (final brightness in Brightness.values) {
      testWidgets(
        'App attention errors recover without replay at $width/${brightness.name}/2x',
        (t) async {
          t.view.devicePixelRatio = 1;
          t.view.physicalSize = Size(width, 844);
          t.platformDispatcher.textScaleFactorTestValue = 2;
          addTearDown(t.view.reset);
          addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
          final g = AttentionGateway(), c = LiveController(g)..mode = 'work';
          g.drafts['s'] = 'Keep my waiting-session draft 尚未送出';
          var dismissFails = true, approvalFails = true;
          final mutations = <Json>[];
          g.handler = (method, args) async {
            if (method == 'preferences') return {'appearance': brightness.name};
            if (method == 'request' && args['method'] == 'POST') {
              mutations.add(Map<String, dynamic>.from(args));
              if ('${args['path']}'.endsWith('/dismiss')) {
                if (dismissFails) {
                  throw PlatformException(
                    code: 'HTTP_503',
                    message: 'Chat node unavailable. Retry dismissal.',
                  );
                }
                g.data['missedRuns'] = [];
                (g.data['schedules'] as List).first['attention'] = 0;
                return <String, dynamic>{};
              }
              if ('${args['path']}'.endsWith('/approve')) {
                if (approvalFails) {
                  final proposals = g.memory['proposals'] as List;
                  proposals.first['target'] = {
                    'id': 'u',
                    'content': 'Updated by another chat.',
                    'revision': 2,
                  };
                  throw PlatformException(
                    code: 'HTTP_409',
                    message: 'Memory changed. Review the updated version.',
                  );
                }
                (g.data['memory'] as Map)['proposals'] = [];
                return g.memory;
              }
            }
            return g.normal(method, args);
          };
          await t.pumpWidget(MobileApp(theme: theme, controller: c));
          await t.pumpAndSettle();
          expect(c.attentionCount, 3);
          final sidebarContext = t.element(find.byType(SessionSidebar));
          expect(Theme.of(sidebarContext).brightness, brightness);
          expect(MediaQuery.textScalerOf(sidebarContext).scale(14), 28);

          await reach(t, find.text('Dismiss'));
          await t.tap(find.text('Dismiss'));
          await t.pumpAndSettle();
          expect(
            mutations.length,
            1,
            reason: 'Failed action must not be automatically resent.',
          );
          expect(c.attentionCount, 3);
          await reach(
            t,
            find.text('Chat node unavailable. Retry dismissal.'),
            delta: -180,
          );
          dismissFails = false;
          await reach(t, find.text('Dismiss'));
          await t.tap(find.text('Dismiss'));
          await t.pumpAndSettle();
          expect(mutations.length, 2);
          expect(
            mutations.map((m) => m['path']),
            everyElement('/api/schedules/daily/runs/missed-one/dismiss'),
          );
          expect(c.attentionCount, 2);
          expect(find.text('Dismiss'), findsNothing);
          expect(c.attention.scheduleError, isNull);

          await reach(t, find.text('Approve'));
          await t.tap(find.text('Approve'));
          await t.pumpAndSettle();
          expect(mutations.length, 3);
          expect(mutations.last['body'], {'targetRevision': 1});
          expect(c.attentionCount, 2);
          await reach(
            t,
            find.text('Memory changed. Review the updated version.'),
            delta: -180,
          );
          await reach(t, find.text('Update memory'));
          await t.tap(find.text('Update memory'));
          await t.pumpAndSettle();
          final changed = find.text('Now: Updated by another chat.');
          await t.ensureVisible(changed);
          await t.pumpAndSettle();
          expect(changed.hitTestable(), findsOneWidget);
          await t.tap(find.byTooltip('Close'));
          await t.pumpAndSettle();
          approvalFails = false;
          await reach(t, find.text('Approve'));
          await t.tap(find.text('Approve'));
          await t.pumpAndSettle();
          expect(mutations.length, 4);
          expect(mutations.last['path'], '/api/memory/proposals/p/approve');
          expect(mutations.last['body'], {'targetRevision': 2});
          expect(c.attentionCount, 1);
          expect(c.attention.memoryError, isNull);

          await reach(t, find.text('Reply'), delta: -180);
          await t.tap(find.text('Reply'));
          await t.pumpAndSettle();
          expect(c.sessionId, 's');
          g.publish('s');
          await t.pumpAndSettle();
          expect(
            find.byKey(const Key('live-draft')).hitTestable(),
            findsOneWidget,
          );
          expect(c.draft, 'Keep my waiting-session draft 尚未送出');
          expect(g.calls.where((call) => call.$1 == 'command'), isEmpty);
          expect(t.takeException(), isNull);
          await t.pumpWidget(const SizedBox());
          await g.stream.close();
        },
      );
    }
  }
}
