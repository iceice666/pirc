import 'gateway.dart';

/// Calendar dates are kept as UTC date-only values. UTC is only a convenient
/// carrier for year/month/day arithmetic; event instants remain epoch values.
String calendarDateKey(DateTime value) =>
    '${value.year.toString().padLeft(4, '0')}-${value.month.toString().padLeft(2, '0')}-${value.day.toString().padLeft(2, '0')}';

DateTime calendarDate(dynamic value) {
  if (value is DateTime) {
    return DateTime.utc(value.year, value.month, value.day);
  }
  final match = RegExp(r'^(\d{4})-(\d{2})-(\d{2})').firstMatch('$value');
  if (match == null) return DateTime.utc(1970);
  return DateTime.utc(
    int.parse(match[1]!),
    int.parse(match[2]!),
    int.parse(match[3]!),
  );
}

DateTime? calendarWall(dynamic value) {
  if (value is! String) return null;
  final match = RegExp(
    r'^(\d{4})-(\d{2})-(\d{2})(?:T| )(\d{2}):(\d{2})',
  ).firstMatch(value);
  if (match == null) return null;
  return DateTime.utc(
    int.parse(match[1]!),
    int.parse(match[2]!),
    int.parse(match[3]!),
    int.parse(match[4]!),
    int.parse(match[5]!),
  );
}

DateTime calendarWeekStart(
  DateTime value, {
  int firstWeekday = DateTime.sunday,
}) {
  final date = DateTime.utc(value.year, value.month, value.day);
  final offset = (date.weekday % 7 - firstWeekday) % 7;
  return date.subtract(Duration(days: offset));
}

List<DateTime> calendarMonthGrid(
  DateTime month, {
  int firstWeekday = DateTime.sunday,
}) {
  final first = DateTime.utc(month.year, month.month);
  final start = calendarWeekStart(first, firstWeekday: firstWeekday);
  final last = DateTime.utc(month.year, month.month + 1, 0);
  final count = ((last.difference(start).inDays + 1 + 6) ~/ 7) * 7;
  return [for (var i = 0; i < count; i++) start.add(Duration(days: i))];
}

class CalendarOccurrence {
  const CalendarOccurrence({
    required this.id,
    required this.type,
    required this.sourceId,
    required this.title,
    required this.startAt,
    required this.endAt,
    required this.allDay,
    required this.timezone,
    required this.revision,
    required this.originalStart,
    required this.raw,
    this.startDate,
    this.endDate,
    this.wallStart,
    this.wallEnd,
  });

  final String id, type, sourceId, title, timezone;
  final int startAt, endAt, revision;
  final bool allDay;
  final String originalStart;
  final String? startDate, endDate;
  final DateTime? wallStart, wallEnd;
  final Json raw;

  bool get isSchedule => type == 'schedule';
  bool get isEvent => type == 'event';
  Json get event => obj(raw['event']);
  Json get occurrenceEvent =>
      obj(raw['occurrenceEvent']).isEmpty ? event : obj(raw['occurrenceEvent']);
  Json get schedule => obj(raw['schedule']);
  Json get run => obj(raw['run']);

  factory CalendarOccurrence.fromJson(
    Json value, {
    String? localStart,
    String? localEnd,
  }) => CalendarOccurrence(
    id: '${value['id'] ?? ''}',
    type: '${value['type'] ?? 'event'}',
    sourceId: '${value['sourceId'] ?? value['id'] ?? ''}',
    title: '${value['title'] ?? ''}',
    startAt: (value['startAt'] as num? ?? 0).toInt(),
    endAt: (value['endAt'] as num? ?? value['startAt'] as num? ?? 0).toInt(),
    allDay: value['allDay'] == true,
    timezone: '${value['timezone'] ?? 'UTC'}',
    revision: (value['revision'] as num? ?? 0).toInt(),
    originalStart: '${value['originalStart'] ?? ''}',
    raw: value,
    startDate: value['startDate'] as String?,
    endDate: value['endDate'] as String?,
    wallStart: calendarWall(localStart),
    wallEnd: calendarWall(localEnd),
  );
}

