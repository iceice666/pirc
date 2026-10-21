import 'dart:async';
import '../l10n/app_i18n.dart';
import 'keyboard_suggestions.dart';
import 'web_length_formatter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/rendering.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'gateway.dart';
import 'schedules_state.dart';
import 'schedule_datetime_picker.dart';
import 'web_controls.dart';
import 'calendar_projection.dart';
import 'calendar_view.dart';

TextStyle scheduleText(
  BuildContext context, {
  double size = 14,
  FontWeight weight = FontWeight.w400,
  String color = 'text.primary',
}) => webText(
  context,
  size: size,
  weight: weight,
  color: color,
).copyWith(height: 1.15);

class SchedulesPage extends StatefulWidget {
  const SchedulesPage({
    super.key,
    required this.controller,
    this.focusId,
    this.focusRevision = 0,
    this.focusEventId,
    this.focusEventDate,
    this.focusEventStartAt,
    this.focusOccurrenceStart,
    this.focusEventRevision = 0,
    this.onOpenChat,
    this.sidebarCollapsed = false,
    this.onExpand,
    this.now,
  });
  final LiveController controller;
  final String? focusId;
  final String? focusEventId, focusEventDate, focusOccurrenceStart;
  final int? focusEventStartAt;
  final int focusRevision;
  final int focusEventRevision;
  final ValueChanged<String>? onOpenChat;
  final bool sidebarCollapsed;
  final VoidCallback? onExpand;
  final DateTime Function()? now;
  @override
  State<SchedulesPage> createState() => _SchedulesPageState();
}

class _SchedulesPageState extends State<SchedulesPage> {
  late SchedulesState state;
  String? editing;
  Json? existing;
  int editorKey = 0, epoch = 0;
  String calendarMode = 'month', calendarFilter = 'all', calendarZone = '';
  bool manageAgentSchedules = false;
  int calendarFirstWeekday = DateTime.sunday, _calendarPreferenceRead = 0;
  int _calendarModeRevision = 0,
      _calendarZoneRevision = 0,
      _calendarWeekStartRevision = 0;
  bool _calendarLocaleWeekStartApplied = false;
  Future<void> _calendarPreferenceWrite = Future.value();
  late DateTime calendarDate = _initialCalendarDate();
  late DateTime calendarSelected = calendarDate;
  GlobalKey<CalendarViewBodyState> calendarViewKey =
      GlobalKey<CalendarViewBodyState>();
  final prompts = <String>{};

  DateTime _initialCalendarDate() {
    final focused = calendarWall(widget.focusOccurrenceStart);
    final rawDate = widget.focusOccurrenceStart;
    final targetDate = DateTime.tryParse(widget.focusEventDate ?? '');
    final hasTargetDate =
        widget.focusEventDate != null &&
        RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(widget.focusEventDate!);
    final focusedDate =
        (hasTargetDate ? targetDate : null) ??
        focused ??
        (rawDate != null && RegExp(r'^\d{4}-\d{2}-\d{2}').hasMatch(rawDate)
            ? DateTime.tryParse(rawDate)
            : null);
    return _dateOnly(focusedDate ?? widget.now?.call() ?? DateTime.now());
  }

  String get _calendarAccountKey =>
      '${widget.controller.origin ?? ''}|${widget.controller.clientId ?? ''}|${widget.controller.pairingStamp ?? ''}';

  int _localeFirstWeekday() =>
      MaterialLocalizations.of(context).firstDayOfWeekIndex == 1
      ? DateTime.monday
      : DateTime.sunday;

  Future<void> _loadCalendarPreferences() async {
    final controller = widget.controller;
    final account = _calendarAccountKey;
    if (controller.origin == null) return;
    final request = ++_calendarPreferenceRead;
    final modeRevision = _calendarModeRevision;
    final zoneRevision = _calendarZoneRevision;
    final weekStartRevision = _calendarWeekStartRevision;
    try {
      final saved = obj(
        await controller.gateway.call('calendarPreferences', {
          'accountKey': account,
        }),
      );
      if (!mounted ||
          request != _calendarPreferenceRead ||
          account != _calendarAccountKey) {
        return;
      }
      final savedView = '${saved['view'] ?? ''}';
      final savedZone = '${saved['timezone'] ?? ''}';
      final savedWeekStart = '${saved['weekStart'] ?? ''}';
      setState(() {
        if (modeRevision == _calendarModeRevision &&
            widget.focusEventId == null &&
            widget.focusId == null) {
          calendarMode =
              const ['month', 'week', 'day', 'list'].contains(savedView)
              ? savedView
              : 'month';
        }
        if (zoneRevision == _calendarZoneRevision) {
          calendarZone = savedZone.isNotEmpty ? savedZone : state.deviceZone;
        }
        if (weekStartRevision == _calendarWeekStartRevision) {
          calendarFirstWeekday = savedWeekStart == 'monday'
              ? DateTime.monday
              : savedWeekStart == 'sunday'
              ? DateTime.sunday
              : _localeFirstWeekday();
        }
      });
      if (widget.focusEventStartAt != null) {
        unawaited(_resolveFocusedEventDate());
      }
    } catch (_) {
      // Display defaults remain usable if local preferences cannot be read.
    }
  }

  Future<void> _saveCalendarPreferences() async {
    final controller = widget.controller;
    final account = _calendarAccountKey;
    final value = {
      'view': calendarMode,
      'timezone': calendarZone.isEmpty ? state.deviceZone : calendarZone,
      'weekStart': calendarFirstWeekday == DateTime.monday
          ? 'monday'
          : 'sunday',
    };
    _calendarPreferenceWrite = _calendarPreferenceWrite.then((_) async {
      if (!mounted ||
          account != _calendarAccountKey ||
          controller.origin == null) {
        return;
      }
      try {
        await controller.gateway.call('saveCalendarPreferences', {
          'accountKey': account,
          ...value,
        });
      } catch (error) {
        if (mounted && account == _calendarAccountKey) {
          showNotice(context, LiveController.describe(error));
        }
      }
    });
    await _calendarPreferenceWrite;
  }

  void _setCalendarMode(String value) {
    if (value == calendarMode) return;
    _calendarModeRevision++;
    setState(() {
      calendarMode = value;
      manageAgentSchedules = false;
    });
    unawaited(_saveCalendarPreferences());
  }

  void _showAgentSchedules(bool show) =>
      setState(() => manageAgentSchedules = show);

