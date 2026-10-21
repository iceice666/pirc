import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/calendar_view.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/schedules_state.dart';

import 'live_test.dart' show FakeGateway;

Json response(String title) => {
  'items': [
    {
      'id': title,
      'sourceId': title,
      'type': 'event',
      'title': title,
      'startAt': 1792544400000,
      'endAt': 1792549800000,
      'timezone': 'UTC',
      'revision': 1,
      'originalStart': '2026-10-21T01:00',
    },
  ],
};

void main() {
  test('re-pairing resets schedule manager and calendar page epoch', () async {
    final gateway = FakeGateway();
    final controller = LiveController(gateway)
      ..origin = 'https://gateway.example'
      ..clientId = 'same-phone'
      ..pairingStamp = 'old-pairing';
    final state = SchedulesState(controller);
    state.schedules = [
      {'id': 'private-old-schedule'},
    ];
    controller.pairingStamp = 'new-pairing';
    controller.changed();
    expect(state.epoch, 1);
    expect(state.schedules, isEmpty);
    state.dispose();
    controller.dispose();
    await gateway.stream.close();
  });

  test(
    're-pairing fences in-flight responses even with the same client ID',
    () async {
      final gateway = FakeGateway();
      final stale = Completer<Json>(), current = Completer<Json>();
      var reads = 0;
      gateway.handler = (method, args) async {
        if (method == 'calendarDateStart') {
          return DateTime.parse(
            '${args['date']}T00:00:00Z',
          ).millisecondsSinceEpoch;
        }
        if (method == 'wallInput') {
          return DateTime.fromMillisecondsSinceEpoch(
            (args['at'] as num).toInt(),
            isUtc: true,
          ).toIso8601String().substring(0, 16);
        }
        if (method == 'request' &&
            '${args['path']}'.startsWith('/api/calendar?')) {
          reads++;
          if (reads == 1) return response('Old account');
          if (reads == 2) return stale.future;
          return current.future;
        }
        return {};
      };
      final controller = LiveController(gateway)
        ..origin = 'https://gateway.example'
        ..clientId = 'same-phone'
        ..pairingStamp = 'old-pairing';
      final state = CalendarData(controller);
      await state.load(
        mode: 'day',
        anchor: DateTime.utc(2026, 10, 21),
        timezone: 'UTC',
        firstWeekday: DateTime.monday,
      );
      expect(state.items.single.title, 'Old account');
      final oldRead = state.reload();
      while (reads < 2) {
        await Future<void>.delayed(Duration.zero);
      }
      controller.pairingStamp = 'new-pairing';
      controller.changed();
      expect(state.items, isEmpty);
      while (reads < 3) {
        await Future<void>.delayed(Duration.zero);
      }
      stale.complete(response('Stale secret'));
      await oldRead;
      expect(state.items, isEmpty);
      current.complete(response('New account'));
      while (state.loading) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(state.items.single.title, 'New account');
      state.dispose();
      controller.dispose();
      await gateway.stream.close();
    },
  );
}
