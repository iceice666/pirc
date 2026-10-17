import 'schedules_state.dart' show scheduleWallTime;

/// A timezone-free wall-clock value used by the schedule date/time picker.
///
/// The gateway interprets [wallTime] in the schedule's separately selected
/// IANA timezone. This model deliberately does not convert through the phone's
/// timezone.
final class SchedulePickerValue {
  const SchedulePickerValue._(
    this.year,
    this.month,
    this.day,
    this.hour,
    this.minute,
  );

  static const int maxYear = 275760;
  static const String maxWallTime = '275760-09-13T00:00';
  static const SchedulePickerValue _maximum = SchedulePickerValue._(
    maxYear,
    9,
    13,
    0,
    0,
  );

  final int year;
  final int month;
  final int day;
  final int hour;
  final int minute;

  /// Parses and normalizes a value accepted by the schedule wall-time rule.
  /// Returns null for invalid calendar values or values beyond datetime-local's
  /// maximum representable date.
  static SchedulePickerValue? parse(String input) {
    final canonical = scheduleWallTime(input);
    if (canonical == null) return null;
    final match = RegExp(
      r'^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$',
    ).firstMatch(canonical);
    if (match == null) return null;
    final value = SchedulePickerValue._(
      int.parse(match[1]!),
      int.parse(match[2]!),
      int.parse(match[3]!),
      int.parse(match[4]!),
      int.parse(match[5]!),
    );
    return _compare(value, _maximum) <= 0 ? value : null;
  }

  /// The canonical `YYYY-MM-DDTHH:mm` wall time sent to the gateway.
  String get wallTime =>
      '${year.toString().padLeft(4, '0')}-${_two(month)}-${_two(day)}T${_two(hour)}:${_two(minute)}';

  /// Number of days in this value's current month.
  int get daysInMonth => _daysInMonth(year, month);

  /// The hour on a 12-hour clock, in the range 1 through 12.
  int get hour12 => hour % 12 == 0 ? 12 : hour % 12;

  bool get isPm => hour >= 12;

  SchedulePickerValue withYear(int value) =>
      _make(year: value, month: month, day: day, hour: hour, minute: minute);

  SchedulePickerValue withMonth(int value) =>
      _make(year: year, month: value, day: day, hour: hour, minute: minute);

  SchedulePickerValue withDay(int value) =>
      _make(year: year, month: month, day: value, hour: hour, minute: minute);

  SchedulePickerValue withHour(int value) =>
      _make(year: year, month: month, day: day, hour: value, minute: minute);

  SchedulePickerValue withMinute(int value) =>
      _make(year: year, month: month, day: day, hour: hour, minute: value);

  /// Updates the 12-hour value while keeping the current AM/PM period.
  SchedulePickerValue withHour12(int value) {
    final normalized = value.clamp(1, 12);
    final nextHour = normalized % 12 + (isPm ? 12 : 0);
    return withHour(nextHour);
  }

  /// Switches AM/PM while keeping the current 12-hour value.
  SchedulePickerValue withPeriod(bool pm) {
    final nextHour = hour12 % 12 + (pm ? 12 : 0);
    return withHour(nextHour);
  }

  static SchedulePickerValue _make({
    required int year,
    required int month,
    required int day,
    required int hour,
    required int minute,
  }) {
    final safeYear = year.clamp(1, maxYear);
    final safeMonth = month.clamp(1, 12);
    final safeDay = day.clamp(1, _daysInMonth(safeYear, safeMonth));
    final safeHour = hour.clamp(0, 23);
    final safeMinute = minute.clamp(0, 59);
    final candidate = SchedulePickerValue._(
      safeYear,
      safeMonth,
      safeDay,
      safeHour,
      safeMinute,
    );
    // datetime-local's maximum is a wall-clock bound, not a timezone instant.
    return _compare(candidate, _maximum) > 0 ? _maximum : candidate;
  }

  static int _daysInMonth(int year, int month) => switch (month) {
    2 => _isLeapYear(year) ? 29 : 28,
    4 || 6 || 9 || 11 => 30,
    _ => 31,
  };

  static bool _isLeapYear(int year) =>
      year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);

  static int _compare(SchedulePickerValue a, SchedulePickerValue b) {
    for (final comparison in [
      a.year.compareTo(b.year),
      a.month.compareTo(b.month),
      a.day.compareTo(b.day),
      a.hour.compareTo(b.hour),
      a.minute.compareTo(b.minute),
    ]) {
      if (comparison != 0) return comparison;
    }
    return 0;
  }

  static String _two(int value) => value.toString().padLeft(2, '0');

  @override
  bool operator ==(Object other) =>
      other is SchedulePickerValue &&
      year == other.year &&
      month == other.month &&
      day == other.day &&
      hour == other.hour &&
      minute == other.minute;

  @override
  int get hashCode => Object.hash(year, month, day, hour, minute);

  @override
  String toString() => wallTime;
}
