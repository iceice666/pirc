import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/calendar_projection.dart';
import 'package:pirc_mobile/live/calendar_view.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/schedules_page.dart';
import 'package:pirc_mobile/l10n/app_i18n.dart';

import 'live_test.dart' show FakeGateway, theme;
import '../tool/parity/capture_fonts.dart' show loadParityFonts;

final calendarFixture = obj(
  jsonDecode(
    File('../../fixtures/mobile-parity/calendar.json').readAsStringSync(),
  ),
);

String _wall(int epoch) {
  final value = DateTime.fromMillisecondsSinceEpoch(
    epoch,
    isUtc: true,
  ).add(const Duration(hours: 8));
  String two(int n) => n.toString().padLeft(2, '0');
  return '${value.year}-${two(value.month)}-${two(value.day)}T${two(value.hour)}:${two(value.minute)}';
}

List<CalendarOccurrence> _fixtureItems() => [
  for (final raw in rows(calendarFixture['items']))
    CalendarOccurrence.fromJson(
      raw,
      localStart: raw['allDay'] == true
          ? null
          : _wall((raw['startAt'] as num).toInt()),
      localEnd: raw['allDay'] == true
          ? null
          : _wall((raw['endAt'] as num).toInt()),
    ),
];

void main() {
  test(
    'fixture projects overlap lanes, schedule points, and floating all-day span',
    () {
      final items = _fixtureItems();
      final date = DateTime.utc(2026, 10, 21);
      final agenda = calendarItemsOnDate(items, date);
      expect(agenda.map((item) => item.title), [
        'Team retreat',
        'Design review',
        'Weekly planning',
        'Daily summary',
      ]);
      final segments = calendarTimedSegments(items, date);
      expect(segments.map((segment) => segment.item.title), [
        'Design review',
        'Weekly planning',
      ]);
      expect(segments.map((segment) => (segment.lane, segment.laneCount)), [
        (0, 2),
        (1, 2),
      ]);
      expect(
        segments.map((segment) => (segment.startMinute, segment.endMinute)),
        [(540.0, 630.0), (570.0, 660.0)],
      );
      expect(
        calendarItemsOnDate(items, DateTime.utc(2026, 10, 22)).first.title,
        'Team retreat',
      );
      expect(calendarItemsOnDate(items, DateTime.utc(2026, 10, 23)), isEmpty);
      final week = [
        for (var offset = 0; offset < 7; offset++)
          DateTime.utc(2026, 10, 19 + offset),
      ];
      final spans = calendarAllDaySpans(items, week);
      expect(spans.map((span) => (span.startIndex, span.endIndex, span.lane)), [
        (1, 4, 0),
      ]);
    },
  );

  test('schedule markers keep their wall time and cluster only exact ties', () {
    CalendarOccurrence point(String id, DateTime wall) => CalendarOccurrence(
      id: id,
      type: 'schedule',
      sourceId: id,
      title: id,
      startAt: wall.millisecondsSinceEpoch,
      endAt: wall.millisecondsSinceEpoch,
      allDay: false,
      timezone: 'Asia/Taipei',
      revision: 1,
      originalStart: wall.toIso8601String(),
      wallStart: wall,
      raw: const {},
    );

    final date = DateTime(2026, 10, 21);
    final points = calendarSchedulePoints([
      point('first', DateTime(2026, 10, 21, 11)),
      point('same-time', DateTime(2026, 10, 21, 11)),
      point('later', DateTime(2026, 10, 21, 12)),
    ], date);

    expect(points.map((point) => point.minute), [660, 660, 720]);
    expect(points.map((point) => (point.lane, point.laneCount)), [
      (0, 2),
      (1, 2),
      (0, 1),
    ]);
  });

  test('week start preference and month grid honor Sunday and Monday', () {
    final date = DateTime.utc(2026, 10, 21);
    expect(calendarDateKey(calendarWeekStart(date)), '2026-10-18');
    expect(
      calendarDateKey(calendarWeekStart(date, firstWeekday: DateTime.monday)),
      '2026-10-19',
    );
    expect(calendarDateKey(calendarMonthGrid(date).first), '2026-09-27');
    expect(
      calendarDateKey(
        calendarMonthGrid(date, firstWeekday: DateTime.monday).first,
      ),
      '2026-09-28',
    );
  });

  testWidgets('month, week, and day views render the shared API fixture', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.reset);
    final gateway = FakeGateway();
    gateway.handler = (method, args) async {
      if (method == 'calendarDateStart') {
        return DateTime.parse(
          '${args['date']}T00:00:00Z',
        ).millisecondsSinceEpoch;
      }
      if (method == 'wallInput') return _wall((args['at'] as num).toInt());
      if (method == 'calendarWallInstant') {
        return DateTime.parse(
          '${args['value']}Z',
        ).subtract(const Duration(hours: 8)).millisecondsSinceEpoch;
      }
      if (method == 'request' &&
          '${args['path']}'.startsWith('/api/calendar?')) {
        return calendarFixture;
      }
      if (method == 'request' && args['path'] == '/api/calendar/context') {
        return {
          'accountKey': 'fixture-account',
          'reminderDeliveryAvailable': true,
        };
      }
      return gateway.normal(method, args);
    };
    final controller = LiveController(gateway);
    await controller.boot();
    var mode = 'month';
    var filter = 'all';
    Widget surface() => RepaintBoundary(
      key: GlobalKey(),
      child: MaterialApp(
        theme: theme.build(Brightness.light),
        locale: const Locale('en'),
        supportedLocales: const [Locale('en'), Locale('zh', 'TW')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: I18nScope(
          child: Scaffold(
            body: SizedBox.expand(
              child: CalendarViewBody(
                controller: controller,
                mode: mode,
                anchor: DateTime(2026, 10, 21),
                selectedDate: DateTime(2026, 10, 21),
                filter: filter,
                firstWeekday: DateTime.monday,
                timezone: 'Asia/Taipei',
                zones: const ['Asia/Taipei', 'UTC'],
                accountKey: 'fixture-account',
                onAnchorChanged: (_) {},
                onSelectedDate: (_) {},
                onOpenSchedule: (_) {},
                onCreateAgentTask: () {},
                clock: () => DateTime(2026, 10, 21, 12),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.pumpWidget(surface());
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull, reason: 'month view');
    expect(find.text('Design review'), findsOneWidget);
    expect(find.text('Weekly planning'), findsOneWidget);

    mode = 'week';
    await tester.pumpWidget(surface());
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull, reason: 'week view');
    expect(find.text('Design review'), findsOneWidget);
    expect(find.text('Weekly planning'), findsOneWidget);

    mode = 'day';
    await tester.pumpWidget(surface());
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull, reason: 'day view');
    expect(find.text('Design review'), findsOneWidget);
    expect(find.text('Weekly planning'), findsOneWidget);

    // Long press moves open a draft. Cancelling must never mutate the server.
    final start =
        tester.getTopLeft(find.text('Design review')) + const Offset(20, 5);
    final drag = await tester.startGesture(start);
    await tester.pump(const Duration(milliseconds: 600));
    await drag.moveBy(const Offset(0, 56));
    await tester.pump();
    await drag.up();
    await tester.pumpAndSettle();
    expect(find.byType(CalendarEventEditor), findsOneWidget);
    expect(find.text('10:00'), findsWidgets);
    expect(find.text('11:30'), findsWidgets);
    expect(
      gateway.calls.where(
        (call) => call.$1 == 'request' && call.$2['method'] == 'PATCH',
      ),
      isEmpty,
    );
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.byType(CalendarEventEditor), findsNothing);

    mode = 'list';
    await tester.pumpWidget(surface());
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull, reason: 'list agenda');
    expect(find.text('Design review'), findsOneWidget);
    expect(find.text('Weekly planning'), findsOneWidget);
    expect(find.text('Daily summary'), findsOneWidget);
    expect(find.text('Team retreat'), findsWidgets);

    filter = 'schedule';
    await tester.pumpWidget(surface());
    await tester.pumpAndSettle();
    expect(find.text('Daily summary'), findsOneWidget);
    expect(find.text('Design review'), findsNothing);
    expect(find.text('Weekly planning'), findsNothing);

    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await gateway.stream.close();
  });

  testWidgets(
    'saving an occurrence sends its revision scope and repeat count',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 844);
      tester.view.viewInsets = const FakeViewPadding(bottom: 300);
      addTearDown(tester.view.reset);
      final gateway = FakeGateway();
      final patchBodies = <Json>[];
      final itemJson =
          Map<String, dynamic>.from(rows(calendarFixture['items']).first)
            ..['revision'] = 7
            ..['event'] = {
              ...obj(rows(calendarFixture['items']).first['event']),
              'revision': 8,
              'recurrence': {
                'frequency': 'weekly',
                'interval': 1,
                'weekdays': [3],
                'count': 6,
              },
            };
      gateway.handler = (method, args) async {
        if (method == 'request' &&
            args['path'] == '/api/calendar/events/review' &&
            args['method'] == 'PATCH') {
          patchBodies.add(obj(args['body']));
          if (patchBodies.length == 1) {
            throw PlatformException(code: 'HTTP_409');
          }
          return {
            'event': {...obj(itemJson['event']), 'revision': 10},
          };
        }
        if (method == 'request' &&
            args['path'] == '/api/calendar/events/review') {
          return {
            'event': {...obj(itemJson['event']), 'revision': 9},
          };
        }
        return gateway.normal(method, args);
      };
      final item = CalendarOccurrence.fromJson(
        itemJson,
        localStart: '2026-10-21T09:00',
        localEnd: '2026-10-21T10:30',
      );
      final controller = LiveController(gateway);
      await tester.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          locale: const Locale('en'),
          supportedLocales: const [Locale('en'), Locale('zh', 'TW')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          home: I18nScope(child: const Scaffold(body: Text('editor host'))),
        ),
      );
      final context = tester.element(find.text('editor host'));
      unawaited(
        showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          builder: (_) => CalendarEventEditor(
            controller: controller,
            existing: item,
            initialDate: DateTime(2026, 10, 21),
            timezone: 'Asia/Taipei',
            zones: const ['Asia/Taipei', 'UTC'],
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(CalendarEventEditor), findsOneWidget);
      expect(tester.takeException(), isNull, reason: 'editor first layout');

      await tester.tap(find.byType(TextField).first);
      await tester.pump();
      expect(find.text('Save').hitTestable(), findsOneWidget);
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(find.byType(CalendarEventEditor), findsOneWidget);
      expect(find.textContaining('changed elsewhere'), findsOneWidget);
      expect(patchBodies.single['revision'], 7);
      await tester.ensureVisible(find.text('Keep my edits and continue'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Keep my edits and continue'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(patchBodies, hasLength(2));
      expect(patchBodies.first['revision'], 7);
      expect(patchBodies.last['revision'], 9);
      for (final body in patchBodies) {
        expect(body['scope'], 'occurrence');
        expect(body['occurrence'], '2026-10-21T09:00');
        expect(obj(body['event'])['recurrence'], {
          'frequency': 'weekly',
          'interval': 1,
          'weekdays': [3],
          'count': 6,
        });
      }
      expect(find.byType(CalendarEventEditor), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'new event retries reuse the idempotency key for the same draft',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(844, 390);
      tester.view.viewInsets = const FakeViewPadding(bottom: 250);
      addTearDown(tester.view.reset);
      final gateway = FakeGateway();
      final posts = <Json>[];
      gateway.handler = (method, args) async {
        if (method == 'request' &&
            args['path'] == '/api/calendar/events' &&
            args['method'] == 'POST') {
          posts.add(obj(args['body']));
          if (posts.length == 1) throw StateError('temporary network failure');
          return {
            'event': {'id': 'created'},
          };
        }
        return gateway.normal(method, args);
      };
      final controller = LiveController(gateway);
      await tester.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          locale: const Locale('en'),
          supportedLocales: const [Locale('en'), Locale('zh', 'TW')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          home: I18nScope(child: const Scaffold(body: Text('editor host'))),
        ),
      );
      final context = tester.element(find.text('editor host'));
      unawaited(
        showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          builder: (_) => CalendarEventEditor(
            controller: controller,
            initialDate: DateTime(2026, 10, 21),
            timezone: 'Asia/Taipei',
            zones: const ['Asia/Taipei', 'UTC'],
            occurrenceStart: DateTime(2026, 10, 21, 10),
            occurrenceEnd: DateTime(2026, 10, 22, 11),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester.takeException(),
        isNull,
        reason: 'landscape editor with keyboard inset',
      );
      expect(find.text('Start date'), findsOneWidget);
      expect(find.text('End date'), findsOneWidget);
      await tester.enterText(find.byType(TextField).first, 'Create retry');
      await tester.pump();
      await tester.ensureVisible(find.text('Create event'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Create event'));
      await tester.pumpAndSettle();
      expect(posts, hasLength(1));
      expect(find.byType(CalendarEventEditor), findsOneWidget);
      expect(find.textContaining('temporary network failure'), findsOneWidget);

      await tester.tap(find.text('Create event'));
      await tester.pumpAndSettle();
      expect(posts, hasLength(2));
      expect(posts[0]['idempotencyKey'], isA<String>());
      expect(posts[0]['idempotencyKey'], isNotEmpty);
      expect(posts[1]['idempotencyKey'], posts[0]['idempotencyKey']);
      expect(posts[1]['event'], posts[0]['event']);
      expect(obj(posts[0]['event'])['start'], '2026-10-21T10:00');
      expect(obj(posts[0]['event'])['end'], '2026-10-22T11:00');
      expect(find.byType(CalendarEventEditor), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'calendar page screenshot uses production toolbar and calendar modes',
    (tester) async {
      await tester.runAsync(loadParityFonts);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 844);
      addTearDown(tester.view.reset);
      final gateway = FakeGateway();
      gateway.handler = (method, args) async {
        if (method == 'timeZoneInfo') {
          return {
            'default': 'Asia/Taipei',
            'zones': ['Asia/Taipei', 'UTC'],
          };
        }
        if (method == 'calendarPreferences') {
          return {
            'view': 'month',
            'timezone': 'Asia/Taipei',
            'weekStart': 'monday',
          };
        }
        if (method == 'calendarDateStart') {
          return DateTime.parse(
            '${args['date']}T00:00:00Z',
          ).millisecondsSinceEpoch;
        }
        if (method == 'wallInput') return _wall((args['at'] as num).toInt());
        if (method == 'request' &&
            '${args['path']}'.startsWith('/api/calendar?')) {
          return calendarFixture;
        }
        if (method == 'request' && args['path'] == '/api/calendar/context') {
          return {
            'accountKey': 'fixture-account',
            'reminderDeliveryAvailable': true,
          };
        }
        if (method == 'request' && args['path'] == '/api/schedules') {
          return {'schedules': []};
        }
        if (method == 'request' && args['path'] == '/api/models') {
          return {'models': []};
        }
        return gateway.normal(method, args);
      };
      final controller = LiveController(gateway);
      await controller.boot();
      final captureKey = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: captureKey,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: theme.build(Brightness.light),
            locale: const Locale('en'),
            supportedLocales: const [Locale('en'), Locale('zh', 'TW')],
            localizationsDelegates: GlobalMaterialLocalizations.delegates,
            home: I18nScope(
              child: Scaffold(
                body: SchedulesPage(
                  controller: controller,
                  now: () => DateTime(2026, 10, 21, 12),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      Future<void> capture(String view) async {
        await tester.runAsync(() async {
          final boundary =
              captureKey.currentContext!.findRenderObject()
                  as RenderRepaintBoundary;
          final image = await boundary.toImage(pixelRatio: 1);
          final data = await image.toByteData(format: ui.ImageByteFormat.png);
          await File(
            '/private/tmp/pirc-calendar-app-$view.png',
          ).writeAsBytes(data!.buffer.asUint8List());
          image.dispose();
        });
      }

      await capture('month');
      await tester.tap(find.text('Week').first);
      await tester.pumpAndSettle();
      await capture('week');
      await tester.tap(find.text('Day').first);
      await tester.pumpAndSettle();
      await capture('day');
      expect(find.text('Design review'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets('moved reminder opens the occurrence effective month', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.reset);
    final gateway = FakeGateway();
    const movedStart = 1793494800000;
    final movedItems = rows(calendarFixture['items']).map((raw) {
      if (raw['sourceId'] != 'review') return raw;
      return {
        ...raw,
        'startAt': movedStart,
        'endAt': movedStart + 90 * 60 * 1000,
        'originalStart': '2026-10-21T09:00',
      };
    }).toList();
    gateway.handler = (method, args) async {
      if (method == 'timeZoneInfo') {
        return {
          'default': 'Asia/Taipei',
          'zones': ['Asia/Taipei', 'UTC'],
        };
      }
      if (method == 'calendarPreferences') {
        return {
          'view': 'month',
          'timezone': 'Asia/Taipei',
          'weekStart': 'monday',
        };
      }
      if (method == 'calendarDateStart') {
        return DateTime.parse(
          '${args['date']}T00:00:00Z',
        ).millisecondsSinceEpoch;
      }
      if (method == 'wallInput') {
        final at = (args['at'] as num).toInt();
        if (at == movedStart) return '2026-11-01T09:00';
        if (at == movedStart + 90 * 60 * 1000) return '2026-11-01T10:30';
        return _wall(at);
      }
      if (method == 'request' &&
          '${args['path']}'.startsWith('/api/calendar?')) {
        return {...calendarFixture, 'items': movedItems};
      }
      if (method == 'request' && args['path'] == '/api/calendar/context') {
        return {
          'accountKey': 'fixture-account',
          'reminderDeliveryAvailable': true,
        };
      }
      return gateway.normal(method, args);
    };
    final controller = LiveController(gateway);
    await controller.boot();
    gateway.stream.add({
      'type': 'route',
      'scope': 'account',
      'data': {
        'page': 'calendar',
        'eventId': 'review',
        'occurrenceStart': '2026-10-21T09:00',
        'eventDate': '2026-11-01',
        'eventStartAt': movedStart,
      },
    });
    await tester.pump();
    expect(controller.calendarFocusEventId, 'review');
    expect(controller.calendarFocusDate, '2026-11-01');
    expect(controller.calendarFocusStartAt, movedStart);
    await tester.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        locale: const Locale('en'),
        supportedLocales: const [Locale('en'), Locale('zh', 'TW')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: I18nScope(
          child: Scaffold(
            body: SchedulesPage(
              controller: controller,
              focusEventId: controller.calendarFocusEventId,
              focusEventDate: controller.calendarFocusDate,
              focusEventStartAt: controller.calendarFocusStartAt,
              focusOccurrenceStart: controller.calendarFocusOccurrenceStart,
              now: () => DateTime(2026, 10, 21, 12),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('November 2026'), findsOneWidget);
    expect(find.text('Design review'), findsWidgets);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    await gateway.stream.close();
  });
}
