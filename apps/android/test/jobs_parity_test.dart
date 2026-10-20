import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/jobs_menu.dart';
import 'package:pirc_mobile/live/jobs_state.dart';
import 'live_test.dart' show FakeGateway, theme;

Json job(String id, String status) => {
  'id': id,
  'status': status,
  'command': 'command $id',
  'startedAt': 1000,
  'endedAt': status == 'running' ? null : 5000,
};
Json get fixture => {
  'backgroundTasks': [
    job('done', 'completed'),
    job('one', 'running'),
    job('two', 'running'),
  ],
  'team': {
    'agents': [
      {
        'name': 'reader',
        'status': 'working',
        'mode': 'subagent',
        'task': 'Inspect files',
      },
      {'name': 'gone', 'status': 'done'},
    ],
  },
};
LiveController controller(FakeGateway g) => LiveController(g)
  ..sessionId = 's'
  ..origin = 'https://test'
  ..clientId = 'phone'
  ..connection = 'live'
  ..control = {'held': true, 'generation': 3};
Widget shell(Widget child, {double scale = 1}) => MaterialApp(
  theme: theme.build(Brightness.light),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
    child: child!,
  ),
  home: Scaffold(
    body: Align(alignment: Alignment.topRight, child: child),
  ),
);
void main() {
  for (final width in [390.0, 768.0]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'agent names center without blank task lines $width scale$scale',
        (t) async {
          t.view.devicePixelRatio = 1;
          t.view.physicalSize = Size(width, 900);
          addTearDown(t.view.reset);
          final g = FakeGateway(), c = controller(g);
          final data = <String, dynamic>{
            'backgroundTasks': <Json>[],
            'team': {
              'agents': [
                {
                  'name': 'web',
                  'status': 'running',
                  'mode': 'subagent',
                  'task': ' \n\t ',
                },
                {'name': 'android', 'status': 'running', 'mode': 'subagent'},
                {
                  'name': 'reviewer',
                  'status': 'running',
                  'mode': 'subagent',
                  'task': '\n  Inspect files  \n',
                },
              ],
            },
          };
          g.handler = (_, __) async => data;
          final jobs = JobsState(c)..data = data;
          try {
            await t.pumpWidget(shell(JobsList(jobs: jobs), scale: scale));
            await t.pump();
            for (final name in ['web', 'android']) {
              final label = find.text(name);
              final row = find
                  .ancestor(of: label, matching: find.byType(Row))
                  .first;
              final icon = find.descendant(
                of: row,
                matching: find.byType(Icon),
              );
              final status = find.descendant(
                of: row,
                matching: find.text('running'),
              );
              expect(
                t.getCenter(label).dy,
                closeTo(t.getCenter(icon).dy, 0.01),
                reason: '$name icon center',
              );
              expect(
                t.getCenter(label).dy,
                closeTo(t.getCenter(status).dy, 0.01),
                reason: '$name status center',
              );
            }
            expect(find.text('Inspect files'), findsOneWidget);
            expect(find.text(' \n\t '), findsNothing);
            expect(t.takeException(), isNull);
          } finally {
            await t.pumpWidget(const SizedBox.shrink());
            jobs.dispose();
            c.dispose();
            await g.stream.close();
          }
        },
      );
    }
  }
  test('task detail and duration follow the web', () {
    expect(jobDetail({'status': 'completed', 'exitCode': 4}), 'exit 4');
    expect(jobDetail({'status': 'failed', 'exitCode': 0}), 'exit 0');
    expect(jobDetail({'status': 'timed_out'}), 'timed out');
    expect(
      jobDuration({'startedAt': 1000, 'endedAt': 64600}, DateTime.now()),
      '1m 4s',
    );
  });
  testWidgets('two presses stop once with lease and clearing is local', (
    t,
  ) async {
    final g = FakeGateway();
    final live = controller(g);
    final stop = Completer<Json>();
    g.handler = (method, args) async {
      if ('${args['path']}'.endsWith('/stop')) return stop.future;
      if ('${args['path']}'.endsWith('/panel/state')) return fixture;
      return {'output': 'tail'};
    };
    final j = JobsState(live);
    await t.pump(const Duration(milliseconds: 100));
    expect(j.live.map((e) => e['id']), ['two', 'one']);
    expect(j.agents.length, 1);
    await j.pressStop(j.live.first);
    expect(j.armed, 'two');
    expect(g.calls.where((e) => '${e.$2['path']}'.endsWith('/stop')), isEmpty);
    final request = j.pressStop(j.live.first);
    await j.pressStop(j.live.first);
    final calls = g.calls
        .where((e) => '${e.$2['path']}'.endsWith('/stop'))
        .toList();
    expect(calls.length, 1);
    expect(calls.single.$2['body'], {'clientId': 'phone', 'generation': 3});
    stop.complete({'task': job('two', 'stopping')});
    await request;
    expect(j.tasks.first['status'], 'stopping');
    j.clearFinished();
    expect(j.finished, isEmpty);
    expect(g.calls.where((e) => e.$2['method'] == 'DELETE'), isEmpty);
    j.dispose();
    live.dispose();
    await g.stream.close();
  });
  testWidgets(
    'stale panel and output reads cannot cross tasks or conversations',
    (t) async {
      final g = FakeGateway();
      final live = controller(g),
          read = Completer<Json>(),
          output = Completer<Json>();
      g.handler = (_, args) async => '${args['path']}'.contains('/background/')
          ? output.future
          : read.future;
      final j = JobsState(live);
      await t.pump(const Duration(milliseconds: 100));
      j.data = fixture;
      final pending = j.toggleTask(j.live.first);
      live.sessionId = 'new';
      live.changed();
      read.complete(fixture);
      output.complete({'output': 'old secret'});
      await pending;
      await t.pump();
      expect(j.data, isEmpty);
      expect(j.output, isEmpty);
      expect(j.expanded, isNull);
      j.dispose();
      live.dispose();
      await g.stream.close();
    },
  );
  testWidgets('output polling backs off, stops closed, and resumes', (t) async {
    final g = FakeGateway(), c = controller(g);
    g.handler = (_, args) async => '${args['path']}'.contains('/background/')
        ? {'output': 'same'}
        : fixture;
    final j = JobsState(c);
    await t.pump(const Duration(milliseconds: 100));
    j.setOpen(true);
    await t.pump();
    await j.toggleTask(j.live.first);
    int reads() =>
        g.calls.where((e) => '${e.$2['path']}'.contains('?lines=200')).length;
    expect(reads(), 1);
    await t.pump(const Duration(seconds: 2));
    expect(reads(), 2);
    await t.pump(const Duration(seconds: 2));
    expect(reads(), 2);
    await t.pump(const Duration(seconds: 1));
    expect(reads(), 3);
    j.setOpen(false);
    await t.pump(const Duration(seconds: 20));
    expect(reads(), 3);
    j.setOpen(true);
    await t.pump();
    expect(reads(), 4);
    j.dispose();
    c.dispose();
    await g.stream.close();
  });
  testWidgets(
    'panel signal refreshes jobs and lost control prevents stopping',
    (t) async {
      final g = FakeGateway(), c = controller(g);
      var reads = 0;
      g.handler = (_, args) async {
        if ('${args['path']}'.endsWith('/panel/state')) {
          reads++;
          return fixture;
        }
        return {};
      };
      final j = JobsState(c);
      await t.pump(const Duration(milliseconds: 100));
      g.stream.add({
        'type': 'panelChange',
        'sessionId': 's',
        'data': ['background'],
      });
      await t.pump(const Duration(milliseconds: 100));
      expect(reads, 2);
      await j.pressStop(j.live.first);
      await t.pump(const Duration(seconds: 3));
      expect(j.armed, isNull);
      await j.pressStop(j.live.first);
      c.control = {'held': false};
      c.changed();
      await j.pressStop(j.live.first);
      expect(
        g.calls.where((e) => '${e.$2['path']}'.endsWith('/stop')),
        isEmpty,
      );
      j.dispose();
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets('late task output and uncertain stop are not replayed', (
    t,
  ) async {
    final g = FakeGateway(), c = controller(g);
    final old = Completer<Json>();
    var stops = 0;
    g.handler = (_, args) async {
      final path = '${args['path']}';
      if (path.endsWith('/stop')) {
        stops++;
        throw PlatformException(code: 'network', message: 'Connection lost');
      }
      if (path.contains('/background/two?')) return old.future;
      if (path.contains('/background/one?')) return {'output': 'new task'};
      return fixture;
    };
    final j = JobsState(c);
    await t.pump(const Duration(milliseconds: 100));
    final pending = j.toggleTask(j.live.first);
    await j.toggleTask(j.live.last);
    old.complete({'output': 'stale task'});
    await pending;
    expect(j.output, 'new task');
    await j.pressStop(j.live.last);
    await j.pressStop(j.live.last);
    await t.pump(const Duration(seconds: 20));
    expect(stops, 1);
    expect(j.stopError, contains('Connection lost'));
    expect(j.stopping, isNull);
    expect(j.live.last['status'], 'running');
    j.dispose();
    c.dispose();
    await g.stream.close();
  });
  testWidgets(
    'menu opens, shows output, closes with Escape at phone and tablet widths',
    (t) async {
      for (final width in [390.0, 651.0, 1024.0]) {
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size(width, 844);
        final g = FakeGateway(), c = controller(g);
        g.handler = (_, args) async =>
            '${args['path']}'.contains('/background/')
            ? {'output': 'native task output'}
            : fixture;
        await t.pumpWidget(shell(JobsMenu(controller: c), scale: 2));
        await t.pump(const Duration(milliseconds: 100));
        await t.pump();
        await t.tap(find.byTooltip('Background jobs'));
        await t.pump();
        await t.pump();
        expect(find.text('Running'), findsOneWidget);
        await t.tap(find.text('command two'));
        await t.pump();
        expect(find.text('native task output'), findsOneWidget);
        expect(t.takeException(), isNull);
        await t.sendKeyEvent(LogicalKeyboardKey.escape);
        await t.pump();
        await t.pump();
        expect(find.text('Running'), findsNothing);
        await t.pumpWidget(const SizedBox());
        c.dispose();
        await g.stream.close();
      }
      t.view.reset();
    },
  );
}