  Future<void> _resolveFocusedEventDate() async {
    final startAt = widget.focusEventStartAt;
    if (widget.focusEventId == null || startAt == null) return;
    final timezone = calendarZone.isNotEmpty ? calendarZone : state.deviceZone;
    try {
      final wall = await widget.controller.gateway.call('wallInput', {
        'at': startAt,
        'timezone': timezone,
      });
      final date = calendarWall(wall);
      if (!mounted || date == null) return;
      setState(() {
        calendarDate = DateTime(date.year, date.month, date.day);
        calendarSelected = calendarDate;
      });
    } catch (error) {
      if (mounted) showNotice(context, LiveController.describe(error));
    }
  }

  @override
  void initState() {
    super.initState();
    setup();
  }

  void setup() {
    state = SchedulesState(widget.controller, clock: widget.now)
      ..addListener(changed);
    unawaited(_loadCalendarPreferences());
    final initial = state;
    state.initialize().then((_) async {
      if (mounted && identical(initial, state)) {
        setState(() {
          if (calendarZone.isEmpty) calendarZone = state.deviceZone;
        });
        if (!mounted || !identical(initial, state)) return;
        if (widget.focusEventId != null) {
          setState(() {
            calendarMode = 'month';
            calendarDate = _initialCalendarDate();
            calendarSelected = calendarDate;
          });
          if (widget.focusEventStartAt != null) {
            unawaited(_resolveFocusedEventDate());
          }
        } else if (widget.focusId != null) {
          setState(() {
            calendarMode = 'list';
            manageAgentSchedules = true;
          });
          state.focus(widget.focusId!);
        }
      }
    });
  }

  void changed() {
    if (!mounted) return;
    var accountChanged = false;
    setState(() {
      if (epoch != state.epoch) {
        accountChanged = true;
        epoch = state.epoch;
        calendarZone = state.deviceZone;
        calendarMode = widget.focusId != null ? 'list' : 'month';
        manageAgentSchedules = widget.focusId != null;
        calendarFirstWeekday = _localeFirstWeekday();
        _calendarLocaleWeekStartApplied = true;
        _calendarModeRevision = 0;
        _calendarZoneRevision = 0;
        _calendarWeekStartRevision = 0;
        calendarViewKey = GlobalKey<CalendarViewBodyState>();
        editing = null;
        existing = null;
        prompts.clear();
        editorKey++;
      }
    });
    if (accountChanged) {
      _calendarModeRevision = 0;
      unawaited(_loadCalendarPreferences());
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_calendarLocaleWeekStartApplied) {
      _calendarLocaleWeekStartApplied = true;
      calendarFirstWeekday = _localeFirstWeekday();
    }
  }