bool calendarCoversDate(CalendarOccurrence item, DateTime date) {
  final day = DateTime.utc(date.year, date.month, date.day);
  if (item.allDay) {
    final start = calendarDate(
      item.startDate ??
          item.event['start'] ??
          DateTime.fromMillisecondsSinceEpoch(item.startAt, isUtc: true),
    );
    final end = calendarDate(
      item.endDate ??
          item.event['end'] ??
          calendarDateKey(start.add(const Duration(days: 1))),
    );
    return !day.isBefore(start) && day.isBefore(end);
  }
  final start =
      item.wallStart ??
      DateTime.fromMillisecondsSinceEpoch(item.startAt, isUtc: true);
  final end =
      item.wallEnd ??
      DateTime.fromMillisecondsSinceEpoch(item.endAt, isUtc: true);
  final startDate = DateTime.utc(start.year, start.month, start.day);
  if (item.isSchedule || item.endAt <= item.startAt) return day == startDate;
  final dayEnd = day.add(const Duration(days: 1));
  return start.isBefore(dayEnd) && end.isAfter(day);
}

List<CalendarOccurrence> calendarItemsOnDate(
  Iterable<CalendarOccurrence> items,
  DateTime date, {
  String filter = 'all',
}) =>
    [
      for (final item in items)
        if ((filter == 'all' || item.type == filter) &&
            calendarCoversDate(item, date))
          item,
    ]..sort((a, b) {
      if (a.allDay != b.allDay) return a.allDay ? -1 : 1;
      final left = a.wallStart?.millisecondsSinceEpoch ?? a.startAt;
      final right = b.wallStart?.millisecondsSinceEpoch ?? b.startAt;
      final byTime = left.compareTo(right);
      return byTime == 0 ? a.title.compareTo(b.title) : byTime;
    });

class CalendarTimedSegment {
  const CalendarTimedSegment({
    required this.item,
    required this.startMinute,
    required this.endMinute,
    required this.lane,
    required this.laneCount,
  });
  final CalendarOccurrence item;
  final double startMinute, endMinute;
  final int lane, laneCount;
}

class CalendarSchedulePoint {
  const CalendarSchedulePoint({
    required this.item,
    required this.minute,
    required this.lane,
    required this.laneCount,
  });
  final CalendarOccurrence item;
  final int minute, lane, laneCount;
}

class CalendarAllDaySpan {
  const CalendarAllDaySpan({
    required this.item,
    required this.startIndex,
    required this.endIndex,
    required this.lane,
  });
  final CalendarOccurrence item;
  final int startIndex, endIndex, lane;
}

List<CalendarAllDaySpan> calendarAllDaySpans(
  Iterable<CalendarOccurrence> items,
  List<DateTime> dates, {
  String filter = 'all',
}) {
  if (dates.isEmpty) return const [];
  final start = DateTime.utc(
    dates.first.year,
    dates.first.month,
    dates.first.day,
  );
  final end = DateTime.utc(
    dates.last.year,
    dates.last.month,
    dates.last.day,
  ).add(const Duration(days: 1));
  final spans = <(CalendarOccurrence, int, int)>[];
  for (final item in items) {
    if (!item.allDay || (filter != 'all' && item.type != filter)) continue;
    final itemStart = calendarDate(
      item.startDate ??
          item.event['start'] ??
          DateTime.fromMillisecondsSinceEpoch(item.startAt, isUtc: true),
    );
    final itemEnd = calendarDate(
      item.endDate ??
          item.event['end'] ??
          calendarDateKey(itemStart.add(const Duration(days: 1))),
    );
    if (!itemStart.isBefore(end) || !itemEnd.isAfter(start)) continue;
    final startIndex = itemStart.isBefore(start)
        ? 0
        : itemStart.difference(start).inDays;
    final endIndex = itemEnd.isAfter(end)
        ? dates.length
        : itemEnd.difference(start).inDays;
    spans.add((item, startIndex, endIndex));
  }
  spans.sort((a, b) {
    final byStart = a.$2.compareTo(b.$2);
    return byStart != 0 ? byStart : b.$3.compareTo(a.$3);
  });
  final laneEnds = <int>[];
  return [
    for (final span in spans)
      () {
        var lane = laneEnds.indexWhere((laneEnd) => laneEnd <= span.$2);
        if (lane < 0) {
          lane = laneEnds.length;
          laneEnds.add(span.$3);
        } else {
          laneEnds[lane] = span.$3;
        }
        return CalendarAllDaySpan(
          item: span.$1,
          startIndex: span.$2,
          endIndex: span.$3,
          lane: lane,
        );
      }(),
  ];
}

