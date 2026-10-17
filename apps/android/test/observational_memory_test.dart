import 'dart:ui' show SemanticsRole;
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/observational_memory_state.dart';
import 'package:pirc_mobile/live/observational_memory_pane.dart';
import 'live_test.dart' show FakeGateway, theme;

final memoryFixture = obj(
  jsonDecode(
    File(
      '../../fixtures/mobile-parity/observational-memory.json',
    ).readAsStringSync(),
  ),
);
Json memoryView(String view) {
  final p = obj(memoryFixture['panel']);
  return {
    ...p,
    if (view == 'working') 'memoryRuntime': memoryFixture['working'],
    if (view == 'disabled') 'memory': {...obj(p['memory']), 'enabled': false},
    if (view == 'unavailable') 'memory': null,
  };
}

void main() {
  test('token labels preserve web rounding boundaries', () {
    expect([0, 999, 1000, 1250, 9999, 10000, 10500].map(memoryTokens), [
      '0',
      '999',
      '1.0k',
      '1.3k',
      '10.0k',
      '10k',
      '11k',
    ]);
  });
  testWidgets(
    'memory observes only visible relevant events and retains filter/expansion across refresh',
    (t) async {
      final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
      g.handler = (_, _) async => memoryView('active');
      final s = ObservationalMemoryState(c)..setActive(true);
      await t.pump();
      expect(s.observations.map((o) => o['id']), [
        'a00000000003',
        'a00000000001',
      ]);
      s.setFilter('dropped');
      s.toggle('a00000000002');
      expect(s.observations.single['dropped'], true);
      final before = g.calls.length;
      g.stream.add({
        'type': 'panelChange',
        'sessionId': 's',
        'data': ['team'],
      });
      await t.pump(const Duration(seconds: 1));
      expect(g.calls.length, before);
      g.stream.add({
        'type': 'panelChange',
        'sessionId': 's',
        'data': ['memory'],
      });
      await t.pump(const Duration(milliseconds: 400));
      await t.pump();
      expect(g.calls.length, before + 1);
      expect(s.expanded, contains('a00000000002'));
      s.setActive(false);
      g.stream.add({
        'type': 'panelChange',
        'sessionId': 's',
        'data': ['memory'],
      });
      await t.pump(const Duration(seconds: 1));
      expect(g.calls.length, before + 1);
      s.setActive(true);
      await t.pump();
      expect(g.calls.length, before + 2);
      c.state = {
        'run': {'status': 'running'},
      };
      c.changed();
      c.state = {
        'run': {'status': 'idle'},
      };
      c.changed();
      await t.pump(const Duration(milliseconds: 100));
      await t.pump();
      expect(g.calls.length, before + 3);
      final pending = Completer<Json>(), next = Completer<Json>();
      g.handler = (_, args) => '${args['path']}'.contains('/sessions/new/')
          ? next.future
          : pending.future;
      final read = c.panelData.refresh();
      c.sessionId = 'new';
      c.changed();
      pending.complete(memoryView('active'));
      await read;
      await t.pump();
      expect(s.session, 'new');
      expect(s.memory, isNull);
      next.complete({...memoryView('active'), 'memory': null});
      await t.pump();
      expect(s.memory, isNull);
      s.dispose();
      c.dispose();
      await g.stream.close();
    },
  );
  for (final width in [390.0, 420.0]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('memory filters and expansion at $width and $scale text', (
        t,
      ) async {
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size(width, 1200);
        addTearDown(t.view.reset);
        final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
        g.handler = (_, _) async => memoryView('active');
        await t.pumpWidget(
          MaterialApp(
            theme: theme.build(Brightness.light),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: Scaffold(body: ObservationalMemoryPane(controller: c)),
          ),
        );
        await t.pumpAndSettle();
        expect(find.text('Passive'), findsOneWidget);
        expect(find.text('Active observation pool'), findsOneWidget);
        final semantics = t.ensureSemantics();
        expect(find.bySemanticsLabel('Next reflection'), findsOneWidget);
        expect(
          t.getSemantics(find.bySemanticsLabel('Next reflection')).value,
          '100%',
        );
        expect(
          t
              .getSemantics(find.bySemanticsLabel('Next reflection'))
              .getSemanticsData()
              .role,
          SemanticsRole.progressBar,
        );
        semantics.dispose();
        final all = find.byKey(const ValueKey('memory-filter-all'));
        await t.scrollUntilVisible(
          find.text('OBSERVATIONS'),
          300,
          scrollable: find.byType(Scrollable).last,
        );
        await t.pumpAndSettle();
        await t.drag(
          find.byKey(const ValueKey('memory-pane-horizontal-scroll')),
          const Offset(-300, 0),
        );
        await t.pumpAndSettle();
        expect(all.hitTestable(), findsOneWidget);
        await t.tap(all);
        await t.pumpAndSettle();
        final dropped = find.byKey(const ValueKey('memory-entry-a00000000002'));
        await t.ensureVisible(dropped);
        await t.pumpAndSettle();
        expect(dropped, findsOneWidget);
        final long = find.byKey(const ValueKey('memory-entry-a00000000001'));
        await t.ensureVisible(long);
        await t.pumpAndSettle();
        final body = find
            .descendant(of: long, matching: find.byType(Text))
            .first;
        expect(
          t.widget<Text>(body).textSpan!.toPlainText(),
          contains('**plain text**'),
        );
        expect(t.widget<Text>(body).maxLines, 3);
        await t.tap(long);
        await t.pumpAndSettle();
        expect(t.widget<Text>(body).maxLines, isNull);
        await t.ensureVisible(
          find.byKey(const ValueKey('memory-filter-dropped')),
        );
        await t.pumpAndSettle();
        await t.tap(find.byKey(const ValueKey('memory-filter-dropped')));
        await t.pumpAndSettle();
        expect(long, findsNothing);
        expect(dropped, findsOneWidget);
        expect(g.calls.where((c) => c.$2['method'] == 'POST'), isEmpty);
        expect(t.takeException(), isNull);
        await t.pumpWidget(const SizedBox());
        c.dispose();
        await g.stream.close();
      });
    }
  }
  testWidgets(
    '390px 2x memory stats use the unscrolled panel breakpoint and fixed chip height',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(390, 844);
      addTearDown(t.view.reset);
      final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
      g.handler = (_, _) async => memoryView('active');
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(2)),
            child: child!,
          ),
          home: Scaffold(body: ObservationalMemoryPane(controller: c)),
        ),
      );
      await t.pumpAndSettle();

      final reflections = find.byKey(const ValueKey('memory-stat-reflections'));
      final active = find.byKey(const ValueKey('memory-stat-active'));
      final dropped = find.byKey(const ValueKey('memory-stat-dropped'));
      final compactions = find.byKey(const ValueKey('memory-stat-compactions'));
      expect(reflections, findsOneWidget);
      expect(active, findsOneWidget);
      expect(dropped, findsOneWidget);
      expect(compactions, findsOneWidget);
      expect(t.getRect(reflections).top, t.getRect(active).top);
      expect(t.getRect(dropped).top, greaterThan(t.getRect(reflections).top));
      expect(t.getRect(compactions).top, t.getRect(dropped).top);
      expect(
        t.getSize(active).width,
        greaterThan(170),
        reason: 'The source 390px panel uses two stats columns.',
      );
      expect(
        t.getSize(find.byKey(const ValueKey('memory-status-chip-Idle'))).height,
        20,
        reason: 'Source status chips retain their fixed 20px height at 2x.',
      );
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    '650px 2x memory keeps observation filters in the no-wrap heading row',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(650, 844);
      addTearDown(t.view.reset);
      final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
      g.handler = (_, _) async => memoryView('active');
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(2)),
            child: child!,
          ),
          home: Scaffold(
            body: ObservationalMemoryPane(
              controller: c,
              clock: () => DateTime.fromMillisecondsSinceEpoch(
                memoryFixture['now'] as int,
              ),
            ),
          ),
        ),
      );
      await t.pumpAndSettle();

      expect(
        c.panelData.value,
        isNotNull,
        reason: 'Memory fixture request: ${g.calls}',
      );
      expect(c.panelData.value?['memory'], isNotNull);
      expect(find.text('Passive'), findsOneWidget);
      final statCards = [
        'reflections',
        'active',
        'dropped',
        'compactions',
      ].map((name) => find.byKey(ValueKey('memory-stat-$name')));
      final statTop = t.getRect(statCards.first).top;
      for (final card in statCards) {
        expect(t.getRect(card).top, statTop);
      }
      expect(
        t.getSize(find.byKey(const ValueKey('memory-status-chip-Idle'))).height,
        20,
      );
      final activeEntry = find.byKey(
        const ValueKey('memory-entry-a00000000003'),
      );
      final metadataFinder = find
          .descendant(of: activeEntry, matching: find.byType(Text))
          .last;
      final heading = find.text('OBSERVATIONS');
      final activeFilter = find.byKey(const ValueKey('memory-filter-active'));
      final verticalScroll = find.byType(Scrollable).last;
      await t.scrollUntilVisible(heading, 300, scrollable: verticalScroll);
      await t.pumpAndSettle();
      expect(activeFilter, findsOneWidget);
      expect(heading, findsOneWidget);
      expect(
        (t.getRect(heading).center.dy - t.getRect(activeFilter).center.dy)
            .abs(),
        lessThan(4),
        reason: 'The 650px Web flex row keeps its title and filters aligned.',
      );
      final metadata = t.widget<Text>(metadataFinder);

      expect(metadata.textSpan!.toPlainText(), contains('2026-10-03 09:04'));
      expect(
        t.getRect(metadataFinder).top,
        lessThan(844),
        reason:
            'The observation timestamp remains reachable below the heading.',
      );
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'loading, unavailable, disabled and runtime errors use exact states; old data survives a refresh error',
    (t) async {
      final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
      final pending = Completer<Json>();
      g.handler = (_, _) => pending.future;
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.dark),
          home: Scaffold(
            body: ObservationalMemoryPane(
              controller: c,
              clock: () =>
                  DateTime.fromMillisecondsSinceEpoch(memoryFixture['now']),
            ),
          ),
        ),
      );
      expect(find.text('Loading…'), findsOneWidget);
      pending.completeError(
        PlatformException(
          code: 'HTTP_500',
          message: 'Memory service unavailable',
        ),
      );
      await t.pumpAndSettle();
      expect(find.text('Memory service unavailable'), findsOneWidget);
      for (final view in ['unavailable', 'disabled', 'working']) {
        g.handler = (_, _) async => memoryView(view);
        await c.panelData.refresh();
        await t.pump();
        if (view == 'unavailable') {
          expect(
            find.text('Memory state is unavailable for this session.'),
            findsOneWidget,
          );
        }
        if (view == 'disabled') {
          expect(
            find.text(
              'Observational memory is disabled in this workspace’s config.',
            ),
            findsOneWidget,
          );
        }
      }
      expect(find.text('Observing recent turns'), findsOneWidget);
      expect(
        find.text('reflector: Model is temporarily unavailable.'),
        findsOneWidget,
      );
      expect(find.textContaining('expired-model'), findsNothing);
      expect(
        find.textContaining('native-test rate-limited until'),
        findsOneWidget,
      );
      g.handler = (_, _) async => throw PlatformException(
        code: 'HTTP_500',
        message: 'Late refresh failed',
      );
      await c.panelData.refresh();
      await t.pump();
      expect(find.text('Late refresh failed'), findsNothing);
      expect(find.text('Observing recent turns'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
}