  @override
  void didUpdateWidget(covariant SchedulesPage old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      state.removeListener(changed);
      state.dispose();
      editing = null;
      existing = null;
      epoch = 0;
      calendarViewKey = GlobalKey<CalendarViewBodyState>();
      editorKey++;
      setup();
    } else if (old.focusEventRevision != widget.focusEventRevision &&
        widget.focusEventId != null) {
      final date = _initialCalendarDate();
      setState(() {
        calendarMode = 'month';
        calendarDate = date;
        calendarSelected = date;
        calendarViewKey = GlobalKey<CalendarViewBodyState>();
      });
      if (widget.focusEventStartAt != null) {
        unawaited(_resolveFocusedEventDate());
      }
    } else if ((old.focusId != widget.focusId ||
            old.focusRevision != widget.focusRevision) &&
        widget.focusId != null) {
      setState(() {
        calendarMode = 'list';
        manageAgentSchedules = true;
      });
      state.focus(widget.focusId!);
    }
  }

  @override
  void dispose() {
    state.removeListener(changed);
    state.dispose();
    super.dispose();
  }

  void edit(Json? schedule) {
    setState(() {
      editing = schedule == null ? 'new' : '${schedule['id']}';
      existing = schedule;
      editorKey++;
    });
    state.loadModels();
  }

  Widget button(
    String label,
    VoidCallback? onPressed, {
    bool primary = false,
    bool danger = false,
  }) => WebButton(
    label,
    onPressed: onPressed,
    primary: primary,
    danger: danger,
    height: 32,
    fontSize: 13,
    horizontalPadding: 12,
  );
  Widget text(
    String value, {
    bool small = false,
    String color = 'text.muted',
    FontWeight weight = FontWeight.w400,
  }) => Text(
    value,
    style: scheduleText(
      context,
      size: small ? 12 : 13,
      color: color,
      weight: weight,
    ),
  );
  Widget badge(String label, {bool attention = false}) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6),
    decoration: BoxDecoration(
      color: palette(context)[attention ? 'accent.default' : 'web.bg-hover'],
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(
      label,
      style: scheduleText(
        context,
        size: 11,
        color: attention ? 'surface.page' : 'text.secondary',
      ),
    ),
  );

  static DateTime _dateOnly(DateTime value) =>
      DateTime(value.year, value.month, value.day);

  String _periodLabel() {
    final local = DateTime(
      calendarDate.year,
      calendarDate.month,
      calendarDate.day,
    );
    final material = MaterialLocalizations.of(context);
    if (calendarMode == 'month' || calendarMode == 'list') {
      return material.formatMonthYear(local);
    }
    if (calendarMode == 'day') return material.formatMediumDate(local);
    final start = calendarWeekStart(
      calendarDate,
      firstWeekday: calendarFirstWeekday,
    );
    final end = start.add(const Duration(days: 6));
    if (start.month == end.month) {
      return tr("{0} {1}–{2}", [
        material.formatMonthYear(start),
        start.day,
        end.day,
      ]);
    }
    return '${material.formatMediumDate(start)} – ${material.formatMediumDate(end)}';
  }

  void _moveCalendar(int direction) {
    setState(() {
      if (calendarMode == 'month' || calendarMode == 'list') {
        calendarDate = DateTime(
          calendarDate.year,
          calendarDate.month + direction,
          1,
        );
      } else if (calendarMode == 'week') {
        calendarDate = calendarDate.add(Duration(days: direction * 7));
      } else {
        calendarDate = calendarDate.add(Duration(days: direction));
      }
      calendarSelected = calendarDate;
    });
  }

  Future<void> _goToday() async {
    var today = _dateOnly(widget.now?.call() ?? DateTime.now());
    if (calendarZone.isNotEmpty) {
      try {
        final wall = await widget.controller.gateway.call('wallInput', {
          'at': (widget.now?.call() ?? DateTime.now()).millisecondsSinceEpoch,
          'timezone': calendarZone,
        });
        final date = calendarWall(wall);
        if (date == null) {
          throw StateError(
            tr("Unable to format calendar time in this time zone."),
          );
        }
        today = DateTime(date.year, date.month, date.day);
      } catch (error) {
        if (mounted) showNotice(context, LiveController.describe(error));
        return;
      }
    }
    if (mounted) {
      setState(() {
        calendarDate = today;
        calendarSelected = today;
      });
    }
  }

  Future<void> _newCalendarItem() async {
    final kind = await showModalBottomSheet<String>(
      context: context,
      useRootNavigator: false,
      showDragHandle: true,
      backgroundColor: palette(context)['surface.page'],
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                tr("New calendar item"),
                style: webText(context, size: 16, weight: FontWeight.w600),
              ),
              const SizedBox(height: 12),
              WebButton(
                tr("Personal event"),
                icon: LucideIcons.calendarDays,
                onPressed: () => Navigator.pop(context, 'event'),
                height: 42,
                backgroundColor: palette(context)['web.bg-subtle'],
              ),
              const SizedBox(height: 8),
              WebButton(
                tr("Agent task"),
                icon: LucideIcons.bot,
                onPressed: () => Navigator.pop(context, 'schedule'),
                height: 42,
                backgroundColor: palette(context)['web.bg-subtle'],
              ),
            ],
          ),
        ),
      ),
    );
    if (!mounted || kind == null) return;
    if (kind == 'schedule') {
      _calendarModeRevision++;
      setState(() {
        calendarMode = 'list';
        manageAgentSchedules = true;
        editing = 'new';
        existing = null;
        editorKey++;
      });
      unawaited(_saveCalendarPreferences());
      state.loadModels();
      return;
    }
    if (calendarMode == 'list') {
      _calendarModeRevision++;
      setState(() => calendarMode = 'month');
      unawaited(_saveCalendarPreferences());
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) calendarViewKey.currentState?.createEvent(calendarSelected);
    });
  }

  Future<void> _pickDisplayZone() async {
    final zone = await showCalendarTimezonePicker(
      context,
      calendarZone,
      state.zones,
    );
    if (zone != null && mounted) {
      _calendarZoneRevision++;
      setState(() => calendarZone = zone);
      unawaited(_saveCalendarPreferences());
    }
  }

  Future<void> _showCalendarAccess() => showModalBottomSheet<void>(
    context: context,
    useRootNavigator: false,
    isScrollControlled: true,
    showDragHandle: true,
    backgroundColor: palette(context)['surface.page'],
    builder: (context) =>
        CalendarAccessSettingsSheet(controller: widget.controller),
  );

  Widget _calendarHeader({
    required bool phone,
    required double textScale,
    required bool compactHeader,
  }) {
    final titleStyle = scheduleText(context, size: 15, weight: FontWeight.w600);
    final title = Row(
      children: [
        if (widget.sidebarCollapsed && !phone) ...[
          WebIconButton(
            LucideIcons.panelLeftOpen,
            tr("Show sidebar"),
            onPressed: widget.onExpand,
            iconSize: 19,
          ),
          const SizedBox(width: 10),
        ],
        Icon(
          LucideIcons.calendarDays,
          size: 18,
          color: palette(context)['text.muted'],
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            tr("Calendar"),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: titleStyle,
          ),
        ),
      ],
    );
    final zoneButton = calendarZone.isEmpty
        ? null
        : InkWell(
            borderRadius: BorderRadius.circular(6),
            onTap: _pickDisplayZone,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    LucideIcons.globe,
                    size: 14,
                    color: palette(context)['text.muted'],
                  ),
                  const SizedBox(width: 5),
                  if (textScale < 1.5)
                    Text(
                      calendarZone == 'Asia/Taipei'
                          ? tr("Taipei")
                          : calendarZone.split('/').last.replaceAll('_', ' '),
                      style: scheduleText(
                        context,
                        size: 11,
                        color: 'text.muted',
                      ),
                    ),
                ],
              ),
            ),
          );
    final accessButton = WebIconButton(
      LucideIcons.shield,
      tr("Agent calendar access"),
      onPressed: _showCalendarAccess,
      size: 32,
      iconSize: 16,
    );
    final newButton = WebButton(
      compactHeader ? tr("New") : tr("New event"),
      icon: LucideIcons.plus,
      primary: true,
      height: textScale >= 1.5 ? 40 : 32,
      fontSize: 13,
      horizontalPadding: compactHeader ? 8 : 12,
      onPressed: _newCalendarItem,
    );

    return SafeArea(
      bottom: false,
      child: Padding(
        padding: EdgeInsets.only(left: phone ? 16 : 20, right: phone ? 16 : 20),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 56),
          child: textScale >= 1.5
              ? Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    SizedBox(height: 52, child: title),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        ?zoneButton,
                        accessButton,
                        const SizedBox(width: 4),
                        newButton,
                      ],
                    ),
                  ],
                )
              : Row(
                  children: [
                    if (widget.sidebarCollapsed && !phone) ...[
                      WebIconButton(
                        LucideIcons.panelLeftOpen,
                        tr("Show sidebar"),
                        onPressed: widget.onExpand,
                        iconSize: 19,
                      ),
                      const SizedBox(width: 10),
                    ],
                    Icon(
                      LucideIcons.calendarDays,
                      size: 18,
                      color: palette(context)['text.muted'],
                    ),
                    const SizedBox(width: 10),
                    Text(tr("Calendar"), style: titleStyle),
                    const Spacer(),
                    ?zoneButton,
                    accessButton,
                    newButton,
                  ],
                ),
        ),
      ),
    );
  }

  Widget _calendarToolbar(bool phone) {
    final tabLabels = <String, String>{
      'month': tr("Calendar month view"),
      'week': tr("Week"),
      'day': tr("Calendar day view"),
      'list': tr("List"),
    };
    return Padding(
      padding: EdgeInsets.fromLTRB(phone ? 16 : 24, 4, phone ? 16 : 24, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  _periodLabel(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: scheduleText(
                    context,
                    size: 19,
                    weight: FontWeight.w600,
                    color: 'text.primary',
                  ),
                ),
              ),
              WebIconButton(
                LucideIcons.chevronLeft,
                tr("Previous period"),
                onPressed: () => _moveCalendar(-1),
                size: 32,
                iconSize: 17,
              ),
              WebButton(
                tr("Today"),
                onPressed: _goToday,
                height: 32,
                fontSize: 13,
                horizontalPadding: 12,
              ),
              WebIconButton(
                LucideIcons.chevronRight,
                tr("Next period"),
                onPressed: () => _moveCalendar(1),
                size: 32,
                iconSize: 17,
              ),
            ],
          ),
          const SizedBox(height: 8),
          Container(
            height: 36,
            padding: const EdgeInsets.all(3),
            decoration: BoxDecoration(
              color: palette(context)['web.bg-subtle'],
              borderRadius: BorderRadius.circular(999),
            ),
            child: Row(
              children: [
                for (final mode in ['month', 'week', 'day', 'list'])
                  Expanded(
                    child: Semantics(
                      button: true,
                      selected: calendarMode == mode,
                      child: InkWell(
                        borderRadius: BorderRadius.circular(999),
                        onTap: () => _setCalendarMode(mode),
                        child: AnimatedContainer(
                          duration: const Duration(milliseconds: 120),
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: calendarMode == mode
                                ? palette(context)['surface.page']
                                : Colors.transparent,
                            borderRadius: BorderRadius.circular(999),
                            boxShadow: calendarMode == mode
                                ? [
                                    BoxShadow(
                                      color: palette(context)['line.hairline'],
                                      blurRadius: 2,
                                    ),
                                  ]
                                : null,
                          ),
                          child: Text(
                            tabLabels[mode]!,
                            style: scheduleText(
                              context,
                              size: 12,
                              weight: calendarMode == mode
                                  ? FontWeight.w600
                                  : FontWeight.w400,
                              color: calendarMode == mode
                                  ? 'text.primary'
                                  : 'text.muted',
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (calendarMode != 'list' || !manageAgentSchedules) ...[
            const SizedBox(height: 8),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  _filterChip('all', tr("All")),
                  const SizedBox(width: 6),
                  _filterChip(
                    'event',
                    tr("Personal events"),
                    icon: LucideIcons.calendarDays,
                  ),
                  const SizedBox(width: 6),
                  _filterChip(
                    'schedule',
                    tr("Agent tasks"),
                    icon: LucideIcons.bot,
                  ),
                ],
              ),
            ),
          ],
          if (calendarMode == 'list') ...[
            const SizedBox(height: 2),
            Align(
              alignment: Alignment.centerRight,
              child: WebButton(
                manageAgentSchedules
                    ? tr("Calendar list")
                    : tr("Manage agent tasks"),
                icon: manageAgentSchedules
                    ? LucideIcons.calendarDays
                    : LucideIcons.bot,
                onPressed: () => _showAgentSchedules(!manageAgentSchedules),
                height: 30,
                fontSize: 12,
                horizontalPadding: 10,
              ),
            ),
          ],
          if (calendarMode != 'list') ...[
            const SizedBox(height: 2),
            Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 4,
              children: [
                Text(
                  tr("Week starts"),
                  style: scheduleText(context, size: 11, color: 'text.muted'),
                ),
                const SizedBox(width: 4),
                for (final entry in [
                  (DateTime.sunday, tr("Sunday")),
                  (DateTime.monday, tr("Monday")),
                ]) ...[
                  ChoiceChip(
                    label: Text(entry.$2),
                    selected: calendarFirstWeekday == entry.$1,
                    visualDensity: VisualDensity.compact,
                    onSelected: (_) {
                      _calendarWeekStartRevision++;
                      setState(() => calendarFirstWeekday = entry.$1);
                      unawaited(_saveCalendarPreferences());
                    },
                  ),
                  const SizedBox(width: 0),
                ],
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _filterChip(String value, String label, {IconData? icon}) {
    final selected = calendarFilter == value;
    return InkWell(
      borderRadius: BorderRadius.circular(999),
      onTap: () => setState(() => calendarFilter = value),
      child: Container(
        height: 30,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(
          color: selected
              ? palette(context)['web.bg-hover']
              : Colors.transparent,
          borderRadius: BorderRadius.circular(999),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (value == 'event') ...[
              Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(
                  color: palette(context)['accent.default'],
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 6),
            ],
            if (icon != null) ...[
              Icon(icon, size: 14, color: palette(context)['text.muted']),
              const SizedBox(width: 5),
            ],
            Text(
              label,
              style: scheduleText(
                context,
                size: 12,
                color: selected ? 'text.primary' : 'text.muted',
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final phone = MediaQuery.sizeOf(context).width <= 650;
    final textScale = MediaQuery.textScalerOf(context).scale(1);
    final compactHeader = phone || textScale >= 1.25;
    return DefaultTextStyle(
      style: scheduleText(context, size: 13),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _calendarHeader(
            phone: phone,
            textScale: textScale,
            compactHeader: compactHeader,
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _calendarToolbar(phone),
                Expanded(
                  child: calendarMode == 'list' && manageAgentSchedules
                      ? SingleChildScrollView(
                          child: Align(
                            alignment: Alignment.topCenter,
                            child: ConstrainedBox(
                              constraints: const BoxConstraints(maxWidth: 780),
                              child: Padding(
                                padding: EdgeInsets.fromLTRB(
                                  phone ? 14 : 32,
                                  phone ? 4 : 8,
                                  phone ? 14 : 32,
                                  phone
                                      ? 72 +
                                            MediaQuery.paddingOf(context).bottom
                                      : 48,
                                ),
                                child: Column(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.stretch,
                                  children: [
                                    Text(
                                      'SCHEDULES',
                                      style: scheduleText(
                                        context,
                                        size: 12,
                                        weight: FontWeight.w600,
                                        color: 'text.secondary',
                                      ).copyWith(letterSpacing: .24),
                                    ),
                                    const SizedBox(height: 13),
                                    text(tr(scheduleExplanation)),
                                    if (state.loading)
                                      WebNotice(tr("Loading schedules…"))
                                    else ...[
                                      if (state.error != null &&
                                          editing == null)
                                        WebNotice(state.error!, error: true),
                                      if (editing != null)
                                        ScheduleForm(
                                          key: ValueKey('$epoch:$editorKey'),
                                          state: state,
                                          existing: existing,
                                          onCancel: () =>
                                              setState(() => editing = null),
                                          onSaved: () =>
                                              setState(() => editing = null),
                                        )
                                      else
                                        Padding(
                                          padding: const EdgeInsets.symmetric(
                                            vertical: 12,
                                          ),
                                          child: Align(
                                            alignment: Alignment.centerRight,
                                            child: button(
                                              tr("New schedule"),
                                              state.busy == null
                                                  ? () => edit(null)
                                                  : null,
                                              primary: true,
                                            ),
                                          ),
                                        ),
                                      if (state.schedules.isEmpty &&
                                          editing == null)
                                        text(
                                          tr(
                                            "No schedules yet. Make one here, or ask your assistant: it asks you before it adds one.",
                                          ),
                                        ),
                                      for (final s in state.schedules)
                                        Padding(
                                          padding: const EdgeInsets.only(
                                            bottom: 6,
                                          ),
                                          child: card(s),
                                        ),
                                    ],
                                  ],
                                ),
                              ),
                            ),
                          ),
                        )
                      : CalendarViewBody(
                          key: calendarViewKey,
                          controller: widget.controller,
                          mode: calendarMode,
                          anchor: calendarDate,
                          selectedDate: calendarSelected,
                          filter: calendarFilter,
                          timezone: calendarZone.isEmpty
                              ? state.deviceZone
                              : calendarZone,
                          firstWeekday: calendarFirstWeekday,
                          zones: state.zones,
                          accountKey: '$epoch',
                          focusEventId: widget.focusEventId,
                          focusOccurrenceStart: widget.focusOccurrenceStart,
                          focusRevision: widget.focusEventRevision,
                          clock: widget.now,
                          onAnchorChanged: (value) => setState(() {
                            calendarDate = _dateOnly(value);
                            calendarSelected = _dateOnly(value);
                          }),
                          onSelectedDate: (value) => setState(() {
                            calendarSelected = _dateOnly(value);
                            if (value.month != calendarDate.month ||
                                value.year != calendarDate.year) {
                              calendarDate = _dateOnly(value);
                            }
                          }),
                          onOpenSchedule: (id) {
                            _calendarModeRevision++;
                            setState(() {
                              calendarMode = 'list';
                              manageAgentSchedules = true;
                              state.focus(id);
                            });
                            unawaited(_saveCalendarPreferences());
                          },
                          onCreateAgentTask: () {
                            _calendarModeRevision++;
                            setState(() {
                              calendarMode = 'list';
                              manageAgentSchedules = true;
                              editing = 'new';
                              existing = null;
                              editorKey++;
                            });
                            unawaited(_saveCalendarPreferences());
                            state.loadModels();
                          },
                        ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget row(Widget content, List<Widget> actions) => actions.isEmpty
      ? content
      : _ScheduleRow(
          children: [
            content,
            Wrap(spacing: 6, runSpacing: 6, children: actions),
          ],
        );
  Widget card(Json s) {
    final id = '${s['id']}',
        base = '/api/schedules/${enc(id)}',
        online = obj(s['workspace'])['online'] == true,
        ready = state.busy == null;
    final attention = (s['attention'] as num? ?? 0).toInt();
    return Container(
      key: ValueKey('schedule-$id'),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: palette(context)['surface.subtle'],
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          row(
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              spacing: 2,
              children: [
                Wrap(
                  spacing: 6,
                  runSpacing: 2,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    text(
                      '${s['title']}',
                      color: s['status'] == 'active'
                          ? 'text.primary'
                          : 'text.muted',
                      weight: FontWeight.w700,
                    ),
                    if (s['status'] == 'paused') badge(tr("Paused")),
                    if (s['status'] == 'done') badge(tr("Done")),
                    if (attention > 0)
                      badge(
                        tr("{0} waiting for you", [attention]),
                        attention: true,
                      ),
                  ],
                ),
                text(state.when(s), small: true),
                text(state.where(s), small: true),
                text(state.status(s), small: true),
              ],
            ),
            [
              Semantics(
                expanded: state.expanded == id,
                child: button(tr("Runs"), () => state.toggle(id)),
              ),
              Tooltip(
                message: online
                    ? ''
                    : tr("{0} is offline", [obj(s['workspace'])['node']]),
                child: button(
                  tr("Run now"),
                  ready && online
                      ? () => state.mutate(id, '$base/run', body: {})
                      : null,
                ),
              ),
              if (s['status'] == 'active')
                button(
                  tr("Pause"),
                  ready
                      ? () => state.mutate(
                          id,
                          base,
                          method: 'PATCH',
                          body: {'status': 'paused'},
                        )
                      : null,
                ),
              if (s['status'] == 'paused')
                button(
                  tr("Resume"),
                  ready
                      ? () => state.mutate(
                          id,
                          base,
                          method: 'PATCH',
                          body: {'status': 'active'},
                        )
                      : null,
                ),
              button(tr("Edit"), ready ? () => edit(s) : null),
              if (state.confirming == id) ...[
                button(
                  tr("Delete for good"),
                  ready ? () => state.mutate(id, base, method: 'DELETE') : null,
                  danger: true,
                ),
                button(
                  tr("Cancel"),
                  () => setState(() => state.confirming = null),
                ),
              ] else
                button(
                  tr("Delete"),
                  ready ? () => setState(() => state.confirming = id) : null,
                ),
            ],
          ),
          if (state.expanded == id) ...[
            const SizedBox(height: 8),
            Semantics(
              expanded: prompts.contains(id),
              child: InkWell(
                onTap: () => setState(
                  () => prompts.contains(id)
                      ? prompts.remove(id)
                      : prompts.add(id),
                ),
                child: Row(
                  children: [
                    Icon(
                      prompts.contains(id)
                          ? LucideIcons.chevronDown
                          : LucideIcons.chevronRight,
                      size: 13,
                      color: palette(context)['text.secondary'],
                    ),
                    const SizedBox(width: 4),
                    text(tr("Prompt"), color: 'text.secondary'),
                  ],
                ),
              ),
            ),
            if (prompts.contains(id))
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: SelectableText(
                  '${s['prompt']}',
                  style: scheduleText(
                    context,
                    size: 13,
                    color: 'text.secondary',
                  ),
                ),
              ),
            if (state.runsError != null)
              WebNotice(state.runsError!, error: true)
            else if (state.runsLoading && state.runs.isEmpty)
              WebNotice(tr("Loading runs…"))
            else if (state.runs.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: text(tr("No runs yet."), small: true),
              )
            else
              Container(
                margin: const EdgeInsets.only(top: 8),
                padding: const EdgeInsets.only(top: 8),
                decoration: BoxDecoration(
                  border: Border(
                    top: BorderSide(color: palette(context)['web.line']),
                  ),
                ),
                child: Column(
                  spacing: 6,
                  children: [for (final run in state.runs) runRow(s, run)],
                ),
              ),
          ],
        ],
      ),
    );
  }

  Widget runRow(Json s, Json run) {
    final id = '${s['id']}',
        base = '/api/schedules/${enc(id)}',
        ready = state.busy == null;
    final color = switch (run['status']) {
      'completed' => 'status.success',
      'failed' => 'status.danger',
      'missed' || 'waiting_input' => 'accent.default',
      'skipped' || 'dismissed' => 'text.muted',
      _ => 'text.primary',
    };
    return row(
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              text(
                tr(scheduleRunLabels[run['status']] ?? '${run['status']}'),
                color: color,
                weight: FontWeight.w600,
              ),
              text(
                tr("due {0} · {1}", [
                  state.wall(run['dueAt'], '${s['timezone']}'),
                  scheduleAgo(
                    (run['createdAt'] as num?) ?? 0,
                    state.clock().millisecondsSinceEpoch,
                  ),
                ]),
                small: true,
              ),
            ],
          ),
          if (run['result'] != null && '${run['result']}'.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 160),
                child: SingleChildScrollView(
                  child: SelectableText(
                    '${run['result']}',
                    style: scheduleText(
                      context,
                      size: 13,
                      color: 'text.secondary',
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
      [
        if (run['status'] == 'missed') ...[
          button(
            tr("Allow and run now"),
            ready && obj(s['workspace'])['online'] == true
                ? () => state.mutate(
                    '${run['id']}',
                    '$base/run',
                    body: {'runId': run['id']},
                  )
                : null,
            primary: true,
          ),
          button(
            tr("Dismiss"),
            ready
                ? () => state.mutate(
                    '${run['id']}',
                    '$base/runs/${enc('${run['id']}')}/dismiss',
                  )
                : null,
          ),
        ],
        if (run['sessionId'] != null && run['session'] != null)
          button(
            tr("Open session"),
            () => widget.onOpenChat?.call('${run['sessionId']}'),
          ),
      ],
    );
  }
}

class ScheduleForm extends StatefulWidget {
  const ScheduleForm({
    super.key,
    required this.state,
    required this.onCancel,
    required this.onSaved,
    this.existing,
  });
  final SchedulesState state;
  final Json? existing;
  final VoidCallback onCancel, onSaved;
  @override
  State<ScheduleForm> createState() => _ScheduleFormState();
}

class _ScheduleFormState extends State<ScheduleForm> {
  late final title = TextEditingController(
    text: '${widget.existing?['title'] ?? ''}',
  );
  late final prompt = TextEditingController(
    text: '${widget.existing?['prompt'] ?? ''}',
  );
  late final cron = TextEditingController(
    text: '${widget.existing?['cron'] ?? '0 9 * * *'}',
  );
  late final zone = TextEditingController(
    text: '${widget.existing?['timezone'] ?? s.deviceZone}',
  );
  final at = TextEditingController(),
      zoneFocus = FocusNode(),
      timeFocus = FocusNode();
  late bool once = widget.existing != null && widget.existing!['cron'] == null;
  late String workspace =
      '${widget.existing?['workspaceId'] ?? defaultWorkspace()}';
  late String model = obj(widget.existing?['model']).isEmpty
      ? ''
      : scheduleModelKey(obj(widget.existing?['model']));
  late String thinking = '${widget.existing?['thinking'] ?? ''}',
      notify = '${widget.existing?['notify'] ?? 'all'}';
  String? error;
  bool wallLoading = true, pickerOpen = false;
  SchedulesState get s => widget.state;
  String defaultWorkspace() {
    final active = obj(s.controller.state['session'])['workspaceId'];
    return '${s.workspaces.where((w) => w['id'] == active).firstOrNull?['id'] ?? s.workspaces.firstOrNull?['id'] ?? ''}';
  }

  @override
  void initState() {
    super.initState();
    initTime();
  }

  Future<void> initTime() async {
    try {
      final value = await s.gateway.call('wallInput', {
        'at':
            widget.existing?['runAt'] ??
            s.clock().millisecondsSinceEpoch + 3600000,
        'timezone': zone.text,
      });
      if (mounted && at.text.isEmpty && value is String) {
        setState(() => at.text = value);
      }
    } catch (e) {
      if (mounted) setState(() => error = LiveController.describe(e));
    } finally {
      if (mounted) setState(() => wallLoading = false);
    }
  }

  Future<void> chooseTime() async {
    if (pickerOpen || wallLoading) return;
    final origin = s.controller.origin, epoch = s.epoch;
    setState(() => pickerOpen = true);
    try {
      var initial = scheduleWallTime(at.text);
      initial ??=
          await s.gateway.call('wallInput', {
                'at': s.clock().millisecondsSinceEpoch,
                'timezone': s.deviceZone,
              })
              as String?;
      if (!mounted || origin != s.controller.origin || epoch != s.epoch) return;
      if (initial == null || scheduleWallTime(initial) == null) {
        setState(
          () => error = tr("Unable to initialize the date and time picker."),
        );
        return;
      }
      FocusScope.of(context).unfocus();
      final result = await showScheduleDateTimePicker(context, initial);
      if (!mounted ||
          origin != s.controller.origin ||
          epoch != s.epoch ||
          result == null) {
        return;
      }
      setState(() {
        at.text = result;
        error = null;
      });
    } catch (e) {
      if (mounted && origin == s.controller.origin && epoch == s.epoch) {
        setState(() => error = LiveController.describe(e));
      }
    } finally {
      if (mounted) setState(() => pickerOpen = false);
    }
  }

  @override
  void dispose() {
    for (final c in [title, prompt, cron, zone, at]) {
      c.dispose();
    }
    zoneFocus.dispose();
    timeFocus.dispose();
    super.dispose();
  }

  Future<void> save() async {
    if (s.busy != null || once && wallLoading) return;
    if (workspace.isEmpty ||
        prompt.text.isEmpty ||
        zone.text.trim().isEmpty ||
        (once ? at.text : cron.text).isEmpty) {
      setState(
        () => error = tr("Fill in the workspace, prompt, time and time zone."),
      );
      return;
    }
    final wallTime = once ? scheduleWallTime(at.text) : null;
    if (once && wallTime == null) {
      setState(
        () => error = tr("Enter a valid date and time (YYYY-MM-DDTHH:mm)."),
      );
      timeFocus.requestFocus();
      final fieldContext = timeFocus.context;
      if (fieldContext != null) Scrollable.ensureVisible(fieldContext);
      return;
    }
    final chosen = s.models
        .where((m) => m['available'] == true && scheduleModelKey(m) == model)
        .firstOrNull;
    final body = <String, dynamic>{
      'workspaceId': workspace,
      'title': title.text.trim(),
      'prompt': prompt.text,
      'timezone': zone.text.trim(),
      'model': model.isEmpty
          ? null
          : chosen == null
          ? (widget.existing?['model'])
          : {'provider': chosen['provider'], 'id': chosen['id']},
      'thinking': thinking.isEmpty ? null : thinking,
      'notify': notify,
      if (once) 'at': wallTime else 'cron': cron.text.trim(),
    };
    setState(() => error = null);
    final ok = await s.mutate(
      'save',
      '/api/schedules${widget.existing == null ? '' : '/${enc('${widget.existing!['id']}')}'}',
      method: widget.existing == null ? 'POST' : 'PATCH',
      body: body,
    );
    if (!mounted) return;
    if (ok) {
      widget.onSaved();
    } else {
      setState(() => error = s.error);
    }
  }

  InputDecoration decoration({String? hint}) => InputDecoration(
    hintText: hint,
    hintStyle: scheduleText(context, size: 16, color: 'text.muted'),
    isDense: true,
    filled: true,
    fillColor: palette(context)['surface.subtle'],
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    border: OutlineInputBorder(
      borderRadius: BorderRadius.circular(10),
      borderSide: BorderSide.none,
    ),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(10),
      borderSide: BorderSide.none,
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(10),
      borderSide: BorderSide(color: palette(context)['accent.default']),
    ),
  );
  Widget label(String name, Widget child) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          name,
          style: scheduleText(
            context,
            size: 13,
            weight: FontWeight.w500,
            color: 'text.secondary',
          ),
        ),
        const SizedBox(height: 6),
        child,
      ],
    ),
  );
  Widget field(
    String name,
    TextEditingController c, {
    String? hint,
    int lines = 1,
    int? maxLength,
    bool mono = false,
  }) => label(
    name,
    Focus(
      canRequestFocus: false,
      onKeyEvent: (_, event) {
        if (lines != 1 ||
            event is! KeyDownEvent ||
            (event.logicalKey != LogicalKeyboardKey.enter &&
                event.logicalKey != LogicalKeyboardKey.numpadEnter) ||
            !c.value.composing.isCollapsed) {
          return KeyEventResult.ignored;
        }
        save();
        return KeyEventResult.handled;
      },
      child: TextField(
        key: ValueKey('schedule-field-$name'),
        controller: c,
        focusNode: c == at ? timeFocus : null,
        textInputAction: lines == 1
            ? TextInputAction.done
            : TextInputAction.newline,
        onSubmitted: lines == 1
            ? (_) {
                if (c.value.composing.isCollapsed) save();
              }
            : null,
        onChanged: c == cron ? (_) => setState(() {}) : null,
        minLines: lines,
        maxLines: lines == 1 ? 1 : null,
        inputFormatters: [if (maxLength != null) WebLengthFormatter(maxLength)],
        style: scheduleText(
          context,
          size: 16,
          color: 'text.secondary',
        ).copyWith(fontFamily: mono ? 'monospace' : null),
        decoration: decoration(hint: hint).copyWith(
          counterText: '',
          suffixIcon: c == at
              ? IconButton(
                  key: const ValueKey('schedule-open-time-picker'),
                  tooltip: tr("Choose date and time"),
                  onPressed: wallLoading || pickerOpen ? null : chooseTime,
                  icon: const Icon(LucideIcons.chevronDown, size: 18),
                )
              : null,
        ),
      ),
    ),
  );
  Widget select(
    String name,
    String value,
    Map<String, String> options,
    ValueChanged<String> changed,
  ) => label(
    name,
    InputDecorator(
      decoration: decoration().copyWith(
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          key: ValueKey('schedule-select-$name'),
          value: options.containsKey(value) ? value : null,
          isExpanded: true,
          isDense: true,
          style: scheduleText(context, size: 16, color: 'text.secondary'),
          borderRadius: BorderRadius.circular(10),
          items: [
            for (final e in options.entries)
              DropdownMenuItem(
                value: e.key,
                child: Text(e.value, overflow: TextOverflow.ellipsis),
              ),
          ],
          onChanged: (v) {
            if (v != null) setState(() => changed(v));
          },
        ),
      ),
    ),
  );
  Widget radio(String name, bool selected, VoidCallback choose) => Semantics(
    checked: selected,
    inMutuallyExclusiveGroup: true,
    child: InkWell(
      onTap: choose,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 16,
            height: 16,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(
                color: palette(
                  context,
                )[selected ? 'accent.default' : 'text.muted'],
                width: selected ? 4 : 1,
              ),
            ),
          ),
          const SizedBox(width: 6),
          Text(
            name,
            style: scheduleText(
              context,
              size: 13,
              weight: FontWeight.w500,
              color: 'text.secondary',
            ),
          ),
        ],
      ),
    ),
  );
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(color: palette(context)['web.line']),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            widget.existing == null ? tr("New schedule") : tr("Edit schedule"),
            style: scheduleText(context, size: 13, weight: FontWeight.w600),
          ),
          const SizedBox(height: 12),
          select(tr("Workspace"), workspace, {
            for (final w in s.workspaces)
              '${w['id']}': '${w['displayName']} · ${w['hostId']}',
          }, (v) => workspace = v),
          field(
            tr("Title"),
            title,
            maxLength: 80,
            hint: tr("Named after the first line of the prompt"),
          ),
          field(
            tr("Prompt"),
            prompt,
            lines: 5,
            hint: tr(
              "What the agent should do. Each run starts fresh with only this.",
            ),
          ),
          label(
            tr("When"),
            Wrap(
              spacing: 16,
              children: [
                radio(tr("Repeat"), !once, () => setState(() => once = false)),
                radio(tr("Once"), once, () => setState(() => once = true)),
              ],
            ),
          ),
          if (once)
            field(tr("Time"), at, hint: tr("YYYY-MM-DDTHH:mm"))
          else ...[
            field(tr("Cron (minute hour day month weekday)"), cron, mono: true),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final e in schedulePresets.entries)
                  Semantics(
                    selected: cron.text.trim() == e.key,
                    child: TextButton(
                      style: TextButton.styleFrom(
                        minimumSize: const Size(0, 32),
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        shape: const StadiumBorder(),
                        textStyle: scheduleText(
                          context,
                          size: 13,
                          weight: FontWeight.w500,
                        ),
                        foregroundColor:
                            palette(context)[cron.text.trim() == e.key
                                ? 'accent.default'
                                : 'text.primary'],
                      ),
                      onPressed: () => setState(() => cron.text = e.key),
                      child: Text(tr(e.value)),
                    ),
                  ),
              ],
            ),
          ],
          if (!once) const SizedBox(height: 12),
          label(
            tr("Time zone"),
            KeyboardSuggestions(
              controller: zone,
              focusNode: zoneFocus,
              options: s.zones,
              builder: (context, keyboardVisible) => RawAutocomplete<String>(
                textEditingController: zone,
                focusNode: zoneFocus,
                optionsBuilder: (v) => s.zones.where(
                  (z) => z.toLowerCase().contains(v.text.toLowerCase()),
                ),
                fieldViewBuilder: (context, c, f, _) => Focus(
                  canRequestFocus: false,
                  onKeyEvent: (_, event) {
                    if (event is KeyDownEvent &&
                        (event.logicalKey == LogicalKeyboardKey.enter ||
                            event.logicalKey ==
                                LogicalKeyboardKey.numpadEnter) &&
                        c.value.composing.isCollapsed) {
                      save();
                      return KeyEventResult.handled;
                    }
                    return KeyEventResult.ignored;
                  },
                  child: TextField(
                    key: const ValueKey('schedule-field-Time zone'),
                    controller: c,
                    focusNode: f,
                    style: scheduleText(
                      context,
                      size: 16,
                      color: 'text.secondary',
                    ),
                    decoration: decoration(),
                    autocorrect: false,
                    spellCheckConfiguration:
                        const SpellCheckConfiguration.disabled(),
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) {
                      if (!c.value.composing.isCollapsed) return;
                      save();
                    },
                  ),
                ),
                optionsViewBuilder: (context, onSelect, options) =>
                    keyboardVisible
                    ? const SizedBox.shrink()
                    : Align(
                        alignment: Alignment.topLeft,
                        child: Material(
                          color: palette(context)['surface.page'],
                          elevation: 4,
                          borderRadius: BorderRadius.circular(10),
                          child: SizedBox(
                            width: 260,
                            child: ConstrainedBox(
                              constraints: const BoxConstraints(maxHeight: 200),
                              child: ListView(
                                shrinkWrap: true,
                                padding: const EdgeInsets.all(4),
                                children: [
                                  for (final option in options)
                                    InkWell(
                                      onTap: () => onSelect(option),
                                      child: Padding(
                                        padding: const EdgeInsets.all(8),
                                        child: Text(
                                          option,
                                          style: scheduleText(
                                            context,
                                            size: 14,
                                          ),
                                        ),
                                      ),
                                    ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
              ),
            ),
          ),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                flex: 2,
                child: select(tr("Model"), model, {
                  '': tr("Workspace default"),
                  for (final m in s.models.where((m) => m['available'] == true))
                    scheduleModelKey(
                      m,
                    ): '${m['displayName'] ?? m['name'] ?? m['id']} · ${m['provider']}',
                  if (model.isNotEmpty &&
                      !s.models.any(
                        (m) =>
                            m['available'] == true &&
                            scheduleModelKey(m) == model,
                      ))
                    model:
                        '${obj(widget.existing?['model'])['provider']} / ${obj(widget.existing?['model'])['id']}',
                }, (v) => model = v),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: select(tr("Thinking"), thinking, {
                  '': tr("Default"),
                  for (final level in [
                    'off',
                    'minimal',
                    'low',
                    'medium',
                    'high',
                    'xhigh',
                    'max',
                  ])
                    level: level,
                }, (v) => thinking = v),
              ),
            ],
          ),
          select(tr("Notifications"), notify, {
            for (final e in scheduleNotifyLabels.entries) e.key: tr(e.value),
          }, (v) => notify = v),
          if (error != null) WebNotice(error!, error: true),
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Wrap(
              spacing: 8,
              alignment: WrapAlignment.end,
              children: [
                WebButton(
                  tr("Cancel"),
                  height: 32,
                  fontSize: 13,
                  horizontalPadding: 12,
                  onPressed: widget.onCancel,
                ),
                WebButton(
                  widget.existing == null ? tr("Create") : tr("Save"),
                  height: 32,
                  fontSize: 13,
                  horizontalPadding: 12,
                  primary: true,
                  onPressed:
                      s.busy == null &&
                          workspace.isNotEmpty &&
                          (!once || !wallLoading)
                      ? save
                      : null,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Legacy activity links open the same schedule page with its run history focused.
class ScheduleDetailPage extends StatelessWidget {
  const ScheduleDetailPage({
    super.key,
    required this.controller,
    required this.id,
  });
  final LiveController controller;
  final String id;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Scaffold(
      body: SchedulesPage(
        controller: controller,
        focusId: id,
        onOpenChat: (session) async {
          await controller.open(session);
          if (context.mounted) Navigator.of(context).popUntil((r) => r.isFirst);
        },
      ),
    );
  }
}

// Mirrors .schedule-row flex wrapping: a 240px text basis, intrinsic action
// group, 12px horizontal gap and 8px gap when the group wraps below.
class _ScheduleRow extends MultiChildRenderObjectWidget {
  const _ScheduleRow({required super.children});
  @override
  RenderObject createRenderObject(BuildContext context) => _RenderScheduleRow();
}

class _ScheduleRowParentData extends ContainerBoxParentData<RenderBox> {}

class _RenderScheduleRow extends RenderBox
    with
        ContainerRenderObjectMixin<
          RenderBox,
          ContainerBoxParentData<RenderBox>
        >,
        RenderBoxContainerDefaultsMixin<
          RenderBox,
          ContainerBoxParentData<RenderBox>
        > {
  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! ContainerBoxParentData<RenderBox>) {
      child.parentData = _ScheduleRowParentData();
    }
  }

  ({Size text, Size actions, bool inline}) sizes(
    BoxConstraints c, {
    required bool dry,
  }) {
    final text = firstChild!, actions = lastChild!;
    final width = c.maxWidth;
    final spacing = actions is RenderWrap
        ? actions.spacing * (actions.childCount - 1)
        : 0.0;
    final actionWidth =
        (actions.getMaxIntrinsicWidth(double.infinity) + spacing).clamp(
          0.0,
          width,
        );
    final inline = 240 + 12 + actionWidth <= width;
    final tc = BoxConstraints.tightFor(
      width: inline ? width - actionWidth - 12 : width,
    );
    final ac = BoxConstraints(maxWidth: inline ? actionWidth : width);
    if (dry) {
      return (
        text: text.getDryLayout(tc),
        actions: actions.getDryLayout(ac),
        inline: inline,
      );
    }
    text.layout(tc, parentUsesSize: true);
    actions.layout(ac, parentUsesSize: true);
    return (text: text.size, actions: actions.size, inline: inline);
  }

  @override
  Size computeDryLayout(BoxConstraints c) {
    final s = sizes(c, dry: true);
    return c.constrain(
      Size(
        c.maxWidth,
        s.inline
            ? (s.text.height > s.actions.height
                  ? s.text.height
                  : s.actions.height)
            : s.text.height + 8 + s.actions.height,
      ),
    );
  }

  @override
  void performLayout() {
    final s = sizes(constraints, dry: false);
    size = constraints.constrain(
      Size(
        constraints.maxWidth,
        s.inline
            ? (s.text.height > s.actions.height
                  ? s.text.height
                  : s.actions.height)
            : s.text.height + 8 + s.actions.height,
      ),
    );
    (firstChild!.parentData! as ContainerBoxParentData<RenderBox>).offset =
        Offset.zero;
    (lastChild!.parentData! as ContainerBoxParentData<RenderBox>).offset =
        s.inline ? Offset(s.text.width + 12, 0) : Offset(0, s.text.height + 8);
  }

  @override
  void paint(PaintingContext context, Offset offset) =>
      defaultPaint(context, offset);
  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) =>
      defaultHitTestChildren(result, position: position);
}
