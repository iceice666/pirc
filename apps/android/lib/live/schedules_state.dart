import '../l10n/app_i18n.dart';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'gateway.dart';

const scheduleExplanation =
    'Prompts that run by themselves at set times, each in a new session of their workspace. Nobody watches a run live: read its final message here or open its session. Runs the gateway could not start on time wait for you to allow them.';
const scheduleRunLabels = {
  'missed': 'Missed',
  'skipped': 'Skipped',
  'dismissed': 'Dismissed',
  'running': 'Running',
  'waiting_input': 'Waiting for you',
  'completed': 'Completed',
  'failed': 'Failed',
};
const scheduleNotifyLabels = {
  'all': 'Every run',
  'problems': 'Only when it fails, is missed or needs me',
  'none': 'Never',
};
const schedulePresets = {
  '0 * * * *': 'Every hour',
  '0 9 * * *': 'Every day at 09:00',
  '0 9 * * 1-5': 'Weekdays at 09:00',
  '0 9 * * 1': 'Mondays at 09:00',
  '0 9 1 * *': 'First of the month',
};
String scheduleModelKey(Json model) =>
    jsonEncode([model['provider'], model['id']]);
String describeCron(String expression) {
  final fields = expression.trim().split(RegExp(r'\s+'));
  if (fields.length != 5) return expression;
  final [minute, hour, day, month, weekday] = fields;
  final number = RegExp(r'^\d{1,2}$'), step = RegExp(r'^\*/(\d+)$');
  String two(String s) => s.padLeft(2, '0');
  if (hour == '*' && day == '*' && month == '*' && weekday == '*') {
    if (minute == '*') return tr("Every minute");
    final match = step.firstMatch(minute);
    if (match != null) return tr("Every {0} minutes", [match[1]]);
    if (number.hasMatch(minute)) return tr("Every hour at :{0}", [two(minute)]);
    return expression;
  }
  if (!number.hasMatch(minute) || month != '*') return expression;
  final match = step.firstMatch(hour);
  if (match != null && day == '*' && weekday == '*') {
    return tr("Every {0} hours at :{1}", [match[1], two(minute)]);
  }
  if (!number.hasMatch(hour)) return expression;
  final time = '${two(hour)}:${two(minute)}';
  if (day == '*' && weekday == '*') return tr("Every day at {0}", [time]);
  if (day == '*') {
    if (weekday == '1-5') return tr("Weekdays at {0}", [time]);
    if (weekday == '0,6' || weekday == '6,0') {
      return tr("Weekends at {0}", [time]);
    }
    final days = [
      tr("Sunday"),
      tr("Monday"),
      tr("Tuesday"),
      tr("Wednesday"),
      tr("Thursday"),
      tr("Friday"),
      tr("Saturday"),
    ];
    final selected = weekday.split(',');
    if (selected.every((d) => RegExp(r'^[0-7]$').hasMatch(d))) {
      return tr("Every {0} at {1}", [
        selected.map((d) => days[int.parse(d) % 7]).join(', '),
        time,
      ]);
    }
    return expression;
  }
  if (weekday == '*' && number.hasMatch(day)) {
    return tr("Monthly on day {0} at {1}", [int.parse(day), time]);
  }
  return expression;
}

String scheduleUntil(num at, int now) {
  final delta = at - now;
  if (delta < 60000) return tr("in under a minute");
  if (delta < 3600000) return tr("in {0}m", [(delta / 60000).round()]);
  if (delta < 86400000) return tr("in {0}h", [(delta / 3600000).round()]);
  return tr("in {0}d", [(delta / 86400000).round()]);
}

String scheduleAgo(num at, int now) {
  final seconds = (now - at) / 1000;
  if (seconds < 60) return tr("just now");
  if (seconds < 3600) return tr("{0}m ago", [(seconds / 60).floor()]);
  if (seconds < 86400) return tr("{0}h ago", [(seconds / 3600).floor()]);
  if (seconds < 30 * 86400) return tr("{0}d ago", [(seconds / 86400).floor()]);
  final date = DateTime.fromMillisecondsSinceEpoch(at.toInt());
  return '${date.month}/${date.day}/${date.year}';
}

