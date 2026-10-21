import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/app_i18n.dart';
import 'calendar_projection.dart';
import 'calendar_time_gestures.dart';
import 'common.dart';
import 'gateway.dart';
import 'web_controls.dart';

String _calendarClientIdentity(LiveController controller) =>
    jsonEncode([controller.clientId, controller.pairingStamp]);

class CalendarViewBody extends StatefulWidget {
  const CalendarViewBody({
    super.key,
    required this.controller,
    required this.mode,
    required this.anchor,
    required this.selectedDate,
    required this.filter,
    required this.firstWeekday,
    required this.timezone,
    required this.zones,
    required this.accountKey,
    required this.onAnchorChanged,
    required this.onSelectedDate,
    required this.onOpenSchedule,
    required this.onCreateAgentTask,
    this.focusEventId,
    this.focusOccurrenceStart,
    this.focusRevision = 0,
    this.clock,
  });

  final LiveController controller;
  final String mode, filter, timezone, accountKey;
  final int firstWeekday;
  final DateTime anchor, selectedDate;
  final List<String> zones;
  final String? focusEventId, focusOccurrenceStart;
  final int focusRevision;
  final DateTime Function()? clock;
  final ValueChanged<DateTime> onAnchorChanged, onSelectedDate;
  final ValueChanged<String> onOpenSchedule;
  final VoidCallback onCreateAgentTask;

  @override
  State<CalendarViewBody> createState() => CalendarViewBodyState();
}

class CalendarViewBodyState extends State<CalendarViewBody> {
  late final CalendarData state;
  final _headScroll = ScrollController();
  final _allDayScroll = ScrollController();
  final _daysScroll = ScrollController();
  final _verticalScroll = ScrollController(initialScrollOffset: 7 * 56.0);
  bool _syncingScroll = false;
  bool _openedFocusedEvent = false;

