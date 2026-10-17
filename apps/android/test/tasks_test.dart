import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/tasks_state.dart';
import 'package:pirc_mobile/live/tasks_pane.dart';
import '../tool/parity/capture_fonts.dart' show loadParityFonts;
import 'live_test.dart' show FakeGateway, theme;

final fixture = obj(
  jsonDecode(
    File('../../fixtures/mobile-parity/tasks.json').readAsStringSync(),
  ),
);
void main() {
  testWidgets(
    'shared panel reads coalesce and a fresh signal queues exactly one follow-up; account changes discard old replies',
    (t) async {
      final g = FakeGateway(),
          c = LiveController(g)
            ..sessionId = 's'
            ..origin = 'one'
            ..clientId = 'a';
      final first = Completer<Json>(), second = Completer<Json>();
      var reads = 0;
      g.handler = (_, _) {
        reads++;
        return reads == 1 ? first.future : second.future;
      };
      final p = c.panelData;
      final a = p.refresh(),
          b = p.refresh(fresh: true),
          d = p.refresh(fresh: true);
      expect(reads, 1);
      first.complete(obj(fixture['panel']));
      await Future.wait([a, b, d]);
      await t.pump();
      expect(reads, 2);
      c.origin = 'two';
      c.clientId = 'b';
      c.changed();
      second.complete({'private': 'old account'});
      await t.pump();
      expect(p.value, isNull);
      g.handler = (_, _) async => throw PlatformException(
        code: 'HTTP_500',
        message: 'Panel unavailable',
      );
      await p.refresh();
      expect(p.error, 'Panel unavailable');
      g.handler = (_, _) async => fixture['panel'];
      await p.refresh();
      expect(p.error, isNull);
      expect(p.value?['agentRunning'], true);
      g.handler = (_, _) async =>
          throw PlatformException(code: 'HTTP_500', message: 'Refresh failed');
      await p.refresh();
      expect(p.value?['agentRunning'], true);
      expect(p.error, 'Refresh failed');
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'task selection uses 400 lines, keeps scope, and refreshes after status changes without polling',
    (t) async {
      final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
      var data = obj(fixture['panel']);
      var outputs = 0;
      g.handler = (_, a) async {
        if ('${a['path']}'.contains('/background/')) {
          outputs++;
          expect('${a['path']}', endsWith('?lines=400'));
          return fixture['output'];
        }
        return data;
      };
      final state = TasksState(c)..setActive(true);
      await t.pump();
      expect(state.tasks.map((t) => t['id']), ['watch-2', 'build-1']);
      expect(state.subagents.map((a) => a['name']), ['writer', 'reader']);
      await state.open(state.tasks.first);
      expect(outputs, 1);
      await t.pump(const Duration(seconds: 20));
      expect(outputs, 1);
      data = {
        ...data,
        'backgroundTasks': [
          for (final x in rows(data['backgroundTasks']))
            {...x, 'status': 'completed'},
        ],
      };
      g.stream.add({
        'type': 'panelChange',
        'sessionId': 's',
        'data': ['background'],
      });
      await t.pump(const Duration(milliseconds: 400));
      await t.pump();
      expect(outputs, 2);
      state.setActive(false);
      final before = g.calls.length;
      g.stream.add({
        'type': 'panelChange',
        'sessionId': 's',
        'data': ['team'],
      });
      await t.pump(const Duration(seconds: 1));
      expect(g.calls.length, before);
      state.setActive(true);
      await t.pump();
      expect(g.calls.length, greaterThan(before));
      final pending = Completer<Json>();
      g.handler = (_, _) => pending.future;
      final read = state.refreshOutput();
      state.back();
      pending.complete({
        'task': {'id': 'watch-2'},
        'output': 'discarded',
      });
      await read;
      expect(state.selected, isNull);
      expect(state.output, isNot('discarded'));
      state.dispose();
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets('a stale panel read cannot undo a confirmed stop', (t) async {
    final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
    final p = c.panelData;
    g.handler = (_, _) async => fixture['panel'];
    await p.refresh();
    final old = Completer<Json>(), next = Completer<Json>();
    var reads = 0;
    g.handler = (_, _) => ++reads == 1 ? old.future : next.future;
    final pending = p.refresh();
    p.updateTask({
      ...rows(p.value?['backgroundTasks']).last,
      'status': 'stopped',
    });
    old.complete(obj(fixture['panel']));
    await pending;
    await t.pump();
    expect(rows(p.value?['backgroundTasks']).last['status'], 'stopped');
    expect(reads, 2);
    next.complete(p.value!);
    await t.pump();
    c.dispose();
    await g.stream.close();
  });
  for (final scale in [1.0, 2.0]) {
    testWidgets('all task sections and output navigation at $scale text', (
      t,
    ) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(390, 1000);
      addTearDown(t.view.reset);
      final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
      g.handler = (_, a) async => '${a['path']}'.contains('/background/')
          ? fixture['output']
          : fixture['panel'];
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
          home: Scaffold(
            body: TasksPane(
              controller: c,
              clock: () => DateTime.fromMillisecondsSinceEpoch(fixture['now']),
            ),
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(find.text('BACKGROUND TASKS'), findsOneWidget);
      expect(find.text('watch 2'), findsOneWidget);
      expect(find.text('The node went offline.'), findsOneWidget);
      await t.ensureVisible(find.text('TASK BOARD'));
      await t.pumpAndSettle();
      expect(find.text('owner writer · after #1 · blocked'), findsOneWidget);
      await t.scrollUntilVisible(
        find.text('RECENT TEAM ACTIVITY'),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await t.pumpAndSettle();
      expect(find.text('reviewer → lead'), findsOneWidget);
      expect(
        find.text('Layout review complete. Two edge cases remain.'),
        findsOneWidget,
      );
      await t.scrollUntilVisible(
        find.text('bun run watch --verbose'),
        -300,
        scrollable: find.byType(Scrollable).first,
      );
      await t.pumpAndSettle();
      await t.tap(find.text('bun run watch --verbose'));
      await t.pumpAndSettle();
      expect(find.text('${obj(fixture['output'])['output']}'), findsOneWidget);
      await t.tap(find.byTooltip('Refresh output'));
      await t.pumpAndSettle();
      await t.tap(find.byTooltip('Back'));
      await t.pumpAndSettle();
      expect(find.text('BACKGROUND TASKS'), findsOneWidget);
      expect(g.calls.where((x) => x.$2['method'] == 'POST'), isEmpty);
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    });
  }

  testWidgets('2x task rows preserve flex items and CSS normal line metrics', (
    t,
  ) async {
    await t.runAsync(loadParityFonts);
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(390, 844);
    addTearDown(t.view.reset);

    final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
    g.handler = (_, _) async => fixture['panel'];
    final baseTheme = theme.build(Brightness.light);
    await t.pumpWidget(
      MaterialApp(
        theme: baseTheme.copyWith(
          textTheme: baseTheme.textTheme.apply(fontFamily: 'Arial'),
        ),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: Scaffold(
          body: TasksPane(
            controller: c,
            clock: () => DateTime.fromMillisecondsSinceEpoch(fixture['now']),
          ),
        ),
      ),
    );
    await t.pumpAndSettle();

    final watchId = find.text('watch-2');
    final watchDetails = find.text('· 42s');
    final watchRow = find.ancestor(of: watchId, matching: find.byType(InkWell));
    expect(watchDetails, findsOneWidget);
    // Web keeps the ID span and duration text item in separate flex rows when
    // they cannot share a line. The duration must not flow beside the ID's
    // final wrapped fragment in the native pane.
    expect(
      t.getTopLeft(watchDetails).dy,
      greaterThan(t.getTopLeft(watchId).dy),
    );
    expect(t.getSize(watchRow.first).height, closeTo(125, 3));

    final readerTask = find.text(
      'Inspect all routes and record the missing cases.',
    );
    expect(readerTask, findsOneWidget);
    // Flutter's natural Arial line metrics produce a 52px two-line box here;
    // Chrome's CSS normal line-height box measured 54px in the source oracle.
    expect(t.getSize(readerTask).height, closeTo(52, 1));
    expect(t.widget<Text>(readerTask).style?.height, kTextHeightNone);
    final taskBoard = t.widget<Text>(find.text('TASK BOARD'));
    expect(taskBoard.style?.letterSpacing, closeTo(.46, .001));
    expect(t.takeException(), isNull);

    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });
}
