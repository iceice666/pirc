import 'package:pirc_mobile/live/web_length_formatter.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/schedules_state.dart';
import 'package:pirc_mobile/live/schedules_page.dart';
import 'live_test.dart' show FakeGateway, theme;

Json schedule(String id, {bool online = true, String status = 'active'}) => {
  'id': id,
  'workspaceId': 'node:project',
  'workspace': {'name': 'Project', 'node': 'node', 'online': online},
  'title': id,
  'prompt': 'Read the latest changes.',
  'cron': '0 9 * * *',
  'runAt': null,
  'timezone': 'Asia/Taipei',
  'status': status,
  'nextRunAt': 1790989200000,
  'attention': 0,
  'model': null,
};

class ScheduleGateway extends FakeGateway {
  List<Json> schedules = [
    schedule('Daily'),
    schedule('Offline', online: false, status: 'paused'),
    schedule('Finished', status: 'done'),
  ];
  List<Json> models = [
    {'provider': 'a/b', 'id': 'c', 'name': 'Available', 'available': true},
    {'provider': 'a', 'id': 'b/c', 'name': 'Unavailable', 'available': false},
    {'provider': 'missing', 'id': 'flag'},
  ];
  List<Json> runs = [
    {
      'id': 'missed/one',
      'status': 'missed',
      'dueAt': 1790902800000,
      'createdAt': 1790902800000,
      'result': 'Awaiting approval',
    },
    {
      'id': 'complete',
      'status': 'completed',
      'dueAt': 1790902800000,
      'createdAt': 1790902800000,
      'sessionId': 'chat',
      'session': 'Review',
      'result': 'Finished\nRead the changes.',
    },
    {
      'id': 'deleted',
      'status': 'completed',
      'dueAt': 1790902800000,
      'createdAt': 1790902800000,
      'sessionId': 'gone',
      'session': null,
    },
  ];
  @override
  dynamic normal(String method, Json args) {
    if (method == 'timeZoneInfo') {
      return {
        'default': 'Asia/Taipei',
        'zones': ['Asia/Taipei', 'UTC'],
      };
    }
    if (method == 'request') {
      final path = '${args['path']}';
      if (path == '/api/schedules') return {'schedules': schedules};
      if (path.startsWith('/api/schedules/') && args['method'] == 'GET') {
        return {'schedule': schedules.first, 'runs': runs};
      }
      if (path == '/api/models') return {'models': models};
    }
    return super.normal(method, args);
  }
}

LiveController controller(ScheduleGateway g) => LiveController(g)
  ..origin = 'https://one'
  ..clientId = 'one'
  ..workspaces = [
    {'id': 'node:project', 'displayName': 'Project', 'hostId': 'node'},
    {'id': 'local', 'displayName': 'Local'},
  ];
Widget shell(Widget child, {double scale = 1}) => MaterialApp(
  theme: theme.build(Brightness.light),
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
    child: child!,
  ),
  home: Scaffold(body: child),
);
Future<void> tap(WidgetTester t, String label, {Finder? within}) async {
  final f = within == null
      ? find.widgetWithText(TextButton, label)
      : find.descendant(
          of: within,
          matching: find.widgetWithText(TextButton, label),
        );
  FocusManager.instance.primaryFocus?.unfocus();
  await t.pumpAndSettle();
  await t.ensureVisible(f);
  await t.pumpAndSettle();
  await t.tap(f);
  await t.pumpAndSettle();
}