  @override
  void initState() {
    super.initState();
    state = CalendarData(widget.controller, clock: widget.clock)
      ..addListener(_changed);
    _headScroll.addListener(() => _syncHorizontal(_headScroll));
    _allDayScroll.addListener(() => _syncHorizontal(_allDayScroll));
    _daysScroll.addListener(() => _syncHorizontal(_daysScroll));
    _configure();
    if (widget.mode == 'week') {
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _scrollWeekToAnchor(),
      );
    }
  }

  @override
  void didUpdateWidget(covariant CalendarViewBody oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.mode != widget.mode ||
        oldWidget.anchor != widget.anchor ||
        oldWidget.timezone != widget.timezone ||
        oldWidget.firstWeekday != widget.firstWeekday) {
      _configure();
      if (widget.mode == 'week' && oldWidget.mode != 'week') {
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => _scrollWeekToAnchor(),
        );
      }
    }
    if (oldWidget.focusRevision != widget.focusRevision) {
      _openedFocusedEvent = false;
      _openFocusedEventWhenReady();
    }
  }

  void _changed() {
    if (mounted) setState(() {});
    _openFocusedEventWhenReady();
  }

  void _openFocusedEventWhenReady() {
    if (_openedFocusedEvent || state.loading || widget.focusEventId == null) {
      return;
    }
    final eventId = widget.focusEventId!;
    final occurrenceStart = widget.focusOccurrenceStart;
    final item = state.items.cast<CalendarOccurrence?>().firstWhere(
      (candidate) =>
          candidate != null &&
          candidate.sourceId == eventId &&
          (occurrenceStart == null ||
              occurrenceStart.isEmpty ||
              candidate.originalStart == occurrenceStart),
      orElse: () => null,
    );
    if (item == null) return;
    _openedFocusedEvent = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_openItem(item));
    });
  }

  void _configure() {
    unawaited(
      state.load(
        mode: widget.mode,
        anchor: widget.anchor,
        timezone: widget.timezone,
        firstWeekday: widget.firstWeekday,
      ),
    );
  }

  @override
  void dispose() {
    state.removeListener(_changed);
    state.dispose();
    _headScroll.dispose();
    _allDayScroll.dispose();
    _daysScroll.dispose();
    _verticalScroll.dispose();
    super.dispose();
  }

  void _syncHorizontal(ScrollController source) {
    if (_syncingScroll || !source.hasClients) return;
    _syncingScroll = true;
    final offset = source.position.pixels;
    for (final target in [_headScroll, _allDayScroll, _daysScroll]) {
      if (identical(target, source) || !target.hasClients) continue;
      target.jumpTo(offset.clamp(0.0, target.position.maxScrollExtent));
    }
    _syncingScroll = false;
  }

  void _scrollWeekToAnchor() {
    if (!mounted || widget.mode != 'week') return;
    final start = calendarWeekStart(
      widget.anchor,
      firstWeekday: widget.firstWeekday,
    );
    final index = DateTime.utc(
      widget.anchor.year,
      widget.anchor.month,
      widget.anchor.day,
    ).difference(start).inDays.clamp(0, 6);
    final phone = MediaQuery.sizeOf(context).width <= 650;
    final dayWidth = phone ? 116.0 : 128.0;
    final offset = index * dayWidth;
    for (final controller in [_headScroll, _allDayScroll, _daysScroll]) {
      if (controller.hasClients) {
        controller.jumpTo(
          offset.clamp(0.0, controller.position.maxScrollExtent),
        );
      }
    }
  }

  void createEvent(DateTime date, {bool exactTime = false}) =>
      unawaited(_openEditor(date: date, exactTime: exactTime));

  Future<void> _openEditor({
    CalendarOccurrence? item,
    DateTime? date,
    bool exactTime = false,
    DateTime? draftStart,
    DateTime? draftEnd,
  }) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      useRootNavigator: false,
      isScrollControlled: true,
      showDragHandle: true,
      backgroundColor: palette(context)['surface.page'],
      builder: (context) => CalendarEventEditor(
        controller: widget.controller,
        existing: item,
        initialDate: date ?? widget.selectedDate,
        useInitialTime: exactTime,
        timezone: widget.timezone,
        zones: widget.zones,
        occurrenceStart: draftStart ?? item?.wallStart,
        occurrenceEnd: draftEnd ?? item?.wallEnd,
        onCreateAgentTask: item == null ? widget.onCreateAgentTask : null,
      ),
    );
    if (saved == true) await state.reload();
  }

  Future<void> _gestureEdit(
    CalendarOccurrence item, {
    required Offset delta,
    required double dayWidth,
    required bool resize,
  }) async {
    final start = item.wallStart, end = item.wallEnd;
    if (start == null || end == null || !item.isEvent) return;
    final minutes = calendarDragMinutes(delta.dy);
    final days = widget.mode == 'week' && !resize
        ? (delta.dx / dayWidth).round()
        : 0;
    if (minutes == 0 && days == 0) return;
    final shift = Duration(days: days, minutes: minutes);
    final nextStart = resize ? start : start.add(shift);
    var nextEnd = end.add(shift);
    if (!nextEnd.isAfter(nextStart)) {
      nextEnd = nextStart.add(const Duration(minutes: 15));
    }
    final origin = widget.controller.origin;
    final client = widget.controller.pairingStamp;
    final zone = '${item.occurrenceEvent['timezone'] ?? item.timezone}';
    try {
      Future<DateTime> inEventZone(DateTime wall) async {
        final value =
            '${calendarDateKey(wall)}T${_minuteLabel((wall.hour * 60 + wall.minute).toDouble())}';
        final instant = await widget.controller.gateway.call(
          'calendarWallInstant',
          {'value': value, 'timezone': widget.timezone},
        );
        if (instant is! num) throw StateError('Invalid calendar time');
        final formatted = await widget.controller.gateway.call('wallInput', {
          'at': instant.toInt(),
          'timezone': zone,
        });
        final result = calendarWall(formatted);
        if (result == null) throw StateError('Invalid calendar time');
        return result;
      }

      final times = await Future.wait([
        inEventZone(nextStart),
        inEventZone(nextEnd),
      ]);
      if (!mounted ||
          widget.controller.origin != origin ||
          widget.controller.pairingStamp != client) {
        return;
      }
      await _openEditor(item: item, draftStart: times[0], draftEnd: times[1]);
    } catch (_) {
      if (!mounted) return;
      setState(
        () => state.error = tr(
          "Unable to format calendar time in this time zone.",
        ),
      );
    }
  }

  Future<void> _openItem(CalendarOccurrence item) async {
    var detailZone = widget.timezone;
    if (item.event.isNotEmpty) {
      try {
        final projectedEvent = Map<String, dynamic>.from(item.event);
        final detail = obj(
          (await widget.controller.gateway.request(
            '/api/calendar/events/${enc(item.sourceId)}',
          ))['event'],
        );
        if (detail.isNotEmpty) {
          final zone = '${detail['timezone'] ?? item.timezone}';
          final wall = await Future.wait([
            if (!item.allDay)
              widget.controller.gateway.call('wallInput', {
                'at': item.startAt,
                'timezone': zone,
              })
            else
              Future<String?>.value(null),
            if (!item.allDay && item.endAt != item.startAt)
              widget.controller.gateway.call('wallInput', {
                'at': item.endAt,
                'timezone': zone,
              })
            else
              Future<String?>.value(null),
          ]);
          final effectiveStart = wall[0] is String ? wall[0] as String : null;
          final effectiveEnd = wall[1] is String ? wall[1] as String : null;
          detailZone = zone;
          item = CalendarOccurrence.fromJson(
            {
              ...item.raw,
              'event': detail,
              'occurrenceEvent': projectedEvent,
              'title': detail['title'] ?? item.title,
              'timezone': detail['timezone'] ?? item.timezone,
              'allDay': detail['allDay'] ?? item.allDay,
            },
            localStart: effectiveStart,
            localEnd: effectiveEnd,
          );
        }
      } catch (_) {
        // Projection data remains useful while the detail request is offline.
      }
    }
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      useRootNavigator: false,
      isScrollControlled: true,
      showDragHandle: true,
      backgroundColor: palette(context)['surface.page'],
      builder: (context) => CalendarDetailsSheet(
        item: item,
        timezone: detailZone,
        onEdit: item.isEvent
            ? () {
                Navigator.pop(context);
                _openEditor(item: item);
              }
            : null,
        onDelete: item.isEvent
            ? () {
                Navigator.pop(context);
                _deleteEvent(item);
              }
            : null,
        onOpenSchedule: item.isSchedule
            ? () {
                Navigator.pop(context);
                widget.onOpenSchedule(item.sourceId);
              }
            : null,
      ),
    );
  }

  Future<void> _deleteEvent(CalendarOccurrence item) async {
    final event = item.event;
    final repeating = event['recurrence'] != null;
    final scope = repeating
        ? await showModalBottomSheet<String>(
            context: context,
            useRootNavigator: false,
            showDragHandle: true,
            backgroundColor: palette(context)['surface.page'],
            builder: (context) => _DeleteScopeSheet(item: item),
          )
        : 'series';
    if (scope == null || !mounted) return;
    try {
      await widget.controller.gateway.request(
        '/api/calendar/events/${enc(item.sourceId)}',
        method: 'DELETE',
        body: {
          'revision': item.revision,
          'scope': scope,
          if (scope == 'occurrence' || scope == 'following')
            'occurrence': item.originalStart,
        },
      );
      await state.reload();
    } catch (error) {
      if (mounted) showNotice(context, LiveController.describe(error));
    }
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (state.error != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: WebNotice(state.error!, error: true),
          ),
        if (state.reminderDeliveryAvailable == false)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
            child: WebNotice(
              tr("Calendar reminders cannot be delivered to this device."),
            ),
          ),
        if (state.loading && state.items.isEmpty)
          Expanded(child: Center(child: WebNotice(tr("Loading calendar…"))))
        else
          Expanded(
            child: switch (widget.mode) {
              'month' => _month(),
              'list' => _list(),
              'week' => _timeGrid(week: true),
              _ => _timeGrid(week: false),
            },
          ),
        if (state.historyLimited || state.limited || state.nextCursor != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
            child: Wrap(
              alignment: WrapAlignment.center,
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 10,
              children: [
                if (state.historyLimited)
                  Text(
                    tr("Available schedule history is bounded."),
                    style: webText(context, size: 11, color: 'text.muted'),
                  ),
                if (state.limited)
                  Text(
                    tr("Some calendar items are grouped or limited."),
                    style: webText(context, size: 11, color: 'text.muted'),
                  ),
                if (state.nextCursor != null)
                  TextButton(
                    onPressed: state.loading ? null : state.loadMore,
                    child: Text(
                      state.loading ? tr("Loading…") : tr("Load more"),
                      style: webText(context, size: 12),
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _month() {
    final grid = calendarMonthGrid(
      widget.anchor,
      firstWeekday: widget.firstWeekday,
    );
    final labels = MaterialLocalizations.of(context).narrowWeekdays;
    final weekdayIndex = widget.firstWeekday == DateTime.monday ? 1 : 0;
    final days = [for (var i = 0; i < 7; i++) labels[(weekdayIndex + i) % 7]];
    final selectedItems = calendarItemsOnDate(
      state.items,
      widget.selectedDate,
      filter: widget.filter,
    );
    final phone = MediaQuery.sizeOf(context).width <= 650;
    final textScale = MediaQuery.textScalerOf(context).scale(1);
    final compactCells = textScale >= 1.5;
    return LayoutBuilder(
      builder: (context, constraints) {
        final rowCount = grid.length ~/ 7;
        final rowHeight = ((constraints.maxHeight - 82) / rowCount).clamp(
          30.0,
          compactCells
              ? 30.0
              : phone
              ? 48.0
              : 62.0,
        );
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: EdgeInsets.symmetric(horizontal: phone ? 14 : 22),
              child: Row(
                children: [
                  for (final label in days)
                    Expanded(
                      child: SizedBox(
                        height: 27,
                        child: Center(
                          child: Text(
                            label,
                            style: webText(
                              context,
                              size: 11,
                              color: 'text.muted',
                            ),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            Padding(
              padding: EdgeInsets.symmetric(horizontal: phone ? 14 : 22),
              child: Column(
                children: [
                  for (var row = 0; row < grid.length ~/ 7; row++)
                    SizedBox(
                      height: rowHeight,
                      child: Row(
                        children: [
                          for (var col = 0; col < 7; col++)
                            Expanded(
                              child: _monthCell(grid[row * 7 + col], phone),
                            ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
            Container(height: 1, color: palette(context)['line.hairline']),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 3),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      MaterialLocalizations.of(context).formatFullDate(
                        DateTime(
                          widget.selectedDate.year,
                          widget.selectedDate.month,
                          widget.selectedDate.day,
                        ),
                      ),
                      style: webText(
                        context,
                        size: 14,
                        weight: FontWeight.w600,
                      ),
                    ),
                  ),
                  Text(
                    tr("{0} items", [selectedItems.length]),
                    style: webText(context, size: 11, color: 'text.muted'),
                  ),
                ],
              ),
            ),
            Expanded(
              child: selectedItems.isEmpty
                  ? Center(
                      child: Text(
                        tr("No items for this day."),
                        style: webText(context, size: 13, color: 'text.muted'),
                      ),
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.fromLTRB(12, 2, 12, 8),
                      itemCount: selectedItems.length,
                      itemBuilder: (context, index) =>
                          _agendaItem(selectedItems[index]),
                    ),
            ),
            Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: Text(
                tr(
                  "Agent tasks start at their scheduled time; personal events never start an agent.",
                ),
                textAlign: TextAlign.center,
                style: webText(context, size: 10, color: 'text.muted'),
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _list() {
    final dates =
        calendarMonthGrid(
          widget.anchor,
          firstWeekday: widget.firstWeekday,
        ).where(
          (date) =>
              date.year == widget.anchor.year &&
              date.month == widget.anchor.month,
        );
    final groups = [
      for (final date in dates)
        (date, calendarItemsOnDate(state.items, date, filter: widget.filter)),
    ].where((entry) => entry.$2.isNotEmpty).toList();
    if (groups.isEmpty) {
      return Center(
        child: Text(
          tr("No items in this month."),
          style: webText(context, size: 13, color: 'text.muted'),
        ),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
      itemCount: groups.length,
      itemBuilder: (context, index) {
        final (date, items) = groups[index];
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 8, 4, 3),
              child: Text(
                MaterialLocalizations.of(
                  context,
                ).formatFullDate(DateTime(date.year, date.month, date.day)),
                style: webText(context, size: 13, weight: FontWeight.w600),
              ),
            ),
            for (final item in items) _agendaItem(item),
          ],
        );
      },
    );
  }

  Widget _monthCell(DateTime date, bool phone) {
    final items = calendarItemsOnDate(state.items, date, filter: widget.filter);
    final compact = MediaQuery.textScalerOf(context).scale(1) >= 1.5;
    final selected =
        date.year == widget.selectedDate.year &&
        date.month == widget.selectedDate.month &&
        date.day == widget.selectedDate.day;
    final today =
        state.todayWall != null &&
        calendarDateKey(date) == calendarDateKey(state.todayWall!);
    final inMonth =
        date.year == widget.anchor.year && date.month == widget.anchor.month;
    final visible = items.take(phone ? 4 : 3).toList();
    return Semantics(
      button: true,
      selected: selected,
      label:
          '${MaterialLocalizations.of(context).formatMediumDate(DateTime(date.year, date.month, date.day))}, ${tr("{0} items", [items.length])}',
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () =>
            widget.onSelectedDate(DateTime(date.year, date.month, date.day)),
        child: Container(
          margin: const EdgeInsets.symmetric(horizontal: 1),
          decoration: BoxDecoration(
            color: selected && !today
                ? palette(context)['accent.soft']
                : Colors.transparent,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.start,
            children: [
              SizedBox(height: compact ? 1 : 2),
              Container(
                width: compact ? 24 : 29,
                height: compact ? 24 : 29,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: today
                      ? palette(context)['accent.default']
                      : Colors.transparent,
                  shape: BoxShape.circle,
                ),
                child: MediaQuery(
                  data: MediaQuery.of(context).copyWith(
                    textScaler: compact
                        ? const TextScaler.linear(1.35)
                        : MediaQuery.textScalerOf(context),
                  ),
                  child: Text(
                    '${date.day}',
                    style: webText(
                      context,
                      size: 13,
                      weight: today || selected
                          ? FontWeight.w600
                          : FontWeight.w400,
                      color: today
                          ? 'surface.page'
                          : !inMonth
                          ? 'text.muted'
                          : 'text.primary',
                    ),
                  ),
                ),
              ),
              SizedBox(height: compact ? 1 : 3),
              if (items.isNotEmpty)
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    for (final item in visible)
                      Container(
                        width: phone ? 4 : 5,
                        height: phone ? 4 : 5,
                        margin: const EdgeInsets.symmetric(horizontal: 1),
                        decoration: BoxDecoration(
                          color: item.isSchedule
                              ? palette(context)['text.muted']
                              : palette(context)['accent.default'],
                          shape: BoxShape.circle,
                        ),
                      ),
                    if (!phone && items.length > visible.length)
                      Text(
                        tr("+{0} more", [items.length - visible.length]),
                        style: webText(context, size: 8, color: 'text.muted'),
                      ),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _agendaItem(CalendarOccurrence item) {
    final start = item.wallStart;
    final end = item.wallEnd;
    final time = item.allDay
        ? tr("All day")
        : start == null
        ? tr("Time unavailable")
        : '${_timeLabel(start)}${item.isEvent && end != null ? '–${_timeLabel(end)}' : ''}';
    final subtitle = item.isSchedule
        ? '${tr("Agent task")} · ${_statusLabel(item)}'
        : '${item.allDay ? tr("All-day event") : time}${obj(item.event)['location'] == null || '${obj(item.event)['location']}'.isEmpty ? '' : ' · ${obj(item.event)['location']}'}';
    return InkWell(
      key: ValueKey('calendar-agenda-${item.id}'),
      borderRadius: BorderRadius.circular(8),
      onTap: () => _openItem(item),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 8),
        child: Row(
          children: [
            SizedBox(
              width: 42,
              child: Text(
                time,
                style: webText(context, size: 11, color: 'text.muted'),
              ),
            ),
            const SizedBox(width: 8),
            Container(
              width: 30,
              height: 30,
              decoration: BoxDecoration(
                color: item.isSchedule
                    ? palette(context)['web.bg-subtle']
                    : palette(context)['accent.soft'],
                borderRadius: BorderRadius.circular(8),
              ),
              child: Icon(
                item.isSchedule ? LucideIcons.bot : LucideIcons.calendarDays,
                size: 15,
                color: item.isSchedule
                    ? palette(context)['text.muted']
                    : palette(context)['accent.default'],
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: webText(context, size: 13, weight: FontWeight.w600),
                  ),
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: webText(context, size: 11, color: 'text.muted'),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 5),
            Icon(
              LucideIcons.chevronRight,
              size: 15,
              color: palette(context)['text.muted'],
            ),
          ],
        ),
      ),
    );
  }

  Widget _timeGrid({required bool week}) {
    final dates = week
        ? [
            for (var i = 0; i < 7; i++)
              calendarWeekStart(
                widget.anchor,
                firstWeekday: widget.firstWeekday,
              ).add(Duration(days: i)),
          ]
        : [
            DateTime.utc(
              widget.anchor.year,
              widget.anchor.month,
              widget.anchor.day,
            ),
          ];
    final phone = MediaQuery.sizeOf(context).width <= 650;
    final hasDstDay = dates.any((date) {
      final minutes = state.dayLengthMinutes[calendarDateKey(date)];
      return minutes != null && minutes != 1440;
    });
    return LayoutBuilder(
      builder: (context, bounds) {
        const gutter = 44.0;
        final dayWidth = week
            ? math.max(phone ? 116.0 : 128.0, (bounds.maxWidth - gutter) / 7)
            : math.max(1.0, bounds.maxWidth - gutter);
        final totalWidth = dayWidth * dates.length;
        final allDaySpans = calendarAllDaySpans(
          state.items,
          dates,
          filter: widget.filter,
        );
        final allDayRows = allDaySpans.isEmpty
            ? 0
            : allDaySpans.map((span) => span.lane).reduce(math.max) + 1;
        final allDayHeight = math
            .max(42.0, allDayRows == 0 ? 0 : allDayRows * 24.0 + 8)
            .toDouble();
        final todayKey = state.todayWall == null
            ? null
            : calendarDateKey(state.todayWall!);
        return Column(
          children: [
            SizedBox(
              height: 58,
              child: Row(
                children: [
                  SizedBox(
                    width: gutter,
                    child: week
                        ? Center(
                            child: Text(
                              _zoneOffsetLabel(),
                              style: webText(
                                context,
                                size: 9,
                                color: 'text.muted',
                              ),
                            ),
                          )
                        : const SizedBox.shrink(),
                  ),
                  Expanded(
                    child: SingleChildScrollView(
                      controller: _headScroll,
                      scrollDirection: Axis.horizontal,
                      child: SizedBox(
                        width: totalWidth,
                        child: Row(
                          children: [
                            for (final date in dates)
                              SizedBox(
                                width: dayWidth,
                                child: InkWell(
                                  onTap: () => widget.onAnchorChanged(
                                    DateTime(date.year, date.month, date.day),
                                  ),
                                  child: Column(
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    children: [
                                      Text(
                                        _weekdayLabel(date),
                                        style: webText(
                                          context,
                                          size: 10,
                                          color: 'text.muted',
                                        ),
                                      ),
                                      const SizedBox(height: 2),
                                      Container(
                                        width: 31,
                                        height: 31,
                                        alignment: Alignment.center,
                                        decoration: BoxDecoration(
                                          color:
                                              calendarDateKey(date) == todayKey
                                              ? palette(
                                                  context,
                                                )['accent.default']
                                              : Colors.transparent,
                                          shape: BoxShape.circle,
                                        ),
                                        child: Text(
                                          '${date.day}',
                                          style: webText(
                                            context,
                                            size: 15,
                                            weight: FontWeight.w600,
                                            color:
                                                calendarDateKey(date) ==
                                                    todayKey
                                                ? 'surface.page'
                                                : 'text.primary',
                                          ),
                                        ),
                                      ),
                                      if (state
                                              .dayLengthMinutes[calendarDateKey(
                                            date,
                                          )]
                                          case final minutes?
                                          when minutes != 1440)
                                        Text(
                                          tr("{0}-hour day", [minutes ~/ 60]),
                                          style: webText(
                                            context,
                                            size: 8,
                                            color: 'text.muted',
                                          ),
                                        ),
                                    ],
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            if (hasDstDay)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 4, 12, 2),
                child: Text(
                  tr(
                    "DST transition: repeated or missing clock times share this wall-clock grid.",
                  ),
                  textAlign: TextAlign.center,
                  style: webText(context, size: 10, color: 'text.muted'),
                ),
              ),
            Container(height: 1, color: palette(context)['line.hairline']),
            SizedBox(
              height: allDayHeight,
              child: Row(
                children: [
                  SizedBox(
                    width: gutter,
                    child: Center(
                      child: Text(
                        tr("All day"),
                        style: webText(context, size: 9, color: 'text.muted'),
                      ),
                    ),
                  ),
                  Expanded(
                    child: SingleChildScrollView(
                      controller: _allDayScroll,
                      scrollDirection: Axis.horizontal,
                      child: SizedBox(
                        width: totalWidth,
                        height: allDayHeight,
                        child: Stack(
                          children: [
                            for (var index = 0; index < dates.length; index++)
                              Positioned(
                                left: index * dayWidth,
                                top: 0,
                                bottom: 0,
                                width: dayWidth,
                                child: Container(
                                  decoration: BoxDecoration(
                                    border: Border(
                                      right: BorderSide(
                                        color: palette(
                                          context,
                                        )['line.hairline'],
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            for (final span in allDaySpans)
                              Positioned(
                                left: span.startIndex * dayWidth + 3,
                                top: span.lane * 24.0 + 4,
                                width:
                                    (span.endIndex - span.startIndex) *
                                        dayWidth -
                                    6,
                                height: 22,
                                child: InkWell(
                                  onTap: () => _openItem(span.item),
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 5,
                                    ),
                                    alignment: Alignment.centerLeft,
                                    decoration: BoxDecoration(
                                      color: palette(context)['accent.soft'],
                                      borderRadius: BorderRadius.circular(4),
                                    ),
                                    child: Text(
                                      span.item.title,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: webText(
                                        context,
                                        size: 10,
                                        color: 'accent.default',
                                        weight: FontWeight.w500,
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Container(height: 1, color: palette(context)['line.hairline']),
            Expanded(
              child: SingleChildScrollView(
                controller: _verticalScroll,
                child: SizedBox(
                  height: 24 * 56.0,
                  child: Row(
                    children: [
                      SizedBox(
                        width: gutter,
                        child: Stack(
                          children: [
                            for (var hour = 0; hour < 24; hour++)
                              Positioned(
                                top: hour * 56.0 - 7,
                                right: 4,
                                child: Text(
                                  hour == 0
                                      ? ''
                                      : '${hour.toString().padLeft(2, '0')}:00',
                                  style: webText(
                                    context,
                                    size: 9,
                                    color: 'text.muted',
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                      Expanded(
                        child: SingleChildScrollView(
                          controller: _daysScroll,
                          scrollDirection: Axis.horizontal,
                          child: SizedBox(
                            width: totalWidth,
                            height: 24 * 56.0,
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                for (final date in dates)
                                  SizedBox(
                                    width: dayWidth,
                                    child: _timelineDay(
                                      date,
                                      todayKey,
                                      week: week,
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _timelineDay(DateTime date, String? todayKey, {required bool week}) {
    final items = calendarItemsOnDate(state.items, date, filter: widget.filter);
    final segments = calendarTimedSegments(items, date);
    final schedulePoints = calendarSchedulePoints(items, date);
    final dateKey = calendarDateKey(date);
    final isToday = dateKey == todayKey;
    final current = state.todayWall;
    final nowY = current != null && calendarDateKey(current) == dateKey
        ? (current.hour * 60 + current.minute) / 60 * 56.0
        : null;
    return LayoutBuilder(
      builder: (context, bounds) {
        return GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapUp: (details) {
            final minute = ((details.localPosition.dy / 56) * 60).round().clamp(
              0,
              1439,
            );
            final start = DateTime(
              date.year,
              date.month,
              date.day,
              minute ~/ 60,
              minute % 60,
            );
            createEvent(start, exactTime: true);
          },
          child: Stack(
            clipBehavior: Clip.hardEdge,
            children: [
              Positioned.fill(
                child: Column(
                  children: [
                    for (var hour = 0; hour < 24; hour++)
                      Expanded(
                        child: Container(
                          decoration: BoxDecoration(
                            color: isToday && hour >= 0
                                ? palette(
                                    context,
                                  )['accent.soft'].withValues(alpha: .11)
                                : null,
                            border: Border(
                              top: BorderSide(
                                color: palette(context)['line.hairline'],
                              ),
                              right: BorderSide(
                                color: palette(context)['line.hairline'],
                              ),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              for (final segment in segments)
                Positioned(
                  top: segment.startMinute / 60 * 56.0,
                  left: segment.lane * bounds.maxWidth / segment.laneCount + 3,
                  width: bounds.maxWidth / segment.laneCount - 6,
                  height: math.max(
                    34.0,
                    (segment.endMinute - segment.startMinute) / 60 * 56.0,
                  ),
                  child: _eventTimeCard(
                    segment.item,
                    segment.startMinute,
                    segment.endMinute,
                    bounds.maxWidth,
                    canResize:
                        segment.item.wallEnd != null &&
                        calendarDateKey(
                              segment.item.wallEnd!.subtract(
                                const Duration(microseconds: 1),
                              ),
                            ) ==
                            dateKey,
                  ),
                ),
              for (final point in schedulePoints)
                Positioned(
                  top: point.minute / 60 * 56.0,
                  left: point.lane * bounds.maxWidth / point.laneCount + 3,
                  width: bounds.maxWidth / point.laneCount - 6,
                  height: 23,
                  child: _scheduleMarker(point.item),
                ),
              if (nowY != null)
                Positioned(
                  top: nowY,
                  left: 0,
                  right: 0,
                  child: IgnorePointer(
                    child: Container(
                      height: 1,
                      color: palette(context)['accent.default'],
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  Widget _eventTimeCard(
    CalendarOccurrence item,
    double startMinute,
    double endMinute,
    double dayWidth, {
    required bool canResize,
  }) => CalendarTimeGestures(
    key: ValueKey('calendar-time-${item.id}'),
    resizeLabel: tr("End time"),
    handleColor: palette(context)['accent.default'].withValues(alpha: .5),
    canResize: canResize,
    onMove: (delta) => unawaited(
      _gestureEdit(item, delta: delta, dayWidth: dayWidth, resize: false),
    ),
    onResize: (delta) => unawaited(
      _gestureEdit(
        item,
        delta: Offset(0, delta),
        dayWidth: dayWidth,
        resize: true,
      ),
    ),
    child: InkWell(
      onTap: () => _openItem(item),
      child: Container(
        decoration: BoxDecoration(
          color: palette(context)['accent.soft'],
          border: Border(
            left: BorderSide(
              color: palette(context)['accent.default'],
              width: 2,
            ),
          ),
          borderRadius: BorderRadius.circular(6),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 3),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              item.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: webText(
                context,
                size: 10,
                color: 'accent.default',
                weight: FontWeight.w600,
              ),
            ),
            if (endMinute - startMinute > 20)
              Text(
                '${_minuteLabel(startMinute)}–${_minuteLabel(endMinute)}',
                maxLines: 1,
                overflow: TextOverflow.clip,
                style: webText(context, size: 9, color: 'accent.default'),
              ),
          ],
        ),
      ),
    ),
  );

  Widget _scheduleMarker(CalendarOccurrence item) => InkWell(
    onTap: () => _openItem(item),
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 5),
      decoration: BoxDecoration(
        color: palette(context)['surface.page'],
        border: Border.all(color: palette(context)['line.default']),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        children: [
          Icon(
            LucideIcons.bot,
            size: 11,
            color: palette(context)['text.muted'],
          ),
          const SizedBox(width: 4),
          Expanded(
            child: Text(
              item.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: webText(context, size: 10, color: 'text.secondary'),
            ),
          ),
          if (item.run['status'] == 'completed')
            Icon(
              LucideIcons.check,
              size: 12,
              color: palette(context)['status.success'],
            ),
        ],
      ),
    ),
  );

  String _statusLabel(CalendarOccurrence item) {
    final runStatus = '${item.run['status'] ?? ''}';
    if (runStatus.isNotEmpty) return tr(_runStatusKey(runStatus));
    final scheduleStatus = '${item.schedule['status'] ?? ''}';
    if (scheduleStatus == 'paused') return tr("Paused");
    return tr("Scheduled");
  }

  String _runStatusKey(String status) => switch (status) {
    'running' => "Running",
    'waiting_input' => "Waiting for you",
    'completed' => "Completed",
    'failed' => "Failed",
    'missed' => "Missed",
    'skipped' => "Skipped",
    'dismissed' => "Dismissed",
    _ => "Scheduled",
  };

  String _weekdayLabel(DateTime date) =>
      MaterialLocalizations.of(context).narrowWeekdays[date.weekday % 7];

  String _zoneOffsetLabel() {
    final wall = state.todayWall;
    if (wall == null) return widget.timezone;
    return widget.timezone;
  }

  String _timeLabel(DateTime wall) =>
      '${wall.hour.toString().padLeft(2, '0')}:${wall.minute.toString().padLeft(2, '0')}';

  String _minuteLabel(double minute) {
    final total = minute.round().clamp(0, 1440);
    final hour = total ~/ 60;
    final mins = total % 60;
    return '${hour.toString().padLeft(2, '0')}:${mins.toString().padLeft(2, '0')}';
  }
}

class CalendarData extends ChangeNotifier {
  CalendarData(this.controller, {DateTime Function()? clock})
    : clock = clock ?? DateTime.now {
    _origin = controller.origin;
    _client = _calendarClientIdentity(controller);
    _calendarRevision = controller.calendarRevision;
    _scheduleRevision = controller.attention.scheduleRevision;
    controller.addListener(_external);
  }

  final LiveController controller;
  final DateTime Function() clock;
  String? _origin, _client;
  int _calendarRevision = 0, _scheduleRevision = 0;
  int _firstWeekday = DateTime.sunday;
  int _read = 0;
  bool _disposed = false;
  String? error, nextCursor, _mode, _timezone, _fromDate, _toDate;
  DateTime? _anchor;
  bool loading = false, limited = false, historyLimited = false;
  bool? reminderDeliveryAvailable;
  String? accountKey;
  DateTime? todayWall;
  Map<String, int> dayLengthMinutes = {};
  List<CalendarOccurrence> items = [];

  void _external() {
    final accountChanged =
        _origin != controller.origin ||
        _client != _calendarClientIdentity(controller);
    if (accountChanged) {
      _origin = controller.origin;
      _client = _calendarClientIdentity(controller);
      _calendarRevision = controller.calendarRevision;
      _scheduleRevision = controller.attention.scheduleRevision;
      items = [];
      nextCursor = null;
      error = null;
      reminderDeliveryAvailable = null;
      accountKey = null;
      dayLengthMinutes = {};
      if (_mode != null) {
        unawaited(
          load(
            mode: _mode!,
            anchor: _anchor ?? calendarDate(_fromDate),
            timezone: _timezone!,
            firstWeekday: _firstWeekday,
            force: true,
          ),
        );
      }
      notifyListeners();
      return;
    }
    if (_calendarRevision != controller.calendarRevision ||
        _scheduleRevision != controller.attention.scheduleRevision) {
      _calendarRevision = controller.calendarRevision;
      _scheduleRevision = controller.attention.scheduleRevision;
      if (_mode != null) unawaited(reload());
    }
  }

  Future<void> reload() async {
    if (_mode == null || _fromDate == null) return;
    await load(
      mode: _mode!,
      anchor: _anchor ?? calendarDate(_fromDate),
      timezone: _timezone ?? 'UTC',
      firstWeekday: _firstWeekday,
      force: true,
    );
  }

  Future<void> load({
    required String mode,
    required DateTime anchor,
    required String timezone,
    required int firstWeekday,
    bool force = false,
  }) async {
    _firstWeekday = firstWeekday;
    final start = switch (mode) {
      'month' || 'list' => calendarWeekStart(
        DateTime.utc(anchor.year, anchor.month),
        firstWeekday: firstWeekday,
      ),
      'week' => calendarWeekStart(anchor, firstWeekday: firstWeekday),
      _ => DateTime.utc(anchor.year, anchor.month, anchor.day),
    };
    final dayCount = switch (mode) {
      'month' ||
      'list' => calendarMonthGrid(anchor, firstWeekday: firstWeekday).length,
      'week' => 7,
      _ => 1,
    };
    final startDate = calendarDateKey(start);
    final endDate = calendarDateKey(start.add(Duration(days: dayCount)));
    final key = '$mode|$startDate|$endDate|$timezone';
    final previousKey = '$_mode|$_fromDate|$_toDate|$_timezone';
    if (!force && key == previousKey && !loading) return;
    _mode = mode;
    _timezone = timezone;
    _anchor = DateTime(anchor.year, anchor.month, anchor.day);
    _fromDate = startDate;
    _toDate = endDate;
    final read = ++_read;
    final origin = controller.origin,
        client = _calendarClientIdentity(controller);
    loading = true;
    error = null;
    nextCursor = null;
    limited = false;
    historyLimited = false;
    if (key != previousKey) items = [];
    notifyListeners();
    try {
      final boundaryDates = mode == 'month'
          ? [start, start.add(Duration(days: dayCount))]
          : [
              for (var index = 0; index <= dayCount; index++)
                start.add(Duration(days: index)),
            ];
      final bounds = await Future.wait(
        boundaryDates.map(
          (date) => controller.gateway.call('calendarDateStart', {
            'date': calendarDateKey(date),
            'timezone': timezone,
          }),
        ),
      );
      if (!_current(read, origin, client)) return;
      if (bounds.any((value) => value is! num)) {
        throw StateError(
          tr("Unable to calculate calendar time zone boundaries."),
        );
      }
      final from = (bounds.first as num).toInt(),
          to = (bounds.last as num).toInt();
      dayLengthMinutes = mode == 'month'
          ? {}
          : {
              for (var index = 0; index < dayCount; index++)
                calendarDateKey(start.add(Duration(days: index))):
                    (((bounds[index + 1] as num).toInt() -
                                (bounds[index] as num).toInt()) /
                            60000)
                        .round(),
            };
      unawaited(_loadContext(read, origin, client));
      final response = await controller.gateway.request(
        '/api/calendar?from=$from&to=$to&timezone=${Uri.encodeQueryComponent(timezone)}',
      );
      if (!_current(read, origin, client)) return;
      await _accept(
        response,
        append: false,
        read: read,
        origin: origin,
        client: client,
      );
      await _loadTodayWall(read, origin, client, timezone);
    } catch (e) {
      if (_current(read, origin, client)) error = LiveController.describe(e);
    } finally {
      if (_current(read, origin, client)) {
        loading = false;
        notifyListeners();
      }
    }
  }

  Future<void> loadMore() async {
    final cursor = nextCursor;
    final fromDate = _fromDate, toDate = _toDate, timezone = _timezone;
    if (loading ||
        cursor == null ||
        fromDate == null ||
        toDate == null ||
        timezone == null) {
      return;
    }
    final read = ++_read;
    final origin = controller.origin,
        client = _calendarClientIdentity(controller);
    loading = true;
    error = null;
    notifyListeners();
    try {
      final from = await controller.gateway.call('calendarDateStart', {
        'date': fromDate,
        'timezone': timezone,
      });
      final to = await controller.gateway.call('calendarDateStart', {
        'date': toDate,
        'timezone': timezone,
      });
      if (!_current(read, origin, client)) return;
      if (from is! num || to is! num) {
        throw StateError(
          tr("Unable to calculate calendar time zone boundaries."),
        );
      }
      final response = await controller.gateway.request(
        '/api/calendar?from=${from.toInt()}&to=${to.toInt()}&timezone=${Uri.encodeQueryComponent(timezone)}&cursor=${Uri.encodeQueryComponent(cursor)}',
      );
      if (!_current(read, origin, client)) return;
      await _accept(
        response,
        append: true,
        read: read,
        origin: origin,
        client: client,
      );
    } catch (e) {
      if (_current(read, origin, client)) error = LiveController.describe(e);
    } finally {
      if (_current(read, origin, client)) {
        loading = false;
        notifyListeners();
      }
    }
  }

  Future<void> _accept(
    Json response, {
    required bool append,
    required int read,
    required String? origin,
    required String? client,
  }) async {
    final rawItems = rows(response['items']);
    final formatted = await Future.wait(
      rawItems.map((raw) async {
        if (raw['allDay'] == true) return CalendarOccurrence.fromJson(raw);
        final startAt = raw['startAt'], endAt = raw['endAt'];
        if (startAt is! num || endAt is! num) {
          throw StateError(tr("A calendar item has an invalid time."));
        }
        String? start, end;
        final startValue = await controller.gateway.call('wallInput', {
          'at': startAt,
          'timezone': _timezone,
        });
        if (startValue is! String) {
          throw StateError(
            tr("Unable to format calendar time in this time zone."),
          );
        }
        start = startValue;
        if (endAt != startAt) {
          final endValue = await controller.gateway.call('wallInput', {
            'at': endAt,
            'timezone': _timezone,
          });
          if (endValue is! String) {
            throw StateError(
              tr("Unable to format calendar time in this time zone."),
            );
          }
          end = endValue;
        } else {
          end = start;
        }
        return CalendarOccurrence.fromJson(
          raw,
          localStart: start,
          localEnd: end,
        );
      }),
    );
    if (!_current(read, origin, client)) return;
    final merged = append ? [...items, ...formatted] : formatted;
    final seen = <String>{};
    items = [
      for (final item in merged)
        if (seen.add(item.id)) item,
    ];
    limited = response['limited'] == true;
    historyLimited = response['historyLimited'] == true;
    nextCursor =
        response['nextCursor'] is String &&
            '${response['nextCursor']}'.isNotEmpty
        ? '${response['nextCursor']}'
        : null;
    notifyListeners();
  }

  Future<void> _loadTodayWall(
    int read,
    String? origin,
    String? client,
    String timezone,
  ) async {
    try {
      final result = await controller.gateway.call('wallInput', {
        'at': clock().millisecondsSinceEpoch,
        'timezone': timezone,
      });
      if (!_current(read, origin, client)) return;
      todayWall = calendarWall(result);
    } catch (_) {
      todayWall = null;
    }
  }

  Future<void> _loadContext(int read, String? origin, String? client) async {
    try {
      final value = await controller.gateway.request('/api/calendar/context');
      if (!_current(read, origin, client)) return;
      accountKey = value['accountKey'] as String?;
      reminderDeliveryAvailable = value['reminderDeliveryAvailable'] as bool?;
      notifyListeners();
    } catch (_) {
      // Calendar reading and editing remain available when context is offline.
    }
  }

  bool _current(int read, String? origin, String? client) =>
      !_disposed &&
      read == _read &&
      origin == controller.origin &&
      client == _calendarClientIdentity(controller);

  @override
  void dispose() {
    _disposed = true;
    controller.removeListener(_external);
    super.dispose();
  }
}

class CalendarDetailsSheet extends StatelessWidget {
  const CalendarDetailsSheet({
    super.key,
    required this.item,
    required this.timezone,
    this.onEdit,
    this.onDelete,
    this.onOpenSchedule,
  });
  final CalendarOccurrence item;
  final String timezone;
  final VoidCallback? onEdit, onDelete, onOpenSchedule;

  String _dateTimeLabel(BuildContext context) {
    final material = MaterialLocalizations.of(context);
    if (item.allDay) {
      final start = calendarDate(
        item.startDate ??
            item.event['start'] ??
            calendarDateKey(
              DateTime.fromMillisecondsSinceEpoch(item.startAt, isUtc: true),
            ),
      );
      final end = calendarDate(
        item.endDate ??
            item.event['end'] ??
            calendarDateKey(start.add(const Duration(days: 1))),
      );
      final last = end.subtract(const Duration(days: 1));
      return start == last
          ? material.formatFullDate(
              DateTime(start.year, start.month, start.day),
            )
          : '${material.formatFullDate(DateTime(start.year, start.month, start.day))} – ${material.formatFullDate(DateTime(last.year, last.month, last.day))}';
    }
    final event = item.event;
    final start = item.wallStart ?? calendarWall(event['start']);
    final end = item.wallEnd ?? calendarWall(event['end']);
    if (start == null) return tr("Time unavailable");
    final label =
        '${material.formatFullDate(DateTime(start.year, start.month, start.day))} · ${_time(start)}${end == null ? '' : '–${_time(end)}'}';
    return label;
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final event = item.event;
    final occurrenceEvent = item.occurrenceEvent;
    final schedule = item.schedule;
    final run = item.run;
    final recurrence = obj(event['recurrence']);
    final reminders =
        (occurrenceEvent['reminderMinutes'] as List? ??
                event['reminderMinutes'] as List? ??
                [])
            .whereType<num>()
            .map((value) => value.toInt())
            .toList();
    final status = '${run['status'] ?? schedule['status'] ?? ''}';
    final height = MediaQuery.sizeOf(context).height * .78;
    return SafeArea(
      top: false,
      child: SizedBox(
        height: height.clamp(360.0, 760.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 3, 16, 10),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      tr("Calendar item details"),
                      style: webText(context, size: 12, color: 'text.muted'),
                    ),
                  ),
                  WebIconButton(
                    LucideIcons.x,
                    tr("Close"),
                    onPressed: () => Navigator.pop(context),
                    size: 32,
                    iconSize: 17,
                  ),
                ],
              ),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(22, 4, 22, 18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      item.title,
                      style: webText(
                        context,
                        size: 21,
                        weight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: Container(
                        decoration: BoxDecoration(
                          color: palette(context)['web.bg-subtle'],
                          borderRadius: BorderRadius.circular(999),
                        ),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 9,
                          vertical: 5,
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              item.isSchedule
                                  ? LucideIcons.bot
                                  : LucideIcons.calendarDays,
                              size: 14,
                              color: palette(context)['text.muted'],
                            ),
                            const SizedBox(width: 5),
                            Text(
                              tr(
                                item.isSchedule
                                    ? "Agent task"
                                    : "Personal event",
                              ),
                              style: webText(
                                context,
                                size: 11,
                                color: 'text.secondary',
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    _detailRow(
                      context,
                      LucideIcons.clock3,
                      _dateTimeLabel(context),
                      subtitle: timezone,
                    ),
                    if (item.isSchedule) ...[
                      _detailRow(
                        context,
                        LucideIcons.folderOpen,
                        '${obj(schedule['workspace'])['name'] ?? tr("Workspace unavailable")}',
                        subtitle: tr("Each run starts a new agent session."),
                      ),
                      _detailRow(
                        context,
                        _statusIcon(status),
                        tr(_statusLabel(status)),
                        subtitle:
                            '${schedule['cron'] ?? tr("One-time task")} · ${schedule['timezone'] ?? item.timezone}',
                      ),
                      if (run['result'] is String &&
                          '${run['result']}'.isNotEmpty)
                        _detailRow(
                          context,
                          LucideIcons.fileText,
                          tr("Run result"),
                          subtitle: '${run['result']}',
                        ),
                      if (schedule['prompt'] is String &&
                          '${schedule['prompt']}'.isNotEmpty)
                        _detailRow(
                          context,
                          LucideIcons.alignLeft,
                          tr("Prompt"),
                          subtitle: '${schedule['prompt']}',
                        ),
                    ] else ...[
                      _detailRow(
                        context,
                        LucideIcons.repeat2,
                        _recurrenceText(recurrence),
                      ),
                      if (occurrenceEvent['location'] is String &&
                          '${occurrenceEvent['location']}'.trim().isNotEmpty)
                        _detailRow(
                          context,
                          LucideIcons.mapPin,
                          '${occurrenceEvent['location']}',
                        ),
                      _detailRow(
                        context,
                        LucideIcons.bell,
                        reminders.isEmpty
                            ? tr("No reminder")
                            : reminders.map(_reminderText).join(', '),
                        subtitle: tr("Event reminder"),
                      ),
                      if (occurrenceEvent['description'] is String &&
                          '${occurrenceEvent['description']}'.trim().isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 14),
                          child: Text(
                            '${occurrenceEvent['description']}',
                            style: webText(
                              context,
                              size: 13,
                              color: 'text.secondary',
                            ),
                          ),
                        ),
                    ],
                  ],
                ),
              ),
            ),
            Container(
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(color: palette(context)['line.hairline']),
                ),
              ),
              padding: const EdgeInsets.fromLTRB(18, 9, 18, 12),
              child: Row(
                children: [
                  if (onDelete != null)
                    WebIconButton(
                      LucideIcons.trash2,
                      tr("Delete"),
                      onPressed: onDelete,
                      size: 36,
                      iconSize: 16,
                    ),
                  const Spacer(),
                  if (onOpenSchedule != null)
                    WebButton(
                      tr("Open schedule"),
                      icon: LucideIcons.externalLink,
                      onPressed: onOpenSchedule,
                    ),
                  if (onEdit != null)
                    WebButton(
                      tr("Edit"),
                      icon: LucideIcons.pencil,
                      primary: true,
                      onPressed: onEdit,
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  static Widget _detailRow(
    BuildContext context,
    IconData icon,
    String title, {
    String? subtitle,
  }) => Padding(
    padding: const EdgeInsets.only(top: 13),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 2, right: 12),
          child: Icon(icon, size: 16, color: palette(context)['text.muted']),
        ),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: webText(context, size: 13, color: 'text.primary'),
              ),
              if (subtitle != null && subtitle.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    subtitle,
                    style: webText(context, size: 11, color: 'text.muted'),
                  ),
                ),
            ],
          ),
        ),
      ],
    ),
  );

  static IconData _statusIcon(String status) => switch (status) {
    'completed' => LucideIcons.circleCheck,
    'failed' => LucideIcons.circleX,
    'running' => LucideIcons.loaderCircle,
    'waiting_input' || 'missed' => LucideIcons.circleAlert,
    _ => LucideIcons.circleDot,
  };

  static String _statusLabel(String status) => switch (status) {
    'completed' => "Completed",
    'failed' => "Failed",
    'running' => "Running",
    'waiting_input' => "Waiting for you",
    'missed' => "Missed",
    'paused' => "Paused",
    'skipped' => "Skipped",
    'dismissed' => "Dismissed",
    _ => "Scheduled",
  };

  static String _recurrenceText(Json recurrence) {
    final frequency = '${recurrence['frequency'] ?? ''}';
    if (frequency.isEmpty) return tr("Does not repeat");
    final interval = (recurrence['interval'] as num? ?? 1).toInt();
    final prefix = interval == 1 ? '' : tr("Every {0} ", [interval]);
    final name = switch (frequency) {
      'daily' => tr("day"),
      'weekly' => tr("week"),
      'monthly' => tr("month"),
      'yearly' => tr("year"),
      _ => frequency,
    };
    return '$prefix$name';
  }

  static String _reminderText(int value) => switch (value) {
    0 => tr("At start time"),
    _ => tr("{0} minutes before", [value]),
  };

  static String _time(DateTime value) =>
      '${value.hour.toString().padLeft(2, '0')}:${value.minute.toString().padLeft(2, '0')}';
}

class _DeleteScopeSheet extends StatelessWidget {
  const _DeleteScopeSheet({required this.item});
  final CalendarOccurrence item;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 0, 18, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              tr("Delete repeating event"),
              style: webText(context, size: 16, weight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            Text(
              item.title,
              style: webText(context, size: 13, color: 'text.muted'),
            ),
            const SizedBox(height: 12),
            for (final choice in [
              ('occurrence', tr("This occurrence")),
              ('following', tr("This and following")),
              ('series', tr("Whole series")),
            ])
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: WebButton(
                  choice.$2,
                  onPressed: () => Navigator.pop(context, choice.$1),
                  height: 40,
                  backgroundColor: palette(context)['web.bg-subtle'],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class CalendarEventEditor extends StatefulWidget {
  const CalendarEventEditor({
    super.key,
    required this.controller,
    required this.initialDate,
    required this.timezone,
    required this.zones,
    this.useInitialTime = false,
    this.occurrenceStart,
    this.occurrenceEnd,
    this.existing,
    this.onCreateAgentTask,
  });
  final LiveController controller;
  final DateTime initialDate;
  final String timezone;
  final List<String> zones;
  final bool useInitialTime;
  final DateTime? occurrenceStart, occurrenceEnd;
  final CalendarOccurrence? existing;
  final VoidCallback? onCreateAgentTask;

  @override
  State<CalendarEventEditor> createState() => _CalendarEventEditorState();
}

class _CalendarEventEditorState extends State<CalendarEventEditor> {
  late final TextEditingController _title;
  late final TextEditingController _description;
  late final TextEditingController _location;
  late final TextEditingController _interval;
  late final TextEditingController _until;
  late final TextEditingController _count;
  late String _startDate;
  late String _endDate;
  late String _startTime;
  late String _endTime;
  late String _timezone;
  late String _frequency;
  late String _endMode;
  late String _scope;
  late bool _allDay;
  late Set<int> _weekdays;
  late Set<int> _reminders;
  bool _saving = false;
  String? _error;
  Json? _conflictEvent, _serverEvent;
  String? _idempotencyKey;
  late final String? _openedOrigin;
  late final String? _openedClient;
  late final String? _openedPairingStamp;

  bool get _accountUnchanged =>
      _openedOrigin == widget.controller.origin &&
      _openedClient == widget.controller.clientId &&
      _openedPairingStamp == widget.controller.pairingStamp;

  CalendarOccurrence? get existing => widget.existing;
  Json get event => _serverEvent ?? existing?.event ?? const {};
  Json get occurrenceEvent => existing?.occurrenceEvent ?? event;

  @override
  void initState() {
    super.initState();
    _openedOrigin = widget.controller.origin;
    _openedClient = widget.controller.clientId;
    _openedPairingStamp = widget.controller.pairingStamp;
    final eventStart = calendarWall(occurrenceEvent['start']);
    final eventEnd = calendarWall(occurrenceEvent['end']);
    final defaultDate = DateTime(
      widget.initialDate.year,
      widget.initialDate.month,
      widget.initialDate.day,
    );
    final initialStart = widget.occurrenceStart ?? eventStart;
    final initialEnd = widget.occurrenceEnd ?? eventEnd;
    final start =
        initialStart ??
        DateTime(
          defaultDate.year,
          defaultDate.month,
          defaultDate.day,
          widget.useInitialTime ? widget.initialDate.hour : 10,
          widget.useInitialTime ? widget.initialDate.minute : 0,
        );
    final end = initialEnd ?? start.add(const Duration(hours: 1));
    _title = TextEditingController(
      text: '${occurrenceEvent['title'] ?? existing?.title ?? ''}',
    );
    _description = TextEditingController(
      text: '${occurrenceEvent['description'] ?? ''}',
    );
    _location = TextEditingController(
      text: '${occurrenceEvent['location'] ?? ''}',
    );
    final recurrence = obj(event['recurrence']);
    _interval = TextEditingController(text: '${recurrence['interval'] ?? 1}');
    _until = TextEditingController(text: '${recurrence['until'] ?? ''}');
    _count = TextEditingController(text: '${recurrence['count'] ?? ''}');
    final occurrenceDate = existing?.startDate;
    final occurrenceEndDate = existing?.endDate;
    _startDate = occurrenceEvent['allDay'] == true
        ? (occurrenceDate ?? '${occurrenceEvent['start']}')
        : calendarDateKey(start);
    _endDate = occurrenceEvent['allDay'] == true
        ? (occurrenceEndDate ?? '${occurrenceEvent['end']}')
        : calendarDateKey(end);
    _startTime = _time(start);
    _endTime = _time(end);
    _timezone =
        '${occurrenceEvent['timezone'] ?? event['timezone'] ?? existing?.timezone ?? widget.timezone}';
    _allDay = existing?.allDay ?? occurrenceEvent['allDay'] == true;
    _frequency = '${recurrence['frequency'] ?? ''}';
    _endMode = recurrence['count'] != null
        ? 'count'
        : recurrence['until'] != null
        ? 'until'
        : 'never';
    _scope = recurrence.isEmpty ? 'series' : 'occurrence';
    _weekdays = (recurrence['weekdays'] as List? ?? [start.weekday % 7])
        .whereType<num>()
        .map((day) => day.toInt())
        .toSet();
    _reminders =
        (occurrenceEvent['reminderMinutes'] as List? ??
                event['reminderMinutes'] as List? ??
                (existing == null ? [10] : []))
            .whereType<num>()
            .map((value) => value.toInt())
            .toSet();
  }

  @override
  void dispose() {
    _title.dispose();
    _description.dispose();
    _location.dispose();
    _interval.dispose();
    _until.dispose();
    _count.dispose();
    super.dispose();
  }

  Future<void> _pickDate({required bool end}) async {
    final current = calendarDate(end ? _endDate : _startDate);
    final chosen = await showDatePicker(
      context: context,
      initialDate: DateTime(current.year, current.month, current.day),
      firstDate: DateTime(1900),
      lastDate: DateTime(2100),
      helpText: tr(end ? "Choose end date" : "Choose date"),
    );
    if (chosen == null || !mounted) return;
    setState(() {
      if (end) {
        _endDate = calendarDateKey(chosen);
      } else {
        final oldStart = calendarDate(_startDate);
        final daySpan = calendarDate(_endDate).difference(oldStart).inDays;
        _startDate = calendarDateKey(chosen);
        if (_allDay) {
          _endDate = calendarDateKey(chosen.add(const Duration(days: 1)));
        } else {
          _endDate = calendarDateKey(chosen.add(Duration(days: daySpan)));
        }
      }
    });
  }

  Future<void> _pickTime({required bool end}) async {
    final input = (end ? _endTime : _startTime).split(':');
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(
        hour: int.tryParse(input.first) ?? 10,
        minute: int.tryParse(input.last) ?? 0,
      ),
      helpText: tr(end ? "End time" : "Start time"),
    );
    if (picked == null || !mounted) return;
    setState(() {
      final value =
          '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}';
      if (end) {
        _endTime = value;
      } else {
        _startTime = value;
      }
    });
  }

  Future<void> _pickUntil() async {
    final initial = _until.text.isEmpty
        ? calendarDate(_startDate)
        : calendarDate(_until.text);
    final chosen = await showDatePicker(
      context: context,
      initialDate: DateTime(initial.year, initial.month, initial.day),
      firstDate: DateTime(1900),
      lastDate: DateTime(2100),
      helpText: tr("Repeat until"),
    );
    if (chosen != null && mounted) {
      setState(() => _until.text = calendarDateKey(chosen));
    }
  }

  Future<void> _pickZone() async {
    final zone = await _selectZone(context, _timezone, widget.zones);
    if (zone != null && mounted) setState(() => _timezone = zone);
  }

  void _changeScope(String scope) {
    final recurrence = obj(event['recurrence']);
    final source = scope == 'series' || recurrence.isEmpty
        ? event
        : occurrenceEvent;
    final allDay = scope == 'series'
        ? event['allDay'] == true
        : (existing?.allDay ?? source['allDay'] == true);
    final start = scope == 'series'
        ? calendarWall(event['start'])
        : (widget.occurrenceStart ?? calendarWall(source['start']));
    final end = scope == 'series'
        ? calendarWall(event['end'])
        : (widget.occurrenceEnd ?? calendarWall(source['end']));
    final sourceRecurrence = recurrence;
    setState(() {
      _scope = scope;
      _title.text = '${source['title'] ?? existing?.title ?? ''}';
      _description.text = '${source['description'] ?? ''}';
      _location.text = '${source['location'] ?? ''}';
      _timezone =
          '${source['timezone'] ?? existing?.timezone ?? widget.timezone}';
      _frequency = '${sourceRecurrence['frequency'] ?? ''}';
      _interval.text = '${sourceRecurrence['interval'] ?? 1}';
      _until.text = '${sourceRecurrence['until'] ?? ''}';
      _count.text = '${sourceRecurrence['count'] ?? ''}';
      _endMode = sourceRecurrence['count'] != null
          ? 'count'
          : sourceRecurrence['until'] != null
          ? 'until'
          : 'never';
      _weekdays =
          (sourceRecurrence['weekdays'] as List? ??
                  [if (start != null) start.weekday % 7])
              .whereType<num>()
              .map((day) => day.toInt())
              .toSet();
      _allDay = allDay;
      _reminders = (source['reminderMinutes'] as List? ?? [])
          .whereType<num>()
          .map((value) => value.toInt())
          .toSet();
      if (allDay) {
        _startDate = scope == 'series'
            ? '${event['start']}'
            : (existing?.startDate ?? '${source['start']}');
        _endDate = scope == 'series'
            ? '${event['end']}'
            : (existing?.endDate ?? '${source['end']}');
      } else if (start != null && end != null) {
        _startDate = calendarDateKey(start);
        _endDate = calendarDateKey(end);
        _startTime = _time(start);
        _endTime = _time(end);
      }
    });
  }

  Json _spec() {
    final recurrence = _frequency.isEmpty
        ? null
        : <String, dynamic>{
            'frequency': _frequency,
            'interval': (int.tryParse(_interval.text) ?? 1).clamp(1, 1000),
            if (_frequency == 'weekly')
              'weekdays': (_weekdays.toList()..sort()),
            if (_endMode == 'until' && _until.text.trim().isNotEmpty)
              'until': _until.text.trim(),
            if (_endMode == 'count')
              'count': (int.tryParse(_count.text.trim()) ?? 1).clamp(1, 200000),
          };
    return {
      'title': _title.text.trim(),
      'description': _description.text.trim(),
      'location': _location.text.trim(),
      'timezone': _timezone,
      'allDay': _allDay,
      'start': _allDay
          ? _startDate
          : '$_startDate'
                'T'
                '$_startTime',
      'end': _allDay
          ? _endDate
          : '$_endDate'
                'T'
                '$_endTime',
      'recurrence': recurrence,
      'reminderMinutes': _reminders.toList()..sort(),
    };
  }

  Future<void> _save() async {
    final current = existing;
    if (!_accountUnchanged) {
      setState(
        () => _error = tr("Calendar account changed. Reopen this draft."),
      );
      return;
    }
    final spec = _spec();
    final start = calendarWall(spec['start']);
    final end = calendarWall(spec['end']);
    final startDate = calendarDate(spec['start']);
    final endDate = calendarDate(spec['end']);
    if (_title.text.trim().isEmpty) {
      setState(() => _error = tr("Enter an event title."));
      return;
    }
    if (_frequency.isNotEmpty && _endMode == 'count') {
      final count = int.tryParse(_count.text.trim());
      if (count == null || count < 1 || count > 200000) {
        setState(() => _error = tr("Enter a valid occurrence count."));
        return;
      }
    }
    if (_frequency.isNotEmpty) {
      final interval = int.tryParse(_interval.text.trim());
      if (interval == null || interval < 1 || interval > 1000) {
        setState(() => _error = tr("Enter a valid repeat interval."));
        return;
      }
    }
    if (_allDay
        ? !endDate.isAfter(startDate)
        : start == null || end == null || !end.isAfter(start)) {
      setState(() => _error = tr("End must be after start."));
      return;
    }
    if (current == null) _idempotencyKey ??= _uuid();
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      if (current == null) {
        await widget.controller.gateway.request(
          '/api/calendar/events',
          method: 'POST',
          body: {'idempotencyKey': _idempotencyKey, 'event': spec},
        );
      } else {
        await widget.controller.gateway.request(
          '/api/calendar/events/${enc(current.sourceId)}',
          method: 'PATCH',
          body: {
            'revision': (_serverEvent?['revision'] as num? ?? current.revision)
                .toInt(),
            'event': spec,
            'scope': _scope,
            if (_scope == 'occurrence' || _scope == 'following')
              'occurrence': current.originalStart,
          },
        );
      }
      if (!_accountUnchanged) {
        if (mounted) {
          setState(
            () => _error = tr("Calendar account changed. Reopen this draft."),
          );
        }
        return;
      }
      if (mounted) Navigator.pop(context, true);
    } catch (error) {
      if (mounted &&
          error is PlatformException &&
          error.code == 'HTTP_409' &&
          current != null) {
        try {
          final latest = obj(
            (await widget.controller.gateway.request(
              '/api/calendar/events/${enc(current.sourceId)}',
            ))['event'],
          );
          if (mounted && latest.isNotEmpty) {
            setState(() {
              _conflictEvent = latest;
              _serverEvent = latest;
              _error = tr(
                "This event changed elsewhere. Review the current version before saving your draft.",
              );
            });
          } else if (mounted) {
            setState(() => _error = LiveController.describe(error));
          }
        } catch (_) {
          if (mounted) setState(() => _error = LiveController.describe(error));
        }
      } else if (mounted) {
        setState(() => _error = LiveController.describe(error));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final phone = MediaQuery.sizeOf(context).width <= 650;
    final media = MediaQuery.of(context);
    final availableHeight =
        media.size.height -
        media.viewInsets.bottom -
        media.viewPadding.top -
        20;
    final sheetHeight = math.min(
      math.max(0.0, media.size.height * .94),
      math.max(0.0, availableHeight),
    );
    final compact = sheetHeight < 380;
    final top = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 12, 8),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  tr(existing == null ? "New event" : "Edit event"),
                  style: webText(context, size: 16, weight: FontWeight.w600),
                ),
              ),
              WebIconButton(
                LucideIcons.x,
                tr("Cancel"),
                onPressed: () => Navigator.pop(context),
                size: 32,
                iconSize: 17,
              ),
            ],
          ),
        ),
        if (existing == null && widget.onCreateAgentTask != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 2, 20, 12),
            child: Container(
              height: 38,
              decoration: BoxDecoration(
                color: palette(context)['web.bg-subtle'],
                borderRadius: BorderRadius.circular(999),
              ),
              padding: const EdgeInsets.all(3),
              child: Row(
                children: [
                  Expanded(
                    child: _typeOption(
                      context,
                      LucideIcons.calendarDays,
                      tr("Personal event"),
                      selected: true,
                      onTap: () {},
                    ),
                  ),
                  Expanded(
                    child: _typeOption(
                      context,
                      LucideIcons.bot,
                      tr("Agent task"),
                      selected: false,
                      onTap: () {
                        Navigator.pop(context);
                        widget.onCreateAgentTask?.call();
                      },
                    ),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
    final actions = Container(
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: palette(context)['line.hairline']),
        ),
      ),
      padding: EdgeInsets.fromLTRB(18, 8, 18, 8 + media.viewPadding.bottom),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          WebButton(
            tr("Cancel"),
            onPressed: _saving ? null : () => Navigator.pop(context),
          ),
          const SizedBox(width: 8),
          WebButton(
            existing == null ? tr("Create event") : tr("Save"),
            icon: existing == null ? LucideIcons.plus : LucideIcons.check,
            primary: true,
            onPressed: _saving || _conflictEvent != null ? null : _save,
          ),
        ],
      ),
    );
    return SafeArea(
      top: false,
      child: SizedBox(
        height: sheetHeight,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (compact)
              SizedBox(
                height: math.min(100.0, sheetHeight * .34),
                child: SingleChildScrollView(child: top),
              )
            else
              top,
            Expanded(
              child: SingleChildScrollView(
                padding: EdgeInsets.fromLTRB(
                  phone ? 20 : 28,
                  0,
                  phone ? 20 : 28,
                  16,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _fieldLabel(context, tr("Title")),
                    _textField(
                      context,
                      _title,
                      hint: tr("Add a title"),
                      autofocus: existing == null,
                    ),
                    const SizedBox(height: 12),
                    _fieldLabel(context, tr("Start date")),
                    _dateButton(
                      context,
                      _startDate,
                      onPressed: () => _pickDate(end: false),
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Checkbox.adaptive(
                          value: _allDay,
                          onChanged: (value) => setState(() {
                            _allDay = value ?? false;
                            if (_allDay) {
                              _endDate = calendarDateKey(
                                calendarDate(
                                  _startDate,
                                ).add(const Duration(days: 1)),
                              );
                            }
                          }),
                        ),
                        Text(
                          tr("All day"),
                          style: webText(
                            context,
                            size: 12,
                            color: 'text.secondary',
                          ),
                        ),
                      ],
                    ),
                    if (_allDay)
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          _fieldLabel(context, tr("End date (exclusive)")),
                          _dateButton(
                            context,
                            _endDate,
                            onPressed: () => _pickDate(end: true),
                          ),
                        ],
                      )
                    else ...[
                      _fieldLabel(context, tr("End date")),
                      _dateButton(
                        context,
                        _endDate,
                        onPressed: () => _pickDate(end: true),
                      ),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          Expanded(
                            child: _timeButton(
                              context,
                              tr("Start"),
                              _startTime,
                              onPressed: () => _pickTime(end: false),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: _timeButton(
                              context,
                              tr("End"),
                              _endTime,
                              onPressed: () => _pickTime(end: true),
                            ),
                          ),
                        ],
                      ),
                    ],
                    const SizedBox(height: 12),
                    _fieldLabel(context, tr("Time zone")),
                    InkWell(
                      borderRadius: BorderRadius.circular(9),
                      onTap: _pickZone,
                      child: Container(
                        decoration: BoxDecoration(
                          color: palette(context)['web.bg-subtle'],
                          borderRadius: BorderRadius.circular(9),
                        ),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 12,
                        ),
                        child: Row(
                          children: [
                            Icon(
                              LucideIcons.globe,
                              size: 15,
                              color: palette(context)['text.muted'],
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                _timezone,
                                style: webText(context, size: 13),
                              ),
                            ),
                            Icon(
                              LucideIcons.chevronDown,
                              size: 14,
                              color: palette(context)['text.muted'],
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    _fieldLabel(context, tr("Repeat")),
                    DropdownButtonFormField<String>(
                      isExpanded: true,
                      initialValue: _frequency,
                      decoration: _inputDecoration(context),
                      items: [
                        DropdownMenuItem(
                          value: '',
                          child: Text(tr("Does not repeat")),
                        ),
                        for (final value in [
                          'daily',
                          'weekly',
                          'monthly',
                          'yearly',
                        ])
                          DropdownMenuItem(
                            value: value,
                            child: Text(tr(_frequencyLabel(value))),
                          ),
                      ],
                      onChanged: (value) =>
                          setState(() => _frequency = value ?? ''),
                    ),
                    if (_frequency.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          Text(
                            tr("Repeat every"),
                            style: webText(
                              context,
                              size: 12,
                              color: 'text.secondary',
                            ),
                          ),
                          const SizedBox(width: 8),
                          SizedBox(
                            width: 65,
                            child: _textField(
                              context,
                              _interval,
                              keyboardType: TextInputType.number,
                              inputFormatters: [
                                FilteringTextInputFormatter.digitsOnly,
                              ],
                            ),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            tr(_frequencyLabel(_frequency)),
                            style: webText(
                              context,
                              size: 12,
                              color: 'text.secondary',
                            ),
                          ),
                        ],
                      ),
                      if (_frequency == 'weekly') _weekdayPicker(context),
                      const SizedBox(height: 8),
                      _fieldLabel(context, tr("End repeat")),
                      DropdownButtonFormField<String>(
                        isExpanded: true,
                        initialValue: _endMode,
                        decoration: _inputDecoration(context),
                        items: [
                          DropdownMenuItem(
                            value: 'never',
                            child: Text(tr("Never ends")),
                          ),
                          DropdownMenuItem(
                            value: 'until',
                            child: Text(tr("On a date")),
                          ),
                          DropdownMenuItem(
                            value: 'count',
                            child: Text(tr("After a number of events")),
                          ),
                        ],
                        onChanged: (value) {
                          setState(() {
                            _endMode = value ?? 'never';
                            if (_endMode != 'until') _until.clear();
                            if (_endMode == 'until' && _until.text.isEmpty) {
                              _until.text = _startDate;
                            }
                            if (_endMode != 'count') _count.clear();
                            if (_endMode == 'count' && _count.text.isEmpty) {
                              _count.text = '1';
                            }
                          });
                        },
                      ),
                      if (_endMode == 'until') ...[
                        const SizedBox(height: 8),
                        _fieldLabel(context, tr("Repeat until")),
                        Row(
                          children: [
                            Expanded(
                              child: _textField(
                                context,
                                _until,
                                hint: tr("YYYY-MM-DD"),
                              ),
                            ),
                            const SizedBox(width: 8),
                            WebIconButton(
                              LucideIcons.calendarDays,
                              tr("Choose date"),
                              onPressed: _pickUntil,
                              size: 38,
                              iconSize: 16,
                            ),
                          ],
                        ),
                      ],
                      if (_endMode == 'count') ...[
                        const SizedBox(height: 8),
                        _fieldLabel(context, tr("Number of occurrences")),
                        _textField(
                          context,
                          _count,
                          keyboardType: TextInputType.number,
                          inputFormatters: [
                            FilteringTextInputFormatter.digitsOnly,
                          ],
                        ),
                      ],
                    ],
                    const SizedBox(height: 12),
                    _fieldLabel(context, tr("Reminders")),
                    Wrap(
                      spacing: 6,
                      runSpacing: 2,
                      children: [
                        _reminderChoice(context, null, tr("None")),
                        for (final value in [5, 10, 15, 30, 60])
                          _reminderChoice(
                            context,
                            value,
                            tr("{0} min", [value]),
                          ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    _fieldLabel(context, tr("Location")),
                    _textField(
                      context,
                      _location,
                      hint: tr("Add a place or meeting link"),
                    ),
                    const SizedBox(height: 12),
                    _fieldLabel(context, tr("Description")),
                    _textField(
                      context,
                      _description,
                      hint: tr("Add notes"),
                      maxLines: 4,
                    ),
                    if (existing != null && _frequency.isNotEmpty) ...[
                      const SizedBox(height: 12),
                      _fieldLabel(context, tr("Apply changes to")),
                      DropdownButtonFormField<String>(
                        isExpanded: true,
                        initialValue: _scope,
                        decoration: _inputDecoration(context),
                        items: [
                          DropdownMenuItem(
                            value: 'occurrence',
                            child: Text(tr("This occurrence")),
                          ),
                          DropdownMenuItem(
                            value: 'following',
                            child: Text(tr("This and following")),
                          ),
                          DropdownMenuItem(
                            value: 'series',
                            child: Text(tr("Whole series")),
                          ),
                        ],
                        onChanged: (value) => _changeScope(value ?? 'series'),
                      ),
                    ],
                    if (_error != null) ...[
                      const SizedBox(height: 10),
                      WebNotice(_error!, error: true),
                    ],
                    if (_conflictEvent != null) ...[
                      const SizedBox(height: 8),
                      Container(
                        decoration: BoxDecoration(
                          border: Border.all(
                            color: palette(context)['line.default'],
                          ),
                          borderRadius: BorderRadius.circular(8),
                          color: palette(context)['web.bg-subtle'],
                        ),
                        padding: const EdgeInsets.all(11),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Text(
                              tr("Current version: {0} · {1}", [
                                _conflictEvent!['title'] ??
                                    tr("Untitled event"),
                                '${_conflictEvent!['start'] ?? ''}–${_conflictEvent!['end'] ?? ''}',
                              ]),
                              style: webText(
                                context,
                                size: 12,
                                color: 'text.secondary',
                              ),
                            ),
                            const SizedBox(height: 8),
                            WebButton(
                              tr("Keep my edits and continue"),
                              onPressed: () => setState(() {
                                _conflictEvent = null;
                                _error = null;
                              }),
                              height: 36,
                              backgroundColor: palette(context)['surface.page'],
                            ),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            if (compact)
              SizedBox(
                height: math.min(64.0, sheetHeight * .34),
                child: SingleChildScrollView(child: actions),
              )
            else
              actions,
          ],
        ),
      ),
    );
  }

  Widget _weekdayPicker(BuildContext context) {
    final labels = MaterialLocalizations.of(context).narrowWeekdays;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Wrap(
        spacing: 4,
        children: [
          for (var day = 0; day < 7; day++)
            ChoiceChip(
              label: Text(labels[day]),
              selected: _weekdays.contains(day),
              visualDensity: VisualDensity.compact,
              onSelected: (selected) => setState(() {
                if (selected) {
                  _weekdays.add(day);
                } else if (_weekdays.length > 1) {
                  _weekdays.remove(day);
                }
              }),
            ),
        ],
      ),
    );
  }

  Widget _reminderChoice(BuildContext context, int? value, String label) {
    final selected = value == null
        ? _reminders.isEmpty
        : _reminders.contains(value);
    return ChoiceChip(
      label: Text(label),
      selected: selected,
      visualDensity: VisualDensity.compact,
      onSelected: (_) => setState(() {
        if (value == null) {
          _reminders.clear();
        } else {
          if (_reminders.isEmpty) {
            _reminders.clear();
          }
          if (selected) {
            _reminders.remove(value);
          } else {
            _reminders.add(value);
          }
        }
      }),
    );
  }

  Widget _dateButton(
    BuildContext context,
    String value, {
    required VoidCallback onPressed,
  }) {
    final date = calendarDate(value);
    return InkWell(
      onTap: onPressed,
      borderRadius: BorderRadius.circular(9),
      child: Container(
        decoration: BoxDecoration(
          color: palette(context)['web.bg-subtle'],
          borderRadius: BorderRadius.circular(9),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
        child: Row(
          children: [
            Expanded(
              child: Text(
                MaterialLocalizations.of(
                  context,
                ).formatMediumDate(DateTime(date.year, date.month, date.day)),
                style: webText(context, size: 13),
              ),
            ),
            Icon(
              LucideIcons.calendarDays,
              size: 15,
              color: palette(context)['text.muted'],
            ),
          ],
        ),
      ),
    );
  }

  Widget _timeButton(
    BuildContext context,
    String label,
    String value, {
    required VoidCallback onPressed,
  }) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      _fieldLabel(context, label),
      InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(9),
        child: Container(
          decoration: BoxDecoration(
            color: palette(context)['web.bg-subtle'],
            borderRadius: BorderRadius.circular(9),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
          child: Row(
            children: [
              Expanded(child: Text(value, style: webText(context, size: 13))),
              Icon(
                LucideIcons.clock3,
                size: 15,
                color: palette(context)['text.muted'],
              ),
            ],
          ),
        ),
      ),
    ],
  );

  static Widget _typeOption(
    BuildContext context,
    IconData icon,
    String label, {
    required bool selected,
    required VoidCallback onTap,
  }) => InkWell(
    borderRadius: BorderRadius.circular(999),
    onTap: onTap,
    child: Container(
      height: 32,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: selected ? palette(context)['surface.page'] : Colors.transparent,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            icon,
            size: 14,
            color: palette(context)[selected ? 'text.primary' : 'text.muted'],
          ),
          const SizedBox(width: 5),
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: webText(
                context,
                size: 11,
                color: selected ? 'text.primary' : 'text.muted',
              ),
            ),
          ),
        ],
      ),
    ),
  );

  static Widget _fieldLabel(BuildContext context, String label) => Padding(
    padding: const EdgeInsets.only(bottom: 5),
    child: Text(label, style: webText(context, size: 11, color: 'text.muted')),
  );

  static Widget _textField(
    BuildContext context,
    TextEditingController controller, {
    String? hint,
    int maxLines = 1,
    bool autofocus = false,
    TextInputType? keyboardType,
    List<TextInputFormatter>? inputFormatters,
  }) => TextField(
    controller: controller,
    autofocus: autofocus,
    keyboardType: keyboardType,
    inputFormatters: inputFormatters,
    minLines: maxLines == 1 ? 1 : maxLines,
    maxLines: maxLines,
    style: webText(context, size: 14),
    decoration: _inputDecoration(context, hint: hint),
  );

  static InputDecoration _inputDecoration(
    BuildContext context, {
    String? hint,
  }) => InputDecoration(
    hintText: hint,
    hintStyle: webText(context, size: 13, color: 'text.muted'),
    filled: true,
    fillColor: palette(context)['web.bg-subtle'],
    isDense: true,
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
    border: OutlineInputBorder(
      borderRadius: BorderRadius.circular(9),
      borderSide: BorderSide.none,
    ),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(9),
      borderSide: BorderSide.none,
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(9),
      borderSide: BorderSide(
        color: palette(context)['accent.default'],
        width: 1,
      ),
    ),
  );

  static String _frequencyLabel(String frequency) => switch (frequency) {
    'daily' => "Daily",
    'weekly' => "Weekly",
    'monthly' => "Monthly",
    'yearly' => "Yearly",
    _ => "Does not repeat",
  };

  static String _time(DateTime value) =>
      '${value.hour.toString().padLeft(2, '0')}:${value.minute.toString().padLeft(2, '0')}';

  static String _uuid() {
    final random = math.Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    final hex = bytes
        .map((value) => value.toRadixString(16).padLeft(2, '0'))
        .join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }
}

Future<String?> _selectZone(
  BuildContext context,
  String selected,
  List<String> zones,
) => showModalBottomSheet<String>(
  context: context,
  useRootNavigator: false,
  isScrollControlled: true,
  showDragHandle: true,
  backgroundColor: palette(context)['surface.page'],
  builder: (context) => _TimezonePicker(selected: selected, zones: zones),
);

Future<String?> showCalendarTimezonePicker(
  BuildContext context,
  String selected,
  List<String> zones,
) => _selectZone(context, selected, zones);

class _TimezonePicker extends StatefulWidget {
  const _TimezonePicker({required this.selected, required this.zones});
  final String selected;
  final List<String> zones;
  @override
  State<_TimezonePicker> createState() => _TimezonePickerState();
}

class _TimezonePickerState extends State<_TimezonePicker> {
  final _query = TextEditingController();
  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final zones = widget.zones.toSet()..add(widget.selected);
    final matching = zones
        .where((zone) => zone.toLowerCase().contains(_query.text.toLowerCase()))
        .take(100)
        .toList();
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * .75,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
              child: Text(
                tr("Choose time zone"),
                style: webText(context, size: 16, weight: FontWeight.w600),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 18),
              child: TextField(
                controller: _query,
                onChanged: (_) => setState(() {}),
                decoration: InputDecoration(
                  prefixIcon: const Icon(LucideIcons.search, size: 17),
                  hintText: tr("Search time zones"),
                  filled: true,
                  fillColor: palette(context)['web.bg-subtle'],
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(9),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
            ),
            Expanded(
              child: ListView.builder(
                itemCount: matching.length,
                itemBuilder: (context, index) {
                  final zone = matching[index];
                  return ListTile(
                    title: Text(zone, style: webText(context, size: 13)),
                    trailing: zone == widget.selected
                        ? Icon(
                            LucideIcons.check,
                            size: 16,
                            color: palette(context)['accent.default'],
                          )
                        : null,
                    onTap: () => Navigator.pop(context, zone),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class CalendarAccessSettingsSheet extends StatefulWidget {
  const CalendarAccessSettingsSheet({super.key, required this.controller});
  final LiveController controller;
  @override
  State<CalendarAccessSettingsSheet> createState() =>
      _CalendarAccessSettingsSheetState();
}

class _CalendarAccessSettingsSheetState
    extends State<CalendarAccessSettingsSheet> {
  bool _allowRead = false,
      _allowPropose = false,
      _loading = true,
      _saving = false;
  String? _error;
  int _request = 0;
  late final String? _openingOrigin;
  late final String _openingClient;

  @override
  void initState() {
    super.initState();
    _openingOrigin = widget.controller.origin;
    _openingClient = _calendarClientIdentity(widget.controller);
    _load();
  }

  Future<void> _load() async {
    final request = ++_request;
    final origin = widget.controller.origin,
        client = _calendarClientIdentity(widget.controller);
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final response = await widget.controller.gateway.request(
        '/api/calendar/permissions',
      );
      if (!mounted ||
          request != _request ||
          origin != widget.controller.origin ||
          client != _calendarClientIdentity(widget.controller)) {
        return;
      }
      setState(() {
        _allowRead = response['allowRead'] == true;
        _allowPropose = response['allowPropose'] == true;
      });
    } catch (error) {
      if (mounted &&
          request == _request &&
          origin == widget.controller.origin &&
          client == _calendarClientIdentity(widget.controller)) {
        setState(() => _error = LiveController.describe(error));
      }
    } finally {
      if (mounted && request == _request) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    if (_openingOrigin != widget.controller.origin ||
        _openingClient != _calendarClientIdentity(widget.controller)) {
      setState(() => _error = tr("Connection changed."));
      return;
    }
    final request = ++_request;
    final origin = widget.controller.origin,
        client = _calendarClientIdentity(widget.controller);
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await widget.controller.gateway.request(
        '/api/calendar/permissions',
        method: 'PATCH',
        body: {'allowRead': _allowRead, 'allowPropose': _allowPropose},
      );
      if (!mounted ||
          request != _request ||
          origin != widget.controller.origin ||
          client != _calendarClientIdentity(widget.controller)) {
        return;
      }
      final response = await widget.controller.gateway.request(
        '/api/calendar/permissions',
      );
      if (!mounted ||
          request != _request ||
          origin != widget.controller.origin ||
          client != _calendarClientIdentity(widget.controller)) {
        return;
      }
      setState(() {
        _allowRead = response['allowRead'] == true;
        _allowPropose = response['allowPropose'] == true;
      });
      if (mounted) {
        showNotice(context, tr("Agent calendar access was updated."));
      }
    } catch (error) {
      if (mounted && request == _request) {
        setState(() => _error = LiveController.describe(error));
      }
    } finally {
      if (mounted && request == _request) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final media = MediaQuery.of(context);
    return SafeArea(
      child: SizedBox(
        height: (media.size.height * .56).clamp(360.0, 560.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 6),
              child: Text(
                tr("Agent calendar access"),
                style: webText(context, size: 17, weight: FontWeight.w600),
              ),
            ),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(18, 4, 18, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      tr(
                        "These permissions apply to agent tools only. They do not change your personal calendar view.",
                      ),
                      style: webText(context, size: 12, color: 'text.muted'),
                    ),
                    const SizedBox(height: 8),
                    SwitchListTile.adaptive(
                      contentPadding: EdgeInsets.zero,
                      value: _allowRead,
                      onChanged: _loading || _saving || _error != null
                          ? null
                          : (value) => setState(() => _allowRead = value),
                      title: Text(
                        tr("Allow calendar reads"),
                        style: webText(
                          context,
                          size: 14,
                          weight: FontWeight.w600,
                        ),
                      ),
                      subtitle: Text(
                        tr(
                          "Agents can read event and schedule details you request.",
                        ),
                        style: webText(context, size: 12, color: 'text.muted'),
                      ),
                    ),
                    SwitchListTile.adaptive(
                      contentPadding: EdgeInsets.zero,
                      value: _allowPropose,
                      onChanged: _loading || _saving || _error != null
                          ? null
                          : (value) => setState(() => _allowPropose = value),
                      title: Text(
                        tr("Allow change proposals"),
                        style: webText(
                          context,
                          size: 14,
                          weight: FontWeight.w600,
                        ),
                      ),
                      subtitle: Text(
                        tr(
                          "Agents can propose event changes. You must confirm each proposal.",
                        ),
                        style: webText(context, size: 12, color: 'text.muted'),
                      ),
                    ),
                    if (_error != null) WebNotice(_error!, error: true),
                    if (_loading) WebNotice(tr("Loading permissions…")),
                  ],
                ),
              ),
            ),
            Container(
              decoration: BoxDecoration(
                border: Border(
                  top: BorderSide(color: palette(context)['line.hairline']),
                ),
              ),
              padding: const EdgeInsets.fromLTRB(18, 8, 18, 8),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  WebButton(
                    tr("Retry"),
                    onPressed: _loading || _saving ? null : _load,
                  ),
                  const SizedBox(width: 8),
                  WebButton(
                    tr("Save permissions"),
                    icon: LucideIcons.check,
                    primary: true,
                    onPressed: _loading || _saving || _error != null
                        ? null
                        : _save,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