/// Requests are scoped to the paired account. Mutations are never replayed;
/// an ambiguous failure leaves the draft/error and reconciles via GET only.
class SchedulesState extends ChangeNotifier {
  SchedulesState(this.controller, {DateTime Function()? clock})
    : clock = clock ?? DateTime.now {
    _origin = controller.origin;
    _client = controller.clientId;
    _revision = controller.attention.scheduleRevision;
    controller.addListener(_external);
  }
  final LiveController controller;
  final DateTime Function() clock;
  Gateway get gateway => controller.gateway;
  List<Json> schedules = [], runs = [], models = [];
  List<String> zones = [];
  final walls = <String, String>{};
  String deviceZone = 'UTC';
  String? error, runsError, busy, expanded, confirming;
  bool loading = true, runsLoading = false;
  int epoch = 0, _read = 0, _runsRead = 0, _revision = 0;
  String? _origin, _client;
  bool _disposed = false;
  void changed() {
    if (!_disposed) notifyListeners();
  }

  bool current(int token) => !_disposed && token == epoch;
  List<Json> get workspaces =>
      controller.workspaces.where((w) => '${w['id']}'.contains(':')).toList()
        ..sort(
          (a, b) => '${a['displayName']}'.compareTo('${b['displayName']}'),
        );
  void _external() {
    if (_origin != controller.origin || _client != controller.clientId) {
      _origin = controller.origin;
      _client = controller.clientId;
      epoch++;
      _read++;
      _runsRead++;
      schedules = [];
      runs = [];
      models = [];
      walls.clear();
      expanded = confirming = busy = error = runsError = null;
      _revision = controller.attention.scheduleRevision;
      loading = true;
      changed();
      load();
    } else if (_revision != controller.attention.scheduleRevision) {
      _revision = controller.attention.scheduleRevision;
      load();
    }
  }

  Future<void> initialize() async {
    final token = epoch;
    try {
      final info = obj(await gateway.call('timeZoneInfo'));
      if (!current(token)) return;
      deviceZone = '${info['default'] ?? 'UTC'}';
      zones = (info['zones'] as List? ?? [deviceZone])
          .map((v) => '$v')
          .toList();
    } catch (_) {
      /* Formatting failures remain visible at the affected value. */
    }
    if (current(token)) await load();
  }

  Future<void> formatTimes(Iterable<Json> items) async {
    await Future.wait(
      items.map((s) async {
        final zone = '${s['timezone']}';
        for (final key in ['runAt', 'nextRunAt', 'dueAt']) {
          final at = s[key];
          if (at is! num || walls.containsKey('$zone:$at')) continue;
          final token = epoch;
          try {
            final value = await gateway.call('wallInput', {
              'at': at,
              'timezone': zone,
            });
            if (current(token) && value is String) {
              walls['$zone:$at'] = value.replaceFirst('T', ' ');
            }
          } catch (_) {
            /* Do not display device time in place of the schedule's zone. */
          }
        }
      }),
    );
  }

  String wall(dynamic at, String zone) =>
      walls['$zone:$at'] ?? tr("Time unavailable");
  String when(Json s) => s['cron'] != null
      ? '${describeCron('${s['cron']}')} (${s['timezone']})'
      : s['runAt'] != null
      ? tr("Once at {0} ({1})", [
          wall(s['runAt'], '${s['timezone']}'),
          s['timezone'],
        ])
      : tr("Never");
  String where(Json s) => [
    obj(s['workspace'])['name'],
    obj(s['workspace'])['node'],
    if (obj(s['workspace'])['online'] != true) 'offline',
    obj(s['model'])['id'],
    if (s['thinking'] != null) 'thinking ${s['thinking']}',
    if (s['notify'] == 'none') 'no notifications',
    if (s['notify'] == 'problems') 'notifies on problems',
  ].where((v) => v != null && '$v'.isNotEmpty).join(' · ');
  String status(Json s) {
    final last = obj(s['lastRun']), now = clock().millisecondsSinceEpoch;
    return [
      s['status'] == 'active' && s['nextRunAt'] is num
          ? 'Next ${wall(s['nextRunAt'], '${s['timezone']}')} (${scheduleUntil(s['nextRunAt'] as num, now)})'
          : 'No next run',
      if (last['createdAt'] is num)
        'last ${(scheduleRunLabels[last['status']] ?? '${last['status']}').toLowerCase()} ${scheduleAgo(last['createdAt'] as num, now)}',
      if (s['createdBySession'] != null) 'proposed by your assistant',
    ].join(' · ');
  }