/// Keeps schedule markers at their actual wall-clock time. Only identical
/// start minutes share a horizontal cluster so they remain individually
/// tappable without shifting later tasks down the timeline.
List<CalendarSchedulePoint> calendarSchedulePoints(
  Iterable<CalendarOccurrence> items,
  DateTime date,
) {
  final grouped = <int, List<CalendarOccurrence>>{};
  for (final item in items) {
    if (item.type != 'schedule' ||
        item.allDay ||
        !calendarCoversDate(item, date)) {
      continue;
    }
    final start =
        item.wallStart ??
        DateTime.fromMillisecondsSinceEpoch(item.startAt, isUtc: true);
    final minute = start.hour * 60 + start.minute;
    grouped.putIfAbsent(minute, () => []).add(item);
  }
  return [
    for (final entry in grouped.entries)
      for (var lane = 0; lane < entry.value.length; lane++)
        CalendarSchedulePoint(
          item: entry.value[lane],
          minute: entry.key,
          lane: lane,
          laneCount: entry.value.length,
        ),
  ]..sort((a, b) => a.minute.compareTo(b.minute));
}

/// Projects timed personal events into a day's wall-clock axis and assigns
/// adjacent lanes for overlaps. Agent schedules remain point markers.
List<CalendarTimedSegment> calendarTimedSegments(
  Iterable<CalendarOccurrence> items,
  DateTime date,
) {
  final day = DateTime.utc(date.year, date.month, date.day);
  final timed = <(CalendarOccurrence, double, double)>[];
  for (final item in items) {
    if (item.type != 'event' || item.allDay || !calendarCoversDate(item, day)) {
      continue;
    }
    final start =
        item.wallStart ??
        DateTime.fromMillisecondsSinceEpoch(item.startAt, isUtc: true);
    final end =
        item.wallEnd ??
        DateTime.fromMillisecondsSinceEpoch(item.endAt, isUtc: true);
    final startMinute = start.isBefore(day)
        ? 0.0
        : start.difference(day).inMinutes.toDouble();
    final nextDay = day.add(const Duration(days: 1));
    final endMinute = end.isAfter(nextDay)
        ? 1440.0
        : end.difference(day).inMinutes.toDouble().clamp(0, 1440).toDouble();
    timed.add((item, startMinute, endMinute));
  }
  timed.sort((a, b) => a.$2.compareTo(b.$2));
  final output = <CalendarTimedSegment>[];
  var cluster = <(CalendarOccurrence, double, double, int)>[];
  var laneEnds = <double>[];
  var active = <(int, double)>[];
  var clusterEnd = double.negativeInfinity;
  void flush() {
    if (cluster.isEmpty) return;
    final laneCount = laneEnds.length;
    output.addAll([
      for (final item in cluster)
        CalendarTimedSegment(
          item: item.$1,
          startMinute: item.$2,
          endMinute: item.$3,
          lane: item.$4,
          laneCount: laneCount,
        ),
    ]);
    cluster = [];
    laneEnds = [];
    active = [];
    clusterEnd = double.negativeInfinity;
  }

  for (final entry in timed) {
    if (cluster.isNotEmpty && entry.$2 >= clusterEnd) flush();
    active.removeWhere((value) => value.$2 <= entry.$2);
    final used = active.map((value) => value.$1).toSet();
    var lane = 0;
    while (used.contains(lane)) {
      lane++;
    }
    if (lane >= laneEnds.length) laneEnds.add(entry.$3);
    laneEnds[lane] = entry.$3;
    active.add((lane, entry.$3));
    cluster.add((entry.$1, entry.$2, entry.$3, lane));
    clusterEnd = clusterEnd < entry.$3 ? entry.$3 : clusterEnd;
  }
  flush();
  return output;
}
