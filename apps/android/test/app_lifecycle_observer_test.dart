import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show FakeGateway, theme;

int calls(FakeGateway g, String method) =>
    g.calls.where((call) => call.$1 == method).length;
void main() {
  testWidgets(
    'visible inactive interruption keeps watch and draft without reconnect',
    (t) async {
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      final g = FakeGateway(), c = LiveController(g, showing: 'engine');
      await t.pumpWidget(MobileApp(theme: theme, controller: c));
      await t.pumpAndSettle();
      await c.open('s');
      g.publish('s');
      await t.pumpAndSettle();
      await t.enterText(
        find.byKey(const Key('live-draft')),
        'visible interrupted draft',
      );
      final watchCount = calls(g, 'watch'), unwatchCount = calls(g, 'unwatch');
      try {
        t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
        await t.pump();
        expect(c.active, isTrue);
        expect(calls(g, 'unwatch'), unwatchCount);
        t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        await t.pumpAndSettle();
        expect(calls(g, 'watch'), watchCount);
        expect(c.draft, 'visible interrupted draft');
        expect(find.text('visible interrupted draft'), findsOneWidget);
      } finally {
        t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        await t.pumpWidget(const SizedBox());
        await g.stream.close();
      }
    },
  );
  testWidgets(
    'hidden and paused persist draft without unwatch; visible inactive refreshes once',
    (t) async {
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      final g = FakeGateway(), c = LiveController(g, showing: 'engine');
      await t.pumpWidget(MobileApp(theme: theme, controller: c));
      await t.pumpAndSettle();
      await c.open('s');
      g.publish('s');
      await t.pumpAndSettle();
      await t.enterText(
        find.byKey(const Key('live-draft')),
        'background retained draft',
      );
      final watchCount = calls(g, 'watch'), unwatchCount = calls(g, 'unwatch');
      try {
        t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
        t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        await t.pump();
        t.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        await t.pump();
        expect(c.active, isFalse);
        expect(calls(g, 'unwatch'), unwatchCount);
        expect(
          g.calls
              .lastWhere((call) => call.$1 == 'setWatchVisibility')
              .$2['visible'],
          isFalse,
        );
        expect(g.drafts['s'], 'background retained draft');
        t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
        await t.pump();
        expect(c.active, isTrue);
        expect(calls(g, 'watch'), watchCount + 1);
        t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        await t.pumpAndSettle();
        expect(c.active, isTrue);
        expect(calls(g, 'watch'), watchCount + 1);
        expect(c.draft, 'background retained draft');
      } finally {
        t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        await t.pumpWidget(const SizedBox());
        await g.stream.close();
      }
    },
  );
}
