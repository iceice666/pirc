import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/schedule_picker_value.dart';

void main() {
  group('SchedulePickerValue.parse', () {
    test('parses canonical wall time without converting time zones', () {
      final value = SchedulePickerValue.parse('2026-10-05T14:07')!;
      expect(value.wallTime, '2026-10-05T14:07');
      expect([value.year, value.month, value.day], [2026, 10, 5]);
      expect([value.hour, value.minute], [14, 7]);
    });

    test('normalizes only valid zero-second values', () {
      expect(
        SchedulePickerValue.parse('2026-10-05T14:07:00.000')!.wallTime,
        '2026-10-05T14:07',
      );
      expect(SchedulePickerValue.parse('2026-10-05T14:07:01'), isNull);
      expect(SchedulePickerValue.parse('2026-10-05T14:07:00.001'), isNull);
    });

    test(
      'rejects invalid dates, malformed input, and values after datetime-local max',
      () {
        for (final input in [
          '',
          '2026-2-05T14:07',
          '2025-02-29T14:07',
          '2026-04-31T14:07',
          '2026-10-05T24:00',
          '2026-10-05T14:60',
          '0000-01-01T00:00',
          '275760-09-13T00:01',
          '275760-09-14T00:00',
        ]) {
          expect(SchedulePickerValue.parse(input), isNull, reason: input);
        }
      },
    );

    test('accepts the datetime-local maximum exactly', () {
      expect(
        SchedulePickerValue.parse('275760-09-13T00:00')!.wallTime,
        SchedulePickerValue.maxWallTime,
      );
      expect(
        SchedulePickerValue.parse('275760-09-12T23:59')!.wallTime,
        '275760-09-12T23:59',
      );
    });
  });

  group('calendar adjustments', () {
    test('reports leap and non-leap month lengths', () {
      expect(SchedulePickerValue.parse('2024-02-01T00:00')!.daysInMonth, 29);
      expect(SchedulePickerValue.parse('2023-02-01T00:00')!.daysInMonth, 28);
      expect(SchedulePickerValue.parse('2024-04-01T00:00')!.daysInMonth, 30);
    });

    test('clamps the selected day when the year or month becomes shorter', () {
      final leapDay = SchedulePickerValue.parse('2024-02-29T08:09')!;
      expect(leapDay.withYear(2023).wallTime, '2023-02-28T08:09');
      expect(
        SchedulePickerValue.parse('2025-01-31T08:09')!.withMonth(4).wallTime,
        '2025-04-30T08:09',
      );
      expect(
        SchedulePickerValue.parse('2025-03-31T08:09')!.withMonth(2).wallTime,
        '2025-02-28T08:09',
      );
      expect(
        SchedulePickerValue.parse('2024-03-31T08:09')!.withMonth(2).wallTime,
        '2024-02-29T08:09',
      );
    });

    test('clamps edited components into their valid ranges', () {
      final value = SchedulePickerValue.parse('2026-06-15T12:30')!;
      expect(value.withDay(0).wallTime, '2026-06-01T12:30');
      expect(value.withDay(99).wallTime, '2026-06-30T12:30');
      expect(value.withHour(-2).wallTime, '2026-06-15T00:30');
      expect(value.withHour(24).wallTime, '2026-06-15T23:30');
      expect(value.withMinute(-1).wallTime, '2026-06-15T12:00');
      expect(value.withMinute(60).wallTime, '2026-06-15T12:59');
    });
  });

  group('12-hour clock', () {
    test('converts midnight and noon without off-by-twelve errors', () {
      final midnight = SchedulePickerValue.parse('2026-06-15T00:30')!;
      expect([midnight.hour12, midnight.isPm], [12, false]);
      expect(midnight.withHour12(12).wallTime, '2026-06-15T00:30');
      expect(midnight.withHour12(1).wallTime, '2026-06-15T01:30');
      expect(midnight.withPeriod(true).wallTime, '2026-06-15T12:30');

      final noon = SchedulePickerValue.parse('2026-06-15T12:30')!;
      expect([noon.hour12, noon.isPm], [12, true]);
      expect(noon.withHour12(12).wallTime, '2026-06-15T12:30');
      expect(noon.withPeriod(false).wallTime, '2026-06-15T00:30');
      expect(
        SchedulePickerValue.parse('2026-06-15T23:30')!.withHour12(12).wallTime,
        '2026-06-15T12:30',
      );
    });
  });

  group('datetime-local maximum adjustments', () {
    test('never creates a value beyond the legal upper boundary', () {
      final max = SchedulePickerValue.parse(SchedulePickerValue.maxWallTime)!;
      expect(max.withMinute(59), max);
      expect(max.withHour(23), max);
      expect(max.withDay(31), max);
      expect(max.withMonth(10), max);
      expect(max.withYear(275761), max);
      expect(max.withPeriod(true), max);
    });

    test(
      'year changes clamp to the supported year and preserve earlier dates',
      () {
        expect(
          SchedulePickerValue.parse(
            '2024-01-01T00:00',
          )!.withYear(275761).wallTime,
          '275760-01-01T00:00',
        );
        expect(
          SchedulePickerValue.parse(
            '2024-12-31T23:59',
          )!.withYear(275760).wallTime,
          SchedulePickerValue.maxWallTime,
        );
        expect(
          SchedulePickerValue.parse('2024-01-01T00:00')!.withYear(0).wallTime,
          '0001-01-01T00:00',
        );
      },
    );
  });
}