void main() {
  testWidgets('timezone keyboard chip only fills the field then Done submits', (
    t,
  ) async {
    final g = ScheduleGateway(), c = controller(g);
    await t.pumpWidget(shell(SchedulesPage(controller: c)));
    await t.pumpAndSettle();
    await tap(t, 'New schedule');
    await t.enterText(
      find.byKey(const ValueKey('schedule-field-Prompt')),
      'Run task',
    );
    final zone = find.byKey(const ValueKey('schedule-field-Time zone'));
    await t.ensureVisible(zone);
    await t.enterText(zone, 'Asia');
    await t.pumpAndSettle();
    t.view.viewInsets = const FakeViewPadding(bottom: 200);
    addTearDown(t.view.resetViewInsets);
    await t.pumpAndSettle();
    expect(find.byKey(const ValueKey('keyboard-suggestions')), findsOneWidget);
    await t.tap(find.byKey(const ValueKey('keyboard-suggestion-Asia/Taipei')));
    await t.pumpAndSettle();
    expect(t.widget<TextField>(zone).controller!.text, 'Asia/Taipei');
    expect(g.calls.where((x) => x.$2['method'] == 'POST'), isEmpty);
    await t.testTextInput.receiveAction(TextInputAction.done);
    await t.pumpAndSettle();
    final posts = g.calls.where((x) => x.$2['method'] == 'POST').toList();
    expect(posts, hasLength(1));
    expect(obj(posts.single.$2['body'])['timezone'], 'Asia/Taipei');
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });
  testWidgets(
    'timezone Enter and Done submit typed values without choosing suggestions',
    (t) async {
      for (final value in ['Asia/Taipei', 'Europe/Paris', 'Asia', '']) {
        for (final hardware in [true, false]) {
          final g = ScheduleGateway(), c = controller(g);
          await t.pumpWidget(shell(SchedulesPage(controller: c)));
          await t.pumpAndSettle();
          await tap(t, 'New schedule');
          await t.enterText(
            find.byKey(const ValueKey('schedule-field-Prompt')),
            'Run task',
          );
          final zone = find.byKey(const ValueKey('schedule-field-Time zone'));
          await t.ensureVisible(zone);
          await t.enterText(zone, value);
          await t.pumpAndSettle();
          if (hardware) {
            await t.sendKeyEvent(LogicalKeyboardKey.enter);
          } else {
            await t.testTextInput.receiveAction(TextInputAction.done);
          }
          await t.pumpAndSettle();
          final posts = g.calls.where((x) => x.$2['method'] == 'POST').toList();
          if (value.isEmpty) {
            expect(posts, isEmpty);
          } else {
            expect(posts, hasLength(1), reason: '$value hardware=$hardware');
            expect(obj(posts.single.$2['body'])['timezone'], value);
          }
          await t.pumpWidget(const SizedBox());
          c.dispose();
          await g.stream.close();
        }
      }
    },
  );

  test('schedule title matches browser UTF-16 replacement limits', () {
    final fixture =
        jsonDecode(
              File(
                '../../fixtures/mobile-parity/schedule-title.json',
              ).readAsStringSync(),
            )
            as Map;
    const formatter = WebLengthFormatter(80);
    for (final entry in fixture['cases'] as List) {
      final old = entry['old'] as String, insert = entry['insert'] as String;
      final start = entry['start'] as int, end = entry['end'] as int;
      final value = formatter.formatEditUpdate(
        TextEditingValue(
          text: old,
          selection: TextSelection(baseOffset: start, extentOffset: end),
        ),
        TextEditingValue(
          text: old.replaceRange(start, end, insert),
          selection: TextSelection.collapsed(offset: start + insert.length),
        ),
      );
      expect(value.text, entry['value'], reason: entry['name']);
      expect(
        value.selection.extentOffset,
        entry['selection'],
        reason: entry['name'],
      );
    }
  });

  testWidgets('schedule Title enforces the browser emoji limit', (t) async {
    final g = ScheduleGateway(), c = controller(g);
    await t.pumpWidget(shell(SchedulesPage(controller: c)));
    await t.pumpAndSettle();
    await tap(t, 'New schedule');
    final title = find.byKey(const ValueKey('schedule-field-Title'));
    await t.enterText(title, '😀' * 41);
    expect(t.widget<TextField>(title).controller!.text, '😀' * 40);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });

  testWidgets(
    'one-shot picker edits only the draft until Create and preserves timezone',
    (t) async {
      final g = ScheduleGateway(), c = controller(g);
      await t.pumpWidget(shell(SchedulesPage(controller: c)));
      await t.pumpAndSettle();
      await tap(t, 'New schedule');
      await t.enterText(
        find.byKey(const ValueKey('schedule-field-Prompt')),
        'Run task',
      );
      await t.ensureVisible(find.text('Once'));
      await t.tap(find.text('Once'));
      await t.pumpAndSettle();
      final time = find.byKey(const ValueKey('schedule-field-Time'));
      final open = find.byKey(const ValueKey('schedule-open-time-picker'));
      Future<void> openPicker() async {
        FocusManager.instance.primaryFocus?.unfocus();
        await t.pumpAndSettle();
        await t.ensureVisible(open);
        await t.tap(open);
        await t.pumpAndSettle();
      }

      await t.enterText(time, '2026-01-31T09:30');
      await openPicker();
      await t.enterText(
        find.byKey(const ValueKey('schedule-picker-Month')),
        'Feb',
      );
      await tap(t, 'Cancel', within: find.byType(Dialog));
      expect(t.widget<TextField>(time).controller!.text, '2026-01-31T09:30');
      await openPicker();
      await tap(t, 'Clear', within: find.byType(Dialog));
      expect(t.widget<TextField>(time).controller!.text, isEmpty);
      expect(g.calls.where((x) => x.$2['method'] == 'POST'), isEmpty);
      await t.enterText(time, '2026-01-31T09:30');
      await openPicker();
      await t.enterText(
        find.byKey(const ValueKey('schedule-picker-Month')),
        'Feb',
      );
      await tap(t, 'Set', within: find.byType(Dialog));
      expect(t.widget<TextField>(time).controller!.text, '2026-02-28T09:30');
      expect(g.calls.where((x) => x.$2['method'] == 'POST'), isEmpty);
      await tap(t, 'Create');
      final body = obj(
        g.calls.singleWhere((x) => x.$2['method'] == 'POST').$2['body'],
      );
      expect(body['at'], '2026-02-28T09:30');
      expect(body['timezone'], 'Asia/Taipei');
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  test('one-shot wall time matches pinned browser constraint cases', () {
    final fixture =
        jsonDecode(
              File(
                '../../fixtures/mobile-parity/schedule-datetime.json',
              ).readAsStringSync(),
            )
            as Map;
    for (final entry in fixture['cases'] as List) {
      expect(
        scheduleWallTime(entry['input'] as String),
        entry['valid'] == true ? entry['value'] : null,
        reason: '${entry['input']}',
      );
    }
  });

  testWidgets(
    'invalid one-shot date stays editable without a request then normalizes a valid date',
    (t) async {
      final g = ScheduleGateway(), c = controller(g);
      await t.pumpWidget(shell(SchedulesPage(controller: c)));
      await t.pumpAndSettle();
      await tap(t, 'New schedule');
      await t.enterText(
        find.byKey(const ValueKey('schedule-field-Prompt')),
        'Run task',
      );
      await t.ensureVisible(find.text('Once'));
      await t.tap(find.text('Once'));
      await t.pumpAndSettle();
      final time = find.byKey(const ValueKey('schedule-field-Time'));
      await t.enterText(time, '2026-02-29T12:00');
      await t.testTextInput.receiveAction(TextInputAction.done);
      await t.pumpAndSettle();
      expect(g.calls.where((x) => x.$2['method'] == 'POST'), isEmpty);
      expect(t.widget<TextField>(time).controller!.text, '2026-02-29T12:00');
      expect(t.widget<TextField>(time).focusNode!.hasFocus, isTrue);
      expect(
        find.text('Enter a valid date and time (YYYY-MM-DDTHH:mm).'),
        findsOneWidget,
      );
      await t.enterText(time, '2028-02-29 12:00:00');
      await t.testTextInput.receiveAction(TextInputAction.done);
      await t.pumpAndSettle();
      final body = obj(
        g.calls.singleWhere((x) => x.$2['method'] == 'POST').$2['body'],
      );
      expect(body['at'], '2028-02-29T12:00');
      expect(body['timezone'], 'Asia/Taipei');
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );

  testWidgets(
    'cron numpad Enter and once keyboard Done submit exact schedule fields',
    (t) async {
      for (final once in [false, true]) {
        final g = ScheduleGateway(), c = controller(g);
        await t.pumpWidget(shell(SchedulesPage(controller: c)));
        await t.pumpAndSettle();
        await tap(t, 'New schedule');
        await t.enterText(
          find.byKey(const ValueKey('schedule-field-Prompt')),
          'Run this task',
        );
        if (once) {
          await t.ensureVisible(find.text('Once'));
          await t.tap(find.text('Once'));
          await t.pumpAndSettle();
          await t.enterText(
            find.byKey(const ValueKey('schedule-field-Time')),
            '2026-11-05T09:30',
          );
          await t.testTextInput.receiveAction(TextInputAction.done);
        } else {
          await t.enterText(
            find.byKey(
              const ValueKey(
                'schedule-field-Cron (minute hour day month weekday)',
              ),
            ),
            '0 10 * * *',
          );
          await t.sendKeyEvent(LogicalKeyboardKey.numpadEnter);
        }
        await t.pumpAndSettle();
        final requests = g.calls
            .where((x) => x.$2['method'] == 'POST')
            .toList();
        expect(requests.length, 1);
        final body = obj(requests.single.$2['body']);
        expect(
          body[once ? 'at' : 'cron'],
          once ? '2026-11-05T09:30' : '0 10 * * *',
        );
        expect(body['timezone'], 'Asia/Taipei');
        await t.pumpWidget(const SizedBox());
        c.dispose();
        await g.stream.close();
      }
    },
  );

  testWidgets(
    'single-line schedule Enter submits once and preserves multiline editing',
    (t) async {
      final g = ScheduleGateway(), c = controller(g);
      final pending = Completer<Json>();
      g.handler = (method, args) async {
        if (args['method'] == 'POST') return pending.future;
        return g.normal(method, args);
      };
      await t.pumpWidget(shell(SchedulesPage(controller: c)));
      await t.pumpAndSettle();
      await tap(t, 'New schedule');
      final prompt = find.byKey(const ValueKey('schedule-field-Prompt'));
      final title = find.byKey(const ValueKey('schedule-field-Title'));
      await t.enterText(prompt, 'Draft\nsecond line');
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(g.calls.where((x) => x.$2['method'] == 'POST'), isEmpty);
      await t.enterText(title, 'Schedule');
      final input = t.widget<TextField>(title).controller!;
      input.value = const TextEditingValue(
        text: 'Schedule',
        selection: TextSelection.collapsed(offset: 8),
        composing: TextRange(start: 0, end: 8),
      );
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(g.calls.where((x) => x.$2['method'] == 'POST'), isEmpty);
      input.clearComposing();
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pump();
      expect(g.calls.where((x) => x.$2['method'] == 'POST').length, 1);
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pump();
      expect(g.calls.where((x) => x.$2['method'] == 'POST').length, 1);
      final body = obj(
        g.calls.singleWhere((x) => x.$2['method'] == 'POST').$2['body'],
      );
      expect(body['title'], 'Schedule');
      expect(body['prompt'], contains('second line'));
      pending.complete({});
      await t.pumpAndSettle();
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );

  test('cron descriptions and relative clocks mirror fixed web semantics', () {
    expect(describeCron('* * * * *'), 'Every minute');
    expect(describeCron('*/15 * * * *'), 'Every 15 minutes');
    expect(describeCron('5 */3 * * *'), 'Every 3 hours at :05');
    expect(describeCron('0 9 * * 1-5'), 'Weekdays at 09:00');
    expect(describeCron('0 9 * * 0,6'), 'Weekends at 09:00');
    expect(describeCron('0 9 * * 1,7'), 'Every Monday, Sunday at 09:00');
    expect(describeCron('0 9 01 * *'), 'Monthly on day 1 at 09:00');
    expect(describeCron('0 9 * 2 *'), '0 9 * 2 *');
    expect(scheduleUntil(60000, 0), 'in 1m');
    expect(scheduleUntil(90000, 0), 'in 2m');
    expect(scheduleAgo(0, 59000), 'just now');
    expect(
      scheduleModelKey({'provider': 'a/b', 'id': 'c'}),
      isNot(scheduleModelKey({'provider': 'a', 'id': 'b/c'})),
    );
  });
  test('late list/history cannot cross reads or account changes', () async {
    final g = ScheduleGateway(), live = controller(g);
    final state = SchedulesState(live);
    final old = Completer<dynamic>();
    var first = true;
    g.handler = (m, a) {
      if (a['path'] == '/api/schedules' && first) {
        first = false;
        return old.future;
      }
      return Future.value(g.normal(m, a));
    };
    final pending = state.load();
    await state.load();
    expect(state.schedules.first['id'], 'Daily');
    old.complete({
      'schedules': [schedule('stale')],
    });
    await pending;
    expect(state.schedules.first['id'], 'Daily');
    final detail = Completer<dynamic>();
    g.handler = (m, a) => a['path'] == '/api/schedules/Daily'
        ? detail.future
        : Future.value(g.normal(m, a));
    final history = state.focus('Daily');
    await state.focus('Offline');
    detail.complete({
      'schedule': schedule('Daily'),
      'runs': [
        {'id': 'old'},
      ],
    });
    await history;
    expect(state.runs.first['id'], 'missed/one');
    final mutation = Completer<dynamic>();
    g.handler = (m, a) =>
        a['method'] == 'PATCH' ? mutation.future : Future.value(g.normal(m, a));
    final write = state.mutate(
      'Daily',
      '/api/schedules/Daily',
      method: 'PATCH',
      body: {'status': 'paused'},
    );
    live.origin = 'https://two';
    live.changed();
    mutation.complete({});
    expect(await write, isFalse);
    expect(state.busy, isNull);
    await Future<void>.delayed(Duration.zero);
    state.dispose();
    live.dispose();
    await g.stream.close();
  });
  test(
    'mutations are single flight and uncertain failures reconcile without retry',
    () async {
      final g = ScheduleGateway(), c = controller(g), s = SchedulesState(c);
      final result = Completer<dynamic>();
      g.handler = (m, a) =>
          a['method'] == 'POST' ? result.future : Future.value(g.normal(m, a));
      final pending = s.mutate(
        'run',
        '/api/schedules/Daily/run',
        body: {'runId': 'r'},
      );
      expect(
        await s.mutate('run', '/api/schedules/Daily/run', body: {}),
        isFalse,
      );
      result.completeError(
        PlatformException(code: 'offline', message: 'Response lost'),
      );
      expect(await pending, isFalse);
      expect(s.error, 'Response lost');
      expect(g.calls.where((x) => x.$2['method'] == 'POST').length, 1);
      expect(s.schedules.length, 3);
      expect(s.busy, isNull);
      s.dispose();
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'inline history, offline gates, finished status and two-step deletion',
    (t) async {
      final g = ScheduleGateway(), c = controller(g);
      String? opened;
      t.view.physicalSize = const Size(390, 844);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      await t.pumpWidget(
        shell(SchedulesPage(controller: c, onOpenChat: (id) => opened = id)),
      );
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      final daily = find.byKey(const ValueKey('schedule-Daily')),
          offline = find.byKey(const ValueKey('schedule-Offline')),
          finished = find.byKey(const ValueKey('schedule-Finished'));
      expect(
        t
            .widget<TextButton>(
              find.descendant(
                of: offline,
                matching: find.widgetWithText(TextButton, 'Run now'),
              ),
            )
            .onPressed,
        isNull,
      );
      expect(
        find.descendant(of: finished, matching: find.text('Resume')),
        findsNothing,
      );
      await tap(t, 'Runs', within: daily);
      await tap(t, 'Open session', within: daily);
      expect(opened, 'chat');
      expect(find.widgetWithText(TextButton, 'Open session'), findsOneWidget);
      await tap(t, 'Allow and run now', within: daily);
      expect(
        g.calls
            .where((c) => c.$2['path'] == '/api/schedules/Daily/run')
            .single
            .$2['body'],
        {'runId': 'missed/one'},
      );
      await tap(t, 'Dismiss', within: daily);
      expect(
        g.calls.any(
          (c) =>
              c.$2['path'] ==
                  '/api/schedules/Daily/runs/missed%2Fone/dismiss' &&
              c.$2['method'] == 'POST',
        ),
        isTrue,
      );
      await tap(t, 'Delete', within: daily);
      expect(g.calls.where((x) => x.$2['method'] == 'DELETE'), isEmpty);
      await tap(t, 'Delete for good', within: daily);
      expect(g.calls.where((x) => x.$2['method'] == 'DELETE').length, 1);
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets('new schedules can choose only models marked available', (
    t,
  ) async {
    t.view.physicalSize = const Size(390, 844);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    final g = ScheduleGateway(), c = controller(g);
    g.schedules = [];
    await t.pumpWidget(shell(SchedulesPage(controller: c)));
    await t.pumpAndSettle();
    await tap(t, 'New schedule');
    await t.pumpAndSettle();

    final form = t.widget<ScheduleForm>(find.byType(ScheduleForm));
    final stateModels = form.state.models;
    expect(stateModels[0]['available'], isTrue);
    expect(stateModels[1]['available'], isFalse);
    expect(stateModels[2].containsKey('available'), isFalse);

    final modelFinder = find.byKey(const ValueKey('schedule-select-Model'));
    final dropdown = t.widget<DropdownButton<String>>(modelFinder);
    expect(dropdown.items!.map((item) => item.value), [
      '',
      scheduleModelKey({'provider': 'a/b', 'id': 'c'}),
    ]);
    await t.ensureVisible(modelFinder);
    await t.pumpAndSettle();
    await t.tap(modelFinder);
    await t.pumpAndSettle();
    await t.tap(find.text('Available · a/b').last);
    await t.pumpAndSettle();
    await t.enterText(
      find.byKey(const ValueKey('schedule-field-Prompt')),
      'Read the latest changes.',
    );
    await tap(t, 'Create');
    final body = obj(
      g.calls
          .singleWhere(
            (call) =>
                call.$2['method'] == 'POST' &&
                call.$2['path'] == '/api/schedules',
          )
          .$2['body'],
    );
    expect(body['model'], {'provider': 'a/b', 'id': 'c'});
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });

  testWidgets('saved unavailable model stays selected and survives save', (
    t,
  ) async {
    t.view.physicalSize = const Size(390, 844);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    final g = ScheduleGateway(), c = controller(g);
    final savedModel = {'provider': 'a', 'id': 'b/c'};
    g.schedules = [
      {...schedule('Saved'), 'model': savedModel},
    ];
    await t.pumpWidget(shell(SchedulesPage(controller: c)));
    await t.pumpAndSettle();
    final card = find.byKey(const ValueKey('schedule-Saved'));
    await tap(t, 'Edit', within: card);
    await t.pumpAndSettle();

    final modelFinder = find.byKey(const ValueKey('schedule-select-Model'));
    final dropdown = t.widget<DropdownButton<String>>(modelFinder);
    final savedKey = scheduleModelKey(savedModel);
    expect(dropdown.value, savedKey);
    expect(dropdown.items!.map((item) => item.value), [
      '',
      scheduleModelKey({'provider': 'a/b', 'id': 'c'}),
      savedKey,
    ]);
    final fallback = dropdown.items!.singleWhere(
      (item) => item.value == savedKey,
    );
    expect((fallback.child as Text).data, 'a / b/c');
    await tap(t, 'Save');
    final body = obj(
      g.calls
          .singleWhere(
            (call) =>
                call.$2['method'] == 'PATCH' &&
                call.$2['path'] == '/api/schedules/Saved',
          )
          .$2['body'],
    );
    expect(body['model'], savedModel);
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });

  testWidgets('reload updates availability without losing saved model', (
    t,
  ) async {
    t.view.physicalSize = const Size(390, 844);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    final g = ScheduleGateway(), c = controller(g);
    final savedModel = {'provider': 'a', 'id': 'b/c'};
    g.schedules = [
      {...schedule('Saved'), 'model': savedModel},
    ];
    await t.pumpWidget(shell(SchedulesPage(controller: c)));
    await t.pumpAndSettle();
    await tap(t, 'Edit', within: find.byKey(const ValueKey('schedule-Saved')));
    await t.pumpAndSettle();
    final form = t.widget<ScheduleForm>(find.byType(ScheduleForm));
    final modelFinder = find.byKey(const ValueKey('schedule-select-Model'));
    final savedKey = scheduleModelKey(savedModel);
    expect(
      t.widget<DropdownButton<String>>(modelFinder).items!.last.value,
      savedKey,
    );

    g.models = [
      {'provider': 'a', 'id': 'b/c', 'name': 'Saved model', 'available': true},
    ];
    await form.state.loadModels();
    await t.pumpAndSettle();
    var dropdown = t.widget<DropdownButton<String>>(modelFinder);
    expect(dropdown.value, savedKey);
    expect(dropdown.items!.map((item) => item.value), ['', savedKey]);
    expect(
      (dropdown.items!.singleWhere((item) => item.value == savedKey).child
              as Text)
          .data,
      'Saved model · a',
    );

    g.models = [
      {'provider': 'a', 'id': 'b/c', 'name': 'Saved model', 'available': false},
    ];
    await form.state.loadModels();
    await t.pumpAndSettle();
    dropdown = t.widget<DropdownButton<String>>(modelFinder);
    expect(dropdown.value, savedKey);
    expect(
      (dropdown.items!.singleWhere((item) => item.value == savedKey).child
              as Text)
          .data,
      'a / b/c',
    );
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });

  testWidgets(
    'create preserves prompt whitespace, permits empty title and failed draft',
    (t) async {
      final g = ScheduleGateway(), c = controller(g);
      g.schedules = [];
      g.handler = (m, a) async {
        if (a['method'] == 'POST') {
          throw PlatformException(code: 'HTTP_400', message: 'Invalid cron');
        }
        return g.normal(m, a);
      };
      await t.pumpWidget(shell(SchedulesPage(controller: c)));
      await t.pumpAndSettle();
      await tap(t, 'New schedule');
      expect(find.text('Local'), findsNothing);
      await t.enterText(
        find.byKey(const ValueKey('schedule-field-Prompt')),
        '  draft\n ',
      );
      await tap(t, 'Create');
      final body = obj(
        g.calls.singleWhere((x) => x.$2['method'] == 'POST').$2['body'],
      );
      expect(body['title'], '');
      expect(body['prompt'], '  draft\n ');
      expect(body['timezone'], 'Asia/Taipei');
      expect(body['cron'], '0 9 * * *');
      expect(body['model'], isNull);
      expect(find.text('Invalid cron'), findsOneWidget);
      expect(
        t
            .widget<TextField>(
              find.byKey(const ValueKey('schedule-field-Prompt')),
            )
            .controller!
            .text,
        '  draft\n ',
      );
      c.origin = 'https://two';
      c.changed();
      await t.pumpAndSettle();
      expect(find.byType(ScheduleForm), findsNothing);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets(
    'repeated notification reopens the same history without discarding an editor',
    (t) async {
      final g = ScheduleGateway(), c = controller(g);
      Widget page(int revision) => shell(
        SchedulesPage(controller: c, focusId: 'Daily', focusRevision: revision),
      );
      await t.pumpWidget(page(1));
      await t.pumpAndSettle();
      final card = find.byKey(const ValueKey('schedule-Daily'));
      expect(find.widgetWithText(TextButton, 'Open session'), findsOneWidget);
      await tap(t, 'Runs', within: card);
      expect(find.widgetWithText(TextButton, 'Open session'), findsNothing);
      await tap(t, 'Edit', within: card);
      await t.enterText(
        find.byKey(const ValueKey('schedule-field-Title')),
        'unsaved title',
      );
      await t.pumpWidget(page(2));
      await t.pumpAndSettle();
      expect(find.widgetWithText(TextButton, 'Open session'), findsOneWidget);
      expect(
        t
            .widget<TextField>(
              find.byKey(const ValueKey('schedule-field-Title')),
            )
            .controller!
            .text,
        'unsaved title',
      );
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
  testWidgets('tablet action group includes gaps and remains on one row', (
    t,
  ) async {
    t.view.physicalSize = const Size(768, 1100);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    final g = ScheduleGateway(), c = controller(g);
    await t.pumpWidget(shell(SchedulesPage(controller: c)));
    await t.pumpAndSettle();
    final card = find.byKey(const ValueKey('schedule-Daily'));
    final tops = [
      for (final label in ['Runs', 'Run now', 'Pause', 'Edit', 'Delete'])
        t
            .getTopLeft(
              find.descendant(
                of: card,
                matching: find.widgetWithText(TextButton, label),
              ),
            )
            .dy,
    ];
    expect(tops.every((top) => (top - tops.first).abs() < .1), isTrue);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });
  for (final width in [390.0, 650.0, 651.0, 768.0, 860.0, 861.0, 1024.0]) {
    testWidgets('schedule form and actions fit $width at scale 2', (t) async {
      t.view.physicalSize = Size(width, 1100);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);
      final g = ScheduleGateway(), c = controller(g);
      await t.pumpWidget(shell(SchedulesPage(controller: c), scale: 2));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      await tap(t, 'New schedule');
      expect(t.takeException(), isNull);
      await tap(t, 'Cancel');
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    });
  }
}