  Future<void> load() async {
    final token = epoch, read = ++_read;
    try {
      final data = await gateway.request('/api/schedules');
      if (!current(token) || read != _read) return;
      final next = rows(data['schedules']);
      await formatTimes(next);
      if (!current(token) || read != _read) return;
      schedules = next;
      confirming = null;
      if (!next.any((s) => s['id'] == expanded)) {
        expanded = null;
        runs = [];
        _runsRead++;
      } else if (expanded != null) {
        loadRuns(expanded!);
      }
    } catch (e) {
      if (current(token) && read == _read) error = LiveController.describe(e);
    } finally {
      if (current(token) && read == _read) {
        loading = false;
        changed();
      }
    }
  }

  Future<void> focus(String id) async {
    expanded = id;
    runs = [];
    runsError = null;
    changed();
    await loadRuns(id);
  }

  void toggle(String id) {
    if (expanded == id) {
      expanded = null;
      runs = [];
      _runsRead++;
      changed();
    } else {
      focus(id);
    }
  }

  Future<void> loadRuns(String id) async {
    final token = epoch, read = ++_runsRead;
    runsLoading = true;
    runsError = null;
    changed();
    try {
      final data = await gateway.request('/api/schedules/${enc(id)}');
      final next = rows(data['runs']), s = obj(data['schedule']);
      if (!current(token) || read != _runsRead || expanded != id) return;
      await formatTimes(next.map((r) => {...r, 'timezone': s['timezone']}));
      if (!current(token) || read != _runsRead || expanded != id) return;
      runs = next;
    } catch (e) {
      if (current(token) && read == _runsRead && expanded == id) {
        runsError = LiveController.describe(e);
      }
    } finally {
      if (current(token) && read == _runsRead && expanded == id) {
        runsLoading = false;
        changed();
      }
    }
  }

  Future<void> loadModels() async {
    final token = epoch;
    try {
      final data = await gateway.request('/api/models');
      if (current(token)) {
        models = rows(data['models'])
            .map(
              (m) => <String, dynamic>{
                ...m,
                'displayName': m['name'] ?? m['id'],
              },
            )
            .toList();
        changed();
      }
    } catch (_) {
      /* Workspace default and the saved model remain valid choices. */
    }
  }

  Future<bool> mutate(
    String key,
    String path, {
    String method = 'POST',
    dynamic body,
  }) async {
    if (busy != null) return false;
    final token = epoch;
    busy = key;
    error = null;
    _read++;
    _runsRead++;
    changed();
    var success = false;
    try {
      await gateway.request(path, method: method, body: body);
      success = true;
    } catch (e) {
      if (current(token)) error = LiveController.describe(e);
    } finally {
      if (current(token)) {
        await load();
        // Refresh shared badges and missed-run actions even when a response was lost.
        if (current(token)) await controller.attention.refreshSchedules();
        if (current(token)) {
          busy = null;
          changed();
        }
      }
    }
    return success && current(token);
  }

  @override
  void dispose() {
    _disposed = true;
    controller.removeListener(_external);
    super.dispose();
  }
}

/// Validates the pinned datetime-local control's default one-minute step.
/// UTC is used only to check calendar fields/range; the returned wall time is
/// interpreted by the gateway in the separately selected schedule timezone.
String? scheduleWallTime(String input) {
  final match = RegExp(
    r'^([0-9]{4,})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,3}))?)?$',
  ).firstMatch(input);
  if (match == null || match.end != input.length) return null;
  final year = int.tryParse(match[1]!);
  if (year == null || year < 1 || year > 275760) return null;
  final month = int.parse(match[2]!), day = int.parse(match[3]!);
  final hour = int.parse(match[4]!), minute = int.parse(match[5]!);
  if ((match[6] != null && match[6] != '00') ||
      (match[7] != null && int.parse(match[7]!) != 0)) {
    return null;
  }
  try {
    final date = DateTime.utc(year, month, day, hour, minute);
    if (date.year != year ||
        date.month != month ||
        date.day != day ||
        date.hour != hour ||
        date.minute != minute) {
      return null;
    }
  } on ArgumentError {
    return null;
  }
  return '${year.toString().padLeft(4, '0')}-${match[2]}-${match[3]}T${match[4]}:${match[5]}';
}
